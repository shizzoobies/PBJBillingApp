import {
  ChevronLeft,
  ChevronRight,
  Clock3,
  PencilLine,
  Play,
  Plus,
  TimerReset,
  Trash2,
} from 'lucide-react'
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
  WorkSession,
} from '../lib/types'
import {
  allocateGroupMinutes,
  clientName,
  currentBillingPeriod,
  currentWeekStart,
  employeeName,
  formatAuditStamp,
  formatHours,
  formatHoursMinutes,
  getWeekLabel,
  type GroupAllocationMode,
  sessionMinutes,
  shiftWeek,
  weekRangeOf,
} from '../lib/utils'

// ---- Exact start/stop capture: datetime-local <-> ISO helpers ------------
function pad2(value: number) {
  return String(value).padStart(2, '0')
}

/** Format a Date as a `datetime-local` input value in LOCAL time. */
function toLocalInput(date: Date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** ISO timestamp -> `datetime-local` value (local), or '' if missing/invalid. */
function isoToLocalInput(iso?: string) {
  if (!iso) return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : toLocalInput(date)
}

/** `datetime-local` value -> ISO timestamp, or '' if empty/invalid. */
function localInputToIso(value: string) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

/** Live duration between two `datetime-local` values, for the form hint. */
function formatDurationHint(startLocal: string, stopLocal: string) {
  const startMs = startLocal ? new Date(startLocal).getTime() : NaN
  const stopMs = stopLocal ? new Date(stopLocal).getTime() : NaN
  if (Number.isNaN(startMs) || Number.isNaN(stopMs) || stopMs <= startMs) {
    return '—'
  }
  return formatHoursMinutes(Math.round((stopMs - startMs) / 60000))
}

// ---- Sessions editor rows (local datetime strings + a stable key) ---------
let sessionRowSeq = 0
function makeSessionRowId() {
  sessionRowSeq += 1
  return `srow-${sessionRowSeq}`
}

/** The sessions an entry effectively has (synthesizing one from the envelope). */
function effectiveSessions(entry: TimeEntry): WorkSession[] {
  if (entry.sessions && entry.sessions.length > 0) return entry.sessions
  if (entry.startAt && entry.endAt) return [{ startAt: entry.startAt, endAt: entry.endAt }]
  return []
}

/** Build editor rows (datetime-local values) from an entry's sessions. */
function entryToEditSessions(entry: TimeEntry): Array<{ id: string; start: string; stop: string }> {
  return effectiveSessions(entry).map((s) => ({
    id: makeSessionRowId(),
    start: isoToLocalInput(s.startAt),
    stop: isoToLocalInput(s.endAt),
  }))
}

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
    updateTimer,
    cancelTimer,
    stopTimer,
    logTime,
    splitGroupEntry,
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
  // The unsplit group entry the owner is currently splitting (null = none).
  const [splitTarget, setSplitTarget] = useState<TimeEntry | null>(null)

  // Resume a pending entry: start a fresh timer bound to it. Stopping appends a
  // new session to that entry instead of creating a new one. Blocked while a
  // timer is already running (only one timer at a time).
  const handleResume = (entry: TimeEntry) => {
    if (timer || previewMode || lockedThisPeriod) return
    startTimer({
      employeeId: entry.employeeId,
      clientId: entry.clientId,
      description: entry.description,
      startedAt: Date.now(),
      taskId: entry.taskId ?? null,
      isAdministrative: Boolean(entry.isAdministrative),
      resumeEntryId: entry.id,
    })
  }

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
          onUpdateTimer={updateTimer}
          onCancelTimer={cancelTimer}
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
          timerRunning={Boolean(timer)}
          onUpdate={updateTimeEntry}
          onDelete={deleteTimeEntry}
          onResume={handleResume}
          onSplitGroup={(entry) => setSplitTarget(entry)}
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

      {splitTarget ? (
        <GroupSplitModal
          entry={splitTarget}
          clients={data.clients}
          onSplit={splitGroupEntry}
          onClose={() => setSplitTarget(null)}
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
  onUpdateTimer,
  onCancelTimer,
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
  onStopTimer: (descriptionOverride?: string) => Promise<void>
  onUpdateTimer: (patch: Partial<TimerState>) => void
  onCancelTimer: () => void
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
  const [isAdministrative, setIsAdministrative] = useState(false)
  const [busy, setBusy] = useState(false)
  // Group timing (owner-only): track one block against several clients, chosen
  // up front, then split it for billing later.
  const canGroup = role === 'owner'
  const [billTo, setBillTo] = useState<'single' | 'group'>('single')
  const [groupClientIds, setGroupClientIds] = useState<string[]>([])
  const groupMode = canGroup && billTo === 'group' && !isAdministrative
  const toggleGroupClient = (id: string) => {
    setGroupClientIds((current) =>
      current.includes(id) ? current.filter((existing) => existing !== id) : [...current, id],
    )
  }
  const effectiveClientId = clients.some((client) => client.id === clientId)
    ? clientId
    : clients[0]?.id ?? ''
  // Owners pick the employee; fall back to themselves (activeEmployeeId) when
  // the selection is missing/invalid so time is never attributed to a stale id.
  const effectiveEmployeeId =
    role === 'owner'
      ? employees.some((employee) => employee.id === employeeId)
        ? employeeId
        : activeEmployeeId
      : activeEmployeeId

  // A timer is running for this user. While running, the form DISPLAYS the
  // timer's own state (so a tab switch / refresh restores client + notes), and
  // client / task / notes edits update the running timer instead of the
  // compose-state. Structural choices (employee, admin, group) are locked.
  const isRunning = Boolean(timer)
  const taskClientId = isRunning ? timer?.clientId ?? '' : effectiveClientId

  const eligibleTasks = useMemo(
    () => eligibleChecklistsFor(checklists, taskClientId, effectiveEmployeeId, role),
    [checklists, taskClientId, effectiveEmployeeId, role],
  )

  // Reset taskId if the previously-chosen task isn't valid for the new client.
  const effectiveTaskId = eligibleTasks.some((task) => task.id === taskId) ? taskId : ''

  // The timer panel is read-only when the timesheet is locked OR an owner is
  // previewing this person — preview mode must never be able to time work.
  const inputsDisabled = locked || previewMode

  const runningGroup = (timer?.groupClientIds?.length ?? 0) > 0
  const runningAdmin = Boolean(timer?.isAdministrative)
  const shownBillTo = isRunning ? (runningGroup ? 'group' : 'single') : billTo
  const shownAdmin = isRunning ? runningAdmin : isAdministrative
  const shownGroupMode = isRunning ? runningGroup : groupMode
  const shownClientId = isRunning ? timer?.clientId ?? '' : effectiveClientId
  const shownTaskId = isRunning ? timer?.taskId ?? '' : effectiveTaskId
  const shownGroupIds = isRunning ? timer?.groupClientIds ?? [] : groupClientIds
  const shownDescription = isRunning ? timer?.description ?? '' : description
  const shownEmployeeId = isRunning ? timer?.employeeId ?? employeeId : employeeId

  const handleStartTimer = () => {
    if (groupMode) {
      if (groupClientIds.length === 0) return
      onStartTimer({
        employeeId: effectiveEmployeeId,
        clientId: '',
        description: description || 'Group time',
        startedAt: Date.now(),
        taskId: null,
        isAdministrative: false,
        groupClientIds,
      })
      return
    }
    if (!isAdministrative && !effectiveClientId) {
      return
    }

    onStartTimer({
      employeeId: effectiveEmployeeId,
      clientId: isAdministrative ? '' : effectiveClientId,
      description:
        description || (isAdministrative ? 'Administrative time' : 'Timed bookkeeping work'),
      startedAt: Date.now(),
      taskId: isAdministrative ? null : effectiveTaskId || null,
      isAdministrative,
    })
  }

  const handleStopTimer = async () => {
    setBusy(true)
    try {
      // The live notes are kept on the running timer now, so stop with no
      // override and let it use the timer's own (persisted) description.
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

      {timer?.resumeEntryId ? (
        <div className="resume-banner">
          <Play size={15} />
          <span>
            Resuming{' '}
            <strong>
              {timer.isAdministrative ? 'Administrative' : clientName(clients, timer.clientId)}
            </strong>{' '}
            — when you stop, this session is added to that pending entry.
          </span>
        </div>
      ) : null}

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
              value={shownEmployeeId}
              disabled={inputsDisabled || isRunning}
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
        {canGroup && !shownAdmin ? (
          <label className="field full-span">
            <span>Track time for</span>
            <select
              className="input"
              value={shownBillTo}
              onChange={(event) => setBillTo(event.target.value as 'single' | 'group')}
              disabled={inputsDisabled || isRunning}
            >
              <option value="single">A single client</option>
              <option value="group">A group (split for billing later)</option>
            </select>
          </label>
        ) : null}
        {shownBillTo === 'single' ? (
          <label className="check-row full-span">
            <input
              checked={shownAdmin}
              onChange={(event) => setIsAdministrative(event.target.checked)}
              type="checkbox"
              disabled={inputsDisabled || isRunning}
            />
            <span>Administrative work (company meeting, internal — no client or task)</span>
          </label>
        ) : null}
        {shownGroupMode ? (
          <>
            <div className="field full-span group-time-block">
              <span>Clients in this group</span>
              <div className="group-client-grid">
                {clients.map((client) => {
                  const selected = shownGroupIds.includes(client.id)
                  return (
                    <label
                      key={client.id}
                      className={`group-client-chip${selected ? ' is-selected' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleGroupClient(client.id)}
                        disabled={inputsDisabled || isRunning}
                      />
                      <span>{client.name}</span>
                    </label>
                  )
                })}
              </div>
            </div>
            <p className="field full-span group-split-hint">
              Track normally, then <strong>Split across clients</strong> on the saved entry to
              divide the time for billing.
            </p>
          </>
        ) : shownAdmin ? null : (
          <>
            <label className="field">
              <span>Client</span>
              <select
                className="input"
                onChange={(event) => {
                  // Mid-timer client change ("saw a squirrel") updates the
                  // running timer; otherwise it sets the compose-state.
                  if (isRunning) {
                    onUpdateTimer({ clientId: event.target.value, taskId: null })
                  } else {
                    setClientId(event.target.value)
                  }
                  setTaskId('')
                }}
                value={shownClientId}
                disabled={inputsDisabled}
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
                onChange={(event) => {
                  const value = event.target.value
                  if (isRunning) onUpdateTimer({ taskId: value || null })
                  else setTaskId(value)
                }}
                value={shownTaskId}
                disabled={inputsDisabled || eligibleTasks.length === 0}
              >
                <option value="">(none / general)</option>
                {eligibleTasks.map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.title}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <label className="field full-span">
          <span>{shownAdmin ? 'Notes (what was this for?)' : 'What did you do?'}</span>
          {/* While a timer runs the notes live on the timer itself (persisted),
              so a tab switch / refresh keeps them. */}
          <textarea
            className="input"
            onChange={(event) => {
              if (isRunning) onUpdateTimer({ description: event.target.value })
              else setDescription(event.target.value)
            }}
            rows={4}
            value={shownDescription}
            disabled={inputsDisabled}
          />
        </label>
        <div className="button-row full-span">
          {timer ? (
            <>
              <button
                className="primary-action danger"
                disabled={busy || inputsDisabled}
                onClick={() => void handleStopTimer()}
                type="button"
              >
                <TimerReset size={16} />
                {busy ? 'Saving...' : 'Stop & log'}
              </button>
              <button
                className="secondary-action"
                disabled={busy || inputsDisabled}
                onClick={() => {
                  if (window.confirm('Discard this timer without logging the time?')) {
                    onCancelTimer()
                  }
                }}
                type="button"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              className="primary-action"
              disabled={
                busy ||
                inputsDisabled ||
                (groupMode
                  ? groupClientIds.length === 0
                  : !isAdministrative && !effectiveClientId)
              }
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
  // Group billing (owner-only): allocate one block of time across MULTIPLE
  // clients at once, each billed independently. Brittany picks "Group", selects
  // the clients, and chooses how to split the time (even / full to each /
  // custom per-client amounts).
  const canGroup = role === 'owner'
  const [billTo, setBillTo] = useState<'single' | 'group'>('single')
  const [groupClientIds, setGroupClientIds] = useState<string[]>([])
  // Exact start/stop the employee enters, so the owner can audit. Default to a
  // one-hour block ending now; duration is derived from the span.
  const [startLocal, setStartLocal] = useState(() => {
    const start = new Date()
    start.setHours(start.getHours() - 1)
    return toLocalInput(start)
  })
  const [stopLocal, setStopLocal] = useState(() => toLocalInput(new Date()))
  const [employeeId, setEmployeeId] = useState(activeEmployeeId)
  const [clientId, setClientId] = useState(clients[0]?.id ?? '')
  const [description, setDescription] = useState('')
  const [billable, setBillable] = useState(true)
  const [taskId, setTaskId] = useState<string>('')
  const [isAdministrative, setIsAdministrative] = useState(false)
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
  // Owners pick the employee; fall back to themselves (activeEmployeeId) when
  // the selection is missing/invalid so time is never attributed to a stale id.
  const effectiveEmployeeId =
    role === 'owner'
      ? employees.some((employee) => employee.id === employeeId)
        ? employeeId
        : activeEmployeeId
      : activeEmployeeId

  const eligibleTasks = useMemo(
    () => eligibleChecklistsFor(checklists, effectiveClientId, effectiveEmployeeId, role),
    [checklists, effectiveClientId, effectiveEmployeeId, role],
  )
  const effectiveTaskId = eligibleTasks.some((task) => task.id === taskId) ? taskId : ''

  // Group billing (owner-only): track ONE block against multiple clients, then
  // split it for billing later. Here she just picks the member clients; the
  // split (even / full / custom) happens afterward via the Split action.
  const groupMode = canGroup && billTo === 'group' && !isAdministrative

  const toggleGroupClient = (id: string) => {
    setGroupClientIds((current) =>
      current.includes(id) ? current.filter((existing) => existing !== id) : [...current, id],
    )
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const startMs = startLocal ? new Date(startLocal).getTime() : NaN
    const stopMs = stopLocal ? new Date(stopLocal).getTime() : NaN
    if (Number.isNaN(startMs) || Number.isNaN(stopMs)) {
      setSubmitError('Enter a valid start and stop date/time.')
      return
    }
    if (stopMs <= startMs) {
      setSubmitError('The stop time must be after the start time.')
      return
    }
    const totalMinutes = Math.round((stopMs - startMs) / 60000)
    if (totalMinutes <= 0) {
      setSubmitError('Start and stop must be at least a minute apart.')
      return
    }
    if (!isAdministrative && !effectiveClientId) {
      setSubmitError('Select a client, or check "Administrative work".')
      return
    }
    if (isAdministrative && !description.trim()) {
      setSubmitError('Add notes describing the administrative work.')
      return
    }
    if (!reason.trim()) {
      setSubmitError('A reason is required for manual entries.')
      return
    }

    // Group billing: save ONE unsplit holding entry carrying the member
    // clients (no single client, not billable). The owner splits it across the
    // members for billing later via the "Split across clients" action.
    if (groupMode) {
      if (groupClientIds.length === 0) {
        setSubmitError('Pick at least one client for the group.')
        return
      }
      setSubmitPending(true)
      setSubmitError('')
      try {
        await onLog({
          employeeId: effectiveEmployeeId,
          clientId: '',
          isAdministrative: false,
          groupClientIds,
          date: startLocal.slice(0, 10),
          minutes: totalMinutes,
          description,
          billable: false,
          taskId: null,
          entryMethod: 'manual',
          manualReason: reason.trim(),
          startAt: localInputToIso(startLocal),
          endAt: localInputToIso(stopLocal),
          sessions: [{ startAt: localInputToIso(startLocal), endAt: localInputToIso(stopLocal) }],
        })
        setSuccess(true)
      } catch {
        setSubmitError('Group time could not be saved.')
      } finally {
        setSubmitPending(false)
      }
      return
    }

    setSubmitPending(true)
    setSubmitError('')

    try {
      await onLog({
        employeeId: effectiveEmployeeId,
        clientId: isAdministrative ? '' : effectiveClientId,
        isAdministrative,
        // Entry date follows the (local) start day.
        date: startLocal.slice(0, 10),
        minutes: totalMinutes,
        description,
        billable: isAdministrative ? false : billable,
        taskId: isAdministrative ? null : effectiveTaskId || null,
        entryMethod: 'manual',
        manualReason: reason.trim(),
        startAt: localInputToIso(startLocal),
        endAt: localInputToIso(stopLocal),
        sessions: [
          { startAt: localInputToIso(startLocal), endAt: localInputToIso(stopLocal) },
        ],
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
                <span>Started</span>
                <input
                  className="input"
                  type="datetime-local"
                  value={startLocal}
                  onChange={(event) => setStartLocal(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Stopped</span>
                <input
                  className="input"
                  type="datetime-local"
                  value={stopLocal}
                  onChange={(event) => setStopLocal(event.target.value)}
                />
              </label>
              <p className="field full-span manual-duration-hint">
                Duration: {formatDurationHint(startLocal, stopLocal)}
              </p>
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
              {canGroup && !isAdministrative ? (
                <label className="field full-span">
                  <span>Bill to</span>
                  <select
                    className="input"
                    value={billTo}
                    onChange={(event) => setBillTo(event.target.value as 'single' | 'group')}
                  >
                    <option value="single">A single client</option>
                    <option value="group">A group (multiple clients)</option>
                  </select>
                </label>
              ) : null}
              {billTo === 'single' ? (
                <label className="check-row full-span">
                  <input
                    checked={isAdministrative}
                    onChange={(event) => setIsAdministrative(event.target.checked)}
                    type="checkbox"
                  />
                  <span>Administrative work (company meeting, internal — no client or task)</span>
                </label>
              ) : null}
              {groupMode ? (
                <>
                  <div className="field full-span group-time-block">
                    <span>Clients in this group</span>
                    <div className="group-client-grid">
                      {clients.map((client) => {
                        const selected = groupClientIds.includes(client.id)
                        return (
                          <label
                            key={client.id}
                            className={`group-client-chip${selected ? ' is-selected' : ''}`}
                          >
                            <input
                              type="checkbox"
                              checked={selected}
                              onChange={() => toggleGroupClient(client.id)}
                            />
                            <span>{client.name}</span>
                          </label>
                        )
                      })}
                    </div>
                  </div>
                  <p className="field full-span group-split-hint">
                    Saved as one un-split group entry. Use{' '}
                    <strong>Split across clients</strong> on it (in Recent time) to divide the time
                    for billing — evenly, the full duration to each, or a custom split.
                  </p>
                </>
              ) : isAdministrative ? null : (
                <>
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
                </>
              )}
              <label className="field full-span">
                <span>{isAdministrative ? 'Notes (what was this for?)' : 'Details'}</span>
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

/**
 * Splits an unsplit group holding entry across its member clients. The owner
 * picks how to divide the tracked block — evenly, the full duration to each, or
 * a custom per-client split — sees a live preview, and confirms. On confirm the
 * holding entry is replaced by one billable entry per client.
 */
function GroupSplitModal({
  entry,
  clients,
  onSplit,
  onClose,
}: {
  entry: TimeEntry
  clients: Client[]
  onSplit: (
    holding: TimeEntry,
    mode: GroupAllocationMode,
    customMinutes: Record<string, number>,
  ) => Promise<void>
  onClose: () => void
}) {
  const memberIds = useMemo(
    () => (Array.isArray(entry.groupClientIds) ? entry.groupClientIds : []),
    [entry.groupClientIds],
  )
  const [mode, setMode] = useState<GroupAllocationMode>('even')
  const [customMinutes, setCustomMinutes] = useState<Record<string, string>>({})
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const customMinutesNumeric = useMemo(() => {
    const out: Record<string, number> = {}
    for (const id of memberIds) out[id] = Number(customMinutes[id])
    return out
  }, [memberIds, customMinutes])

  const allocation = useMemo(
    () => allocateGroupMinutes(entry.minutes, memberIds, mode, customMinutesNumeric),
    [entry.minutes, memberIds, mode, customMinutesNumeric],
  )
  const totalBilled = Object.values(allocation).reduce((sum, minutes) => sum + (minutes || 0), 0)

  const handleConfirm = async () => {
    const hasAny = memberIds.some((id) => (allocation[id] ?? 0) > 0)
    if (!hasAny) {
      setError(
        mode === 'custom'
          ? 'Enter minutes greater than 0 for at least one client.'
          : 'The tracked time is too short to split.',
      )
      return
    }
    setPending(true)
    setError('')
    try {
      await onSplit(entry, mode, customMinutesNumeric)
      onClose()
    } catch {
      setError('Could not split this group entry.')
      setPending(false)
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
      <div className="modal-panel" role="dialog" aria-modal="true" aria-label="Split group time">
        <div className="modal-body">
          <h2 className="modal-title">Split group time</h2>
          <p className="modal-intro">
            {formatHoursMinutes(entry.minutes)} tracked across {memberIds.length}{' '}
            {memberIds.length === 1 ? 'client' : 'clients'}. Choose how to bill it — this replaces
            the group entry with one billable entry per client.
          </p>
          <div className="form-grid">
            <label className="field full-span">
              <span>How should the time be split?</span>
              <select
                className="input"
                value={mode}
                onChange={(event) => setMode(event.target.value as GroupAllocationMode)}
              >
                <option value="even">Split evenly across clients</option>
                <option value="full">Full duration to each client</option>
                <option value="custom">Custom — set each client&apos;s time</option>
              </select>
            </label>
            <div className="field full-span group-allocation-preview">
              <span>{mode === 'custom' ? 'Minutes per client' : 'Allocation'}</span>
              <ul className="group-allocation-list">
                {memberIds.map((id) => (
                  <li key={id}>
                    <span className="group-allocation-name">{clientName(clients, id)}</span>
                    {mode === 'custom' ? (
                      <input
                        className="input group-allocation-input"
                        type="number"
                        min="0"
                        step="1"
                        value={customMinutes[id] ?? ''}
                        onChange={(event) =>
                          setCustomMinutes((prev) => ({ ...prev, [id]: event.target.value }))
                        }
                        placeholder="min"
                      />
                    ) : (
                      <span className="group-allocation-amount">
                        {formatHoursMinutes(allocation[id] ?? 0)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              <p className="group-allocation-total">
                Total billed: {formatHoursMinutes(totalBilled)}
                {mode === 'full' && memberIds.length > 1
                  ? ` — ${formatHoursMinutes(entry.minutes)} to each of ${memberIds.length} clients`
                  : ''}
              </p>
            </div>
          </div>
          {error ? <p className="auth-error">{error}</p> : null}
          <div className="button-row">
            <button type="button" className="secondary-action" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="primary-action"
              disabled={pending}
              onClick={() => void handleConfirm()}
            >
              <Clock3 size={16} />
              {pending ? 'Splitting...' : 'Split & bill'}
            </button>
          </div>
        </div>
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
  timerRunning,
  onUpdate,
  onDelete,
  onResume,
  onSplitGroup,
}: {
  checklists: Checklist[]
  clients: Client[]
  employees: Employee[]
  entries: TimeEntry[]
  role: Role
  locks: TimesheetLock[]
  timerRunning: boolean
  onUpdate: (
    entryId: string,
    patch: {
      minutes?: number
      description?: string
      billable?: boolean
      taskId?: string | null
      startAt?: string
      endAt?: string
      sessions?: WorkSession[]
    },
  ) => Promise<void>
  onDelete: (entryId: string) => Promise<void>
  onResume: (entry: TimeEntry) => void
  onSplitGroup: (entry: TimeEntry) => void
}) {
  // Most-recently-worked first, so "what I just did" sits at the top and is
  // easy to find / edit. Falls back endAt -> startAt -> date.
  const recencyKey = (entry: TimeEntry) => {
    const sessions = entry.sessions ?? []
    const lastSession = sessions.length > 0 ? sessions[sessions.length - 1] : null
    return lastSession?.endAt ?? entry.endAt ?? entry.startAt ?? `${entry.date}T00:00:00`
  }
  const sortedEntries = [...entries].sort((a, b) => recencyKey(b).localeCompare(recencyKey(a)))
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">{role === 'owner' ? 'Team activity' : 'My activity'}</p>
          <h2>Recent time</h2>
        </div>
      </div>
      <div className="entry-list">
        {sortedEntries.slice(0, 8).map((entry) => {
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
          const memberCount = entry.groupClientIds?.length ?? 0
          const isHolding = !entry.clientId && !entry.isAdministrative && memberCount > 0
          const clientLabel = isHolding
            ? `Group · ${memberCount} ${memberCount === 1 ? 'client' : 'clients'}`
            : entry.isAdministrative
              ? 'Administrative'
              : clientName(clients, entry.clientId)
          return (
            <TimeEntryRow
              key={entry.id}
              entry={entry}
              clientLabel={clientLabel}
              employeeLabel={employeeName(employees, entry.employeeId)}
              taskTitle={linkedTask ? linkedTask.title : null}
              locked={monthLocked}
              timerRunning={timerRunning}
              employees={employees}
              isOwner={role === 'owner'}
              isHolding={isHolding}
              onUpdate={onUpdate}
              onDelete={onDelete}
              onResume={onResume}
              onSplitGroup={onSplitGroup}
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
  timerRunning,
  employees,
  isOwner,
  isHolding,
  onUpdate,
  onDelete,
  onResume,
  onSplitGroup,
}: {
  entry: TimeEntry
  clientLabel: string
  employeeLabel: string
  taskTitle: string | null
  locked: boolean
  timerRunning: boolean
  employees: Employee[]
  isOwner: boolean
  isHolding: boolean
  onUpdate: (
    entryId: string,
    patch: {
      minutes?: number
      description?: string
      billable?: boolean
      taskId?: string | null
      startAt?: string
      endAt?: string
      sessions?: WorkSession[]
      employeeId?: string
    },
  ) => Promise<void>
  onDelete: (entryId: string) => Promise<void>
  onResume: (entry: TimeEntry) => void
  onSplitGroup: (entry: TimeEntry) => void
}) {
  // Entries captured with exact start/stop (timer + new manual entries) edit
  // via a sessions editor; legacy entries without timestamps keep the simpler
  // hours/minutes editor.
  const sessions = effectiveSessions(entry)
  const hasSessions = sessions.length > 0
  const [editing, setEditing] = useState(false)
  const [hours, setHours] = useState(Math.floor(entry.minutes / 60).toString())
  const [minutes, setMinutes] = useState((entry.minutes % 60).toString())
  const [editSessions, setEditSessions] = useState(() => entryToEditSessions(entry))
  const [description, setDescription] = useState(entry.description)
  const [billable, setBillable] = useState(entry.billable)
  const [reassignTo, setReassignTo] = useState(entry.employeeId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Pending and rejected entries are always editable; approved entries stay
  // editable until the month is locked. So a locked month is the only blocker.
  const canEdit = !locked
  // Resume / Add-time stay inside the approval pipeline (pending or rejected),
  // and only make sense for entries that already track sessions.
  const canResumeOrAdd =
    canEdit &&
    hasSessions &&
    (entry.approvalStatus === 'pending' || entry.approvalStatus === 'rejected')

  // Open the editor; `withExtraSession` pre-appends a fresh session (continuing
  // from the last stop to now) so "Add time" is one click.
  const openEditor = (withExtraSession: boolean) => {
    const rows = entryToEditSessions(entry)
    if (withExtraSession) {
      const last = rows[rows.length - 1]
      rows.push({
        id: makeSessionRowId(),
        start: last ? last.stop : toLocalInput(new Date()),
        stop: toLocalInput(new Date()),
      })
    }
    setEditSessions(rows)
    setHours(Math.floor(entry.minutes / 60).toString())
    setMinutes((entry.minutes % 60).toString())
    setDescription(entry.description)
    setBillable(entry.billable)
    setReassignTo(entry.employeeId)
    setError('')
    setEditing(true)
  }

  // Owner-only: reassign this entry to another team member when the picked
  // employee differs from the current one. Empty otherwise.
  const reassignPatch =
    isOwner && reassignTo && reassignTo !== entry.employeeId ? { employeeId: reassignTo } : {}

  const updateSessionRow = (id: string, patch: { start?: string; stop?: string }) =>
    setEditSessions((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  const addSessionRow = () =>
    setEditSessions((rows) => {
      const last = rows[rows.length - 1]
      return [
        ...rows,
        {
          id: makeSessionRowId(),
          start: last ? last.stop : toLocalInput(new Date()),
          stop: toLocalInput(new Date()),
        },
      ]
    })
  const removeSessionRow = (id: string) =>
    setEditSessions((rows) => rows.filter((row) => row.id !== id))

  const editTotalMinutes = editSessions.reduce((sum, row) => {
    const startMs = row.start ? new Date(row.start).getTime() : NaN
    const stopMs = row.stop ? new Date(row.stop).getTime() : NaN
    if (Number.isNaN(startMs) || Number.isNaN(stopMs) || stopMs <= startMs) return sum
    return sum + Math.round((stopMs - startMs) / 60000)
  }, 0)

  const handleSave = async () => {
    if (hasSessions) {
      if (editSessions.length === 0) {
        setError('Keep at least one work session.')
        return
      }
      const built: WorkSession[] = []
      for (const row of editSessions) {
        const startMs = row.start ? new Date(row.start).getTime() : NaN
        const stopMs = row.stop ? new Date(row.stop).getTime() : NaN
        if (Number.isNaN(startMs) || Number.isNaN(stopMs)) {
          setError('Each session needs a valid start and stop time.')
          return
        }
        if (stopMs <= startMs) {
          setError('Each session must stop after it starts.')
          return
        }
        built.push({ startAt: localInputToIso(row.start), endAt: localInputToIso(row.stop) })
      }
      setBusy(true)
      setError('')
      try {
        await onUpdate(entry.id, { sessions: built, description, billable, ...reassignPatch })
        setEditing(false)
      } catch {
        setError('Could not save — the month may be locked.')
      } finally {
        setBusy(false)
      }
      return
    }

    const hoursPart = hours.trim() === '' ? 0 : Number(hours)
    const minutesPart = minutes.trim() === '' ? 0 : Number(minutes)
    if (
      Number.isNaN(hoursPart) ||
      Number.isNaN(minutesPart) ||
      hoursPart < 0 ||
      minutesPart < 0
    ) {
      setError('Enter a valid number of hours and minutes.')
      return
    }
    const totalMinutes = Math.round(hoursPart * 60 + minutesPart)
    if (totalMinutes <= 0) {
      setError('Enter hours and/or minutes greater than zero.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await onUpdate(entry.id, { minutes: totalMinutes, description, billable, ...reassignPatch })
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
          {isOwner ? (
            <label className="field">
              <span>Team member</span>
              <select
                className="input"
                value={reassignTo}
                onChange={(event) => setReassignTo(event.target.value)}
              >
                {employees.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {hasSessions ? (
            <div className="session-editor">
              <span className="session-editor-label">Work sessions</span>
              {editSessions.map((row) => (
                <div className="session-edit-row" key={row.id}>
                  <label className="field">
                    <span>Started</span>
                    <input
                      className="input"
                      type="datetime-local"
                      value={row.start}
                      onChange={(event) => updateSessionRow(row.id, { start: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>Stopped</span>
                    <input
                      className="input"
                      type="datetime-local"
                      value={row.stop}
                      onChange={(event) => updateSessionRow(row.id, { stop: event.target.value })}
                    />
                  </label>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Remove session"
                    disabled={editSessions.length <= 1}
                    onClick={() => removeSessionRow(row.id)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
              <div className="session-editor-foot">
                <button type="button" className="ghost-action" onClick={addSessionRow}>
                  <Plus size={14} />
                  Add session
                </button>
                <span className="session-editor-total">
                  Total: {formatHoursMinutes(editTotalMinutes)}
                </span>
              </div>
            </div>
          ) : (
            <>
              <label className="field">
                <span>Hours</span>
                <input
                  className="input"
                  min="0"
                  step="1"
                  type="number"
                  value={hours}
                  onChange={(event) => setHours(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Minutes</span>
                <input
                  className="input"
                  min="0"
                  step="1"
                  type="number"
                  value={minutes}
                  onChange={(event) => setMinutes(event.target.value)}
                />
              </label>
            </>
          )}
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

  // Unsplit group holding entry: a tracked block waiting to be split across its
  // member clients for billing. Shown compactly with a Split action (owner).
  if (isHolding) {
    const memberCount = entry.groupClientIds?.length ?? 0
    return (
      <article className="entry-row entry-row-holding" key={entry.id}>
        <div>
          <strong>
            {clientLabel}
            <span className="entry-needs-split">Needs split</span>
          </strong>
          <span>{entry.description}</span>
          <small>
            {entry.date} · {employeeLabel} · {formatHoursMinutes(entry.minutes)} across{' '}
            {memberCount} {memberCount === 1 ? 'client' : 'clients'}
          </small>
          {error ? <small className="auth-error">{error}</small> : null}
        </div>
        <div className="entry-meta">
          {isOwner ? (
            <button
              type="button"
              className="secondary-action"
              disabled={busy || locked}
              onClick={() => onSplitGroup(entry)}
            >
              Split across clients
            </button>
          ) : null}
          {canEdit ? (
            <button
              type="button"
              className="link-button danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                setError('')
                try {
                  await onDelete(entry.id)
                } catch {
                  setError('Could not delete.')
                } finally {
                  setBusy(false)
                }
              }}
            >
              <Trash2 size={14} />
            </button>
          ) : null}
        </div>
      </article>
    )
  }

  return (
    <article className="entry-row" key={entry.id}>
      <div>
        <strong>
          {clientLabel}
          {entry.groupId ? <span className="entry-group-tag">Group</span> : null}
        </strong>
        <span>{entry.description}</span>
        <small>
          {entry.date} · {employeeLabel}
        </small>
        {hasSessions ? (
          <div className="entry-sessions">
            {sessions.map((session, index) => (
              <small className="entry-audit-times" key={`${session.startAt}-${index}`}>
                {sessions.length > 1 ? `${index + 1}. ` : ''}
                {formatAuditStamp(session.startAt)} → {formatAuditStamp(session.endAt)} ·{' '}
                {formatHoursMinutes(sessionMinutes(session))}
              </small>
            ))}
          </div>
        ) : null}
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
              onClick={() => openEditor(false)}
            >
              {entry.approvalStatus === 'rejected' ? 'Edit & resubmit' : 'Edit'}
            </button>
            {canResumeOrAdd ? (
              <>
                <button
                  type="button"
                  className="link-action"
                  disabled={busy || timerRunning}
                  title={timerRunning ? 'Stop the running timer first' : undefined}
                  onClick={() => onResume(entry)}
                >
                  <Play size={13} />
                  Resume
                </button>
                <button
                  type="button"
                  className="link-action"
                  disabled={busy}
                  onClick={() => openEditor(true)}
                >
                  Add time
                </button>
              </>
            ) : null}
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
        <strong>{formatHoursMinutes(entry.minutes)}</strong>
        <span>{entry.billable ? 'Billable' : 'Internal'}</span>
      </div>
    </article>
  )
}
