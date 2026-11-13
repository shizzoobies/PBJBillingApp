import { describe, expect, it } from 'vitest'
import {
  FAILED_RETRY_MS,
  LEGACY,
  MAX_RETIRE_TRIES,
  RETIRE_GRACE_MS,
  ROLLOUT_TIMEOUT_MS,
  TICK_FAST_MS,
  TICK_SLOW_MS,
  force,
  initialState,
  plan,
  retireFailed,
  retired,
} from './rollout.js'

const T = 1_000_000
const host = (image, extra = {}) => ({ begun: true, image, running: true, ready: true, commit: 'abc1234', ...extra })
const liveOn = (name, extra = {}) => ({ ...initialState(), seq: 1, live: { name, since: T - 60_000 }, ...extra })

describe('the first start', () => {
  it('with nothing serving, the first host is live at once and is started', () => {
    const { state, actions, delay } = plan(initialState(), { live: null, next: null, wanted: 'img-1', target: 'hosts' }, T)
    expect(state.live.name).toBe('app-1')
    expect(state.next).toBeNull()
    expect(actions).toEqual([{ type: 'begin', name: 'app-1', reason: 'first', forced: false }])
    expect(delay).toBe(TICK_SLOW_MS)
  })

  it('with the old application bound, it serves until the first swap', () => {
    expect(initialState({ hasLegacy: true }).live.name).toBe(LEGACY)
  })
})

describe('a new image', () => {
  it('starts a second host beside the live one and leaves the pointer alone', () => {
    const before = liveOn('app-1')
    const { state, actions, delay } = plan(before, { live: host('img-1'), next: null, wanted: 'img-2', target: 'hosts' }, T)
    expect(state.live.name).toBe('app-1')
    expect(state.next).toMatchObject({ name: 'app-2', startedAt: T, reason: 'image' })
    expect(actions).toEqual([{ type: 'begin', name: 'app-2', reason: 'image', forced: false }])
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

  it('keeps waiting while the new host is not healthy, and the pointer does not move', () => {
    const state = liveOn('app-1', { seq: 2, next: { name: 'app-2', startedAt: T - 60_000, reason: 'image' } })
    const out = plan(state, { live: host('img-1'), next: host('img-2', { ready: false }), wanted: null, target: 'hosts' }, T)
    expect(out.state.live.name).toBe('app-1')
    expect(out.state.next.name).toBe('app-2')
    expect(out.actions).toEqual([])
    expect(out.delay).toBe(TICK_FAST_MS)
  })

  it('asks a host whose start did not take to begin again', () => {
    const state = liveOn('app-1', { seq: 2, next: { name: 'app-2', startedAt: T - 4_000, reason: 'image' } })
    const out = plan(state, { live: host('img-1'), next: { begun: false, image: null, running: false, ready: false }, wanted: null, target: 'hosts' }, T)
    expect(out.actions).toEqual([{ type: 'begin', name: 'app-2', reason: 'image', forced: false }])
  })

  it('moves the pointer only when the new host answers /health, and does not stop the old one yet', () => {
    const state = liveOn('app-1', { seq: 2, next: { name: 'app-2', startedAt: T - 90_000, reason: 'image' } })
    const out = plan(state, { live: host('img-1'), next: host('img-2', { commit: 'def5678' }), wanted: null, target: 'hosts' }, T)
    expect(out.state.live).toMatchObject({ name: 'app-2', since: T, image: 'img-2', commit: 'def5678' })
    expect(out.state.next).toBeNull()
    expect(out.state.retiring).toEqual([{ name: 'app-1', at: T, tries: 0 }])
    expect(out.actions).toEqual([])
    expect(out.delay).toBe(TICK_FAST_MS)
    expect(out.state.history.at(-1)).toMatchObject({ from: 'app-1', to: 'app-2', reason: 'image', tookMs: 90_000 })
  })

  it('stops the old host only after the grace period', () => {
    const state = liveOn('app-2', { seq: 2, retiring: [{ name: 'app-1', at: T, tries: 0 }] })
    const facts = { live: host('img-2'), next: null, wanted: 'img-2', target: 'hosts' }
    expect(plan(state, facts, T + RETIRE_GRACE_MS - 1).actions).toEqual([])
    const due = plan(state, facts, T + RETIRE_GRACE_MS)
    expect(due.actions).toEqual([{ type: 'retire', name: 'app-1' }])
    // It stays listed until the router reports the stop worked.
    expect(due.state.retiring).toHaveLength(1)
    expect(retired(due.state, 'app-1').retiring).toEqual([])
  })
})

describe('a swap that fails', () => {
  it('gives up on a host that never becomes healthy, keeps the live one, and stops the failed one', () => {
    const state = liveOn('app-1', { seq: 2, next: { name: 'app-2', startedAt: T - ROLLOUT_TIMEOUT_MS - 1, reason: 'image', image: 'img-2' } })
    const out = plan(state, { live: host('img-1'), next: host('img-2', { ready: false }), wanted: null, target: 'hosts' }, T)
    expect(out.state.live.name).toBe('app-1')
    expect(out.state.next).toBeNull()
    expect(out.state.failed).toMatchObject({ image: 'img-2', name: 'app-2', at: T })
    expect(out.actions).toEqual([{ type: 'retire', name: 'app-2' }])
    expect(out.state.history.at(-1)).toMatchObject({ to: 'app-2', failed: true })
  })

  it('does not try the same image again for a while, then does; a different image is tried at once', () => {
    const state = liveOn('app-1', { seq: 2, failed: { image: 'img-2', name: 'app-2', at: T } })
    const facts = (wanted) => ({ live: host('img-1'), next: null, wanted, target: 'hosts' })
    expect(plan(state, facts('img-2'), T + FAILED_RETRY_MS - 1).actions).toEqual([])
    expect(plan(state, facts('img-2'), T + FAILED_RETRY_MS).actions).toEqual([{ type: 'begin', name: 'app-3', reason: 'image', forced: false }])
    expect(plan(state, facts('img-3'), T + 1).actions).toEqual([{ type: 'begin', name: 'app-3', reason: 'image', forced: false }])
  })

  it('counts failed stops and drops the instance after the last try', () => {
    let state = liveOn('app-2', { retiring: [{ name: 'app-1', at: T, tries: 0 }] })
    for (let i = 1; i < MAX_RETIRE_TRIES; i++) {
      const out = retireFailed(state, 'app-1')
      expect(out.dropped).toBe(false)
      expect(out.state.retiring[0].tries).toBe(i)
      state = out.state
    }
    const last = retireFailed(state, 'app-1')
    expect(last.dropped).toBe(true)
    expect(last.state.retiring).toEqual([])
  })

  it('sets a live host up again when it has lost its own record', () => {
    const out = plan(liveOn('app-1'), { live: { begun: false, image: null, running: false, ready: false }, next: null, wanted: 'img-1', target: 'hosts' }, T)
    expect(out.actions).toEqual([{ type: 'begin', name: 'app-1', reason: 'revive', forced: false }])
    expect(out.state.live.name).toBe('app-1')
  })
})

describe('a restart on demand', () => {
  it('swaps to a fresh host on the same image, and only once', () => {
    const state = force(liveOn('app-1'), 'restart')
    const out = plan(state, { live: host('img-1'), next: null, wanted: 'img-1', target: 'hosts' }, T)
    expect(out.actions).toEqual([{ type: 'begin', name: 'app-2', reason: 'restart', forced: true }])
    expect(out.state.forced).toBeNull()
    expect(out.state.next).toMatchObject({ name: 'app-2', reason: 'restart' })
  })

  it('waits for a swap already in progress instead of starting a second one', () => {
    const state = force(liveOn('app-1', { seq: 2, next: { name: 'app-2', startedAt: T - 1_000, reason: 'image' } }), 'restart')
    const out = plan(state, { live: host('img-1'), next: host('img-2', { ready: false }), wanted: null, target: 'hosts' }, T)
    expect(out.actions).toEqual([])
    expect(out.state.forced).toEqual({ reason: 'restart' })
  })
})

describe('the old application', () => {
  it('cuts over from it like any other swap: it serves until the first host is healthy', () => {
    const start = initialState({ hasLegacy: true })
    const first = plan(start, { live: { begun: true, image: LEGACY, ready: true }, next: null, wanted: 'img-1', target: 'hosts' }, T)
    expect(first.state.live.name).toBe(LEGACY)
    expect(first.actions).toEqual([{ type: 'begin', name: 'app-1', reason: 'cutover', forced: false }])
    const second = plan(first.state, { live: { begun: true, image: LEGACY, ready: true }, next: host('img-1'), wanted: null, target: 'hosts' }, T + 30_000)
    expect(second.state.live.name).toBe('app-1')
    expect(second.state.retiring).toEqual([{ name: LEGACY, at: T + 30_000, tries: 0 }])
    const third = plan(second.state, { live: host('img-1'), next: null, wanted: 'img-1', target: 'hosts' }, T + 30_000 + RETIRE_GRACE_MS)
    expect(third.actions).toEqual([{ type: 'retire', name: LEGACY }])
  })

  it('stays on it while the target says legacy, whatever image the code wants', () => {
    const out = plan(initialState({ hasLegacy: true }), { live: { begun: true, image: LEGACY, ready: true }, next: null, wanted: null, target: LEGACY }, T)
    expect(out.actions).toEqual([])
    expect(out.state.live.name).toBe(LEGACY)
  })

  it('goes back to it on request: it is started, and the host stops only after it answers', () => {
    const state = liveOn('app-3', { seq: 3 })
    const first = plan(state, { live: host('img-3'), next: null, wanted: null, target: LEGACY }, T)
    expect(first.actions).toEqual([{ type: 'begin', name: LEGACY, reason: 'back to legacy', forced: false }])
    expect(first.state.seq).toBe(3)
    const waiting = plan(first.state, { live: host('img-3'), next: { begun: true, image: LEGACY, ready: false }, wanted: null, target: LEGACY }, T + 5_000)
    expect(waiting.state.live.name).toBe('app-3')
    const done = plan(first.state, { live: host('img-3'), next: { begun: true, image: LEGACY, ready: true }, wanted: null, target: LEGACY }, T + 9_000)
    expect(done.state.live.name).toBe(LEGACY)
    expect(done.state.retiring).toEqual([{ name: 'app-3', at: T + 9_000, tries: 0 }])
  })

  it('is not stopped if it became live again before its grace period ran out', () => {
    const state = { ...initialState(), seq: 1, live: { name: LEGACY, since: T }, retiring: [{ name: LEGACY, at: T - 60_000, tries: 0 }] }
    const out = plan(state, { live: { begun: true, image: LEGACY, ready: true }, next: null, wanted: null, target: LEGACY }, T)
    expect(out.actions).toEqual([])
    expect(out.state.retiring).toEqual([])
  })
})
