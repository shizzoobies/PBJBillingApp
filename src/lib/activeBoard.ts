/**
 * Pure engine for the Active Checklists board (the column-per-service view).
 *
 * Frontend-only: the board is a view over the checklists the client already
 * holds, so all logic lives here in TS (no server round-trip). Deterministic —
 * "today" is always passed in as a yyyy-mm-dd string — so it's unit-testable.
 *
 * Two product decisions encoded here (see the client's feedback / HANDOFF):
 *   1. A column shows a client only while it has at least one OPEN (not fully
 *      complete) checklist of that category — so completing a client's work
 *      drops it off the board automatically.
 *   2. The period toggle (week / month / quarter) is a *horizon*, not a strict
 *      window: a checklist shows when its effective due date is on or before the
 *      end of the selected period. That keeps overdue work visible and widens
 *      the view as you go week → month → quarter.
 */

import type { Checklist, ChecklistTemplate, ServiceCategory } from './types'

export type PeriodType = 'week' | 'month' | 'quarter'

export type DateRange = { start: string; end: string }

export type BoardClientRow = {
  clientId: string
  name: string
  checklists: Checklist[]
}

export type BoardColumn = {
  id: string
  name: string
  openClientCount: number
  clients: BoardClientRow[]
}

export type ActiveBoard = {
  range: DateRange
  columns: BoardColumn[]
}

/** Synthetic column for checklists with no (or a deleted) category. */
export const UNCATEGORIZED_ID = '__uncategorized__'
export const UNCATEGORIZED_NAME = 'Uncategorized'

/**
 * Which board column a checklist belongs in.
 *
 * An instance normally copies its template's category at generation time, but
 * instances generated BEFORE their template was categorized were stamped with
 * `categoryId: null` and stayed that way — they sat in "Uncategorized" forever
 * while the recurring checklist itself showed the right board. Falling back to
 * the template's CURRENT category fixes those on screen, and keeps fixing any
 * future instance whose template gets recategorized after the fact, without a
 * data migration.
 *
 * Precedence:
 *   1. the instance's own `categoryId` when explicitly set — a checklist the
 *      user dragged to another column must never be pulled back by its template;
 *   2. otherwise the owning template's current `categoryId`;
 *   3. otherwise Uncategorized.
 *
 * A category id that no longer exists (deleted column) falls through to
 * Uncategorized at the call site, exactly as before.
 */
export function resolveChecklistCategoryId(
  checklist: Pick<Checklist, 'categoryId' | 'templateId'>,
  templateCategoryById: Map<string, string | null | undefined>,
): string | null {
  if (checklist.categoryId) return checklist.categoryId
  if (checklist.templateId) {
    return templateCategoryById.get(checklist.templateId) ?? null
  }
  return null
}

/** `templateId -> categoryId` lookup for {@link resolveChecklistCategoryId}. */
export function buildTemplateCategoryMap(
  templates: readonly Pick<ChecklistTemplate, 'id' | 'categoryId'>[] = [],
): Map<string, string | null | undefined> {
  return new Map(templates.map((template) => [template.id, template.categoryId]))
}

const pad = (n: number) => String(n).padStart(2, '0')
const lastDayOfMonth = (year: number, month1to12: number) =>
  new Date(year, month1to12, 0).getDate()

/** Inclusive yyyy-mm-dd range for the Sun–Sat week containing `todayIso` (UTC). */
export function weekRange(todayIso: string): DateRange {
  const [y, m, d] = todayIso.split('-').map(Number)
  const base = new Date(Date.UTC(y, m - 1, d))
  const dow = base.getUTCDay() // 0=Sun … 6=Sat
  const start = new Date(base)
  start.setUTCDate(base.getUTCDate() - dow)
  const end = new Date(start)
  end.setUTCDate(start.getUTCDate() + 6)
  const iso = (dt: Date) => dt.toISOString().slice(0, 10)
  return { start: iso(start), end: iso(end) }
}

/** Inclusive { start, end } yyyy-mm-dd range for the board's period filter. */
export function boardPeriodRange(periodType: PeriodType, todayIso: string): DateRange {
  if (periodType === 'week') return weekRange(todayIso)
  const year = Number(todayIso.slice(0, 4))
  const month = Number(todayIso.slice(5, 7))
  if (periodType === 'quarter') {
    const startMonth = Math.floor((month - 1) / 3) * 3 + 1
    const endMonth = startMonth + 2
    return {
      start: `${year}-${pad(startMonth)}-01`,
      end: `${year}-${pad(endMonth)}-${pad(lastDayOfMonth(year, endMonth))}`,
    }
  }
  return {
    start: `${year}-${pad(month)}-01`,
    end: `${year}-${pad(month)}-${pad(lastDayOfMonth(year, month))}`,
  }
}

/** Fully complete = has items and every item is done. Empty = not complete. */
export function isChecklistComplete(checklist: Checklist): boolean {
  const items = checklist.items ?? []
  if (items.length === 0) return false
  return items.every((item) => item.done)
}

/**
 * The date a checklist is bucketed by — the soonest of its overall due date and
 * any still-incomplete item's due date.
 */
export function effectiveDue(checklist: Checklist): string {
  let due = checklist.dueDate
  for (const item of checklist.items ?? []) {
    if (!item.done && item.dueDate && item.dueDate < due) {
      due = item.dueDate
    }
  }
  return due
}

/**
 * Quick-glance status for a board checklist: is it still DUE (actionable, incl.
 * overdue) or PENDING (blocked — at least one open step is flagged waiting)?
 * Mirrors the Delayed page's definition of blocked: a legacy `waiting` flag or
 * any unresolved structured `waitingOns` entry, at any depth (step, sub-step,
 * sub-sub-step). `reasons` collects the human "why" strings — the free-text
 * waiting note first, else the structured blocker's note or name (resolved via
 * `employeeNameById` when provided).
 */
export type BoardChecklistStatus =
  | { kind: 'pending'; reasons: string[]; waitingCount: number }
  | { kind: 'overdue'; due: string }
  | { kind: 'due'; due: string }

export function boardChecklistStatus(
  checklist: Checklist,
  today: string,
  employeeNameById: Record<string, string> = {},
): BoardChecklistStatus {
  const reasons: string[] = []
  let waitingCount = 0

  const nameOf = (id: string) => employeeNameById[id] ?? 'a teammate'
  const addWaiting = (
    waiting: boolean | undefined,
    waitingOn: string | undefined,
    waitingOns: { blockerId: string; note?: string }[] | undefined,
  ) => {
    const structured = waitingOns ?? []
    if (!waiting && structured.length === 0) return
    waitingCount += 1
    const reason =
      (waitingOn ?? '').trim() ||
      (structured[0] ? (structured[0].note ?? '').trim() || `waiting on ${nameOf(structured[0].blockerId)}` : '') ||
      'waiting'
    reasons.push(reason)
  }

  for (const item of checklist.items ?? []) {
    if (item.done) continue
    addWaiting(item.waiting, item.waitingOn, item.waitingOns)
    for (const sub of item.subItems ?? []) {
      if (sub.done) continue
      addWaiting(sub.waiting, sub.waitingOn, sub.waitingOns)
      for (const subSub of sub.subItems ?? []) {
        if (subSub.done) continue
        addWaiting(undefined, undefined, subSub.waitingOns)
      }
    }
  }

  if (waitingCount > 0) return { kind: 'pending', reasons, waitingCount }
  const due = effectiveDue(checklist)
  return due < today ? { kind: 'overdue', due } : { kind: 'due', due }
}

export function buildActiveBoard({
  checklists = [],
  categories = [],
  templates = [],
  periodType = 'month',
  horizonEnd,
  today,
  clientNameById = {},
}: {
  checklists?: Checklist[]
  categories?: ServiceCategory[]
  /**
   * The workspace's checklist templates — used only to recover the board column
   * for instances generated before their template was categorized. Optional so
   * existing callers/tests keep working (they just get no fallback).
   */
  templates?: Pick<ChecklistTemplate, 'id' | 'categoryId'>[]
  periodType?: PeriodType
  /**
   * Explicit horizon end ('YYYY-MM-DD') for the shared Report-period control.
   * When provided it supersedes `periodType` — the board shows every open
   * checklist whose effective due date is on or before this date (overdue work
   * stays visible). `periodType` remains for legacy / test callers.
   */
  horizonEnd?: string
  today: string
  clientNameById?: Record<string, string>
}): ActiveBoard {
  const range = horizonEnd
    ? { start: today, end: horizonEnd }
    : boardPeriodRange(periodType, today)

  const orderedCategories = [...categories].sort(
    (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name),
  )
  const knownIds = new Set(orderedCategories.map((category) => category.id))

  // categoryId -> Map<clientId, checklist[]>
  const byCategory = new Map<string, Map<string, Checklist[]>>()
  const ensure = (categoryId: string) => {
    let map = byCategory.get(categoryId)
    if (!map) {
      map = new Map()
      byCategory.set(categoryId, map)
    }
    return map
  }

  const templateCategoryById = buildTemplateCategoryMap(templates)

  for (const checklist of checklists) {
    if (isChecklistComplete(checklist)) continue // completed → drops off
    if (effectiveDue(checklist) > range.end) continue // beyond the horizon
    const rawId = resolveChecklistCategoryId(checklist, templateCategoryById)
    const columnId = rawId && knownIds.has(rawId) ? rawId : UNCATEGORIZED_ID
    const clientsForColumn = ensure(columnId)
    const list = clientsForColumn.get(checklist.clientId) ?? []
    list.push(checklist)
    clientsForColumn.set(checklist.clientId, list)
  }

  const toClientRows = (clientsMap: Map<string, Checklist[]>): BoardClientRow[] =>
    [...clientsMap.entries()]
      .map(([clientId, list]) => ({
        clientId,
        name: clientNameById[clientId] ?? clientId,
        checklists: [...list].sort((a, b) => effectiveDue(a).localeCompare(effectiveDue(b))),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))

  const columns: BoardColumn[] = orderedCategories.map((category) => {
    const clients = toClientRows(byCategory.get(category.id) ?? new Map())
    return { id: category.id, name: category.name, openClientCount: clients.length, clients }
  })

  const uncategorized = byCategory.get(UNCATEGORIZED_ID)
  if (uncategorized && uncategorized.size > 0) {
    const clients = toClientRows(uncategorized)
    columns.push({
      id: UNCATEGORIZED_ID,
      name: UNCATEGORIZED_NAME,
      openClientCount: clients.length,
      clients,
    })
  }

  return { range, columns }
}
