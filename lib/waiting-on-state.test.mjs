import { describe, expect, it } from 'vitest'

import {
  canAskWaitingOnQuestion,
  canMarkWaitingOnDone,
  canSendBackWaitingOn,
  canVerifyWaitingOn,
  hasLiveSavedWait,
  hasLiveSavedWaitInTree,
  isSelfWait,
  isWaitingOnOpen,
  legacyWaitBelongsOnTab,
  OWNER_TICK_CLEARS_WAIT_TITLE,
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
  waitingOnStageRefusal,
  WAITING_ON_ACTION_STAGE,
  waitingsOnDelayedTab,
  waitingStepConcernsUser,
  waitingBlocksCompletion,
  operationCompletesWaitingStep,
  REMOVAL_WOULD_COMPLETE_WAITING_STEP,
  removalWouldCompleteWaitingStep,
  toggleClosingWaits,
  toggleWouldCompleteWaitingStep,
  WAITING_BLOCK_TITLES,
  waitingToggleRefusal,
} from './waiting-on-state.js'
import { applyItemToggle } from './checklist-step-ops.js'

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

/**
 * A waiting step cannot be checked off (featreq-cdab1605). The predicate the
 * server's toggle guard and every checkbox in the UI share, so a disabled box
 * is never a surprise 409 and the route's refusal is never reachable from a
 * control the UI itself still offered.
 */
describe('waitingBlocksCompletion', () => {
  it('is true for the legacy flag on a step not yet done', () => {
    expect(waitingBlocksCompletion({ done: false, waiting: true })).toBe(true)
  })

  it('is true for a live structured wait on a step not yet done', () => {
    expect(waitingBlocksCompletion({ done: false, waitingOns: [waiting()] })).toBe(true)
  })

  // A VERIFIED wait is the closed-out record — it stopped blocking the step
  // the moment it was approved, same as `stepIsWaiting`.
  it('is false once every structured wait is verified', () => {
    expect(waitingBlocksCompletion({ done: false, waitingOns: [verified()] })).toBe(false)
  })

  it('is still true for a resolved-but-not-yet-verified wait — still live', () => {
    expect(waitingBlocksCompletion({ done: false, waitingOns: [resolved()] })).toBe(true)
  })

  it('is false when nothing is waiting', () => {
    expect(waitingBlocksCompletion({ done: false })).toBe(false)
    expect(waitingBlocksCompletion({ done: false, waiting: false, waitingOns: [] })).toBe(false)
  })

  // Un-checking a done step is never blocked, wait or no wait — only the
  // forward move (not done -> done) is refused.
  it('is false on a DONE step even while it is still waiting', () => {
    expect(waitingBlocksCompletion({ done: true, waiting: true })).toBe(false)
    expect(waitingBlocksCompletion({ done: true, waitingOns: [waiting()] })).toBe(false)
  })

  it('handles an undefined node without throwing', () => {
    expect(waitingBlocksCompletion(undefined)).toBe(false)
  })
})

/**
 * ONE RULE, decided by simulation: no operation may turn a waiting, not-yet-done
 * step into a done one. The guard runs the store's own pure step math
 * (`lib/checklist-step-ops.js`) on a copy of the step and compares before with
 * after, so it can never drift from what the store would do. The cases below are
 * the three hand-written guards' suites (the node itself, what a tick cascades
 * onto, the parent a tick rolls up) restated as ticks, plus the two paths those
 * guards left open: a delete that rolls a waiting step up, and data where the
 * raw flag and the roll-up disagree.
 */
const leaf = (id, over = {}) => ({ id, title: `Step ${id}`, done: false, ...over })
const stepOf = (over, children) => ({
  id: 'item',
  label: 'Reconcile',
  done: false,
  ...over,
  ...(children ? { subItems: children } : {}),
})
const waitingStep = (children) => stepOf({ waiting: true }, children)

describe('toggleWouldCompleteWaitingStep', () => {
  describe('the node itself', () => {
    it('refuses a waiting item (the legacy flag) that is not yet done', () => {
      expect(toggleWouldCompleteWaitingStep(stepOf({ waiting: true }))).toBe(true)
      expect(waitingToggleRefusal(stepOf({ waiting: true })).where).toBe('own')
    })

    it('refuses a live structured wait on an item not yet done', () => {
      expect(toggleWouldCompleteWaitingStep(stepOf({ waitingOns: [waiting()] }))).toBe(true)
    })

    // A VERIFIED wait is the closed-out record: it stopped blocking the moment
    // it was approved, same as `stepIsWaiting`.
    it('allows it once every structured wait is verified', () => {
      expect(toggleWouldCompleteWaitingStep(stepOf({ waitingOns: [verified()] }))).toBe(false)
    })

    it('still refuses a resolved-but-not-yet-verified wait, which is live', () => {
      expect(toggleWouldCompleteWaitingStep(stepOf({ waitingOns: [resolved()] }))).toBe(true)
    })

    it('leaves a step that is not waiting alone', () => {
      expect(toggleWouldCompleteWaitingStep(stepOf({}))).toBe(false)
      expect(toggleWouldCompleteWaitingStep(stepOf({ waiting: false, waitingOns: [] }))).toBe(false)
    })

    // Un-checking something already finished is always allowed, wait or no wait.
    it('never refuses un-ticking a DONE step, even while it is still waiting', () => {
      expect(toggleWouldCompleteWaitingStep(stepOf({ done: true, waiting: true }))).toBe(false)
      expect(toggleWouldCompleteWaitingStep(stepOf({ done: true, waitingOns: [waiting()] }))).toBe(
        false,
      )
    })

    it('refuses a waiting sub-item and a waiting sub-sub-item on their own ticks', () => {
      const item = stepOf({}, [
        leaf('a', { waiting: true }),
        leaf('b', { subItems: [leaf('b1', { waitingOns: [waiting()] })] }),
      ])
      expect(waitingToggleRefusal(item, 'a').where).toBe('own')
      expect(waitingToggleRefusal(item, 'b', 'b1').where).toBe('own')
    })

    it('handles an undefined step and a target that does not exist', () => {
      expect(toggleWouldCompleteWaitingStep(undefined)).toBe(false)
      expect(toggleWouldCompleteWaitingStep(waitingStep([leaf('a')]), 'zzz')).toBe(false)
      expect(toggleWouldCompleteWaitingStep(waitingStep([leaf('a')]), 'a', 'zzz')).toBe(false)
    })
  })

  // Ticking an item or sub-item cascades `done` onto everything beneath it, so a
  // waiting sub-step would be completed through its parent.
  describe('what the tick cascades onto', () => {
    it('refuses a parent whose not-done sub-item is waiting, with the sub-step wording', () => {
      const parent = stepOf({}, [leaf('a'), leaf('b', { waitingOns: [waiting()] })])
      expect(toggleWouldCompleteWaitingStep(parent)).toBe(true)
      const refusal = waitingToggleRefusal(parent)
      expect(refusal.where).toBe('below')
      expect(refusal.message).toBe('A sub-step is waiting - clear it first')
      expect(refusal.message).toBe(WAITING_BLOCK_TITLES.below)
      expect(refusal.error).toBe('STEP_IS_WAITING')
      expect(refusal.status).toBe(409)
    })

    it('refuses a parent when a sub-sub-item two levels down is waiting', () => {
      const parent = stepOf({}, [leaf('a', { subItems: [leaf('a1', { waiting: true })] })])
      expect(toggleWouldCompleteWaitingStep(parent)).toBe(true)
      // ...and the sub-item above that sub-sub-item.
      expect(waitingToggleRefusal(parent, 'a').where).toBe('below')
    })

    it('allows it when the only waiting descendant is already done', () => {
      const parent = stepOf({}, [leaf('a', { done: true, waiting: true }), leaf('b')])
      expect(toggleWouldCompleteWaitingStep(parent)).toBe(false)
    })

    it('allows it when the descendant wait is verified', () => {
      const parent = stepOf({}, [leaf('a', { waitingOns: [verified()] })])
      expect(toggleWouldCompleteWaitingStep(parent)).toBe(false)
    })

    it('never refuses un-ticking a DONE parent', () => {
      const parent = stepOf({ done: true }, [leaf('a', { done: true, waiting: true })])
      expect(toggleWouldCompleteWaitingStep(parent)).toBe(false)
    })

    // "Done" is the roll-up: a parent whose stored flag says done but whose
    // sub-step is open is OPEN, and ticking it completes that waiting sub-step.
    it('reads done as the roll-up, not the stored flag', () => {
      const parent = stepOf({ done: true }, [leaf('a', { waiting: true })])
      expect(toggleWouldCompleteWaitingStep(parent)).toBe(true)
    })

    it('allows a step with no waiting anywhere beneath it', () => {
      expect(toggleWouldCompleteWaitingStep(stepOf({}, [leaf('a'), leaf('b')]))).toBe(false)
    })
  })

  // The store rolls a parent's `done` up from its children, so ticking the LAST
  // open child of a waiting step would finish a step that is itself waiting.
  describe('the parent the roll-up completes', () => {
    it('refuses ticking the last open sub-item of a waiting step', () => {
      const item = waitingStep([leaf('a', { done: true }), leaf('b')])
      expect(toggleWouldCompleteWaitingStep(item, 'b')).toBe(true)
      const refusal = waitingToggleRefusal(item, 'b')
      expect(refusal.where).toBe('above')
      expect(refusal.message).toBe('The step above is waiting - clear it first')
      expect(refusal.message).toBe(WAITING_BLOCK_TITLES.above)
    })

    it('allows a sub-item that is not the last open one', () => {
      expect(toggleWouldCompleteWaitingStep(waitingStep([leaf('a'), leaf('b')]), 'b')).toBe(false)
    })

    it('allows it when the parent is not waiting', () => {
      expect(toggleWouldCompleteWaitingStep(stepOf({}, [leaf('a')]), 'a')).toBe(false)
    })

    it('allows it when the parent wait is verified', () => {
      expect(
        toggleWouldCompleteWaitingStep(stepOf({ waitingOns: [verified()] }, [leaf('a')]), 'a'),
      ).toBe(false)
    })

    it('never refuses un-ticking a done sub-item', () => {
      expect(toggleWouldCompleteWaitingStep(waitingStep([leaf('a', { done: true })]), 'a')).toBe(
        false,
      )
    })

    it('reads a sibling as the roll-up: one with an open sub-step is not a done sibling', () => {
      const item = waitingStep([
        leaf('a', { done: true, subItems: [leaf('a1')] }),
        leaf('b'),
      ])
      expect(toggleWouldCompleteWaitingStep(item, 'b')).toBe(false)
    })

    describe('two levels', () => {
      it('refuses the last open sub-sub-item when its sub-item is waiting', () => {
        const item = stepOf({}, [
          leaf('a', { waiting: true, subItems: [leaf('a1', { done: true }), leaf('a2')] }),
        ])
        expect(waitingToggleRefusal(item, 'a', 'a2').where).toBe('above')
      })

      it('refuses when the sub-item is plain but completing it completes a waiting top step', () => {
        const item = waitingStep([leaf('a', { done: true }), leaf('b', { subItems: [leaf('b1')] })])
        expect(toggleWouldCompleteWaitingStep(item, 'b', 'b1')).toBe(true)
      })

      it('allows it when the sub-item stays open or a sibling sub-item is open', () => {
        const open = waitingStep([leaf('a'), leaf('b', { subItems: [leaf('b1')] })])
        expect(toggleWouldCompleteWaitingStep(open, 'b', 'b1')).toBe(false)
        const siblingOpen = waitingStep([leaf('a', { subItems: [leaf('a1'), leaf('a2')] })])
        expect(toggleWouldCompleteWaitingStep(siblingOpen, 'a', 'a1')).toBe(false)
      })

      it('never refuses un-ticking a done sub-sub-item', () => {
        const item = waitingStep([leaf('a', { done: true, subItems: [leaf('a1', { done: true })] })])
        expect(toggleWouldCompleteWaitingStep(item, 'a', 'a1')).toBe(false)
      })
    })
  })

  // The two hand-written predicates read "done" differently from the store, so
  // data where the raw flag and the roll-up disagree slipped through: here sub-
  // step `a` is stored done beside a sub-sub-step with no title (which the store
  // drops), so the roll-up read it as OPEN while the store computes it as done.
  describe('data where the raw flag and the roll-up disagree', () => {
    const inconsistent = () =>
      waitingStep([
        leaf('a', { done: true, subItems: [{ id: 'a1', title: '', done: false }] }),
        leaf('b'),
      ])

    it('refuses the tick when the store would complete the waiting parent', () => {
      const item = inconsistent()
      // What the store itself does with this tick:
      const stored = applyItemToggle(item.subItems, item.done, { subItemId: 'b' })
      expect(stored.done).toBe(true)
      expect(toggleWouldCompleteWaitingStep(item, 'b')).toBe(true)
      expect(waitingToggleRefusal(item, 'b').where).toBe('above')
    })
  })
})

// Two siblings can carry the same id (imported or hand-edited data), and the
// store's tick reaches BOTH of them. The simulation used to key its nodes by id
// alone, so the twin listed first hid the waiting one behind it.
describe('sibling steps that share an id', () => {
  it('refuses a sub-step tick that would finish a waiting twin listed first', () => {
    const item = stepOf({}, [leaf('x', { waiting: true }), leaf('x')])
    const stored = applyItemToggle(item.subItems, item.done, { subItemId: 'x' })
    expect(stored.subItems.map((sub) => sub.done)).toEqual([true, true])
    expect(toggleWouldCompleteWaitingStep(item, 'x')).toBe(true)
    expect(waitingToggleRefusal(item, 'x').where).toBe('own')
  })

  it('refuses a sub-step tick that would finish a waiting twin listed second', () => {
    const item = stepOf({}, [leaf('x'), leaf('x', { waiting: true })])
    expect(toggleWouldCompleteWaitingStep(item, 'x')).toBe(true)
  })

  it('refuses the whole-step tick while any twin below is waiting', () => {
    const item = stepOf({}, [leaf('x', { waiting: true }), leaf('x'), leaf('y')])
    expect(toggleWouldCompleteWaitingStep(item)).toBe(true)
    expect(waitingToggleRefusal(item).where).toBe('below')
  })

  it('refuses a sub-sub-step tick that would finish a waiting twin', () => {
    const item = stepOf({}, [
      leaf('a', { subItems: [leaf('z', { waiting: true }), leaf('z')] }),
    ])
    expect(toggleWouldCompleteWaitingStep(item, 'a', 'z')).toBe(true)
  })

  it('still allows a tick when no twin is waiting', () => {
    const item = stepOf({}, [leaf('x'), leaf('x'), leaf('y', { waiting: true })])
    expect(toggleWouldCompleteWaitingStep(item, 'x')).toBe(false)
  })

  it('refuses removing a twin set whose removal rolls up a waiting parent', () => {
    const item = waitingStep([leaf('x', { done: true }), leaf('x'), leaf('y', { done: true })])
    expect(removalWouldCompleteWaitingStep(item, 'x')).toBe(true)
  })
})

describe('removalWouldCompleteWaitingStep', () => {
  it('refuses deleting the last open sub-step of a waiting step', () => {
    const item = waitingStep([leaf('a', { done: true }), leaf('b')])
    expect(removalWouldCompleteWaitingStep(item, 'b')).toBe(true)
  })

  it('allows deleting a sub-step that is not the last open one', () => {
    expect(removalWouldCompleteWaitingStep(waitingStep([leaf('a'), leaf('b')]), 'b')).toBe(false)
  })

  it('allows deleting a done sub-step while others are open', () => {
    expect(
      removalWouldCompleteWaitingStep(waitingStep([leaf('a', { done: true }), leaf('b')]), 'a'),
    ).toBe(false)
  })

  it('allows deleting when the step is not waiting, or its wait is verified', () => {
    expect(removalWouldCompleteWaitingStep(stepOf({}, [leaf('a', { done: true }), leaf('b')]), 'b')).toBe(
      false,
    )
    expect(
      removalWouldCompleteWaitingStep(
        stepOf({ waitingOns: [verified()] }, [leaf('a', { done: true }), leaf('b')]),
        'b',
      ),
    ).toBe(false)
  })

  // With no sub-steps left the step is flat again and keeps its stored `done`,
  // so deleting the only sub-step of an open waiting step completes nothing.
  it('allows deleting the only sub-step, which leaves the step open', () => {
    expect(removalWouldCompleteWaitingStep(waitingStep([leaf('a')]), 'a')).toBe(false)
  })

  it('refuses deleting the last open sub-sub-step of a waiting sub-step', () => {
    const item = stepOf({}, [
      leaf('a', { waiting: true, subItems: [leaf('a1', { done: true }), leaf('a2')] }),
    ])
    expect(removalWouldCompleteWaitingStep(item, 'a', 'a2')).toBe(true)
  })

  it('refuses deleting a sub-sub-step when it rolls a waiting top step up through its sub-item', () => {
    const two = waitingStep([
      leaf('a', { done: true }),
      leaf('b', { subItems: [leaf('b1', { done: true }), leaf('b2')] }),
    ])
    expect(removalWouldCompleteWaitingStep(two, 'b', 'b2')).toBe(true)
    // b1 as the ONLY child: removing it leaves `b` flat and open, so nothing finishes.
    const only = waitingStep([leaf('a', { done: true }), leaf('b', { subItems: [leaf('b1')] })])
    expect(removalWouldCompleteWaitingStep(only, 'b', 'b1')).toBe(false)
  })

  it('handles a missing step, id or target', () => {
    expect(removalWouldCompleteWaitingStep(undefined, 'a')).toBe(false)
    expect(removalWouldCompleteWaitingStep(waitingStep([leaf('a')]), undefined)).toBe(false)
    expect(removalWouldCompleteWaitingStep(waitingStep([leaf('a')]), 'zzz')).toBe(false)
  })

  it('carries the sentence the routes answer with', () => {
    expect(REMOVAL_WOULD_COMPLETE_WAITING_STEP).toBe(
      'Removing this would finish a step that is waiting. Clear its wait first.',
    )
  })
})

describe('operationCompletesWaitingStep', () => {
  it('is true when a waiting, not-done node comes out done', () => {
    expect(
      operationCompletesWaitingStep(waitingStep([leaf('a')]), {
        ...waitingStep([leaf('a', { done: true })]),
      }),
    ).toBe(true)
  })

  it('is false when the waiting node was already done, or stays open', () => {
    const done = stepOf({ waiting: true, done: true })
    expect(operationCompletesWaitingStep(done, done)).toBe(false)
    expect(operationCompletesWaitingStep(waitingStep([leaf('a')]), waitingStep([leaf('a')]))).toBe(
      false,
    )
  })

  it('is false when a node simply is not there afterward, and for missing items', () => {
    expect(
      operationCompletesWaitingStep(
        stepOf({}, [leaf('a', { waiting: true }), leaf('b', { done: true })]),
        stepOf({}, [leaf('b', { done: true })]),
      ),
    ).toBe(false)
    expect(operationCompletesWaitingStep(undefined, undefined)).toBe(false)
  })
})

describe('hasLiveSavedWaitInTree', () => {
  it('is true for a live wait on the step itself', () => {
    expect(hasLiveSavedWaitInTree({ waitingOns: [waiting()] })).toBe(true)
  })

  it('is true for a live wait on a sub-step or a sub-sub-step', () => {
    expect(hasLiveSavedWaitInTree({ subItems: [{ waitingOns: [waiting()] }] })).toBe(true)
    expect(
      hasLiveSavedWaitInTree({ subItems: [{ subItems: [{ waitingOns: [resolved()] }] }] }),
    ).toBe(true)
  })

  it('is false once every wait in the tree is verified, or when there are none', () => {
    expect(
      hasLiveSavedWaitInTree({
        waitingOns: [verified()],
        subItems: [{ waitingOns: [verified()], subItems: [{}] }],
      }),
    ).toBe(false)
    expect(hasLiveSavedWaitInTree({ subItems: [{}, { subItems: [{}] }] })).toBe(false)
    expect(hasLiveSavedWaitInTree(undefined)).toBe(false)
  })
})

describe('WAITING_BLOCK_TITLES: one wording for the tooltip and the server answer', () => {
  it('has one sentence per place the block comes from', () => {
    expect(WAITING_BLOCK_TITLES).toEqual({
      own: 'Clear the wait first',
      below: 'A sub-step is waiting - clear it first',
      above: 'The step above is waiting - clear it first',
    })
  })

  it('is exactly what a refused tick says, for each place', () => {
    const own = waitingToggleRefusal(waitingStep([]))
    expect(own).toMatchObject({ where: 'own', message: WAITING_BLOCK_TITLES.own })
    const parent = stepOf({}, [leaf('a'), leaf('b', { waitingOns: [waiting()] })])
    expect(waitingToggleRefusal(parent)).toMatchObject({ where: 'below', message: WAITING_BLOCK_TITLES.below })
    const roll = waitingStep([leaf('a', { done: true }), leaf('b')])
    expect(waitingToggleRefusal(roll, 'b')).toMatchObject({ where: 'above', message: WAITING_BLOCK_TITLES.above })
  })
})

/**
 * The OWNER's tick (featreq-8a01fe08): the toggle goes through and every node it
 * turned from not-done to done has its wait closed - the same nodes the guard
 * would have refused a staff member for, found by the same simulation.
 */
describe('toggleClosingWaits', () => {
  const OWNER = 'emp-brit'
  const AT = '2026-10-01T15:00:00.000Z'
  const closeBy = { userId: OWNER, at: AT }
  const run = (item, subId, subSubId) => toggleClosingWaits(item, subId, subSubId, closeBy)
  const closedEntry = (over = {}) =>
    waiting({
      resolvedAt: AT,
      resolvedBy: OWNER,
      verifiedAt: AT,
      verifiedBy: OWNER,
      ...over,
    })

  it('has the owner-facing tooltip sentence', () => {
    expect(OWNER_TICK_CLEARS_WAIT_TITLE).toBe('Checking this off clears the wait')
  })

  describe('the step itself', () => {
    it('closes a legacy flag: waiting goes false, the note stays, and the step is done', () => {
      const { item, closedWaits } = run(stepOf({ waiting: true, waitingOn: 'client to send' }))
      expect(item.done).toBe(true)
      expect(item.waiting).toBe(false)
      expect(item.waitingOn).toBe('client to send')
      expect(closedWaits).toEqual([{ path: [], label: 'Reconcile' }])
      expect(item.waitingOns).toBeUndefined()
    })

    it('verifies a saved wait nobody had finished: resolved and verified by the owner', () => {
      const { item, closedWaits } = run(stepOf({ waitingOns: [waiting()] }))
      expect(item.done).toBe(true)
      expect(item.waitingOns).toEqual([closedEntry()])
      expect(waitingOnStage(item.waitingOns[0])).toBe('verified')
      expect(closedWaits).toHaveLength(1)
    })

    it('keeps an existing resolution and adds only the verification', () => {
      const { item } = run(stepOf({ waitingOns: [resolved()] }))
      expect(item.waitingOns).toEqual([
        resolved({ verifiedAt: AT, verifiedBy: OWNER }),
      ])
      expect(item.waitingOns[0].resolvedBy).toBe(B)
      expect(item.waitingOns[0].resolvedAt).toBe('2026-08-07T01:00:00.000Z')
    })

    it('closes every open wait and never deletes one, including already-verified ones', () => {
      const { item, closedWaits } = run(
        stepOf({
          waiting: true,
          waitingOns: [
            waiting({ id: 'wo-1' }),
            resolved({ id: 'wo-2' }),
            verified({ id: 'wo-3' }),
          ],
        }),
      )
      expect(item.waitingOns.map((entry) => entry.id)).toEqual(['wo-1', 'wo-2', 'wo-3'])
      expect(item.waitingOns.every((entry) => !isWaitingOnOpen(entry))).toBe(true)
      // The already-verified one is left exactly as it was.
      expect(item.waitingOns[2]).toEqual(verified({ id: 'wo-3' }))
      expect(item.waiting).toBe(false)
      // One per wait closed: the two open entries.
      expect(closedWaits).toHaveLength(2)
    })

    it('mirrors a client wait too: open entry closed by the owner', () => {
      const { item } = run(stepOf({ waitingOns: [clientWait()] }))
      expect(waitingOnStage(item.waitingOns[0])).toBe('verified')
      expect(item.waitingOns[0].blockerType).toBe('client')
    })
  })

  describe('a parent tick that cascades', () => {
    it('closes the waiting sub-step and sub-sub-step it sweeps along, and nothing else', () => {
      const item = stepOf({}, [
        leaf('a'),
        leaf('b', {
          subItems: [
            { id: 'b1', title: 'Chase client', done: false, waitingOns: [waiting()] },
            { id: 'b2', title: 'File receipt', done: false },
          ],
        }),
        leaf('c', { waitingOns: [waiting()] }),
      ])
      const { item: after, closedWaits } = run(item)
      expect(after.done).toBe(true)
      const [a, b, c] = after.subItems
      expect(a.waiting).toBeUndefined()
      expect(b.subItems[0].waitingOns).toEqual([closedEntry()])
      expect(b.subItems[1].waiting).toBeUndefined()
      expect(c.waitingOns).toEqual([closedEntry()])
      expect(closedWaits.map(({ path }) => path)).toEqual([['b', 'b1'], ['c']])
      expect(closedWaits.map(({ label }) => label)).toEqual(['Chase client', 'Step c'])
    })

    it('ticking a sub-item closes the wait on it and on its waiting sub-sub-step', () => {
      const item = stepOf({}, [
        leaf('a', {
          waiting: true,
          subItems: [{ id: 'a1', title: 'Chase client', done: false, waitingOns: [waiting()] }],
        }),
        leaf('z'),
      ])
      const { item: after, closedWaits } = run(item, 'a')
      expect(after.subItems[0].done).toBe(true)
      expect(after.subItems[0].waiting).toBe(false)
      expect(after.subItems[0].subItems[0].waitingOns).toEqual([closedEntry()])
      // The parent step was not finished by this tick, so it is untouched.
      expect(after.done).toBe(false)
      expect(closedWaits).toHaveLength(2)
    })
  })

  describe('the last open child rolling a waiting parent up', () => {
    it('closes the parent step when its last open sub-step is ticked', () => {
      const item = waitingStep([leaf('a', { done: true }), leaf('b')])
      const { item: after, closedWaits } = run(item, 'b')
      expect(after.done).toBe(true)
      expect(after.waiting).toBe(false)
      expect(closedWaits).toEqual([{ path: [], label: 'Reconcile' }])
    })

    it('closes a waiting sub-step when its last open sub-sub-step is ticked, and the step above', () => {
      const item = stepOf({ waiting: true }, [
        leaf('a', {
          waiting: true,
          subItems: [
            { id: 'a1', title: 'One', done: true },
            { id: 'a2', title: 'Two', done: false },
          ],
        }),
      ])
      const { item: after, closedWaits } = run(item, 'a', 'a2')
      expect(after.done).toBe(true)
      expect(after.waiting).toBe(false)
      expect(after.subItems[0].waiting).toBe(false)
      expect(closedWaits.map(({ path }) => path)).toEqual([[], ['a']])
    })

    it('leaves the waiting parent open and its wait alone while another child is still open', () => {
      const item = waitingStep([leaf('a'), leaf('b')])
      const { item: after, closedWaits } = run(item, 'b')
      expect(after.done).toBe(false)
      expect(after.waiting).toBe(true)
      expect(closedWaits).toEqual([])
    })
  })

  it('tells duplicate sibling ids apart: only the twin the tick finished is closed', () => {
    // Same id twice (imported or hand-edited data). The simulation keys by id plus
    // ordinal, so the closing must too.
    const item = stepOf({}, [
      leaf('dup', { done: true, waiting: true }),
      leaf('dup', { waiting: true }),
      leaf('other'),
    ])
    const { item: after, closedWaits } = run(item, 'other')
    // 'other' is ticked; nothing waiting finishes (the first twin was already done
    // and the second twin's step stays open), so no wait closes.
    expect(closedWaits).toEqual([])
    expect(after.subItems[1].waiting).toBe(true)

    // Ticking the parent finishes the second twin only (the first was done).
    const swept = run(item)
    expect(swept.closedWaits).toHaveLength(1)
    expect(swept.item.subItems[0].waiting).toBe(true)
    expect(swept.item.subItems[1].waiting).toBe(false)
  })

  it('does not touch a node that was already done', () => {
    const item = stepOf({}, [
      leaf('a', { done: true, waitingOns: [waiting()] }),
      leaf('b', { waiting: true }),
    ])
    const { item: after, closedWaits } = run(item, 'b')
    expect(closedWaits).toHaveLength(1)
    // The done sub-step keeps its still-open saved wait exactly as it was.
    expect(after.subItems[0].waitingOns).toEqual([waiting()])
    expect(after.subItems[1].waiting).toBe(false)
  })

  it('un-ticking touches nothing: no wait closed or reopened', () => {
    const item = stepOf({ done: true, waiting: true, waitingOns: [waiting()] })
    const { item: after, closedWaits } = run(item)
    expect(after.done).toBe(false)
    expect(closedWaits).toEqual([])
    expect(after.waiting).toBe(true)
    expect(after.waitingOns).toEqual([waiting()])
  })

  it('leaves a step with nothing waiting exactly as the store toggle would', () => {
    const item = stepOf({}, [leaf('a'), leaf('b')])
    const { item: after, closedWaits } = run(item)
    expect(closedWaits).toEqual([])
    const plain = applyItemToggle(item.subItems, item.done, {})
    expect(after.subItems).toEqual(plain.subItems)
    expect(after.done).toBe(plain.done)
  })

  it('closes exactly the nodes the guard refuses: the same simulation, not a second reading', () => {
    const item = stepOf({}, [
      leaf('a'),
      leaf('b', { waiting: true }),
      leaf('c', { waitingOns: [verified()] }),
    ])
    expect(toggleWouldCompleteWaitingStep(item)).toBe(true)
    expect(run(item).closedWaits.map(({ path }) => path)).toEqual([['b']])
    // Once nothing waiting would finish, the guard and the closure agree on none.
    const clear = stepOf({}, [leaf('a'), leaf('c', { waitingOns: [verified()] })])
    expect(toggleWouldCompleteWaitingStep(clear)).toBe(false)
    expect(run(clear).closedWaits).toEqual([])
  })

  it('answers null for a target that does not exist, and never mutates its input', () => {
    const item = stepOf({ waiting: true }, [leaf('a')])
    const snapshot = JSON.stringify(item)
    expect(run(item, 'missing')).toBeNull()
    expect(run(undefined)).toBeNull()
    run(item)
    expect(JSON.stringify(item)).toBe(snapshot)
  })

  it('records the owner as both resolver and verifier when no one had resolved it', () => {
    const { item } = run(stepOf({ waitingOns: [waiting()] }))
    expect(item.waitingOns[0]).toMatchObject({
      resolvedAt: AT,
      resolvedBy: OWNER,
      verifiedAt: AT,
      verifiedBy: OWNER,
    })
  })
})

/**
 * The stage a hand-off action needs, asked again by the store on the wait as it
 * is NOW (two people can act on one wait at the same instant). The sentences are
 * the ones the route's early check answers for that stage; the route imports the
 * same constants, so the two cannot drift.
 */
describe('waitingOnStageRefusal: a hand-off action on a wait at the wrong stage', () => {
  const at = '2026-09-30T13:00:00.000Z'
  const entryAt = (stage, over = {}) => ({
    id: 'wo-1',
    blockerId: 'emp-lisa',
    requestedBy: 'emp-brit',
    createdAt: '2026-09-30T12:00:00.000Z',
    ...(stage !== 'waiting' ? { resolvedAt: at, resolvedBy: 'emp-lisa' } : {}),
    ...(stage === 'verified' ? { verifiedAt: at, verifiedBy: 'emp-brit' } : {}),
    ...over,
  })

  it('needs the stage each action has always needed', () => {
    expect(WAITING_ON_ACTION_STAGE).toEqual({
      done: 'waiting',
      question: 'waiting',
      verify: 'resolved',
      'send-back': 'resolved',
    })
  })

  it('allows every stage / action pair the routes allow, and refuses the rest with a 409', () => {
    for (const [action, needed] of Object.entries(WAITING_ON_ACTION_STAGE)) {
      for (const stage of ['waiting', 'resolved', 'verified']) {
        const refusal = waitingOnStageRefusal(action, entryAt(stage))
        if (stage === needed) {
          expect(refusal, `${action} at ${stage}`).toBeNull()
        } else {
          expect(refusal?.status, `${action} at ${stage}`).toBe(409)
          expect(typeof refusal?.error).toBe('string')
        }
      }
    }
  })

  it('answers with the sentences the route gives for that stage', () => {
    const sentence = (action, stage, over) => waitingOnStageRefusal(action, entryAt(stage, over))?.error
    expect(sentence('done', 'resolved')).toBe('This wait has already been marked done')
    expect(sentence('done', 'verified')).toBe('This wait has already been marked done')
    expect(sentence('question', 'resolved')).toBe(
      'This wait has already been marked done, so there is nothing to ask about',
    )
    expect(sentence('verify', 'waiting')).toBe(
      'Nobody has marked this done yet — it can be approved once they do',
    )
    expect(sentence('verify', 'verified')).toBe('This wait is already closed out')
    expect(sentence('send-back', 'waiting')).toBe(
      'Nobody has marked this done yet — there is nothing to send back',
    )
    expect(sentence('send-back', 'verified')).toBe('This wait is already closed out')
  })

  it('names the client wait the way the route does', () => {
    const client = { blockerType: 'client', blockerId: 'c1' }
    expect(waitingOnStageRefusal('question', entryAt('verified', client))?.error).toBe(
      'A client wait has nobody to ask — clients have no login here',
    )
    expect(waitingOnStageRefusal('send-back', entryAt('verified', client))?.error).toBe(
      'A client wait cannot be sent back',
    )
  })

  it('judges the stage with waitingOnStage, and knows no action it was not told about', () => {
    expect(waitingOnStage(entryAt('resolved'))).toBe('resolved')
    expect(waitingOnStageRefusal('cancel', entryAt('verified'))).toBeNull()
  })
})
