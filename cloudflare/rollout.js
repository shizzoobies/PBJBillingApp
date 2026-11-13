// The swap rules for zero-downtime deploys (docs/plans/zero-downtime-deploy-2026-11.md).
// Pure: no Cloudflare API in this file, so every rule is unit-tested (rollout.test.mjs).
// cloudflare/worker.js gathers the facts, calls plan(), and carries out the actions.
//
// The idea: the app runs in one "live" instance. When the image the code wants differs from
// the image the live instance runs, a second instance ("next") is started beside it. Only
// when next answers /health does the pointer move; the old instance keeps serving for a few
// seconds more (requests already on their way to it), then is asked to stop. A next that
// never becomes healthy is given up on and the live instance simply keeps serving.

/** The name of the old one-container application (the default scheduling policy). */
export const LEGACY = 'legacy'

/** After the pointer moves, how long the old instance keeps serving before SIGTERM. */
export const RETIRE_GRACE_MS = 5_000
/** How long a new instance may take to become healthy before the swap is given up on. */
export const ROLLOUT_TIMEOUT_MS = 20 * 60_000
/** After a failed swap, how long before the same image is tried again. */
export const FAILED_RETRY_MS = 30 * 60_000
/** Tries at stopping an old instance before it is dropped from the list (and logged). */
export const MAX_RETIRE_TRIES = 5
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
 *   live / next: what each instance reports ({ begun, image, running, ready, commit }), or null
 *     when it could not be asked.
 *   wanted: the image this version of the code wants to run (null when unknown).
 *   target: 'hosts' (normal) or 'legacy' (the rollback lever: go back to the old application).
 * Returns { state, actions, delay } where actions are, in order:
 *   { type: 'begin', name, reason, forced }   start an instance
 *   { type: 'retire', name }                  stop an instance for good
 */
export function plan(state, facts, now) {
  const next = { ...state, retiring: [...state.retiring], history: [...state.history] }
  const actions = []
  const target = facts.target === LEGACY ? LEGACY : 'hosts'

  if (next.next) {
    const candidate = next.next
    if (facts.next?.ready) {
      // The swap itself. The old instance is NOT stopped here: see RETIRE_GRACE_MS.
      const from = next.live?.name ?? null
      if (from && from !== candidate.name) next.retiring.push({ name: from, at: now, tries: 0 })
      next.live = { name: candidate.name, since: now, image: facts.next.image ?? null, commit: facts.next.commit ?? null }
      next.next = null
      next.failed = null
      next.history = [
        ...next.history,
        { at: now, from, to: candidate.name, reason: candidate.reason, tookMs: now - candidate.startedAt, commit: facts.next.commit ?? null },
      ].slice(-HISTORY_KEPT)
    } else if (now - candidate.startedAt > ROLLOUT_TIMEOUT_MS) {
      // Given up on. It goes on the old-instances list, already due, so a failed stop is retried.
      next.retiring.push({ name: candidate.name, at: now - RETIRE_GRACE_MS, tries: 0 })
      next.failed ={ image: facts.next?.image ?? candidate.image ?? null, name: candidate.name, at: now }
      next.next = null
      next.history = [
        ...next.history,
        { at: now, from: next.live?.name ?? null, to: candidate.name, reason: candidate.reason, failed: true, tookMs: now - candidate.startedAt },
      ].slice(-HISTORY_KEPT)
    } else if (facts.next && facts.next.begun === false) {
      // The start did not take (the call failed last time): ask again. Starting is idempotent.
      actions.push({ type: 'begin', name: candidate.name, reason: candidate.reason, forced: false })
    }
  } else if (!next.live) {
    // Nothing has ever served (a brand-new deployment with no old application): there is
    // nothing to keep serving, so the first instance is live at once and requests wait on it.
    if (target === LEGACY) {
      next.live = { name: LEGACY, since: now }
    } else {
      next.seq += 1
      next.live = { name: hostName(next.seq), since: now, image: null, commit: null }
      actions.push({ type: 'begin', name: next.live.name, reason: 'first', forced: false })
    }
  } else if (next.live.name !== LEGACY && facts.live && facts.live.begun === false) {
    // The live host has lost its own record of what to run (it should never happen). Nothing
    // else is serving, so set the same host up again rather than leave every request failing.
    actions.push({ type: 'begin', name: next.live.name, reason: 'revive', forced: false })
  } else {
    const liveImage = liveImageOf(next, facts)
    const wanted = target === LEGACY ? LEGACY : (facts.wanted ?? null)
    const failedRecently = next.failed && next.failed.image === wanted && now - next.failed.at < FAILED_RETRY_MS
    const forced = next.forced && target !== LEGACY ? next.forced : null
    const imageChanged = wanted !== null && liveImage !== undefined && liveImage !== wanted
    if (forced || (imageChanged && !failedRecently)) {
      let name = LEGACY
      if (target !== LEGACY) {
        next.seq += 1
        name = hostName(next.seq)
      }
      const reason = forced ? forced.reason : target === LEGACY ? 'back to legacy' : liveImage === LEGACY ? 'cutover' : 'image'
      next.next = { name, startedAt: now, reason, image: wanted === LEGACY ? LEGACY : wanted }
      next.forced = null
      actions.push({ type: 'begin', name, reason, forced: Boolean(forced) })
    }
  }

  // Old instances whose grace period is over. The router removes one from the list when the
  // stop succeeded (retired()), or counts the failure (retireFailed()).
  for (const old of next.retiring) {
    if (old.name === next.live?.name || old.name === next.next?.name) continue
    if (now - old.at >= RETIRE_GRACE_MS) actions.push({ type: 'retire', name: old.name })
  }
  // An instance that became live or next again (back to legacy and forward again) is not old.
  next.retiring = next.retiring.filter((old) => old.name !== next.live?.name && old.name !== next.next?.name)

  const busy = Boolean(next.next) || next.retiring.length > 0
  return { state: next, actions, delay: busy ? TICK_FAST_MS : TICK_SLOW_MS }
}

/** The instance was stopped for good: forget it. */
export function retired(state, name) {
  return { ...state, retiring: state.retiring.filter((old) => old.name !== name) }
}

/** Stopping it failed: try again next time, up to MAX_RETIRE_TRIES. `dropped` says it was given up on. */
export function retireFailed(state, name) {
  let dropped = false
  const retiring = []
  for (const old of state.retiring) {
    if (old.name !== name) {
      retiring.push(old)
      continue
    }
    const tries = (old.tries ?? 0) + 1
    if (tries >= MAX_RETIRE_TRIES) dropped = true
    else retiring.push({ ...old, tries })
  }
  return { state: { ...state, retiring }, dropped }
}

/** Ask for a swap to a fresh instance on the same image (a restart that reloads the environment). */
export function force(state, reason = 'restart') {
  return { ...state, forced: { reason: String(reason).slice(0, 40) } }
}
