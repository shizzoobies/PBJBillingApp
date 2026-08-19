import { describe, expect, it } from 'vitest'
import { stepIsWaiting, WAITING_DONE_PATCH } from '../lib/utils'
import type { WaitingOn } from '../lib/types'

/**
 * Pure-helper tests for `stepIsWaiting` — the shared predicate that decides
 * whether a checklist step is "waiting." It's true when the legacy `waiting`
 * boolean is set OR the node carries ≥1 structured person-blocker.
 */
const blocker = (overrides: Partial<WaitingOn> = {}): WaitingOn => ({
  id: 'wo-abcd1234',
  blockerId: 'emp-brit',
  requestedBy: 'emp-avery',
  createdAt: '2026-07-02T00:00:00.000Z',
  ...overrides,
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

/**
 * The waiting editor's "Done" button — now only ever pressed on a step flagged
 * waiting the OLD free-text way, since a step carrying a live saved wait has no
 * Done at all (featreq-8b7d06d7: the wait's own chip carries every action).
 * What the patch does has not changed: it un-flags the step, keeps the
 * `waitingOn` note as the record, and never touches the step's own `done`.
 */
describe('WAITING_DONE_PATCH', () => {
  it('retires the blocker and nothing else', () => {
    expect(WAITING_DONE_PATCH).toEqual({ waiting: false, waitingForChecklistId: null })
  })

  it('never completes the step and never erases the note', () => {
    expect(Object.keys(WAITING_DONE_PATCH)).not.toContain('done')
    expect(Object.keys(WAITING_DONE_PATCH)).not.toContain('waitingOn')
  })
})
