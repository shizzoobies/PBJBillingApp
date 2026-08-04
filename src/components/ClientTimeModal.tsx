import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Play } from 'lucide-react'
import { useAppContext } from '../AppContext'
import { AddModal } from './AddModal'
import type { Client } from '../lib/types'
import { buildTimeTaskOptions, resolveTimeTaskChoice } from '../lib/timeTaskOptions'
import { eligibleChecklistsFor, formatHours } from '../lib/utils'

/** Shared id for the task suggestions <datalist>, same idiom as Contacts' Group input. */
const TASK_DATALIST_ID = 'client-time-task-options'

/**
 * Start tracking time for one client without leaving the client list. Picks an
 * optional task and a note, then starts the shared timer — the same timer the
 * Time page drives, so it keeps running as you navigate and stops there as
 * usual. Only one timer runs at a time, so when one is already going this just
 * says so and offers the Time page instead.
 *
 * The task box is a pick-or-type field (see {@link buildTimeTaskOptions}): the
 * client's own open tasks, every standard blueprint in the workspace, and
 * whatever you type. It replaced a plain <select> of the client's open tasks,
 * which left you with nothing to pick on a client that had none.
 */
export function ClientTimeModal({ client, onClose }: { client: Client; onClose: () => void }) {
  const { data, timer, timerElapsed, startTimer, sessionUser } = useAppContext()
  const [task, setTask] = useState('')
  const [description, setDescription] = useState('')

  const clientTasks = useMemo(
    () => eligibleChecklistsFor(data.checklists, client.id),
    [data.checklists, client.id],
  )
  const taskOptions = useMemo(
    () => buildTimeTaskOptions(clientTasks, data.checklistTemplates),
    [clientTasks, data.checklistTemplates],
  )
  // Counted off the deduped OPTIONS, not the raw inputs, so the caption always
  // describes the list actually under it.
  const ownCount = taskOptions.filter((option) => option.checklistId).length
  const standardCount = taskOptions.length - ownCount

  // This month's logged time for the client — quick context before starting.
  const loggedMinutes = useMemo(() => {
    const month = new Date().toISOString().slice(0, 7)
    return data.timeEntries
      .filter((entry) => entry.clientId === client.id && entry.date.startsWith(month))
      .reduce((sum, entry) => sum + entry.minutes, 0)
  }, [data.timeEntries, client.id])

  const start = () => {
    // A typed name that IS one of this client's open tasks still attaches to the
    // real checklist; anything else rides along as free text. Same two fields
    // the entry always had — nothing new is persisted.
    const { taskId, taskLabel } = resolveTimeTaskChoice(task, taskOptions)
    startTimer({
      employeeId: sessionUser.id,
      clientId: client.id,
      description: description.trim(),
      startedAt: Date.now(),
      taskId,
      taskLabel,
    })
    onClose()
  }

  return (
    <AddModal title={`Track time · ${client.name}`} onClose={onClose}>
      {timer ? (
        <div className="client-time-running">
          <p>
            A timer is already running ({timerElapsed}). Only one can run at a time — stop it on
            the Time page first.
          </p>
          <Link to="/time" className="primary-action" onClick={onClose}>
            Go to Time <ArrowRight size={14} />
          </Link>
        </div>
      ) : (
        <>
          <p className="muted-text" style={{ marginTop: 0 }}>
            {loggedMinutes > 0
              ? `${formatHours(loggedMinutes)} logged for this client this month.`
              : 'No time logged for this client yet this month.'}
          </p>
          <label className="field">
            <span>Task (optional)</span>
            <input
              className="input"
              type="text"
              list={TASK_DATALIST_ID}
              value={task}
              placeholder="No specific task — pick one or type your own"
              onChange={(event) => setTask(event.target.value)}
            />
            {/* Bare option values on purpose: browsers disagree about whether a
                datalist option renders its value or its text, so grouping is
                said in the caption below instead of inside the list. */}
            <datalist id={TASK_DATALIST_ID}>
              {taskOptions.map((option) => (
                <option key={option.label} value={option.label} />
              ))}
            </datalist>
          </label>
          <p className="muted-text" style={{ margin: '-4px 0 0 0' }}>
            {ownCount > 0
              ? `${ownCount} open task${ownCount === 1 ? '' : 's'} for this client`
              : 'No open tasks for this client'}
            {standardCount > 0
              ? `, plus ${standardCount} standard task${standardCount === 1 ? '' : 's'}`
              : ''}
            . Anything you type that isn&rsquo;t in the list is used exactly as typed.
          </p>
          <label className="field">
            <span>What are you working on? (optional)</span>
            <input
              className="input"
              type="text"
              value={description}
              placeholder="Bank reconciliation…"
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <div className="button-row">
            <button type="button" className="primary-action" onClick={start}>
              <Play size={14} /> Start timer
            </button>
            <Link to="/time" className="secondary-action" onClick={onClose}>
              Open Time page
            </Link>
          </div>
        </>
      )}
    </AddModal>
  )
}
