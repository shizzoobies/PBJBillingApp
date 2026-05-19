import { CheckCircle2, Lock, LockOpen, XCircle } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useAppContext } from '../AppContext'
import type { Checklist, Client, Employee, TimeEntry } from '../lib/types'
import { clientName, formatHours, getBillingPeriodLabel } from '../lib/utils'

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
  } = useAppContext()

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending')

  if (!ownerMode) {
    return null
  }

  const employees = data.employees.filter((employee) => employee.role !== 'Owner')

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
            clientLabel={clientName(clients, entry.clientId)}
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
