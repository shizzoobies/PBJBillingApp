// The swap rules for deploys that do not take the app down
// (docs/plans/zero-downtime-deploy-2026-11.md, sections 9 and 12).
// Pure: no Cloudflare API in this file, so every rule is unit-tested (rollout.test.mjs).
// cloudflare/worker.js gathers the facts, calls plan(), and carries out the actions.
//
// The app runs in one "live" instance. When the image the code wants differs from the image
// the live instance runs, a second instance ("next") is started beside it, and the live one
// keeps serving for however long that takes. Then one of two things happens:
//
// HAND-OVER (every swap to a host; the default). The new instance is started HELD: its
//   container is up, but the app is not (lib/container-hold.js). When it reports "parked",
//   the pointer moves to it (requests wait there), the old app is stopped, and only then is
//   the new app let go. Two copies of the app never run against the database at once; the
//   cost is that requests wait while the new app boots. If the new app does not come up,
//   it is stopped and the old instance is started again.
//
// OVERLAP (only the way back to the old application, which cannot be held). The new instance
//   boots beside the live one; the pointer moves when it answers /health, and the old one
//   is stopped a few seconds later. Nobody waits, but for those seconds two copies run.

/** The name of the old one-container application (the default scheduling policy). */
export const LEGACY = 'legacy'

export const HANDOVER = 'handover'
export const OVERLAP = 'overlap'
/**
 * What an instance must speak to be handed over FROM (a stop that keeps its record, resume).
 * A Durable Object can go on running the previous version of this code for minutes after a
 * deploy, so the router asks, and waits, instead of calling a method that is not there yet.
 */
export const PROTOCOL = 2

/** OVERLAP: after the pointer moves, how long the old instance keeps serving before SIGTERM. */
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

/** `hasLegacy`: the old application is bound, so it is what serves until the first swap. */
export function initialState({ hasLegacy = false } = {}) {
  return {
    v: 1,
    seq: 0,
    live: hasLegacy ? { name: LEGACY, since: 0 } : null,
    next: null,
    handover: null,
    retiring: [],
    failed: null,
    forced: null,
    history: [],
  }
}

/**
 * What the live instance runs, as far as the facts say: LEGACY for the old application, the
 * image a host reports, or undefined when the host could not be asked (never swap on a guess).
 */
function liveImageOf(state, facts) {
  if (!state.live) return null
  if (state.live.name === LEGACY) return LEGACY
  return facts.live?.begun ? facts.live.image : undefined
}

/**
 * Decide what to do now.
 *
 * state: what the router stored last time (never mutated).
 * facts: { live, next, wanted, target }
 *   live / next: what each instance reports ({ begun, image, running, ready, parked, stopped,
 *     exits, protocol, commit }), or null when it could not be asked.
 *   wanted: the image the newest version of the code wants to run (null when unknown).
 *   target: 'hosts' (normal) or 'legacy' (the rollback lever: go back to the old application).
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
  const target = facts.target === LEGACY ? LEGACY : 'hosts'
  const note = (entry) => {
    next.history = [...next.history, { at: now, ...entry }].slice(-HISTORY_KEPT)
  }

  if (next.handover) {
    planHandover(next, facts, now, actions, note)
  } else if (next.next) {
    const candidate = next.next
    const held = candidate.style === HANDOVER
    const canHandOver = (facts.live?.protocol ?? 0) >= PROTOCOL
    if (held && facts.next?.parked && next.live && canHandOver) {
      // The hand-over begins. The pointer moves first, so from this moment requests wait on
      // the new instance instead of arriving at an app that is about to stop.
      const from = next.live
      const image = facts.next.image ?? candidate.image ?? null
      next.handover = { from: from.name, fromLive: from, to: candidate.name, at: now, phase: 'stop', reason: candidate.reason, startedAt: candidate.startedAt, image }
      next.live = { name: candidate.name, since: now, image, commit: facts.next.commit ?? null }
      next.next = null
      actions.push({ type: 'stop', name: from.name, seq: true, settle: true }, { type: 'release', name: candidate.name, seq: true })
    } else if (facts.next?.ready) {
      // The overlap swap: the new app is already answering. The old instance is NOT stopped
      // here: see RETIRE_GRACE_MS.
      const from = next.live?.name ?? null
      if (from && from !== candidate.name) next.retiring.push({ name: from, at: now, tries: 0, wasLive: true })
      next.live = { name: candidate.name, since: now, image: facts.next.image ?? null, commit: facts.next.commit ?? null }
      next.next = null
      next.failed = null
      note({ from, to: candidate.name, reason: candidate.reason, tookMs: now - candidate.startedAt, commit: facts.next.commit ?? null })
    } else if (
      candidate.name !== LEGACY &&
      (target === LEGACY || (facts.wanted && facts.next?.begun && facts.next.image && facts.next.image !== facts.wanted))
    ) {
      // A newer deploy arrived while this one was still coming up (or the target became the
      // old application): drop it and go straight to what is wanted now (the next look
      // starts it) instead of waiting out the older one.
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
      actions.push({ type: 'begin', name: candidate.name, reason: candidate.reason, forced: false, held })
    }
  } else if (!next.live) {
    // Nothing has ever served (a brand-new deployment with no old application): there is
    // nothing to keep serving, so the first instance is live at once and requests wait on it.
    if (target === LEGACY) {
      next.live = { name: LEGACY, since: now }
    } else {
      next.seq += 1
      next.live = { name: hostName(next.seq), since: now, image: null, commit: null }
      actions.push({ type: 'begin', name: next.live.name, reason: 'first', forced: false, held: false })
    }
  } else if (next.live.name !== LEGACY && facts.live && facts.live.begun === false) {
    // The live host has lost its own record of what to run (it should never happen). Nothing
    // else is serving, so set the same host up again rather than leave every request failing.
    actions.push({ type: 'begin', name: next.live.name, reason: 'revive', forced: false, held: false })
  } else if (next.live.name !== LEGACY && facts.live?.stopped) {
    // The live host is stopped (a hand-over was undone and the start-again did not stick).
    // Nothing else is serving: start it.
    actions.push({ type: 'resume', name: next.live.name })
  } else {
    const liveImage = liveImageOf(next, facts)
    const wanted = target === LEGACY ? LEGACY : (facts.wanted ?? null)
    const failed = next.failed && next.failed.image === wanted ? next.failed : null
    // An image whose hand-over was undone is never tried again by itself: every try makes
    // people wait. A new deploy (another image) is tried at once.
    const failedRecently = failed && (failed.final === true || now - failed.at < FAILED_RETRY_MS)
    const forced = next.forced && target !== LEGACY && !failed?.final ? next.forced : null
    const imageChanged = wanted !== null && liveImage !== undefined && liveImage !== wanted
    if (forced || (imageChanged && !failedRecently)) {
      let name = LEGACY
      if (target !== LEGACY) {
        next.seq += 1
        name = hostName(next.seq)
      }
      const reason = forced ? forced.reason : target === LEGACY ? 'back to legacy' : liveImage === LEGACY ? 'cutover' : 'image'
      // The old application cannot be held (its image has no hold), so the way back overlaps.
      const style = name === LEGACY ? OVERLAP : HANDOVER
      next.next = { name, startedAt: now, reason, image: wanted === LEGACY ? LEGACY : wanted, style }
      next.forced = null
      actions.push({ type: 'begin', name, reason, forced: Boolean(forced), held: style === HANDOVER })
    }
  }

  // Old instances whose grace period is over. The router removes one from the list when the
  // stop succeeded (retired()), or schedules another try (retireFailed()); one is never
  // forgotten while it may still be running.
  const busy = new Set([next.live?.name, next.next?.name, next.handover?.from].filter(Boolean))
  if (next.handover && next.handover.phase !== 'resume') busy.add(next.handover.to)
  for (const old of next.retiring) {
    if (busy.has(old.name)) continue
    // The instance that was serving a moment ago is kept while the new live one is not
    // answering (it crashed right after the swap): it is the only thing known to work.
    if (old.wasLive && facts.live && facts.live.ready === false && now - old.at < ROLLOUT_TIMEOUT_MS) continue
    if (now >= (old.retryAt ?? old.at + RETIRE_GRACE_MS)) actions.push({ type: 'retire', name: old.name })
  }
  // An instance that became live or next again (back to legacy and forward again) is not old.
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
      // The old host is already stopped; this forgets its record. (The old application keeps
      // nothing to forget: its stop was already for good.)
      if (h.from !== LEGACY) next.retiring.push({ name: h.from, at: now - RETIRE_GRACE_MS, tries: 0 })
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
    if (now - (h.undoneAt ?? h.at) > HANDOVER_STOP_TIMEOUT_MS) {
      // The new instance will not confirm it stopped. It was not serving and is not being
      // sent anything; stopping it goes on being retried, but the old one must serve now.
      next.retiring.push({ name: h.to, at: now - RETIRE_GRACE_MS, tries: 0 })
      next.handover = { ...h, phase: 'resume' }
      actions.push(resume)
    } else {
      actions.push(retire, resume)
    }
  } else {
    actions.push(resume)
  }
}

/** A step of the hand-over worked: move to its next phase. Anything unexpected changes nothing. */
export function handoverStep(state, event, { name, now, graceful = null } = {}) {
  const h = state.handover
  if (!h) return state
  if (event === 'stopped' && h.phase === 'stop' && name === h.from) {
    return { ...state, handover: { ...h, phase: 'release', stoppedAt: now, graceful } }
  }
  if (event === 'released' && h.phase === 'release' && name === h.to) {
    return { ...state, handover: { ...h, phase: 'boot', releasedAt: now } }
  }
  if (event === 'retired' && h.phase === 'undo' && name === h.to) {
    return { ...state, handover: { ...h, phase: 'resume' } }
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
