import { describe, expect, it } from 'vitest'
import {
  FAILED_RETRY_MS,
  HANDOVER,
  HANDOVER_BOOT_TIMEOUT_MS,
  HANDOVER_STOP_TIMEOUT_MS,
  LEGACY,
  OVERLAP,
  PROTOCOL,
  RETIRE_RETRY_CAP_MS,
  RETIRE_RETRY_MS,
  RETIRE_GRACE_MS,
  ROLLOUT_TIMEOUT_MS,
  TICK_FAST_MS,
  TICK_SLOW_MS,
  force,
  handoverStep,
  initialState,
  plan,
  retireFailed,
  retired,
} from './rollout.js'

const T = 1_000_000
const host = (image, extra = {}) => ({ begun: true, image, running: true, ready: true, commit: 'abc1234', protocol: PROTOCOL, ...extra })
/** A held instance: its container is up, its app is not. `parked` says its checks pass. */
const held = (image, extra = {}) => ({ begun: true, image, running: true, ready: false, held: true, parked: true, commit: 'def5678', ...extra })
const liveOn = (name, extra = {}) => ({ ...initialState(), seq: 1, live: { name, since: T - 60_000 }, ...extra })
const candidate = (name, extra = {}) => ({ name, startedAt: T - 30_000, reason: 'image', image: 'img-2', style: HANDOVER, ...extra })
const legacyLive = { begun: true, image: LEGACY, ready: true, protocol: PROTOCOL }

describe('the first start', () => {
  it('with nothing serving, the first host is live at once and is started (not held: nothing to hand over from)', () => {
    const { state, actions, delay } = plan(initialState(), { live: null, next: null, wanted: 'img-1', target: 'hosts' }, T)
    expect(state.live.name).toBe('app-1')
    expect(state.next).toBeNull()
    expect(actions).toEqual([{ type: 'begin', name: 'app-1', reason: 'first', forced: false, held: false }])
    expect(delay).toBe(TICK_SLOW_MS)
  })

  it('with the old application bound, it serves until the first swap', () => {
    expect(initialState({ hasLegacy: true }).live.name).toBe(LEGACY)
  })
})

describe('a new image', () => {
  it('starts a second host beside the live one, held, and leaves the pointer alone', () => {
    const before = liveOn('app-1')
    const { state, actions, delay } = plan(before, { live: host('img-1'), next: null, wanted: 'img-2', target: 'hosts' }, T)
    expect(state.live.name).toBe('app-1')
    expect(state.next).toMatchObject({ name: 'app-2', startedAt: T, reason: 'image', style: HANDOVER })
    expect(actions).toEqual([{ type: 'begin', name: 'app-2', reason: 'image', forced: false, held: true }])
    expect(delay).toBe(TICK_FAST_MS)
    // The stored state is never mutated.
    expect(before.next).toBeNull()
    expect(before.seq).toBe(1)
  })

  it('does nothing while the live host runs the wanted image', () => {
    const { state, actions } = plan(liveOn('app-1'), { live: host('img-1'), next: null, wanted: 'img-1', target: 'hosts' }, T)
    expect(state.next).toBeNull()
    expect(actions).toEqual([])
  })

  it('never swaps on a guess: an unanswered live host or an unknown wanted image changes nothing', () => {
    expect(plan(liveOn('app-1'), { live: null, next: null, wanted: 'img-2', target: 'hosts' }, T).actions).toEqual([])
    expect(plan(liveOn('app-1'), { live: host('img-1'), next: null, wanted: null, target: 'hosts' }, T).actions).toEqual([])
  })

  it('keeps waiting, pointer unmoved, while the new host is still coming up or its checks do not pass', () => {
    const state = liveOn('app-1', { seq: 2, next: candidate('app-2') })
    for (const next of [held('img-2', { running: false, parked: false }), held('img-2', { parked: false, checks: { database: 'failed' } }), null]) {
      const out = plan(state, { live: host('img-1'), next, wanted: null, target: 'hosts' }, T)
      expect(out.state.live.name).toBe('app-1')
      expect(out.state.next.name).toBe('app-2')
      expect(out.state.handover).toBeNull()
      expect(out.actions).toEqual([])
      expect(out.delay).toBe(TICK_FAST_MS)
    }
  })

  it('drops a host that is still coming up when a newer deploy arrives, then starts the newest image', () => {
    const state = liveOn('app-1', { seq: 2, next: candidate('app-2') })
    const out = plan(state, { live: host('img-1'), next: held('img-2', { parked: false }), wanted: 'img-3', target: 'hosts' }, T)
    expect(out.state.live.name).toBe('app-1')
    expect(out.state.next).toBeNull()
    expect(out.state.failed).toBeNull()
    expect(out.actions).toEqual([{ type: 'retire', name: 'app-2' }])
    expect(out.state.history.at(-1)).toMatchObject({ to: 'app-2', superseded: true })
    const after = plan(retired(out.state, 'app-2'), { live: host('img-1'), next: null, wanted: 'img-3', target: 'hosts' }, T + 2_000)
    expect(after.actions).toEqual([{ type: 'begin', name: 'app-3', reason: 'image', forced: false, held: true }])
  })

  it('still hands over to a host that is already parked when a newer deploy arrives (the newest follows)', () => {
    const state = liveOn('app-1', { seq: 2, next: candidate('app-2') })
    const out = plan(state, { live: host('img-1'), next: held('img-2'), wanted: 'img-3', target: 'hosts' }, T)
    expect(out.state.live.name).toBe('app-2')
    expect(out.state.handover).toMatchObject({ from: 'app-1', to: 'app-2', phase: 'stop' })
  })

  it('a restart onto the same image is not mistaken for a newer deploy', () => {
    const state = liveOn('app-1', { seq: 2, next: candidate('app-2', { reason: 'restart', image: 'img-1' }) })
    const out = plan(state, { live: host('img-1'), next: held('img-1', { parked: false }), wanted: 'img-1', target: 'hosts' }, T)
    expect(out.state.next.name).toBe('app-2')
    expect(out.actions).toEqual([])
  })

  it('asks a host whose start did not take to begin again, held as before', () => {
    const state = liveOn('app-1', { seq: 2, next: candidate('app-2') })
    const out = plan(state, { live: host('img-1'), next: { begun: false, image: null, running: false, ready: false }, wanted: null, target: 'hosts' }, T)
    expect(out.actions).toEqual([{ type: 'begin', name: 'app-2', reason: 'image', forced: false, held: true }])
  })

  it('stops an old host on the list only after the grace period', () => {
    const state = liveOn('app-2', { seq: 2, retiring: [{ name: 'app-1', at: T, tries: 0 }] })
    const facts = { live: host('img-2'), next: null, wanted: 'img-2', target: 'hosts' }
    expect(plan(state, facts, T + RETIRE_GRACE_MS - 1).actions).toEqual([])
    const due = plan(state, facts, T + RETIRE_GRACE_MS)
    expect(due.actions).toEqual([{ type: 'retire', name: 'app-1' }])
    // It stays listed until the router reports the stop worked.
    expect(due.state.retiring).toHaveLength(1)
    const after = retired(due.state, 'app-1', { graceful: true, now: T + 9_000 })
    expect(after.retiring).toEqual([])
    expect(after.history.at(-1)).toEqual({ at: T + 9_000, stopped: 'app-1', graceful: true })
  })
})

describe('a hand-over', () => {
  const stop = { type: 'stop', name: 'app-1', seq: true }
  const release = { type: 'release', name: 'app-2', seq: true }
  const begun = () => {
    const state = liveOn('app-1', { seq: 2, next: candidate('app-2') })
    return plan(state, { live: host('img-1'), next: held('img-2'), wanted: 'img-2', target: 'hosts' }, T)
  }
  /** The state once the old app is stopped and the new one has been let go. */
  const booting = () => {
    let state = handoverStep(begun().state, 'stopped', { name: 'app-1', now: T + 3_000, graceful: true })
    state = handoverStep(state, 'released', { name: 'app-2', now: T + 3_100 })
    return state
  }
  const bootFacts = (extra = {}) => ({ live: host('img-2', { ready: false, commit: null, ...extra }), next: null, wanted: 'img-2', target: 'hosts' })

  it('begins when the new host is parked: the pointer moves first, then the old app is stopped, then the new one let go', () => {
    const out = begun()
    expect(out.state.live).toMatchObject({ name: 'app-2', since: T, image: 'img-2' })
    expect(out.state.next).toBeNull()
    expect(out.state.handover).toMatchObject({ from: 'app-1', to: 'app-2', at: T, phase: 'stop', reason: 'image', image: 'img-2' })
    expect(out.state.handover.fromLive).toEqual({ name: 'app-1', since: T - 60_000 })
    // In this order, each a step of one sequence; the first waits a moment for requests on their way.
    expect(out.actions).toEqual([{ ...stop, settle: true }, release])
    expect(out.delay).toBe(TICK_FAST_MS)
    // Nothing is on the old-instances list: the old host is the way back until the new app answers.
    expect(out.state.retiring).toEqual([])
  })

  it('does not begin while the live instance runs a version of the code that cannot be handed over from', () => {
    const state = liveOn('app-1', { seq: 2, next: candidate('app-2') })
    for (const protocol of [undefined, 0, 1]) {
      const out = plan(state, { live: host('img-1', { protocol }), next: held('img-2'), wanted: 'img-2', target: 'hosts' }, T)
      expect(out.state.live.name).toBe('app-1')
      expect(out.state.handover).toBeNull()
      expect(out.state.next.name).toBe('app-2')
      expect(out.actions).toEqual([])
    }
    // Not for ever: the parked instance is given up on like any other that never took over.
    const waited = { ...state, next: candidate('app-2', { startedAt: T - ROLLOUT_TIMEOUT_MS - 1 }) }
    const late = plan(waited, { live: host('img-1', { protocol: 0 }), next: held('img-2'), wanted: 'img-2', target: 'hosts' }, T)
    expect(late.state.failed).toMatchObject({ name: 'app-2', why: 'the live instance could not hand over' })
    expect(late.state.live.name).toBe('app-1')
  })

  it('asks for the stop again (and only then the release) until the router says the old app is stopped', () => {
    const again = plan(begun().state, { live: held('img-2'), next: null, wanted: 'img-2', target: 'hosts' }, T + 2_000)
    expect(again.actions).toEqual([stop, release])
    expect(again.state.handover.phase).toBe('stop')
    // A release reported before the stop changes nothing: the order is fixed.
    expect(handoverStep(again.state, 'released', { name: 'app-2', now: T + 2_500 })).toBe(again.state)
  })

  it('once the old app is stopped, only the release is asked for; once let go, it waits for /health', () => {
    const stopped = handoverStep(begun().state, 'stopped', { name: 'app-1', now: T + 3_000, graceful: true })
    expect(stopped.handover).toMatchObject({ phase: 'release', stoppedAt: T + 3_000, graceful: true })
    expect(plan(stopped, bootFacts(), T + 4_000).actions).toEqual([release])
    const waiting = plan(booting(), bootFacts(), T + 5_000)
    expect(waiting.actions).toEqual([])
    expect(waiting.state.handover.phase).toBe('boot')
    expect(waiting.state.live.name).toBe('app-2')
    expect(waiting.delay).toBe(TICK_FAST_MS)
  })

  it('is done when the new app answers /health: the old host is forgotten and the wait is recorded', () => {
    const out = plan(booting(), { live: host('img-2', { commit: 'def5678' }), next: null, wanted: 'img-2', target: 'hosts' }, T + 14_000)
    expect(out.state.handover).toBeNull()
    expect(out.state.live).toMatchObject({ name: 'app-2', commit: 'def5678' })
    expect(out.state.failed).toBeNull()
    expect(out.actions).toEqual([{ type: 'retire', name: 'app-1' }])
    expect(out.state.history.at(-1)).toMatchObject({
      from: 'app-1',
      to: 'app-2',
      reason: 'image',
      style: HANDOVER,
      tookMs: 44_000,
      pausedMs: 14_000,
      stopMs: 3_000,
      bootMs: 10_900,
      commit: 'def5678',
    })
  })

  it('does not start another swap while one is in progress, even when a newer image is wanted', () => {
    const out = plan(booting(), { ...bootFacts(), wanted: 'img-3' }, T + 5_000)
    expect(out.state.next).toBeNull()
    expect(out.actions).toEqual([])
  })

  it('is undone when the old app will not stop: pointer back, new instance stopped, old one started again', () => {
    const out = plan(begun().state, { live: held('img-2'), next: null, wanted: 'img-2', target: 'hosts' }, T + HANDOVER_STOP_TIMEOUT_MS + 1)
    expect(out.state.live).toEqual({ name: 'app-1', since: T - 60_000 })
    expect(out.state.handover).toMatchObject({ phase: 'undo', why: 'the old instance did not stop' })
    expect(out.actions).toEqual([
      { type: 'retire', name: 'app-2', seq: true },
      { type: 'resume', name: 'app-1', seq: true },
    ])
  })

  it('is undone when the new app does not come up in time, and that image is never tried again by itself', () => {
    const at = T + 3_000 + HANDOVER_BOOT_TIMEOUT_MS + 1
    const out = plan(booting(), bootFacts(), at)
    expect(out.state.live.name).toBe('app-1')
    expect(out.state.handover.phase).toBe('undo')
    expect(out.state.failed).toMatchObject({ image: 'img-2', name: 'app-2', final: true, why: 'the new app did not come up' })
    expect(out.state.history.at(-1)).toMatchObject({ from: 'app-1', to: 'app-2', failed: true, style: HANDOVER })
    expect(out.actions).toEqual([
      { type: 'retire', name: 'app-2', seq: true },
      { type: 'resume', name: 'app-1', seq: true },
    ])

    // The new instance is confirmed stopped BEFORE the old one is started again.
    const again = plan(out.state, { live: host('img-1', { ready: false, stopped: true }), next: null, wanted: 'img-2', target: 'hosts' }, at + 2_000)
    expect(again.actions).toEqual([
      { type: 'retire', name: 'app-2', seq: true },
      { type: 'resume', name: 'app-1', seq: true },
    ])
    const stopped = handoverStep(retired(again.state, 'app-2', { graceful: true, now: at + 3_000 }), 'retired', { name: 'app-2', now: at + 3_000 })
    expect(stopped.handover.phase).toBe('resume')
    expect(plan(stopped, { live: host('img-1', { ready: false, stopped: true }), next: null, wanted: 'img-2', target: 'hosts' }, at + 4_000).actions).toEqual([
      { type: 'resume', name: 'app-1', seq: true },
    ])
    const back = handoverStep(stopped, 'resumed', { name: 'app-1', now: at + 5_000 })
    expect(back.handover).toBeNull()
    expect(back.history.at(-1)).toEqual({ at: at + 5_000, resumed: 'app-1' })

    // Hours later the failed image is still wanted: nothing happens (every try makes people wait).
    const later = plan(back, { live: host('img-1'), next: null, wanted: 'img-2', target: 'hosts' }, at + 10 * FAILED_RETRY_MS)
    expect(later.actions).toEqual([])
    // A restart on demand waits too (a new host could only start the image that failed)...
    const forced = plan(force(back, 'restart'), { live: host('img-1'), next: null, wanted: 'img-2', target: 'hosts' }, at + 60_000)
    expect(forced.actions).toEqual([])
    expect(forced.state.forced).toEqual({ reason: 'restart' })
    // ...and a new deploy is tried at once.
    const fixed = plan(back, { live: host('img-1'), next: null, wanted: 'img-3', target: 'hosts' }, at + 60_000)
    expect(fixed.actions).toEqual([{ type: 'begin', name: 'app-3', reason: 'image', forced: false, held: true }])
  })

  it('is undone at once when the new app keeps exiting, without waiting out the clock', () => {
    const out = plan(booting(), bootFacts({ exits: 2 }), T + 9_000)
    expect(out.state.handover).toMatchObject({ phase: 'undo', why: 'the new app kept exiting' })
    expect(plan(booting(), bootFacts({ exits: 1 }), T + 9_000).state.handover.phase).toBe('boot')
  })

  it('never starts the old app while the new one may still be running, however long its stop keeps failing', () => {
    const undone = plan(booting(), bootFacts({ exits: 2 }), T + 9_000).state
    const stoppedOld = host('img-1', { ready: false, stopped: true })
    const late = T + 9_000 + 10 * HANDOVER_STOP_TIMEOUT_MS
    for (const to of [null, undefined, { begun: true, running: true }]) {
      const out = plan(undone, { live: stoppedOld, next: null, wanted: 'img-2', target: 'hosts', to }, late)
      expect(out.state.handover.phase).toBe('undo')
      expect(out.actions).toEqual([
        { type: 'retire', name: 'app-2', seq: true },
        { type: 'resume', name: 'app-1', seq: true },
      ])
    }
    // Only when the new instance itself says nothing runs there is the old one started
    // without the stop-for-good having worked; forgetting the new one goes on being retried.
    const gone = { live: stoppedOld, next: null, wanted: 'img-2', target: 'hosts', to: { begun: true, running: false } }
    expect(plan(undone, gone, T + 9_000 + HANDOVER_STOP_TIMEOUT_MS - 1).state.handover.phase).toBe('undo')
    const out = plan(undone, gone, T + 9_000 + HANDOVER_STOP_TIMEOUT_MS + 1)
    expect(out.state.handover.phase).toBe('resume')
    expect(out.actions).toEqual([{ type: 'resume', name: 'app-1', seq: true }, { type: 'retire', name: 'app-2' }])
    expect(out.state.retiring).toMatchObject([{ name: 'app-2' }])
  })

  it('when the old instance will not start again, the ordinary rules take over: keep trying, and take a new deploy', () => {
    const undone = plan(booting(), bootFacts({ exits: 2 }), T + 9_000).state
    const resuming = handoverStep(retired(undone, 'app-2', { graceful: true, now: T + 12_000 }), 'retired', { name: 'app-2', now: T + 12_000 })
    expect(resuming.handover).toMatchObject({ phase: 'resume', resumeAt: T + 12_000 })
    const stoppedOld = host('img-1', { ready: false, stopped: true })
    const facts = (wanted) => ({ live: stoppedOld, next: null, wanted, target: 'hosts' })
    expect(plan(resuming, facts('img-2'), T + 12_000 + HANDOVER_STOP_TIMEOUT_MS).state.handover.phase).toBe('resume')
    const out = plan(resuming, facts('img-2'), T + 12_000 + HANDOVER_STOP_TIMEOUT_MS + 1)
    expect(out.state.handover).toBeNull()
    expect(out.state.live).toMatchObject({ name: 'app-1', needsResume: true })
    expect(out.actions).toEqual([{ type: 'resume', name: 'app-1' }])
    expect(out.state.history.at(-1)).toMatchObject({ stuck: 'the old instance did not start again' })
    // Every look tries the start again; the image that failed is still not retried...
    expect(plan(out.state, facts('img-2'), T + 200_000).actions).toEqual([{ type: 'resume', name: 'app-1' }])
    // ...and a new deploy is brought up beside the stopped instance: the other way out.
    expect(plan(out.state, facts('img-3'), T + 200_000).actions).toEqual([
      { type: 'resume', name: 'app-1' },
      { type: 'begin', name: 'app-3', reason: 'image', forced: false, held: true },
    ])
    // Once the start works the mark is cleared.
    const back = handoverStep(out.state, 'resumed', { name: 'app-1', now: T + 201_000 })
    expect(back.live).toEqual({ name: 'app-1', since: T - 60_000 })
    expect(plan(back, { live: host('img-1'), next: null, wanted: 'img-2', target: 'hosts' }, T + 202_000).actions).toEqual([])
  })

  it('a step reported out of order, or for another instance, changes nothing', () => {
    const state = begun().state
    expect(handoverStep(state, 'stopped', { name: 'app-2', now: T })).toBe(state)
    expect(handoverStep(state, 'resumed', { name: 'app-1', now: T })).toBe(state)
    expect(handoverStep(liveOn('app-1'), 'stopped', { name: 'app-1', now: T })).toEqual(liveOn('app-1'))
  })
})

describe('a swap that fails before it starts', () => {
  it('gives up on a host that never comes up, keeps the live one, and stops the failed one', () => {
    const state = liveOn('app-1', { seq: 2, next: candidate('app-2', { startedAt: T - ROLLOUT_TIMEOUT_MS - 1 }) })
    const out = plan(state, { live: host('img-1'), next: held('img-2', { parked: false, checks: { database: 'failed', net: 'skipped' } }), wanted: null, target: 'hosts' }, T)
    expect(out.state.live.name).toBe('app-1')
    expect(out.state.next).toBeNull()
    expect(out.state.handover).toBeNull()
    expect(out.state.failed).toMatchObject({ image: 'img-2', name: 'app-2', at: T, why: 'never came up', checks: { database: 'failed' } })
    expect(out.state.failed.final).toBeUndefined()
    expect(out.actions).toEqual([{ type: 'retire', name: 'app-2' }])
    expect(out.state.history.at(-1)).toMatchObject({ to: 'app-2', failed: true })
  })

  it('does not try the same image again for a while, then does; a different image is tried at once', () => {
    const state = liveOn('app-1', { seq: 2, failed: { image: 'img-2', name: 'app-2', at: T } })
    const facts = (wanted) => ({ live: host('img-1'), next: null, wanted, target: 'hosts' })
    const begin = { type: 'begin', name: 'app-3', reason: 'image', forced: false, held: true }
    expect(plan(state, facts('img-2'), T + FAILED_RETRY_MS - 1).actions).toEqual([])
    expect(plan(state, facts('img-2'), T + FAILED_RETRY_MS).actions).toEqual([begin])
    expect(plan(state, facts('img-3'), T + 1).actions).toEqual([begin])
  })

  it('never forgets an instance whose stop fails: it is tried again, later each time, on the slow heartbeat', () => {
    const facts = { live: host('img-2'), next: null, wanted: 'img-2', target: 'hosts' }
    let state = liveOn('app-2', { seq: 2, retiring: [{ name: 'app-1', at: T, tries: 0 }] })
    state = retireFailed(state, 'app-1', T + 6_000)
    expect(state.retiring).toEqual([{ name: 'app-1', at: T, tries: 1, retryAt: T + 6_000 + RETIRE_RETRY_MS }])
    const early = plan(state, facts, T + 6_000 + RETIRE_RETRY_MS - 1)
    expect(early.actions).toEqual([])
    expect(early.delay).toBe(TICK_SLOW_MS)
    expect(plan(state, facts, T + 6_000 + RETIRE_RETRY_MS).actions).toEqual([{ type: 'retire', name: 'app-1' }])
    for (let i = 0; i < 100; i++) state = retireFailed(state, 'app-1', T)
    expect(state.retiring).toHaveLength(1)
    expect(state.retiring[0].retryAt).toBe(T + RETIRE_RETRY_CAP_MS)
  })

  it('drops a host that is coming up as soon as the target becomes the old application, even one already parked or answering', () => {
    const state = { ...initialState({ hasLegacy: true }), seq: 1, next: candidate('app-1', { reason: 'cutover', image: 'img-1' }) }
    for (const next of [held('img-1', { parked: false }), held('img-1'), host('img-1')]) {
      const out = plan(state, { live: legacyLive, next, wanted: null, target: LEGACY }, T)
      expect(out.state.next).toBeNull()
      expect(out.state.handover).toBeNull()
      expect(out.state.live.name).toBe(LEGACY)
      expect(out.actions).toEqual([{ type: 'retire', name: 'app-1' }])
    }
    // The same from a host: the parked candidate is dropped, and the old application is started on the next look.
    const fromHost = liveOn('app-1', { seq: 2, next: candidate('app-2') })
    const out = plan(fromHost, { live: host('img-1'), next: held('img-2'), wanted: null, target: LEGACY }, T)
    expect(out.state.live.name).toBe('app-1')
    expect(out.state.handover).toBeNull()
    expect(out.actions).toEqual([{ type: 'retire', name: 'app-2' }])
  })

  it('sets a live host up again when it has lost its own record', () => {
    const out = plan(liveOn('app-1'), { live: { begun: false, image: null, running: false, ready: false }, next: null, wanted: 'img-1', target: 'hosts' }, T)
    expect(out.actions).toEqual([{ type: 'begin', name: 'app-1', reason: 'revive', forced: false, held: false }])
    expect(out.state.live.name).toBe('app-1')
  })

  it('starts a live host that is found stopped', () => {
    const out = plan(liveOn('app-1'), { live: host('img-1', { ready: false, stopped: true }), next: null, wanted: 'img-1', target: 'hosts' }, T)
    expect(out.actions).toEqual([{ type: 'resume', name: 'app-1' }])
    expect(out.state.next).toBeNull()
  })
})

describe('a restart on demand', () => {
  it('hands over to a fresh host on the same image, and only once', () => {
    const state = force(liveOn('app-1'), 'restart')
    const out = plan(state, { live: host('img-1'), next: null, wanted: 'img-1', target: 'hosts' }, T)
    expect(out.actions).toEqual([{ type: 'begin', name: 'app-2', reason: 'restart', forced: true, held: true }])
    expect(out.state.forced).toBeNull()
    expect(out.state.next).toMatchObject({ name: 'app-2', reason: 'restart', style: HANDOVER })
  })

  it('waits for a swap already in progress instead of starting a second one', () => {
    const state = force(liveOn('app-1', { seq: 2, next: candidate('app-2', { startedAt: T - 1_000 }) }), 'restart')
    const out = plan(state, { live: host('img-1'), next: held('img-2', { parked: false }), wanted: null, target: 'hosts' }, T)
    expect(out.actions).toEqual([])
    expect(out.state.forced).toEqual({ reason: 'restart' })
  })
})

describe('the old application', () => {
  it('is handed over from like any host: it serves until the first host is parked, and is not listed to be stopped twice', () => {
    const start = initialState({ hasLegacy: true })
    const first = plan(start, { live: legacyLive, next: null, wanted: 'img-1', target: 'hosts' }, T)
    expect(first.state.live.name).toBe(LEGACY)
    expect(first.actions).toEqual([{ type: 'begin', name: 'app-1', reason: 'cutover', forced: false, held: true }])
    const waiting = plan(first.state, { live: legacyLive, next: held('img-1', { parked: false }), wanted: null, target: 'hosts' }, T + 20_000)
    expect(waiting.state.live.name).toBe(LEGACY)
    const second = plan(first.state, { live: legacyLive, next: held('img-1'), wanted: null, target: 'hosts' }, T + 30_000)
    expect(second.state.live.name).toBe('app-1')
    expect(second.actions).toEqual([
      { type: 'stop', name: LEGACY, seq: true, settle: true },
      { type: 'release', name: 'app-1', seq: true },
    ])
    let state = handoverStep(second.state, 'stopped', { name: LEGACY, now: T + 33_000, graceful: true })
    state = handoverStep(state, 'released', { name: 'app-1', now: T + 33_100 })
    const done = plan(state, { live: host('img-1'), next: null, wanted: 'img-1', target: 'hosts' }, T + 45_000)
    expect(done.state.handover).toBeNull()
    expect(done.state.retiring).toEqual([])
    expect(done.actions).toEqual([])
    expect(done.state.history.at(-1)).toMatchObject({ from: LEGACY, to: 'app-1', reason: 'cutover', pausedMs: 15_000 })
  })

  it('is started again if the first host does not come up', () => {
    const first = plan(initialState({ hasLegacy: true }), { live: legacyLive, next: null, wanted: 'img-1', target: 'hosts' }, T)
    let state = plan(first.state, { live: legacyLive, next: held('img-1'), wanted: null, target: 'hosts' }, T + 30_000).state
    state = handoverStep(state, 'stopped', { name: LEGACY, now: T + 33_000, graceful: true })
    state = handoverStep(state, 'released', { name: 'app-1', now: T + 33_100 })
    const out = plan(state, { live: host('img-1', { ready: false, exits: 2 }), next: null, wanted: 'img-1', target: 'hosts' }, T + 50_000)
    expect(out.state.live.name).toBe(LEGACY)
    expect(out.actions).toEqual([
      { type: 'retire', name: 'app-1', seq: true },
      { type: 'resume', name: LEGACY, seq: true },
    ])
  })

  it('stays on it while the target says legacy, whatever image the code wants', () => {
    const out = plan(initialState({ hasLegacy: true }), { live: legacyLive, next: null, wanted: null, target: LEGACY }, T)
    expect(out.actions).toEqual([])
    expect(out.state.live.name).toBe(LEGACY)
  })

  it('goes back to it on request by overlap: it is started, and the host stops only after it answers', () => {
    const state = liveOn('app-3', { seq: 3 })
    const first = plan(state, { live: host('img-3'), next: null, wanted: null, target: LEGACY }, T)
    expect(first.actions).toEqual([{ type: 'begin', name: LEGACY, reason: 'back to legacy', forced: false, held: false }])
    expect(first.state.next.style).toBe(OVERLAP)
    expect(first.state.seq).toBe(3)
    const waiting = plan(first.state, { live: host('img-3'), next: { begun: true, image: LEGACY, ready: false }, wanted: null, target: LEGACY }, T + 5_000)
    expect(waiting.state.live.name).toBe('app-3')
    const done = plan(first.state, { live: host('img-3'), next: { begun: true, image: LEGACY, ready: true }, wanted: null, target: LEGACY }, T + 9_000)
    expect(done.state.live.name).toBe(LEGACY)
    expect(done.state.handover).toBeNull()
    expect(done.state.retiring).toEqual([{ name: 'app-3', at: T + 9_000, tries: 0, wasLive: true }])
    expect(done.actions).toEqual([])
    // The host keeps serving requests on their way to it for the grace period, then stops.
    const later = plan(done.state, { live: legacyLive, next: null, wanted: null, target: LEGACY }, T + 9_000 + RETIRE_GRACE_MS)
    expect(later.actions).toEqual([{ type: 'retire', name: 'app-3' }])
  })

  it('keeps the instance that was just serving while the one that took over by overlap is not answering', () => {
    const state = liveOn('app-2', { seq: 2, retiring: [{ name: 'app-1', at: T, tries: 0, wasLive: true }] })
    const facts = (ready) => ({ live: host('img-2', { ready }), next: null, wanted: 'img-2', target: 'hosts' })
    expect(plan(state, facts(false), T + RETIRE_GRACE_MS + 1).actions).toEqual([])
    expect(plan(state, facts(true), T + RETIRE_GRACE_MS + 1).actions).toEqual([{ type: 'retire', name: 'app-1' }])
    // Not for ever: an instance nothing points at is stopped in the end.
    expect(plan(state, facts(false), T + ROLLOUT_TIMEOUT_MS).actions).toEqual([{ type: 'retire', name: 'app-1' }])
  })

  it('is not stopped if it became live again before its grace period ran out', () => {
    const state = { ...initialState(), seq: 1, live: { name: LEGACY, since: T }, retiring: [{ name: LEGACY, at: T - 60_000, tries: 0 }] }
    const out = plan(state, { live: legacyLive, next: null, wanted: null, target: LEGACY }, T)
    expect(out.actions).toEqual([])
    expect(out.state.retiring).toEqual([])
  })
})
