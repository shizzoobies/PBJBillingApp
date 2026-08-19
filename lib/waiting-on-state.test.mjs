import { describe, expect, it } from 'vitest'

import {
  canAskWaitingOnQuestion,
  canMarkWaitingOnDone,
  canSendBackWaitingOn,
  canVerifyWaitingOn,
  hasLiveSavedWait,
  isSelfWait,
  isWaitingOnOpen,
  legacyWaitBelongsOnTab,
  REFUSED_WAITING_ON_ACTIONS,
  SAVED_WAIT_FIELDS_ARE_LOCKED,
  SAVED_WAIT_IS_PERMANENT,
  SELF_WAIT_REFUSAL,
  waitForTaskLinkDenial,
  waitingLockRefusal,
  waitingOnActionRefusal,
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

  // You cannot confirm work nobody has reported finished. There is no way out
  // at this stage either — the wait keeps until they press Done.
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

/**
 * Her fifth round: "User should not be able to remove the information once it is
 * saved, we don't want to lose the data and we don't want to impact other people
 * interacting with it."
 *
 * The button was only ever half of it — `/waiting-ons/:id/cancel` was a live
 * route that deleted the row, so anything still holding the old client (an open
 * tab from before the deploy) could erase a record nobody else agreed to lose.
 * The refusal is the enforcement; the missing button is the courtesy.
 */
describe('a saved wait cannot be removed', () => {
  it('refuses the cancel route, whoever is asking', () => {
    expect(waitingOnActionRefusal('cancel')).toEqual({
      status: 409,
      error: SAVED_WAIT_IS_PERMANENT,
    })
  })

  /**
   * `delete` and `remove` are RESERVED, not live: nothing has ever routed to
   * them. They are listed so the obvious next name for the same idea lands on
   * the refusal rather than quietly becoming a new hole — and the endpoint's
   * route pattern is built from this same list, so a word added here is matched
   * and answered rather than 404'd.
   */
  it('holds the reserved erasure names too, so they cannot be re-opened', () => {
    expect(REFUSED_WAITING_ON_ACTIONS).toContain('cancel')
    for (const reserved of ['delete', 'remove']) {
      expect(REFUSED_WAITING_ON_ACTIONS).toContain(reserved)
      expect(waitingOnActionRefusal(reserved)?.status).toBe(409)
    }
  })

  it('never lists a stage move among the refused actions', () => {
    for (const action of ['done', 'verify', 'send-back']) {
      expect(REFUSED_WAITING_ON_ACTIONS).not.toContain(action)
    }
  })

  it('says why, in a sentence a person can act on', () => {
    expect(SAVED_WAIT_IS_PERMANENT).toMatch(/stays on the task/)
    expect(SAVED_WAIT_IS_PERMANENT).toMatch(/approve/i)
  })

  // The care point: locking deletion must not wedge the hand-off. Every stage
  // move EDITS the record, so none of them is a removal.
  it('lets every stage transition straight through', () => {
    for (const action of ['done', 'verify', 'send-back']) {
      expect(waitingOnActionRefusal(action)).toBeNull()
    }
  })
})

/**
 * Her answered clarification: a wait names another employee or the client,
 * never yourself.
 */
describe('a wait names somebody else', () => {
  it('refuses a wait pointed back at whoever is creating it', () => {
    expect(isSelfWait({ blockerId: A, requestedBy: A })).toBe(true)
  })

  it('allows a colleague', () => {
    expect(isSelfWait({ blockerId: B, requestedBy: A })).toBe(false)
  })

  it('allows the client — a client wait is never a self-wait', () => {
    expect(isSelfWait({ blockerId: A, requestedBy: A, blockerType: 'client' })).toBe(false)
  })

  it('tolerates a half-built entry rather than calling it a self-wait', () => {
    expect(isSelfWait({})).toBe(false)
    expect(isSelfWait({ requestedBy: A })).toBe(false)
  })

  it('tells you what to pick instead', () => {
    expect(SELF_WAIT_REFUSAL).toMatch(/client or a colleague/)
  })
})

/**
 * Existing self-waits in production data are saved records now, so they stay
 * readable. Nothing filters them out of the hand-off.
 */
describe('a self-wait that is already saved', () => {
  const selfWait = waiting({ blockerId: A, requestedBy: A })

  it('still reads as an open wait on its owner', () => {
    expect(isWaitingOnOpen(selfWait)).toBe(true)
    expect(waitingOnStage(selfWait)).toBe('waiting')
    expect(waitingOnConcernsUser({ entry: selfWait, userId: A })).toBe(true)
  })

  it('can still be finished — its owner is both sides', () => {
    expect(canMarkWaitingOnDone({ entry: selfWait, userId: A })).toBe(true)
    const done = { ...selfWait, resolvedAt: '2026-08-09T00:00:00.000Z', resolvedBy: A }
    expect(canVerifyWaitingOn({ entry: done, userId: A })).toBe(true)
  })
})

/**
 * Her annotated Delayed screenshot (featreq-8b7d06d7): beside DONE, a
 * QUESTION / SEND BACK button that opens a message box. "Sending does not
 * complete the wait" — so this is a permission to SPEAK, not a stage move, and
 * it belongs to the same person Done belongs to.
 */
describe('who can ask a question without finishing', () => {
  it('is the person being waited on', () => {
    expect(canAskWaitingOnQuestion({ entry: waiting(), userId: B })).toBe(true)
  })

  it('is not the person who asked — they have Send back for that', () => {
    expect(canAskWaitingOnQuestion({ entry: waiting(), userId: A })).toBe(false)
  })

  it('is nobody else at all', () => {
    expect(canAskWaitingOnQuestion({ entry: waiting(), userId: C })).toBe(false)
  })

  it('closes once the work is reported done — there is nothing left to ask about', () => {
    expect(canAskWaitingOnQuestion({ entry: resolved(), userId: B })).toBe(false)
    expect(canAskWaitingOnQuestion({ entry: verified(), userId: B })).toBe(false)
  })

  // A client has no login to read the question, and the person holding a client
  // wait is the one who would be asking.
  it('is refused on a client wait, even for the person chasing it', () => {
    expect(canAskWaitingOnQuestion({ entry: clientWait(), userId: A })).toBe(false)
    expect(canAskWaitingOnQuestion({ entry: clientWait(), userId: A, isOwner: true })).toBe(false)
  })

  it('follows the same owner override the Done beside it does', () => {
    expect(canAskWaitingOnQuestion({ entry: waiting(), userId: C, isOwner: true })).toBe(true)
  })

  it('goes exactly where Done goes, at every stage', () => {
    for (const entry of [waiting(), resolved(), verified()]) {
      for (const userId of [A, B, C]) {
        expect(canAskWaitingOnQuestion({ entry, userId })).toBe(
          canMarkWaitingOnDone({ entry, userId }),
        )
      }
    }
  })
})

/**
 * SAVE LOCKS EVERYTHING (featreq-8b7d06d7, her email): "all info is locked and
 * cannot be changed." The wait's own note and target have never had an edit
 * route; what DID was the step's free-text note and its waiting-for-a-task
 * link, and un-flagging the step made a live wait vanish off the page. All
 * three are refused while a wait is live.
 */
describe('a saved wait freezes its step', () => {
  const live = { waiting: true, waitingOns: [waiting()] }
  const closed = { waiting: true, waitingOns: [verified()] }

  it('knows when a step is carrying a live wait', () => {
    expect(hasLiveSavedWait(live)).toBe(true)
    expect(hasLiveSavedWait(closed)).toBe(false)
    expect(hasLiveSavedWait({ waiting: true })).toBe(false)
    expect(hasLiveSavedWait(undefined)).toBe(false)
  })

  it('refuses the note, the task link and the un-flagging', () => {
    for (const patch of [
      { waitingOn: 'something else' },
      { waitingOn: '' },
      { waitingForChecklistId: 'cl-other' },
      { waitingForChecklistId: '' },
      { waiting: false },
      { waiting: false, waitingOn: null, waitingForChecklistId: null },
    ]) {
      expect(waitingLockRefusal(live, patch)).toEqual({
        status: 409,
        error: SAVED_WAIT_FIELDS_ARE_LOCKED,
      })
    }
  })

  it('says why, in a sentence somebody can act on', () => {
    expect(SAVED_WAIT_FIELDS_ARE_LOCKED).toMatch(/locked|fixed/i)
    expect(SAVED_WAIT_FIELDS_ARE_LOCKED).toMatch(/approve/i)
  })

  // The step is more than its wait: renaming it, dating it and assigning it are
  // ordinary work and were never part of what Save froze.
  it('leaves the rest of the step editable', () => {
    expect(waitingLockRefusal(live, { title: 'Renamed' })).toBeNull()
    expect(waitingLockRefusal(live, { dueDate: '2026-09-01' })).toBeNull()
    expect(waitingLockRefusal(live, { assigneeId: C })).toBeNull()
    expect(waitingLockRefusal(live, {})).toBeNull()
  })

  // Flagging is not editing. Only the false direction is refused, because that
  // is the one that used to make a live wait disappear from the page.
  it('still lets a step be flagged waiting', () => {
    expect(waitingLockRefusal(live, { waiting: true })).toBeNull()
  })

  /**
   * The lock has to LIFT, or a step whose waits are all approved would sit
   * amber forever with no control left to quiet it.
   */
  it('lifts once every wait is approved', () => {
    expect(waitingLockRefusal(closed, { waiting: false })).toBeNull()
    expect(waitingLockRefusal(closed, { waitingOn: 'anything' })).toBeNull()
  })

  it('never applies to a step that has no saved wait at all', () => {
    expect(waitingLockRefusal({ waiting: true }, { waiting: false })).toBeNull()
  })
})

/**
 * The "waiting for another task" link, refused server-side rather than trusted.
 * The picker has offered only same-client, openable tasks since featreq-5dd514b8;
 * the routes took any string at all, so a link the picker would never show could
 * still be stored — and a dependency that can never honestly complete is a
 * "Ready to continue" ping that never fires.
 */
describe('what a step may be waiting for', () => {
  const acme = { id: 'cl-acme-aug', clientId: 'client-acme' }
  const pool = [
    acme,
    { id: 'cl-acme-sep', clientId: 'client-acme' },
    { id: 'cl-globex', clientId: 'client-globex' },
    // Recycled tasks are still real dependencies, so they resolve.
    { id: 'cl-acme-recycled', clientId: 'client-acme' },
    { id: 'cl-internal', clientId: '' },
  ]
  const denial = (taskId, current = '') =>
    waitForTaskLinkDenial({ checklist: acme, pool, taskId, current })

  it('allows another task of the same client', () => {
    expect(denial('cl-acme-sep')).toBeNull()
  })

  it('always allows clearing the link', () => {
    expect(denial('')).toBeNull()
    expect(waitForTaskLinkDenial({ checklist: acme, pool, taskId: null })).toBeNull()
  })

  it('refuses a task that does not exist', () => {
    expect(denial('cl-ghost')).toEqual({
      status: 400,
      error: 'That task no longer exists, so nothing can wait for it',
    })
  })

  it('refuses a task waiting for ITSELF', () => {
    expect(denial(acme.id)).toEqual({
      status: 400,
      error: 'A task cannot be waiting for itself',
    })
  })

  it("refuses another client's task", () => {
    expect(denial('cl-globex')).toEqual({
      status: 400,
      error: "A step can only wait for another of the same client's tasks",
    })
  })

  // Falls out of the same rule rather than being a special case: empty matches
  // empty, so an internal task sees only the other internal ones.
  it('lets an internal task wait for another internal task, and nothing else', () => {
    const internal = { id: 'cl-internal-b', clientId: '' }
    expect(waitForTaskLinkDenial({ checklist: internal, pool, taskId: 'cl-internal' })).toBeNull()
    expect(waitForTaskLinkDenial({ checklist: internal, pool, taskId: 'cl-acme-sep' })).not.toBeNull()
  })

  /**
   * The escape hatch the picker depends on: a cross-client link that is ALREADY
   * saved stays visible and selected (src/lib/waitForTaskOptions.ts). Refusing to
   * re-send it would make a step that predates this rule unsavable.
   */
  it('always allows re-sending the link the step already has', () => {
    expect(denial('cl-globex', 'cl-globex')).toBeNull()
    expect(denial('cl-ghost', 'cl-ghost')).toBeNull()
  })
})
