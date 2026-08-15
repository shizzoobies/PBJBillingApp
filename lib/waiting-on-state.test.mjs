import { describe, expect, it } from 'vitest'

import {
  canMarkWaitingOnDone,
  canSendBackWaitingOn,
  canVerifyWaitingOn,
  isWaitingOnOpen,
  legacyWaitBelongsOnTab,
  waitingOnConcernsUser,
  waitingOnDelayedTab,
  waitingOnStage,
  waitingsOnDelayedTab,
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

/**
 * SEND BACK — her fourth round: "if completed then we just need one button to
 * approve and mark completed or a button to not approve and send back with
 * another note."
 */
describe('who can send it back', () => {
  it('is exactly the people who could approve it', () => {
    expect(canSendBackWaitingOn({ entry: resolved(), userId: A })).toBe(true)
    expect(
      canSendBackWaitingOn({ entry: resolved(), userId: ASSIGNEE, assigneeId: ASSIGNEE }),
    ).toBe(true)
    expect(canSendBackWaitingOn({ entry: resolved(), userId: C })).toBe(false)
  })

  it('is not the blocker — you cannot reject your own work back to yourself', () => {
    expect(canSendBackWaitingOn({ entry: resolved(), userId: B })).toBe(false)
  })

  it('is unavailable before the blocker reports done, and after approval', () => {
    expect(canSendBackWaitingOn({ entry: waiting(), userId: A })).toBe(false)
    expect(canSendBackWaitingOn({ entry: verified(), userId: A })).toBe(false)
  })

  // A client has no login and no Delayed area — there is nobody to send it to.
  it('is never offered on a client wait', () => {
    const resolvedClient = clientWait({
      resolvedAt: '2026-08-07T01:00:00.000Z',
      resolvedBy: A,
    })
    expect(canSendBackWaitingOn({ entry: resolvedClient, userId: A })).toBe(false)
    expect(canSendBackWaitingOn({ entry: resolvedClient, userId: A, isOwner: true })).toBe(false)
  })
})

/**
 * The two Delayed tabs. Her words: "maybe a waiting on me and a I am waiting on
 * others tabs within delayed to keep it organized."
 */
describe('which Delayed tab a wait sits on', () => {
  const args = { assigneeId: ASSIGNEE }

  it('puts an open wait on the blocker "Waiting on me" and the requester "others"', () => {
    expect(waitingOnDelayedTab({ ...args, entry: waiting(), userId: B })).toBe('blocking')
    expect(waitingOnDelayedTab({ ...args, entry: waiting(), userId: A })).toBe('requesting')
    // The step's assignee is held up, not held UP-ON.
    expect(waitingOnDelayedTab({ ...args, entry: waiting(), userId: ASSIGNEE })).toBe('requesting')
    expect(waitingOnDelayedTab({ ...args, entry: waiting(), userId: C })).toBe(null)
  })

  it("drops off the blocker's tab entirely once they mark it done", () => {
    expect(waitingOnDelayedTab({ ...args, entry: resolved(), userId: B })).toBe(null)
    expect(waitingOnDelayedTab({ ...args, entry: resolved(), userId: A })).toBe('requesting')
  })

  it('leaves both tabs once approved', () => {
    for (const userId of [A, B, C, ASSIGNEE]) {
      expect(waitingOnDelayedTab({ ...args, entry: verified(), userId })).toBe(null)
    }
  })

  // "I am waiting on the client" is waiting on OTHERS, even though the person
  // chasing the client is the one who eventually presses its single Done.
  it('files a client wait under "I\'m waiting on others"', () => {
    expect(waitingOnDelayedTab({ entry: clientWait(), userId: A })).toBe('requesting')
  })

  // An owner is routed by their real part in the hand-off. Consulting the owner
  // override here would pile every wait in the firm into their "Waiting on me".
  it('routes an uninvolved owner nowhere', () => {
    expect(waitingOnDelayedTab({ ...args, entry: waiting(), userId: C })).toBe(null)
  })
})

describe('one person, both sides of the same step', () => {
  // B is being waited on by A, and is themselves waiting on C. Same step.
  const node = {
    waitingOns: [
      waiting({ id: 'wo-owed', blockerId: B, requestedBy: A }),
      waiting({ id: 'wo-asked', blockerId: C, requestedBy: B }),
      verified({ id: 'wo-old' }),
    ],
  }

  it('splits the step across both tabs, one wait on each', () => {
    expect(
      waitingsOnDelayedTab(node, { userId: B, tab: 'blocking' }).map((w) => w.id),
    ).toEqual(['wo-owed'])
    expect(
      waitingsOnDelayedTab(node, { userId: B, tab: 'requesting' }).map((w) => w.id),
    ).toEqual(['wo-asked'])
  })

  it('never puts a closed-out wait on either tab', () => {
    for (const tab of ['blocking', 'requesting']) {
      expect(
        waitingsOnDelayedTab(node, { userId: A, tab }).some((w) => w.id === 'wo-old'),
      ).toBe(false)
    }
  })
})

/**
 * The old free-text flag has nobody attached, so it is nobody's "waiting on
 * me" — it is the viewer waiting on something outside the app.
 */
describe('an old free-text wait', () => {
  const node = { waiting: true, waitingOns: [] }

  it('only ever lands on "I\'m waiting on others"', () => {
    expect(legacyWaitBelongsOnTab(node, { userId: ASSIGNEE, assigneeId: ASSIGNEE, tab: 'requesting' })).toBe(true)
    expect(legacyWaitBelongsOnTab(node, { userId: ASSIGNEE, assigneeId: ASSIGNEE, tab: 'blocking' })).toBe(false)
  })

  it('steps aside once the step carries a real wait', () => {
    const structured = { waiting: true, waitingOns: [waiting()] }
    expect(legacyWaitBelongsOnTab(structured, { userId: A, tab: 'requesting' })).toBe(false)
  })
})
