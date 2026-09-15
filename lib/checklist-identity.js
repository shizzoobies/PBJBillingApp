/**
 * ONE definition of "which recurring instance is this?" — shared by the server
 * materializer (`db/store.js`), the client-side backfill (`src/lib/utils.ts`)
 * and the on-demand generate endpoint.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Recurring checklist instances were being created by TWO code paths that each
 * kept their own private copy of the idempotency rule:
 *
 *   - the server materializer inside `appDataStore.read()` (ids like
 *     `check-c59cb47b`, from `randomUUID()`), and
 *   - `ensureRecurringChecklists()` in the browser, which runs on every
 *     app-data load and every local workspace edit (ids like `check-hk0dmbd`,
 *     from `Math.random()`), and then persists via the bulk save.
 *
 * Production ended up with 21 groups of ACTIVE checklists sharing an identical
 * `(template_id, due_date, stage_index)` — some groups mixing BOTH id styles.
 * Two copies of a rule are two chances to get it wrong, so the rule lives here
 * and nowhere else. Both backends (Postgres and the JSON file) go through the
 * same materializer, so they cannot diverge either.
 *
 * There is also a Postgres backstop — a UNIQUE partial index named
 * {@link CHECKLIST_INSTANCE_UNIQUE_INDEX} on exactly this tuple — so even a
 * racing writer physically cannot persist a second copy.
 */

/**
 * Identity of a materialized instance: template + the date it is due + which
 * stage of the case it is. This is the tuple the Postgres unique index covers,
 * and the tuple every generator must check before creating anything.
 *
 * Returns `null` for rows that aren't materialized instances (a one-off
 * checklist with no template, or a row with no due date) — those are never
 * deduped.
 */
export function checklistInstanceKey(templateId, dueDate, stageIndex) {
  if (!templateId || !dueDate) return null
  const index = typeof stageIndex === 'number' ? stageIndex : 0
  return `${templateId}:${dueDate}:${index}`
}

/**
 * The date that IDENTIFIES a stored instance — which is not always the date it
 * is due.
 *
 * A pushed occurrence (featreq-68638ed2) keeps its place in the cycle by
 * stamping `cycleDueDate` with the date it was ORIGINALLY due and moving
 * `dueDate` forward. Identity has to follow the cycle date, not the working
 * date, or the push breaks the two rules this whole file exists to protect:
 * the materializer would stop recognizing the pushed row and respawn the cycle
 * it came from, and the pushed row — parked by default on exactly the NEXT
 * cycle's date — would collide with that occurrence when it generates.
 *
 * Unset on every row that has never been pushed, so `dueDate` remains the
 * identity for all of them and nothing about existing behavior changes.
 */
export function checklistIdentityDueDate(checklist) {
  return checklist?.cycleDueDate ?? checklist?.dueDate ?? null
}

/**
 * Per-month identity (`${templateId}:${YYYY-MM}`) used by specific-months
 * templates, which generate at most one case per designated month regardless of
 * which day inside the month the due date lands on.
 *
 * NOT usable for weekly/monthly templates — a weekly template legitimately has
 * several instances in one month — which is exactly why the unique index uses
 * the full due date and not the month.
 */
export function checklistMonthKey(templateId, dueDate) {
  if (!templateId || !dueDate) return null
  return `${templateId}:${String(dueDate).slice(0, 7)}`
}

/**
 * Build both key sets from any number of checklist lists.
 *
 * IMPORTANT: pass the RECYCLED list too. A soft-deleted instance still counts
 * as "this period already happened" — otherwise the next read respawns the
 * instance the user just deleted (the "it comes right back" bug).
 */
export function buildChecklistInstanceKeys(...lists) {
  const instanceKeys = new Set()
  const monthKeys = new Set()
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const checklist of list) {
      if (!checklist) continue
      // The CYCLE date, not the working due date — see checklistIdentityDueDate.
      const identityDue = checklistIdentityDueDate(checklist)
      const instanceKey = checklistInstanceKey(
        checklist.templateId,
        identityDue,
        checklist.stageIndex,
      )
      if (instanceKey) instanceKeys.add(instanceKey)
      const monthKey = checklistMonthKey(checklist.templateId, identityDue)
      if (monthKey) monthKeys.add(monthKey)
    }
  }
  return { instanceKeys, monthKeys }
}

/**
 * First checklist in `checklists` matching the given instance identity, or
 * `undefined`. Lets a generator return the instance that already exists instead
 * of minting a second one.
 */
export function findChecklistInstance(checklists, templateId, dueDate, stageIndex) {
  const wanted = checklistInstanceKey(templateId, dueDate, stageIndex)
  if (!wanted) return undefined
  return (Array.isArray(checklists) ? checklists : []).find(
    (checklist) =>
      checklist &&
      checklistInstanceKey(
        checklist.templateId,
        checklistIdentityDueDate(checklist),
        checklist.stageIndex,
      ) === wanted,
  )
}

/**
 * Name of the Postgres UNIQUE partial index that backstops all of the above.
 * Created idempotently (and failure-tolerantly) in `initialize()`.
 */
export const CHECKLIST_INSTANCE_UNIQUE_INDEX = 'checklists_template_instance_uniq'

/**
 * Its replacement, on the same tuple but keyed by the CYCLE date
 * (`coalesce(cycle_due_date, due_date)`) so a pushed occurrence keeps its slot.
 * `initialize()` creates this one and then drops the v1 index above — in that
 * order, so a database too dirty to build the new index keeps the old backstop.
 */
export const CHECKLIST_INSTANCE_UNIQUE_INDEX_V2 = 'checklists_template_instance_uniq_v2'
