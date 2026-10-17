import { stageFinished } from '../../lib/waiting-on-state.js'
import type { Checklist } from './types'

/**
 * featreq-ed73d181: a staged case whose step is finished but whose next step
 * never opened (I-95 case-8b17c9df: step 1 of 6 finished on 2026-10-07, before
 * the 10-12 hardening, and nothing created step 2). Such a case has no open row
 * anywhere, so the Board and the open lists never show it. Open next step now
 * revives it from the card; the Dashboard lists it so someone finds the card.
 *
 * True when this row is a live, templated stage (not projected, onboarding,
 * pushed away or skipped), it is not the last stage of its case, every step is
 * done by the roll-up (`stageFinished`), and NO later stage of the same case is
 * live in `checklists` - neither the next one (the ordinary hand-off) nor one
 * beyond it (the server refuses to create a step behind it, later_stage_exists).
 * `checklists` is the live list (the recycle bin is separate).
 */
export function nextStageNeverOpened(checklist: Checklist, checklists: readonly Checklist[]): boolean {
  const stageIndex = checklist.stageIndex ?? 0
  const stageCount = checklist.stageCount ?? 1
  if (checklist.projected) return false
  if (stageIndex + 1 >= stageCount) return false
  if (!checklist.templateId) return false
  if (checklist.onboardingForClientId || checklist.pushedToChecklistId || checklist.skippedAt) return false
  if (!stageFinished(checklist)) return false
  const caseKey = checklist.caseId || checklist.id
  return !checklists.some(
    (entry) =>
      (entry.caseId || entry.id) === caseKey &&
      typeof entry.stageIndex === 'number' &&
      entry.stageIndex > stageIndex,
  )
}

/**
 * Every stalled stage in `checklists` (at most one per case: the latest live
 * stage), soonest due first. `dueOnOrAfter` (YYYY-MM-DD) keeps only stages due
 * that day or later: the Dashboard lists the last 90 days, so the old August
 * import stalls do not flood it. The card's button is offered on every stall.
 */
export function stalledCaseStages(checklists: readonly Checklist[], dueOnOrAfter?: string): Checklist[] {
  return checklists
    .filter((checklist) => !dueOnOrAfter || (checklist.dueDate ?? '') >= dueOnOrAfter)
    .filter((checklist) => nextStageNeverOpened(checklist, checklists))
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0))
}
