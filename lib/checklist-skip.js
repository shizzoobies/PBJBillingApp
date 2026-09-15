/**
 * Quiet skip for recurring checklist tasks.
 *
 * The rule, in Brittany's words: a staff member who won't complete a recurring
 * task this cycle — but WILL catch it on the next occurrence — should be able to
 * step past it quietly, so an "overdue" flag stops misrepresenting a task that
 * is simply moving to the next occurrence.
 *
 * Three things live here because the server, the store and `src/` all have to
 * agree about them, and three copies of a rule are three chances to get it
 * wrong (same arrangement as lib/recurring-gate.js — plain JS with a sibling
 * .d.ts so `src/` can import it without a second TypeScript copy):
 *
 *   1. WHAT COUNTS AS SKIPPABLE. Skipping is a property set when the recurring
 *      template is created, not a global capability. It is OFF by default and a
 *      task whose template has it off must not show the affordance at all —
 *      "they don't necessarily know skipping is an option unless enabled."
 *   2. THE REASON VOCABULARY. Exactly three categories, in her words: me / a
 *      colleague / the client. Plus a written explanation, required.
 *   3. WHO HEARS ABOUT IT. The owner every time; an Accountant when a
 *      Bookkeeper skips on a client the Accountant is on.
 *
 * WHAT A SKIP IS NOT: it is not a completion, not a deletion, and it does not
 * touch the overdue view. The skipped INSTANCE stays in the `checklists` table
 * carrying `skippedAt`, which is what makes the next occurrence behave: the
 * materializer's identity tuple is (template_id, due_date, stage_index), so a
 * surviving row stops this period respawning while the next period's different
 * due date generates exactly as it always did. Views drop it from the active
 * lists, so it can never reach an overdue bucket either.
 */

import { assignedTeamIds } from './data-scope.js'

/**
 * The dropdown. Exactly three, and the values are stable storage keys — the
 * labels are what the person picking reads.
 */
export const SKIP_REASON_CATEGORIES = [
  { value: 'me', label: 'Me — I could not get to it' },
  { value: 'colleague', label: 'A colleague — someone else could not get to it' },
  { value: 'client', label: 'The client — they did not get us what we needed' },
]

const CATEGORY_VALUES = new Set(SKIP_REASON_CATEGORIES.map((entry) => entry.value))

/** Is this one of the three stored category keys? */
export function isSkipReasonCategory(value) {
  return CATEGORY_VALUES.has(value)
}

/** The reader-facing label for a stored category key, or the key itself. */
export function skipReasonLabel(value) {
  return SKIP_REASON_CATEGORIES.find((entry) => entry.value === value)?.label ?? String(value ?? '')
}

/**
 * Refusal messages. Friendly rather than technical because a skip dialog is a
 * two-field form and the only thing a person can do wrong here is leave one of
 * them empty.
 */
export const SKIP_NOT_ENABLED_MESSAGE =
  'Skipping is not turned on for this task, so it cannot be skipped. Ask an owner if it should be.'
export const SKIP_NEEDS_CATEGORY_MESSAGE =
  'Please choose who could not complete it — you, a colleague, or the client.'
export const SKIP_NEEDS_EXPLANATION_MESSAGE =
  'Please add a short explanation of why this one is moving to the next occurrence.'
export const SKIP_ALREADY_SKIPPED_MESSAGE = 'This task has already been skipped for this cycle.'

/** Explanations are free text; capped so one paste cannot fill a column. */
export const SKIP_EXPLANATION_MAX_LENGTH = 2000

/**
 * Validate a skip request. Returns the normalized values on success so the
 * caller never re-trims — the server writes exactly what this returns.
 *
 * @param {{ category?: string, explanation?: string }} [input]
 * @returns {{ ok: boolean, error: string | null, category?: string, explanation?: string }}
 */
export function validateSkipRequest(input = {}) {
  if (!isSkipReasonCategory(input.category)) {
    return { ok: false, error: SKIP_NEEDS_CATEGORY_MESSAGE }
  }
  const explanation = String(input.explanation ?? '').trim()
  if (!explanation) {
    return { ok: false, error: SKIP_NEEDS_EXPLANATION_MESSAGE }
  }
  return {
    ok: true,
    error: null,
    category: input.category,
    explanation: explanation.slice(0, SKIP_EXPLANATION_MAX_LENGTH),
  }
}

/** Has this instance already been skipped for its cycle? */
export function isChecklistSkipped(checklist) {
  return Boolean(checklist?.skippedAt)
}

// ---- Push: the same form, a different outcome (featreq-68638ed2) ----
//
// Brittany asked for a button BESIDE Skip. Skip closes the occurrence out for
// its cycle; PUSH keeps the very same task alive on a new date. It is not a
// completion and it unblocks nothing — the task simply lives on, due later.
//
// It carries the identical requirements (who is responsible + a written
// explanation) and reaches the owner's review dashboard the same way, because
// the reason a task moved is the thing she is actually reviewing; whether it
// was stepped past or re-dated is a detail of the row.
//
// What makes a push safe is NOT in this file: the instance keeps its place in
// the cycle by stamping `cycleDueDate` with its original date, which is what
// the materializer's identity reads (lib/checklist-identity.js). Without that,
// pushing to the next cycle's date would both respawn the cycle just left and
// collide with the occurrence being pushed into.

export const PUSH_NEEDS_DATE_MESSAGE = 'Please choose the new date this task should be due.'
export const PUSH_DATE_UNREADABLE_MESSAGE =
  'That date could not be read — please pick one from the calendar.'
export const PUSH_DATE_NOT_LATER_MESSAGE =
  'Pick a date after the one it is due on now — pushing only ever moves a task forward.'
export const PUSH_DATE_TOO_FAR_MESSAGE =
  'Pick a date within two years of the one it is due on now — a push that far out is a typo far more often than it is a plan.'

/** How far ahead a push may land, in years past the current due date. */
export const PUSH_MAX_YEARS_AHEAD = 2

/** A real calendar date written `yyyy-mm-dd` (so 2026-02-30 is refused). */
function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  if (month < 1 || month > 12 || day < 1) return false
  const probe = new Date(Date.UTC(year, month - 1, day))
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  )
}

/** `yyyy-mm-dd` shifted by whole years in UTC (a Feb 29 start rolls to Mar 1). */
function addYears(dateOnly, years) {
  const [year, month, day] = dateOnly.split('-').map(Number)
  return new Date(Date.UTC(year + years, month - 1, day)).toISOString().slice(0, 10)
}

/**
 * Validate a push request: everything a skip needs, plus the new date.
 *
 * The date is checked against the instance's CURRENT `dueDate` — strictly
 * after, because a push that lands on or before today's date is either a no-op
 * or a backdate, and neither is what the button says it does. Returns the
 * normalized values so the server writes exactly what this returns.
 *
 * There is an upper bound too. The date arrives from a free-form
 * `<input type="date">`, where a mistyped year is one keystroke, and a push
 * moves the row's WORKING date while its identity stays on the cycle it came
 * from — so a task parked in 2226 is simply gone from every list anyone looks
 * at, with nothing downstream to flag it. Two years is far past any real
 * "come back to this", and a genuine one can be pushed twice.
 *
 * @param {{ category?: string, explanation?: string, newDueDate?: string }} [input]
 * @param {{ dueDate?: string } | null} [checklist]
 */
export function validatePushRequest(input = {}, checklist = null) {
  const base = validateSkipRequest(input)
  if (!base.ok) return base
  const newDueDate = String(input.newDueDate ?? '').trim()
  if (!newDueDate) {
    return { ok: false, error: PUSH_NEEDS_DATE_MESSAGE }
  }
  if (!isCalendarDate(newDueDate)) {
    return { ok: false, error: PUSH_DATE_UNREADABLE_MESSAGE }
  }
  const currentDue = String(checklist?.dueDate ?? '')
  if (currentDue && newDueDate <= currentDue) {
    return { ok: false, error: PUSH_DATE_NOT_LATER_MESSAGE }
  }
  if (
    currentDue &&
    isCalendarDate(currentDue) &&
    newDueDate > addYears(currentDue, PUSH_MAX_YEARS_AHEAD)
  ) {
    return { ok: false, error: PUSH_DATE_TOO_FAR_MESSAGE }
  }
  return { ...base, newDueDate }
}

/**
 * May this instance be skipped at all?
 *
 * Two conditions, both structural: it must be a materialized RECURRING instance
 * (a one-off task has no next occurrence to catch it on, so "skip" would just be
 * a quiet delete), and its template must carry `skipAllowed`.
 *
 * `skipAllowed` lives ONLY on the template — deliberately. Copying it onto every
 * instance would make an owner's later change of mind apply to some rows and not
 * others, which is the drift this codebase keeps paying for elsewhere.
 *
 * @param {{ templateId?: string } | null | undefined} checklist
 * @param {{ id?: string, skipAllowed?: boolean }[]} [templates]
 */
export function isSkipAllowedForChecklist(checklist, templates) {
  if (!checklist?.templateId) return false
  const list = Array.isArray(templates) ? templates : []
  const template = list.find((entry) => entry?.id === checklist.templateId)
  return Boolean(template?.skipAllowed)
}

/**
 * Should the skip affordance be rendered for this viewer on this instance?
 * Skipped-already and not-allowed both render NOTHING rather than a disabled
 * control — an affordance a person cannot use still tells them the option
 * exists, which is precisely what "unless enabled" rules out.
 */
export function canOfferSkip({ checklist, templates, canWrite }) {
  if (!canWrite) return false
  if (isChecklistSkipped(checklist)) return false
  return isSkipAllowedForChecklist(checklist, templates)
}

/**
 * Should the PUSH affordance be rendered? Exactly the same gate as skipping —
 * one template setting governs both, because to the owner turning it on they
 * are one permission ("this task may be moved off its cycle"), and a second
 * flag would be a second thing to keep honest. An already-skipped instance is
 * closed out for its cycle, so it cannot be pushed either.
 */
export function canOfferPush(args) {
  return canOfferSkip(args)
}

/**
 * Everyone who hears about a skip, as a de-duplicated list of user ids.
 *
 * WHY THE ACCOUNTANT RULE IS WRITTEN THIS WAY: "the accountant is notified when
 * a bookkeeper skips a task on their client" needs an accountant→bookkeeper
 * relationship, and this app's data has none — no supervisor id, no team table,
 * no reports-to column. The established substitution is the one already made for
 * the open-task badge in `src/lib/openTaskScope.ts`: "theirs" means "staffed
 * alongside them on a client they are assigned to", read off
 * `clients.assigned_bookkeeper_ids` (lib/data-scope.js, the single source of
 * truth for assignment). This reuses that substitution rather than inventing a
 * hierarchy. If a real hierarchy is ever added, that function and this one are
 * the two places to change.
 *
 * The person doing the skipping is never notified of their own skip.
 *
 * @param {object} args
 * @param {{ assignedBookkeeperIds?: string[] } | null} args.client
 * @param {{ id?: string, role?: string }[]} args.employees display-cased roles
 * @param {string} args.skipperId
 * @returns {string[]}
 */
export function skipNotificationRecipients({ client, employees, skipperId } = {}) {
  const staff = Array.isArray(employees) ? employees : []
  const recipients = new Set()

  // The owner, every time — her explicit ask.
  for (const employee of staff) {
    if (employee?.id && employee.role === 'Owner') recipients.add(employee.id)
  }

  // The shared-client substitution: only when a BOOKKEEPER did the skipping.
  const skipper = staff.find((employee) => employee?.id === skipperId)
  if (skipper?.role === 'Bookkeeper') {
    // TEAM, not visibility (2026-09-04 split). The question here is "who works
    // this account" — which Accountant should hear that a step was skipped and
    // may have to cover it — not "who is allowed to look". Someone handed a
    // single checklist on this client can see that checklist; that does not
    // make them the account's accountant, and paging them would be noise.
    const team = assignedTeamIds(client)
    for (const employee of staff) {
      if (!employee?.id) continue
      if (employee.role !== 'Accountant') continue
      if (team.includes(employee.id)) recipients.add(employee.id)
    }
  }

  recipients.delete(skipperId)
  return [...recipients]
}

/**
 * The owner's dashboard list: this year's skips that she has not reviewed yet,
 * newest first. PUSHES are in here too — the record's `kind` says which, and
 * both want the same look from her, so this filter deliberately doesn't care.
 *
 * Reviewing does NOT delete the record — it stamps it. This is an audit trail
 * (the same decision as the completed-tasks history), so "clears off my
 * dashboard" is a filter, never a delete.
 *
 * @param {{ skippedAt?: string | null, reviewedAt?: string | null }[]} skips
 * @param {number} year
 */
export function pendingSkipReviews(skips, year) {
  return (Array.isArray(skips) ? skips : [])
    .filter((skip) => skip && !skip.reviewedAt)
    .filter((skip) => String(skip.skippedAt ?? '').slice(0, 4) === String(year))
    .sort((a, b) => String(b.skippedAt ?? '').localeCompare(String(a.skippedAt ?? '')))
}
