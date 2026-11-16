import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { fetchWeekPlanRequest, saveWeekPlanEntryRequest } from '../lib/api'
import { inactiveClientIdSet } from '../lib/clientLifecycle'
import { employeeName } from '../lib/utils'
import { firmToday } from '../../lib/firm-time.js'
import {
  WEEK_PLAN_NOTE_MAX,
  addDays,
  buildWeekPlan,
  mondayOf,
  normalizeWeekPlanEntry,
  type WeekPlanEntry,
  type WeekPlanMarkStatus,
  type WeekPlanRow,
  type WeekPlanTask,
} from '../../lib/week-plan.js'

/**
 * My Week (featreq-f0e8046b, docs/plans/weekly-scheduler-2026-11.md).
 *
 * Brittany: "look at the week and say ok I need to touch these clients ... and
 * then sort clients by day", so that the clients at the bottom of a person's
 * list are not left until the end of the month. Each person plans her OWN week:
 * the clients she has open work for (due this month or overdue) are listed, she
 * puts each one on the day or days she means to work on it, writes a short note,
 * and marks a task "In questions" when she is waiting on an answer so she does
 * not reopen it. "I do not want to micromanage their days": nothing here assigns
 * work, moves a due date or tracks hours.
 *
 * What is the person's own and stored: the days, the note, the marks
 * (`/api/week-plan`). Everything else is read off the checklists the page
 * already holds (`buildWeekPlan`), so it cannot drift from the real work.
 *
 * Whose week: the person using the app. While an owner previews somebody, it is
 * that person's week and nothing can be changed.
 */

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']

const dayNumber = (dateOnly: string) => String(Number(dateOnly.slice(8, 10)))
const monthDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const monthDayYear = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
})
// A date-only value is a calendar day, not an instant: format it at UTC noon so
// no time zone can show the day before.
const asDate = (dateOnly: string) => new Date(`${dateOnly}T12:00:00Z`)
const shortDay = (dateOnly: string) => monthDay.format(asDate(dateOnly))

/** What a person picks on a task. "Work on this week" is no mark at all. */
type TaskChoice = 'work' | WeekPlanMarkStatus
const CHOICES: Array<{ value: TaskChoice; label: string }> = [
  { value: 'work', label: 'Work on this week' },
  { value: 'questions', label: 'In questions' },
  { value: 'finished', label: 'Finished for month' },
]

const STATUS_WORDS: Record<WeekPlanTask['status'], string> = {
  not_planned: 'Not planned',
  planned: 'Planned',
  questions: 'In questions',
  finished: 'Finished for month',
}

function rollupWords(row: WeekPlanRow): string {
  if (row.noOpenWork) return 'Nothing open'
  const parts = [
    [row.rollup.planned, 'planned'],
    [row.rollup.notPlanned, 'not planned'],
    [row.rollup.questions, 'in questions'],
    [row.rollup.finished, 'finished'],
  ]
    .filter(([count]) => (count as number) > 0)
    .map(([count, word]) => `${count} ${word}`)
  return parts.join(', ')
}

function stepWords(task: WeekPlanTask): string {
  const parts: string[] = []
  if (task.stageIndex !== null && task.stageCount !== null && task.stageCount > 1) {
    parts.push(`Step ${task.stageIndex + 1} of ${task.stageCount}`)
  }
  if (task.stepsTotal > 0) parts.push(`${task.stepsDone} of ${task.stepsTotal} done`)
  return parts.join(' · ')
}

export function MyWeekPage() {
  const { data, activeEmployeeId, previewMode } = useAppContext()
  const today = firmToday()
  const [weekStart, setWeekStart] = useState(() => mondayOf(firmToday()))
  const [entries, setEntries] = useState<Record<string, WeekPlanEntry>>({})
  // The rows as they were when the week was read: the ORDER of the list comes
  // from these, so a client does not jump down the page the moment she puts it
  // on a day (she may be about to pick a second day, or set a task's status).
  const [loadedEntries, setLoadedEntries] = useState<WeekPlanEntry[]>([])
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  // The newest rows, for a save that is built while an earlier one is in flight.
  const entriesRef = useRef(entries)
  useEffect(() => {
    entriesRef.current = entries
  }, [entries])

  const loadKey = `${activeEmployeeId}|${weekStart}`
  // Bumped to read the stored week again (after a save that failed).
  const [reloadTick, setReloadTick] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    const load = async () => {
      try {
        const result = await fetchWeekPlanRequest(weekStart, null, signal)
        if (signal.aborted) return
        // The server answers with whose week it is. Anyone's but the person
        // this page is for is never shown.
        if (result.userId && result.userId !== activeEmployeeId) {
          throw new Error('Could not load the week.')
        }
        const next: Record<string, WeekPlanEntry> = {}
        for (const entry of result.entries) {
          const clean = normalizeWeekPlanEntry(entry)
          if (clean.clientId) next[clean.clientId] = clean
        }
        entriesRef.current = next
        setEntries(next)
        setLoadedEntries(Object.values(next))
        setLoadError(null)
        setLoadedFor(`${activeEmployeeId}|${weekStart}`)
      } catch (error) {
        if (signal.aborted) return
        setLoadError(error instanceof Error ? error.message : 'Could not load the week.')
      }
    }
    void load()
    return () => controller.abort()
  }, [activeEmployeeId, weekStart, reloadTick])

  // Never another week's (or another person's) plan under this heading.
  const ready = loadedFor === loadKey
  const shownEntries = useMemo(() => (ready ? Object.values(entries) : []), [ready, entries])

  const clients = useMemo(() => {
    const inactive = inactiveClientIdSet(data.clients)
    return data.clients.filter((client) => !inactive.has(client.id))
  }, [data.clients])

  const view = useMemo(
    () =>
      buildWeekPlan({
        checklists: data.checklists,
        clients,
        entries: shownEntries,
        userId: activeEmployeeId,
        weekStart,
        today,
      }),
    [data.checklists, clients, shownEntries, activeEmployeeId, weekStart, today],
  )

  // Not-started clients first, as of when the week was read (see `loadedEntries`).
  // A client that appears later (new work) goes after them, in its usual place.
  const rows = useMemo(() => {
    const atLoad = buildWeekPlan({
      checklists: data.checklists,
      clients,
      entries: ready ? loadedEntries : [],
      userId: activeEmployeeId,
      weekStart,
      today,
    }).rows.map((row) => row.clientId)
    const place = new Map(atLoad.map((clientId, index) => [clientId, index]))
    return view.rows
      .map((row, index) => ({ row, index }))
      .sort(
        (a, b) =>
          (place.get(a.row.clientId) ?? atLoad.length + a.index) -
          (place.get(b.row.clientId) ?? atLoad.length + b.index),
      )
      .map(({ row }) => row)
  }, [data.checklists, clients, ready, loadedEntries, activeEmployeeId, weekStart, today, view.rows])

  const canEdit = ready && !previewMode

  // The week on screen, for a save that fails after she has moved to another week.
  const weekRef = useRef(weekStart)
  useEffect(() => {
    weekRef.current = weekStart
  }, [weekStart])

  // One save at a time per client and week. A click while a save is in flight
  // only replaces what is sent next, so the newest row is always the last one
  // written: two saves can never land out of order and leave the page showing
  // something that is not stored.
  const saveQueue = useRef(new Map<string, { latest: WeekPlanEntry; running: boolean }>())
  // After a failed save the stored week is read again, but only once every
  // save still in flight has finished: read sooner and a save that lands a
  // moment later would be missing from the screen, and her next change to that
  // client would quietly put the older row back.
  const reloadWanted = useRef(false)
  const reloadWhenIdle = useCallback(() => {
    if (!reloadWanted.current) return
    for (const slot of saveQueue.current.values()) if (slot.running) return
    reloadWanted.current = false
    setReloadTick((tick) => tick + 1)
  }, [])
  const flush = useCallback(async (key: string, clientId: string, week: string) => {
    const slot = saveQueue.current.get(key)
    if (!slot || slot.running) return
    slot.running = true
    try {
      for (;;) {
        const sending = slot.latest
        await saveWeekPlanEntryRequest(clientId, {
          weekStart: week,
          plannedDays: sending.plannedDays,
          note: sending.note,
          taskMarks: sending.taskMarks,
        })
        if (slot.latest === sending) break
      }
      saveQueue.current.delete(key)
    } catch (error) {
      saveQueue.current.delete(key)
      // A failure for a week she has left says nothing here: that week is read
      // fresh when she comes back to it.
      if (weekRef.current !== week) return
      setSaveError(
        error instanceof Error
          ? `That change was not saved: ${error.message}`
          : 'That change was not saved.',
      )
      // Read what is stored again. Until it is back nothing can be changed, so
      // a click made meanwhile cannot be wiped out by the reload.
      setLoadedFor(null)
      reloadWanted.current = true
    } finally {
      reloadWhenIdle()
    }
  }, [reloadWhenIdle])

  /** Replace one client's row: shown at once, then saved in turn; a failed save reloads what is stored. */
  const saveRow = useCallback(
    (clientId: string, change: (current: WeekPlanEntry) => WeekPlanEntry) => {
      if (!canEdit) return
      const current = entriesRef.current[clientId] ?? normalizeWeekPlanEntry({ clientId })
      const next = normalizeWeekPlanEntry({ ...change(current), clientId })
      const optimistic = { ...entriesRef.current, [clientId]: next }
      entriesRef.current = optimistic
      setEntries(optimistic)
      setSaveError(null)
      const key = `${weekStart}|${clientId}`
      const slot = saveQueue.current.get(key)
      if (slot) slot.latest = next
      else saveQueue.current.set(key, { latest: next, running: false })
      void flush(key, clientId, weekStart)
    },
    [canEdit, flush, weekStart],
  )

  const toggleDay = (clientId: string, day: string) =>
    saveRow(clientId, (current) => ({
      ...current,
      plannedDays: current.plannedDays.includes(day)
        ? current.plannedDays.filter((each) => each !== day)
        : [...current.plannedDays, day],
    }))

  const setNote = (clientId: string, note: string) =>
    saveRow(clientId, (current) => ({ ...current, note }))

  const setTaskChoice = (clientId: string, checklistId: string, choice: TaskChoice) =>
    saveRow(clientId, (current) => {
      const taskMarks = { ...current.taskMarks }
      if (choice === 'work') delete taskMarks[checklistId]
      else taskMarks[checklistId] = { status: choice, note: taskMarks[checklistId]?.note ?? '' }
      return { ...current, taskMarks }
    })

  const friday = view.days[4]
  const weekLabel = `${shortDay(weekStart)} to ${monthDayYear.format(asDate(friday))}`
  const thisWeek = mondayOf(today)
  const whose = previewMode ? employeeName(data.employees, activeEmployeeId) : null

  return (
    <section className="panel my-week" id="my-week">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Planning</p>
          <h2>My Week</h2>
        </div>
        <div className="my-week-nav">
          <div className="period-control">
            <button
              type="button"
              className="period-step"
              aria-label="Previous week"
              onClick={() => setWeekStart((current) => addDays(current, -7))}
            >
              <ChevronLeft size={16} />
            </button>
            <span aria-live="polite">Week of {weekLabel}</span>
            <button
              type="button"
              className="period-step"
              aria-label="Next week"
              onClick={() => setWeekStart((current) => addDays(current, 7))}
            >
              <ChevronRight size={16} />
            </button>
          </div>
          {weekStart !== thisWeek ? (
            <button type="button" className="ghost-action" onClick={() => setWeekStart(thisWeek)}>
              This week
            </button>
          ) : null}
        </div>
      </div>

      <p className="my-week-hint">
        Every client you have open work for that is due this month or overdue. Put each client on the
        day or days you plan to work on it. When you have sent questions and are waiting for an
        answer, set that task to In questions so you can move on to a client you have not started.
        This is your own plan: it does not change any due date or anyone's tasks.
      </p>

      {whose ? (
        <p className="my-week-readonly" role="status">
          You are looking at {whose}'s week. It cannot be changed from here.
        </p>
      ) : null}
      {loadError ? (
        <p className="invoice-run-error" role="alert">
          {loadError}
        </p>
      ) : null}
      {saveError ? (
        <p className="invoice-run-error" role="alert">
          {saveError}
        </p>
      ) : null}

      {!ready && !loadError ? <p className="my-week-empty">Loading your week…</p> : null}

      {ready ? (
        <>
          <p className="my-week-count" role="status">
            {view.rows.length === 0
              ? 'No open work due this month. Nothing to plan.'
              : view.notPlannedCount === 0
                ? 'Every client is planned or in hand this week.'
                : `${view.notPlannedCount} ${view.notPlannedCount === 1 ? 'client' : 'clients'} not planned this week`}
          </p>

          <div className="my-week-days" role="list" aria-label="The week, Monday to Friday">
            {view.days.map((day, index) => {
              const placed = view.rows.filter((row) => row.plannedDays.includes(day))
              return (
                <section
                  key={day}
                  role="listitem"
                  aria-label={`${DAY_NAMES[index]} ${shortDay(day)}`}
                  className={`my-week-day${day === today ? ' is-today' : ''}`}
                >
                  <h3>
                    <span>{DAY_SHORT[index]}</span> {dayNumber(day)}
                    {day === today ? <em> Today</em> : null}
                  </h3>
                  {placed.length === 0 ? (
                    <p className="my-week-day-empty">Nothing planned</p>
                  ) : (
                    <ul>
                      {placed.map((row) => (
                        <li
                          key={row.clientId}
                          className={row.allParked || row.noOpenWork ? 'is-parked' : undefined}
                        >
                          <strong>{row.clientName}</strong>
                          <small>
                            {row.noOpenWork
                              ? 'Nothing open'
                              : row.allParked
                                ? 'Waiting, nothing to pick up'
                                : `${row.tasks.length - row.rollup.questions - row.rollup.finished} to work on`}
                          </small>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )
            })}
          </div>

          {view.rows.length > 0 ? <h3 className="my-week-subhead">My clients this week</h3> : null}
          <ul className="my-week-rows">
            {rows.map((row) => (
              <ClientRow
                key={`${weekStart}|${row.clientId}`}
                row={row}
                days={view.days}
                today={today}
                canEdit={canEdit}
                onToggleDay={(day) => toggleDay(row.clientId, day)}
                onNote={(note) => setNote(row.clientId, note)}
                onTaskChoice={(checklistId, choice) =>
                  setTaskChoice(row.clientId, checklistId, choice)
                }
              />
            ))}
          </ul>

          {view.questions.length > 0 ? (
            <section className="my-week-questions" aria-label="Sent questions">
              <h3 className="my-week-subhead">Sent questions</h3>
              <p className="my-week-hint">
                Waiting on an answer. Check these again at the end of the day, not first thing.
              </p>
              <ul>
                {view.questions.map((question) => (
                  <li key={question.checklistId}>
                    <div>
                      <strong>{question.clientName}</strong>
                      <span>{question.title}</span>
                    </div>
                    <div className="my-week-question-actions">
                      <Link
                        className="ghost-action"
                        to={`/checklists?focus=${encodeURIComponent(question.checklistId)}`}
                      >
                        Open
                      </Link>
                      {canEdit ? (
                        <button
                          type="button"
                          className="ghost-action"
                          onClick={() =>
                            setTaskChoice(question.clientId, question.checklistId, 'work')
                          }
                        >
                          Answered, back to work
                        </button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}
    </section>
  )
}

function ClientRow({
  row,
  days,
  today,
  canEdit,
  onToggleDay,
  onNote,
  onTaskChoice,
}: {
  row: WeekPlanRow
  days: string[]
  today: string
  canEdit: boolean
  onToggleDay: (day: string) => void
  onNote: (note: string) => void
  onTaskChoice: (checklistId: string, choice: TaskChoice) => void
}) {
  // The note is typed freely and saved when she leaves the box (or presses Enter).
  const [draft, setDraft] = useState(row.note)
  const [editing, setEditing] = useState(false)
  const shownNote = editing ? draft : row.note
  const commit = () => {
    setEditing(false)
    const next = draft.replace(/\s+/g, ' ').trim()
    if (next !== row.note) onNote(next)
  }

  return (
    <li className={`my-week-row${row.started ? '' : ' is-not-started'}`}>
      <div className="my-week-row-head">
        <div className="my-week-row-name">
          <Link className="client-name-link" to={`/clients/${row.clientId}`}>
            {row.clientName}
          </Link>
          <span className="my-week-rollup">{rollupWords(row)}</span>
        </div>
        <div className="my-week-daypick" role="group" aria-label={`Days for ${row.clientName}`}>
          {days.map((day, index) => {
            const on = row.plannedDays.includes(day)
            return (
              <button
                key={day}
                type="button"
                className={`my-week-daybtn${on ? ' is-on' : ''}${day === today ? ' is-today' : ''}`}
                aria-pressed={on}
                aria-label={`${DAY_NAMES[index]} ${shortDay(day)}`}
                title={`${DAY_NAMES[index]} ${shortDay(day)}`}
                disabled={!canEdit}
                onClick={() => onToggleDay(day)}
              >
                {DAY_SHORT[index]}
              </button>
            )
          })}
        </div>
      </div>

      <label className="my-week-note">
        <span className="visually-hidden">Note for {row.clientName}</span>
        <input
          type="text"
          className="input"
          placeholder="Note for yourself, for example: bank feed first, then payroll"
          maxLength={WEEK_PLAN_NOTE_MAX}
          value={shownNote}
          disabled={!canEdit}
          onFocus={() => {
            setDraft(row.note)
            setEditing(true)
          }}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
        />
      </label>

      {row.noOpenWork ? (
        <p className="my-week-empty">Nothing of yours is open for this client now.</p>
      ) : (
        <ul className="my-week-tasks">
          {row.tasks.map((task) => (
            <li key={task.checklistId} className={`my-week-task is-${task.status}`}>
              <div className="my-week-task-main">
                <Link to={`/checklists?focus=${encodeURIComponent(task.checklistId)}`}>
                  {task.title}
                </Link>
                <span className="my-week-task-meta">
                  <span
                    className={
                      task.overdue ? 'my-week-due is-overdue' : task.dueThisWeek ? 'my-week-due is-week' : 'my-week-due'
                    }
                  >
                    {task.overdue ? 'Overdue, was due ' : task.dueThisWeek ? 'Due this week, ' : 'Due '}
                    {shortDay(task.dueDate)}
                  </span>
                  {stepWords(task) ? <span>{stepWords(task)}</span> : null}
                  {task.mine === 'step' ? <span>A step of this is yours</span> : null}
                </span>
              </div>
              <div className="my-week-task-status">
                {/* The label is only the name; the word beside the picker is not part of it. */}
                <label>
                  <span className="visually-hidden">Status of {task.title}</span>
                  <select
                    className="input"
                    value={task.status === 'questions' || task.status === 'finished' ? task.status : 'work'}
                    disabled={!canEdit}
                    onChange={(event) => onTaskChoice(task.checklistId, event.target.value as TaskChoice)}
                  >
                    {CHOICES.map((choice) => (
                      <option key={choice.value} value={choice.value}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                </label>
                {/* The picker already says a hand-set status; under "Work on this
                    week" this says whether the client is on a day yet. */}
                {task.status === 'planned' || task.status === 'not_planned' ? (
                  <small>{STATUS_WORDS[task.status]}</small>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}
