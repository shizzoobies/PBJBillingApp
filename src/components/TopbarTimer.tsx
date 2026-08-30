import { TimerReset } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { buildTimeTaskOptions, resolveTimeTaskChoice } from '../lib/timeTaskOptions'
import type { Checklist, ChecklistTemplate, Client, TimerState } from '../lib/types'
import { clientName, currentBillingPeriod, eligibleChecklistsFor } from '../lib/utils'

/**
 * The time-tracking control that lives in the TOPBAR, on every screen.
 *
 * The problem it solves is not "the app has no timer" — it has had one on the
 * Time page for a long time. It is that the timer was only visible on that one
 * page: start it, walk over to Checklists, and there was no way to tell whether
 * the clock was still running, nor any way to start one without navigating away
 * from whatever you were about to time.
 *
 * IMPORTANT — this is a VIEW, not a second timer. The running timer already
 * lives in app-level state (`App.tsx`: `timer` / `startTimer` / the 1s `setNow`
 * interval / the `pbj.activeTimer.v1` localStorage mirror) and is handed out
 * through {@link useAppContext}. That is why the display keeps ticking across
 * navigation and survives a refresh for free: this component only reads it.
 * Any temptation to keep elapsed time in local state here would produce two
 * clocks that disagree the moment one of them re-mounts.
 *
 * Stopping deliberately does NOT live here. A stop has to satisfy the server's
 * required-field rules (client, task, detail) and shows the inline prompts that
 * explain a refusal — all of which is the Time page's timer panel. So a running
 * timer in the bar is a link to that panel, not a second Stop button that would
 * have to grow its own copy of the validation.
 */
export function TopbarTimer() {
  const {
    activeEmployeeId,
    data,
    previewMode,
    role,
    startTimer,
    timeTrackingClients,
    timer,
    timerElapsed,
  } = useAppContext()
  const navigate = useNavigate()
  const [modalOpen, setModalOpen] = useState(false)

  // The same two gates the Time page's timer panel applies (`inputsDisabled`
  // there): a locked timesheet for the current month, and preview mode — where
  // `startTimer` is a no-op anyway, so an enabled button would silently do
  // nothing. Owners are never period-locked.
  const currentPeriod = currentBillingPeriod()
  const lockedThisPeriod =
    role !== 'owner' &&
    (data.timesheetLocks ?? []).some(
      (lock) => lock.userId === activeEmployeeId && lock.period === currentPeriod,
    )
  const startDisabled = lockedThisPeriod || previewMode

  if (timer) {
    // What is being timed, in as few words as the bar can spare. Looked up
    // against the FULL client list rather than the pickable one: a timer may
    // have been started against a client that has since been retired, and a
    // running clock labeled "Unknown client" is worse than no label.
    const label = timer.isAdministrative
      ? 'Administrative'
      : (timer.groupClientIds?.length ?? 0) > 0
        ? `${timer.groupClientIds?.length} clients`
        : timer.clientId
          ? clientName(data.clients, timer.clientId)
          : 'No client yet'
    return (
      <button
        type="button"
        className="topbar-timer running"
        onClick={() => navigate('/time')}
        aria-label={`Timer running — ${timerElapsed} on ${label}. Open the Time page to stop and log it.`}
        title="A timer is running. Open the Time page to stop and log it."
      >
        <TimerReset size={16} aria-hidden="true" />
        <span className="topbar-timer-elapsed">{timerElapsed}</span>
        <span className="topbar-timer-label">{label}</span>
      </button>
    )
  }

  return (
    <>
      <button
        type="button"
        className="topbar-timer"
        disabled={startDisabled}
        onClick={() => setModalOpen(true)}
        title={
          previewMode
            ? 'You are previewing as another user, so no time can be started here.'
            : lockedThisPeriod
              ? 'Your timesheet is locked for this month, so no time can be started.'
              : 'Start a timer from anywhere.'
        }
      >
        <TimerReset size={16} aria-hidden="true" />
        <span className="topbar-timer-label">Start timer</span>
      </button>
      {modalOpen ? (
        <StartTimerModal
          checklists={data.checklists}
          clients={timeTrackingClients}
          employeeId={activeEmployeeId}
          onClose={() => setModalOpen(false)}
          onStart={startTimer}
          templates={data.checklistTemplates}
        />
      ) : null}
    </>
  )
}

/** The placeholder the client picker opens on — see the Time page's own copy. */
const CHOOSE_CLIENT_LABEL = 'Choose client'

/** Shared id for the task suggestions <datalist>, same idiom as `ClientTimeModal`. */
const TASK_DATALIST_ID = 'topbar-timer-task-options'

/**
 * "What are you about to work on?" — the smallest form that can legally start a
 * timer, mirroring the Time page's own rule: starting is FREE apart from
 * needing to know WHO the time is for. Everything else the eventual Stop & log
 * demands (task, detail) is asked for there, with the prompts that explain it,
 * exactly as it is for a timer started on the page itself.
 *
 * The client list handed in is `timeTrackingClients`, which is `workableClients`
 * scoped to this person's assignments — so retired clients and BILLING MASTERS
 * (payers that hold no work; the server refuses time written against them) are
 * absent here for the same reason they are absent from the Time page dropdown.
 *
 * The task box is the same pick-or-type field as the client-list "Track time"
 * modal — this client's open tasks, every standard blueprint, and whatever you
 * type — resolved through the shared {@link resolveTimeTaskChoice}, so a typed
 * name that IS a real task attaches to it instead of becoming free text.
 */
function StartTimerModal({
  checklists,
  clients,
  employeeId,
  onClose,
  onStart,
  templates,
}: {
  checklists: Checklist[]
  clients: Client[]
  employeeId: string
  onClose: () => void
  onStart: (timer: TimerState) => void
  templates: ChecklistTemplate[]
}) {
  // Opens on the placeholder, never on the first client in the list: a real
  // client pre-selected is a real client billed by accident.
  const [clientId, setClientId] = useState('')
  const [isAdministrative, setIsAdministrative] = useState(false)
  const [task, setTask] = useState('')
  const [description, setDescription] = useState('')

  const clientTasks = useMemo(
    () => (clientId ? eligibleChecklistsFor(checklists, clientId) : []),
    [checklists, clientId],
  )
  const taskOptions = useMemo(
    () => buildTimeTaskOptions(clientTasks, templates),
    [clientTasks, templates],
  )
  // Counted off the deduped OPTIONS so the caption describes the list under it.
  const ownCount = taskOptions.filter((option) => option.checklistId).length
  const standardCount = taskOptions.length - ownCount

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const canStart = isAdministrative || Boolean(clientId)

  const handleStart = () => {
    if (!canStart) return
    // Administrative time has no client, so by definition it has no task.
    const { taskId, taskLabel } = isAdministrative
      ? { taskId: null, taskLabel: undefined }
      : resolveTimeTaskChoice(task, taskOptions)
    onStart({
      employeeId,
      clientId: isAdministrative ? '' : clientId,
      description: description.trim(),
      startedAt: Date.now(),
      taskId,
      taskLabel,
      isAdministrative,
      isAdhoc: false,
    })
    onClose()
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
        className="modal-panel start-timer-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Start a timer"
      >
        <div className="modal-body">
          <h2 className="modal-title">Start a timer</h2>
          <p className="modal-intro">
            The clock starts now and keeps running in the bar while you work, wherever you
            go in the app.
          </p>

          <label className="check-row full-span">
            <input
              checked={isAdministrative}
              onChange={(event) => setIsAdministrative(event.target.checked)}
              type="checkbox"
            />
            <span>Administrative work (company meeting, internal — no client or task)</span>
          </label>

          {isAdministrative ? null : (
            <>
              <label className="field full-span">
                <span>Client</span>
                <select
                  className="input"
                  onChange={(event) => {
                    setClientId(event.target.value)
                    // The task list belongs to the client — a name typed for the
                    // old one must not follow the picker to a new one.
                    setTask('')
                  }}
                  value={clientId}
                >
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
              <label className="field full-span">
                <span>Task</span>
                <input
                  className="input"
                  list={TASK_DATALIST_ID}
                  onChange={(event) => setTask(event.target.value)}
                  placeholder="No specific task — pick one or type your own"
                  type="text"
                  value={task}
                />
                {/* Bare option values on purpose: browsers disagree about whether
                    a datalist option renders its value or its text, so the
                    grouping is said in the caption instead of inside the list. */}
                <datalist id={TASK_DATALIST_ID}>
                  {taskOptions.map((option) => (
                    <option key={option.label} value={option.label} />
                  ))}
                </datalist>
              </label>
              <p className="start-timer-note">
                {ownCount > 0
                  ? `${ownCount} open task${ownCount === 1 ? '' : 's'} for this client`
                  : 'No open tasks for this client'}
                {standardCount > 0
                  ? `, plus ${standardCount} standard task${standardCount === 1 ? '' : 's'}`
                  : ''}
                . Anything you type that isn&rsquo;t in the list is used exactly as typed.
              </p>
            </>
          )}

          <label className="field full-span">
            <span>{isAdministrative ? 'Notes (what is this for?)' : 'What are you doing?'}</span>
            <textarea
              className="input"
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Optional now — you can fill this in before you stop."
              rows={3}
              value={description}
            />
          </label>

          <p className="start-timer-note">
            Everything here can be left blank except the client — the clock starts now and
            the task and detail are only required when you stop and log the time, which you
            do on the Time page.
          </p>

          <div className="button-row">
            <button type="button" className="secondary-action" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="primary-action"
              disabled={!canStart}
              onClick={handleStart}
              title={
                canStart
                  ? undefined
                  : `Pick a client first — the field starts on "${CHOOSE_CLIENT_LABEL}".`
              }
            >
              <TimerReset size={16} aria-hidden="true" />
              Start timer
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
