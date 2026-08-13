import type {
  AppData,
  Checklist,
  ChecklistFrequency,
  ChecklistTemplate,
  Client,
  Contact,
  Employee,
  Invoice,
  PersistedInvoice,
  RecurringReimbursement,
  Reimbursement,
  SubscriptionPlan,
  TemplateStage,
  TimeEntry,
  WorkSession,
} from './types'

export const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
})

export const shortDate = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
})

export const checklistFrequencies: ChecklistFrequency[] = [
  'daily',
  'weekly',
  'biweekly',
  'monthly',
  'quarterly',
  'annually',
  'specific-months',
]

/** Short month names indexed 1–12 (index 0 unused). */
export const monthShortNames = [
  '',
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

/** Largest day-of-month a specific-months template may use (caps short months). */
export const MAX_DUE_DAY_OF_MONTH = 28

export function dateOffset(days: number) {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return date.toISOString().slice(0, 10)
}

export function currentBillingPeriod() {
  // LOCAL month (YYYY-MM). UTC would roll to next month on the last evening of
  // the month for US users, defaulting selectors to the wrong billing period.
  return localDateOnly().slice(0, 7)
}

/**
 * The LOCAL calendar date ('YYYY-MM-DD') for a timestamp/Date — using the
 * browser's own time zone, NOT UTC. `new Date(ms).toISOString().slice(0,10)`
 * gives the UTC day, which rolls forward for US users working in the evening
 * (e.g. 8pm CDT logs as tomorrow), landing time entries on the wrong day and
 * sometimes the wrong week. Use this whenever a user-facing "what day did this
 * happen" date is derived from a timestamp, so it matches the wall clock the
 * user is looking at (the manual time-entry form already uses the local day).
 */
export function localDateOnly(input: number | Date = new Date()): string {
  const date = typeof input === 'number' ? new Date(input) : input
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * True when a YYYY-MM-DD due date falls within the same calendar month as
 * `today` (also YYYY-MM-DD). Pure string comparison on the year-month prefix,
 * so it's timezone-safe and avoids Date math. Empty/invalid dates are not due.
 */
export function isDueThisMonth(dueDate: string, today: string = localDateOnly()): boolean {
  if (!dueDate || dueDate.length < 7) return false
  return dueDate.slice(0, 7) === today.slice(0, 7)
}

/**
 * Sunday-anchored "start of week" for a YYYY-MM-DD date. US convention:
 * Sun = 0 ... Sat = 6, so subtracting `getDay()` lands on the Sunday that
 * begins the week. Returns 'YYYY-MM-DD' (same shape as the input). The
 * noon timestamp avoids DST midnight wobble.
 */
export function weekStartOf(dateString: string): string {
  const date = new Date(`${dateString}T12:00:00`)
  date.setDate(date.getDate() - date.getDay())
  return date.toISOString().slice(0, 10)
}

/**
 * Sun-Sat date range for a given date. Returns both ends as 'YYYY-MM-DD'.
 * Useful for filtering time entries to a week and for the "Sun X – Sat Y"
 * label shown on the time page submission widget.
 */
export function weekRangeOf(dateString: string): { start: string; end: string } {
  const start = weekStartOf(dateString)
  const endDate = new Date(`${start}T12:00:00`)
  endDate.setDate(endDate.getDate() + 6)
  return { start, end: endDate.toISOString().slice(0, 10) }
}

/** Today's week-start ('YYYY-MM-DD' Sunday) — small convenience wrapper. */
export function currentWeekStart(): string {
  // Seed from the LOCAL day so "this week" matches the user's wall clock; on a
  // Saturday evening UTC is already Sunday and would open next week.
  return weekStartOf(localDateOnly())
}

/**
 * Human label for a week-start date. "Jan 14 – 20, 2025" for same-month
 * ranges, "Dec 29, 2024 – Jan 4, 2025" when the week crosses a year /
 * month boundary. Tuned for tight headers on the time page widget.
 */
export function getWeekLabel(weekStart: string): string {
  const { start, end } = weekRangeOf(weekStart)
  const startDate = new Date(`${start}T12:00:00`)
  const endDate = new Date(`${end}T12:00:00`)
  const sameMonth =
    startDate.getMonth() === endDate.getMonth() && startDate.getFullYear() === endDate.getFullYear()
  if (sameMonth) {
    const month = new Intl.DateTimeFormat('en-US', { month: 'short' }).format(startDate)
    return `${month} ${startDate.getDate()} – ${endDate.getDate()}, ${startDate.getFullYear()}`
  }
  const startLabel = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(startDate)
  const endLabel = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(endDate)
  return `${startLabel} – ${endLabel}`
}

/** Add `weeks` to the given week-start. Negative values walk backwards. */
export function shiftWeek(weekStart: string, weeks: number): string {
  const date = new Date(`${weekStart}T12:00:00`)
  date.setDate(date.getDate() + weeks * 7)
  return date.toISOString().slice(0, 10)
}

export function getBillingPeriodLabel(period: string) {
  const [year, month] = period.split('-').map(Number)
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(
    new Date(year, month - 1, 1),
  )
}

export function isInBillingPeriod(entry: TimeEntry, period: string) {
  return entry.date.startsWith(period)
}

/**
 * What each stored-invoice status is CALLED on screen. Kept here rather than in
 * either invoice view because both the month run and History render the same
 * status pill: two copies would eventually disagree, and a status that reads
 * one way in the run and another way in the archive is the kind of thing that
 * gets reported as a missing invoice.
 */
export const INVOICE_STATUS_LABELS: Record<PersistedInvoice['status'], string> = {
  draft: 'Draft',
  reviewed: 'Reviewed',
  sent: 'Sent',
  processing: 'Processing',
  paid: 'Paid',
  overdue: 'Overdue',
  void: 'Void',
}

export type InvoiceMonthSummary = {
  /** Non-void invoices — what every figure below is counted from. */
  liveCount: number
  voidCount: number
  billed: number
  paid: number
  outstanding: number
}

/**
 * What a month of invoices adds up to, for the History view's header line.
 *
 * Two rules, both of which are the kind of thing that would be reported as a
 * bug in the other direction:
 *
 *  - VOIDED invoices are excluded from all of it. A void is a document that was
 *    withdrawn, and counting it would say the firm billed money it never asked
 *    for. They are counted separately so a month that is half voids does not
 *    look like a month where invoices went missing.
 *  - `outstanding` is billed minus paid, which means PROCESSING counts as
 *    outstanding. An ACH payment takes about four business days to clear, and
 *    money that has not arrived is not settled.
 *
 * Every figure is rounded to cents on the way out. Summing floats leaves
 * residue — a fully paid month can land on -0.0000000001 outstanding, which
 * `Intl.NumberFormat` renders as "-$0.00". A month that is square has to read
 * as square.
 */
function toCents(amount: number) {
  return Math.round(amount * 100) / 100
}

export function summarizeInvoiceMonth(invoices: PersistedInvoice[]): InvoiceMonthSummary {
  const live = invoices.filter((invoice) => invoice.status !== 'void')
  const billed = toCents(live.reduce((sum, invoice) => sum + invoice.total, 0))
  const paid = toCents(
    live
      .filter((invoice) => invoice.status === 'paid')
      .reduce((sum, invoice) => sum + invoice.total, 0),
  )
  return {
    liveCount: live.length,
    voidCount: invoices.length - live.length,
    billed,
    paid,
    outstanding: toCents(billed - paid),
  }
}

/**
 * When an invoice was emailed: "Aug 9", or "Aug 9, 2025" once the year is no
 * longer the current one — the year is noise on this month's run and the whole
 * point on an invoice someone dug up from last year.
 *
 * Shared by the month run and the per-client view so the two cannot report the
 * same send in two different formats.
 */
export function formatSentOn(iso: string) {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return ''
  const thisYear = parsed.getFullYear() === new Date().getFullYear()
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    ...(thisYear ? {} : { year: 'numeric' }),
  }).format(parsed)
}

/**
 * Client Recap period helpers (UI-side mirror of lib/periods.js). The server
 * validates and labels periods; these just drive the page's selector. A period
 * is "2026-08" (month) or "2026-Q3" (quarter).
 */
export function currentReviewPeriod(type: 'month' | 'quarter'): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() + 1
  if (type === 'quarter') return `${year}-Q${Math.ceil(month / 3)}`
  return `${year}-${String(month).padStart(2, '0')}`
}

export function shiftReviewPeriod(
  type: 'month' | 'quarter',
  period: string,
  dir: number,
): string {
  if (type === 'quarter') {
    const year = Number(period.slice(0, 4))
    const q = Number(period.slice(6))
    const index = year * 4 + (q - 1) + dir
    return `${Math.floor(index / 4)}-Q${(index % 4) + 1}`
  }
  const year = Number(period.slice(0, 4))
  const month = Number(period.slice(5, 7))
  const index = year * 12 + (month - 1) + dir
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`
}

/**
 * Whole-day difference between a due date and today (both ISO yyyy-mm-dd).
 * Positive = days until due, negative = days overdue, 0 = due today.
 */
export function daysUntilDue(dueDate: string, todayDateOnly: string): number {
  const today = new Date(`${todayDateOnly}T12:00:00`)
  const due = new Date(`${dueDate}T12:00:00`)
  return Math.round((due.getTime() - today.getTime()) / 86_400_000)
}

/**
 * The date a checklist effectively needs attention by: the EARLIEST of its own
 * due date and any incomplete step / sub-step / sub-sub-step due date. A task
 * whose overall deadline is month-end but has a sub-step due the 15th should
 * surface as due the 15th, so nothing slips. Returns ISO yyyy-mm-dd.
 */
export function effectiveChecklistDue(checklist: Checklist): string {
  let earliest = checklist.dueDate
  const consider = (done: boolean, dueDate?: string) => {
    if (!done && dueDate && dueDate < earliest) earliest = dueDate
  }
  for (const item of checklist.items) {
    consider(item.done, item.dueDate)
    for (const sub of item.subItems ?? []) {
      consider(sub.done, sub.dueDate)
      for (const subSub of sub.subItems ?? []) {
        consider(subSub.done, subSub.dueDate)
      }
    }
  }
  return earliest
}

/** Which "due" bucket a checklist falls into on the Checklists page. */
export type ChecklistDueBucket = 'overdue' | 'week' | 'month' | 'later' | 'completed'

/**
 * Bucket a checklist by how soon it's due (using the soonest of the overall
 * deadline and any incomplete step's due). The "month" bucket is a ROLLING
 * ~31-day horizon, NOT the current calendar month — otherwise a task due a week
 * or two out that lands in the NEXT calendar month would fall into the
 * collapsed "Later" bucket and disappear from the view (it would still show on
 * the Gantt, which is date-range based — the exact mismatch staff reported).
 */
export function groupChecklist(checklist: Checklist, todayDateOnly: string): ChecklistDueBucket {
  const completed = checklist.items.filter((item) => item.done).length
  const total = checklist.items.length
  if (total > 0 && completed === total) return 'completed'
  const due = effectiveChecklistDue(checklist)
  if (due < todayDateOnly) return 'overdue'
  if (daysUntilDue(due, todayDateOnly) <= 7) return 'week'
  if (daysUntilDue(due, todayDateOnly) <= 31) return 'month'
  return 'later'
}

/**
 * True when a checklist has a pending staff deletion request awaiting owner
 * approval — i.e. `deletionRequestedBy` is a non-empty string. (A request can
 * only exist on an active checklist; the field is cleared on approve/reject.)
 */
export function checklistHasPendingDeletionRequest(checklist: Checklist): boolean {
  return typeof checklist.deletionRequestedBy === 'string' && checklist.deletionRequestedBy.length > 0
}

/**
 * Stable key identifying one item / sub-item / sub-sub-item across a checklist
 * for pending item-deletion-request lookup. Empty path segments collapse to ''
 * so a top-level item, a sub-item, and a sub-sub-item never collide:
 *   `${checklistId}:${itemId}:${subItemId||''}:${subSubItemId||''}`
 * Pure — the client builds a Set of these from the request list and the server
 * dedupes against the same shape. `null`/`undefined` path parts are treated as
 * absent.
 */
export function itemDeletionKey(
  checklistId: string,
  itemId: string,
  subItemId?: string | null,
  subSubItemId?: string | null,
): string {
  return `${checklistId}:${itemId}:${subItemId || ''}:${subSubItemId || ''}`
}

/** Friendly relative due-date cue: "due today", "due in 3 days", "4 days overdue". */
export function dueDateLabel(dueDate: string, todayDateOnly: string): string {
  const days = daysUntilDue(dueDate, todayDateOnly)
  if (days === 0) return 'due today'
  if (days === 1) return 'due tomorrow'
  if (days > 1) return `due in ${days} days`
  if (days === -1) return '1 day overdue'
  return `${Math.abs(days)} days overdue`
}

/**
 * The name of the stage a (possibly multi-stage) checklist instance is on,
 * resolved live from its template. Returns undefined for single-stage / one-off
 * checklists or when the template no longer exists.
 */
export function stageNameFor(
  templates: ChecklistTemplate[],
  checklist: Pick<Checklist, 'templateId' | 'stageIndex'>,
): string | undefined {
  if (!checklist.templateId || typeof checklist.stageIndex !== 'number') return undefined
  const template = templates.find((entry) => entry.id === checklist.templateId)
  const stage = template?.stages?.[checklist.stageIndex]
  const name = stage?.name?.trim()
  return name ? name : undefined
}

/** Full English month names indexed 1–12 (index 0 unused). */
export const MONTH_NAMES = [
  '',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const

/** Clamp an arbitrary value to a valid billing month (1–12), defaulting to January. */
export function normalizeBillingMonth(value: unknown): number {
  const month = Number(value)
  if (!Number.isFinite(month) || month < 1 || month > 12) return 1
  return Math.floor(month)
}

/**
 * True for an UNSPLIT group holding entry — a tracked block (no single client)
 * carrying its member clients, waiting to be split for billing. Such entries
 * are drafts: not billable, on no invoice, and kept out of the approval queue
 * until the owner splits them into per-client entries.
 */
export function isGroupHoldingEntry(entry: {
  clientId: string
  isAdministrative?: boolean
  groupClientIds?: string[]
}): boolean {
  return !entry.clientId && !entry.isAdministrative && (entry.groupClientIds?.length ?? 0) > 0
}

/**
 * How a block of "group time" is allocated across the selected clients:
 * - `even`   — split the duration as evenly as possible.
 * - `full`   — bill every client the full duration (e.g. a meeting that serves
 *              several clients where each is charged the whole hour).
 * - `custom` — the owner sets each client's minutes by hand (full flexibility).
 *
 * The rules themselves live in `lib/group-allocation.js` (plain JS) because the
 * SERVER performs the split and this module only draws the preview. Re-exported
 * here so every existing import keeps working — and so the preview and the
 * saved entries can never disagree.
 */
export type { GroupAllocationMode } from '../../lib/group-allocation.js'
export {
  allocateGroupMinutes,
  // Percentages are the friendly face of `custom`: the modal collects "60% / 40%",
  // converts it to exact seconds here, and submits an ordinary custom split.
  allocateByPercentages,
  percentagesFromMinutes,
  percentagesTotalTo100,
  // Which entries can be split, and the client checkbox list a regular-entry
  // split opens with — shared so the modal offers exactly what the server allows.
  classifySplitTarget,
  // The one rule for what an edit does to an entry's billed minutes, so the
  // edit form's live total and the server's stored result cannot disagree.
  minutesAfterEntryEdit,
  minutesToSeconds,
  splitClientOptions,
  // Reopening a split with its current distribution intact — the prefill the
  // "Adjust split" modal opens with.
  splitGroupPrefill,
} from '../../lib/group-allocation.js'

import { buildInvoiceLines, PER_EMPLOYEE_BILLING_START as SHARED_CUTOVER } from '../../lib/invoice-lines.js'
import {
  buildChecklistInstanceKeys,
  checklistInstanceKey,
  checklistMonthKey,
} from '../../lib/checklist-identity.js'
import {
  isClientWait,
  isWaitingOnOpen,
  waitingOnStage,
  type WaitingOnLike,
} from '../../lib/waiting-on-state.js'
import { inactiveClientIds } from '../../lib/recurring-gate.js'

/**
 * Recurring-instance identity, shared verbatim with the server materializer
 * (db/store.js) so the two generators cannot disagree about what already
 * exists. See lib/checklist-identity.js for why that matters.
 */
export {
  buildChecklistInstanceKeys,
  checklistInstanceKey,
  checklistMonthKey,
}

/** Add the `(template, dueDate, stage 0)` key for a just-created instance. */
function registerInstanceKey(keys: Set<string>, templateId: string, dueDate: string) {
  const key = checklistInstanceKey(templateId, dueDate, 0)
  if (key) keys.add(key)
}

export function getAssignedEmployeeIds(client: Client) {
  return client.assignedEmployeeIds ?? []
}

export function makeId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`
}

export function addDays(dateString: string, days: number) {
  const date = new Date(`${dateString}T12:00:00`)
  date.setDate(date.getDate() + days)
  return date.toISOString().slice(0, 10)
}

export function addMonths(dateString: string, months: number) {
  const [year, month, day] = dateString.split('-').map(Number)
  return new Date(year, month - 1 + months, day).toISOString().slice(0, 10)
}

export function advanceChecklistFrequency(dateString: string, frequency: ChecklistFrequency) {
  if (frequency === 'daily') {
    return addDays(dateString, 1)
  }

  if (frequency === 'weekly') {
    return addDays(dateString, 7)
  }

  if (frequency === 'biweekly') {
    return addDays(dateString, 14)
  }

  if (frequency === 'quarterly') {
    return addMonths(dateString, 3)
  }

  if (frequency === 'annually') {
    return addMonths(dateString, 12)
  }

  return addMonths(dateString, 1)
}

export function getChecklistFrequencyLabel(frequency: ChecklistFrequency) {
  if (frequency === 'specific-months') {
    return 'Specific months'
  }
  if (frequency === 'biweekly') {
    return 'Biweekly (every 2 weeks)'
  }
  return frequency.charAt(0).toUpperCase() + frequency.slice(1)
}

/* -------------------------------------------------------------------------- */
/* Plans ↔ checklist-template association                                      */
/* -------------------------------------------------------------------------- */

/**
 * A readable picker label for a checklist template: "<title> · <frequency>"
 * (e.g. "Monthly Bookkeeping · Monthly"). Standard blueprints are tagged so
 * the owner can tell them apart from client-specific copies.
 */
export function templatePickerLabel(template: ChecklistTemplate): string {
  const base = `${template.title} · ${getChecklistFrequencyLabel(template.frequency)}`
  return template.isStandard ? `${base} (blueprint)` : base
}

/**
 * The checklist templates bundled with a plan, resolved from the plan's
 * `templateIds` against the full template list. Ids that no longer resolve to a
 * real template (deleted since being linked) are dropped, and order follows the
 * plan's `templateIds`. Pure — safe to use in render and in tests.
 */
export function planTemplates(
  plan: Pick<SubscriptionPlan, 'templateIds'>,
  templates: ChecklistTemplate[],
): ChecklistTemplate[] {
  const ids = Array.isArray(plan.templateIds) ? plan.templateIds : []
  const byId = new Map(templates.map((template) => [template.id, template]))
  const seen = new Set<string>()
  const result: ChecklistTemplate[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    const template = byId.get(id)
    if (template) {
      seen.add(id)
      result.push(template)
    }
  }
  return result
}

/**
 * Whether a plan's template is "already set up" on a given client. A client
 * template matches the plan's source template when it targets this client AND
 * either was cloned from it (`sourceTemplateId` stamp) OR shares its title
 * (case-insensitive, trimmed) — the stamp is authoritative, the title is the
 * fallback for templates created before origin stamping existed.
 */
function clientHasPlanTemplate(
  planTemplate: ChecklistTemplate,
  clientId: string,
  clientTemplates: ChecklistTemplate[],
): boolean {
  const wantTitle = planTemplate.title.trim().toLowerCase()
  return clientTemplates.some((template) => {
    if (template.clientId !== clientId) return false
    if (template.sourceTemplateId && template.sourceTemplateId === planTemplate.id) {
      return true
    }
    return template.title.trim().toLowerCase() === wantTitle
  })
}

/**
 * The plan's templates that are NOT yet set up on the given client — i.e. the
 * ones "Set up plan checklists" would clone. `clientTemplates` is normally the
 * full template list (it filters to the client itself). Pure.
 */
export function missingPlanTemplatesForClient(
  plan: Pick<SubscriptionPlan, 'templateIds'>,
  templates: ChecklistTemplate[],
  clientId: string,
  clientTemplates: ChecklistTemplate[],
): ChecklistTemplate[] {
  return planTemplates(plan, templates).filter(
    (template) => !clientHasPlanTemplate(template, clientId, clientTemplates),
  )
}

/**
 * Roll-up completion, recursing up to three levels (item → sub-item →
 * sub-sub-item). A node with children is `done` exactly when every child is
 * `done` (children are themselves evaluated by the same rule); a node with no
 * children keeps its own stored `done`. Pure — safe to call anywhere the
 * derived state is needed.
 */
export function isChecklistItemDone(item: {
  done: boolean
  subItems?: { done: boolean; subItems?: { done: boolean }[] }[]
}): boolean {
  if (Array.isArray(item.subItems) && item.subItems.length > 0) {
    return item.subItems.every((sub) => isChecklistItemDone(sub))
  }
  return item.done
}

/**
 * Whether a checklist step (item / sub-item / sub-sub-item) counts as "waiting."
 * True when the legacy `waiting` toggle is on OR the node carries ≥1 structured
 * person-blocker (`waitingOns`). Used everywhere the app decides "is this step
 * waiting?" so person-only blockers surface in the existing waiting UI without
 * flipping the old boolean.
 */
export function stepIsWaiting(node: {
  waiting?: boolean
  waitingOns?: WaitingOnLike[]
}): boolean {
  // Waits are no longer deleted when they finish — a closed-out one stays on
  // the step as the record of who did the check. So counting entries is not
  // enough any more; a verified entry must stop holding the step amber, or
  // every completed hand-off would leave the step looking blocked forever.
  return node.waiting === true || (node.waitingOns ?? []).some(isWaitingOnOpen)
}

/**
 * The patch the waiting editor's "Done" sends. Deliberately narrow: it retires
 * the blocker (`waiting` off, no more waiting-for-a-task link) and touches
 * nothing else — the `waitingOn` note stays on the step as the permanent
 * record, and the step's own `done` is never set, because completing the work
 * is the checkboxes' job. Owner's rule, shipped in 039a2d2; pinned by tests so
 * it can't drift back.
 */
export const WAITING_DONE_PATCH: Readonly<{
  waiting: boolean
  waitingForChecklistId: string | null
}> = { waiting: false, waitingForChecklistId: null }

/**
 * The waiting editor's "Clear" button — the opposite of Done. Done means "this
 * finished, keep the receipt"; Clear means "this was never really a wait",
 * so it ERASES the note rather than keeping it. Pinned here beside
 * {@link WAITING_DONE_PATCH} so the difference between the two buttons is one
 * diff apart and can't quietly converge.
 */
export const WAITING_CLEAR_PATCH: Readonly<{
  waiting: boolean
  waitingOn: null
  waitingForChecklistId: null
}> = { waiting: false, waitingOn: null, waitingForChecklistId: null }

/**
 * The waits on a step that are CLOSED OUT — confirmed by whoever asked, so they
 * no longer block anything and no longer belong in the amber editor. They are
 * not gone: they render on the step as completed sub-items, struck through, the
 * way any ticked checklist item does.
 *
 * This is the other half of the fix for "[I] clicked Confirmed on the waiting
 * task and it disappeared". The record already survived on the server; what it
 * had nowhere to render was a home outside the editor, which unmounts the
 * instant the last wait closes.
 */
export function completedWaits<T extends WaitingOnLike>(
  waitingOns: readonly T[] | undefined,
): T[] {
  return (waitingOns ?? []).filter((entry) => !isWaitingOnOpen(entry))
}

/**
 * The full provenance of a closed-out wait, as one readable line: who asked,
 * who did it, who confirmed it, and when. This is the "information in it" that
 * has to stay — three names and two dates are the entire audit trail of a
 * two-party hand-off, and losing them is what made the feature untrustworthy.
 *
 * Names resolve through the same helpers the rest of the page uses, so an
 * unknown id reads "Unassigned" rather than as a raw id. A client wait names
 * the client (its `blockerId` points at the client record, not an employee).
 */
export function describeWaitProvenance(
  entry: WaitingOnLike & { requestedBy?: string; createdAt?: string },
  { employees, clientLabel }: { employees: Employee[]; clientLabel: string },
): string {
  const parts: string[] = []
  const stamp = (iso?: string) => (iso ? ` ${shortDate.format(new Date(iso))}` : '')

  const blocker = isClientWait(entry) ? clientLabel || 'the client' : employeeName(employees, entry.blockerId ?? '')
  if (entry.requestedBy) {
    parts.push(`asked by ${employeeName(employees, entry.requestedBy)}${stamp(entry.createdAt)}`)
  }
  if (entry.resolvedBy) {
    parts.push(`done by ${employeeName(employees, entry.resolvedBy)}${stamp(entry.resolvedAt)}`)
  } else if (entry.resolvedAt) {
    parts.push(`done by ${blocker}${stamp(entry.resolvedAt)}`)
  }
  if (entry.verifiedBy) {
    parts.push(
      `confirmed by ${employeeName(employees, entry.verifiedBy)}${stamp(entry.verifiedAt)}`,
    )
  }
  return parts.join(' · ')
}

/**
 * Which endpoint retires each structured person-blocker when "Done" is pressed.
 * If I'm the person being waited on it is genuinely "done" (notifies the
 * flagger and the assignee); otherwise I'm the blocked side saying the wait is
 * over, which is the "cancel" endpoint.
 *
 * Retiring these is not optional: `stepIsWaiting` ORs `waitingOns` in, so a
 * "Done" that only flipped the `waiting` boolean left the step amber and the
 * editor open — the click produced no visible change whatsoever.
 */
export function planWaitingDone(
  waitingOns: ReadonlyArray<{
    id: string
    blockerId: string
    blockerType?: 'employee' | 'client'
    resolvedAt?: string
    verifiedAt?: string
  }>,
  meId: string,
): Array<{ id: string; action: 'done' | 'cancel' | 'verify' }> {
  return waitingOns
    .filter(isWaitingOnOpen)
    .map((entry) => {
      // Already reported done by the other side — this press is the confirmation.
      if (waitingOnStage(entry) === 'resolved') {
        return { id: entry.id, action: 'verify' as const }
      }
      // Mine to finish (or a client wait, which nobody hands back), so this is
      // the first Done. Anything else is someone else's to report, and pressing
      // the step's Done means "I no longer need it" — a cancel.
      if (entry.blockerId === meId || isClientWait(entry)) {
        return { id: entry.id, action: 'done' as const }
      }
      return { id: entry.id, action: 'cancel' as const }
    })
}

export type ChecklistStatus = 'Done' | 'Overdue' | 'In progress' | 'Not started'

/**
 * Derive a single rolled-up status label for a checklist. Pure — `today` is a
 * YYYY-MM-DD string so callers control "now" (and tests stay deterministic).
 *   - Done: every item is done (via the `isChecklistItemDone` roll-up)
 *   - Overdue: not done and `dueDate` is strictly before `today`
 *   - In progress: not done, not overdue, and at least one item done
 *   - Not started: nothing done yet
 */
export function deriveChecklistStatus(
  checklist: {
    items: { done: boolean; subItems?: { done: boolean; subItems?: { done: boolean }[] }[] }[]
    dueDate?: string
  },
  today: string,
): ChecklistStatus {
  const items = checklist.items ?? []
  const total = items.length
  const doneCount = items.filter((item) => isChecklistItemDone(item)).length
  if (total > 0 && doneCount === total) {
    return 'Done'
  }
  if (checklist.dueDate && checklist.dueDate < today) {
    return 'Overdue'
  }
  if (doneCount > 0) {
    return 'In progress'
  }
  return 'Not started'
}

// Tasks you can log time against for a client: every open (not fully
// complete) task for that client. The server already scopes a non-owner's
// data to clients they're assigned to, so "all of this client's tasks" is
// exactly the shared-client board — no per-assignee filtering here. A team
// member can therefore log time against any task on a client they're
// assigned to, including get-ahead tasks assigned to a teammate.
export function eligibleChecklistsFor(checklists: Checklist[], clientId: string): Checklist[] {
  if (!clientId) return []
  return checklists.filter((checklist) => {
    if (checklist.clientId !== clientId) return false
    const total = checklist.items.length
    const done = checklist.items.filter((item) => item.done).length
    return !(total > 0 && done === total)
  })
}

export function sortChecklists(checklists: Checklist[]) {
  return [...checklists].sort((left, right) => {
    if (left.dueDate !== right.dueDate) {
      return left.dueDate.localeCompare(right.dueDate)
    }

    return left.title.localeCompare(right.title)
  })
}

/**
 * Backwards-compat: take a template that may still have flat `items` and ensure
 * it has a `stages` array. Idempotent — templates that already have stages are
 * returned with their stage shape normalized. Pre-stage templates' top-level
 * assigneeId/viewerIds/editorIds become Stage 1's defaults.
 */
export function ensureTemplateStages(template: ChecklistTemplate): ChecklistTemplate {
  const viewerIds = Array.isArray(template.viewerIds) ? [...template.viewerIds] : []
  const editorIds = Array.isArray(template.editorIds) ? [...template.editorIds] : []
  const existingStages = Array.isArray((template as { stages?: TemplateStage[] }).stages)
    ? (template as { stages?: TemplateStage[] }).stages!
    : null

  if (existingStages && existingStages.length > 0) {
    const stages = existingStages.map((stage, index) => ({
      id: stage.id || makeId('stage'),
      name: stage.name || `Stage ${index + 1}`,
      assigneeId: stage.assigneeId || template.assigneeId,
      offsetDays: Number.isFinite(stage.offsetDays) ? Number(stage.offsetDays) : 0,
      ...(stage.dueDate ? { dueDate: stage.dueDate } : {}),
      ...(typeof stage.dueDayOfMonth === 'number' && stage.dueDayOfMonth >= 1
        ? { dueDayOfMonth: stage.dueDayOfMonth }
        : {}),
      viewerIds: Array.isArray(stage.viewerIds) ? [...stage.viewerIds] : [],
      editorIds: Array.isArray(stage.editorIds) ? [...stage.editorIds] : [],
      items: Array.isArray(stage.items) ? stage.items.map((item) => ({ ...item })) : [],
    }))
    return { ...template, viewerIds, editorIds, stages }
  }

  const flatItems = Array.isArray(template.items) ? template.items.map((item) => ({ ...item })) : []
  const stage: TemplateStage = {
    id: makeId('stage'),
    name: 'Stage 1',
    assigneeId: template.assigneeId,
    offsetDays: 0,
    viewerIds,
    editorIds,
    items: flatItems,
  }
  return { ...template, viewerIds, editorIds, stages: [stage] }
}

/**
 * The Nth day of `baseDate`'s month as an ISO yyyy-mm-dd, with `day` clamped to
 * the month's real length (so "31" lands on Feb 28/29). Mirrors the helper in
 * db/store.js.
 */
function dayOfMonthDate(baseDate: string, day: number): string {
  const [year, month] = baseDate.split('-').map(Number)
  const lastDay = new Date(year, month, 0).getDate()
  const clamped = Math.min(Math.max(Math.trunc(day), 1), lastDay)
  return `${year}-${String(month).padStart(2, '0')}-${String(clamped).padStart(2, '0')}`
}

/**
 * Resolve a stage's due date. Precedence: an explicit fixed `stage.dueDate`
 * always wins; else a recurring `stage.dueDayOfMonth` resolves to that day of
 * `baseDate`'s month (clamped to the month's length); else the LEGACY
 * `offsetDays` — kept for back-compat — counts days BEFORE the deadline so a
 * hand-off stage lands on or before the task's due date; else `baseDate`.
 * Note: per-stage *repeat cadence* is not supported — the template repeats as a
 * whole; only the due date can be per-stage.
 */
export function resolveStageDueDate(stage: TemplateStage, baseDate: string): string {
  if (stage.dueDate) {
    return stage.dueDate
  }
  if (typeof stage.dueDayOfMonth === 'number' && stage.dueDayOfMonth >= 1) {
    return dayOfMonthDate(baseDate, stage.dueDayOfMonth)
  }
  const offset = Number(stage.offsetDays) || 0
  return offset ? addDays(baseDate, -offset) : baseDate
}

/**
 * Resolve a checklist NODE's (item / sub-item / sub-sub-item) concrete due date
 * for a given cycle month. Precedence: a fixed `node.dueDate` wins; else a
 * recurring `node.dueDayOfMonth` resolves to that day of `cycleYear`/
 * `cycleMonth` (1–12), clamped to the month's length; else `undefined`.
 */
export function resolveNodeDueDate(
  node: { dueDate?: string; dueDayOfMonth?: number },
  cycleYear: number,
  cycleMonth: number,
): string | undefined {
  if (node.dueDate) {
    return node.dueDate
  }
  if (typeof node.dueDayOfMonth === 'number' && node.dueDayOfMonth >= 1) {
    const lastDay = new Date(cycleYear, cycleMonth, 0).getDate()
    const day = Math.min(Math.trunc(node.dueDayOfMonth), lastDay)
    return `${cycleYear}-${String(cycleMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }
  return undefined
}

function buildChecklistFromStage(
  template: ChecklistTemplate,
  stage: TemplateStage,
  stageIndex: number,
  stageCount: number,
  caseId: string,
  dueDate: string,
  completed = false,
): Checklist {
  // When `completed` is true (a specific-months instance for a month whose
  // due date is already in the past), every item/sub-item/sub-sub-item is
  // born `done:true` so the historical occurrence shows as finished.
  // Derive the cycle month from the stage's resolved due date so each node's
  // recurring day-of-month lands in the right month.
  const [cycleYear, cycleMonth] = dueDate.split('-').map(Number)
  return {
    id: makeId('check'),
    templateId: template.id,
    title: template.title,
    clientId: template.clientId,
    assigneeId: stage.assigneeId,
    frequency: template.frequency,
    dueDate,
    viewerIds: [...stage.viewerIds],
    editorIds: [...stage.editorIds],
    createdAt: new Date().toISOString().slice(0, 10),
    caseId,
    stageId: stage.id,
    stageIndex,
    stageCount,
    // Inherit the template's board column, exactly like the server materializer
    // (db/store.js buildChecklistFromStage) does. Omitting it was why instances
    // generated in the browser landed in "Uncategorized" on the Active board
    // even when their template had a category.
    categoryId: template.categoryId ?? null,
    items: stage.items.map((item) => {
      const itemDue = resolveNodeDueDate(item, cycleYear, cycleMonth)
      return {
        id: makeId('item'),
        label: item.label,
        done: completed,
        ...(itemDue ? { dueDate: itemDue } : {}),
        ...(item.assigneeId ? { assigneeId: item.assigneeId } : {}),
        ...(Array.isArray(item.subItems) && item.subItems.length > 0
          ? {
              subItems: item.subItems.map((sub) => {
                const subDue = resolveNodeDueDate(sub, cycleYear, cycleMonth)
                return {
                  id: makeId('subitem'),
                  title: sub.title,
                  done: completed,
                  ...(subDue ? { dueDate: subDue } : {}),
                  ...(Array.isArray(sub.subItems) && sub.subItems.length > 0
                    ? {
                        subItems: sub.subItems.map((subSub) => {
                          const subSubDue = resolveNodeDueDate(subSub, cycleYear, cycleMonth)
                          return {
                            id: makeId('subsubitem'),
                            title: subSub.title,
                            done: completed,
                            ...(subSubDue ? { dueDate: subSubDue } : {}),
                          }
                        }),
                      }
                    : {}),
                }
              }),
            }
          : {}),
      }
    }),
  }
}

/**
 * Concrete due date a specific-months template's checklist gets in `month` of
 * `year`. Prefers the per-month `monthlyDueDays` entry, falls back to the legacy
 * shared `dueDayOfMonth`, then to the last day of the month. The chosen day is
 * clamped to the month's real length (so "31" lands on Feb 28/29). `month` is
 * 1–12.
 */
export function resolveSpecificMonthsDueDate(
  template: Pick<ChecklistTemplate, 'dueDayOfMonth' | 'monthlyDueDays'>,
  year: number,
  month: number,
): string {
  const lastDay = new Date(year, month, 0).getDate()
  const perMonth = template.monthlyDueDays ? Number(template.monthlyDueDays[month]) : NaN
  const legacy = typeof template.dueDayOfMonth === 'number' ? template.dueDayOfMonth : NaN
  const requested = Number.isFinite(perMonth) && perMonth >= 1 ? perMonth : legacy
  const day = Number.isFinite(requested) && requested >= 1 ? Math.min(requested, lastDay) : lastDay
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * Due date for the FIRST stage of a specific-months case instance. Honors that
 * stage's own `dueDayOfMonth` (resolved inside the designated `month`, so it
 * stays in-month) — matching how every LATER stage honors its own day via
 * {@link resolveStageDueDate} — and falls back to the template's per-month /
 * shared due day when stage 1 has none. A fixed stage `dueDate` and the legacy
 * `offsetDays` are intentionally NOT applied here: either could push the
 * instance out of its designated month and break the materializer's per-month
 * idempotency key. Without this, stage 1 alone was pinned to the template's
 * month-level day (e.g. the 20th) while stages 2+ used their own (the 5th, the
 * 10th…), so step 1 showed the wrong due date.
 */
export function resolveSpecificMonthsStageDueDate(
  template: Pick<ChecklistTemplate, 'dueDayOfMonth' | 'monthlyDueDays'>,
  stage: Pick<TemplateStage, 'dueDayOfMonth'>,
  year: number,
  month: number,
): string {
  if (typeof stage.dueDayOfMonth === 'number' && stage.dueDayOfMonth >= 1) {
    const lastDay = new Date(year, month, 0).getDate()
    const day = Math.min(Math.trunc(stage.dueDayOfMonth), lastDay)
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }
  return resolveSpecificMonthsDueDate(template, year, month)
}

export function ensureRecurringChecklists(data: AppData) {
  const templates = (data.checklistTemplates ?? []).map((template) => ensureTemplateStages(template))
  const existingChecklists = (data.checklists ?? []).map((checklist) => ({
    ...checklist,
    viewerIds: Array.isArray(checklist.viewerIds) ? checklist.viewerIds : [],
    editorIds: Array.isArray(checklist.editorIds) ? checklist.editorIds : [],
  }))

  // Backfill case/stage fields on legacy checklists.
  let changed = false
  const templatesById = new Map(templates.map((template) => [template.id, template] as const))
  const checklistsBackfilled = existingChecklists.map((checklist) => {
    const next = { ...checklist }
    let mutated = false
    if (!next.caseId) {
      next.caseId = next.id
      mutated = true
    }
    if (typeof next.stageIndex !== 'number') {
      next.stageIndex = 0
      mutated = true
    }
    if (typeof next.stageCount !== 'number') {
      next.stageCount = 1
      mutated = true
    }
    if (!next.stageId && next.templateId) {
      const owningTemplate = templatesById.get(next.templateId)
      const firstStage = owningTemplate?.stages?.[0]
      if (firstStage) {
        next.stageId = firstStage.id
        next.stageCount = owningTemplate!.stages.length
        mutated = true
      }
    }
    if (mutated) changed = true
    return next
  })

  // Materialise stage 1 instances for due/overdue templates.
  //
  // The SERVER runs the same materializer on every read (db/store.js
  // `materializeRecurringChecklists`) and is the authoritative generator. This
  // copy exists so a local workspace edit (e.g. creating a template) shows its
  // first instance immediately instead of waiting for a refetch. Because both
  // can run, they MUST agree on what "already exists" means down to the last
  // character — that shared rule lives in lib/checklist-identity.js. When they
  // disagreed, the two paths each spawned their own instance for the same
  // period, which is how production collected duplicate checklists carrying two
  // different id styles (server `check-<uuid8>` vs browser `check-<rand7>`).
  const today = new Date().toISOString().slice(0, 10)
  const checklists = [...checklistsBackfilled]

  // Recycled instances count as "this period already happened" — otherwise a
  // checklist the user deleted gets respawned here and re-uploaded by the bulk
  // save, undoing the delete. The server has always folded them in; this copy
  // did not, which is the second way the two paths diverged.
  const { instanceKeys: existingKeys, monthKeys: existingMonthKeys } =
    buildChecklistInstanceKeys(checklistsBackfilled, data.recycledChecklists)

  const todayDate = new Date()
  const currentYear = todayDate.getFullYear()
  // Same gate the server materializer applies: a retired client generates
  // nothing new. Its existing instances are already in `checklists` and stay.
  const retiredClients = inactiveClientIds(data.clients)

  for (const template of templates) {
    const stages = template.stages ?? []
    // Standard templates are blueprints only — they never materialize.
    if (
      template.isStandard ||
      !template.active ||
      retiredClients.has(template.clientId) ||
      stages.length === 0 ||
      stages[0].items.length === 0
    ) {
      continue
    }

    // Specific-months mode: ignore nextDueDate advance logic. For each
    // designated month of the current year that has already started, generate
    // a Stage-1 instance unless one already exists for that template+month.
    if (template.frequency === 'specific-months') {
      // "Repeat every year" off: only generate for the year the template was
      // scheduled in. true/undefined behaves as today (every year).
      if (template.repeatAnnually === false && currentYear !== template.scheduleYear) {
        continue
      }
      const months = Array.isArray(template.scheduledMonths) ? template.scheduledMonths : []
      for (const month of months) {
        if (!Number.isInteger(month) || month < 1 || month > 12) continue
        // Has this month started? (today on or after the 1st of that month.)
        const monthStart = new Date(currentYear, month - 1, 1)
        if (todayDate < monthStart) continue
        const stageOne = stages[0]
        // `resolveSpecificMonthsStageDueDate` always stays inside the designated
        // month, so the due date's YYYY-MM IS the per-month key.
        const stageOneDue = resolveSpecificMonthsStageDueDate(template, stageOne, currentYear, month)
        const monthKey = checklistMonthKey(template.id, stageOneDue)
        if (monthKey && existingMonthKeys.has(monthKey)) continue
        // A designated month whose due date already passed is born completed
        // so the historical occurrence shows as finished; the current/future
        // month generates open exactly as before.
        const completed = stageOneDue < today
        const caseId = makeId('case')
        checklists.push(
          buildChecklistFromStage(template, stageOne, 0, stages.length, caseId, stageOneDue, completed),
        )
        if (monthKey) existingMonthKeys.add(monthKey)
        registerInstanceKey(existingKeys, template.id, stageOneDue)
        changed = true
      }
      continue
    }

    // Lead time: surface an upcoming instance up to `leadDays` BEFORE its due
    // date (so the team can start early), instead of only once it's due.
    const leadDays =
      typeof template.leadDays === 'number' && template.leadDays > 0
        ? Math.min(Math.floor(template.leadDays), 120)
        : 0
    const horizon = leadDays > 0 ? addDays(today, leadDays) : today
    let safetyCounter = 0
    while (template.nextDueDate <= horizon && safetyCounter < 60) {
      const stageOne = stages[0]
      const stageOneDue = resolveStageDueDate(stageOne, template.nextDueDate)
      // Check BOTH the cycle date and the due date we are about to write. They
      // differ as soon as stage 1 carries an `offsetDays` / `dueDayOfMonth`, and
      // checking only the cycle date meant the key set rebuilt on the next run
      // (from the stored `dueDate`) never matched — so the same period spawned
      // again. Mirrors db/store.js exactly.
      const cycleKey = checklistInstanceKey(template.id, template.nextDueDate, 0)
      const dueKey = checklistInstanceKey(template.id, stageOneDue, 0)
      const alreadyExists =
        (cycleKey !== null && existingKeys.has(cycleKey)) ||
        (dueKey !== null && existingKeys.has(dueKey))

      if (!alreadyExists) {
        const caseId = makeId('case')
        checklists.push(
          buildChecklistFromStage(
            template,
            stageOne,
            0,
            stages.length,
            caseId,
            stageOneDue,
          ),
        )
        registerInstanceKey(existingKeys, template.id, template.nextDueDate)
        registerInstanceKey(existingKeys, template.id, stageOneDue)
        changed = true
      }

      const nextDueDate = advanceChecklistFrequency(template.nextDueDate, template.frequency)
      if (nextDueDate === template.nextDueDate) {
        break
      }

      template.nextDueDate = nextDueDate
      changed = true
      safetyCounter += 1
    }
  }

  return {
    changed,
    data: {
      ...data,
      checklistTemplates: templates,
      checklists: sortChecklists(checklists),
    },
  }
}

export function formatHours(minutes: number) {
  const hours = minutes / 60
  return `${Number.isInteger(hours) ? hours.toFixed(0) : hours.toFixed(1)}h`
}

/**
 * Exact hours + minutes, e.g. 80 -> "1h 20m", 45 -> "45m", 120 -> "2h".
 * Unlike formatHours (which rounds to one decimal), this shows the precise
 * time the user logged.
 */
export function formatHoursMinutes(minutes: number) {
  // Work in whole seconds so sub-minute durations (exact-seconds timer stops)
  // read e.g. "45s" or "1m 30s" instead of being rounded away.
  const totalSeconds = Math.max(0, Math.round(minutes * 60))
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  if (h === 0 && m === 0) return `${s}s`
  // Once it's at least a minute we round to the minute (the historical display)
  // unless it's a sub-minute remainder worth showing.
  const parts: string[] = []
  if (h > 0) parts.push(`${h}h`)
  if (m > 0) parts.push(`${m}m`)
  if (h === 0 && s > 0) parts.push(`${s}s`)
  return parts.join(' ')
}

/**
 * Human-readable audit timestamp for an exact start/stop, e.g. "Jun 3, 9:15 AM".
 * Renders in the viewer's local timezone. Returns '' for missing/invalid input.
 */
export function formatAuditStamp(iso?: string) {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

/**
 * The clock-in/clock-out spans for an entry. Prefers the `sessions` array;
 * falls back to the single `startAt`/`endAt` envelope so TIMER and legacy
 * entries (logged before the sessions model) still report their in/out times.
 * Returns [] only when an entry genuinely has no timestamps (minutes-only).
 * Used by the time list, both approval surfaces, and the raw-hours export so
 * they can't drift apart.
 */
export function effectiveSessions(entry: {
  sessions?: WorkSession[]
  startAt?: string
  endAt?: string
}): WorkSession[] {
  if (entry.sessions && entry.sessions.length > 0) return entry.sessions
  if (entry.startAt && entry.endAt) return [{ startAt: entry.startAt, endAt: entry.endAt }]
  return []
}

/** Whole minutes in a single session (rounded, never negative). */
export function sessionMinutes(session: WorkSession): number {
  const startMs = new Date(session.startAt).getTime()
  const endMs = new Date(session.endAt).getTime()
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) return 0
  // Seconds-precise (fractional minutes) so sub-minute spans aren't lost.
  return Math.round((endMs - startMs) / 1000) / 60
}

/** Total minutes across all sessions. */
export function sessionsTotalMinutes(sessions: WorkSession[]): number {
  return sessions.reduce((sum, session) => sum + sessionMinutes(session), 0)
}

/** First start / last stop across sessions (chronological), or undefined. */
export function sessionsEnvelope(sessions: WorkSession[]): {
  startAt?: string
  endAt?: string
} {
  const valid = sessions.filter(
    (s) => !Number.isNaN(new Date(s.startAt).getTime()) && !Number.isNaN(new Date(s.endAt).getTime()),
  )
  if (valid.length === 0) return {}
  const starts = valid.map((s) => new Date(s.startAt).getTime())
  const ends = valid.map((s) => new Date(s.endAt).getTime())
  return {
    startAt: new Date(Math.min(...starts)).toISOString(),
    endAt: new Date(Math.max(...ends)).toISOString(),
  }
}

export function formatTimeFromMs(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

export function employeeName(employees: Employee[], employeeId: string) {
  return employees.find((employee) => employee.id === employeeId)?.name ?? 'Unassigned'
}

export function clientName(clients: Client[], clientId: string) {
  return clients.find((client) => client.id === clientId)?.name ?? 'Unknown client'
}

/**
 * The email to use for a contact ON a specific client. A `companyEmails`
 * override for that `clientId` (with a non-empty value) wins; otherwise the
 * contact's base `email`. Returns '' when neither is set. Pure — unit-tested.
 */
export function emailForClient(
  contact: Pick<Contact, 'email' | 'companyEmails'>,
  clientId: string,
): string {
  const override = (contact.companyEmails ?? []).find((entry) => entry.clientId === clientId)
  const overrideEmail = override?.email?.trim()
  if (overrideEmail) return overrideEmail
  return (contact.email ?? '').trim()
}

/**
 * Contacts that are "unlinked" — not referenced by any client's `contactIds`
 * and not archived. These are surfaced on the Contacts page so the owner can
 * spot a contact that was added but never attached to a company. Pure —
 * unit-tested.
 */
export function unlinkedContacts(contacts: Contact[], clients: Client[]): Contact[] {
  const linkedIds = new Set<string>()
  for (const client of clients) {
    for (const id of client.contactIds ?? []) {
      linkedIds.add(id)
    }
  }
  return contacts.filter((contact) => !contact.archivedAt && !linkedIds.has(contact.id))
}

/**
 * The distinct, trimmed group names already in use across `contacts`, sorted
 * alphabetically (case-insensitive). Powers the Group input's <datalist> so the
 * owner can pick an existing group or type a new one. Pure — unit-tested.
 */
export function distinctGroupNames(contacts: Contact[]): string[] {
  const seen = new Map<string, string>()
  for (const contact of contacts) {
    const name = (contact.group ?? '').trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (!seen.has(key)) seen.set(key, name)
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
}

/** One group section produced by {@link groupContacts}. */
export type ContactGroupSection = {
  /** Display name of the group, or 'Ungrouped' for the no-group bucket. */
  group: string
  /** Whether this is the synthetic "Ungrouped" bucket (always sorted last). */
  ungrouped: boolean
  /** Members of this group, sorted by name. */
  contacts: Contact[]
}

/**
 * Partition `contacts` into named-group sections for the "Group by group" view.
 * Groups are sorted alphabetically (case-insensitive); members within a group
 * are sorted by name. Contacts with no (or blank) group land in a single
 * "Ungrouped" section appended last. Pure — unit-tested. The caller is expected
 * to pass the already-filtered (search + unlinked) list.
 */
export function groupContacts(contacts: Contact[]): ContactGroupSection[] {
  const byKey = new Map<string, { group: string; contacts: Contact[] }>()
  const ungrouped: Contact[] = []
  for (const contact of contacts) {
    const name = (contact.group ?? '').trim()
    if (!name) {
      ungrouped.push(contact)
      continue
    }
    const key = name.toLowerCase()
    const bucket = byKey.get(key)
    if (bucket) bucket.contacts.push(contact)
    else byKey.set(key, { group: name, contacts: [contact] })
  }
  const byName = (a: Contact, b: Contact) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  const sections: ContactGroupSection[] = [...byKey.values()]
    .sort((a, b) => a.group.localeCompare(b.group, undefined, { sensitivity: 'base' }))
    .map((bucket) => ({
      group: bucket.group,
      ungrouped: false,
      contacts: [...bucket.contacts].sort(byName),
    }))
  if (ungrouped.length > 0) {
    sections.push({
      group: 'Ungrouped',
      ungrouped: true,
      contacts: [...ungrouped].sort(byName),
    })
  }
  return sections
}

/**
 * True when a recurring reimbursement should appear on the invoice for
 * `billingPeriod` ('YYYY-MM'). Cadence logic:
 *  - Skip if `startDate` is after the billing period (the recurring
 *    hasn't started yet).
 *  - `monthly`: hits every month from start.
 *  - `quarterly`: every 3 months from start (Jan-anchor → Jan/Apr/Jul/Oct).
 *  - `annually`: same calendar month each year (Mar-anchor → every Mar).
 * Stop the line by deleting the row.
 */
export function recurringReimbursementAppliesToPeriod(
  recurring: RecurringReimbursement,
  billingPeriod: string,
): boolean {
  if (typeof billingPeriod !== 'string' || !/^\d{4}-\d{2}$/.test(billingPeriod)) return false
  if (typeof recurring.startDate !== 'string' || recurring.startDate.length < 7) return false
  const periodYear = Number(billingPeriod.slice(0, 4))
  const periodMonth = Number(billingPeriod.slice(5, 7))
  const startYear = Number(recurring.startDate.slice(0, 4))
  const startMonth = Number(recurring.startDate.slice(5, 7))
  if (
    !Number.isFinite(periodYear) ||
    !Number.isFinite(periodMonth) ||
    !Number.isFinite(startYear) ||
    !Number.isFinite(startMonth)
  ) {
    return false
  }
  const periodKey = periodYear * 12 + periodMonth
  const startKey = startYear * 12 + startMonth
  if (periodKey < startKey) return false
  const monthsSinceStart = periodKey - startKey
  if (recurring.frequency === 'monthly') return true
  if (recurring.frequency === 'quarterly') return monthsSinceStart % 3 === 0
  if (recurring.frequency === 'annually') return monthsSinceStart % 12 === 0
  return false
}

/**
 * Build an Invoice for a single client + billing period. `reimbursements`
 * is optional for backward compatibility — when present, every entry that
 * matches this client AND falls inside the billing period is appended as
 * its own invoice line ("Reimb: <description>") and added to the total.
 * Each shows the date and the dollar amount the owner recorded.
 *
 * `recurringReimbursements` is similar but synthesized: any entry whose
 * cadence (see `recurringReimbursementAppliesToPeriod`) lands on this
 * billing period becomes a "Recurring: <description>" line. No row is
 * stored per period; the line is derived at read time. Owner stops it
 * by deleting the recurring record.
 */
/**
 * Hourly billing cutover (YYYY-MM, inclusive). Billing periods on/after this
 * month bill hourly clients at each EMPLOYEE's bill rate; earlier months keep
 * the LEGACY per-CLIENT hourly rate so already-sent historical invoices stay
 * byte-for-byte exact (accounting firm — historical numbers must not change).
 * June 2026 is the first month invoiced under the new per-employee model.
 */
export const PER_EMPLOYEE_BILLING_START = SHARED_CUTOVER

export function getInvoice(
  client: Client,
  entries: TimeEntry[],
  plans: SubscriptionPlan[],
  billingPeriod: string,
  reimbursements: Reimbursement[] = [],
  recurringReimbursements: RecurringReimbursement[] = [],
  employees: Employee[] = [],
  defaultHourlyRate = 0,
): Invoice {
  // Thin wrapper. The lines themselves are built by the SHARED builder in
  // `lib/invoice-lines.js`, which the server-side draft generator and Client
  // Recap also call — so what the UI shows, what gets invoiced, and what the
  // profit figure is measured against can no longer drift apart.
  const built = buildInvoiceLines({
    client,
    entries,
    plans,
    billingPeriod,
    reimbursements,
    recurringReimbursements,
    employees,
    defaultHourlyRate,
  })
  return {
    client,
    plan: built.plan as SubscriptionPlan | null,
    billableMinutes: built.billableMinutes,
    entryCount: built.entryCount,
    period: billingPeriod,
    periodLabel: built.periodLabel,
    lines: built.lines,
    total: built.total,
  }
}

export function relativeTime(value: string | null | undefined): string {
  if (!value) {
    return 'Never'
  }
  const then = new Date(value).getTime()
  if (Number.isNaN(then)) {
    return 'Never'
  }
  const diffSeconds = Math.round((Date.now() - then) / 1000)
  if (diffSeconds < 0) {
    return 'just now'
  }
  if (diffSeconds < 45) {
    return 'just now'
  }
  if (diffSeconds < 90) {
    return '1 minute ago'
  }
  const diffMinutes = Math.round(diffSeconds / 60)
  if (diffMinutes < 45) {
    return `${diffMinutes} minutes ago`
  }
  if (diffMinutes < 90) {
    return '1 hour ago'
  }
  const diffHours = Math.round(diffMinutes / 60)
  if (diffHours < 24) {
    return `${diffHours} hours ago`
  }
  if (diffHours < 36) {
    return '1 day ago'
  }
  const diffDays = Math.round(diffHours / 24)
  if (diffDays < 30) {
    return `${diffDays} days ago`
  }
  const diffMonths = Math.round(diffDays / 30)
  if (diffMonths < 12) {
    return `${diffMonths} months ago`
  }
  const diffYears = Math.round(diffMonths / 12)
  return `${diffYears} years ago`
}

export function formatActivityTimestamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

export function describeActivityAction(action: string): string {
  switch (action) {
    case 'login_password':
      return 'logged in with password'
    case 'login_via_magic_link':
      return 'logged in via magic link'
    case 'login_via_email_link':
      return 'signed in via email link'
    case 'login_link_requested':
      return 'requested a sign-in link for'
    case 'signed_out':
      return 'signed out'
    case 'session_revoked':
      return 'revoked a session for'
    case 'team_link_resent':
      return 'resent sign-in link to'
    case 'checklist_item_checked':
      return 'checked off'
    case 'checklist_item_unchecked':
      return 'unchecked'
    case 'checklist_created':
      return 'created checklist'
    case 'template_viewers_updated':
      return 'updated template viewers'
    case 'team_invited':
      return 'invited'
    case 'team_revoked':
      return 'revoked link for'
    case 'team_link_regenerated':
      return 'regenerated link for'
    case 'team_link_restored':
      return 'restored access for'
    case 'team_removed':
      return 'removed'
    case 'client_profile_updated':
      return 'updated client profile'
    case 'client_team_updated':
      return 'updated client assigned team'
    case 'client_marked_inactive':
      return 'marked inactive'
    case 'client_reactivated':
      return 'reactivated'
    case 'case_started':
      return 'started case'
    case 'case_advanced':
      return 'advanced case'
    case 'case_completed':
      return 'completed case'
    case 'template_stage_added':
      return 'added template stage'
    case 'template_stage_removed':
      return 'removed template stage'
    case 'template_stage_edited':
      return 'edited template stage'
    case 'template_stages_reordered':
      return 'reordered template stages'
    case 'standard_template_created':
      return 'created standard template'
    case 'template_applied_to_client':
      return 'applied template to client'
    case 'template_copied_to_client':
      return 'copied template to client'
    case 'totp_enabled':
      return 'enabled two-factor authentication'
    case 'totp_disabled':
      return 'disabled two-factor authentication'
    case 'totp_backup_codes_regenerated':
      return 'regenerated backup codes for'
    case 'totp_used_backup_code':
      return 'used a backup code'
    case 'totp_reset_by_admin':
      return 'reset two-factor for'
    default:
      return action.replace(/_/g, ' ')
  }
}

export function lastDayOfCurrentMonth() {
  const date = new Date()
  const last = new Date(date.getFullYear(), date.getMonth() + 1, 0)
  return last.toISOString().slice(0, 10)
}

/**
 * True only for absolute http(s) URLs. Used to gate user-supplied URLs before
 * rendering them as a live link (an `<a href>`), so a `javascript:` / `data:`
 * URL can never execute in the viewer's session.
 */
export function isSafeHttpUrl(value: string | null | undefined): boolean {
  if (!value) return false
  try {
    const u = new URL(value)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * True for image sources we're willing to put in an `<img src>`: inline
 * `data:image/...` (our firm-logo uploads) or an absolute http(s) URL.
 * Anything else (e.g. `javascript:`) is rejected.
 */
export function isSafeImageSrc(value: string | null | undefined): boolean {
  if (!value) return false
  if (value.startsWith('data:image/')) return true
  return isSafeHttpUrl(value)
}

/**
 * Parse a CSS hex color (#abc or #aabbcc) into RGB. Returns null for
 * anything else (named colors, rgb(), invalid input) — callers should
 * treat null as "can't reason about this color, leave it alone".
 */
function parseHexColor(value: string): { r: number; g: number; b: number } | null {
  const hex = value.trim().replace(/^#/, '')
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  }
}

/** WCAG relative luminance (0 = black, 1 = white). */
function relativeLuminance(rgb: { r: number; g: number; b: number }): number {
  const lin = (channel: number) => {
    const s = channel / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b)
}

/**
 * WCAG contrast ratio between two hex colors (1–21), or null if either
 * color isn't a parseable hex value.
 */
export function contrastRatio(a: string, b: string): number | null {
  const ca = parseHexColor(a)
  const cb = parseHexColor(b)
  if (!ca || !cb) return null
  const la = relativeLuminance(ca)
  const lb = relativeLuminance(cb)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * Contrast guard for the customizable sidebar colors: keep the user's
 * preferred text color whenever it's at least readable (3:1, the WCAG
 * large-text floor) against the sidebar background; otherwise swap in
 * whichever of warm-white / near-black reads better on that background.
 * Non-hex values pass through untouched — we can't score them.
 */
export function legibleSidebarText(preferred: string, background: string): string {
  const ratio = contrastRatio(preferred, background)
  if (ratio === null || ratio >= 3) return preferred
  const light = '#fffaf3'
  const dark = '#25131e'
  return (contrastRatio(light, background) ?? 0) >= (contrastRatio(dark, background) ?? 0)
    ? light
    : dark
}
