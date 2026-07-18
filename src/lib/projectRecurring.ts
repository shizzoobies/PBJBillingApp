/**
 * Pure, read-only PROJECTION of upcoming (not-yet-materialized) recurring
 * checklist occurrences — the "ghost" overlay for the Board and Gantt.
 *
 * This module NEVER generates, materializes, or persists anything. It is the
 * read-only alternative to the Time dropdown's "get ahead" (which actually
 * creates real instances). It synthesizes throwaway `Checklist` objects flagged
 * `projected: true`, with a stable id `projected:<templateId>:<dueDate>`, and
 * returns them so the page layer can concat them into the list it hands to
 * `buildActiveBoard` / the Gantt render. The ghosts must never enter context
 * `data` / `visibleChecklists`, autosave, or any endpoint.
 *
 * It deliberately mirrors how real generation (`ensureRecurringChecklists` in
 * `./utils.ts`) picks dates and builds a stage-1 instance — same
 * `advanceChecklistFrequency` cadence walk (incl. biweekly), same
 * specific-months handling via `resolveSpecificMonthsDueDate`, same stage/node
 * due-date resolution — so a projected ghost lines up exactly with the real
 * instance it will become. Because the materializer already creates everything
 * due-by-today, this only emits occurrences STRICTLY in the future
 * (`dueDate > fromDateOnly`), and additionally dedupes against any existing
 * real OR recycled instance (key `templateId + dueDate + stageIndex`) so a
 * ghost is never a duplicate of a real / about-to-be-real task.
 */

import type {
  AppData,
  Checklist,
  ChecklistItem,
  ChecklistTemplate,
  SubChecklistItem,
  SubSubChecklistItem,
  TemplateStage,
} from './types'
import {
  advanceChecklistFrequency,
  ensureTemplateStages,
  resolveNodeDueDate,
  resolveSpecificMonthsStageDueDate,
  resolveStageDueDate,
} from './utils'

/** Default cap on ghosts emitted per template, so an annual horizon doesn't explode weekly templates. */
const DEFAULT_MAX_PER_TEMPLATE = 6

/** Hard ceiling on the cadence walk regardless of horizon, mirroring the materializer's safety counter. */
const SAFETY_LIMIT = 240

type ProjectOptions = {
  /** Exclusive lower bound: only occurrences with `dueDate > fromDateOnly` are projected (yyyy-mm-dd). */
  fromDateOnly: string
  /** Inclusive upper bound: only occurrences with `dueDate <= horizonEndDateOnly` are projected (yyyy-mm-dd). */
  horizonEndDateOnly: string
  /** Cap on ghosts per template (default {@link DEFAULT_MAX_PER_TEMPLATE}). */
  maxPerTemplate?: number
}

/**
 * Build a ghost stage-1 `Checklist` for `template` due on `dueDate`. Mirrors the
 * private `buildChecklistFromStage` in utils, but: every item/sub-item is born
 * OPEN (`done: false`), the id is the stable `projected:<templateId>:<dueDate>`
 * convention, and `projected: true` is set. The cycle month is derived from the
 * resolved due date so each node's recurring day-of-month lands in the right
 * month.
 */
function buildProjectedChecklist(
  template: ChecklistTemplate,
  stage: TemplateStage,
  stageCount: number,
  dueDate: string,
): Checklist {
  const [cycleYear, cycleMonth] = dueDate.split('-').map(Number)
  const items: ChecklistItem[] = stage.items.map((item, itemIndex) => {
    const itemDue = resolveNodeDueDate(item, cycleYear, cycleMonth)
    const subItems: SubChecklistItem[] | undefined =
      Array.isArray(item.subItems) && item.subItems.length > 0
        ? item.subItems.map((sub, subIndex) => {
            const subDue = resolveNodeDueDate(sub, cycleYear, cycleMonth)
            const subSubItems: SubSubChecklistItem[] | undefined =
              Array.isArray(sub.subItems) && sub.subItems.length > 0
                ? sub.subItems.map((subSub, subSubIndex) => {
                    const subSubDue = resolveNodeDueDate(subSub, cycleYear, cycleMonth)
                    return {
                      id: `projected:${template.id}:${dueDate}:i${itemIndex}:s${subIndex}:ss${subSubIndex}`,
                      title: subSub.title,
                      done: false,
                      ...(subSubDue ? { dueDate: subSubDue } : {}),
                    }
                  })
                : undefined
            return {
              id: `projected:${template.id}:${dueDate}:i${itemIndex}:s${subIndex}`,
              title: sub.title,
              done: false,
              ...(subDue ? { dueDate: subDue } : {}),
              ...(subSubItems ? { subItems: subSubItems } : {}),
            }
          })
        : undefined
    return {
      id: `projected:${template.id}:${dueDate}:i${itemIndex}`,
      label: item.label,
      done: false,
      ...(itemDue ? { dueDate: itemDue } : {}),
      ...(item.assigneeId ? { assigneeId: item.assigneeId } : {}),
      ...(subItems ? { subItems } : {}),
    }
  })

  return {
    id: `projected:${template.id}:${dueDate}`,
    templateId: template.id,
    title: template.title,
    clientId: template.clientId,
    assigneeId: stage.assigneeId || template.assigneeId,
    frequency: template.frequency,
    dueDate,
    viewerIds: [],
    editorIds: [],
    caseId: `projected:${template.id}:${dueDate}`,
    stageId: stage.id,
    stageIndex: 0,
    stageCount,
    ...(template.categoryId !== undefined ? { categoryId: template.categoryId } : {}),
    items,
    projected: true,
  }
}

/**
 * Project the upcoming (not-yet-materialized) recurring occurrences for every
 * active recurring template in `data`, within `(fromDateOnly, horizonEndDateOnly]`.
 *
 * Pure and deterministic given its inputs (it does NOT read the clock — callers
 * pass `fromDateOnly`, typically today). Returns `[]` when there are no
 * templates. Each returned `Checklist` is a synthesized ghost (`projected:true`,
 * stable `projected:<templateId>:<dueDate>` id) and must never be persisted.
 */
export function projectUpcomingChecklists(data: AppData, opts: ProjectOptions): Checklist[] {
  const { fromDateOnly, horizonEndDateOnly } = opts
  const maxPerTemplate =
    typeof opts.maxPerTemplate === 'number' && opts.maxPerTemplate > 0
      ? Math.floor(opts.maxPerTemplate)
      : DEFAULT_MAX_PER_TEMPLATE

  const templates = (data.checklistTemplates ?? []).map((template) => ensureTemplateStages(template))
  if (templates.length === 0 || horizonEndDateOnly < fromDateOnly) {
    return []
  }

  // Dedupe key set mirrors the materializer: `${templateId}:${dueDate}:${stageIndex}`
  // over BOTH active and recycled (soft-deleted) checklists, so a ghost is never
  // a duplicate of a real / about-to-be-real / deliberately-removed instance.
  const realChecklists = [
    ...(data.checklists ?? []),
    ...(data.recycledChecklists ?? []),
  ]
  const existingKeys = new Set(
    realChecklists
      .filter((checklist) => checklist.templateId)
      .map((checklist) => `${checklist.templateId}:${checklist.dueDate}:${checklist.stageIndex ?? 0}`),
  )

  const ghosts: Checklist[] = []
  const currentYear = new Date(`${fromDateOnly}T12:00:00`).getFullYear()

  for (const template of templates) {
    const stages = template.stages ?? []
    // Same skip rule the materializer uses: blueprints/inactive/no-stages/empty-stage-1 never produce.
    if (template.isStandard || !template.active || stages.length === 0 || stages[0].items.length === 0) {
      continue
    }

    const stageOne = stages[0]
    let emitted = 0

    if (template.frequency === 'specific-months') {
      // "Repeat every year" off: only project for the scheduled year.
      if (template.repeatAnnually === false && currentYear !== template.scheduleYear) {
        continue
      }
      const months = Array.isArray(template.scheduledMonths) ? [...template.scheduledMonths] : []
      // Ascending so the cap keeps the soonest occurrences.
      months.sort((a, b) => a - b)
      for (const month of months) {
        if (emitted >= maxPerTemplate) break
        if (!Number.isInteger(month) || month < 1 || month > 12) continue
        const dueDate = resolveSpecificMonthsStageDueDate(template, stageOne, currentYear, month)
        if (dueDate <= fromDateOnly || dueDate > horizonEndDateOnly) continue
        if (existingKeys.has(`${template.id}:${dueDate}:0`)) continue
        ghosts.push(buildProjectedChecklist(template, stageOne, stages.length, dueDate))
        existingKeys.add(`${template.id}:${dueDate}:0`)
        emitted += 1
      }
      continue
    }

    // Cadence frequencies: walk future due dates from nextDueDate forward using
    // the SAME advance logic the materializer uses (incl. biweekly).
    if (!template.nextDueDate) continue
    let cursor = template.nextDueDate
    let steps = 0
    while (cursor <= horizonEndDateOnly && emitted < maxPerTemplate && steps < SAFETY_LIMIT) {
      steps += 1
      if (cursor > fromDateOnly) {
        const dueDate = resolveStageDueDate(stageOne, cursor)
        if (dueDate > fromDateOnly && dueDate <= horizonEndDateOnly) {
          if (!existingKeys.has(`${template.id}:${dueDate}:0`)) {
            ghosts.push(buildProjectedChecklist(template, stageOne, stages.length, dueDate))
            existingKeys.add(`${template.id}:${dueDate}:0`)
            emitted += 1
          }
        }
      }
      const next = advanceChecklistFrequency(cursor, template.frequency)
      if (next === cursor) break
      cursor = next
    }
  }

  return ghosts
}
