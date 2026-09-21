import { firstCycleOnOrAfter } from '../../lib/checklist-start-floor.js'
import type { ChecklistTemplate } from './types'
import { advanceChecklistFrequency, ensureTemplateStages, localDateOnly, makeId } from './utils'

/**
 * Copying a recurring recipe — the ONE clone both copy paths run through.
 *
 * Two places make a copy of a repeating task: "Set up plan checklists" on a
 * client (ClientDetailPage, which retargets the copy at that client) and
 * "Duplicate" on the Checklists tab (App.tsx, which keeps the client and waits
 * for the owner to re-aim it). They drifted: the client path floored the copy's
 * start at today and stamped its origin, while Duplicate was a `{ ...source }`
 * spread that carried the source's `createdAt` — so a copy of an August recipe
 * was still, as far as both materializers were concerned, an August recipe, and
 * it back-filled August the moment it landed (featreq-0bc2437e). One function
 * now, so they cannot disagree again.
 *
 * The field list is EXPLICIT on purpose. A spread makes every future template
 * field a copied field by default, decided by whoever adds it and reviewed by
 * nobody; listing them means a new field has to be looked at once, here.
 *
 * Deliberately NOT carried:
 *   - `id` (the caller supplies one — fresh ids at every level, so the bulk
 *     autosave inserts the copy instead of colliding with the source),
 *   - `onboardingForClientId` — a copy must not drive a client's lifecycle,
 *   - `items` (the deprecated pre-stages shape; `stages` is what is written).
 */
export type CloneChecklistTemplateOptions = {
  /** The client the copy belongs to — the source's own, or a new one. */
  clientId: string
  /** The copy's title. Defaults to the source's. */
  title?: string
  /** Whether the copy starts generating immediately. */
  active: boolean
}

export function cloneChecklistTemplate(
  source: ChecklistTemplate,
  options: CloneChecklistTemplateOptions,
): Omit<ChecklistTemplate, 'id'> {
  const migrated = ensureTemplateStages(source)
  const cloneItems = (items: ChecklistTemplate['stages'][number]['items']) =>
    (items ?? []).map((item) => ({
      ...item,
      id: makeId('template-item'),
      subItems: (item.subItems ?? []).map((sub) => ({
        ...sub,
        id: makeId('template-subitem'),
      })),
    }))
  return {
    title: options.title ?? source.title,
    clientId: options.clientId,
    assigneeId: source.assigneeId || '',
    frequency: source.frequency,
    // The start floor, the half that stops a copy back-filling history: the
    // copy begins at its first cycle on or after today. A source's
    // `nextDueDate` is routinely months stale (a standard blueprint's weekly
    // ones sat at 2026-06-30), and copying it verbatim spawned a dozen
    // backdated instances on the next read (featreq-c133daf8).
    nextDueDate: firstCycleOnOrAfter(
      source.nextDueDate || localDateOnly(),
      source.frequency,
      localDateOnly(),
      advanceChecklistFrequency,
    ),
    // The other half: the copy was created TODAY. Both materializers measure a
    // spawn against this stamp, so inheriting the source's would hand the copy
    // the source's months.
    createdAt: new Date().toISOString(),
    active: options.active,
    isStandard: false,
    sourceTemplateId: source.id,
    categoryId: source.categoryId ?? null,
    leadDays: source.leadDays,
    scheduledMonths: source.scheduledMonths ? [...source.scheduledMonths] : undefined,
    dueDayOfMonth: source.dueDayOfMonth,
    monthlyDueDays: source.monthlyDueDays ? { ...source.monthlyDueDays } : undefined,
    repeatAnnually: source.repeatAnnually,
    scheduleYear: source.scheduleYear,
    skipAllowed: source.skipAllowed,
    // The period-label settings travel with the copy — a copy of a recipe that
    // labels "July 2026" is meant to label its own cycles too. The anchor comes
    // along so the derived windows keep the source's phase; the label math
    // steps from it by the recurrence, exactly as it does on the source.
    periodLabelEnabled: source.periodLabelEnabled,
    periodCoverageStart: source.periodCoverageStart ?? null,
    periodCoverageEnd: source.periodCoverageEnd ?? null,
    periodCoverageAnchorDue: source.periodCoverageAnchorDue ?? null,
    viewerIds: Array.isArray(source.viewerIds) ? [...source.viewerIds] : [],
    editorIds: Array.isArray(source.editorIds) ? [...source.editorIds] : [],
    stages: (migrated.stages ?? []).map((stage) => ({
      ...stage,
      id: makeId('stage'),
      viewerIds: Array.isArray(stage.viewerIds) ? [...stage.viewerIds] : [],
      editorIds: Array.isArray(stage.editorIds) ? [...stage.editorIds] : [],
      items: cloneItems(stage.items),
    })),
  }
}

/**
 * "Duplicate" on the Checklists tab: the same recipe, same client, "(copy)" on
 * the title — and SWITCHED OFF.
 *
 * Off is the part that matters. A copy exists to be re-aimed, usually at
 * another client, and the start floor is month-granular: an active copy spawns
 * this month's occurrence within seconds of being made, long before anyone
 * finishes changing the client. Those instances keep the OLD client forever —
 * an instance's `clientId` is a snapshot, and the "already generated" key is
 * client-blind, so they also occupy the very months the new client needs.
 * Brittany duplicated a Let's Eat recipe, pointed it at I-95 five minutes
 * later, and I-95 never got a single task (featreq-0bc2437e).
 */
export function duplicateTemplateDraft(source: ChecklistTemplate): Omit<ChecklistTemplate, 'id'> {
  return cloneChecklistTemplate(source, {
    clientId: source.clientId,
    title: `${source.title} (copy)`,
    active: false,
  })
}
