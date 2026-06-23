import type {
  AppData,
  Checklist,
  ChecklistFrequency,
  ChecklistTemplate,
  Client,
  Contact,
  Employee,
  Invoice,
  InvoiceLine,
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
 */
export type GroupAllocationMode = 'even' | 'full' | 'custom'

/**
 * Allocate `totalMinutes` of work across `clientIds` per the chosen mode and
 * return a map of clientId → minutes. Pure + deterministic so it can be unit
 * tested independently of the form.
 *
 * - `even`: integer minutes that sum to EXACTLY `totalMinutes` (the remainder
 *   is handed out one minute at a time to the first clients).
 * - `full`: every client gets `totalMinutes`.
 * - `custom`: each client gets its own `custom[clientId]` value (rounded; a
 *   missing / non-positive value becomes 0). The parts are NOT forced to sum to
 *   `totalMinutes` — the owner has full control.
 *
 * Duplicate / empty ids are ignored. Callers decide whether to drop 0-minute
 * clients before persisting.
 */
export function allocateGroupMinutes(
  totalMinutes: number,
  clientIds: string[],
  mode: GroupAllocationMode,
  custom: Record<string, number> = {},
): Record<string, number> {
  const ids = clientIds.filter((id, index) => Boolean(id) && clientIds.indexOf(id) === index)
  const result: Record<string, number> = {}
  if (ids.length === 0) return result

  if (mode === 'full') {
    const each = Math.max(0, Math.round(totalMinutes))
    for (const id of ids) result[id] = each
    return result
  }

  if (mode === 'custom') {
    for (const id of ids) {
      const value = Number(custom[id])
      result[id] = Number.isFinite(value) && value > 0 ? Math.round(value) : 0
    }
    return result
  }

  // even — distribute the remainder so the parts sum to exactly totalMinutes.
  const total = Math.max(0, Math.round(totalMinutes))
  const base = Math.floor(total / ids.length)
  let remainder = total - base * ids.length
  for (const id of ids) {
    result[id] = base + (remainder > 0 ? 1 : 0)
    if (remainder > 0) remainder -= 1
  }
  return result
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
  const today = new Date().toISOString().slice(0, 10)
  const existingKeys = new Set(
    checklistsBackfilled
      .filter((checklist) => checklist.templateId)
      .map((checklist) => `${checklist.templateId}:${checklist.dueDate}:${checklist.stageIndex ?? 0}`),
  )
  const checklists = [...checklistsBackfilled]

  // Year-month instance keys (`${templateId}:${YYYY-MM}`) for specific-months
  // templates. Derived from each existing checklist's due date so re-running
  // materialization never double-generates a designated month.
  const existingMonthKeys = new Set(
    checklistsBackfilled
      .filter((checklist) => checklist.templateId && checklist.dueDate)
      .map((checklist) => `${checklist.templateId}:${checklist.dueDate.slice(0, 7)}`),
  )

  const todayDate = new Date()
  const currentYear = todayDate.getFullYear()

  for (const template of templates) {
    const stages = template.stages ?? []
    // Standard templates are blueprints only — they never materialize.
    if (template.isStandard || !template.active || stages.length === 0 || stages[0].items.length === 0) {
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
        const monthKey = `${template.id}:${currentYear}-${String(month).padStart(2, '0')}`
        if (existingMonthKeys.has(monthKey)) continue
        const stageOne = stages[0]
        const stageOneDue = resolveSpecificMonthsDueDate(template, currentYear, month)
        // A designated month whose due date already passed is born completed
        // so the historical occurrence shows as finished; the current/future
        // month generates open exactly as before.
        const completed = stageOneDue < today
        const caseId = makeId('case')
        checklists.push(
          buildChecklistFromStage(template, stageOne, 0, stages.length, caseId, stageOneDue, completed),
        )
        existingMonthKeys.add(monthKey)
        existingKeys.add(`${template.id}:${stageOneDue}:0`)
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
      const instanceKey = `${template.id}:${template.nextDueDate}:0`
      if (!existingKeys.has(instanceKey)) {
        const stageOne = stages[0]
        const stageOneDue = resolveStageDueDate(stageOne, template.nextDueDate)
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
        existingKeys.add(instanceKey)
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
export const PER_EMPLOYEE_BILLING_START = '2026-06'

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
  const billableEntries = entries.filter(
    (entry) =>
      entry.clientId === client.id && entry.billable && isInBillingPeriod(entry, billingPeriod),
  )
  const billableMinutes = billableEntries.reduce((total, entry) => total + entry.minutes, 0)
  // The subscribed plans/services are now just labels (no fee). Resolve the
  // names for the monthly invoice line; the amount comes from the client's
  // own `monthlyRate`. `Invoice.plan` keeps the first matched plan for
  // back-compat with callers that still read a single plan.
  const planIds = Array.isArray(client.planIds) ? client.planIds : []
  const subscribedPlans = planIds
    .map((id) => plans.find((item) => item.id === id))
    .filter((item): item is SubscriptionPlan => Boolean(item))
  const plan = subscribedPlans[0] ?? null
  const periodLabel = getBillingPeriodLabel(billingPeriod)

  // Reimbursements for THIS client and THIS billing period. Sorted by date
  // ascending so the invoice lines read chronologically.
  const clientReimbursements = reimbursements
    .filter(
      (reimbursement) =>
        reimbursement.clientId === client.id && reimbursement.date.startsWith(billingPeriod),
    )
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))

  const reimbursementLines: InvoiceLine[] = clientReimbursements.map((reimbursement) => ({
    label: `Reimbursement: ${reimbursement.description}`,
    detail: new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(`${reimbursement.date}T12:00:00`)),
    amount: reimbursement.amount,
  }))
  const reimbursementTotal = reimbursementLines.reduce((total, line) => total + line.amount, 0)

  // Recurring reimbursements that should appear on this billing period for
  // this client. Synthesized — no per-period row is stored. The detail
  // notes the cadence so the invoice reads "Recurring: Software · monthly".
  const recurringForClient = recurringReimbursements.filter(
    (recurring) =>
      recurring.clientId === client.id &&
      recurringReimbursementAppliesToPeriod(recurring, billingPeriod),
  )
  const recurringLines: InvoiceLine[] = recurringForClient.map((recurring) => ({
    label: `Recurring: ${recurring.description}`,
    detail: recurring.frequency,
    amount: recurring.amount,
  }))
  const recurringTotal = recurringLines.reduce((total, line) => total + line.amount, 0)

  if (client.billingMode === 'annual') {
    // Annual billing: a flat yearly fee billed ONCE per year, in the client's
    // chosen `annualBillingMonth`. The fee appears on the invoice only when the
    // billing period's month matches; every other month shows no subscription
    // line (just any reimbursements that happen to fall in that month).
    const annualRate =
      typeof client.annualRate === 'number' && !Number.isNaN(client.annualRate)
        ? client.annualRate
        : 0
    const billingMonth = normalizeBillingMonth(client.annualBillingMonth)
    const periodMonth = Number(billingPeriod.slice(5, 7))
    const lines: InvoiceLine[] = []
    if (periodMonth === billingMonth) {
      const serviceLabel =
        client.monthlyServiceTier && client.monthlyServiceTier.trim()
          ? client.monthlyServiceTier
          : subscribedPlans.length > 0
            ? subscribedPlans.map((item) => item.name).join(', ')
            : 'Annual service'
      lines.push({
        label: serviceLabel,
        detail: `Annual fee · billed in ${MONTH_NAMES[billingMonth]}`,
        amount: annualRate,
      })
    }

    lines.push(...reimbursementLines, ...recurringLines)

    return {
      client,
      plan,
      billableMinutes,
      entryCount: billableEntries.length,
      period: billingPeriod,
      periodLabel,
      lines,
      total: lines.reduce((total, line) => total + line.amount, 0),
    }
  }

  if (client.billingMode === 'subscription') {
    // Monthly billing: the client's own `monthlyRate` is the line amount.
    // There is NO included-hours / overage math anymore. The line is
    // labeled with the subscribed plan/service names, or "Monthly service"
    // when none are selected.
    const monthlyRate =
      typeof client.monthlyRate === 'number' && !Number.isNaN(client.monthlyRate)
        ? client.monthlyRate
        : 0
    // Prefer the explicitly-picked monthly service package (e.g. "The
    // Classic"); else fall back to the subscribed plan names; else generic.
    const serviceLabel =
      client.monthlyServiceTier && client.monthlyServiceTier.trim()
        ? client.monthlyServiceTier
        : subscribedPlans.length > 0
          ? subscribedPlans.map((item) => item.name).join(', ')
          : 'Monthly service'
    const lines: InvoiceLine[] = [
      {
        label: serviceLabel,
        detail: 'Monthly service',
        amount: monthlyRate,
      },
    ]

    lines.push(...reimbursementLines, ...recurringLines)

    return {
      client,
      plan,
      billableMinutes,
      entryCount: billableEntries.length,
      period: billingPeriod,
      periodLabel,
      lines,
      total: lines.reduce((total, line) => total + line.amount, 0),
    }
  }

  // Hourly billing has a CUTOVER (see PER_EMPLOYEE_BILLING_START).
  //  - On/after the cutover: bill each person's hours at THEIR own bill rate
  //    (set on the Team page); one line per employee. An employee with no bill
  //    rate falls back to the firm's default hourly rate.
  //  - Before the cutover: reproduce the LEGACY per-CLIENT rate exactly, so
  //    invoices already sent for past months never change. Historical numbers
  //    must stay exact for an accounting firm.
  let employeeLines: InvoiceLine[]
  let billableAmount: number
  if (billingPeriod >= PER_EMPLOYEE_BILLING_START) {
    const employeeById = new Map(employees.map((employee) => [employee.id, employee]))
    const minutesByEmployee = new Map<string, number>()
    for (const entry of billableEntries) {
      minutesByEmployee.set(
        entry.employeeId,
        (minutesByEmployee.get(entry.employeeId) ?? 0) + entry.minutes,
      )
    }

    employeeLines = Array.from(minutesByEmployee.entries())
      .map(([employeeId, minutes]) => {
        const employee = employeeById.get(employeeId)
        const rate =
          employee && typeof employee.billRate === 'number' && !Number.isNaN(employee.billRate)
            ? employee.billRate
            : defaultHourlyRate
        const amount = (minutes / 60) * rate
        const name = employee?.name ?? 'Unknown'
        return {
          label: `Billable hours — ${name}`,
          detail: `${formatHours(minutes)} at ${currency.format(rate)}/hr`,
          amount,
        }
      })
      .sort((a, b) => a.label.localeCompare(b.label))
    billableAmount = employeeLines.reduce((total, line) => total + line.amount, 0)
  } else {
    // Legacy: a single per-client "Billable hours" line at the client's own
    // stored hourly rate — the exact shape historical invoices were sent in.
    billableAmount = (billableMinutes / 60) * client.hourlyRate
    employeeLines = [
      {
        label: 'Billable hours',
        detail: `${formatHours(billableMinutes)} at ${currency.format(client.hourlyRate)}/hr`,
        amount: billableAmount,
      },
    ]
  }

  return {
    client,
    plan,
    billableMinutes,
    entryCount: billableEntries.length,
    period: billingPeriod,
    periodLabel,
    lines: [...employeeLines, ...reimbursementLines, ...recurringLines],
    total: billableAmount + reimbursementTotal + recurringTotal,
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
