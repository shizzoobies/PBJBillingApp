import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Play } from 'lucide-react'
import { useAppContext } from '../AppContext'
import { AddModal } from './AddModal'
import type { Client } from '../lib/types'
import { eligibleChecklistsFor, formatHours } from '../lib/utils'

/**
 * Start tracking time for one client without leaving the client list. Picks an
 * optional task (the client's open checklists) and a note, then starts the
 * shared timer — the same timer the Time page drives, so it keeps running as
 * you navigate and stops there as usual. Only one timer runs at a time, so when
 * one is already going this just says so and offers the Time page instead.
 */
export function ClientTimeModal({ client, onClose }: { client: Client; onClose: () => void }) {
  const { data, timer, timerElapsed, startTimer, sessionUser } = useAppContext()
  const [taskId, setTaskId] = useState('')
  const [description, setDescription] = useState('')

  const tasks = useMemo(
    () => eligibleChecklistsFor(data.checklists, client.id),
    [data.checklists, client.id],
  )

  // This month's logged time for the client — quick context before starting.
  const loggedMinutes = useMemo(() => {
    const month = new Date().toISOString().slice(0, 7)
    return data.timeEntries
      .filter((entry) => entry.clientId === client.id && entry.date.startsWith(month))
      .reduce((sum, entry) => sum + entry.minutes, 0)
  }, [data.timeEntries, client.id])

  const start = () => {
    startTimer({
      employeeId: sessionUser.id,
      clientId: client.id,
      description: description.trim(),
      startedAt: Date.now(),
      taskId: taskId || null,
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
            <select
              className="input"
              value={taskId}
              onChange={(event) => setTaskId(event.target.value)}
            >
              <option value="">No specific task</option>
              {tasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
            </select>
          </label>
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
