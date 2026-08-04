import { describe, expect, it } from 'vitest'
import { planWaitingDone, stepIsWaiting, WAITING_DONE_PATCH } from '../lib/utils'
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
 * The waiting editor's "Done" button. Its semantics were reported broken twice
 * ("does nothing when pushed"), so both halves are pinned here:
 *  - WHAT IT KEEPS: only the blocker is retired. The `waitingOn` note stays as
 *    the record and the step's own `done` is never touched.
 *  - WHAT IT CLEARS: the structured person-blockers too — `stepIsWaiting` ORs
 *    them in, so a Done that left them behind changed nothing on screen.
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

describe('planWaitingDone', () => {
  const me = 'emp-patrice'

  it('cancels blockers owned by someone else (I am the blocked side)', () => {
    expect(planWaitingDone([blocker({ id: 'wo-1', blockerId: 'emp-lisa' })], me)).toEqual([
      { id: 'wo-1', action: 'cancel' },
    ])
  })

  it('marks my own blockers done (I am the one being waited on)', () => {
    expect(planWaitingDone([blocker({ id: 'wo-2', blockerId: me })], me)).toEqual([
      { id: 'wo-2', action: 'done' },
    ])
  })

  it('plans every blocker on the step, in order', () => {
    expect(
      planWaitingDone(
        [
          blocker({ id: 'wo-1', blockerId: 'emp-lisa' }),
          blocker({ id: 'wo-2', blockerId: me }),
          blocker({ id: 'wo-3', blockerId: 'emp-avery' }),
        ],
        me,
      ),
    ).toEqual([
      { id: 'wo-1', action: 'cancel' },
      { id: 'wo-2', action: 'done' },
      { id: 'wo-3', action: 'cancel' },
    ])
  })

  it('plans nothing when there are no structured blockers', () => {
    expect(planWaitingDone([], me)).toEqual([])
  })

  it('regression: after Done the step is no longer waiting', () => {
    // The bug: Done applied only WAITING_DONE_PATCH, so a step blocked on a
    // person stayed waiting, the amber editor stayed open, and the click had
    // no visible effect at all.
    const step = {
      done: false,
      waiting: true,
      waitingOn: 'Lisa to send the bank statements',
      waitingOns: [blocker({ id: 'wo-1', blockerId: 'emp-lisa' })],
    }

    const retiredIds = new Set(planWaitingDone(step.waitingOns, me).map((plan) => plan.id))
    const after = {
      ...step,
      ...WAITING_DONE_PATCH,
      waitingOns: step.waitingOns.filter((entry) => !retiredIds.has(entry.id)),
    }

    expect(stepIsWaiting(after)).toBe(false)
    // …and the 039a2d2 semantics survive: note kept, step still unchecked.
    expect(after.waitingOn).toBe('Lisa to send the bank statements')
    expect(after.done).toBe(false)
  })
})
