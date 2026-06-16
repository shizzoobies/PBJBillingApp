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

import type { Checklist, ServiceCategory } from './types'

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

export function buildActiveBoard({
  checklists = [],
  categories = [],
  periodType = 'month',
  today,
  clientNameById = {},
}: {
  checklists?: Checklist[]
  categories?: ServiceCategory[]
  periodType?: PeriodType
  today: string
  clientNameById?: Record<string, string>
}): ActiveBoard {
  const range = boardPeriodRange(periodType, today)

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

  for (const checklist of checklists) {
    if (isChecklistComplete(checklist)) continue // completed → drops off
    if (effectiveDue(checklist) > range.end) continue // beyond the horizon
    const rawId = checklist.categoryId
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
