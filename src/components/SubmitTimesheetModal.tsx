import { useEffect, useMemo, useState } from 'react'
import {
  buildTimesheetSubmitPlan,
  weekDayRangeLabel,
  type SubmitTarget,
} from '../lib/timesheetSubmitPlan'
import type { TimeEntry, TimesheetLock, WeeklySubmission } from '../lib/types'
import { formatHours } from '../lib/utils'

/**
 * The guided "Submit timesheet" flow.
 *
 * Submitting used to fire the moment the button was clicked, on whatever week
 * happened to be on screen — so the current week went out while older weeks sat
 * un-submitted behind it. The client asked for the opposite order: check the
 * past first, and never send the in-progress week without being asked.
 *
 * So one click opens this modal, which walks the decision in
 * `buildTimesheetSubmitPlan`:
 *
 *   1. Any PAST week still owed? Name the oldest one plainly, say how many more
 *      are queued behind it, and submit that one on confirm. After it lands the
 *      plan is recomputed from fresh workspace data and the modal advances to
 *      the next oldest — the user can close at any point.
 *   2. Nothing past outstanding? Say so, then ask the completion question about
 *      the CURRENT week. That explicit yes is the only way the current week is
 *      ever submitted from the UI.
 *
 * The server endpoint is unchanged and still accepts any Sunday: an owner can
 * still tell someone to submit early, and this is guidance, not a lock.
 */
export function SubmitTimesheetModal({
  employeeId,
  entries,
  submissions,
  locks,
  previewMode,
  onSubmit,
  onClose,
}: {
  employeeId: string
  entries: readonly TimeEntry[]
  submissions: readonly WeeklySubmission[]
  locks: readonly TimesheetLock[]
  previewMode: boolean
  onSubmit: (weekStart: string) => Promise<void>
  onClose: () => void
}) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  // The week the user just sent, so the next screen can confirm it landed
  // instead of silently swapping in the following week.
  const [justSubmitted, setJustSubmitted] = useState<string | null>(null)

  // Recomputed whenever the workspace data changes — which is exactly what a
  // successful submit does, so the flow advances on its own.
  const plan = useMemo(
    () => buildTimesheetSubmitPlan({ employeeId, entries, submissions, locks }),
    [employeeId, entries, submissions, locks],
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleConfirm = async (target: SubmitTarget) => {
    if (submitting || previewMode) return
    setSubmitting(true)
    setError('')
    try {
      await onSubmit(target.weekStart)
      setJustSubmitted(target.weekStart)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submit failed')
    } finally {
      setSubmitting(false)
    }
  }

  const currentLabel = weekDayRangeLabel(plan.currentWeek.weekStart)
  // Local const so the null check narrows inside the click handler's closure.
  const target = plan.target

  return (
    <div
      className="modal-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="modal-panel submit-timesheet-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Submit timesheet"
      >
        <div className="modal-body">
          <h2 className="modal-title">Submit timesheet</h2>

          {justSubmitted ? (
            <p className="submit-flow-confirm">
              Week of {weekDayRangeLabel(justSubmitted)} submitted for approval.
            </p>
          ) : null}

          {plan.step === 'past' && target ? (
            <>
              <p className="modal-intro">
                Submitting week of <strong>{weekDayRangeLabel(target.weekStart)}</strong> —{' '}
                {formatHours(target.minutes)} logged.
              </p>
              {target.reason === 'rejected' ? (
                <p className="submit-flow-note">
                  An owner sent this week back. Submitting it again returns it for review.
                </p>
              ) : null}
              <p className="submit-flow-note">
                {plan.remainingAfterTarget === 0
                  ? 'This is the last past week waiting on you.'
                  : `${plan.remainingAfterTarget} more past week${
                      plan.remainingAfterTarget === 1 ? '' : 's'
                    } still need submitting after this one.`}
              </p>
            </>
          ) : null}

          {plan.step !== 'past' ? (
            <p className="modal-intro">All past weeks are submitted — nothing prior to submit.</p>
          ) : null}

          {plan.step === 'current' && target ? (
            <p className="submit-flow-question">
              Are you finished logging time for the current week ({currentLabel})? Submitting sends
              it to the owner for approval.
            </p>
          ) : null}

          {plan.step === 'none' ? (
            <p className="submit-flow-note">{describeCurrentWeekBlock(plan.currentWeek, currentLabel)}</p>
          ) : null}

          {previewMode ? (
            <p className="submit-flow-note">
              You are previewing as another user, so nothing can be submitted here.
            </p>
          ) : null}

          {error ? <p className="auth-error">{error}</p> : null}

          <div className="button-row">
            <button type="button" className="secondary-action" onClick={onClose}>
              {plan.step === 'past' ? 'Cancel' : plan.step === 'current' ? 'Not yet' : 'Done'}
            </button>
            {target ? (
              <button
                type="button"
                className="primary-action"
                disabled={submitting || previewMode}
                onClick={() => handleConfirm(target)}
              >
                {submitting
                  ? 'Submitting…'
                  : plan.step === 'past'
                    ? 'Submit this week'
                    : 'Yes, submit this week'}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Why the current week isn't on offer, once nothing prior is outstanding. */
function describeCurrentWeekBlock(
  currentWeek: { status: string | null; monthLocked: boolean },
  currentLabel: string,
): string {
  if (currentWeek.monthLocked) {
    return `This month is locked, so the current week (${currentLabel}) can't be submitted.`
  }
  if (currentWeek.status === 'approved') {
    return `The current week (${currentLabel}) is already approved.`
  }
  if (currentWeek.status === 'pending') {
    return `The current week (${currentLabel}) is already submitted and awaiting the owner's approval.`
  }
  return `There is nothing left to submit for the current week (${currentLabel}).`
}
