import type { Checklist } from './types'
import type { StepSkipNextStep } from './api'

/**
 * The sentence for what a step skip (featreq-7e1827e0) or a step push
 * (featreq-78f09571) did to the next step.
 */
export function stepSkipOutcomeText(outcome: StepSkipNextStep): string {
  const did = outcome.after === 'push' ? 'Step pushed' : 'Step skipped'
  if (outcome.opened) {
    const stepNumber = (outcome.checklist.stageIndex ?? 0) + 1
    return `${did}. Step ${stepNumber} is open now for ${outcome.assigneeName || 'the next person'}.`
  }
  if (outcome.alreadyOpen) {
    const stepNumber = (outcome.checklist.stageIndex ?? 0) + 1
    // A push onto a next step that is already finished: nothing opened, nobody told.
    if (outcome.finished) return `${did}. Step ${stepNumber} was already finished.`
    return outcome.assigneeName
      ? `${did}. Step ${stepNumber} was already open for ${outcome.assigneeName}, who has been told.`
      : `${did}. Step ${stepNumber} was already open.`
  }
  return `${did}, but the next step did not open: ${outcome.message}`
}

/** The row a step skip opened or stamped, to merge into the workspace; null when there is none. */
export function stepSkipOutcomeChecklist(outcome: StepSkipNextStep | null | undefined): Checklist | null {
  if (!outcome) return null
  if (outcome.opened || outcome.alreadyOpen) return outcome.checklist
  return null
}
