import { ChevronLeft, ChevronRight, Clock3, PencilLine, TimerReset } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useAppContext } from '../AppContext'
import type {
  Checklist,
  Client,
  Employee,
  Role,
  TimeEntry,
  TimerState,
  TimesheetLock,
  WeeklySubmission,
} from '../lib/types'
import {
  clientName,
  currentBillingPeriod,
  currentWeekStart,
  employeeName,
  formatHours,
  getWeekLabel,
  shiftWeek,
  weekRangeOf,
} from '../lib/utils'

export function TimePage() {
  const {
    activeEmployeeId,
    timeTrackingClients,
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
    previewMode,
    submitWeeklyTimesheet,
  } = useAppContext()

  // The viewed period is the current month. A bookkeeper whose timesheet is
  // locked for it loses add/edit/delete on this page.
  const currentPeriod = currentBillingPeriod()
  const lockedThisPeriod =
    role !== 'owner' &&
    (data.timesheetLocks ?? []).some(
      (lock) => lock.userId === activeEmployeeId && lock.period === currentPeriod,
    )

  // Manual entry is deliberately gated and is read-only when the timesheet is
  // locked or an owner is previewing — exactly like the timer inputs.
  const inputsDisabled = lockedThisPeriod || previewMode
  const [manualOpen, setManualOpen] = useState(false)

  return (
    <section className="content-grid" id="time">
      <header className="page-header time-page-header">
        <div>
          <p className="section-kicker">Time tracking</p>
          <h1>Time</h1>
        </div>
        <div className="page-header-actions">
          <button
            type="button"
            className="secondary-action"
            onClick={() => setManualOpen(true)}
            disabled={inputsDisabled}
            title={
              inputsDisabled
                ? 'Manual entry is unavailable while this timesheet is locked or in preview.'
                : undefined
            }
          >
            <PencilLine size={16} />
            Log time manually
          </button>
        </div>
      </header>

      {role !== 'owner' ? (
        <WeeklySubmissionWidget
          activeEmployeeId={activeEmployeeId}
          entries={visibleEntries}
          submissions={data.weeklySubmissions ?? []}
          employees={data.employees}
          previewMode={previewMode}
          onSubmit={submitWeeklyTimesheet}
        />
      ) : null}

      <div className="content-grid two-column">
        <TimeCapture
          activeEmployeeId={activeEmployeeId}
          clients={timeTrackingClients}
          checklists={data.checklists}
          employees={data.employees}
          onStartTimer={startTimer}
          onStopTimer={stopTimer}
          role={role}
          timer={timer}
          timerElapsed={timer ? timerElapsed : '0:00'}
          locked={lockedThisPeriod}
          previewMode={previewMode}
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
      </div>

      {manualOpen ? (
        <ManualEntryModal
          activeEmployeeId={activeEmployeeId}
          clients={timeTrackingClients}
          checklists={data.checklists}
          employees={data.employees}
          role={role}
          onLog={logTime}
          onClose={() => setManualOpen(false)}
        />
      ) : null}
    </section>
  )
}

/**
 * Weekly lock-for-review widget shown at the top of the time page for
 * bookkeepers / accountants. Lets the user pick a Sun-Sat week (defaulting
 * to the current week), shows the total hours logged that week, and the
 * submission's current status (none / pending / approved / rejected with
 * note). The "Submit week" button creates or upgrades the submission
 * server-side via `submitWeeklyTimesheet`. Owners aren't shown this
 * widget — they're the reviewers, not the submitters.
 */
function WeeklySubmissionWidget({
  activeEmployeeId,
  entries,
  submissions,
  employees,
  previewMode,
  onSubmit,
}: {
  activeEmployeeId: string
  entries: TimeEntry[]
  submissions: WeeklySubmission[]
  employees: Employee[]
  previewMode: boolean
  onSubmit: (weekStart: string) => Promise<void>
}) {
  const [weekStart, setWeekStart] = useState(currentWeekStart)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const { start, end } = weekRangeOf(weekStart)
  const submission = submissions.find(
    (entry) => entry.userId === activeEmployeeId && entry.weekStart === weekStart,
  )

  // Total minutes logged this user, this week.
  const weekTotal = useMemo(() => {
    return entries
      .filter(
        (entry) =>
          entry.employeeId === activeEmployeeId &&
          entry.date >= start &&
          entry.date <= end,
      )
      .reduce((sum, entry) => sum + entry.minutes, 0)
  }, [entries, activeEmployeeId, start, end])

  // Approved weeks are sealed — submitter can't re-submit; an owner would
  // need to unlock first (a future affordance). Pending blocks resubmit
  // until status changes. Rejected re-allows submit so the user can
  // resubmit after fixing whatever the owner flagged.
  const canSubmit = !previewMode && (!submission || submission.status === 'rejected')
  const buttonLabel =
    submission?.status === 'rejected'
      ? 'Resubmit this week'
      : submission?.status === 'pending'
        ? 'Awaiting review'
        : submission?.status === 'approved'
          ? 'Approved'
          : 'Submit week for review'

  const handleSubmit = async () => {
    if (!canSubmit || submitting) return
    setSubmitting(true)
    setError('')
    try {
      await onSubmit(weekStart)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submit failed')
    } finally {
      setSubmitting(false)
    }
  }

  const reviewer =
    submission?.reviewedBy && submission.status !== 'pending'
      ? employees.find((employee) => employee.id === submission.reviewedBy)?.name
      : null

  return (
    <section
      className="panel weekly-submission-widget"
      style={{ display: 'grid', gap: 12 }}
      aria-label="Weekly timesheet submission"
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            className="secondary-action"
            onClick={() => setWeekStart(shiftWeek(weekStart, -1))}
            title="Previous week"
            aria-label="Previous week"
          >
            <ChevronLeft size={14} />
          </button>
          <div>
            <p className="section-kicker" style={{ margin: 0 }}>
              Weekly timesheet
            </p>
            <h2 style={{ margin: 0 }}>{getWeekLabel(weekStart)}</h2>
          </div>
          <button
            type="button"
            className="secondary-action"
            onClick={() => setWeekStart(shiftWeek(weekStart, 1))}
            title="Next week"
            aria-label="Next week"
          >
            <ChevronRight size={14} />
          </button>
          {weekStart !== currentWeekStart() ? (
            <button
              type="button"
              className="secondary-action"
              onClick={() => setWeekStart(currentWeekStart())}
              title="Jump to this week"
            >
              Today
            </button>
          ) : null}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="status-pill">{formatHours(weekTotal)} logged</span>
          {submission?.status === 'pending' ? (
            <span className="status-pill">Pending review</span>
          ) : null}
          {submission?.status === 'approved' ? (
            <span className="status-pill">
              Approved{reviewer ? ` by ${reviewer}` : ''}
            </span>
          ) : null}
          {submission?.status === 'rejected' ? (
            <span className="status-pill">Rejected{reviewer ? ` by ${reviewer}` : ''}</span>
          ) : null}
          <button
            type="button"
            className="primary-action"
            disabled={!canSubmit || submitting}
            onClick={handleSubmit}
            title={
              submission?.status === 'approved'
                ? 'This week is already approved.'
                : submission?.status === 'pending'
                  ? 'Already submitted — an owner is reviewing.'
                  : previewMode
                    ? 'Cannot submit while previewing as another user.'
                    : 'Lock this week and send it to an owner for review.'
            }
          >
            {submitting ? 'Submitting…' : buttonLabel}
          </button>
        </div>
      </div>

      {submission?.status === 'rejected' && submission.reviewNote ? (
        <p className="auth-error" style={{ margin: 0 }}>
          <strong>Rejection note:</strong> {submission.reviewNote}
        </p>
      ) : null}
      {error ? <p className="auth-error">{error}</p> : null}
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

/** Small badge marking an entry that was logged through the manual form. */
function ManualBadge() {
  return <span className="manual-badge">Manual</span>
}

/**
 * The primary time-capture panel: the live timer. Manual logging has moved
 * into its own gated modal (see `ManualEntryModal`) — the timer is the
 * default, accurate flow.
 */
function TimeCapture({
  activeEmployeeId,
  clients,
  checklists,
  employees,
  onStartTimer,
  onStopTimer,
  role,
  timer,
  timerElapsed,
  locked,
  previewMode,
  currentPeriod,
}: {
  activeEmployeeId: string
  clients: Client[]
  checklists: Checklist[]
  employees: Employee[]
  onStartTimer: (timer: TimerState) => void
  onStopTimer: () => Promise<void>
  role: Role
  timer: TimerState | null
  timerElapsed: string
  locked: boolean
  previewMode: boolean
  currentPeriod: string
}) {
  const [clientId, setClientId] = useState(clients[0]?.id ?? '')
  const [employeeId, setEmployeeId] = useState(activeEmployeeId)
  const [description, setDescription] = useState('Reviewed transactions and added client notes.')
  const [taskId, setTaskId] = useState<string>('')
  const [busy, setBusy] = useState(false)
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

  // The timer panel is read-only when the timesheet is locked OR an owner is
  // previewing this person — preview mode must never be able to time work.
  const inputsDisabled = locked || previewMode

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

  const handleStopTimer = async () => {
    setBusy(true)
    try {
      await onStopTimer()
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Assigned to me</p>
          <h2>Live timer</h2>
        </div>
        <div className={timer ? 'timer-pill running' : 'timer-pill'}>
          <TimerReset size={16} />
          <span>{timer ? timerElapsed : '0:00'}</span>
        </div>
      </div>

      <p className="panel-intro">
        The timer is the most accurate way to log time. Pick a client and task, then start it
        when you begin work.
      </p>

      {locked ? (
        <div className="lock-banner">
          <strong>This timesheet is locked.</strong>
          <span>
            {currentPeriod} has been signed off. Contact an owner to make changes.
          </span>
        </div>
      ) : null}

      <div className="form-grid">
        {role === 'owner' && (
          <label className="field">
            <span>Employee</span>
            <select
              className="input"
              onChange={(event) => setEmployeeId(event.target.value)}
              value={employeeId}
              disabled={inputsDisabled || Boolean(timer)}
            >
              {/* Owners do billable work too — include everyone so an owner can
                  log their OWN time, not just a staff member's. */}
              {employees.map((employee) => (
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
            disabled={inputsDisabled || Boolean(timer)}
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
            disabled={inputsDisabled || Boolean(timer) || eligibleTasks.length === 0}
          >
            <option value="">(none / general)</option>
            {eligibleTasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.title}
              </option>
            ))}
          </select>
        </label>
        <label className="field full-span">
          <span>What did you do?</span>
          <textarea
            className="input"
            onChange={(event) => setDescription(event.target.value)}
            rows={4}
            value={description}
            disabled={inputsDisabled || Boolean(timer)}
          />
        </label>
        <div className="button-row full-span">
          {timer ? (
            <button
              className="primary-action danger"
              disabled={busy || inputsDisabled}
              onClick={() => void handleStopTimer()}
              type="button"
            >
              <TimerReset size={16} />
              {busy ? 'Saving...' : 'Stop & log'}
            </button>
          ) : (
            <button
              className="primary-action"
              disabled={busy || inputsDisabled || !effectiveClientId}
              onClick={handleStartTimer}
              type="button"
            >
              <TimerReset size={16} />
              Start timer
            </button>
          )}
        </div>
      </div>
    </section>
  )
}

/**
 * The gated manual-entry modal. Two steps:
 *   1. a confirmation nudging the user toward the timer;
 *   2. the manual entry form, with a REQUIRED reason for entering manually.
 * On submit the entry is created (pending approval, like every entry) and a
 * short success confirmation is shown before the modal closes.
 */
function ManualEntryModal({
  activeEmployeeId,
  clients,
  checklists,
  employees,
  role,
  onLog,
  onClose,
}: {
  activeEmployeeId: string
  clients: Client[]
  checklists: Checklist[]
  employees: Employee[]
  role: Role
  onLog: (entry: Omit<TimeEntry, 'id' | 'approvalStatus'>) => Promise<void>
  onClose: () => void
}) {
  const [step, setStep] = useState<'confirm' | 'form'>('confirm')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [employeeId, setEmployeeId] = useState(activeEmployeeId)
  const [clientId, setClientId] = useState(clients[0]?.id ?? '')
  const [hours, setHours] = useState('1.00')
  const [description, setDescription] = useState('')
  const [billable, setBillable] = useState(true)
  const [taskId, setTaskId] = useState<string>('')
  const [reason, setReason] = useState('')
  const [submitError, setSubmitError] = useState('')
  const [submitPending, setSubmitPending] = useState(false)
  const [success, setSuccess] = useState(false)

  // Close on Escape for keyboard parity with a native dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const effectiveClientId = clients.some((client) => client.id === clientId)
    ? clientId
    : clients[0]?.id ?? ''
  const effectiveEmployeeId = role === 'owner' ? employeeId : activeEmployeeId

  const eligibleTasks = useMemo(
    () => eligibleChecklistsFor(checklists, effectiveClientId, effectiveEmployeeId, role),
    [checklists, effectiveClientId, effectiveEmployeeId, role],
  )
  const effectiveTaskId = eligibleTasks.some((task) => task.id === taskId) ? taskId : ''

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const numericHours = Number(hours)
    if (!effectiveClientId || Number.isNaN(numericHours) || numericHours <= 0) {
      setSubmitError('Enter a valid client and number of hours.')
      return
    }
    if (!reason.trim()) {
      setSubmitError('A reason is required for manual entries.')
      return
    }
    if (!date) {
      setSubmitError('Choose a date for this entry.')
      return
    }

    setSubmitPending(true)
    setSubmitError('')

    try {
      await onLog({
        employeeId: effectiveEmployeeId,
        clientId: effectiveClientId,
        date,
        minutes: Math.round(numericHours * 60),
        description,
        billable,
        taskId: effectiveTaskId || null,
        entryMethod: 'manual',
        manualReason: reason.trim(),
      })
      setSuccess(true)
    } catch {
      setSubmitError('Manual entry could not be saved.')
    } finally {
      setSubmitPending(false)
    }
  }

  return (
    <div
      className="modal-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Log time manually"
      >
        {success ? (
          <div className="modal-body">
            <h2 className="modal-title">Manual entry submitted</h2>
            <p className="modal-intro">
              Manual entry submitted — an owner will review it.
            </p>
            <div className="button-row">
              <button type="button" className="primary-action" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        ) : step === 'confirm' ? (
          <div className="modal-body">
            <h2 className="modal-title">Enter time manually?</h2>
            <p className="modal-intro">
              Are you sure you want to enter time manually instead of using the timer? The
              timer records time more accurately.
            </p>
            <div className="button-row">
              <button type="button" className="secondary-action" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="primary-action"
                onClick={() => setStep('form')}
              >
                Yes, enter manually
              </button>
            </div>
          </div>
        ) : (
          <form className="modal-body" onSubmit={handleSubmit}>
            <h2 className="modal-title">Manual time entry</h2>
            <p className="modal-intro">
              This entry will be submitted for owner approval, like all time entries.
            </p>
            <div className="form-grid">
              <label className="field">
                <span>Date</span>
                <input
                  className="input"
                  type="date"
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                />
              </label>
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
              {role === 'owner' && (
                <label className="field">
                  <span>Employee</span>
                  <select
                    className="input"
                    value={employeeId}
                    onChange={(event) => setEmployeeId(event.target.value)}
                  >
                    {/* Include owners — an owner logs their own time too. */}
                    {employees.map((employee) => (
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
                  value={effectiveClientId}
                  onChange={(event) => {
                    setClientId(event.target.value)
                    setTaskId('')
                  }}
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
                  value={effectiveTaskId}
                  onChange={(event) => setTaskId(event.target.value)}
                  disabled={eligibleTasks.length === 0}
                >
                  <option value="">(none / general)</option>
                  {eligibleTasks.map((task) => (
                    <option key={task.id} value={task.id}>
                      {task.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="check-row full-span">
                <input
                  checked={billable}
                  onChange={(event) => setBillable(event.target.checked)}
                  type="checkbox"
                />
                <span>Billable</span>
              </label>
              <label className="field full-span">
                <span>Details</span>
                <textarea
                  className="input"
                  rows={3}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
              <label className="field full-span">
                <span>Why are you entering this manually instead of using the timer?</span>
                <textarea
                  className="input"
                  rows={3}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Required — e.g. forgot to start the timer."
                />
              </label>
            </div>
            {submitError ? <p className="auth-error">{submitError}</p> : null}
            <div className="button-row">
              <button type="button" className="secondary-action" onClick={onClose}>
                Cancel
              </button>
              <button
                type="submit"
                className="primary-action"
                disabled={submitPending}
              >
                <Clock3 size={16} />
                {submitPending ? 'Submitting...' : 'Submit for approval'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
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
          {entry.entryMethod === 'manual' ? <ManualBadge /> : null}
          {taskTitle ? <span className="task-chip">Task: {taskTitle}</span> : null}
        </div>
        {entry.entryMethod === 'manual' && entry.manualReason ? (
          <small className="entry-manual-reason">Manual reason: {entry.manualReason}</small>
        ) : null}
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
