import { Clock3, TimerReset } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { useAppContext } from '../AppContext'
import type { Checklist, Client, Employee, Role, TimeEntry, TimerState } from '../lib/types'
import { clientName, employeeName, formatHours } from '../lib/utils'

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
  } = useAppContext()

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
      />
      <RecentTimeEntries
        checklists={data.checklists}
        clients={data.clients}
        employees={data.employees}
        entries={visibleEntries}
        role={role}
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
}: {
  activeEmployeeId: string
  clients: Client[]
  checklists: Checklist[]
  employees: Employee[]
  onLog: (entry: Omit<TimeEntry, 'id'>) => Promise<void>
  onStartTimer: (timer: TimerState) => void
  onStopTimer: () => Promise<void>
  role: Role
  timer: TimerState | null
  timerElapsed: string
}) {
  const [clientId, setClientId] = useState(clients[0]?.id ?? '')
  const [employeeId, setEmployeeId] = useState(activeEmployeeId)
  const [hours, setHours] = useState('1.25')
  const [category, setCategory] = useState('Bookkeeping')
  // Tracks whether the user has manually changed the work-type field. We only
  // auto-fill from the picked task on first selection so we never clobber a
  // deliberate override.
  const [categoryDirty, setCategoryDirty] = useState(false)
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

  const handleTaskPick = (nextTaskId: string) => {
    setTaskId(nextTaskId)
    if (!nextTaskId || categoryDirty) return
    // Categories on tasks aren't a first-class field today, but we can pick
    // up a sensible work-type from the title prefix (e.g. "Payroll - CD" →
    // "Payroll"). Only the predefined options are honored.
    const task = eligibleTasks.find((entry) => entry.id === nextTaskId)
    if (!task) return
    const titleHead = task.title.split(/[-:]/, 1)[0]?.trim() ?? ''
    const known = ['Bookkeeping', 'Payroll', 'Cleanup', 'Advisory', 'Admin']
    const match = known.find((option) => option.toLowerCase() === titleHead.toLowerCase())
    if (match) setCategory(match)
  }

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
        category,
        description,
        billable,
        taskId: effectiveTaskId || null,
      })
      setDescription('')
      setHours('0.50')
      setTaskId('')
      setCategoryDirty(false)
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
      category,
      startedAt: Date.now(),
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
          >
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Attach to task (optional)</span>
          <select
            className="input"
            onChange={(event) => handleTaskPick(event.target.value)}
            value={effectiveTaskId}
            disabled={eligibleTasks.length === 0}
          >
            <option value="">(none)</option>
            {eligibleTasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.title}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Work type</span>
          <select
            className="input"
            onChange={(event) => {
              setCategory(event.target.value)
              setCategoryDirty(true)
            }}
            value={category}
          >
            <option>Bookkeeping</option>
            <option>Payroll</option>
            <option>Cleanup</option>
            <option>Advisory</option>
            <option>Admin</option>
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
          />
        </label>
        <label className="field full-span">
          <span>What did you do?</span>
          <textarea
            className="input"
            onChange={(event) => setDescription(event.target.value)}
            rows={4}
            value={description}
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
        {submitError ? <p className="auth-error full-span">{submitError}</p> : null}
        <div className="button-row full-span">
          <button className="primary-action" disabled={submitPending} type="submit">
            <Clock3 size={16} />
            {submitPending ? 'Saving...' : 'Log time'}
          </button>
          {timer ? (
            <button
              className="secondary-action danger"
              disabled={submitPending}
              onClick={() => void onStopTimer()}
              type="button"
            >
              <TimerReset size={16} />
              Stop &amp; log
            </button>
          ) : (
            <button
              className="secondary-action"
              disabled={submitPending}
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
}: {
  checklists: Checklist[]
  clients: Client[]
  employees: Employee[]
  entries: TimeEntry[]
  role: Role
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
          return (
            <article className="entry-row" key={entry.id}>
              <div>
                <strong>{clientName(clients, entry.clientId)}</strong>
                <span>{entry.description}</span>
                <small>
                  {entry.category} · {employeeName(employees, entry.employeeId)}
                </small>
                {linkedTask ? (
                  <small className="task-chip">Task: {linkedTask.title}</small>
                ) : null}
              </div>
              <div className="entry-meta">
                <strong>{formatHours(entry.minutes)}</strong>
                <span>{entry.billable ? 'Billable' : 'Internal'}</span>
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
