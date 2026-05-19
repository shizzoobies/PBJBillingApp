import { Clock3, TimerReset } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { useAppContext } from '../AppContext'
import type {
  Checklist,
  Client,
  Employee,
  Role,
  TimeEntry,
  TimerState,
  TimesheetLock,
} from '../lib/types'
import { clientName, currentBillingPeriod, employeeName, formatHours } from '../lib/utils'

export function TimePage() {
  const {
    activeEmployeeId,
    visibleClients,
    data,
    role,
    visibleEntries,
    timer,
    timerElapsed,
    startTimer,
    stopTimer,
    logTime,
    updateTimeEntry,
    deleteTimeEntry,
  } = useAppContext()

  // The viewed period is the current month. A bookkeeper whose timesheet is
  // locked for it loses add/edit/delete on this page.
  const currentPeriod = currentBillingPeriod()
  const lockedThisPeriod =
    role !== 'owner' &&
    (data.timesheetLocks ?? []).some(
      (lock) => lock.userId === activeEmployeeId && lock.period === currentPeriod,
    )

  return (
    <section className="content-grid two-column" id="time">
      <TimeCapture
        activeEmployeeId={activeEmployeeId}
        clients={visibleClients}
        checklists={data.checklists}
        employees={data.employees}
        onLog={logTime}
        onStartTimer={startTimer}
        onStopTimer={stopTimer}
        role={role}
        timer={timer}
        timerElapsed={timer ? timerElapsed : '0:00'}
        locked={lockedThisPeriod}
        currentPeriod={currentPeriod}
      />
      <RecentTimeEntries
        checklists={data.checklists}
        clients={data.clients}
        employees={data.employees}
        entries={visibleEntries}
        role={role}
        locks={data.timesheetLocks ?? []}
        onUpdate={updateTimeEntry}
        onDelete={deleteTimeEntry}
      />
    </section>
  )
}

/**
 * Pick checklists eligible for time-attach: same client, not yet completed,
 * and either the user is assignee/editor (or owner — owners see all).
 */
function eligibleChecklistsFor(
  checklists: Checklist[],
  clientId: string,
  userId: string,
  role: Role,
): Checklist[] {
  if (!clientId) return []
  return checklists.filter((checklist) => {
    if (checklist.clientId !== clientId) return false
    const total = checklist.items.length
    const done = checklist.items.filter((item) => item.done).length
    if (total > 0 && done === total) return false
    if (role === 'owner') return true
    const editorIds = Array.isArray(checklist.editorIds) ? checklist.editorIds : []
    return checklist.assigneeId === userId || editorIds.includes(userId)
  })
}

function StatusPill({ status }: { status: TimeEntry['approvalStatus'] }) {
  const label =
    status === 'approved' ? 'Approved' : status === 'rejected' ? 'Rejected' : 'Pending'
  return <span className={`time-status-pill time-status-${status}`}>{label}</span>
}

function TimeCapture({
  activeEmployeeId,
  clients,
  checklists,
  employees,
  onLog,
  onStartTimer,
  onStopTimer,
  role,
  timer,
  timerElapsed,
  locked,
  currentPeriod,
}: {
  activeEmployeeId: string
  clients: Client[]
  checklists: Checklist[]
  employees: Employee[]
  onLog: (entry: Omit<TimeEntry, 'id' | 'approvalStatus'>) => Promise<void>
  onStartTimer: (timer: TimerState) => void
  onStopTimer: () => Promise<void>
  role: Role
  timer: TimerState | null
  timerElapsed: string
  locked: boolean
  currentPeriod: string
}) {
  const [clientId, setClientId] = useState(clients[0]?.id ?? '')
  const [employeeId, setEmployeeId] = useState(activeEmployeeId)
  const [hours, setHours] = useState('1.25')
  const [description, setDescription] = useState('Reviewed transactions and added client notes.')
  const [billable, setBillable] = useState(true)
  const [taskId, setTaskId] = useState<string>('')
  const [submitError, setSubmitError] = useState('')
  const [submitPending, setSubmitPending] = useState(false)
  const effectiveClientId = clients.some((client) => client.id === clientId)
    ? clientId
    : clients[0]?.id ?? ''
  const effectiveEmployeeId = role === 'owner' ? employeeId : activeEmployeeId

  const eligibleTasks = useMemo(
    () => eligibleChecklistsFor(checklists, effectiveClientId, effectiveEmployeeId, role),
    [checklists, effectiveClientId, effectiveEmployeeId, role],
  )

  // Reset taskId if the previously-chosen task isn't valid for the new client.
  const effectiveTaskId = eligibleTasks.some((task) => task.id === taskId) ? taskId : ''

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const numericHours = Number(hours)
    if (!effectiveClientId || Number.isNaN(numericHours) || numericHours <= 0) {
      return
    }

    setSubmitPending(true)
    setSubmitError('')

    try {
      await onLog({
        employeeId: effectiveEmployeeId,
        clientId: effectiveClientId,
        date: new Date().toISOString().slice(0, 10),
        minutes: Math.round(numericHours * 60),
        description,
        billable,
        taskId: effectiveTaskId || null,
      })
      setDescription('')
      setHours('0.50')
      setTaskId('')
    } catch {
      setSubmitError('Time entry could not be saved.')
    } finally {
      setSubmitPending(false)
    }
  }

  const handleStartTimer = () => {
    if (!effectiveClientId) {
      return
    }

    onStartTimer({
      employeeId: effectiveEmployeeId,
      clientId: effectiveClientId,
      description: description || 'Timed bookkeeping work',
      startedAt: Date.now(),
      taskId: effectiveTaskId || null,
    })
  }

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Assigned to me</p>
          <h2>Log time</h2>
        </div>
        <div className={timer ? 'timer-pill running' : 'timer-pill'}>
          <TimerReset size={16} />
          <span>{timer ? timerElapsed : '0:00'}</span>
        </div>
      </div>

      {locked ? (
        <div className="lock-banner">
          <strong>This timesheet is locked.</strong>
          <span>
            {currentPeriod} has been signed off. Contact an owner to make changes.
          </span>
        </div>
      ) : null}

      <form className="form-grid" onSubmit={handleSubmit}>
        {role === 'owner' && (
          <label className="field">
            <span>Employee</span>
            <select
              className="input"
              onChange={(event) => setEmployeeId(event.target.value)}
              value={employeeId}
            >
              {employees
                .filter((employee) => employee.role !== 'Owner')
                .map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>Client</span>
          <select
            className="input"
            onChange={(event) => {
              setClientId(event.target.value)
              setTaskId('')
            }}
            value={effectiveClientId}
            disabled={locked}
          >
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Task</span>
          <select
            className="input"
            onChange={(event) => setTaskId(event.target.value)}
            value={effectiveTaskId}
            disabled={locked || eligibleTasks.length === 0}
          >
            <option value="">(none / general)</option>
            {eligibleTasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.title}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Hours spent</span>
          <input
            className="input"
            min="0.25"
            onChange={(event) => setHours(event.target.value)}
            step="0.25"
            type="number"
            value={hours}
            disabled={locked}
          />
        </label>
        <label className="field full-span">
          <span>What did you do?</span>
          <textarea
            className="input"
            onChange={(event) => setDescription(event.target.value)}
            rows={4}
            value={description}
            disabled={locked}
          />
        </label>
        <label className="check-row full-span">
          <input
            checked={billable}
            onChange={(event) => setBillable(event.target.checked)}
            type="checkbox"
            disabled={locked}
          />
          <span>Billable</span>
        </label>
        {submitError ? <p className="auth-error full-span">{submitError}</p> : null}
        <div className="button-row full-span">
          <button
            className="primary-action"
            disabled={submitPending || locked}
            type="submit"
          >
            <Clock3 size={16} />
            {submitPending ? 'Saving...' : 'Log time'}
          </button>
          {timer ? (
            <button
              className="secondary-action danger"
              disabled={submitPending || locked}
              onClick={() => void onStopTimer()}
              type="button"
            >
              <TimerReset size={16} />
              Stop &amp; log
            </button>
          ) : (
            <button
              className="secondary-action"
              disabled={submitPending || locked}
              onClick={handleStartTimer}
              type="button"
            >
              <TimerReset size={16} />
              Start timer
            </button>
          )}
        </div>
      </form>
    </section>
  )
}

function RecentTimeEntries({
  checklists,
  clients,
  employees,
  entries,
  role,
  locks,
  onUpdate,
  onDelete,
}: {
  checklists: Checklist[]
  clients: Client[]
  employees: Employee[]
  entries: TimeEntry[]
  role: Role
  locks: TimesheetLock[]
  onUpdate: (
    entryId: string,
    patch: { minutes?: number; description?: string; billable?: boolean; taskId?: string | null },
  ) => Promise<void>
  onDelete: (entryId: string) => Promise<void>
}) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">{role === 'owner' ? 'Team activity' : 'My activity'}</p>
          <h2>Recent time</h2>
        </div>
      </div>
      <div className="entry-list">
        {entries.slice(0, 6).map((entry) => {
          const linkedTask = entry.taskId
            ? checklists.find((checklist) => checklist.id === entry.taskId)
            : null
          // A bookkeeper cannot edit/delete entries in a locked month; owners can.
          const monthLocked =
            role !== 'owner' &&
            locks.some(
              (lock) =>
                lock.userId === entry.employeeId && lock.period === entry.date.slice(0, 7),
            )
          return (
            <TimeEntryRow
              key={entry.id}
              entry={entry}
              clientLabel={clientName(clients, entry.clientId)}
              employeeLabel={employeeName(employees, entry.employeeId)}
              taskTitle={linkedTask ? linkedTask.title : null}
              locked={monthLocked}
              onUpdate={onUpdate}
              onDelete={onDelete}
            />
          )
        })}
        {entries.length === 0 ? (
          <p className="empty-state">No time logged yet.</p>
        ) : null}
      </div>
    </section>
  )
}

function TimeEntryRow({
  entry,
  clientLabel,
  employeeLabel,
  taskTitle,
  locked,
  onUpdate,
  onDelete,
}: {
  entry: TimeEntry
  clientLabel: string
  employeeLabel: string
  taskTitle: string | null
  locked: boolean
  onUpdate: (
    entryId: string,
    patch: { minutes?: number; description?: string; billable?: boolean; taskId?: string | null },
  ) => Promise<void>
  onDelete: (entryId: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [hours, setHours] = useState((entry.minutes / 60).toString())
  const [description, setDescription] = useState(entry.description)
  const [billable, setBillable] = useState(entry.billable)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Pending and rejected entries are always editable; approved entries stay
  // editable until the month is locked. So a locked month is the only blocker.
  const canEdit = !locked

  const handleSave = async () => {
    const numericHours = Number(hours)
    if (Number.isNaN(numericHours) || numericHours <= 0) {
      setError('Enter a valid number of hours.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await onUpdate(entry.id, {
        minutes: Math.round(numericHours * 60),
        description,
        billable,
      })
      setEditing(false)
    } catch {
      setError('Could not save — the month may be locked.')
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    setBusy(true)
    setError('')
    try {
      await onDelete(entry.id)
    } catch {
      setError('Could not delete — the month may be locked.')
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <article className="entry-row entry-row-editing">
        <div className="entry-edit-fields">
          <label className="field">
            <span>Hours</span>
            <input
              className="input"
              min="0.25"
              step="0.25"
              type="number"
              value={hours}
              onChange={(event) => setHours(event.target.value)}
            />
          </label>
          <label className="field">
            <span>What did you do?</span>
            <textarea
              className="input"
              rows={2}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <label className="check-row">
            <input
              checked={billable}
              type="checkbox"
              onChange={(event) => setBillable(event.target.checked)}
            />
            <span>Billable</span>
          </label>
          {error ? <p className="auth-error">{error}</p> : null}
          <div className="button-row">
            <button
              className="primary-action"
              type="button"
              disabled={busy}
              onClick={() => void handleSave()}
            >
              {busy ? 'Saving...' : 'Save'}
            </button>
            <button
              className="secondary-action"
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(false)
                setError('')
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      </article>
    )
  }

  return (
    <article className="entry-row" key={entry.id}>
      <div>
        <strong>{clientLabel}</strong>
        <span>{entry.description}</span>
        <small>
          {entry.date} · {employeeLabel}
        </small>
        <div className="entry-tags">
          <StatusPill status={entry.approvalStatus} />
          {taskTitle ? <span className="task-chip">Task: {taskTitle}</span> : null}
        </div>
        {entry.approvalStatus === 'rejected' && entry.approvalNote ? (
          <small className="entry-reject-note">Rejected: {entry.approvalNote}</small>
        ) : null}
        {canEdit ? (
          <div className="entry-row-actions">
            <button
              type="button"
              className="link-action"
              disabled={busy}
              onClick={() => {
                setHours((entry.minutes / 60).toString())
                setDescription(entry.description)
                setBillable(entry.billable)
                setEditing(true)
              }}
            >
              {entry.approvalStatus === 'rejected' ? 'Edit & resubmit' : 'Edit'}
            </button>
            <button
              type="button"
              className="link-action danger"
              disabled={busy}
              onClick={() => void handleDelete()}
            >
              Delete
            </button>
          </div>
        ) : null}
        {error ? <small className="auth-error">{error}</small> : null}
      </div>
      <div className="entry-meta">
        <strong>{formatHours(entry.minutes)}</strong>
        <span>{entry.billable ? 'Billable' : 'Internal'}</span>
      </div>
    </article>
  )
}
