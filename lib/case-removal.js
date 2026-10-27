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
 * NEXT cycle generates as usual.
 */

/** The case a row belongs to: its `caseId`, or its own id for a legacy row without one. */
export function caseKeyOf(checklist) {
  if (!checklist) return null
  return checklist.caseId || checklist.id || null
}

/** The rows of `checklists` that belong to case `caseId`. */
export function rowsOfCase(checklists, caseId) {
  if (!caseId) return []
  return (Array.isArray(checklists) ? checklists : []).filter(
    (checklist) => checklist && caseKeyOf(checklist) === caseId,
  )
}

/**
 * The recycled rows that come back together with `target`: the rows of its case
 * carrying its exact `deletedAt` (removed with it by Remove case), `target`
 * first. A row deleted on its own is a set of one.
 */
export function removedCaseSet(target, recycled) {
  if (!target) return []
  const stamp = target.deletedAt
  if (!stamp) return [target]
  const key = caseKeyOf(target)
  const siblings = (Array.isArray(recycled) ? recycled : []).filter(
    (checklist) =>
      checklist && checklist.id !== target.id && checklist.deletedAt === stamp && caseKeyOf(checklist) === key,
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
