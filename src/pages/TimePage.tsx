import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  PencilLine,
  Play,
  Plus,
  TimerReset,
  Trash2,
} from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useAppContext } from '../AppContext'
import { ReportPeriodControl } from '../components/ReportPeriodControl'
import { SubmitTimesheetModal } from '../components/SubmitTimesheetModal'
import {
  TIME_ENTRY_FIELD_PROMPTS,
  validateTimeEntryRequiredFields,
  type TimeEntryRequiredField,
} from '../../lib/time-entry.js'
import { isInReportPeriod } from '../lib/reportPeriod'
import { selectableClients } from '../lib/clientLifecycle'
import {
  buildTimeTaskOptions,
  resolveTimeTaskChoice,
  type TimeTaskOption,
} from '../lib/timeTaskOptions'
import { ApiError } from '../lib/types'
import type {
  Checklist,
  ChecklistTemplate,
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
  allocateByPercentages,
  allocateGroupMinutes,
  classifySplitTarget,
  clientName,
  currentBillingPeriod,
  currentWeekStart,
  effectiveSessions,
  eligibleChecklistsFor,
  employeeName,
  formatAuditStamp,
  formatHoursMinutes,
  getWeekLabel,
  isGroupHoldingEntry,
  type GroupAllocationMode,
  makeId,
  minutesAfterEntryEdit,
  minutesToSeconds,
  percentagesFromMinutes,
  percentagesTotalTo100,
  sessionMinutes,
  shiftWeek,
  splitClientOptions,
  splitGroupPrefill,
  weekRangeOf,
} from '../lib/utils'

/**
 * The client picker's opening state on every surface that LOGS time.
 *
 * It is `disabled`, so once you leave it you cannot come back to it — it is a
 * prompt, not a choice. The owner's reason, verbatim: "have the client field
 * default to choose client, so it is not accidentally left on the default 1st
 * client option". A pre-picked client is time billed to whoever happens to sort
 * first, by someone who never looked at the field.
 */
const CHOOSE_CLIENT_LABEL = 'Choose client'

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
/** Build editor rows (datetime-local values) from an entry's sessions. */
function entryToEditSessions(entry: TimeEntry): Array<{ id: string; start: string; stop: string }> {
  return effectiveSessions(entry).map((s) => ({
    id: makeSessionRowId(),
    start: isoToLocalInput(s.startAt),
    stop: isoToLocalInput(s.endAt),
  }))
}

// ---- The Time page's pick-or-type task box --------------------------------

/** Title of a checklist by id, for showing an attached task back to the user. */
function checklistTitleById(checklists: Checklist[], taskId: string): string | undefined {
  return checklists.find((checklist) => checklist.id === taskId)?.title
}

/**
 * The task box used by BOTH Time-page forms (live timer and manual entry).
 *
 * It replaced a <select> that made custom task names impossible: on any client
 * with an open task the dropdown was the only control, and the free-text box
 * only appeared when the client had NO tasks at all. This is one input backed
 * by a <datalist>, so the same field offers the client's open tasks, its
 * upcoming recurring tasks, every standard task in the workspace — and
 * anything the user types instead.
 *
 * The parent decides what a choice means; see {@link resolveTimeTaskChoice}.
 */
function TaskPickField({
  value,
  options,
  datalistId,
  placeholder,
  disabled,
  onTyped,
}: {
  value: string
  options: TimeTaskOption[]
  datalistId: string
  placeholder: string
  disabled?: boolean
  onTyped: (typed: string) => void
}) {
  const ownCount = options.filter((option) => option.checklistId).length
  const upcomingCount = options.filter((option) => option.templateId).length
  return (
    <>
      <input
        className="input"
        type="text"
        list={datalistId}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onTyped(event.target.value)}
      />
      {/* Bare option values on purpose: browsers disagree about whether a
          datalist option renders its value or its text, so the grouping is
          said in the caption below instead of inside the list. */}
      <datalist id={datalistId}>
        {options.map((option) => (
          <option key={option.label} value={option.label} />
        ))}
      </datalist>
      <span className="task-pick-hint">
        {ownCount > 0
          ? `${ownCount} open task${ownCount === 1 ? '' : 's'} for this client`
          : 'No open tasks for this client'}
        {upcomingCount > 0 ? `, ${upcomingCount} upcoming` : ''}
        {options.length - ownCount - upcomingCount > 0
          ? `, plus every standard task`
          : ''}
        . Anything you type that isn&rsquo;t in the list is used exactly as typed.
      </span>
    </>
  )
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
    adjustSplitGroup,
    updateTimeEntry,
    deleteTimeEntry,
    generateChecklistFromTemplate,
    previewMode,
    submitWeeklyTimesheet,
    reportPeriod,
    setReportPeriod,
  } = useAppContext()

  // The recent-entries list is scoped to the shared report period. The live
  // timer and the manual / log form are unaffected — only the displayed list.
  const periodEntries = useMemo(
    () => visibleEntries.filter((entry) => isInReportPeriod(entry.date, reportPeriod)),
    [visibleEntries, reportPeriod],
  )

  // MY entries an owner sent back. Deliberately NOT scoped by the report period
  // and NOT capped: the Recent list only renders the 8 most recent, so for
  // anyone who logs a lot the sent-back ones scroll out of reach and look like
  // they vanished. Oldest first — the longest-outstanding needs fixing most.
  const sentBackEntries = useMemo(
    () =>
      visibleEntries
        .filter(
          (entry) =>
            entry.employeeId === activeEmployeeId && entry.approvalStatus === 'rejected',
        )
        .sort((a, b) => a.date.localeCompare(b.date)),
    [visibleEntries, activeEmployeeId],
  )

  // Pick a recurring template in the timer's task list to "get ahead": this
  // generates that template's instance now and returns its checklist id so the
  // time attaches to a real task.
  const generateInstanceFromTemplate = async (templateId: string): Promise<string | null> => {
    try {
      const created = await generateChecklistFromTemplate(templateId)
      return created?.id ?? null
    } catch {
      return null
    }
  }

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
  // The entry currently open in the split modal (null = none). When it already
  // belongs to a split, the modal opens in ADJUST mode over that whole group.
  const [splitTarget, setSplitTarget] = useState<TimeEntry | null>(null)
  // Every slice of the target's group — the modal's prefill (which clients, how
  // many minutes each) is read off these, so reopening a split shows the
  // distribution that is actually saved rather than starting from scratch.
  const splitGroupSlices = useMemo(
    () =>
      splitTarget?.groupId
        ? visibleEntries.filter((entry) => entry.groupId === splitTarget.groupId)
        : [],
    [splitTarget, visibleEntries],
  )

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
      // Carry a custom task name across the resume so the task box isn't blank.
      taskLabel: entry.taskId ? undefined : entry.taskLabel,
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
          locks={data.timesheetLocks ?? []}
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
          templates={data.checklistTemplates}
          onGenerateFromTemplate={generateInstanceFromTemplate}
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
        {/* Sent back + Recent time share ONE grid cell (the right column) and
            stack, so Recent time starts directly under Sent back instead of
            wrapping onto a new row below the whole layout. */}
        <div className="time-side-stack">
        <SentBackEntries
          checklists={data.checklists}
          clients={data.clients}
          employees={data.employees}
          entries={sentBackEntries}
          role={role}
          locks={data.timesheetLocks ?? []}
          timerRunning={Boolean(timer)}
          onUpdate={updateTimeEntry}
          onDelete={deleteTimeEntry}
          onResume={handleResume}
          onSplitGroup={(entry) => setSplitTarget(entry)}
        />
        <RecentTimeEntries
          checklists={data.checklists}
          clients={data.clients}
          employees={data.employees}
          entries={periodEntries}
          totalEntryCount={visibleEntries.length}
          reportPeriodControl={
            <ReportPeriodControl value={reportPeriod} onChange={setReportPeriod} />
          }
          role={role}
          locks={data.timesheetLocks ?? []}
          timerRunning={Boolean(timer)}
          onUpdate={updateTimeEntry}
          onDelete={deleteTimeEntry}
          onResume={handleResume}
          onSplitGroup={(entry) => setSplitTarget(entry)}
        />
        </div>
      </div>

      {manualOpen ? (
        <ManualEntryModal
          activeEmployeeId={activeEmployeeId}
          clients={timeTrackingClients}
          checklists={data.checklists}
          templates={data.checklistTemplates}
          onGenerateFromTemplate={generateInstanceFromTemplate}
          employees={data.employees}
          role={role}
          onLog={logTime}
          onClose={() => setManualOpen(false)}
        />
      ) : null}

      {splitTarget ? (
        <GroupSplitModal
          entry={splitTarget}
          groupSlices={splitGroupSlices}
          clients={data.clients}
          billableClients={timeTrackingClients}
          onSplit={splitGroupEntry}
          onAdjust={adjustSplitGroup}
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
 * note). Owners aren't shown this widget — they're the reviewers, not the
 * submitters.
 *
 * The week picker here is a VIEWER. Submitting deliberately does not follow it:
 * "Submit timesheet" opens `SubmitTimesheetModal`, which works the oldest
 * outstanding past week first and only sends the current week after an explicit
 * "yes, I'm finished." Otherwise the week on screen — usually the current one —
 * went out ahead of older weeks that were still owed.
 */
function WeeklySubmissionWidget({
  activeEmployeeId,
  entries,
  submissions,
  locks,
  employees,
  previewMode,
  onSubmit,
}: {
  activeEmployeeId: string
  entries: TimeEntry[]
  submissions: WeeklySubmission[]
  locks: TimesheetLock[]
  employees: Employee[]
  previewMode: boolean
  onSubmit: (weekStart: string) => Promise<void>
}) {
  const [weekStart, setWeekStart] = useState(currentWeekStart)
  const [flowOpen, setFlowOpen] = useState(false)

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

  // Individual entries can be sent back WITHOUT the week itself being rejected —
  // the submission stays "pending", so nothing about the week hints that some of
  // it needs redoing. Surface that count here, or it goes unnoticed.
  const sentBack = useMemo(
    () =>
      entries.filter(
        (entry) =>
          entry.employeeId === activeEmployeeId &&
          entry.date >= start &&
          entry.date <= end &&
          entry.approvalStatus === 'rejected',
      ).length,
    [entries, activeEmployeeId, start, end],
  )

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
          <span className="status-pill">{formatHoursMinutes(weekTotal)} logged</span>
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
          {sentBack > 0 ? (
            <span
              className="status-pill status-pill--sent-back"
              title="Some entries in this week were sent back — edit and resubmit them below."
            >
              {sentBack} sent back
            </span>
          ) : null}
          <button
            type="button"
            className="primary-action"
            disabled={previewMode}
            onClick={() => setFlowOpen(true)}
            title={
              previewMode
                ? 'Cannot submit while previewing as another user.'
                : 'Check any past weeks you still owe, then send a week for review.'
            }
          >
            Submit timesheet
          </button>
        </div>
      </div>

      {submission?.status === 'rejected' && submission.reviewNote ? (
        <p className="auth-error" style={{ margin: 0 }}>
          <strong>Rejection note:</strong> {submission.reviewNote}
        </p>
      ) : null}

      {flowOpen ? (
        <SubmitTimesheetModal
          employeeId={activeEmployeeId}
          entries={entries}
          submissions={submissions}
          locks={locks}
          previewMode={previewMode}
          onSubmit={onSubmit}
          onClose={() => setFlowOpen(false)}
        />
      ) : null}
    </section>
  )
}

/**
 * Pick checklists eligible for time-attach: same client, not yet completed,
 * and either the user is assignee/editor (or owner — owners see all).
 */
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
// Exported for the timer tests: a blocked Stop & log must never eat the elapsed
// time, which is only provable by driving this panel directly.
export function TimeCapture({
  activeEmployeeId,
  clients,
  checklists,
  templates,
  onGenerateFromTemplate,
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
  templates: ChecklistTemplate[]
  onGenerateFromTemplate: (templateId: string) => Promise<string | null>
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
  // Starts on the "Choose client" placeholder, NOT on the first client in the
  // list. A real client pre-selected is a real client billed by accident —
  // "so it is not accidentally left on the default 1st client option".
  const [clientId, setClientId] = useState('')
  const [employeeId, setEmployeeId] = useState(activeEmployeeId)
  // Starts EMPTY. It used to be pre-filled with a standard sentence, which meant
  // every untouched entry logged a description nobody wrote; what's saved now is
  // only what a human typed.
  const [description, setDescription] = useState('')
  const [taskId, setTaskId] = useState<string>('')
  const [taskLabel, setTaskLabel] = useState('')
  const [isAdministrative, setIsAdministrative] = useState(false)
  // Out-of-scope one-off work. Only the compose-state copy; while a timer runs
  // the answer lives on the timer itself — see `shownAdhoc`.
  const [isAdhoc, setIsAdhoc] = useState(false)
  const [busy, setBusy] = useState(false)
  const [stopError, setStopError] = useState('')
  // A Stop & log has been attempted and blocked — see `fieldPrompt`. Prompts
  // appear only after that, because the timer is deliberately free to start.
  const [stopAttempted, setStopAttempted] = useState(false)
  // Group timing: track one block against several clients, chosen up front, then
  // split it across them for billing. Available to everyone who logs time —
  // staff can split their own time across their assigned clients (the server
  // enforces that every group client is one they're allowed to bill).
  const canGroup = true
  const [billTo, setBillTo] = useState<'single' | 'group'>('single')
  const [groupClientIds, setGroupClientIds] = useState<string[]>([])
  const groupMode = canGroup && billTo === 'group' && !isAdministrative
  const toggleGroupClient = (id: string) => {
    setGroupClientIds((current) =>
      current.includes(id) ? current.filter((existing) => existing !== id) : [...current, id],
    )
  }
  // An unknown (or unpicked) client resolves to NOTHING, never to the first one
  // in the list — the old `clients[0]` fallback would have quietly undone the
  // placeholder the moment it rendered.
  const effectiveClientId = clients.some((client) => client.id === clientId) ? clientId : ''
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
    () => eligibleChecklistsFor(checklists, taskClientId),
    [checklists, taskClientId],
  )

  // Recurring tasks for this client that don't have an open instance yet — so
  // you can "get ahead" and pick one before it's generated. Picking it creates
  // the instance now.
  const upcomingTemplates = useMemo(() => {
    if (!taskClientId) return []
    const haveInstance = new Set(
      eligibleTasks.map((task) => task.templateId).filter(Boolean) as string[],
    )
    return templates.filter(
      (template) =>
        template.clientId === taskClientId &&
        template.active &&
        !template.isStandard &&
        !haveInstance.has(template.id),
    )
  }, [templates, taskClientId, eligibleTasks])

  // Reset taskId if the previously-chosen task isn't valid for the new client.
  const effectiveTaskId = eligibleTasks.some((task) => task.id === taskId) ? taskId : ''

  // Everything the pick-or-type task box offers: this client's open tasks, its
  // upcoming recurring tasks, every standard task, and whatever is typed.
  const taskOptions = useMemo(
    () => buildTimeTaskOptions(eligibleTasks, templates, upcomingTemplates),
    [eligibleTasks, templates, upcomingTemplates],
  )

  // The timer panel is read-only when the timesheet is locked OR an owner is
  // previewing this person — preview mode must never be able to time work.
  const inputsDisabled = locked || previewMode

  const runningGroup = (timer?.groupClientIds?.length ?? 0) > 0
  const runningAdmin = Boolean(timer?.isAdministrative)
  const shownBillTo = isRunning ? (runningGroup ? 'group' : 'single') : billTo
  const shownAdmin = isRunning ? runningAdmin : isAdministrative
  // Ad hoc follows the same read-through-the-timer rule as everything else:
  // ticked mid-run it patches the running timer, so it survives a refresh and
  // is still true at Stop. Administrative time can never be ad hoc.
  const shownAdhoc = !shownAdmin && (isRunning ? Boolean(timer?.isAdhoc) : isAdhoc)
  const shownGroupMode = isRunning ? runningGroup : groupMode
  const shownClientId = isRunning ? timer?.clientId ?? '' : effectiveClientId
  const shownTaskId = isRunning ? timer?.taskId ?? '' : effectiveTaskId
  const shownGroupIds = isRunning ? timer?.groupClientIds ?? [] : groupClientIds
  const shownDescription = isRunning ? timer?.description ?? '' : description
  const shownEmployeeId = isRunning ? timer?.employeeId ?? employeeId : employeeId
  const shownTaskLabel = isRunning ? timer?.taskLabel ?? '' : taskLabel
  // What the task box shows: an attached task reads back as its real title,
  // anything else as the free text that will be saved as `taskLabel`.
  const shownTaskText = shownTaskId
    ? checklistTitleById(checklists, shownTaskId) ?? shownTaskLabel
    : shownTaskLabel

  /**
   * A keystroke (or a datalist pick) in the task box. An open task attaches by
   * id; an UPCOMING recurring task is generated first and then attached — the
   * same "get ahead" flow the old `template:<id>` dropdown option ran; anything
   * else rides along as free text. While a timer runs the choice patches the
   * timer instead of the compose-state, so it survives a refresh.
   */
  const handleTaskTyped = async (typed: string) => {
    const choice = resolveTimeTaskChoice(typed, taskOptions)
    if (choice.templateId) {
      const newId = await onGenerateFromTemplate(choice.templateId)
      if (!newId) {
        window.alert("Couldn't start that upcoming task right now — try again in a moment.")
        return
      }
      // Only the id — generating merges the new checklist into local data, so
      // the box reads back its real title (without the "(upcoming)" marker).
      if (isRunning) onUpdateTimer({ taskId: newId, taskLabel: undefined })
      else {
        setTaskId(newId)
        setTaskLabel('')
      }
      return
    }
    if (isRunning) {
      onUpdateTimer({ taskId: choice.taskId, taskLabel: choice.taskId ? undefined : typed })
    } else {
      setTaskId(choice.taskId ?? '')
      setTaskLabel(choice.taskId ? '' : typed)
    }
  }

  // Starting is FREE: the timer runs with nothing filled in (that's the point —
  // start the clock, then say what you're doing). No description is invented on
  // the way in; the fields are demanded at Stop & log instead.
  const handleStartTimer = () => {
    // A fresh timer starts with a clean slate — prompts belong to the stop that
    // was actually blocked, not to the next run.
    setStopAttempted(false)
    if (groupMode) {
      if (groupClientIds.length === 0) return
      onStartTimer({
        employeeId: effectiveEmployeeId,
        clientId: '',
        description: description.trim(),
        startedAt: Date.now(),
        taskId: null,
        isAdministrative: false,
        // The whole block is out-of-scope work, so every slice the split
        // produces is too — the store carries the flag onto them.
        isAdhoc,
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
      description: description.trim(),
      startedAt: Date.now(),
      taskId: isAdministrative ? null : effectiveTaskId || null,
      // A typed name rides along whenever no real task is attached — the old
      // "only when this client has zero tasks" gate is what made a custom task
      // name impossible on any client that had one.
      taskLabel:
        !isAdministrative && !effectiveTaskId && taskLabel.trim() ? taskLabel.trim() : undefined,
      isAdministrative,
      isAdhoc: !isAdministrative && isAdhoc,
    })
  }

  /**
   * What's still missing before this running timer may be LOGGED. The rule is
   * the server's own (`validateTimeEntryRequiredFields`), so the inline prompts
   * and the 400 can never disagree.
   *
   * Resuming an existing entry is exempt: stopping only appends a session to
   * that entry, it doesn't write these fields, so demanding them would be a
   * dead end on a legacy entry that has none.
   */
  const missingStopFields = useMemo(() => {
    if (!timer || timer.resumeEntryId) return []
    return validateTimeEntryRequiredFields({
      isAdministrative: Boolean(timer.isAdministrative),
      clientId: timer.clientId ?? '',
      groupClientIds: timer.groupClientIds ?? [],
      taskId: timer.taskId ?? '',
      taskLabel: timer.taskLabel ?? '',
      description: timer.description ?? '',
    }).missing
  }, [timer])
  // Prompts appear only after a stop was actually attempted — the timer starts
  // free, so nagging before then would be wrong. They clear themselves as each
  // field is filled because `missingStopFields` is derived from the live timer.
  const fieldPrompt = (field: TimeEntryRequiredField) =>
    stopAttempted && missingStopFields.includes(field) ? (
      <span className="field-error">{TIME_ENTRY_FIELD_PROMPTS[field]}</span>
    ) : null

  /**
   * Back to a blank slate: every field the panel owns returns to the value it
   * had on first render, so the NEXT capture starts from nothing. The panel's
   * own state is what seeds the next Start (a running timer displays itself,
   * but a stopped one leaves the compose-state showing), which is why a
   * carried-over description used to ride along into the following entry.
   *
   * Called ONLY after a stop that actually saved — see {@link handleStopTimer}.
   */
  const resetCaptureFields = () => {
    // Back to "Choose client", not back to the first client — a blank slate that
    // pre-picks somebody is not blank.
    setClientId('')
    setEmployeeId(activeEmployeeId)
    setDescription('')
    setTaskId('')
    setTaskLabel('')
    setIsAdministrative(false)
    setIsAdhoc(false)
    setBillTo('single')
    setGroupClientIds([])
    setStopAttempted(false)
    setStopError('')
  }

  const handleStopTimer = async () => {
    // Blocked stop: the elapsed time is NOT lost. Nothing is saved, nothing is
    // cleared — the timer keeps running with everything it has while the user
    // fills in the prompts, and Stop & log works the moment they do.
    if (missingStopFields.length > 0) {
      setStopAttempted(true)
      setStopError('')
      return
    }
    setStopAttempted(false)
    setBusy(true)
    setStopError('')
    try {
      // The live notes are kept on the running timer now, so stop with no
      // override and let it use the timer's own (persisted) description.
      await onStopTimer()
      // The time is logged — and only now is it safe to wipe the form. A stop
      // that was blocked or refused never reaches this line, so nothing a user
      // typed is thrown away while it is still un-logged.
      resetCaptureFields()
    } catch (error) {
      // Surface a server block (e.g. "submit last week first") instead of a
      // silent failure — the timer stays running so no time is lost.
      setStopError(error instanceof ApiError ? error.message : 'Could not log this time.')
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
        The timer is the most accurate way to log time. Start it the moment you begin work —
        the client, task and detail can be filled in while it runs, but all three are required
        before the time can be logged.
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
        {/* One-off work the client's arrangement does not cover. It bills on its
            own line at your rate instead of disappearing into the month's
            hours, and the owner decides per line what to do with it. Can be
            ticked mid-run — the answer rides on the timer to the stop. */}
        {!shownAdmin ? (
          <label className="check-row full-span">
            <input
              checked={shownAdhoc}
              onChange={(event) => {
                if (isRunning) onUpdateTimer({ isAdhoc: event.target.checked })
                else setIsAdhoc(event.target.checked)
              }}
              type="checkbox"
              disabled={inputsDisabled}
            />
            <span>Ad hoc (outside scoped work)</span>
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
                {/* See {@link CHOOSE_CLIENT_LABEL}. Disabled: it is where the
                    field starts, never somewhere you can go back to. */}
                <option value="" disabled>
                  {CHOOSE_CLIENT_LABEL}
                </option>
                {clients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
              </select>
              {fieldPrompt('client')}
            </label>
            <label className="field">
              <span>Task</span>
              <TaskPickField
                value={shownTaskText}
                options={taskOptions}
                datalistId="time-timer-task-options"
                placeholder="Pick a task or type your own"
                disabled={inputsDisabled}
                onTyped={(typed) => void handleTaskTyped(typed)}
              />
              {fieldPrompt('task')}
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
            placeholder="Required to log this time — e.g. reconciled the operating account."
          />
          {fieldPrompt('detail')}
        </label>
        {stopError ? <p className="auth-error full-span">{stopError}</p> : null}
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
                    setStopAttempted(false)
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
              // The client gate predates the placeholder, but the placeholder is
              // what makes it reachable — so say why the button is greyed out
              // instead of leaving it looking broken.
              title={
                !inputsDisabled && !groupMode && !isAdministrative && !effectiveClientId
                  ? `Pick a client first — the field starts on "${CHOOSE_CLIENT_LABEL}".`
                  : undefined
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
export function ManualEntryModal({
  activeEmployeeId,
  clients,
  checklists,
  templates,
  onGenerateFromTemplate,
  employees,
  role,
  onLog,
  onClose,
}: {
  activeEmployeeId: string
  clients: Client[]
  checklists: Checklist[]
  templates: ChecklistTemplate[]
  onGenerateFromTemplate: (templateId: string) => Promise<string | null>
  employees: Employee[]
  role: Role
  onLog: (entry: Omit<TimeEntry, 'id' | 'approvalStatus'>) => Promise<void>
  onClose: () => void
}) {
  const [step, setStep] = useState<'confirm' | 'form'>('confirm')
  // Group billing: log one block of time across MULTIPLE clients at once, each
  // billed independently — save it as a group block, then split it (even / full
  // to each / custom per-client amounts). Available to everyone who logs time;
  // staff split their own time across their assigned clients (the server
  // enforces every group client is one they're allowed to bill).
  const canGroup = true
  const [billTo, setBillTo] = useState<'single' | 'group'>('single')
  const [groupClientIds, setGroupClientIds] = useState<string[]>([])
  // How the block is divided across the selected clients (one-step split on save).
  const [groupSplitMode, setGroupSplitMode] = useState<GroupAllocationMode>('even')
  const [groupCustomMinutes, setGroupCustomMinutes] = useState<Record<string, string>>({})
  // Exact start/stop the employee enters, so the owner can audit. Default to a
  // one-hour block ending now; duration is derived from the span.
  const [startLocal, setStartLocal] = useState(() => {
    const start = new Date()
    start.setHours(start.getHours() - 1)
    return toLocalInput(start)
  })
  const [stopLocal, setStopLocal] = useState(() => toLocalInput(new Date()))
  const [employeeId, setEmployeeId] = useState(activeEmployeeId)
  // Opens on "Choose client", same as the timer panel — see {@link CHOOSE_CLIENT_LABEL}.
  const [clientId, setClientId] = useState('')
  const [description, setDescription] = useState('')
  const [billable, setBillable] = useState(true)
  const [taskId, setTaskId] = useState<string>('')
  const [taskLabel, setTaskLabel] = useState('')
  const [isAdministrative, setIsAdministrative] = useState(false)
  const [isAdhoc, setIsAdhoc] = useState(false)
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

  // Nothing picked resolves to nothing — never to `clients[0]`, which is the
  // accident this whole change exists to stop.
  const effectiveClientId = clients.some((client) => client.id === clientId) ? clientId : ''
  // Owners pick the employee; fall back to themselves (activeEmployeeId) when
  // the selection is missing/invalid so time is never attributed to a stale id.
  const effectiveEmployeeId =
    role === 'owner'
      ? employees.some((employee) => employee.id === employeeId)
        ? employeeId
        : activeEmployeeId
      : activeEmployeeId

  const eligibleTasks = useMemo(
    () => eligibleChecklistsFor(checklists, effectiveClientId),
    [checklists, effectiveClientId],
  )
  const upcomingTemplates = useMemo(() => {
    if (!effectiveClientId) return []
    const haveInstance = new Set(
      eligibleTasks.map((task) => task.templateId).filter(Boolean) as string[],
    )
    return templates.filter(
      (template) =>
        template.clientId === effectiveClientId &&
        template.active &&
        !template.isStandard &&
        !haveInstance.has(template.id),
    )
  }, [templates, effectiveClientId, eligibleTasks])
  const effectiveTaskId = eligibleTasks.some((task) => task.id === taskId) ? taskId : ''

  // Same pick-or-type task box as the live timer: this client's open tasks, its
  // upcoming recurring tasks, every standard task, and free typing.
  const taskOptions = useMemo(
    () => buildTimeTaskOptions(eligibleTasks, templates, upcomingTemplates),
    [eligibleTasks, templates, upcomingTemplates],
  )
  const shownTaskText = effectiveTaskId
    ? checklistTitleById(checklists, effectiveTaskId) ?? taskLabel
    : taskLabel

  /** See {@link TaskPickField} — an upcoming task is generated, then attached. */
  const handleTaskTyped = async (typed: string) => {
    const choice = resolveTimeTaskChoice(typed, taskOptions)
    if (choice.templateId) {
      const newId = await onGenerateFromTemplate(choice.templateId)
      if (!newId) {
        window.alert("Couldn't start that upcoming task right now — try again in a moment.")
        return
      }
      setTaskId(newId)
      setTaskLabel('')
      return
    }
    setTaskId(choice.taskId ?? '')
    setTaskLabel(choice.taskId ? '' : typed)
  }

  // Group ("split across clients"): log ONE block of time and divide it across
  // the selected clients in a single save — evenly, a custom amount each, or the
  // full duration to each. No separate "split later" step.
  const groupMode = canGroup && billTo === 'group' && !isAdministrative

  const toggleGroupClient = (id: string) => {
    setGroupClientIds((current) =>
      current.includes(id) ? current.filter((existing) => existing !== id) : [...current, id],
    )
  }

  // Live allocation preview (minutes derived from the entered start/stop span).
  const previewMinutes = useMemo(() => {
    const s = startLocal ? new Date(startLocal).getTime() : NaN
    const e = stopLocal ? new Date(stopLocal).getTime() : NaN
    return Number.isFinite(s) && Number.isFinite(e) && e > s ? Math.round((e - s) / 60000) : 0
  }, [startLocal, stopLocal])
  const groupCustomNumeric = useMemo(() => {
    const out: Record<string, number> = {}
    for (const id of groupClientIds) out[id] = Number(groupCustomMinutes[id])
    return out
  }, [groupClientIds, groupCustomMinutes])
  const groupAllocation = useMemo(
    () => allocateGroupMinutes(previewMinutes, groupClientIds, groupSplitMode, groupCustomNumeric),
    [previewMinutes, groupClientIds, groupSplitMode, groupCustomNumeric],
  )

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
    if (!isAdministrative && !effectiveClientId && !groupMode) {
      setSubmitError('Select a client, or check "Administrative work".')
      return
    }
    if (groupMode && groupClientIds.length === 0) {
      setSubmitError('Pick at least one client to split across.')
      return
    }
    // Client + task + detail are mandatory here too — the same rule the timer's
    // Stop & log and the server both apply. A group block is exempt from the
    // task (its slices are per-client) but never from the detail.
    const requiredFields = validateTimeEntryRequiredFields({
      isAdministrative,
      clientId: isAdministrative || groupMode ? '' : effectiveClientId,
      groupClientIds: groupMode ? groupClientIds : [],
      taskId: isAdministrative || groupMode ? '' : effectiveTaskId,
      taskLabel: isAdministrative || groupMode ? '' : taskLabel,
      description,
    })
    if (requiredFields.error) {
      setSubmitError(requiredFields.error)
      return
    }
    if (!reason.trim()) {
      setSubmitError('A reason is required for manual entries.')
      return
    }

    // Split across clients: divide this block per the chosen allocation and save
    // ONE billable entry per client in a single action (a shared groupId ties
    // them together). No leftover "un-split" holding entry.
    if (groupMode) {
      const allocation = allocateGroupMinutes(
        totalMinutes,
        groupClientIds,
        groupSplitMode,
        groupCustomNumeric,
      )
      const allocated = groupClientIds
        .map((id) => ({ id, minutes: allocation[id] ?? 0 }))
        .filter((row) => row.minutes > 0)
      if (allocated.length === 0) {
        setSubmitError(
          groupSplitMode === 'custom'
            ? 'Enter minutes greater than 0 for at least one client.'
            : 'The tracked time is too short to split.',
        )
        return
      }
      setSubmitPending(true)
      setSubmitError('')
      const groupId = makeId('grp')
      try {
        for (const row of allocated) {
          await onLog({
            employeeId: effectiveEmployeeId,
            clientId: row.id,
            isAdministrative: false,
            date: startLocal.slice(0, 10),
            // Allocated minutes only (no session span) so the server keeps each
            // client's split amount instead of recomputing the full duration.
            minutes: row.minutes,
            description: description.trim(),
            billable: true,
            // Every slice of one out-of-scope block is out-of-scope work.
            isAdhoc,
            taskId: null,
            entryMethod: 'manual',
            manualReason: reason.trim(),
            groupId,
          })
        }
        setSuccess(true)
      } catch (error) {
        setSubmitError(
          error instanceof ApiError ? error.message : 'Split time could not be saved.',
        )
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
        description: description.trim(),
        billable: isAdministrative ? false : billable,
        isAdhoc: isAdministrative ? false : isAdhoc,
        taskId: isAdministrative ? null : effectiveTaskId || null,
        // Sent whenever no real task is attached (see the timer form) — the old
        // zero-tasks gate silently dropped every custom name.
        taskLabel:
          !isAdministrative && !effectiveTaskId && taskLabel.trim() ? taskLabel.trim() : undefined,
        entryMethod: 'manual',
        manualReason: reason.trim(),
        startAt: localInputToIso(startLocal),
        endAt: localInputToIso(stopLocal),
        sessions: [
          { startAt: localInputToIso(startLocal), endAt: localInputToIso(stopLocal) },
        ],
      })
      setSuccess(true)
    } catch (error) {
      setSubmitError(
        error instanceof ApiError ? error.message : 'Manual entry could not be saved.',
      )
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
              {/* Same position and rule as the timer panel: offered on any
                  client time, including a group block (every slice inherits
                  it), and never on administrative time. */}
              {!isAdministrative ? (
                <label className="check-row full-span">
                  <input
                    checked={isAdhoc}
                    onChange={(event) => setIsAdhoc(event.target.checked)}
                    type="checkbox"
                  />
                  <span>Ad hoc (outside scoped work)</span>
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
                  <label className="field full-span">
                    <span>How should the time be split?</span>
                    <select
                      className="input"
                      value={groupSplitMode}
                      onChange={(event) =>
                        setGroupSplitMode(event.target.value as GroupAllocationMode)
                      }
                    >
                      <option value="even">Split evenly across clients</option>
                      <option value="custom">Custom — set each client&apos;s minutes</option>
                      <option value="full">Full duration to each client</option>
                    </select>
                  </label>
                  {groupClientIds.length > 0 ? (
                    <div className="field full-span group-allocation-preview">
                      <span>
                        {groupSplitMode === 'custom' ? 'Minutes per client' : 'Each client gets'}
                      </span>
                      <ul className="group-allocation-list">
                        {groupClientIds.map((id) => (
                          <li key={id}>
                            <span className="group-allocation-name">{clientName(clients, id)}</span>
                            {groupSplitMode === 'custom' ? (
                              <input
                                className="input group-allocation-input"
                                type="number"
                                min="0"
                                step="1"
                                value={groupCustomMinutes[id] ?? ''}
                                onChange={(event) =>
                                  setGroupCustomMinutes((prev) => ({
                                    ...prev,
                                    [id]: event.target.value,
                                  }))
                                }
                                placeholder="min"
                              />
                            ) : (
                              <span className="group-allocation-amount">
                                {formatHoursMinutes(groupAllocation[id] ?? 0)}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                      <p className="group-allocation-total">
                        Total:{' '}
                        {formatHoursMinutes(
                          Object.values(groupAllocation).reduce((sum, m) => sum + (m || 0), 0),
                        )}{' '}
                        · saves one billable entry per client, together.
                      </p>
                    </div>
                  ) : null}
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
                      {/* Same opening state as the timer panel — see
                          {@link CHOOSE_CLIENT_LABEL}. */}
                      <option value="" disabled>
                        {CHOOSE_CLIENT_LABEL}
                      </option>
                      {clients.map((client) => (
                        <option key={client.id} value={client.id}>
                          {client.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Task</span>
                    <TaskPickField
                      value={shownTaskText}
                      options={taskOptions}
                      datalistId="time-manual-task-options"
                      placeholder="Pick a task or type your own"
                      onTyped={(typed) => void handleTaskTyped(typed)}
                    />
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
                  placeholder="Required — what did you work on?"
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
 * Splits a time entry across clients. The user picks how to divide the tracked
 * block — evenly, the full duration to each, or a custom per-client split —
 * sees a live preview, and confirms. On confirm the source entry is replaced by
 * one entry per client.
 *
 * Three shapes:
 *   - an unsplit GROUP holding block: the member clients were fixed when the
 *     timer started, so there is no picker (unchanged behavior);
 *   - a REGULAR client entry: it opens with a checkbox list of the clients this
 *     user may bill, its current client preselected. That's the fix for "it
 *     will only let me split if I pick one client" — ordinary time can now be
 *     divided too, not just group-timer blocks;
 *   - an ALREADY-SPLIT slice (`groupSlices` non-empty): the same modal reopens
 *     over the whole group with its CURRENT distribution loaded — the clients
 *     ticked, each one's exact minutes filled in, and the mode it was saved
 *     with. Amounts, clients and the total can all change, and saving replaces
 *     the group in one call. Without this a split was permanent: the only way
 *     to change one was to delete every slice and retype the time, which is
 *     "will not let me adjust my time entry without losing the client split I
 *     chose".
 */
/**
 * How the owner EXPRESSES a split, which is not the same thing as how it is
 * stored. `percent` is the friendly face of a custom split: the percentages are
 * converted to exact seconds before saving and persisted as `custom`, so the
 * stored vocabulary ('even' | 'custom' | 'full') and every rule built on it —
 * the server's exact-sum check, payroll's treatment of 'full' — are untouched.
 */
type SplitMethod = 'even' | 'percent' | 'custom' | 'full'

/**
 * "Evenly" and "By percentage" lead, because manually typing a number of minutes
 * per client is the thing the firm asked us to stop making them do. Exact
 * minutes stays available as a compact third option: an adjustment reopens on
 * exact amounts, and a seconds-precision correction can only be said in minutes.
 */
const SPLIT_METHOD_PRIMARY: Array<{ value: SplitMethod; label: string; hint: string }> = [
  { value: 'even', label: 'Evenly', hint: 'The same share of the block to every client' },
  { value: 'percent', label: 'By percentage', hint: "You set each client's share — 60% / 40%" },
]

const SPLIT_METHOD_SECONDARY: Array<{ value: SplitMethod; label: string; hint: string }> = [
  { value: 'custom', label: 'Exact minutes', hint: 'Type the minutes for each client' },
  { value: 'full', label: 'Full duration to each', hint: 'Every client is billed the whole block' },
]

/** "33.34", "50", "12.5" — 2dp, without trailing-zero noise. */
function formatPercentValue(percent: number) {
  if (!Number.isFinite(percent)) return '0'
  return String(Math.round(percent * 100) / 100)
}

export function GroupSplitModal({
  entry,
  groupSlices = [],
  clients,
  billableClients,
  onSplit,
  onAdjust,
  onClose,
}: {
  entry: TimeEntry
  /** Every slice of `entry`'s split group — empty unless adjusting one. */
  groupSlices?: TimeEntry[]
  /** All visible clients — used for name lookup on already-chosen ids. */
  clients: Client[]
  /** The clients this user may bill — the picker's options. */
  billableClients: Client[]
  onSplit: (
    holding: TimeEntry,
    mode: GroupAllocationMode,
    customMinutes: Record<string, number>,
    clientIds: string[],
  ) => Promise<void>
  onAdjust: (
    groupId: string,
    mode: GroupAllocationMode,
    allocations: { clientId: string; minutes: number }[],
  ) => Promise<void>
  onClose: () => void
}) {
  const isHolding = classifySplitTarget(entry) === 'holding'
  // Adjusting an existing split rather than creating one.
  const isAdjust = Boolean(entry.groupId) && groupSlices.length > 0
  // What the split currently says: its clients, their exact minutes, the mode
  // it was saved with, and the block those amounts came from.
  const prefill = useMemo(() => splitGroupPrefill(groupSlices), [groupSlices])
  const memberIds = useMemo(
    () => (Array.isArray(entry.groupClientIds) ? entry.groupClientIds : []),
    [entry.groupClientIds],
  )
  const clientOptions = useMemo(
    () =>
      isHolding
        ? []
        : splitClientOptions(billableClients, isAdjust ? prefill.clientIds : entry.clientId),
    [isHolding, isAdjust, billableClients, prefill.clientIds, entry.clientId],
  )
  // A regular split starts on the client the entry is already billed to, so the
  // owner only has to add the ones they're splitting toward. An adjustment
  // starts on exactly the clients the split already covers.
  const [pickedIds, setPickedIds] = useState<string[]>(() =>
    isAdjust ? prefill.clientIds : entry.clientId ? [entry.clientId] : [],
  )
  // How the split is being SAID. A reopened split shows the method that produced
  // it (a stored 'custom' reopens on exact minutes, which is what it really is).
  const [method, setMethod] = useState<SplitMethod>(() => (isAdjust ? prefill.mode : 'even'))
  // ...and how it will be STORED. Percentages are saved as an ordinary custom
  // split — see `allocateByPercentages`.
  const mode: GroupAllocationMode = method === 'percent' ? 'custom' : method
  // Prefilled with the split's exact per-client amounts, so reopening it shows
  // what is billed today — and switching to Custom never starts from blank.
  const [customMinutes, setCustomMinutes] = useState<Record<string, string>>(() =>
    isAdjust ? { ...prefill.customMinutes } : {},
  )
  // Percentage mode's typed values — see `percentSeed` below for what they
  // override, and why they are keyed by the client set they belong to.
  const [percentEdits, setPercentEdits] = useState<{
    key: string
    values: Record<string, string>
  }>({ key: '', values: {} })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  // The clients this split is actually dividing across. Keeps the picker's
  // option order (current client first) so the preview list doesn't jump around
  // as boxes are ticked.
  const targetIds = useMemo(
    () =>
      isHolding ? memberIds : clientOptions.map((o) => o.id).filter((id) => pickedIds.includes(id)),
    [isHolding, memberIds, clientOptions, pickedIds],
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const customMinutesNumeric = useMemo(() => {
    const out: Record<string, number> = {}
    for (const id of targetIds) out[id] = Number(customMinutes[id])
    return out
  }, [targetIds, customMinutes])

  /**
   * What the percentage boxes START at, so they never open blank: reopening an
   * existing split shows what is billed TODAY (36m and 24m of an hour read as
   * 60% and 40%), anything else an even share each — which already adds up to
   * exactly 100, so the split is submittable the moment the mode is picked.
   */
  const percentSeed = useMemo(() => {
    if (targetIds.length === 0) return {}
    const currentMinutes: Record<string, number> = {}
    let currentTotal = 0
    for (const id of targetIds) {
      const minutes = Number(prefill.customMinutes[id])
      if (!Number.isFinite(minutes) || minutes <= 0) {
        currentTotal = 0
        break
      }
      currentMinutes[id] = minutes
      currentTotal += minutes
    }
    const seeded =
      isAdjust && currentTotal > 0
        ? percentagesFromMinutes(currentMinutes, currentTotal)
        : percentagesFromMinutes(
            Object.fromEntries(targetIds.map((id) => [id, 1])),
            targetIds.length,
          )
    return Object.fromEntries(Object.entries(seeded).map(([id, value]) => [id, String(value)]))
  }, [targetIds, isAdjust, prefill.customMinutes])

  // Typed percentages sit ON TOP of that seed, tagged with the client set they
  // were typed against: tick another client and the shares go back to an even
  // split of the NEW set rather than leaving a stale 50/50 that no longer adds
  // up. (Derived rather than synced in an effect — one source of truth.)
  const percentSeedKey = targetIds.join('|')
  const percentages = useMemo(
    () =>
      percentEdits.key === percentSeedKey ? { ...percentSeed, ...percentEdits.values } : percentSeed,
    [percentSeed, percentSeedKey, percentEdits],
  )
  const setPercentage = (clientId: string, value: string) =>
    setPercentEdits((prev) => ({
      key: percentSeedKey,
      values: prev.key === percentSeedKey ? { ...prev.values, [clientId]: value } : { [clientId]: value },
    }))

  const percentagesNumeric = useMemo(() => {
    const out: Record<string, number> = {}
    for (const id of targetIds) out[id] = Number(percentages[id])
    return out
  }, [targetIds, percentages])
  const percentTotal = targetIds.reduce((sum, id) => {
    const value = Number(percentages[id])
    return sum + (Number.isFinite(value) ? value : 0)
  }, 0)

  // The duration the even / full previews divide. Creating a split divides the
  // entry; adjusting one divides the block the split came from (reconstructed
  // from the slices — for a 'full' split that's one slice, otherwise the sum).
  const blockMinutes = isAdjust ? prefill.blockMinutes : entry.minutes
  const allocation = useMemo(
    () =>
      method === 'percent'
        ? allocateByPercentages(blockMinutes, percentagesNumeric)
        : allocateGroupMinutes(blockMinutes, targetIds, mode, customMinutesNumeric),
    [method, blockMinutes, targetIds, mode, customMinutesNumeric, percentagesNumeric],
  )
  const totalBilled = Object.values(allocation).reduce((sum, minutes) => sum + (minutes || 0), 0)

  // A custom split has to account for every SECOND of the block — the server
  // refuses anything else, so show the exact gap here rather than letting the
  // owner discover it from a 400. ('even' is exact by construction; 'full'
  // deliberately bills each client the whole block.) An ADJUSTMENT is exempt:
  // it is an explicit correction of what gets billed, so its total is allowed
  // to land anywhere — the "was" figure below is what makes the change visible.
  const blockSeconds = minutesToSeconds(blockMinutes)
  const allocatedSeconds = targetIds.reduce(
    (sum, id) => sum + minutesToSeconds(allocation[id] ?? 0),
    0,
  )
  const remainderSeconds = blockSeconds - allocatedSeconds
  const mustBalance = !isAdjust && method === 'custom' && remainderSeconds !== 0
  // Percentages must total exactly 100 in BOTH modes. An adjustment is allowed
  // to change the total minutes, but "60% and 30%" still isn't a whole split —
  // and once they do total 100 the seconds add up to the block by construction.
  const percentUnbalanced = method === 'percent' && !percentagesTotalTo100(percentagesNumeric)
  // Auto-balance target: the last client in the group, so one click closes the
  // gap instead of making the owner do the arithmetic.
  const balanceTargetId = targetIds[targetIds.length - 1] ?? ''
  const applyBalance = () => {
    if (!balanceTargetId) return
    const nextSeconds = Math.max(
      0,
      minutesToSeconds(allocation[balanceTargetId] ?? 0) + remainderSeconds,
    )
    setCustomMinutes((prev) => ({ ...prev, [balanceTargetId]: String(nextSeconds / 60) }))
  }

  const handleConfirm = async () => {
    // Splitting to a single client is just re-billing the entry — the edit
    // form's client dropdown already does that. The server refuses it too.
    // Adjusting DOWN to one client is a different thing and is allowed: it
    // pulls a client back out of a split that shouldn't have included it.
    if (!isHolding && !isAdjust && targetIds.length < 2) {
      setError("Pick at least two clients — to move this time to one other client, edit the entry's client instead.")
      return
    }
    if (percentUnbalanced) {
      setError(
        `The percentages add up to ${formatPercentValue(percentTotal)}% — they have to add up to 100%.`,
      )
      return
    }
    const hasAny = targetIds.some((id) => (allocation[id] ?? 0) > 0)
    if (!hasAny) {
      setError(
        method === 'percent'
          ? 'Give at least one client more than 0%.'
          : mode === 'custom'
            ? 'Enter minutes greater than 0 for at least one client.'
            : 'The tracked time is too short to split.',
      )
      return
    }
    if (mustBalance) {
      setError(
        `Allocations add up to ${formatHoursMinutes(allocatedSeconds / 60)} but the block is ${formatHoursMinutes(
          blockSeconds / 60,
        )} — ${formatHoursMinutes(Math.abs(remainderSeconds) / 60)} ${
          remainderSeconds > 0 ? 'unassigned' : 'over'
        }.`,
      )
      return
    }
    setPending(true)
    setError('')
    try {
      if (isAdjust && entry.groupId) {
        await onAdjust(
          entry.groupId,
          mode,
          targetIds
            .map((id) => ({ clientId: id, minutes: allocation[id] ?? 0 }))
            .filter((row) => minutesToSeconds(row.minutes) > 0),
        )
      } else {
        // Percentage mode hands over the MINUTES it computed: the server runs the
        // same shared allocator on a plain custom split and re-checks that they
        // account for every second of the block.
        await onSplit(
          entry,
          mode,
          method === 'percent' ? allocation : customMinutesNumeric,
          targetIds,
        )
      }
      onClose()
    } catch (splitError) {
      setError(
        splitError instanceof Error && splitError.message
          ? splitError.message
          : isAdjust
            ? 'Could not adjust this split.'
            : 'Could not split this time entry.',
      )
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
      <div
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label={isAdjust ? 'Adjust the split across clients' : 'Split time across clients'}
      >
        <div className="modal-body">
          <h2 className="modal-title">
            {isAdjust ? 'Adjust split' : isHolding ? 'Split group time' : 'Split across clients'}
          </h2>
          <p className="modal-intro">
            {isAdjust ? (
              <>
                This time is split across {prefill.clientIds.length}{' '}
                {prefill.clientIds.length === 1 ? 'client' : 'clients'} —{' '}
                {formatHoursMinutes(prefill.totalMinutes)} billed in total. Change the amounts, add
                or remove clients, then save. The clock-in/out stays exactly as it was recorded,
                and the entries go back through approval.
              </>
            ) : isHolding ? (
              <>
                {formatHoursMinutes(entry.minutes)} tracked across {memberIds.length}{' '}
                {memberIds.length === 1 ? 'client' : 'clients'}. Choose how to bill it — this
                replaces the group entry with one billable entry per client.
              </>
            ) : (
              <>
                {formatHoursMinutes(entry.minutes)} currently billed to{' '}
                {clientName(clients, entry.clientId)}. Pick every client this time should be split
                across and choose how to divide it — this replaces the entry with one per client,
                and they go back through approval.
              </>
            )}
          </p>
          <div className="form-grid">
            {!isHolding ? (
              <div className="field full-span group-time-block">
                <span>{isAdjust ? 'Clients in this split' : 'Clients to split across'}</span>
                <div className="group-client-grid">
                  {clientOptions.map((option) => {
                    const selected = pickedIds.includes(option.id)
                    return (
                      <label
                        key={option.id}
                        className={`group-client-chip${selected ? ' is-selected' : ''}`}
                      >
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() =>
                            setPickedIds((prev) =>
                              prev.includes(option.id)
                                ? prev.filter((id) => id !== option.id)
                                : [...prev, option.id],
                            )
                          }
                        />
                        <span>{option.name}</span>
                      </label>
                    )
                  })}
                </div>
              </div>
            ) : null}
            <div
              className="field full-span split-method-field"
              role="radiogroup"
              aria-label="How should the time be split?"
            >
              <span>How should the time be split?</span>
              <div className="split-method-choices">
                {SPLIT_METHOD_PRIMARY.map((choice) => (
                  <label
                    key={choice.value}
                    className={`split-method-chip${method === choice.value ? ' is-selected' : ''}`}
                  >
                    <input
                      type="radio"
                      name="split-method"
                      value={choice.value}
                      checked={method === choice.value}
                      onChange={() => setMethod(choice.value)}
                    />
                    <span className="split-method-label">{choice.label}</span>
                    <span className="split-method-hint">{choice.hint}</span>
                  </label>
                ))}
              </div>
              <div className="split-method-choices split-method-choices--compact">
                {SPLIT_METHOD_SECONDARY.map((choice) => (
                  <label
                    key={choice.value}
                    className={`split-method-chip is-compact${
                      method === choice.value ? ' is-selected' : ''
                    }`}
                    title={choice.hint}
                  >
                    <input
                      type="radio"
                      name="split-method"
                      value={choice.value}
                      checked={method === choice.value}
                      onChange={() => setMethod(choice.value)}
                    />
                    <span className="split-method-label">{choice.label}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="field full-span group-allocation-preview">
              <span>
                {method === 'custom'
                  ? 'Minutes per client'
                  : method === 'percent'
                    ? 'Percentage per client'
                    : 'Allocation'}
              </span>
              <ul className="group-allocation-list">
                {targetIds.map((id) => (
                  <li key={id}>
                    <span className="group-allocation-name">{clientName(clients, id)}</span>
                    {method === 'custom' ? (
                      <input
                        className="input group-allocation-input"
                        type="number"
                        min="0"
                        // Minutes can be fractional (entries are seconds-exact),
                        // so a whole-minute step would make some splits
                        // impossible to balance.
                        step="any"
                        value={customMinutes[id] ?? ''}
                        onChange={(event) =>
                          setCustomMinutes((prev) => ({ ...prev, [id]: event.target.value }))
                        }
                        placeholder="min"
                      />
                    ) : method === 'percent' ? (
                      // The percentage AND what it means in time, side by side —
                      // "40%" on its own doesn't tell her what she just billed.
                      <span className="group-allocation-percent">
                        <input
                          className="input group-allocation-input"
                          type="number"
                          min="0"
                          max="100"
                          step="any"
                          value={percentages[id] ?? ''}
                          onChange={(event) => setPercentage(id, event.target.value)}
                          aria-label={`${clientName(clients, id)} percentage`}
                        />
                        <span className="group-allocation-percent-sign">%</span>
                        <span className="group-allocation-amount">
                          {formatHoursMinutes(allocation[id] ?? 0)}
                        </span>
                      </span>
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
                {isAdjust ? ` — was ${formatHoursMinutes(prefill.totalMinutes)}` : ''}
                {mode === 'full' && targetIds.length > 1
                  ? ` — ${formatHoursMinutes(blockMinutes)} to each of ${targetIds.length} clients`
                  : ''}
                {!isAdjust && method === 'custom' && remainderSeconds !== 0
                  ? ` — ${formatHoursMinutes(Math.abs(remainderSeconds) / 60)} ${
                      remainderSeconds > 0 ? 'still unassigned' : 'over the block'
                    }`
                  : ''}
                {!isAdjust && method === 'custom' && remainderSeconds === 0
                  ? ' — the block is fully assigned'
                  : ''}
              </p>
              {method === 'percent' && targetIds.length > 0 ? (
                <p className="group-allocation-percent-total">
                  Adds up to {formatPercentValue(percentTotal)}%
                  {percentUnbalanced
                    ? percentTotal < 100
                      ? ` — ${formatPercentValue(100 - percentTotal)}% left`
                      : ` — ${formatPercentValue(percentTotal - 100)}% over`
                    : ' — every minute of the block is assigned'}
                </p>
              ) : null}
              {mustBalance && balanceTargetId ? (
                <button type="button" className="secondary-action" onClick={applyBalance}>
                  {remainderSeconds > 0 ? 'Assign the remaining ' : 'Take '}
                  {formatHoursMinutes(Math.abs(remainderSeconds) / 60)}
                  {remainderSeconds > 0 ? ' to ' : ' off '}
                  {clientName(clients, balanceTargetId)}
                </button>
              ) : null}
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
              disabled={pending || mustBalance || percentUnbalanced}
              onClick={() => void handleConfirm()}
            >
              <Clock3 size={16} />
              {isAdjust
                ? pending
                  ? 'Saving...'
                  : 'Save split'
                : pending
                  ? 'Splitting...'
                  : 'Split & bill'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * "Sent back" — a dedicated home for the current user's REJECTED time so it can
 * be found and fixed in one place.
 *
 * Why this exists separately from Recent time: rejected entries used to be
 * findable only in that list, which is scoped to the report period AND capped at
 * the 8 most recent. Anyone who logs a lot (Lisa had ~36 entries in one week)
 * simply never saw theirs — they looked lost. This list is unscoped, uncapped,
 * and sits above Recent time. It disappears entirely when nothing is sent back.
 *
 * Each row is the normal entry row, so the rejection note, the full editor and
 * "Edit & resubmit" all work exactly as they do elsewhere; saving an edit puts
 * the entry back in the owner's queue automatically.
 */
function SentBackEntries({
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
  onUpdate: React.ComponentProps<typeof RecentTimeEntries>['onUpdate']
  onDelete: (entryId: string) => Promise<void>
  onResume: (entry: TimeEntry) => void
  onSplitGroup: (entry: TimeEntry) => void
}) {
  // Collapsible + independently scrollable: a long sent-back list must never
  // push Recent time (or anything below) off the screen.
  const [open, setOpen] = useState(true)
  if (entries.length === 0) return null
  return (
    <section className="panel panel--sent-back">
      <div className="section-heading">
        <button
          type="button"
          className="panel-collapse-btn"
          aria-expanded={open}
          aria-label={open ? 'Collapse sent-back entries' : 'Expand sent-back entries'}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        </button>
        <div>
          <p className="section-kicker">Needs your attention</p>
          <h2>Sent back</h2>
          {open ? (
            <p className="section-subtitle">
              {entries.length === 1
                ? 'An owner sent this entry back for a change.'
                : `An owner sent these ${entries.length} entries back for changes.`}{' '}
              Fix each one and hit <strong>Edit &amp; resubmit</strong> — it goes straight back for
              approval, no need to resubmit the whole week. Oldest first.
            </p>
          ) : null}
        </div>
      </div>
      {open ? (
      <div className="entry-list entry-list--scroll">
        {entries.map((entry) => {
          const linkedTask = entry.taskId
            ? checklists.find((checklist) => checklist.id === entry.taskId)
            : null
          const monthLocked =
            role !== 'owner' &&
            locks.some(
              (lock) => lock.userId === entry.employeeId && lock.period === entry.date.slice(0, 7),
            )
          const memberCount = entry.groupClientIds?.length ?? 0
          const isHolding = !entry.clientId && !entry.isAdministrative && memberCount > 0
          const clientLabel = entry.isAdministrative
            ? 'Administrative'
            : isHolding
              ? `Group · ${memberCount} client${memberCount === 1 ? '' : 's'}`
              : clientName(clients, entry.clientId)
          return (
            <TimeEntryRow
              key={entry.id}
              entry={entry}
              clientLabel={clientLabel}
              employeeLabel={employeeName(employees, entry.employeeId)}
              taskTitle={linkedTask ? linkedTask.title : entry.taskLabel ?? null}
              locked={monthLocked}
              timerRunning={timerRunning}
              employees={employees}
              clients={clients}
              checklists={checklists}
              isOwner={role === 'owner'}
              isHolding={isHolding}
              onUpdate={onUpdate}
              onDelete={onDelete}
              onResume={onResume}
              onSplitGroup={onSplitGroup}
            />
          )
        })}
      </div>
      ) : null}
    </section>
  )
}

function RecentTimeEntries({
  checklists,
  clients,
  employees,
  entries,
  totalEntryCount,
  reportPeriodControl,
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
  /** Count of entries BEFORE the report-period filter — drives the empty copy. */
  totalEntryCount: number
  reportPeriodControl: ReactNode
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
  // Most-recently-LOGGED first, so "what I just submitted" sits at the top and
  // is easy to find / edit. Prefer the creation time (when it was logged);
  // fall back to the worked time for legacy rows without one.
  const workedKey = (entry: TimeEntry) => {
    const sessions = entry.sessions ?? []
    const lastSession = sessions.length > 0 ? sessions[sessions.length - 1] : null
    return lastSession?.endAt ?? entry.endAt ?? entry.startAt ?? `${entry.date}T00:00:00`
  }
  // Collapsible + independently scrollable, so neither this nor the sent-back
  // list can push the other off the screen.
  const [open, setOpen] = useState(true)
  const recencyKey = (entry: TimeEntry) => entry.createdAt ?? workedKey(entry)
  const sortedEntries = [...entries].sort((a, b) => {
    const byCreated = recencyKey(b).localeCompare(recencyKey(a))
    return byCreated !== 0 ? byCreated : workedKey(b).localeCompare(workedKey(a))
  })
  return (
    <section className="panel">
      <div className="section-heading">
        <button
          type="button"
          className="panel-collapse-btn"
          aria-expanded={open}
          aria-label={open ? 'Collapse recent time' : 'Expand recent time'}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        </button>
        <div>
          <p className="section-kicker">{role === 'owner' ? 'Team activity' : 'My activity'}</p>
          <h2>Recent time</h2>
        </div>
        <span className="status-pill">
          {sortedEntries.length} in range
        </span>
      </div>
      {open ? (
      <>
      <div className="time-filter-row">{reportPeriodControl}</div>
      {/* Every entry in range, inside its own scroll box — the list used to be
          capped at 8, which silently hid anything older for heavy loggers. */}
      <div className="entry-list entry-list--scroll">
        {sortedEntries.map((entry) => {
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
              taskTitle={linkedTask ? linkedTask.title : entry.taskLabel ?? null}
              locked={monthLocked}
              timerRunning={timerRunning}
              employees={employees}
              clients={clients}
              checklists={checklists}
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
          <p className="empty-state">
            {totalEntryCount === 0
              ? 'No time logged yet.'
              : 'No time logged in this report period.'}
          </p>
        ) : null}
      </div>
      </>
      ) : null}
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
  clients,
  checklists,
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
  /** Clients the user may move this entry to (their visible list). */
  clients: Client[]
  /** All visible checklists — filtered to the picked client for the task list. */
  checklists: Checklist[]
  isOwner: boolean
  isHolding: boolean
  onUpdate: (
    entryId: string,
    patch: {
      minutes?: number
      description?: string
      billable?: boolean
      clientId?: string
      isAdministrative?: boolean
      isAdhoc?: boolean
      taskId?: string | null
      date?: string
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
  // Entries captured with exact start/stop (timer + new manual entries) get the
  // sessions editor ON TOP OF the hours/minutes duration field; legacy entries
  // without timestamps get the duration field alone.
  const sessions = effectiveSessions(entry)
  const hasSessions = sessions.length > 0
  const [editing, setEditing] = useState(false)
  const [hours, setHours] = useState(Math.floor(entry.minutes / 60).toString())
  const [minutes, setMinutes] = useState((entry.minutes % 60).toString())
  const [editSessions, setEditSessions] = useState(() => entryToEditSessions(entry))
  // Which of the two time facts the user actually touched. The duration is what
  // gets BILLED and the spans are WHEN the work happened; they normally agree,
  // so an untouched duration follows the spans. Touching the duration makes it
  // user-set — it is then sent as `minutes` and the server bills exactly that.
  // Untouched spans are not sent at all, which is what stops a save from
  // truncating a seconds-exact timer stop back to whole minutes.
  const [durationTouched, setDurationTouched] = useState(false)
  const [spansTouched, setSpansTouched] = useState(false)
  const [description, setDescription] = useState(entry.description)
  const [billable, setBillable] = useState(entry.billable)
  const [isAdhoc, setIsAdhoc] = useState(Boolean(entry.isAdhoc))
  const [reassignTo, setReassignTo] = useState(entry.employeeId)
  // Every other field is editable too — the client it's billed to, the task,
  // whether it's administrative, and the date it lands on.
  const [editClientId, setEditClientId] = useState(entry.clientId ?? '')
  const [editIsAdmin, setEditIsAdmin] = useState(Boolean(entry.isAdministrative))
  const [editTaskId, setEditTaskId] = useState(entry.taskId ?? '')
  const [editDate, setEditDate] = useState(entry.date)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Does this entry bill something other than what its clock spans add up to?
  // True only when a duration was typed — a split slice legitimately carries
  // the whole block's spans against its own share, which is not an adjustment.
  const billedDiffersFromClock =
    hasSessions &&
    !entry.groupId &&
    Math.round(entry.minutes * 60) !==
      Math.round(sessions.reduce((sum, session) => sum + sessionMinutes(session), 0) * 60)

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
    setMinutes(Math.round(entry.minutes % 60).toString())
    setDurationTouched(false)
    // "Add time" appends a session, so the spans ARE edited before the form
    // even opens — the appended time has to reach the server.
    setSpansTouched(withExtraSession)
    setDescription(entry.description)
    setBillable(entry.billable)
    setIsAdhoc(Boolean(entry.isAdhoc))
    setReassignTo(entry.employeeId)
    setEditClientId(entry.clientId ?? '')
    setEditIsAdmin(Boolean(entry.isAdministrative))
    setEditTaskId(entry.taskId ?? '')
    setEditDate(entry.date)
    setError('')
    setEditing(true)
  }

  // Tasks belong to a client, so the picker follows whichever client is chosen.
  const taskOptions = editIsAdmin
    ? []
    : checklists.filter((checklist) => checklist.clientId === editClientId)

  /**
   * This entry is an unsplit GROUP-timer block: no single client, its members
   * held in `groupClientIds` until it is split for billing. Such a block may be
   * edited (start/stop, duration, date, notes) WITHOUT being collapsed to one
   * client — see `handleSave`.
   */
  const editingGroupBlock = isGroupHoldingEntry(entry)
  const groupMemberCount = entry.groupClientIds?.length ?? 0

  // The client / task / date / admin part of the patch, shared by both save
  // paths (sessions editor and legacy hours+minutes editor).
  const detailsPatch = (() => {
    const patch: {
      clientId?: string
      isAdministrative?: boolean
      isAdhoc?: boolean
      taskId?: string | null
      date?: string
    } = {}
    if (editIsAdmin !== Boolean(entry.isAdministrative)) patch.isAdministrative = editIsAdmin
    if (editIsAdmin) {
      // Admin time carries no client or task; the server enforces this too. It
      // also has no client to be outside the scope of, so the ad hoc flag goes
      // with it rather than lingering on a re-filed entry.
      if (entry.clientId) patch.clientId = ''
      if (entry.taskId) patch.taskId = null
      if (entry.isAdhoc) patch.isAdhoc = false
    } else {
      if (editClientId !== (entry.clientId ?? '')) patch.clientId = editClientId
      if ((editTaskId || null) !== (entry.taskId ?? null)) patch.taskId = editTaskId || null
      if (isAdhoc !== Boolean(entry.isAdhoc)) patch.isAdhoc = isAdhoc
    }
    if (editDate && editDate !== entry.date) patch.date = editDate
    return patch
  })()

  // Owner-only: reassign this entry to another team member when the picked
  // employee differs from the current one. Empty otherwise.
  const reassignPatch =
    isOwner && reassignTo && reassignTo !== entry.employeeId ? { employeeId: reassignTo } : {}

  const updateSessionRow = (id: string, patch: { start?: string; stop?: string }) => {
    setSpansTouched(true)
    setEditSessions((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  }
  const addSessionRow = () => {
    setSpansTouched(true)
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
  }
  const removeSessionRow = (id: string) => {
    setSpansTouched(true)
    setEditSessions((rows) => rows.filter((row) => row.id !== id))
  }

  const editTotalMinutes = editSessions.reduce((sum, row) => {
    const startMs = row.start ? new Date(row.start).getTime() : NaN
    const stopMs = row.stop ? new Date(row.stop).getTime() : NaN
    if (Number.isNaN(startMs) || Number.isNaN(stopMs) || stopMs <= startMs) return sum
    return sum + Math.round((stopMs - startMs) / 60000)
  }, 0)

  // The duration the user typed, or NaN while a field is mid-edit / invalid.
  const typedDurationMinutes = (() => {
    const hoursPart = hours.trim() === '' ? 0 : Number(hours)
    const minutesPart = minutes.trim() === '' ? 0 : Number(minutes)
    if (Number.isNaN(hoursPart) || Number.isNaN(minutesPart) || hoursPart < 0 || minutesPart < 0) {
      return NaN
    }
    return Math.round(hoursPart * 60 + minutesPart)
  })()

  // What this entry will actually BILL if saved right now — the same rule the
  // server applies, so the preview and the stored result cannot disagree. A
  // typed duration wins; otherwise it follows the spans (and for a slice, moves
  // by the session delta instead of snapping back to the whole block).
  const previewMinutes = minutesAfterEntryEdit({
    typedMinutes: durationTouched && !Number.isNaN(typedDurationMinutes) ? typedDurationMinutes : null,
    sessionsMinutes: editTotalMinutes,
    isSlice: Boolean(entry.groupId),
    currentMinutes: entry.minutes,
    previousSessions: sessions,
    nextSessions: editSessions.flatMap((row) => {
      const startIso = localInputToIso(row.start)
      const stopIso = localInputToIso(row.stop)
      return startIso && stopIso ? [{ startAt: startIso, endAt: stopIso }] : []
    }),
  })

  // Until the user takes the duration over, the field MIRRORS the spans (so
  // moving a clock time updates it live). Derived rather than synced into state
  // — the displayed value is a function of the spans, not a second copy of them.
  const durationFollowsSpans = hasSessions && !durationTouched
  const displayHours = durationFollowsSpans ? Math.floor(previewMinutes / 60).toString() : hours
  const displayMinutes = durationFollowsSpans
    ? Math.round(previewMinutes % 60).toString()
    : minutes

  // Typing in either duration box takes BOTH over, seeded from what the spans
  // say right now — otherwise editing just the minutes would silently revert
  // the hours to whatever they were when the form opened.
  const takeOverDuration = (next: { hours?: string; minutes?: string }) => {
    if (!durationTouched) {
      setHours(displayHours)
      setMinutes(displayMinutes)
      setDurationTouched(true)
    }
    if (next.hours !== undefined) setHours(next.hours)
    if (next.minutes !== undefined) setMinutes(next.minutes)
  }

  const handleSave = async () => {
    // A group-timer block legitimately has NO single client — its members live
    // in `groupClientIds` until it is split for billing. This guard predates
    // group entries and applied a single-client assumption to the one entry
    // type that is defined by not having one, so fixing a group block's
    // start/stop meant first collapsing it to a single client: exactly the
    // reported bug. The SERVER already allows it (see `isGroupPending` in the
    // create path, and the PATCH handler imposes no client rule at all) — this
    // was the client being stricter than the API.
    //
    // Picking a client here still works and still collapses the block to that
    // one client; it just isn't forced any more.
    if (!editIsAdmin && !editClientId && !editingGroupBlock) {
      setError('Pick a client, or mark the entry as administrative.')
      return
    }
    // An edit may not empty a detail that was filled in (the server refuses it
    // too). An entry saved before details were mandatory is left alone: its
    // minutes, client and date stay editable, blank detail and all.
    if ((entry.description ?? '').trim() && !description.trim()) {
      setError(TIME_ENTRY_FIELD_PROMPTS.detail)
      return
    }
    // The typed duration is only validated (and only sent) when the user
    // actually took the field over — an untouched one is just mirroring the
    // spans, and re-sending it would overwrite a seconds-exact total with its
    // whole-minute rendering.
    if (durationTouched || !hasSessions) {
      if (Number.isNaN(typedDurationMinutes)) {
        setError('Enter a valid number of hours and minutes.')
        return
      }
      if (typedDurationMinutes <= 0) {
        setError('Enter hours and/or minutes greater than zero.')
        return
      }
    }

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
        await onUpdate(entry.id, {
          // Each of the two time facts travels only when it was edited: the
          // spans as `sessions`, the billed duration as `minutes`. Sending a
          // typed duration is what makes it stick — the server bills exactly
          // that and keeps the spans as the record of when the work happened.
          ...(spansTouched ? { sessions: built } : {}),
          ...(durationTouched ? { minutes: typedDurationMinutes } : {}),
          description,
          billable,
          ...detailsPatch,
          ...reassignPatch,
        })
        setEditing(false)
      } catch {
        setError('Could not save — the month may be locked.')
      } finally {
        setBusy(false)
      }
      return
    }

    setBusy(true)
    setError('')
    try {
      await onUpdate(entry.id, {
        minutes: typedDurationMinutes,
        description,
        billable,
        ...detailsPatch,
        ...reassignPatch,
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
          <label className="check-row">
            <input
              checked={editIsAdmin}
              type="checkbox"
              onChange={(event) => {
                const next = event.target.checked
                setEditIsAdmin(next)
                // Admin time has no client/task and is never billable.
                if (next) {
                  setEditTaskId('')
                  setBillable(false)
                }
              }}
            />
            <span>Administrative / internal (no client)</span>
          </label>
          {!editIsAdmin ? (
            <>
              <label className="field">
                <span>Client</span>
                <select
                  className="input"
                  value={editClientId}
                  onChange={(event) => {
                    setEditClientId(event.target.value)
                    // Tasks belong to a client — drop a task from the old one.
                    setEditTaskId('')
                  }}
                >
                  {/* On a group block, blank is a real choice — it keeps the
                      block multi-client so it can be split afterwards. Saying
                      "Select a client…" there is what made it read as required. */}
                  <option value="">
                    {editingGroupBlock
                      ? `Keep as group time (${groupMemberCount} ${groupMemberCount === 1 ? 'client' : 'clients'}) — split it below`
                      : 'Select a client…'}
                  </option>
                  {/* Re-pointing an entry bills someone new, so retired clients
                      are not offered — but the entry's CURRENT client stays
                      listed even if retired, or an old entry would open showing
                      "Select a client…" and lose its attribution on save. */}
                  {selectableClients(clients, [entry.clientId]).map((client) => (
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
                  value={editTaskId}
                  disabled={!editClientId}
                  onChange={(event) => setEditTaskId(event.target.value)}
                >
                  <option value="">No specific task</option>
                  {taskOptions.map((task) => (
                    <option key={task.id} value={task.id}>
                      {task.title}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : null}
          <label className="field">
            <span>Date</span>
            <input
              className="input"
              type="date"
              value={editDate}
              onChange={(event) => setEditDate(event.target.value)}
            />
          </label>
          {hasSessions ? (
            <div className="session-editor">
              <span className="session-editor-label">Work sessions</span>
              <small className="session-editor-hint">
                When the work happened. The billed time follows these unless you set it yourself
                below.
              </small>
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
          ) : null}
          {/* The billed duration. Offered on EVERY entry, not just the legacy
              ones without timestamps: on a session-backed entry it used to be
              missing entirely, so the only way to change the time was to move
              the clock — "still will not let me edit the time before I split
              it". Typing here sets what gets billed; the sessions above stay as
              the record of when the work happened. */}
          <div className="entry-duration-fields">
            <label className="field">
              <span>Hours</span>
              <input
                className="input"
                min="0"
                step="1"
                type="number"
                value={displayHours}
                onChange={(event) => takeOverDuration({ hours: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Minutes</span>
              <input
                className="input"
                min="0"
                step="1"
                type="number"
                value={displayMinutes}
                onChange={(event) => takeOverDuration({ minutes: event.target.value })}
              />
            </label>
          </div>
          {hasSessions ? (
            <small className="entry-duration-hint">
              Billing {formatHoursMinutes(previewMinutes)}
              {durationTouched ? ' — set by you' : ' — from the sessions above'}
            </small>
          ) : null}
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
          {/* Hidden on administrative time, which has no client to be outside
              the scope of — the same rule the create path and server apply. */}
          {!editIsAdmin ? (
            <label className="check-row">
              <input
                checked={isAdhoc}
                type="checkbox"
                onChange={(event) => setIsAdhoc(event.target.checked)}
              />
              <span>Ad hoc (outside scoped work)</span>
            </label>
          ) : null}
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
            {/* The client dropdown above MOVES this time to one client; this
                DIVIDES it across several. Offered on any client-billed entry —
                the same `canEdit` gate that opened this form. On an entry that
                is ALREADY part of a split it reopens that split with its
                current distribution instead of starting a new one. */}
            {!editIsAdmin && entry.clientId ? (
              <button
                className="secondary-action"
                type="button"
                disabled={busy}
                onClick={() => {
                  setEditing(false)
                  setError('')
                  onSplitGroup(entry)
                }}
              >
                {entry.groupId ? 'Adjust split…' : 'Split across clients…'}
              </button>
            ) : null}
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
          {canEdit ? (
            <button
              type="button"
              className="secondary-action"
              disabled={busy || locked}
              onClick={() => openEditor(false)}
              title="Edit the tracked time / notes before splitting"
            >
              Edit
            </button>
          ) : null}
          {canEdit ? (
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
            {/* The billed time is allowed to differ from the clock — someone
                typed a duration. Say so, or the row shows two durations with no
                explanation of which one is being invoiced. A SLICE is exempt:
                its minutes differ because the block was split, not adjusted. */}
            {billedDiffersFromClock ? (
              <small className="entry-audit-adjusted">
                Billed {formatHoursMinutes(entry.minutes)} — adjusted from the tracked clock
              </small>
            ) : null}
          </div>
        ) : null}
        <div className="entry-tags">
          <StatusPill status={entry.approvalStatus} />
          {entry.entryMethod === 'manual' ? <ManualBadge /> : null}
          {/* Visible without opening the editor: this is the flag that decides
              how the time is billed, so it should not take a click to see. */}
          {entry.isAdhoc ? <span className="adhoc-chip">Ad hoc</span> : null}
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
            {/* Same affordance a group holding block gets, on ordinary client
                time — and on a slice of an existing split it becomes the way
                back IN: it reopens that split with the clients and amounts it
                currently has, rather than starting a fresh one from this slice. */}
            {entry.clientId && !entry.isAdministrative ? (
              <button
                type="button"
                className="link-action"
                disabled={busy}
                onClick={() => onSplitGroup(entry)}
              >
                {entry.groupId ? 'Adjust split' : 'Split across clients'}
              </button>
            ) : null}
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
