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
  WEEK_PLAN_OTHER_KEY,
  addDays,
  asPerTaskRow,
  buildWeekPlan,
  mondayOf,
  normalizeWeekPlanEntry,
  withTaskDayToggled,
  withTaskStatusSet,
  type WeekPlanEntry,
  type WeekPlanMarkStatus,
  type WeekPlanRow,
  type WeekPlanTask,
  type WeekPlanWait,
} from '../../lib/week-plan.js'

/**
 * My Week (featreq-f0e8046b, docs/plans/weekly-scheduler-2026-11.md).
 *
 * Brittany: "look at the week and say ok I need to touch these clients ... and
 * then sort clients by day", so that the clients at the bottom of a person's
 * list are not left until the end of the month. Each person plans her OWN week:
 * the clients she has open work for (due this month or overdue) are listed with
 * their tasks, she puts each TASK on the day or days she means to work on it
 * (her send-back: "there are 3 task ... I need to be able to put them to
 * different days"), writes a short note per client, and marks a task "In
 * questions" when she is waiting on an answer so she does not reopen it. "I do not want to micromanage their days": nothing here assigns
 * work, moves a due date or tracks hours.
 *
 * Work with no task (featreq-f8ebbfc4): "I need to be able to see all my
 * clients and choose whether I work on any without a task - I might have adhoc
 * work needed". Any client she can see can be added to her week from a picker
 * under the heading, and every client row can carry an "Other work (no task)"
 * line with its own Monday to Friday buttons. Those days are stored in the same
 * row, under the key `WEEK_PLAN_OTHER_KEY` beside the tasks' marks.
 *
 * What is the person's own and stored: the days, the note, the marks
 * (`/api/week-plan`). Everything else is read off the checklists the page
 * already holds (`buildWeekPlan`), so it cannot drift from the real work.
 *
 * Questions set themselves (ship 2): a task whose every open step the team has
 * marked Waiting reads In questions with nothing set, saying who it waits on and
 * since when, and reads Answered once the answer is in. That is read off the
 * checklists; the picker on a task is only for what she sets herself.
 *
 * Whose week: the person using the app. While an owner previews somebody, it is
 * that person's week and nothing can be changed.
 *
 * An owner can also look at anyone's week from her own page (ship 3: "She can
 * peek at everyone's from her page with a button"): a "Whose week" picker, and
 * a line per person under "Everyone's week". Looking is all it is: another
 * person's week is read-only here, and the server refuses a team member who
 * asks for anyone's but her own.
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
  answered: 'Answered',
  finished: 'Finished for month',
}

const listOf = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

/**
 * The waits on a task, in words. The list handed in is all of one kind (see
 * `buildWeekPlan`): answers that are in, waits that are out with someone else,
 * or waits where she is the one being asked. `nameOf` turns an id into a name.
 */
function waitWords(waits: WeekPlanWait[], nameOf: (id: string) => string): string {
  if (waits.length === 0) return ''
  const names = (list: WeekPlanWait[]) => [
    ...new Set(list.map((wait) => (wait.who ? nameOf(wait.who) : '')).filter(Boolean)),
  ]
  const earliest = (list: WeekPlanWait[]) =>
    list
      .map((wait) => wait.since)
      .filter((day): day is string => Boolean(day))
      .sort()[0]
  const since = (list: WeekPlanWait[]) => (earliest(list) ? ` since ${shortDay(earliest(list))}` : '')

  if (waits[0].move === 'answered') {
    const who = names(waits)
    return who.length > 0
      ? `${listOf(who)} answered. Open it to confirm and carry on.`
      : 'An answer is in. Open it to confirm and carry on.'
  }
  if (waits[0].move === 'mine') {
    // Two ways it is her move: someone is waiting on her to do something, or
    // the person she asked has asked her a question back.
    const waiting = waits.filter((wait) => !wait.askedBack)
    const asking = waits.filter((wait) => wait.askedBack)
    const parts: string[] = []
    if (waiting.length > 0) {
      const who = names(waiting)
      const dated = Boolean(earliest(waiting))
      const subject = who.length > 0 ? listOf(who) : 'Someone'
      const verb =
        who.length > 1 ? (dated ? 'have been waiting' : 'are waiting') : dated ? 'has been waiting' : 'is waiting'
      parts.push(`${subject} ${verb} on you${since(waiting)}`)
    }
    if (asking.length > 0) {
      const who = names(asking)
      parts.push(`${who.length > 0 ? listOf(who) : 'Someone'} asked you a question back`)
    }
    return `${parts.join('. ')}.`
  }
  // Out with someone else.
  const asking = waits.filter((wait) => !wait.toConfirm)
  const confirming = waits.filter((wait) => wait.toConfirm)
  const asked = [
    ...(asking.some((wait) => wait.onClient) ? ['the client'] : []),
    ...names(asking.filter((wait) => !wait.onClient)),
  ]
  const parts: string[] = []
  if (asked.length > 0) parts.push(`Waiting on ${listOf(asked)}${since(asking)}`)
  if (confirming.length > 0) {
    const who = names(confirming)
    parts.push(
      who.length > 0
        ? `${asked.length > 0 ? 'waiting on' : 'Waiting on'} ${listOf(who)} to confirm an answer`
        : `${asked.length > 0 ? 'an' : 'An'} answer is waiting to be confirmed`,
    )
  }
  if (parts.length === 0) {
    // The old plain Waiting flag: nobody is named on it.
    const note = waits.find((wait) => wait.note)?.note ?? ''
    return note ? `Marked waiting: ${note}` : 'Marked waiting'
  }
  const askedBack = names(waits.filter((wait) => wait.askedBack))
  const words = parts.join(', ')
  return askedBack.length > 0 ? `${words}. ${listOf(askedBack)} asked a question back.` : words
}

function rollupWords(row: WeekPlanRow): string {
  if (row.noOpenWork) return row.otherDays.length > 0 ? 'Other work' : 'Nothing open'
  const parts = [
    [row.rollup.planned, 'planned'],
    [row.rollup.notPlanned, 'not planned'],
    [row.rollup.answered, 'answered'],
    [row.rollup.questions, 'in questions'],
    [row.rollup.finished, 'finished'],
  ]
    .filter(([count]) => (count as number) > 0)
    .map(([count, word]) => `${count} ${word}`)
  if (row.otherDays.length > 0) parts.push('other work')
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
  const { data, activeEmployeeId, previewMode, role } = useAppContext()
  const today = firmToday()
  // Only an owner, and never while previewing, may look at another person's week.
  const canPick = role === 'owner' && !previewMode
  const [pickedId, setPickedId] = useState<string | null>(null)
  const whoseId =
    canPick && pickedId && data.employees.some((employee) => employee.id === pickedId)
      ? pickedId
      : activeEmployeeId
  const ownWeek = whoseId === activeEmployeeId
  const [weekStart, setWeekStart] = useState(() => mondayOf(firmToday()))
  const [entries, setEntries] = useState<Record<string, WeekPlanEntry>>({})
  // The rows as they were when the week was read: the ORDER of the list comes
  // from these, so a client does not jump down the page the moment she puts it
  // on a day (she may be about to pick a second day, or set a task's status).
  const [loadedEntries, setLoadedEntries] = useState<WeekPlanEntry[]>([])
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  // An error belongs to the person and week it happened on (`key`), and is
  // shown only there: her failed save must not sit above someone else's week.
  const [loadError, setLoadError] = useState<{ key: string; message: string } | null>(null)
  const [saveError, setSaveError] = useState<{ key: string; message: string } | null>(null)
  // The newest rows, for a save that is built while an earlier one is in flight.
  const entriesRef = useRef(entries)
  useEffect(() => {
    entriesRef.current = entries
  }, [entries])

  // One save at a time per client and week. A click while a save is in flight
  // only replaces what is sent next, so the newest row is always the last one
  // written: two saves can never land out of order and leave the page showing
  // something that is not stored. Only her own rows ever go in here.
  const saveQueue = useRef(new Map<string, { latest: WeekPlanEntry; running: boolean }>())

  const loadKey = `${whoseId}|${weekStart}`
  // Clients she has asked to plan work on that is not a task (featreq-f8ebbfc4):
  // a client with no task gets a row at once, and a client already listed gets
  // its "Other work" line, before anything is saved. They belong to the person
  // and week on screen and are forgotten when either changes; a day she then
  // puts on one is stored, and brings the line back by itself.
  // `top`: the ones she chose from the picker, which go to the top of the list.
  const [added, setAdded] = useState<{ key: string; ids: string[]; top: string[] }>({
    key: '',
    ids: [],
    top: [],
  })
  const addedIds = useMemo(() => (added.key === loadKey ? added.ids : []), [added, loadKey])
  const pickedIds = useMemo(() => (added.key === loadKey ? added.top : []), [added, loadKey])
  // The client chosen in the picker, added with its button (a picker that adds
  // on change adds a client at every arrow key on Windows).
  const [picking, setPicking] = useState('')
  // Bumped to read the stored week again (after a save that failed).
  const [reloadTick, setReloadTick] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    const load = async () => {
      try {
        // Her own week names nobody; an owner looking at someone names them.
        const result = await fetchWeekPlanRequest(weekStart, ownWeek ? null : whoseId, signal)
        if (signal.aborted) return
        // The server answers with whose week it is. Anyone's but the person
        // this page is showing is never put on screen.
        if (result.userId && result.userId !== whoseId) {
          throw new Error('Could not load the week.')
        }
        const next: Record<string, WeekPlanEntry> = {}
        for (const entry of result.entries) {
          const clean = normalizeWeekPlanEntry(entry)
          if (clean.clientId) next[clean.clientId] = clean
        }
        // A save of hers for this week that has not landed yet is newer than
        // what was just read: keep it on screen. Without this, a look at
        // someone else's week (or another week) and back could show the row
        // from before the save, and her next click would put that older row
        // back over it.
        if (ownWeek) {
          for (const [key, slot] of saveQueue.current) {
            if (key.startsWith(`${weekStart}|`)) next[key.slice(weekStart.length + 1)] = slot.latest
          }
        }
        entriesRef.current = next
        setEntries(next)
        setLoadedEntries(Object.values(next))
        setLoadError(null)
        setLoadedFor(`${whoseId}|${weekStart}`)
      } catch (error) {
        if (signal.aborted) return
        setLoadError({
          key: `${whoseId}|${weekStart}`,
          message: error instanceof Error ? error.message : 'Could not load the week.',
        })
      }
    }
    void load()
    return () => controller.abort()
  }, [whoseId, ownWeek, weekStart, reloadTick])
  const shownLoadError = loadError?.key === loadKey ? loadError.message : null
  const shownSaveError = saveError?.key === loadKey ? saveError.message : null

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
        userId: whoseId,
        weekStart,
        today,
        extraClientIds: addedIds,
      }),
    [data.checklists, clients, shownEntries, whoseId, weekStart, today, addedIds],
  )

  // Not-started clients first, as of when the week was read (see `loadedEntries`).
  // A client that appears later (new work) goes after them, in its usual place.
  const rows = useMemo(() => {
    const atLoad = buildWeekPlan({
      checklists: data.checklists,
      clients,
      entries: ready ? loadedEntries : [],
      userId: whoseId,
      weekStart,
      today,
    }).rows.map((row) => row.clientId)
    const place = new Map(atLoad.map((clientId, index) => [clientId, index]))
    // A client she has just added from the picker goes to the top, under the
    // picker, in the order she added them. One that was already on the page
    // stays where it is, also when she adds other work to it.
    const top = new Map(pickedIds.map((clientId, index) => [clientId, index - pickedIds.length]))
    const at = (clientId: string, index: number) =>
      place.get(clientId) ?? top.get(clientId) ?? atLoad.length + index
    return view.rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => at(a.row.clientId, a.index) - at(b.row.clientId, b.index))
      .map(({ row }) => row)
  }, [data.checklists, clients, ready, loadedEntries, whoseId, weekStart, today, view.rows, pickedIds])

  // Her clients that are not on the page (no open task of hers due this month,
  // and nothing planned): the ones she can add to plan other work on.
  const addable = useMemo(() => {
    const listed = new Set(view.rows.map((row) => row.clientId))
    return clients
      .filter((client) => !listed.has(client.id))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  }, [clients, view.rows])

  // Only her own week, and never in preview.
  const canEdit = ready && !previewMode && ownWeek

  // Whose week and which week is on screen, for a save that fails after she
  // has moved on (to another week, or to look at another person's).
  const viewRef = useRef(loadKey)
  useEffect(() => {
    viewRef.current = loadKey
  }, [loadKey])

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
  const flush = useCallback(async (key: string, clientId: string, week: string, viewKey: string) => {
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
      // A failure for a view she has left (another week, or another person's
      // week) says nothing there and reloads nothing there: her own week is
      // read fresh when she comes back to it.
      if (viewRef.current !== viewKey) return
      setSaveError({
        key: viewKey,
        message:
          error instanceof Error
            ? `That change was not saved: ${error.message}`
            : 'That change was not saved.',
      })
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
      // A row from before the days moved onto tasks is turned per-task before
      // ANY change to it (a day, a status, the note), so what she had planned
      // is saved in the new form and never lost by the save.
      const taskIds = (view.rows.find((row) => row.clientId === clientId)?.tasks ?? []).map(
        (task) => task.checklistId,
      )
      const current = asPerTaskRow(
        entriesRef.current[clientId] ?? normalizeWeekPlanEntry({ clientId }),
        taskIds,
      )
      const next = normalizeWeekPlanEntry({ ...change(current), clientId })
      const optimistic = { ...entriesRef.current, [clientId]: next }
      entriesRef.current = optimistic
      setEntries(optimistic)
      setSaveError(null)
      const key = `${weekStart}|${clientId}`
      const slot = saveQueue.current.get(key)
      if (slot) slot.latest = next
      else saveQueue.current.set(key, { latest: next, running: false })
      void flush(key, clientId, weekStart, loadKey)
    },
    [canEdit, flush, weekStart, loadKey, view.rows],
  )

  // A day goes on ONE task. The client's task ids come from the page; each
  // task's days are read off the row itself, so two quick clicks build on each
  // other even before the first one has been drawn.
  const toggleDay = (clientId: string, checklistId: string, day: string) => {
    const taskIds = (view.rows.find((row) => row.clientId === clientId)?.tasks ?? []).map(
      (task) => task.checklistId,
    )
    // Once she has used a client's Other work line it stays on the page while
    // she is here, so taking its last day off (to move it to another day) does
    // not take the line, or a client with no task, out from under her.
    if (checklistId === WEEK_PLAN_OTHER_KEY) addClient(clientId)
    saveRow(clientId, (current) => withTaskDayToggled(current, taskIds, checklistId, day))
  }

  // Show a client's "Other work (no task)" line: a client with no task of hers
  // gets a row for it, a client already on the page gets the line. Nothing is
  // saved until she puts it on a day.
  const addClient = (clientId: string, fromPicker = false) => {
    if (!canEdit || !clientId) return
    setAdded((current) => {
      const ids = current.key === loadKey ? current.ids : []
      const top = current.key === loadKey ? current.top : []
      return {
        key: loadKey,
        ids: ids.includes(clientId) ? ids : [...ids, clientId],
        top: fromPicker && !top.includes(clientId) ? [...top, clientId] : top,
      }
    })
  }

  // A client with no task of hers on the page has no task to take a day off:
  // this clears its days (other work included) and its note so it leaves the
  // page. A status she set on a task that is not listed right now (its due
  // date moved out of the month) is kept for when the task comes back.
  const clearRow = (clientId: string) => {
    setAdded((current) =>
      current.key === loadKey
        ? {
            key: loadKey,
            ids: current.ids.filter((id) => id !== clientId),
            top: current.top.filter((id) => id !== clientId),
          }
        : current,
    )
    // A client she only just added, with nothing put on it: nothing is stored.
    if (!entriesRef.current[clientId]) return
    saveRow(clientId, (current) =>
      normalizeWeekPlanEntry({
        clientId,
        taskMarks: Object.fromEntries(
          Object.entries(current.taskMarks).map(([id, mark]) => [id, { ...mark, days: [] }]),
        ),
      }),
    )
  }

  const setNote = (clientId: string, note: string) =>
    saveRow(clientId, (current) => ({ ...current, note }))

  // The task's days are kept; only its hand-set status changes.
  const setTaskChoice = (clientId: string, checklistId: string, choice: TaskChoice) =>
    saveRow(clientId, (current) =>
      withTaskStatusSet(current, checklistId, choice === 'work' ? null : choice),
    )

  // A person named on a wait may have left the team since: never "Unassigned".
  const nameOf = useCallback(
    (id: string) =>
      [...data.employees, ...(data.inactiveEmployees ?? [])].find((employee) => employee.id === id)?.name ??
      'a teammate',
    [data.employees, data.inactiveEmployees],
  )

  const friday = view.days[4]
  const weekLabel = `${shortDay(weekStart)} to ${monthDayYear.format(asDate(friday))}`
  const thisWeek = mondayOf(today)
  const whose = previewMode || !ownWeek ? employeeName(data.employees, whoseId) : null
  const others = useMemo(
    () =>
      data.employees
        .filter((employee) => employee.id !== activeEmployeeId)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [data.employees, activeEmployeeId],
  )

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
          {canPick ? (
            <label className="my-week-who">
              <span>Whose week</span>
              <select
                className="input"
                value={whoseId}
                onChange={(event) =>
                  setPickedId(event.target.value === activeEmployeeId ? null : event.target.value)
                }
              >
                <option value={activeEmployeeId}>My week</option>
                {others.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      </div>

      {ownWeek && !previewMode ? (
        <p className="my-week-hint">
          Every client you have open work for that is due this month or overdue. Put each task on the
          day or days you plan to work on it. When you have sent questions and are waiting for an
          answer, set that task to In questions so you can move on to a client you have not started.
          For work that is not on a checklist, use Other work: add it to a client below, or pick any
          of your other clients. This is your own plan: it does not change any due date or anyone's
          tasks.
        </p>
      ) : null}

      {whose ? (
        <p className="my-week-readonly" role="status">
          You are looking at {whose}'s week. It cannot be changed from here.
        </p>
      ) : null}
      {shownLoadError ? (
        <p className="invoice-run-error" role="alert">
          {shownLoadError}
        </p>
      ) : null}
      {shownSaveError ? (
        <p className="invoice-run-error" role="alert">
          {shownSaveError}
        </p>
      ) : null}

      {!ready && !shownLoadError ? (
        <p className="my-week-empty">{ownWeek ? 'Loading your week…' : 'Loading the week…'}</p>
      ) : null}

      {ready ? (
        <>
          <p className="my-week-count" role="status">
            {view.rows.length === 0
              ? 'No open work due this month. Nothing to plan.'
              : view.notPlannedCount === 0
                ? 'Every client is planned or in hand this week.'
                : `${view.notPlannedCount} ${view.notPlannedCount === 1 ? 'client' : 'clients'} not planned this week`}
          </p>
          {view.finishedClientCount > 0 ? (
            <p className="my-week-finished">
              {view.finishedClientCount} {view.finishedClientCount === 1 ? 'client is' : 'clients are'} finished
              for the month.
            </p>
          ) : null}

          {view.answered.length > 0 ? (
            <section className="my-week-answered" aria-label="Answered">
              <h3 className="my-week-subhead">Answered: pick these up</h3>
              <ul>
                {view.answered.map((line) => (
                  <li key={line.checklistId}>
                    <div>
                      <strong>{line.clientName}</strong>
                      <span>{line.title}</span>
                      <span>{waitWords(line.waits, nameOf)}</span>
                    </div>
                    <div className="my-week-question-actions">
                      <Link
                        className="ghost-action"
                        to={`/checklists?focus=${encodeURIComponent(line.checklistId)}`}
                      >
                        Open
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <div className="my-week-days" role="list" aria-label="The week, Monday to Friday">
            {view.byDay.map(({ date: day, items: placed }, index) => {
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
                      {/* One line per TASK she put on this day, under its client's
                          name. A task that is waiting or finished stays on its
                          day, greyed. */}
                      {placed.map((item) => (
                        <li
                          key={`${item.clientId}|${item.other ? 'other' : (item.checklistId ?? '')}`}
                          className={item.parked ? 'is-parked' : undefined}
                        >
                          <strong>{item.clientName}</strong>
                          <small>
                            {item.other
                              ? 'Other work'
                              : item.nothingOpen
                                ? 'Nothing open'
                                : item.parked
                                  ? `${item.title} (waiting or finished)`
                                  : item.title}
                          </small>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )
            })}
          </div>

          {view.rows.length > 0 ? (
            <h3 className="my-week-subhead">
              {ownWeek && !previewMode ? 'My clients this week' : `${whose ? `${whose}'s` : 'Their'} clients this week`}
            </h3>
          ) : null}
          {/* Any of her clients that is not listed (no task of hers due): she
              may have ad hoc work for it this week. Only on her own week. */}
          {canEdit && addable.length > 0 ? (
            <div className="my-week-add">
              <label>
                <span>Work on a client that has no task</span>
                <select
                  className="input"
                  value={addable.some((client) => client.id === picking) ? picking : ''}
                  onChange={(event) => setPicking(event.target.value)}
                >
                  <option value="">Choose a client…</option>
                  {addable.map((client) => (
                    <option key={client.id} value={client.id}>
                      {client.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="ghost-action"
                disabled={!addable.some((client) => client.id === picking)}
                onClick={() => {
                  addClient(picking, true)
                  setPicking('')
                }}
              >
                Add to my week
              </button>
              <small>For ad hoc work. The client is added to this week so you can put it on a day.</small>
            </div>
          ) : null}
          <ul className="my-week-rows">
            {rows.map((row) => (
              <ClientRow
                key={`${weekStart}|${row.clientId}`}
                row={row}
                days={view.days}
                today={today}
                canEdit={canEdit}
                nameOf={nameOf}
                // The "Other work (no task)" line: always once it has a day (also
                // on a week that is only being looked at); on her own week also
                // on a client with no task listed, and where she asked for it.
                showOther={
                  row.otherDays.length > 0 ||
                  (canEdit && (row.noOpenWork || addedIds.includes(row.clientId)))
                }
                onAddOther={() => addClient(row.clientId)}
                onToggleDay={(checklistId, day) => toggleDay(row.clientId, checklistId, day)}
                onClear={() => clearRow(row.clientId)}
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
                      {question.auto ? <span>{waitWords(question.waits, nameOf)}</span> : null}
                    </div>
                    <div className="my-week-question-actions">
                      <Link
                        className="ghost-action"
                        to={`/checklists?focus=${encodeURIComponent(question.checklistId)}`}
                      >
                        Open
                      </Link>
                      {/* A question the Waiting flags set clears by itself when it
                          is answered. One she set herself has a button, also
                          when the flags say the same thing. */}
                      {canEdit && question.byHand ? (
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

      {canPick ? (
        <TeamWeeks
          employees={data.employees}
          checklists={data.checklists}
          clients={clients}
          weekStart={weekStart}
          today={today}
          ownId={activeEmployeeId}
          // Her own line follows what is on her screen, saved or about to be.
          ownEntries={ownWeek && ready ? shownEntries : null}
          viewedId={whoseId}
          onLook={(id) => setPickedId(id === activeEmployeeId ? null : id)}
        />
      ) : null}
    </section>
  )
}

/**
 * "Everyone's week" (owners only): one line per person with open work, read
 * from each person's stored plan for the week on screen and the same rules the
 * page itself uses. The owner's own line is built from her own page, so it
 * moves as she plans. A person whose plan cannot be read says so; the others
 * still show.
 */
function TeamWeeks({
  employees,
  checklists,
  clients,
  weekStart,
  today,
  ownId,
  ownEntries,
  viewedId,
  onLook,
}: {
  employees: Array<{ id: string; name: string }>
  checklists: unknown[]
  clients: Array<{ id: string; name: string }>
  weekStart: string
  today: string
  ownId: string
  ownEntries: WeekPlanEntry[] | null
  viewedId: string
  onLook: (id: string) => void
}) {
  // Keyed by the ids, not by the list: the workspace refreshes often and a new
  // array holding the same people must not read everyone's plan again.
  const otherIdsKey = employees
    .map((employee) => employee.id)
    .filter((id) => id !== ownId)
    .sort()
    .join('|')
  const [loaded, setLoaded] = useState<{
    key: string
    byUser: Record<string, WeekPlanEntry[] | null>
  } | null>(null)
  const loadKey = `${weekStart}|${otherIdsKey}`
  useEffect(() => {
    const controller = new AbortController()
    const ids = otherIdsKey.split('|').filter(Boolean)
    const load = async () => {
      const results = await Promise.all(
        ids.map(async (id) => {
          try {
            const result = await fetchWeekPlanRequest(weekStart, id, controller.signal)
            // Never another person's plan under this person's name.
            if (result.userId !== id) return [id, null] as const
            return [id, result.entries.map((entry) => normalizeWeekPlanEntry(entry))] as const
          } catch {
            return [id, null] as const
          }
        }),
      )
      if (controller.signal.aborted) return
      setLoaded({ key: `${weekStart}|${otherIdsKey}`, byUser: Object.fromEntries(results) })
    }
    void load()
    return () => controller.abort()
    // Read again each time she opens a different person's week, so a line and
    // the week it opens cannot drift far apart on a page left open. (The
    // earlier answer stays on screen until the new one is in.)
  }, [weekStart, otherIdsKey, viewedId])

  const lines = useMemo(() => {
    const ready = loaded?.key === loadKey
    return [...employees]
      .sort((a, b) => Number(b.id === ownId) - Number(a.id === ownId) || a.name.localeCompare(b.name))
      .map((employee) => {
        const own = employee.id === ownId
        const entries = own ? ownEntries : ready ? (loaded?.byUser[employee.id] ?? null) : undefined
        const view =
          entries === undefined || entries === null
            ? null
            : buildWeekPlan({ checklists, clients, entries, userId: employee.id, weekStart, today })
        return {
          id: employee.id,
          name: own ? 'Me' : employee.name,
          // undefined = still reading; null = could not be read (or her own page is not showing her week).
          state: entries === undefined ? 'loading' : entries === null ? (own ? 'own-hidden' : 'failed') : 'ready',
          view,
        }
      })
      // A person with nothing open and nothing finished this month has no line.
      .filter(
        (line) =>
          line.state !== 'ready' ||
          (line.view?.rows.filter((row) => !row.noOpenWork).length ?? 0) +
            (line.view?.finishedClientCount ?? 0) >
            0,
      )
      .filter((line) => line.state !== 'own-hidden')
  }, [employees, ownId, ownEntries, loaded, loadKey, checklists, clients, weekStart, today])

  return (
    <section className="my-week-team" aria-label="Everyone's week">
      <h3 className="my-week-subhead">Everyone's week</h3>
      <p className="my-week-hint">
        One line for each person with open work this week. Only owners see this. Look opens their
        week on this page; it cannot be changed from here.
      </p>
      {lines.length === 0 ? (
        <p className="my-week-empty">Nobody has open work due this month.</p>
      ) : (
        <table className="my-week-team-table">
          <thead>
            <tr>
              <th scope="col">Person</th>
              <th scope="col">Clients</th>
              <th scope="col">Not planned</th>
              <th scope="col">In questions</th>
              <th scope="col">Answered</th>
              <th scope="col">Finished for month</th>
              <th scope="col">
                <span className="visually-hidden">Look</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id} className={line.id === viewedId ? 'is-viewed' : undefined}>
                <th scope="row">{line.name}</th>
                {line.view ? (
                  <>
                    <td>{line.view.rows.filter((row) => !row.noOpenWork).length}</td>
                    <td>{line.view.notPlannedCount}</td>
                    <td>{line.view.questions.length}</td>
                    <td>{line.view.answered.length}</td>
                    <td>{line.view.finishedClientCount}</td>
                  </>
                ) : (
                  <td colSpan={5}>{line.state === 'loading' ? 'Loading…' : 'Could not be read'}</td>
                )}
                <td>
                  {line.id === viewedId ? (
                    <span className="my-week-team-here">On screen</span>
                  ) : (
                    <button type="button" className="ghost-action" onClick={() => onLook(line.id)}>
                      Look<span className="visually-hidden"> at {line.name}'s week</span>
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

function ClientRow({
  row,
  days,
  today,
  canEdit,
  nameOf,
  showOther,
  onAddOther,
  onToggleDay,
  onClear,
  onNote,
  onTaskChoice,
}: {
  row: WeekPlanRow
  days: string[]
  today: string
  canEdit: boolean
  nameOf: (id: string) => string
  showOther: boolean
  onAddOther: () => void
  onToggleDay: (checklistId: string, day: string) => void
  onClear: () => void
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
        {/* Ad hoc work for a client that is listed for its tasks. */}
        {canEdit && !showOther ? (
          <button type="button" className="ghost-action my-week-add-other" onClick={onAddOther}>
            Add other work<span className="visually-hidden"> for {row.clientName}</span>
          </button>
        ) : null}
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
        <p className="my-week-empty">
          No task of yours is open for this client now.{' '}
          {canEdit ? (
            <button type="button" className="ghost-action" onClick={onClear}>
              {row.note ? 'Take it off my week (clears the note)' : 'Take it off my week'}
            </button>
          ) : null}
        </p>
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
                {task.waits.length > 0 ? (
                  <span
                    className={`my-week-wait${
                      task.waits[0].move === 'answered' ? ' is-answered' : task.waits[0].move === 'mine' ? ' is-mine' : ''
                    }`}
                  >
                    {waitWords(task.waits, nameOf)}
                  </span>
                ) : null}
              </div>
              {/* The days are on the TASK: a client with three tasks can have
                  each on a different day. */}
              <div
                className="my-week-daypick"
                role="group"
                aria-label={`Days for ${task.title} (${row.clientName}), due ${shortDay(task.dueDate)}`}
              >
                {days.map((day, index) => {
                  const on = task.days.includes(day)
                  return (
                    <button
                      key={day}
                      type="button"
                      className={`my-week-daybtn${on ? ' is-on' : ''}${day === today ? ' is-today' : ''}`}
                      aria-pressed={on}
                      aria-label={`${DAY_NAMES[index]} ${shortDay(day)}`}
                      title={`${DAY_NAMES[index]} ${shortDay(day)}`}
                      disabled={!canEdit}
                      onClick={() => onToggleDay(task.checklistId, day)}
                    >
                      {DAY_SHORT[index]}
                    </button>
                  )
                })}
              </div>
              <div className="my-week-task-status">
                {/* The label is only the name; the word beside the picker is not part of it. */}
                <label>
                  <span className="visually-hidden">Status of {task.title}</span>
                  <select
                    className="input"
                    value={task.hand ?? 'work'}
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
                {/* The picker shows only what she set herself. Whenever the
                    status shown is something else (planned or not, or set by
                    the Waiting flags), this says it. */}
                {task.status !== task.hand ? <small>{STATUS_WORDS[task.status]}</small> : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Work for this client that is not a task: its own days, nothing else. */}
      {showOther ? (
        <div className="my-week-task my-week-other">
          <div className="my-week-task-main">
            <span className="my-week-other-name">Other work (no task)</span>
            <span className="my-week-task-meta">
              <span>Work for this client that is not on a checklist</span>
            </span>
          </div>
          <div
            className="my-week-daypick"
            role="group"
            aria-label={`Days for other work (${row.clientName})`}
          >
            {days.map((day, index) => {
              const on = row.otherDays.includes(day)
              return (
                <button
                  key={day}
                  type="button"
                  className={`my-week-daybtn${on ? ' is-on' : ''}${day === today ? ' is-today' : ''}`}
                  aria-pressed={on}
                  aria-label={`${DAY_NAMES[index]} ${shortDay(day)}`}
                  title={`${DAY_NAMES[index]} ${shortDay(day)}`}
                  disabled={!canEdit}
                  onClick={() => onToggleDay(WEEK_PLAN_OTHER_KEY, day)}
                >
                  {DAY_SHORT[index]}
                </button>
              )
            })}
          </div>
        </div>
      ) : null}
    </li>
  )
}
