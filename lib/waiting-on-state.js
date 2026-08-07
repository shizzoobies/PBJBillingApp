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
 */

export const WAITING_STAGES = Object.freeze(['waiting', 'resolved', 'verified'])

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
 * said is finished. A can still CANCEL at any time — that route is unchanged.
 */
export function canVerifyWaitingOn({ entry, userId, isOwner = false, assigneeId = null }) {
  if (waitingOnStage(entry) !== 'resolved') return false
  if (isOwner) return true
  return isSelf(entry.requestedBy, userId) || isSelf(assigneeId, userId)
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
