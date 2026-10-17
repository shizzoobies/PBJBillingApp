/**
 * Open next step now (featreq-8b54d117), the server's sentences and the case
 * completion rule it changes.
 *
 * Brittany: "when a task under a step gets a delayed [waiting] but all other
 * steps checked off, a button to open next step populates to push the next step
 * while waiting." Once a step can be opened early, a case can have a LATER stage
 * finished while an earlier one is still waiting - so "the last stage finished"
 * no longer means "the case is done". `caseAllDone` is the rule that replaces it.
 */

import { rollUpItemDone } from './checklist-step-done.js'
import { waitingBlocksCompletion } from './waiting-on-state.js'

/**
 * Whether any open step, sub-step or sub-sub-step of this checklist is waiting.
 * Picks the not_ready sentence: "nothing is waiting" or "something else is open".
 */
export function stageHasOpenWait(checklist) {
  const walk = (nodes) =>
    (nodes ?? []).some(
      (node) => !rollUpItemDone(node) && (waitingBlocksCompletion(node) || walk(node.subItems)),
    )
  return walk(checklist?.items)
}

/** "Step 2", for a 0-based stage index. */
function stepNumber(stageIndex) {
  return `Step ${(typeof stageIndex === 'number' ? stageIndex : 0) + 1}`
}

/**
 * The sentence for a refused Open next step now, by the store's reason.
 *
 * @param {string} reason - `NextStageRefusedError.reason`.
 * @param {{ stageIndex?: number, nextStageName?: string, anyWaiting?: boolean }} [context]
 *   `stageIndex` is the stage the button was pressed on.
 * @returns {string}
 */
export function nextStageRefusalMessage(reason, { stageIndex = 0, nextStageName = '', anyWaiting = false } = {}) {
  const next = stepNumber(stageIndex + 1)
  const named = nextStageName ? `${next} (${nextStageName})` : next
  switch (reason) {
    case 'not_found':
      return 'That task no longer exists.'
    case 'skipped':
      return 'This occurrence was skipped, so there is no next step to open from it.'
    case 'pushed':
      return 'This task was pushed. Open the next step from the copy that holds its open work.'
    case 'onboarding':
      return 'Onboarding steps move on only when they are finished.'
    case 'last_stage':
      return 'This is the last step of the case, so there is no next step to open.'
    case 'already_spawned':
      return `${next} is already open.`
    case 'not_ready': {
      // Both ways in: the waiting one (featreq-8b54d117) and the revive (featreq-ed73d181).
      const rule =
        'To open the next step now, every other step must be checked and one waiting, or every step done with the next step never opened.'
      return anyWaiting
        ? `Some steps here are still open and not waiting. ${rule}`
        : `Nothing here is waiting. ${rule}`
    }
    case 'later_stage_exists':
      return `A step after ${next} is already open, so ${next} is not created behind it.`
    case 'date_taken':
      return `${next} could not be created: another case of this recipe already has that step on that date.`
    case 'next_stage_empty':
      return `${named} has nothing on it, so there is nothing to open.`
    default:
      return `The recipe for this task no longer has a ${next.toLowerCase()} to open.`
  }
}

/**
 * Whether skipping this stage's occurrence just finished its STAGED case: the
 * case has more than one stage and `caseAllDone` now holds with the skipped row
 * stepped past. A single-stage occurrence that is skipped was never completed, so
 * it announces nothing. Read the workspace AFTER the skip is saved.
 */
export function skipCompletesCase(data, checklist) {
  const stageCount = typeof checklist?.stageCount === 'number' ? checklist.stageCount : 1
  if (stageCount <= 1) return false
  return caseAllDone(data, checklist.caseId || checklist.id)
}

/**
 * Whether every stage of a case is finished: at least one row of the case, every
 * row's steps all done, and the final stage (`stageIndex + 1 >= stageCount`)
 * among them. A skipped or recycled (deleted) occurrence is stepped past and never holds the case open;
 * a done-only record a split push left behind is done by construction.
 *
 * @param {{ checklists?: Array<{ id?: string, caseId?: string, stageIndex?: number, stageCount?: number, skippedAt?: string | null, deletedAt?: string | null, items?: Array<{ done?: boolean }> }> }} data
 * @param {string} caseId
 * @returns {boolean}
 */
export function caseAllDone(data, caseId) {
  if (!caseId) return false
  const rows = (data?.checklists ?? []).filter(
    (entry) => (entry.caseId || entry.id) === caseId && !entry.skippedAt && !entry.deletedAt,
  )
  if (rows.length === 0) return false
  // A row with no steps has nothing open, so it never holds the case open.
  const finished = (row) => (row.items ?? []).every((item) => item.done)
  if (!rows.every(finished)) return false
  return rows.some((row) => {
    const stageIndex = typeof row.stageIndex === 'number' ? row.stageIndex : 0
    const stageCount = typeof row.stageCount === 'number' ? row.stageCount : 1
    return stageIndex + 1 >= stageCount
  })
}
