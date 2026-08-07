import { describe, expect, it } from 'vitest'

import {
  canMarkWaitingOnDone,
  canVerifyWaitingOn,
  isWaitingOnOpen,
  waitingOnConcernsUser,
  waitingOnStage,
  waitingStepConcernsUser,
} from './waiting-on-state.js'

/**
 * The waiting-on hand-off, pinned against Brittany's spec (featreq-b05a2f3a):
 *
 *   A creates the wait on B → B's Done → A's Done → checked off, struck through
 *
 * Two things these tests exist to protect:
 *
 *   1. The record is NEVER destroyed by finishing. Her complaint was "when the
 *      person clicks done that persons name that was to do the check
 *      disappears" — so every stage below still has a readable entry.
 *   2. A client wait is ONE click. Clients have no login, so there is no second
 *      party to hand back to; requiring two presses would be ceremony.
 */

const A = 'emp-brit' // asked for the help
const B = 'emp-lisa' // is being waited on
const C = 'emp-avery' // uninvolved
const ASSIGNEE = 'emp-jordan' // owns the step itself

const waiting = (over = {}) => ({
  id: 'wo-1',
  blockerId: B,
  requestedBy: A,
  createdAt: '2026-08-07T00:00:00.000Z',
  ...over,
})
const resolved = (over = {}) =>
  waiting({ resolvedAt: '2026-08-07T01:00:00.000Z', resolvedBy: B, ...over })
const verified = (over = {}) =>
  resolved({ verifiedAt: '2026-08-07T02:00:00.000Z', verifiedBy: A, ...over })
const clientWait = (over = {}) =>
  waiting({ blockerId: 'client-clover', blockerType: 'client', ...over })

describe('waitingOnStage', () => {
  it('walks waiting → resolved → verified', () => {
    expect(waitingOnStage(waiting())).toBe('waiting')
    expect(waitingOnStage(resolved())).toBe('resolved')
    expect(waitingOnStage(verified())).toBe('verified')
  })

  it('treats a legacy entry with no timestamps as still waiting', () => {
    expect(waitingOnStage({ id: 'x', blockerId: B, requestedBy: A })).toBe('waiting')
  })

  it('stops blocking the step only once verified', () => {
    expect(isWaitingOnOpen(waiting())).toBe(true)
    // Still open at 'resolved' — A has not confirmed, so the step stays flagged.
    expect(isWaitingOnOpen(resolved())).toBe(true)
    expect(isWaitingOnOpen(verified())).toBe(false)
  })
})

describe('who can press the first Done', () => {
  it('is the person being waited on', () => {
    expect(canMarkWaitingOnDone({ entry: waiting(), userId: B })).toBe(true)
  })

  it('is not the person who asked, nor a bystander', () => {
    expect(canMarkWaitingOnDone({ entry: waiting(), userId: A })).toBe(false)
    expect(canMarkWaitingOnDone({ entry: waiting(), userId: C })).toBe(false)
  })

  it('lets an owner step in', () => {
    expect(canMarkWaitingOnDone({ entry: waiting(), userId: C, isOwner: true })).toBe(true)
  })

  it('refuses once it has already been marked done', () => {
    expect(canMarkWaitingOnDone({ entry: resolved(), userId: B })).toBe(false)
    expect(canMarkWaitingOnDone({ entry: verified(), userId: B })).toBe(false)
  })

  // Nobody is "being waited on" when the blocker is a client, so it falls to
  // whoever is chasing them.
  it('falls to the requester or step assignee for a client wait', () => {
    expect(canMarkWaitingOnDone({ entry: clientWait(), userId: A })).toBe(true)
    expect(
      canMarkWaitingOnDone({ entry: clientWait(), userId: ASSIGNEE, assigneeId: ASSIGNEE }),
    ).toBe(true)
    expect(canMarkWaitingOnDone({ entry: clientWait(), userId: C })).toBe(false)
  })
})

describe('who can press the second Done', () => {
  it('is the person who asked, or the assignee actually held up', () => {
    expect(canVerifyWaitingOn({ entry: resolved(), userId: A })).toBe(true)
    expect(
      canVerifyWaitingOn({ entry: resolved(), userId: ASSIGNEE, assigneeId: ASSIGNEE }),
    ).toBe(true)
  })

  it('is not the blocker, who already had their turn', () => {
    expect(canVerifyWaitingOn({ entry: resolved(), userId: B })).toBe(false)
  })

  // You cannot confirm work nobody has reported finished — cancel is the way out.
  it('is unavailable until the blocker has marked it done', () => {
    expect(canVerifyWaitingOn({ entry: waiting(), userId: A })).toBe(false)
    expect(canVerifyWaitingOn({ entry: waiting(), userId: A, isOwner: true })).toBe(false)
  })

  it('is unavailable once already closed out', () => {
    expect(canVerifyWaitingOn({ entry: verified(), userId: A })).toBe(false)
  })
})

describe("whose Delayed page it shows on", () => {
  it('sits with the blocker, the requester and the assignee while waiting', () => {
    const args = { entry: waiting(), assigneeId: ASSIGNEE }
    expect(waitingOnConcernsUser({ ...args, userId: B })).toBe(true)
    expect(waitingOnConcernsUser({ ...args, userId: A })).toBe(true)
    expect(waitingOnConcernsUser({ ...args, userId: ASSIGNEE })).toBe(true)
    expect(waitingOnConcernsUser({ ...args, userId: C })).toBe(false)
  })

  // Her step 3: "removed from Person B's delayed area … notification to person A".
  it("leaves the blocker's list once they mark it done, and stays on the requester's", () => {
    expect(waitingOnConcernsUser({ entry: resolved(), userId: B })).toBe(false)
    expect(waitingOnConcernsUser({ entry: resolved(), userId: A })).toBe(true)
  })

  // Her step 4: "remove it from Person A's delayed area".
  it('leaves everyone once confirmed', () => {
    for (const userId of [A, B, C, ASSIGNEE]) {
      expect(waitingOnConcernsUser({ entry: verified(), userId, assigneeId: ASSIGNEE })).toBe(
        false,
      )
    }
  })

  it('never puts a client wait on an uninvolved person', () => {
    expect(waitingOnConcernsUser({ entry: clientWait(), userId: A })).toBe(true)
    expect(waitingOnConcernsUser({ entry: clientWait(), userId: C })).toBe(false)
  })
})

describe('whole-step visibility', () => {
  it('shows a step while any of its waits still concerns you', () => {
    const node = { waitingOns: [verified(), waiting()] }
    expect(waitingStepConcernsUser(node, { userId: B })).toBe(true)
  })

  it('hides a step whose waits are all closed out', () => {
    expect(waitingStepConcernsUser({ waitingOns: [verified()] }, { userId: A })).toBe(false)
  })

  // The old free-text flag has nobody attached. Filtering it the same way would
  // quietly empty the page of every wait predating the structured version, so
  // it falls back to the step's assignee.
  it('falls back to the assignee for an old free-text wait', () => {
    const node = { waiting: true, waitingOns: [] }
    expect(waitingStepConcernsUser(node, { userId: ASSIGNEE, assigneeId: ASSIGNEE })).toBe(true)
    expect(waitingStepConcernsUser(node, { userId: C, assigneeId: ASSIGNEE })).toBe(false)
  })

  it('shows an unassigned free-text wait to everyone rather than nobody', () => {
    expect(waitingStepConcernsUser({ waiting: true }, { userId: C })).toBe(true)
  })

  it('shows nothing for a step that was never flagged', () => {
    expect(waitingStepConcernsUser({ waitingOns: [] }, { userId: A })).toBe(false)
  })
})
