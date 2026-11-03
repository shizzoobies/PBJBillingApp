import type { StepSkipNextStep } from './api'

/** The sentence for what a step skip did to the next step (featreq-7e1827e0). */
export function stepSkipOutcomeText(outcome: StepSkipNextStep): string {
  if (outcome.opened) {
    const stepNumber = (outcome.checklist.stageIndex ?? 0) + 1
    return `Step skipped. Step ${stepNumber} is open now for ${outcome.assigneeName || 'the next person'}.`
  }
  return `Step skipped, but the next step did not open: ${outcome.message}`
}
