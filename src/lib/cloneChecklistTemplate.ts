import { firstCycleOnOrAfter } from '../../lib/checklist-start-floor.js'
import { copiedTemplateSettings, copiedTemplateStages } from '../../lib/checklist-template-copy.js'
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
 * nobody; listing them means a new field has to be looked at once - in
 * lib/checklist-template-copy.js, which the server's copy (`_clientTemplateCopy`
 * in db/store.js) shares, so the two copy paths carry the same fields.
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
  return {
    title: options.title ?? source.title,
    clientId: options.clientId,
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
    // Everything else a copy keeps - the schedule, the Board column, the skip and
    // period-label settings, access, and the stages/steps/sub-steps with fresh
    // ids - comes from the ONE list the server's copy uses too
    // (lib/checklist-template-copy.js), so the two paths cannot drift again.
    ...copiedTemplateSettings(source),
    stages: copiedTemplateStages(migrated.stages, makeId),
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
