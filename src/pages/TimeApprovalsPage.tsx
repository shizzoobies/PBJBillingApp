import { CheckCircle2, Lock, LockOpen, XCircle } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useAppContext } from '../AppContext'
import type {
  Checklist,
  Client,
  Employee,
  TimeEntry,
  WeeklySubmission,
} from '../lib/types'
import {
  clientName,
  employeeName,
  formatAuditStamp,
  formatHours,
  formatHoursMinutes,
  getBillingPeriodLabel,
  getWeekLabel,
  sessionMinutes,
  weekRangeOf,
} from '../lib/utils'

type StatusFilter = 'pending' | 'rejected' | 'all'

function previousPeriod(period: string): string {
  const [year, month] = period.split('-').map(Number)
  const date = new Date(year, month - 2, 1)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function taskTitleFor(checklists: Checklist[], taskId: string | null | undefined): string {
  if (!taskId) return 'Unassigned'
  return checklists.find((checklist) => checklist.id === taskId)?.title ?? 'Unassigned'
}

export function TimeApprovalsPage() {
  const {
    data,
    ownerMode,
    approveTimeEntry,
    rejectTimeEntry,
    approveTimeEntriesBatch,
    lockTimesheet,
    unlockTimesheet,
    approveWeeklySubmission,
    rejectWeeklySubmission,
  } = useAppContext()

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending')

  if (!ownerMode) {
    return null
  }

  // Include owners too: an owner can log their own time (timer or manual), and
  // those entries also land in the approval queue — so the owner needs to see
  // and approve them. Empty groups are dropped downstream, so an owner only
  // appears here when they actually have entries awaiting review.
  const employees = data.employees

  return (
    <section className="content-grid" id="time-approvals">
      <header className="productivity-header">
        <div>
          <h1>Time Approvals</h1>
          <p className="productivity-subtitle">
            Review submitted time, then lock each month once it is signed off.
          </p>
        </div>
      </header>

      <WeeklyReviewSection
        submissions={data.weeklySubmissions ?? []}
        employees={data.employees}
        entries={data.timeEntries}
        onApprove={approveWeeklySubmission}
        onReject={rejectWeeklySubmission}
      />

      <ApprovalQueue
        employees={employees}
        clients={data.clients}
        checklists={data.checklists}
        entries={data.timeEntries}
        statusFilter={statusFilter}
        onStatusFilter={setStatusFilter}
        onApprove={approveTimeEntry}
        onReject={rejectTimeEntry}
        onApproveBatch={approveTimeEntriesBatch}
      />

      <MonthEndSection
        employees={employees}
        entries={data.timeEntries}
        locks={data.timesheetLocks ?? []}
        onLock={lockTimesheet}
        onUnlock={unlockTimesheet}
      />
    </section>
  )
}

// ---------------------------------------------------------------------------
// Weekly review — pending lock-for-review submissions, owner approves/rejects
// ---------------------------------------------------------------------------

/**
 * Top-of-page section that surfaces every pending weekly submission so an
 * owner can approve / reject in one place. Approving auto-approves all
 * pending time entries in that user's Sun-Sat week (handled by the
 * `approveWeeklySubmission` handler). Rejecting requires a note explaining
 * the rationale — the submitter sees it on their time page.
 */
function WeeklyReviewSection({
  submissions,
  employees,
  entries,
  onApprove,
  onReject,
}: {
  submissions: WeeklySubmission[]
  employees: Employee[]
  entries: TimeEntry[]
  onApprove: (submissionId: string) => Promise<void>
  onReject: (submissionId: string, note: string) => Promise<void>
}) {
  const [pendingId, setPendingId] = useState<string | null>(null)
  // Map<submissionId, draftNote> — local state for each pending row's
  // rejection-note textarea. Cleared on approve/reject success.
  const [notes, setNotes] = useState<Record<string, string>>({})

  const pending = useMemo(
    () =>
      submissions
        .filter((submission) => submission.status === 'pending')
        .slice()
        .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)),
    [submissions],
  )

  const handleApprove = async (submissionId: string) => {
    setPendingId(submissionId)
    try {
      await onApprove(submissionId)
      setNotes((current) => {
        const next = { ...current }
        delete next[submissionId]
        return next
      })
    } finally {
      setPendingId(null)
    }
  }

  const handleReject = async (submissionId: string) => {
    const note = (notes[submissionId] ?? '').trim()
    if (!note) {
      window.alert('Add a short rejection note so the bookkeeper knows what to fix.')
      return
    }
    setPendingId(submissionId)
    try {
      await onReject(submissionId, note)
      setNotes((current) => {
        const next = { ...current }
        delete next[submissionId]
        return next
      })
    } finally {
      setPendingId(null)
    }
  }

  return (
    <section className="panel" aria-label="Weekly submissions">
      <div className="section-heading">
        <div>
          <h2 style={{ margin: 0 }}>Weekly submissions</h2>
          <p className="productivity-subtitle" style={{ margin: '4px 0 0 0' }}>
            Approve a week to seal every pending time entry inside it. Rejecting unlocks
            the week so the bookkeeper can edit and resubmit.
          </p>
        </div>
        <span className="status-pill">{pending.length} pending</span>
      </div>

      {pending.length === 0 ? (
        <p className="checklist-empty-hint">Nothing pending review.</p>
      ) : (
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'grid',
            gap: 12,
          }}
        >
          {pending.map((submission) => {
            const { start, end } = weekRangeOf(submission.weekStart)
            const totalMinutes = entries
              .filter(
                (entry) =>
                  entry.employeeId === submission.userId &&
                  entry.date >= start &&
                  entry.date <= end,
              )
              .reduce((sum, entry) => sum + entry.minutes, 0)
            const inFlight = pendingId === submission.id
            return (
              <li
                key={submission.id}
                style={{
                  padding: 12,
                  borderTop: '1px solid var(--border-subtle, #eee)',
                  display: 'grid',
                  gap: 8,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    gap: 12,
                    flexWrap: 'wrap',
                  }}
                >
                  <div>
                    <strong>{employeeName(employees, submission.userId)}</strong>
                    <span className="checklist-meta-line">
                      {getWeekLabel(submission.weekStart)} ·{' '}
                      {formatHours(totalMinutes)} logged · submitted{' '}
                      {new Date(submission.submittedAt).toLocaleString()}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      className="primary-action"
                      disabled={inFlight}
                      onClick={() => void handleApprove(submission.id)}
                      title="Approve this week and seal every pending entry in it"
                    >
                      <CheckCircle2 size={14} />
                      Approve week
                    </button>
                    <button
                      type="button"
                      className="secondary-action danger"
                      disabled={inFlight}
                      onClick={() => void handleReject(submission.id)}
                      title="Reject so the bookkeeper can edit and resubmit"
                    >
                      <XCircle size={14} />
                      Reject
                    </button>
                  </div>
                </div>
                <textarea
                  className="input"
                  rows={2}
                  placeholder="Rejection note (required to reject) — e.g. 'Missing description on Tue 1/16'"
                  value={notes[submission.id] ?? ''}
                  onChange={(event) =>
                    setNotes((current) => ({ ...current, [submission.id]: event.target.value }))
                  }
                />
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Approval queue — entries grouped by employee
// ---------------------------------------------------------------------------

function ApprovalQueue({
  employees,
  clients,
  checklists,
  entries,
  statusFilter,
  onStatusFilter,
  onApprove,
  onReject,
  onApproveBatch,
}: {
  employees: Employee[]
  clients: Client[]
  checklists: Checklist[]
  entries: TimeEntry[]
  statusFilter: StatusFilter
  onStatusFilter: (value: StatusFilter) => void
  onApprove: (entryId: string) => Promise<void>
  onReject: (entryId: string, note: string) => Promise<void>
  onApproveBatch: (entryIds: string[]) => Promise<void>
}) {
  const filtered = useMemo(() => {
    if (statusFilter === 'all') return entries
    return entries.filter((entry) => entry.approvalStatus === statusFilter)
  }, [entries, statusFilter])

  const groups = useMemo(() => {
    return employees
      .map((employee) => ({
        employee,
        entries: filtered
          .filter((entry) => entry.employeeId === employee.id)
          .sort((left, right) => right.date.localeCompare(left.date)),
      }))
      .filter((group) => group.entries.length > 0)
  }, [employees, filtered])

  return (
    <section className="panel report-section">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Submitted time</p>
          <h2>Approval queue</h2>
        </div>
        <div className="productivity-segmented" role="group" aria-label="Status filter">
          <button
            type="button"
            className={statusFilter === 'pending' ? 'is-active' : ''}
            onClick={() => onStatusFilter('pending')}
          >
            Pending
          </button>
          <button
            type="button"
            className={statusFilter === 'rejected' ? 'is-active' : ''}
            onClick={() => onStatusFilter('rejected')}
          >
            Rejected
          </button>
          <button
            type="button"
            className={statusFilter === 'all' ? 'is-active' : ''}
            onClick={() => onStatusFilter('all')}
          >
            All
          </button>
        </div>
      </div>

      {groups.length === 0 ? (
        <p className="empty-state">
          {statusFilter === 'pending'
            ? 'No time entries are waiting for approval.'
            : 'Nothing to show for this filter.'}
        </p>
      ) : (
        <div className="approval-groups">
          {groups.map((group) => (
            <EmployeeApprovalGroup
              key={group.employee.id}
              employee={group.employee}
              entries={group.entries}
              clients={clients}
              checklists={checklists}
              onApprove={onApprove}
              onReject={onReject}
              onApproveBatch={onApproveBatch}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function EmployeeApprovalGroup({
  employee,
  entries,
  clients,
  checklists,
  onApprove,
  onReject,
  onApproveBatch,
}: {
  employee: Employee
  entries: TimeEntry[]
  clients: Client[]
  checklists: Checklist[]
  onApprove: (entryId: string) => Promise<void>
  onReject: (entryId: string, note: string) => Promise<void>
  onApproveBatch: (entryIds: string[]) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const pendingIds = entries
    .filter((entry) => entry.approvalStatus === 'pending')
    .map((entry) => entry.id)

  return (
    <div className="approval-group">
      <div className="approval-group-header">
        <strong>{employee.name}</strong>
        {pendingIds.length > 0 ? (
          <button
            type="button"
            className="ghost-action"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await onApproveBatch(pendingIds)
              } finally {
                setBusy(false)
              }
            }}
          >
            <CheckCircle2 size={14} />
            Approve all ({pendingIds.length})
          </button>
        ) : null}
      </div>
      <div className="approval-rows">
        {entries.map((entry) => (
          <ApprovalRow
            key={entry.id}
            entry={entry}
            clientLabel={
              entry.isAdministrative ? 'Administrative' : clientName(clients, entry.clientId)
            }
            taskLabel={taskTitleFor(checklists, entry.taskId)}
            onApprove={onApprove}
            onReject={onReject}
          />
        ))}
      </div>
    </div>
  )
}

function ApprovalRow({
  entry,
  clientLabel,
  taskLabel,
  onApprove,
  onReject,
}: {
  entry: TimeEntry
  clientLabel: string
  taskLabel: string
  onApprove: (entryId: string) => Promise<void>
  onReject: (entryId: string, note: string) => Promise<void>
}) {
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const handleApprove = async () => {
    setBusy(true)
    setError('')
    try {
      await onApprove(entry.id)
    } catch {
      setError('Could not approve this entry.')
    } finally {
      setBusy(false)
    }
  }

  const handleReject = async () => {
    if (!note.trim()) {
      setError('A rejection note is required.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await onReject(entry.id, note.trim())
      setRejecting(false)
      setNote('')
    } catch {
      setError('Could not reject this entry.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className="approval-row">
      <div className="approval-row-main">
        <div className="approval-row-facts">
          <strong>{clientLabel}</strong>
          <span>{entry.description}</span>
          <small>
            {entry.date} · {taskLabel} · {formatHours(entry.minutes)} ·{' '}
            {entry.billable ? 'Billable' : 'Internal'}
          </small>
          {(() => {
            const sessions =
              entry.sessions && entry.sessions.length > 0
                ? entry.sessions
                : entry.startAt && entry.endAt
                  ? [{ startAt: entry.startAt, endAt: entry.endAt }]
                  : []
            return sessions.length > 0 ? (
              <div className="approval-sessions">
                {sessions.map((session, index) => (
                  <small className="approval-audit-times" key={`${session.startAt}-${index}`}>
                    {sessions.length > 1 ? `Session ${index + 1}: ` : ''}
                    {formatAuditStamp(session.startAt)} → {formatAuditStamp(session.endAt)} ·{' '}
                    {formatHoursMinutes(sessionMinutes(session))}
                  </small>
                ))}
              </div>
            ) : null
          })()}
          {entry.entryMethod === 'manual' ? (
            <div className="approval-manual-note">
              <strong>Manual entry</strong>
              <span>
                {entry.manualReason
                  ? `Reason: ${entry.manualReason}`
                  : 'No reason was provided.'}
              </span>
            </div>
          ) : null}
          {entry.approvalStatus === 'rejected' && entry.approvalNote ? (
            <small className="entry-reject-note">Rejected: {entry.approvalNote}</small>
          ) : null}
        </div>
        <div className="approval-row-pills">
          {entry.entryMethod === 'manual' ? (
            <span className="manual-badge">Manual</span>
          ) : null}
          <span className={`time-status-pill time-status-${entry.approvalStatus}`}>
            {entry.approvalStatus === 'approved'
              ? 'Approved'
              : entry.approvalStatus === 'rejected'
                ? 'Rejected'
                : 'Pending'}
          </span>
        </div>
      </div>

      {entry.approvalStatus !== 'approved' ? (
        <div className="approval-row-actions">
          {rejecting ? (
            <div className="approval-reject-form">
              <input
                className="input"
                placeholder="Reason for rejection (required)"
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
              <div className="button-row">
                <button
                  type="button"
                  className="secondary-action danger"
                  disabled={busy}
                  onClick={() => void handleReject()}
                >
                  Confirm reject
                </button>
                <button
                  type="button"
                  className="secondary-action"
                  disabled={busy}
                  onClick={() => {
                    setRejecting(false)
                    setNote('')
                    setError('')
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              {entry.approvalStatus === 'pending' ? (
                <button
                  type="button"
                  className="ghost-action"
                  disabled={busy}
                  onClick={() => void handleApprove()}
                >
                  <CheckCircle2 size={14} />
                  Approve
                </button>
              ) : null}
              <button
                type="button"
                className="ghost-action danger"
                disabled={busy}
                onClick={() => setRejecting(true)}
              >
                <XCircle size={14} />
                Reject
              </button>
            </>
          )}
        </div>
      ) : null}
      {error ? <small className="auth-error">{error}</small> : null}
    </article>
  )
}

// ---------------------------------------------------------------------------
// Month-end lock section
// ---------------------------------------------------------------------------

function MonthEndSection({
  employees,
  entries,
  locks,
  onLock,
  onUnlock,
}: {
  employees: Employee[]
  entries: TimeEntry[]
  locks: { userId: string; period: string; lockedBy: string; lockedAt: string }[]
  onLock: (userId: string, period: string) => Promise<void>
  onUnlock: (userId: string, period: string) => Promise<void>
}) {
  const defaultPeriod = previousPeriod(new Date().toISOString().slice(0, 7))
  const [period, setPeriod] = useState(defaultPeriod)
  const [busy, setBusy] = useState(false)

  const rows = useMemo(() => {
    return employees.map((employee) => {
      const periodEntries = entries.filter(
        (entry) => entry.employeeId === employee.id && entry.date.slice(0, 7) === period,
      )
      const minutes = periodEntries.reduce((sum, entry) => sum + entry.minutes, 0)
      const pendingCount = periodEntries.filter(
        (entry) => entry.approvalStatus === 'pending',
      ).length
      const lock = locks.find(
        (item) => item.userId === employee.id && item.period === period,
      )
      return { employee, minutes, pendingCount, lock }
    })
  }, [employees, entries, locks, period])

  const unlockedRows = rows.filter((row) => !row.lock)

  return (
    <section className="panel report-section">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Month-end</p>
          <h2>Timesheet locks</h2>
        </div>
        <div className="page-actions">
          <label className="productivity-control">
            <span>Month</span>
            <input
              type="month"
              value={period}
              onChange={(event) => setPeriod(event.target.value)}
            />
          </label>
          {unlockedRows.length > 0 ? (
            <button
              type="button"
              className="ghost-action"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  for (const row of unlockedRows) {
                    await onLock(row.employee.id, period)
                  }
                } finally {
                  setBusy(false)
                }
              }}
            >
              <Lock size={14} />
              Lock all
            </button>
          ) : null}
        </div>
      </div>
      <p className="report-caption">
        Locking {getBillingPeriodLabel(period)} signs off that month — pending entries are
        auto-approved and the employee can no longer change them.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Employee</th>
              <th>Total hours</th>
              <th>Pending</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <MonthEndRow
                key={row.employee.id}
                employeeName={row.employee.name}
                minutes={row.minutes}
                pendingCount={row.pendingCount}
                lock={row.lock}
                onLock={() => onLock(row.employee.id, period)}
                onUnlock={() => onUnlock(row.employee.id, period)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function MonthEndRow({
  employeeName,
  minutes,
  pendingCount,
  lock,
  onLock,
  onUnlock,
}: {
  employeeName: string
  minutes: number
  pendingCount: number
  lock: { lockedBy: string; lockedAt: string } | undefined
  onLock: () => Promise<void>
  onUnlock: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)

  return (
    <tr>
      <td>
        <strong>{employeeName}</strong>
      </td>
      <td>{formatHours(minutes)}</td>
      <td>{pendingCount}</td>
      <td>
        {lock ? (
          <span className="time-status-pill time-status-approved">
            Locked {lock.lockedAt.slice(0, 10)}
          </span>
        ) : (
          <span className="time-status-pill time-status-pending">Open</span>
        )}
      </td>
      <td>
        {lock ? (
          <button
            type="button"
            className="ghost-action"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await onUnlock()
              } finally {
                setBusy(false)
              }
            }}
          >
            <LockOpen size={14} />
            Unlock
          </button>
        ) : (
          <button
            type="button"
            className="ghost-action"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await onLock()
              } finally {
                setBusy(false)
              }
            }}
          >
            <Lock size={14} />
            Lock month
          </button>
        )}
      </td>
    </tr>
  )
}
