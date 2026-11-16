// The swap rules for deploys that do not take the app down
// (docs/plans/zero-downtime-deploy-2026-11.md, sections 9 and 12).
// Pure: no Cloudflare API in this file, so every rule is unit-tested (rollout.test.mjs).
// cloudflare/worker.js gathers the facts, calls plan(), and carries out the actions.
//
// The app runs in one "live" instance. When the image the code wants differs from the image
// the live instance runs, a second instance ("next") is started beside it, and the live one
// keeps serving for however long that takes. Then comes the HAND-OVER:
//
//   The new instance is started HELD: its container is up, but the app is not
//   (lib/container-hold.js). When it reports "parked", the pointer moves to it (requests wait
//   there), the old app is stopped, and only then is the new app let go. Two copies of the
//   app never run against the database at once; the cost is that requests wait while the new
//   app boots. If the new app does not come up, it is stopped and the old instance is
//   started again.
//
// (Until 2026-11 there was also an old one-container application, "legacy", and an overlap
// swap back to it. Both are gone: every instance is a host, and every swap is a hand-over.)

/** How every swap is done; kept on each candidate and in the history. */
export const HANDOVER = 'handover'
/**
 * What an instance must speak to be handed over FROM (a stop that keeps its record, resume).
 * A Durable Object can go on running the previous version of this code for minutes after a
 * deploy, so the router asks, and waits, instead of calling a method that is not there yet.
 */
export const PROTOCOL = 2

/**
 * An old instance's stop-for-good is asked this long after the time it was listed with. Every
 * listing is back-dated by the same amount (`at: now - RETIRE_GRACE_MS`), so in practice it is
 * asked on the next look. (The wait was for the overlap swap, which is gone.)
 */
export const RETIRE_GRACE_MS = 5_000
/** How long a new instance may take to come up (parked, or healthy) before it is given up on. */
export const ROLLOUT_TIMEOUT_MS = 20 * 60_000
/** After a swap that never started, how long before the same image is tried again. */
export const FAILED_RETRY_MS = 30 * 60_000
/** A stop that failed is tried again after this long, times the number of tries, up to the cap. */
export const RETIRE_RETRY_MS = 30_000
export const RETIRE_RETRY_CAP_MS = 10 * 60_000
/** HAND-OVER: how long stopping the old instance may take before the hand-over is undone. */
export const HANDOVER_STOP_TIMEOUT_MS = 60_000
/** HAND-OVER: how long the new app may take to answer /health, once let go, before it is undone. */
export const HANDOVER_BOOT_TIMEOUT_MS = 180_000
/** HAND-OVER: a new app that has exited this many times since it was let go is not coming up. */
export const HANDOVER_MAX_EXITS = 2
/** Time between looks while a swap is in progress, and while nothing is happening. */
export const TICK_FAST_MS = 2_000
export const TICK_SLOW_MS = 30_000
const HISTORY_KEPT = 10

export const hostName = (seq) => 'app-' + seq

/** Nothing serves yet: the first look starts the first instance. */
export function initialState() {
  return {
    v: 1,
    seq: 0,
    live: null,
    next: null,
    handover: null,
    retiring: [],
    failed: null,
    forced: null,
    history: [],
  }
}

/**
 * What the live instance runs, as far as the facts say: the image it reports, or undefined
 * when it could not be asked (never swap on a guess).
 */
function liveImageOf(state, facts) {
  if (!state.live) return null
  return facts.live?.begun ? facts.live.image : undefined
}

/**
 * Decide what to do now.
 *
 * state: what the router stored last time (never mutated).
 * facts: { live, next, wanted, to }
 *   to: only while a hand-over is being undone: { begun, running, stopped } of the instance being stopped,
 *     asked without starting anything (null when it could not be asked).
 *   live / next: what each instance reports ({ begun, image, running, ready, parked, stopped,
 *     exits, protocol, commit }), or null when it could not be asked.
 *   wanted: the image the newest version of the code wants to run (null when unknown).
 * Returns { state, actions, delay } where actions are, in order:
 *   { type: 'begin', name, reason, forced, held }  start an instance (held: parked, app not started)
 *   { type: 'stop', name }      stop an instance's app but keep its record (it can be resumed)
 *   { type: 'release', name }   let a parked instance start its app
 *   { type: 'resume', name }    start a stopped instance again
 *   { type: 'retire', name }    stop an instance for good
 * An action marked `seq` is one step of a sequence: if it fails, the router carries out none
 * of the actions after it on this look (a new app is never let go while the old may still run).
 */
export function plan(state, facts, now) {
  const next = { ...state, retiring: [...state.retiring], history: [...state.history], handover: state.handover ?? null }
  const actions = []
  const note = (entry) => {
    next.history = [...next.history, { at: now, ...entry }].slice(-HISTORY_KEPT)
  }

  if (next.handover) {
    planHandover(next, facts, now, actions, note)
  } else if (next.next) {
    const candidate = next.next
    const canHandOver = (facts.live?.protocol ?? 0) >= PROTOCOL
    if (facts.next?.parked && next.live && canHandOver) {
      // The hand-over begins. The pointer moves first, so from this moment requests wait on
      // the new instance instead of arriving at an app that is about to stop.
      const from = next.live
      const image = facts.next.image ?? candidate.image ?? null
      next.handover = { from: from.name, fromLive: from, to: candidate.name, at: now, phase: 'stop', reason: candidate.reason, startedAt: candidate.startedAt, image }
      next.live = { name: candidate.name, since: now, image, commit: facts.next.commit ?? null }
      next.next = null
      actions.push({ type: 'stop', name: from.name, seq: true, settle: true }, { type: 'release', name: candidate.name, seq: true })
    } else if (facts.wanted && facts.next?.begun && facts.next.image && facts.next.image !== facts.wanted) {
      // A newer deploy arrived while this one was still coming up: drop it and go straight to
      // what is wanted now (the next look starts it) instead of waiting out the older one.
      next.retiring.push({ name: candidate.name, at: now - RETIRE_GRACE_MS, tries: 0 })
      next.next = null
      note({ from: next.live?.name ?? null, to: candidate.name, reason: candidate.reason, superseded: true, tookMs: now - candidate.startedAt })
    } else if (now - candidate.startedAt > ROLLOUT_TIMEOUT_MS) {
      // Given up on. It goes on the old-instances list, already due, so a failed stop is retried.
      next.retiring.push({ name: candidate.name, at: now - RETIRE_GRACE_MS, tries: 0 })
      const why = facts.next?.parked ? 'the live instance could not hand over' : 'never came up'
      next.failed = { image: facts.next?.image ?? candidate.image ?? null, name: candidate.name, at: now, why, checks: facts.next?.checks ?? null }
      next.next = null
      note({ from: next.live?.name ?? null, to: candidate.name, reason: candidate.reason, failed: true, why, tookMs: now - candidate.startedAt })
    } else if (facts.next && facts.next.begun === false) {
      // The start did not take (the call failed last time): ask again. Starting is idempotent.
      actions.push({ type: 'begin', name: candidate.name, reason: candidate.reason, forced: false, held: true })
    }
    // A live instance that is stopped (an earlier hand-over was undone and its start-again
    // did not stick) goes on being started while a held instance comes up: a held instance
    // runs no app, so this never makes two.
    const liveStopped = next.live && (next.live.needsResume || facts.live?.stopped)
    if (next.next && liveStopped) actions.push({ type: 'resume', name: next.live.name })
  } else if (!next.live) {
    // Nothing has ever served (a brand-new deployment): there is nothing to keep serving, so
    // the first instance is live at once and requests wait on it.
    next.seq += 1
    next.live = { name: hostName(next.seq), since: now, image: null, commit: null }
    actions.push({ type: 'begin', name: next.live.name, reason: 'first', forced: false, held: false })
  } else if (facts.live && facts.live.begun === false) {
    // The live host has lost its own record of what to run (it should never happen). Nothing
    // else is serving, so set the same host up again rather than leave every request failing.
    actions.push({ type: 'begin', name: next.live.name, reason: 'revive', forced: false, held: false })
  } else {
    if (next.live.needsResume || facts.live?.stopped) {
      // The live instance is stopped (a hand-over was undone and the start-again did not
      // stick). Nothing else is serving: start it. This does not stop a new deploy from being
      // brought up below, which is the other way out.
      actions.push({ type: 'resume', name: next.live.name })
    }
    const liveImage = liveImageOf(next, facts)
    const wanted = facts.wanted ?? null
    const failed = next.failed && next.failed.image === wanted ? next.failed : null
    // An image whose hand-over was undone is never tried again by itself: every try makes
    // people wait. A new deploy (another image) is tried at once.
    const failedRecently = failed && (failed.final === true || now - failed.at < FAILED_RETRY_MS)
    const forced = next.forced && !failed?.final ? next.forced : null
    const imageChanged = wanted !== null && liveImage !== undefined && liveImage !== wanted
    if (forced || (imageChanged && !failedRecently)) {
      next.seq += 1
      const name = hostName(next.seq)
      const reason = forced ? forced.reason : 'image'
      next.next = { name, startedAt: now, reason, image: wanted, style: HANDOVER }
      next.forced = null
      actions.push({ type: 'begin', name, reason, forced: Boolean(forced), held: true })
    }
  }

  // Old instances whose grace period is over. The router removes one from the list when the
  // stop succeeded (retired()), or schedules another try (retireFailed()); one is never
  // forgotten while it may still be running.
  const busy = new Set([next.live?.name, next.next?.name, next.handover?.from].filter(Boolean))
  if (next.handover && next.handover.phase !== 'resume') busy.add(next.handover.to)
  for (const old of next.retiring) {
    if (busy.has(old.name)) continue
    if (now >= (old.retryAt ?? old.at + RETIRE_GRACE_MS)) actions.push({ type: 'retire', name: old.name })
  }
  // Whatever is live or coming up is never on the old-instances list.
  next.retiring = next.retiring.filter((old) => old.name !== next.live?.name && old.name !== next.next?.name)

  // An instance whose stop keeps failing is retried on the slow heartbeat, not every 2 seconds.
  const working = Boolean(next.next) || Boolean(next.handover) || next.retiring.some((old) => !old.tries)
  return { state: next, actions, delay: working ? TICK_FAST_MS : TICK_SLOW_MS }
}

/**
 * One look at a hand-over in progress. Its phases, each entered only when the router reports
 * the step before it worked (handoverStep):
 *   stop     the old app is being stopped         (requests wait on the new instance)
 *   release  the old app is stopped; the new one is being let go
 *   boot     the new app is starting; done when it answers /health
 *   undo     it did not work: the new instance is being stopped for good
 *   resume   the new instance is stopped; the old one is being started again
 */
function planHandover(next, facts, now, actions, note) {
  const h = next.handover
  const stop = { type: 'stop', name: h.from, seq: true }
  const release = { type: 'release', name: h.to, seq: true }
  const retire = { type: 'retire', name: h.to, seq: true }
  const resume = { type: 'resume', name: h.from, seq: true }

  const undo = (why) => {
    // The pointer goes back at once. Until the old instance is running again its answer is
    // "try again"; nothing is sent to a new app that is known not to work.
    next.live = { ...h.fromLive }
    next.handover = { ...h, phase: 'undo', undoneAt: now, why }
    next.failed = { image: h.image, name: h.to, at: now, why, final: true }
    note({ from: h.from, to: h.to, reason: h.reason, style: HANDOVER, failed: true, why, tookMs: now - h.startedAt })
    actions.push(retire, resume)
  }

  if (h.phase === 'stop') {
    if (now - h.at > HANDOVER_STOP_TIMEOUT_MS) undo('the old instance did not stop')
    else actions.push(stop, release)
  } else if (h.phase === 'release' || h.phase === 'boot') {
    if (facts.live?.ready) {
      next.handover = null
      next.failed = null
      next.live = { ...next.live, commit: facts.live.commit ?? next.live.commit ?? null }
      // The old host is already stopped; this forgets its record.
      next.retiring.push({ name: h.from, at: now - RETIRE_GRACE_MS, tries: 0 })
      note({
        from: h.from,
        to: h.to,
        reason: h.reason,
        style: HANDOVER,
        tookMs: now - h.startedAt,
        pausedMs: now - h.at,
        stopMs: h.stoppedAt ? h.stoppedAt - h.at : null,
        bootMs: h.releasedAt ? now - h.releasedAt : null,
        commit: facts.live.commit ?? null,
      })
    } else if ((facts.live?.exits ?? 0) >= HANDOVER_MAX_EXITS) {
      undo('the new app kept exiting')
    } else if (now - (h.stoppedAt ?? h.at) > HANDOVER_BOOT_TIMEOUT_MS) {
      undo('the new app did not come up')
    } else if (h.phase === 'release') {
      actions.push(release)
    }
  } else if (h.phase === 'undo') {
    const gone = facts.to && facts.to.running === false && (facts.to.stopped === true || facts.to.begun === false)
    if (now - (h.undoneAt ?? h.at) > HANDOVER_STOP_TIMEOUT_MS && gone) {
      // The stop-for-good keeps failing, but the new instance itself says nothing is running
      // there and its record says it must stay stopped (or it has no record left). Forgetting its record goes on being retried; the old one is started now.
      // (While the new app may still be running, the old one is NOT started: two copies must
      // never run at once, even if that leaves nothing serving until the stop works.)
      next.retiring.push({ name: h.to, at: now - RETIRE_GRACE_MS, tries: 0 })
      next.handover = { ...h, phase: 'resume', resumeAt: now }
      actions.push(resume)
    } else {
      actions.push(retire, resume)
    }
  } else if (now - (h.resumeAt ?? h.undoneAt ?? h.at) > HANDOVER_STOP_TIMEOUT_MS) {
    // Starting the old instance again keeps failing. Stop treating this as a hand-over, so
    // the ordinary rules apply: the start is tried on every look, and a new deploy can be
    // brought up and handed over to.
    next.handover = null
    next.live = { ...next.live, needsResume: true }
    note({ from: h.from, to: h.to, reason: h.reason, style: HANDOVER, stuck: 'the old instance did not start again' })
    actions.push({ type: 'resume', name: h.from })
  } else {
    actions.push(resume)
  }
}

/** A step of the hand-over worked: move to its next phase. Anything unexpected changes nothing. */
export function handoverStep(state, event, { name, now, graceful = null } = {}) {
  const h = state.handover
  if (!h) {
    // Outside a hand-over the one step that matters: the live instance was started again.
    if (event === 'resumed' && state.live?.name === name && state.live.needsResume) {
      const live = { ...state.live }
      delete live.needsResume
      return { ...state, live }
    }
    return state
  }
  if (event === 'stopped' && h.phase === 'stop' && name === h.from) {
    return { ...state, handover: { ...h, phase: 'release', stoppedAt: now, graceful } }
  }
  if (event === 'released' && h.phase === 'release' && name === h.to) {
    return { ...state, handover: { ...h, phase: 'boot', releasedAt: now } }
  }
  if (event === 'retired' && h.phase === 'undo' && name === h.to) {
    return { ...state, handover: { ...h, phase: 'resume', resumeAt: now } }
  }
  if (event === 'resumed' && h.phase === 'resume' && name === h.from) {
    const history = [...state.history, { at: now, resumed: h.from }].slice(-HISTORY_KEPT)
    return { ...state, handover: null, history }
  }
  return state
}

/** The instance was stopped for good: forget it, and note how the stop went. */
export function retired(state, name, { graceful = null, now = null } = {}) {
  const history = now === null ? state.history : [...state.history, { at: now, stopped: name, graceful }].slice(-HISTORY_KEPT)
  return { ...state, retiring: state.retiring.filter((old) => old.name !== name), history }
}

/** Stopping it failed: try again later (a little later each time). It stays listed until it IS stopped. */
export function retireFailed(state, name, now) {
  const retiring = state.retiring.map((old) => {
    if (old.name !== name) return old
    const tries = (old.tries ?? 0) + 1
    return { ...old, tries, retryAt: now + Math.min(tries * RETIRE_RETRY_MS, RETIRE_RETRY_CAP_MS) }
  })
  return { ...state, retiring }
}

/** Ask for a swap to a fresh instance on the same image (a restart that reloads the environment). */
export function force(state, reason = 'restart') {
  return { ...state, forced: { reason: String(reason).slice(0, 40) } }
}
