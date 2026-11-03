import { useEffect } from 'react'
import { X } from 'lucide-react'
import type { StepSkipNextStep } from '../lib/api'
import { stepSkipOutcomeText } from '../lib/stepSkipOutcome'

/** How long the notice stays up before it clears itself. */
const VISIBLE_MS = 12_000

/**
 * Skip a step (featreq-7e1827e0): the skipped card leaves the list the moment the
 * skip saves, so what happened to the NEXT step is said here instead - a small
 * fixed notice like the new-version one, cleared after a few seconds or on X.
 */
export function StepSkipToast({
  outcome,
  onDismiss,
}: {
  outcome: StepSkipNextStep | null
  onDismiss: () => void
}) {
  useEffect(() => {
    if (!outcome) return undefined
    const timer = window.setTimeout(onDismiss, VISIBLE_MS)
    return () => window.clearTimeout(timer)
  }, [outcome, onDismiss])

  if (!outcome) return null
  return (
    <div className="new-version-toast step-skip-toast" role="status">
      <span className="new-version-toast-text">{stepSkipOutcomeText(outcome)}</span>
      <button type="button" className="new-version-toast-dismiss" aria-label="Dismiss" onClick={onDismiss}>
        <X size={14} />
      </button>
    </div>
  )
}
