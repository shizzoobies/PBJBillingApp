import type { Employee, WaitingOn } from '../lib/types'
import { isClientWait } from '../../lib/waiting-on-state.js'
import { completedWaits, describeWaitProvenance, employeeName } from '../lib/utils'

/**
 * Closed-out waits, rendered on the step as completed sub-items.
 *
 * Her test, verbatim: "A received the notification and clicked Confirmed on the
 * waiting task and it disappeared. The waiting and information in it needs to
 * stay as a sub task shown as completed like other tasks are when you click the
 * box."
 *
 * It disappeared because the ONLY place a wait rendered was the amber waiting
 * editor, and that editor is mounted on `stepIsWaiting` — which goes false the
 * moment the last wait is confirmed. The record survived on the server the
 * whole time; it simply had nowhere left to be drawn. So this list lives
 * OUTSIDE the editor and outside every one of its conditions: it renders on a
 * done step, on a read-only step, and long after the wait itself is history.
 *
 * Two rules it must never break, both from earlier rounds of this same feature:
 *   - it never completes the parent step. The box here is the wait's own, not
 *     the step's — checking work off stays the checkboxes' job.
 *   - it keeps the names. Requester, doer and confirmer with their dates are
 *     the entire receipt for a two-party hand-off.
 */
export function CompletedWaits({
  waitingOns,
  employees,
  clientLabel,
  className,
}: {
  waitingOns: WaitingOn[] | undefined
  employees: Employee[]
  /** This task's client, for a wait that was on the client rather than a teammate. */
  clientLabel: string
  className?: string
}) {
  const entries = completedWaits(waitingOns)
  if (entries.length === 0) return null

  return (
    <ul className={className ? `waiting-record-list ${className}` : 'waiting-record-list'}>
      {entries.map((entry) => {
        const blockerName = isClientWait(entry)
          ? clientLabel || 'the client'
          : employeeName(employees, entry.blockerId)
        const label = `Waited on ${blockerName}`
        return (
          <li className="waiting-record-row" key={entry.id}>
            {/* Ticked, and not yours to un-tick: the wait is closed, and this box
                has never had anything to do with the step's own completion. */}
            <input
              type="checkbox"
              checked
              disabled
              readOnly
              aria-label={`${label} — completed`}
            />
            <span className="waiting-record-body">
              <span className="waiting-record-label">
                {label}
                {entry.note ? <span className="waiting-record-note"> — {entry.note}</span> : null}
              </span>
              <span className="waiting-record-trail">
                {describeWaitProvenance(entry, { employees, clientLabel })}
              </span>
            </span>
          </li>
        )
      })}
    </ul>
  )
}
