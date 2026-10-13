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

import { isWaitingOnOpen, type WaitingOnLike } from '../../lib/waiting-on-state.js'
import { isChecklistItemDone, stageNameFor, stepIsWaiting } from './utils'
import type { Checklist, ChecklistTemplate, ServiceCategory, TemplateStage } from './types'

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
 *      user dragged to another column must never be pulled back by its template
 *      (and a task generated before its step had a column keeps the one it got);
 *   2. otherwise its step's current `categoryId` (`checklist.stageId` against
 *      the template's stages; featreq-3e81b386, the column is set per step);
 *   3. otherwise the owning template's current `categoryId`;
 *   4. otherwise Uncategorized.
 *
 * A category id that no longer exists (deleted column) falls through to
 * Uncategorized at the call site, exactly as before.
 */
export function resolveChecklistCategoryId(
  checklist: Pick<Checklist, 'categoryId' | 'templateId'> & { stageId?: string },
  templateCategoryById: Map<string, string | null | undefined>,
  stageCategoryByTemplate: StageCategoryMap = new Map(),
): string | null {
  if (checklist.categoryId) return checklist.categoryId
  if (checklist.templateId) {
    const stageCategory = checklist.stageId
      ? stageCategoryByTemplate.get(checklist.templateId)?.get(checklist.stageId)
      : undefined
    if (stageCategory) return stageCategory
    return templateCategoryById.get(checklist.templateId) ?? null
  }
  return null
}

/** The template shape the Board's column lookups read. */
export type BoardTemplate = Pick<ChecklistTemplate, 'id' | 'categoryId'> & {
  stages?: readonly Pick<TemplateStage, 'id' | 'categoryId'>[]
}

/** `templateId -> stageId -> categoryId`, only for steps that name a column. */
export type StageCategoryMap = Map<string, Map<string, string>>

/** `templateId -> categoryId` lookup for {@link resolveChecklistCategoryId}. */
export function buildTemplateCategoryMap(
  templates: readonly BoardTemplate[] = [],
): Map<string, string | null | undefined> {
  return new Map(templates.map((template) => [template.id, template.categoryId]))
}

/** The per-step half of the lookup for {@link resolveChecklistCategoryId}. */
export function buildStageCategoryMap(templates: readonly BoardTemplate[] = []): StageCategoryMap {
  const byTemplate: StageCategoryMap = new Map()
  for (const template of templates) {
    const stages = new Map<string, string>()
    for (const stage of template.stages ?? []) {
      if (stage?.categoryId) stages.set(stage.id, stage.categoryId)
    }
    if (stages.size > 0) byTemplate.set(template.id, stages)
  }
  return byTemplate
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
 * any structured `waitingOns` entry that is not yet verified, at any depth
 * (step, sub-step, sub-sub-step). A wait the other person has marked done but
 * the requester has not yet approved is still unverified, so it still holds the
 * chip on Pending. `reasons` collects the human "why" strings — the free-text
 * waiting note first, else the structured blocker's note or name (resolved via
 * `employeeNameById` when provided).
 */
export type BoardChecklistStatus =
  | { kind: 'pending'; reasons: string[]; waitingCount: number }
  | { kind: 'overdue'; due: string }
  | { kind: 'due'; due: string }

type WaitingNode = {
  waiting?: boolean
  waitingOn?: string
  waitingOns?: (WaitingOnLike & { blockerId: string; note?: string })[]
}

/**
 * The human "why" for one waiting step, or null when the step is not waiting.
 * `stepIsWaiting` is the one definition of "waiting": a verified entry is a
 * closed-out record, not a block, so it must not read as waiting. Precedence:
 * the free-text waiting note, else the first open structured blocker's note,
 * else "waiting on <name>", else plain "waiting".
 */
function waitingReasonFor(node: WaitingNode, employeeNameById: Record<string, string>): string | null {
  if (!stepIsWaiting({ waiting: node.waiting, waitingOns: node.waitingOns })) return null
  const nameOf = (id: string) => employeeNameById[id] ?? 'a teammate'
  const structured = (node.waitingOns ?? []).filter(isWaitingOnOpen)
  return (
    (node.waitingOn ?? '').trim() ||
    (structured[0] ? (structured[0].note ?? '').trim() || `waiting on ${nameOf(structured[0].blockerId)}` : '') ||
    'waiting'
  )
}

export function boardChecklistStatus(
  checklist: Checklist,
  today: string,
  employeeNameById: Record<string, string> = {},
): BoardChecklistStatus {
  const reasons: string[] = []
  let waitingCount = 0

  const addWaiting = (
    waiting: boolean | undefined,
    waitingOn: string | undefined,
    waitingOns: WaitingNode['waitingOns'],
  ) => {
    const reason = waitingReasonFor({ waiting, waitingOn, waitingOns }, employeeNameById)
    if (reason === null) return
    waitingCount += 1
    reasons.push(reason)
  }

  // "Open" is the roll-up reading (`isChecklistItemDone`), the same rule the
  // Waiting count, the checkbox guard and the Delayed page use, never the stored
  // flag: a step whose stored flag lags its sub-steps must not read differently here.
  for (const item of checklist.items ?? []) {
    if (isChecklistItemDone(item)) continue
    addWaiting(item.waiting, item.waitingOn, item.waitingOns)
    for (const sub of item.subItems ?? []) {
      if (isChecklistItemDone(sub)) continue
      addWaiting(sub.waiting, sub.waitingOn, sub.waitingOns)
      for (const subSub of sub.subItems ?? []) {
        if (isChecklistItemDone(subSub)) continue
        addWaiting(undefined, undefined, subSub.waitingOns)
      }
    }
  }

  if (waitingCount > 0) return { kind: 'pending', reasons, waitingCount }
  const due = effectiveDue(checklist)
  return due < today ? { kind: 'overdue', due } : { kind: 'due', due }
}

/**
 * Where one checklist is, for the Board's "Current step only" view: the STEP
 * (the stage) it is on, never its tasks.
 */
export type BoardStepSummary = {
  /** Staged (stageCount >= 2): "Step N of M - <stage name>"; otherwise the checklist's own title. */
  stepLabel: string
  /** Staged with a later stage: "Then: Step N+1 - <next stage name>"; otherwise null. */
  nextStepLabel: string | null
  /** Top-level items (the step's tasks). */
  taskCount: number
  /** Top-level items that read done by the roll-up (`isChecklistItemDone`). */
  taskDoneCount: number
  /** The checklist's due date; the status chip already shows due / overdue / waiting. */
  dueDate: string | null
  /** Who the checklist is for; null when unknown. */
  assigneeName: string | null
}

/**
 * The Board's "Current step only" reading of a checklist (featreq-338b1507:
 * "see what step we are on for each client"). Brittany's follow-up: "I consider
 * the main a step. And the items under it the task for that step. The
 * open/unlocked step should show on the board not the task." A staged case
 * materializes one checklist per stage, so the checklist on the board IS the
 * open step and its items are that step's tasks: the summary names the step and
 * counts the tasks, and lists none of them. "Done" is the roll-up
 * (`isChecklistItemDone`), the rule the Waiting count and the card use.
 */
export function boardStepSummary(
  checklist: Checklist,
  templates: readonly ChecklistTemplate[],
  employeeNameById: Record<string, string> = {},
): BoardStepSummary {
  const items = checklist.items ?? []

  let stepLabel = checklist.title
  let nextStepLabel: string | null = null
  const stageIndex = checklist.stageIndex
  const stageCount = checklist.stageCount ?? 0
  // A one-stage recipe is not a staged case: "Step 1 of 1" would be noise. A
  // stage whose template (or name) is gone reads as the checklist's own title.
  const stageName =
    stageCount >= 2 && typeof stageIndex === 'number' && stageIndex >= 0 && stageIndex < stageCount
      ? stageNameFor(templates as ChecklistTemplate[], checklist)
      : undefined
  if (stageName && typeof stageIndex === 'number') {
    stepLabel = `Step ${stageIndex + 1} of ${stageCount} - ${stageName}`
    const stages = templates.find((template) => template.id === checklist.templateId)?.stages ?? []
    // Gated on the STORED count too: a template that gained a stage after this
    // case materialized must not read "Step 3 of 3" then "Then: Step 4".
    const next = stageIndex + 1 < stageCount ? stages[stageIndex + 1] : undefined
    if (next) {
      const nextName = next.name?.trim()
      nextStepLabel = `Then: Step ${stageIndex + 2}${nextName ? ` - ${nextName}` : ''}`
    }
  }

  return {
    stepLabel,
    nextStepLabel,
    taskCount: items.length,
    taskDoneCount: items.filter((item) => isChecklistItemDone(item)).length,
    dueDate: checklist.dueDate ?? null,
    assigneeName: checklist.assigneeId ? (employeeNameById[checklist.assigneeId] ?? null) : null,
  }
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
  /** The columns; a column's group plays no part in what lands in it. */
  categories?: Pick<ServiceCategory, 'id' | 'name' | 'sortOrder'>[]
  /**
   * The workspace's checklist templates — used only to recover the board column
   * for instances generated before their template was categorized. Optional so
   * existing callers/tests keep working (they just get no fallback). Their
   * steps' columns come first (a task with none goes to its step's column).
   */
  templates?: BoardTemplate[]
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
  const stageCategoryByTemplate = buildStageCategoryMap(templates)

  for (const checklist of checklists) {
    if (isChecklistComplete(checklist)) continue // completed → drops off
    if (effectiveDue(checklist) > range.end) continue // beyond the horizon
    const rawId = resolveChecklistCategoryId(checklist, templateCategoryById, stageCategoryByTemplate)
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

/** One group of Board columns (featreq-54bf39b6). */
export type BoardGroup = {
  /** The columns' shared group name; null = columns with no group ("Other"). */
  name: string | null
  /** In board order. */
  columns: BoardColumn[]
  /** DISTINCT clients across its columns' `clients` (one client in two columns counts once). */
  openClientCount: number
}

/**
 * Fold the board's columns into their groups. Group order is the order each
 * group first appears walking `columns`; a column whose category has no group
 * (or isn't a known category - the synthetic Uncategorized column) goes in the
 * null group, which is always LAST. Pure: no filtering - an empty column stays
 * in its group and a group of empty columns counts 0.
 */
export function groupBoardColumns(
  columns: readonly BoardColumn[],
  categories: readonly Pick<ServiceCategory, 'id' | 'groupName'>[],
): BoardGroup[] {
  const groupNameById = new Map<string, string>()
  for (const category of categories) {
    const name = category.groupName?.trim()
    if (name) groupNameById.set(category.id, name)
  }
  const named = new Map<string, BoardColumn[]>()
  const ungrouped: BoardColumn[] = []
  for (const col of columns) {
    const name = groupNameById.get(col.id)
    if (!name) {
      ungrouped.push(col)
      continue
    }
    const list = named.get(name) ?? []
    list.push(col)
    named.set(name, list)
  }
  const toGroup = (name: string | null, groupColumns: BoardColumn[]): BoardGroup => ({
    name,
    columns: groupColumns,
    openClientCount: new Set(
      groupColumns.flatMap((col) => col.clients.map((clientRow) => clientRow.clientId)),
    ).size,
  })
  const groups = [...named.entries()].map(([name, groupColumns]) => toGroup(name, groupColumns))
  if (ungrouped.length > 0) groups.push(toGroup(null, ungrouped))
  return groups
}
