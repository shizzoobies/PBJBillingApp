import type { Checklist } from './types'
import type { StepSkipNextStep } from './api'

/** The sentence for what a step skip did to the next step (featreq-7e1827e0). */
export function stepSkipOutcomeText(outcome: StepSkipNextStep): string {
  if (outcome.opened) {
    const stepNumber = (outcome.checklist.stageIndex ?? 0) + 1
    return `Step skipped. Step ${stepNumber} is open now for ${outcome.assigneeName || 'the next person'}.`
  }
  if (outcome.alreadyOpen) {
    const stepNumber = (outcome.checklist.stageIndex ?? 0) + 1
    return outcome.assigneeName
      ? `Step skipped. Step ${stepNumber} was already open for ${outcome.assigneeName}, who has been told.`
      : `Step skipped. Step ${stepNumber} was already open.`
  }
  return `Step skipped, but the next step did not open: ${outcome.message}`
}

/** The row a step skip opened or stamped, to merge into the workspace; null when there is none. */
export function stepSkipOutcomeChecklist(outcome: StepSkipNextStep | null | undefined): Checklist | null {
  if (!outcome) return null
  if (outcome.opened || outcome.alreadyOpen) return outcome.checklist
  return null
}
