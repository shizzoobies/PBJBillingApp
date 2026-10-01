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
 * A QUESTION (her annotated screenshots, featreq-8b7d06d7) is the one arrow
 * that goes nowhere:
 *
 *   waiting ──B's Question──▶ waiting   (+ a message on the record, + A is told)
 *
 * "Sending does not complete the wait." B still owes the work and it stays on
 * B's Delayed page; all that changes is that A now knows what B is asking.
 *
 * SAVE IS THE ONLY WRITE that sets a wait's details. Everything before Save is
 * a draft the client holds in memory — pick the person, type the message,
 * choose the task it waits for, then Save creates the whole thing at once, or
 * Clear throws it away. After Save the details are frozen; see
 * `waitingLockRefusal`.
 *
 * NOTHING LEAVES THE DIAGRAM. Her fifth round: "User should not be able to
 * remove the information once it is saved, we don't want to lose the data and we
 * don't want to impact other people interacting with it." Cancel used to be the
 * one door out that erased the row; there is no such door now. Every arrow above
 * EDITS a saved wait's status fields, and no path deletes one — see
 * `waitingOnActionRefusal`.
 */

import {
  applyItemToggle,
  applySubItemRemoval,
  applySubSubItemRemoval,
  normalizeSubItems,
} from './checklist-step-ops.js'
import { rollUpItemDone } from './checklist-step-done.js'

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

/**
 * What the server answers a PATCH that would rewrite a saved wait's details.
 *
 * Her latest word (featreq-8b7d06d7, the annotated screenshots): "all info is
 * locked and cannot be changed" once Save is pressed — the person or client
 * waited on, the message, and the task it waits for. This deliberately reverses
 * the earlier round where the note stayed editable.
 *
 * The wait's own `note`, `blockerId` and `blockerType` have never had an edit
 * route, so the lock is really about the two fields that DO: the step's
 * free-text `waitingOn` note, and its `waitingForChecklistId` link — both of
 * which the editor now folds into the one atomic create. `waiting: false` is
 * refused with them because un-flagging a step is how Clear used to make a live
 * wait vanish off the page.
 */
export const SAVED_WAIT_FIELDS_ARE_LOCKED =
  'This wait was saved, so who it names, its message and the task it waits for are fixed. Mark it done and approve it instead.'

/**
 * The step fields a live saved wait freezes. `waiting` is only frozen in the
 * `false` direction — see `waitingLockRefusal`.
 */
export const LOCKED_WAIT_STEP_FIELDS = Object.freeze([
  'waitingOn',
  'waitingForChecklistId',
  'waiting',
])

/** Does this step carry a saved wait that is still live? */
export function hasLiveSavedWait(node) {
  return (node?.waitingOns ?? []).some(isWaitingOnOpen)
}

/**
 * Does this step, or any sub-step or sub-sub-step beneath it, carry a live saved
 * wait? A done step is only safe to tuck away (Hide completed) when this is
 * false: its Approve controls live on whichever row holds the wait, so hiding
 * the step would bury an open hand-off however deep it sits.
 */
export function hasLiveSavedWaitInTree(node) {
  return hasLiveSavedWait(node) || (node?.subItems ?? []).some(hasLiveSavedWaitInTree)
}

/**
 * Whether this node is waiting, in the one sense the app reads everywhere
 * (`stepIsWaiting` in `src/lib/utils.ts`): the legacy `waiting` flag, or any
 * structured wait not yet verified. Server code cannot reach that TS file, so
 * the meaning lives here in the shared JS module.
 */
function isStepWaiting(node) {
  return node?.waiting === true || (node?.waitingOns ?? []).some(isWaitingOnOpen)
}

/**
 * Whether this ONE node is waiting and not yet done (featreq-cdab1605). A DONE
 * node never counts: un-checking something already finished is always allowed,
 * wait or no wait. "Done" is the roll-up (`rollUpItemDone`), the rule the store
 * applies when it recomputes a parent, not the raw stored flag.
 *
 * This reads one node only. Whether an OPERATION may go ahead is decided by
 * simulation (`toggleWouldCompleteWaitingStep` and friends below), which looks
 * at every node the operation would touch.
 *
 * @param {{ done?: boolean, waiting?: boolean, waitingOns?: unknown[], subItems?: unknown[] }} node
 * @returns {boolean}
 */
export function waitingBlocksCompletion(node) {
  if (!node || rollUpItemDone(node)) return false
  return isStepWaiting(node)
}

/**
 * ONE RULE: no operation may turn a waiting, not-yet-done step into a done one.
 *
 * Three hand-written guards used to state it (the node itself, what a tick
 * cascades onto, the parent a tick rolls up) and each read "done" a little
 * differently from the store, which left two paths open (deleting a waiting
 * step's last open sub-step, and data where the raw flag and the roll-up
 * disagree). So the guard no longer restates any arithmetic: it RUNS the store's
 * own pure step math (`lib/checklist-step-ops.js`) on a copy of the step and
 * compares the step before and after. Whatever the store would do, the guard
 * sees, and the UI and the routes cannot drift from it.
 */

/** The three sentences a refused tick can carry, by where the waiting node is. */
const WAITING_OWN_MESSAGE = 'Clear the wait first'
const WAITING_SUBSTEP_MESSAGE = 'A sub-step is waiting - clear it first'
const WAITING_ABOVE_MESSAGE = 'The step above is waiting - clear it first'

/**
 * The ONE wording for a blocked checkbox, keyed by where the block comes from:
 * the step's own wait, a wait on one of its sub-steps, or a wait on the step
 * above that this tick would finish. The server answers a refused tick with the
 * same sentence and every disabled checkbox carries it as its tooltip, so what
 * a person is told never depends on whether the page or the server noticed first.
 */
export const WAITING_BLOCK_TITLES = Object.freeze({
  own: WAITING_OWN_MESSAGE,
  below: WAITING_SUBSTEP_MESSAGE,
  above: WAITING_ABOVE_MESSAGE,
})

/** What the server answers a delete (or an approval) that would finish a waiting step. */
export const REMOVAL_WOULD_COMPLETE_WAITING_STEP =
  'Removing this would finish a step that is waiting. Clear its wait first.'

/** The item with its sub-steps normalized exactly as the store reads them. */
function withNormalizedSteps(item) {
  return { ...item, subItems: normalizeSubItems(item.subItems, { withDone: true }) }
}

/** Every node of a step as `{ path, node }`: the item, its sub-items, their sub-sub-items. */
function stepNodes(item) {
  const nodes = [{ path: [], key: '', node: item }]
  const subOrdinals = new Map()
  for (const sub of item?.subItems ?? []) {
    const subKey = ordinalKey(subOrdinals, sub?.id)
    nodes.push({ path: [sub?.id], key: subKey, node: sub })
    const subSubOrdinals = new Map()
    for (const subSub of sub?.subItems ?? []) {
      nodes.push({
        path: [sub?.id, subSub?.id],
        key: `${subKey}/${ordinalKey(subSubOrdinals, subSub?.id)}`,
        node: subSub,
      })
    }
  }
  return nodes
}

/**
 * A sibling's identity: its id plus how many same-id siblings came before it.
 * Two steps can carry the same id (imported or hand-edited data), and keying by
 * id alone made the waiting twin invisible behind the one listed first.
 */
function ordinalKey(seen, id) {
  const ordinal = seen.get(id) ?? 0
  seen.set(id, ordinal + 1)
  return `${id}#${ordinal}`
}

/**
 * The paths (ids from the item down; `[]` is the item itself) of every node that
 * is waiting and not done in `itemBefore` but done in `itemAfter`. A node absent
 * after the operation (a removed sub-step) did not become done.
 *
 * `asRead` is the step as the page or route read it, un-normalized: a node's
 * wait is read from there when it has one, because normalizing for the store's
 * math can drop a flag the person still sees on screen.
 */
function completedWaitingPaths(itemBefore, itemAfter, asRead = itemBefore) {
  const before = new Map(stepNodes(itemBefore).map(({ key, node }) => [key, node]))
  const read = new Map(stepNodes(asRead).map(({ key, node }) => [key, node]))
  const completed = []
  for (const { path, key, node } of stepNodes(itemAfter)) {
    const was = before.get(key)
    if (!was || rollUpItemDone(was)) continue
    if (!isStepWaiting(read.get(key) ?? was)) continue
    if (rollUpItemDone(node)) completed.push(path)
  }
  return completed
}

/**
 * Whether an operation turned any waiting, not-yet-done node (the item, a
 * sub-item or a sub-sub-item) into a done one — by the roll-up, the one reading
 * of "done" the store and the guard share. Un-ticking, and removing anything
 * that leaves a waiting step open, are false.
 *
 * @param {{ done?: boolean, subItems?: unknown[] } | undefined} itemBefore
 * @param {{ done?: boolean, subItems?: unknown[] } | undefined} itemAfter
 * @returns {boolean}
 */
export function operationCompletesWaitingStep(itemBefore, itemAfter) {
  if (!itemBefore || !itemAfter) return false
  return completedWaitingPaths(itemBefore, itemAfter).length > 0
}

/**
 * The item before and after the store's own toggle, or null when the target
 * does not exist. `applyItemToggle` is the very function the store calls.
 */
function simulateToggle(item, subItemId, subSubItemId) {
  if (!item) return null
  const before = withNormalizedSteps(item)
  const next = applyItemToggle(before.subItems, before.done, { subItemId, subSubItemId })
  if (!next) return null
  return { before, after: { ...before, subItems: next.subItems, done: next.done } }
}

/**
 * The refusal for a tick that would finish a waiting step — or null when the
 * tick is fine. Covers every way a tick can do it: the node itself, a sub-step
 * the cascade completes beneath it, and a parent the roll-up completes above it.
 * Un-ticking is never refused: nothing becomes done.
 *
 * `where` says where the wait is: on the ticked step ('own'), beneath it
 * ('below'), or on the step above ('above'); `message` is the sentence for it.
 *
 * @param {{ done?: boolean, subItems?: unknown[] } | undefined} item - the top-level step, as read.
 * @param {string | undefined} subItemId - the sub-item ticked, or the one holding the sub-sub-item.
 * @param {string | undefined} subSubItemId - the sub-sub-item ticked, if any.
 * @returns {{ status: number, error: string, message: string, where: 'own' | 'below' | 'above' } | null}
 */
export function waitingToggleRefusal(item, subItemId, subSubItemId) {
  const simulated = simulateToggle(item, subItemId, subSubItemId)
  if (!simulated) return null
  const completed = completedWaitingPaths(simulated.before, simulated.after, item)
  if (completed.length === 0) return null
  const target = subSubItemId ? [subItemId, subSubItemId] : subItemId ? [subItemId] : []
  const atOrBelow = completed.filter((path) => target.every((id, index) => path[index] === id))
  let where = 'above'
  let message = WAITING_ABOVE_MESSAGE
  if (atOrBelow.length > 0) {
    if (atOrBelow.some((path) => path.length === target.length)) {
      where = 'own'
      message = WAITING_OWN_MESSAGE
    } else {
      where = 'below'
      message = WAITING_SUBSTEP_MESSAGE
    }
  }
  return { status: 409, error: 'STEP_IS_WAITING', message, where }
}

/**
 * Whether ticking the item (no ids), the sub-item (`subItemId`) or the sub-sub-
 * item (both ids) would finish a step that is waiting. The one predicate every
 * checkbox disables with and the toggle route refuses with.
 */
export function toggleWouldCompleteWaitingStep(item, subItemId, subSubItemId) {
  return waitingToggleRefusal(item, subItemId, subSubItemId) !== null
}

/**
 * Whether removing the sub-item (`subItemId`) or the sub-sub-item (both ids)
 * would finish a step that is waiting: removing the last OPEN child rolls the
 * parent up to done. Runs the store's own removal, so a delete button, a DELETE
 * route and an approved deletion request all read the same answer.
 */
export function removalWouldCompleteWaitingStep(item, subItemId, subSubItemId) {
  if (!item || !subItemId) return false
  const before = withNormalizedSteps(item)
  const next = subSubItemId
    ? applySubSubItemRemoval(before.subItems, { subItemId, subSubItemId })
    : applySubItemRemoval(before.subItems, before.done, subItemId)
  if (!next) return false
  const after = { ...before, subItems: next.subItems, done: next.done }
  return completedWaitingPaths(before, after, item).length > 0
}

/**
 * The refusal for a step PATCH that would edit a locked field while a saved
 * wait is live on that step — or null when the patch is allowed.
 *
 * Only LIVE waits lock the step. Once every wait is approved the step is an
 * ordinary one again: its free-text note and its task link are editable, and
 * the amber flag can finally be turned off, which is the only way a step whose
 * waits are all closed ever stops looking blocked.
 *
 * @param {{ waitingOns?: unknown[] }} node - the step being patched.
 * @param {Record<string, unknown>} patch - the incoming patch, already parsed.
 * @returns {{ status: number, error: string } | null}
 */
export function waitingLockRefusal(node, patch) {
  if (!hasLiveSavedWait(node)) return null
  const touched = Object.keys(patch ?? {}).filter((key) => {
    if (!LOCKED_WAIT_STEP_FIELDS.includes(key)) return false
    // Flagging a step waiting is never the problem — UN-flagging one is.
    if (key === 'waiting') return patch.waiting === false
    return true
  })
  if (touched.length === 0) return null
  // 409, like the removal refusal: a fact about the record, not about who you
  // are. Nobody gets a different answer.
  return { status: 409, error: SAVED_WAIT_FIELDS_ARE_LOCKED }
}

/**
 * Whether a step may be pointed at `taskId` as the task it is waiting for — or
 * the refusal to answer with.
 *
 * The three edges are the ones `src/lib/waitForTaskOptions.ts` documents for the
 * picker, restated where they can actually be enforced. The picker has offered
 * only same-client tasks since featreq-5dd514b8, but the routes accepted any
 * string at all, and a link the picker would never offer is a dependency whose
 * "Ready to continue" ping can never fire honestly:
 *
 *   1. The task must EXIST — checked against actives AND the recycle bin, since
 *      a recycled task is still a real dependency and still resolvable.
 *   2. A task cannot wait on ITSELF.
 *   3. It must belong to the SAME client (empty matches empty, so an internal
 *      task waits on internal tasks).
 *
 * `current` is the link already on the step: re-sending it is always allowed,
 * so a step that predates this rule — or one carrying a cross-client link the
 * picker deliberately keeps visible — is never made unsavable by it.
 *
 * Clearing (empty / null) is always allowed: no link is always a legal state.
 *
 * @param {{ id?: string, clientId?: string }} checklist - the task being edited.
 * @param {Array<{ id?: string, clientId?: string }>} pool - actives + recycled.
 * @param {string} taskId - the incoming link.
 * @param {string} [current] - the link already stored on the step.
 * @returns {{ status: number, error: string } | null}
 */
export function waitForTaskLinkDenial({ checklist, pool = [], taskId, current = '' }) {
  const wanted = String(taskId ?? '')
  if (!wanted) return null
  if (wanted === String(current ?? '')) return null
  if (wanted === checklist?.id) {
    return { status: 400, error: 'A task cannot be waiting for itself' }
  }
  const target = pool.find((entry) => entry?.id === wanted)
  if (!target) {
    return { status: 400, error: 'That task no longer exists, so nothing can wait for it' }
  }
  if ((target.clientId ?? '') !== (checklist?.clientId ?? '')) {
    return {
      status: 400,
      error: "A step can only wait for another of the same client's tasks",
    }
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
 * Who may ask a QUESTION / send the wait back with a message WITHOUT finishing
 * it — the other new button on her annotated Delayed screenshot, beside Done.
 *
 * It is the mirror of Send back: the same wait, the same conversation, the
 * other direction. B does not always know what A wanted, and the only two
 * things B could do before were finish it or leave it sitting there.
 *
 * Exactly the people who could press Done, at exactly the stage where Done is
 * live — you cannot ask about work you have already reported finished, and a
 * wait is nobody else's to speak on. A CLIENT wait is excluded: its "blocker"
 * is the client, who has no login to read the question, and the person holding
 * it is the one who would be asking.
 *
 * Asking does NOT resolve anything. The wait stays exactly where it is, on B's
 * Delayed page, still B's move — the message is a note on the record and a
 * notification to A, nothing more.
 */
export function canAskWaitingOnQuestion({ entry, userId, isOwner = false, assigneeId = null }) {
  if (isClientWait(entry)) return false
  return canMarkWaitingOnDone({ entry, userId, isOwner, assigneeId })
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
