/**
 * Remove case (2026-10-27, Alex for Brittany): "a way to manually just remove
 * stuff from her Cases in flight; we have old stuff and there is no way to get
 * rid of it." Every live row of a case goes to the checklist recycle bin in one
 * store call, all stamped with ONE `deletedAt`. That shared stamp is what makes
 * the removed steps a set: a restore of any one of them brings the whole case
 * back together, while a step deleted on its own earlier (a stamp of its own)
 * stays in the bin.
 *
 * Shared by `db/store.js` (file backend; the Postgres branch says the same in
 * SQL with `coalesce(case_id, id)` and an exact `deleted_at` match), the
 * workspace merge in `src/App.tsx` and the recycle bin on the Checklists page.
 *
 * No respawn: the materializer counts recycled rows as "this cycle already
 * happened" (`buildChecklistInstanceKeys(checklists, recycled)` in both
 * materializer copies), so a removed cycle is not generated again; the recipe's
 * NEXT cycle generates as usual. (Emptying the bin hard-deletes the rows, and a
 * cycle the recipe still schedules can then generate again.)
 */

import { checklistIdentityDueDate, checklistInstanceKey } from './checklist-identity.js'

/**
 * The refusal when a restore would put back a step whose cycle exists again as
 * a live step (Postgres: the partial unique instance index answers 23505).
 */
export const RESTORE_CONFLICT_MESSAGE =
  "That step's cycle was created again since; restore is not possible - remove the newer one first."

/**
 * The case a row belongs to: its `caseId`, or its own id for a legacy row
 * without one (an empty caseId counts as none, like SQL's
 * `coalesce(nullif(case_id, ''), id)`).
 */
export function caseKeyOf(checklist) {
  if (!checklist) return null
  return checklist.caseId || checklist.id || null
}

/**
 * The title Remove case names a case by: its first step's (the lowest stage
 * index among `rows`), else `fallback`. One source for the Dashboard rows and
 * the case page.
 */
export function caseTitleOf(rows, fallback = '') {
  const ordered = (Array.isArray(rows) ? rows : [])
    .filter(Boolean)
    .slice()
    .sort((a, b) => (a.stageIndex ?? 0) - (b.stageIndex ?? 0))
  return ordered[0]?.title || fallback
}

/**
 * The partial unique instance index's key for a row, or null when the index
 * does not cover it - it spans live rows with a template that were not pushed:
 * (template_id, coalesce(cycle_due_date, due_date), stage_index)
 *   where deleted_at is null and template_id is not null and pushed_to_checklist_id is null
 */
function indexedInstanceKey(checklist) {
  if (!checklist || !checklist.templateId || checklist.pushedToChecklistId) return null
  return checklistInstanceKey(checklist.templateId, checklistIdentityDueDate(checklist), checklist.stageIndex)
}

/**
 * The rows of `set` a restore cannot put back, because a live row already holds
 * the same instance (the file backend's mirror of the Postgres index refusal).
 */
export function restoreConflicts(set, live) {
  const taken = new Set((Array.isArray(live) ? live : []).map(indexedInstanceKey).filter(Boolean))
  return (Array.isArray(set) ? set : []).filter((checklist) => {
    const key = indexedInstanceKey(checklist)
    return key !== null && taken.has(key)
  })
}

/**
 * The rows of `checklists` that belong to case `caseId` - on `clientId` when
 * given. A case id is NOT unique across clients: a recipe copy made by the
 * 2026-08-14 import kept its case ids, so one id can hold steps of two clients.
 */
export function rowsOfCase(checklists, caseId, clientId) {
  if (!caseId) return []
  return (Array.isArray(checklists) ? checklists : []).filter(
    (checklist) =>
      checklist && caseKeyOf(checklist) === caseId && (clientId === undefined || checklist.clientId === clientId),
  )
}

/**
 * The recycled rows that come back together with `target`: the rows of its case
 * AND client carrying its exact `deletedAt` (removed with it by Remove case, or
 * deleted together in one go), `target` first. A row deleted on its own is a
 * set of one.
 */
export function removedCaseSet(target, recycled) {
  if (!target) return []
  const stamp = target.deletedAt
  if (!stamp) return [target]
  const key = caseKeyOf(target)
  const siblings = (Array.isArray(recycled) ? recycled : []).filter(
    (checklist) =>
      checklist &&
      checklist.id !== target.id &&
      checklist.deletedAt === stamp &&
      caseKeyOf(checklist) === key &&
      (checklist.clientId ?? null) === (target.clientId ?? null),
  )
  return [target, ...siblings]
}

/** "1 step" / "3 steps". */
export function stepCountLabel(count) {
  return `${count} step${count === 1 ? '' : 's'}`
}

/**
 * The confirm sentence for Remove case, word for word what Alex asked for:
 * "Remove <title> for <client>? Its N steps go to the recycle bin (you can
 * restore them there). The recipe keeps running on its next cycle."
 */
export function removeCaseConfirmText({ title, clientName, stepCount }) {
  return `Remove ${title} for ${clientName}? Its ${stepCountLabel(stepCount)} go${stepCount === 1 ? 'es' : ''} to the recycle bin (you can restore ${stepCount === 1 ? 'it' : 'them'} there). The recipe keeps running on its next cycle.`
}
