/**
 * The waiting-on hand-off state machine, shared by the server and the UI.
 *
 * Brittany's flow (her words, featreq-b05a2f3a):
 *   1. Person A needs help, creates the waiting item and assigns it to Person B
 *   2. B is notified and it lands in B's Delayed area
 *   3. B finishes their part and clicks Done — it leaves B's Delayed area and
 *      notifies A
 *   4. A confirms and clicks the final Done — it checks off like a sub-task,
 *      shrinks with a line through it, and leaves A's Delayed area
 *
 * So a wait has THREE stages, not two:
 *
 *   waiting ──B's Done──▶ resolved ──A's Done──▶ verified
 *
 * Nothing is ever deleted along that path. The old one-stage version REMOVED
 * the record on Done, which is why "the person's name that was to do the check
 * disappears" — her second complaint. The record is the receipt; it has to
 * outlive the wait.
 *
 * CLIENT WAITS are one click, not two. A client has no login, no notification
 * and no Delayed area, so there is no second party to hand back to — whoever
 * chased the client both finishes and confirms it. Their Done goes straight to
 * `verified`. Which client is never asked for: the task already belongs to one,
 * so the server fills `blockerId` in from the checklist.
 *
 * SEND BACK (her fourth round) is the one edge that loops:
 *
 *   waiting ──B's Done──▶ resolved ──A's Approve──▶ verified
 *                            │  ▲
 *              A's Send back │  │ B's Done again
 *                            ▼  │
 *                          waiting
 *
 * "if completed then we just need one button to approve and mark completed or a
 * button to not approve and send back with another note." Sending back clears
 * the resolution so the wait is B's move again — and stashes the resolution it
 * cleared, plus A's note, onto `sendBacks[]`. Nothing is overwritten: the
 * original note, who asked, who did it and when all survive every lap.
 *
 * NOTHING LEAVES THE DIAGRAM. Her fifth round: "User should not be able to
 * remove the information once it is saved, we don't want to lose the data and we
 * don't want to impact other people interacting with it." Cancel used to be the
 * one door out that erased the row; there is no such door now. Every arrow above
 * EDITS a saved wait's status fields, and no path deletes one — see
 * `waitingOnActionRefusal`.
 */

export const WAITING_STAGES = Object.freeze(['waiting', 'resolved', 'verified'])

/**
 * The two halves of the Delayed page. Her words: "maybe a waiting on me and a
 * I am waiting on others tabs within delayed to keep it organized."
 */
export const DELAYED_TABS = Object.freeze(['blocking', 'requesting'])

/** @returns {'waiting'|'resolved'|'verified'} */
export function waitingOnStage(entry) {
  if (entry?.verifiedAt) return 'verified'
  if (entry?.resolvedAt) return 'resolved'
  return 'waiting'
}

/** A wait on this task's client rather than on a teammate. */
export function isClientWait(entry) {
  return entry?.blockerType === 'client'
}

/** Still blocking the step? Verified waits stay on the record but stop blocking. */
export function isWaitingOnOpen(entry) {
  return waitingOnStage(entry) !== 'verified'
}

function isSelf(id, userId) {
  return Boolean(id) && id === userId
}

/**
 * What the server answers anyone who tries to erase a saved wait.
 *
 * Her words: "we don't want to lose the data and we don't want to impact other
 * people interacting with it." A wait is a shared record — who asked, who did
 * it, who confirmed, and when — so removing one takes the receipt away from
 * everybody on it, not just from whoever pressed the button. Hiding the button
 * is not enough: the route still existed, so the refusal lives here and the
 * endpoint reads it.
 */
export const SAVED_WAIT_IS_PERMANENT =
  'A saved wait is the record of who asked and who did it, so it stays on the task. Mark it done and approve it instead.'

/**
 * Action words that erase a record, so the route answers them with the reason
 * above rather than a bare 404.
 *
 * `cancel` is the one that was real: it shipped, tabs still hold it, and it
 * deleted the row. `delete` and `remove` are reserved — nothing has ever routed
 * to them — so that the obvious next name for the same idea lands on the refusal
 * instead of quietly becoming a new hole.
 *
 * The endpoint's route pattern is built FROM this list (see server.js), so a
 * word added here is refused rather than unmatched — the 409 contract for an old
 * tab is structural, not two lists that have to be kept in step by hand.
 */
export const REFUSED_WAITING_ON_ACTIONS = Object.freeze(['cancel', 'delete', 'remove'])

/**
 * The refusal for a waiting-on action that would ERASE the record, or null when
 * the action is a legitimate stage move. Status progression is not removal: the
 * three transitions all edit a saved wait in place and pass straight through.
 *
 * @param {string} action - the action segment of the waiting-on route.
 * @returns {{ status: number, error: string } | null}
 */
export function waitingOnActionRefusal(action) {
  if (REFUSED_WAITING_ON_ACTIONS.includes(action)) {
    // 409 rather than 403: this is a fact about the record, not about who you
    // are. No one — blocker, requester, owner — gets a different answer.
    return { status: 409, error: SAVED_WAIT_IS_PERMANENT }
  }
  return null
}

/** What the server answers someone who tries to wait on themselves. */
export const SELF_WAIT_REFUSAL =
  'A wait names who you are waiting ON — pick the client or a colleague, not yourself'

/**
 * A wait pointed back at the person creating it. Refused at creation: a wait on
 * yourself has nobody to notify and nobody to hand back to, so it can never
 * leave the `waiting` stage — and since nothing can remove it any more, it would
 * sit on the step forever.
 *
 * A CLIENT wait is never a self-wait: `blockerId` is the client's id, which
 * cannot collide with an employee's, and the check is skipped anyway.
 *
 * Only new waits are checked. Any self-wait already in the data stays readable
 * exactly as it is — it is a saved record now, and the rule above applies to it
 * too.
 */
export function isSelfWait({ blockerId, requestedBy, blockerType } = {}) {
  if (blockerType === 'client') return false
  return isSelf(blockerId, requestedBy)
}

/**
 * Who may press the FIRST Done — "my part is finished".
 *
 * For a normal wait that is the person being waited on: only B can report that
 * B is done. For a client wait there is no B, so it falls to whoever is chasing
 * the client — the person who flagged it or the step's assignee.
 */
export function canMarkWaitingOnDone({ entry, userId, isOwner = false, assigneeId = null }) {
  if (waitingOnStage(entry) !== 'waiting') return false
  if (isOwner) return true
  if (isClientWait(entry)) {
    return isSelf(entry.requestedBy, userId) || isSelf(assigneeId, userId)
  }
  return isSelf(entry.blockerId, userId)
}

/**
 * Who may press the SECOND Done — "confirmed, I can move on". The person who
 * asked (or the step's assignee, who is the one actually blocked). Only
 * available once the blocker has reported done: A cannot verify work B has not
 * said is finished. There is no longer a way out at the earlier stage either —
 * a wait A no longer needs still has to be reported done and approved, because
 * the record belongs to B as much as to A.
 */
export function canVerifyWaitingOn({ entry, userId, isOwner = false, assigneeId = null }) {
  if (waitingOnStage(entry) !== 'resolved') return false
  if (isOwner) return true
  return isSelf(entry.requestedBy, userId) || isSelf(assigneeId, userId)
}

/**
 * Who may press SEND BACK — "that isn't what I needed, do it again". Exactly
 * the same people who could approve it, at exactly the same stage: you cannot
 * reject work nobody has reported finished, and you cannot reject work you have
 * already approved.
 *
 * A CLIENT wait is excluded: a client has no login and no Delayed area, so
 * there is nobody to send it back TO. (It also never reaches `resolved` — a
 * client wait's single Done goes straight to `verified` — so this is belt and
 * braces rather than a live branch.)
 */
export function canSendBackWaitingOn({ entry, userId, isOwner = false, assigneeId = null }) {
  if (isClientWait(entry)) return false
  return canVerifyWaitingOn({ entry, userId, isOwner, assigneeId })
}

/**
 * Which Delayed tab a single wait sits on for `userId` — or null when it isn't
 * theirs at all. Her words: "maybe a waiting on me and a I am waiting on others
 * tabs within delayed to keep it organized."
 *
 * 'blocking'   — someone is waiting on YOU. It is your move, so this is the
 *                only tab with a Done button.
 * 'requesting' — you are waiting on someone else. Read-only while it is still
 *                open (her: "no button to push done just so they can see and
 *                remember it"); Approve / Send back once they report done.
 *
 * A CLIENT wait is "I am waiting on the client" — others, not me — even though
 * the requester is the one who eventually presses its single Done. The owner
 * override is deliberately NOT consulted here: an owner is routed by their real
 * part in the hand-off, or every wait in the firm would pile into their
 * "Waiting on me" tab.
 */
export function waitingOnDelayedTab({ entry, userId, assigneeId = null }) {
  if (!waitingOnConcernsUser({ entry, userId, assigneeId })) return null
  if (isClientWait(entry)) return 'requesting'
  if (waitingOnStage(entry) === 'waiting' && isSelf(entry?.blockerId, userId)) return 'blocking'
  return 'requesting'
}

/**
 * Whether this wait belongs on `userId`'s Delayed page.
 *
 * Her steps 3 and 4 both say "remove it from <person>'s delayed area", which
 * only means something if the two people see different lists — so the page
 * filters per viewer:
 *
 *   waiting  → the blocker (it is their move), plus the requester and the step
 *              assignee, who are the ones actually held up
 *   resolved → the requester and assignee only; B is finished and it has left
 *              their list
 *   verified → nobody
 */
export function waitingOnConcernsUser({ entry, userId, assigneeId = null }) {
  const stage = waitingOnStage(entry)
  if (stage === 'verified') return false
  const waitingSide = isSelf(entry?.requestedBy, userId) || isSelf(assigneeId, userId)
  if (stage === 'resolved') return waitingSide
  if (isClientWait(entry)) return waitingSide
  return waitingSide || isSelf(entry?.blockerId, userId)
}

/**
 * Whether a whole step should appear on `userId`'s Delayed page.
 *
 * A step can also be flagged waiting the old free-text way (`waiting: true`
 * with a note and nobody attached). Those have no one to attribute them to, so
 * filtering them the same way would silently empty the page of them: they fall
 * back to the step's assignee, or stay visible to everyone when the step has no
 * assignee either.
 */
export function waitingStepConcernsUser(node, { userId, assigneeId = null }) {
  const entries = (node?.waitingOns ?? []).filter(isWaitingOnOpen)
  if (entries.length > 0) {
    return entries.some((entry) => waitingOnConcernsUser({ entry, userId, assigneeId }))
  }
  if (node?.waiting !== true) return false
  return assigneeId ? isSelf(assigneeId, userId) : true
}

/**
 * The waits on a step that belong on `userId`'s given Delayed tab.
 *
 * A step can hold several waits at once, and one person can be the blocker on
 * one and the requester on another — of the SAME step. So the split is per
 * wait, not per step, and a step can legitimately appear on both tabs with a
 * different set of waits showing on each.
 */
export function waitingsOnDelayedTab(node, { userId, assigneeId = null, tab }) {
  return (node?.waitingOns ?? [])
    .filter(isWaitingOnOpen)
    .filter((entry) => waitingOnDelayedTab({ entry, userId, assigneeId }) === tab)
}

/**
 * Whether an OLD free-text wait (`waiting: true`, nobody attached) belongs on
 * this tab. It has no blocker to be, so it is always "I'm waiting on others" —
 * that is what a note like "client to send statements" means. Kept separate
 * from the structured routing so the fallback rule in `waitingStepConcernsUser`
 * stays the single place that decides who sees an unattributed wait.
 */
export function legacyWaitBelongsOnTab(node, { userId, assigneeId = null, tab }) {
  if (tab !== 'requesting') return false
  if ((node?.waitingOns ?? []).filter(isWaitingOnOpen).length > 0) return false
  return waitingStepConcernsUser(node, { userId, assigneeId })
}
