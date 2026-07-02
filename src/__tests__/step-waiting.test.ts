import { describe, expect, it } from 'vitest'
import { stepIsWaiting } from '../lib/utils'
import type { WaitingOn } from '../lib/types'

/**
 * Pure-helper tests for `stepIsWaiting` — the shared predicate that decides
 * whether a checklist step is "waiting." It's true when the legacy `waiting`
 * boolean is set OR the node carries ≥1 structured person-blocker.
 */
const blocker = (): WaitingOn => ({
  id: 'wo-abcd1234',
  blockerId: 'emp-brit',
  requestedBy: 'emp-avery',
  createdAt: '2026-07-02T00:00:00.000Z',
})

describe('stepIsWaiting', () => {
  it('is true when the waiting boolean is set (no waitingOns)', () => {
    expect(stepIsWaiting({ waiting: true })).toBe(true)
  })

  it('is true when there are person-blockers (waiting boolean unset)', () => {
    expect(stepIsWaiting({ waitingOns: [blocker()] })).toBe(true)
  })

  it('is true when both the boolean and person-blockers are present', () => {
    expect(stepIsWaiting({ waiting: true, waitingOns: [blocker()] })).toBe(true)
  })

  it('is false when neither is present', () => {
    expect(stepIsWaiting({})).toBe(false)
    expect(stepIsWaiting({ waiting: false, waitingOns: [] })).toBe(false)
  })
})
