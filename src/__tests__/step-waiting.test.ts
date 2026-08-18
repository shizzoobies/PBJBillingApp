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

  // THE regression this round: pressing Done on a colleague's wait used to plan
  // a CANCEL, which deleted the record — including their half of it. "We don't
  // want to lose the data and we don't want to impact other people interacting
  // with it." It is their move, so Done leaves it alone.
  it('leaves a blocker owned by someone else exactly where it is', () => {
    expect(planWaitingDone([blocker({ id: 'wo-1', blockerId: 'emp-lisa' })], me)).toEqual([
      { id: 'wo-1', action: 'theirs' },
    ])
  })

  it('never plans a removal, whoever the blocker is', () => {
    const actions = planWaitingDone(
      [
        blocker({ id: 'wo-1', blockerId: 'emp-lisa' }),
        blocker({ id: 'wo-2', blockerId: me }),
        blocker({ id: 'wo-3', blockerId: 'client-clover', blockerType: 'client' }),
      ],
      me,
    ).map((plan) => plan.action)
    expect(actions).not.toContain('cancel')
  })

  it('marks my own blockers done (I am the one being waited on)', () => {
    expect(planWaitingDone([blocker({ id: 'wo-2', blockerId: me })], me)).toEqual([
      { id: 'wo-2', action: 'done' },
    ])
  })

  it('confirms one the other side has already reported done', () => {
    expect(
      planWaitingDone(
        [
          blocker({
            id: 'wo-4',
            blockerId: 'emp-lisa',
            requestedBy: me,
            resolvedAt: '2026-08-16T00:00:00.000Z',
          }),
        ],
        me,
      ),
    ).toEqual([{ id: 'wo-4', action: 'verify' }])
  })

  /**
   * The plan is decided with the SAME predicates as the chip beside it and the
   * server behind it. Deciding on a bare `blockerId === meId` disagreed with
   * both: it told an owner "only they can mark their part done" about a wait the
   * chip was offering them, and it sent a blocker's press at `verify`, which the
   * server answers with a flat 403.
   */
  describe('agrees with the chip and the server', () => {
    const lisas = blocker({ id: 'wo-5', blockerId: 'emp-lisa', requestedBy: 'emp-avery' })
    const reported = { ...lisas, resolvedAt: '2026-08-16T00:00:00.000Z' }

    it('lets an OWNER mark a colleague’s wait done, like the chip does', () => {
      expect(planWaitingDone([lisas], me, { isOwner: true })).toEqual([
        { id: 'wo-5', action: 'done' },
      ])
    })

    it('lets the STEP ASSIGNEE approve one reported done, like the chip does', () => {
      expect(planWaitingDone([reported], me, { assigneeId: me })).toEqual([
        { id: 'wo-5', action: 'verify' },
      ])
    })

    // MEDIUM-2: Lisa pressing Done on her own reported wait used to be planned
    // as `verify`, which the server refuses outright ("You cannot confirm this
    // waiting-on request"). It is the requester's call, so it is theirs.
    it('never sends the blocker at verify — that is the requester’s call', () => {
      expect(planWaitingDone([reported], 'emp-lisa')).toEqual([{ id: 'wo-5', action: 'theirs' }])
    })

    it('leaves a client wait to the person actually chasing it', () => {
      const clientWait = blocker({
        id: 'wo-6',
        blockerId: 'client-clover',
        blockerType: 'client',
        requestedBy: 'emp-avery',
      })
      expect(planWaitingDone([clientWait], me)).toEqual([{ id: 'wo-6', action: 'theirs' }])
      expect(planWaitingDone([clientWait], 'emp-avery')).toEqual([{ id: 'wo-6', action: 'done' }])
    })
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
      { id: 'wo-1', action: 'theirs' },
      { id: 'wo-2', action: 'done' },
      { id: 'wo-3', action: 'theirs' },
    ])
  })

  it('plans nothing when there are no structured blockers', () => {
    expect(planWaitingDone([], me)).toEqual([])
  })

  it('regression: after Done my own blocker is retired and the step is clear', () => {
    // The original bug: Done applied only WAITING_DONE_PATCH, so a step blocked
    // on a person stayed waiting, the amber editor stayed open, and the click
    // had no visible effect at all.
    const step = {
      done: false,
      waiting: true,
      waitingOn: 'Lisa to send the bank statements',
      waitingOns: [blocker({ id: 'wo-1', blockerId: me })],
    }

    const retired = new Set(
      planWaitingDone(step.waitingOns, me)
        .filter((plan) => plan.action === 'done')
        .map((plan) => plan.id),
    )
    const after = {
      ...step,
      ...WAITING_DONE_PATCH,
      // The entry is kept, not dropped — resolving it is what stops it blocking.
      waitingOns: step.waitingOns.map((entry) =>
        retired.has(entry.id)
          ? { ...entry, resolvedAt: '2026-08-16T00:00:00.000Z', verifiedAt: '2026-08-16T00:00:00.000Z' }
          : entry,
      ),
    }

    expect(stepIsWaiting(after)).toBe(false)
    expect(after.waitingOns).toHaveLength(1)
    // …and the 039a2d2 semantics survive: note kept, step still unchecked.
    expect(after.waitingOn).toBe('Lisa to send the bank statements')
    expect(after.done).toBe(false)
  })

  it("regression: a colleague's wait keeps the step amber rather than vanishing", () => {
    const step = {
      done: false,
      waiting: true,
      waitingOns: [blocker({ id: 'wo-1', blockerId: 'emp-lisa' })],
    }
    const plan = planWaitingDone(step.waitingOns, me)
    // Nothing to apply, so the step is still blocked — and it should be: Lisa
    // has not sent the statements. The editor says whose move it is.
    expect(plan.every((entry) => entry.action === 'theirs')).toBe(true)
    expect(stepIsWaiting({ ...step, ...WAITING_DONE_PATCH })).toBe(true)
  })
})
