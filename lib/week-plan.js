/**
 * My Week: a person's own plan for the week (featreq-f0e8046b,
 * docs/plans/weekly-scheduler-2026-11.md).
 *
 * Brittany: "what if we had a scheduler of some type that you could like look
 * at the week and say ok I need to touch these clients ... and then sort
 * clients by day". The problem behind it: everything has the same due date, so
 * a person starts at the top of the list, works each client to 100 percent, and
 * the clients at the bottom are not touched until the end of the month.
 *
 * What is STORED is small and is the person's own: for one person, one week and
 * one client, the days she means to work on it, a one-line note, and a mark she
 * can put on a task by hand ("In questions", "Finished for month"). Everything
 * else on the page is DERIVED here from the checklists themselves, so the plan
 * can never drift from the real work: which clients she has open work for, what
 * is due, how far along it is.
 *
 * Her answers (2026-11-16) this file follows:
 *  - the list is every client the person has open work for that is due this
 *    month or overdue, with this week's due dates marked;
 *  - one row per client with its tasks under it, the client is what goes on a day;
 *  - the STATUS IS ON EACH TASK, not on the client;
 *  - Monday to Friday.
 *
 * Pure: no clock, no store. The route and the page hand the data in. Shared by
 * the server (validating a save) and the page (building the view).
 */
import { rollUpItemDone } from './checklist-step-done.js'
import { isChecklistSkipped } from './checklist-skip.js'

/** The longest note a client row keeps. */
export const WEEK_PLAN_NOTE_MAX = 500
/** The longest note a hand-set task mark keeps. */
export const WEEK_PLAN_MARK_NOTE_MAX = 300
/** The most task marks one client row keeps (a client never has this many open tasks). */
export const WEEK_PLAN_MAX_MARKS = 200
/** What a person can set on a task by hand. No mark = "Work on this week". */
export const WEEK_PLAN_MARK_STATUSES = Object.freeze(['questions', 'finished'])

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

const pad2 = (value) => String(value).padStart(2, '0')

/** A real calendar date written yyyy-mm-dd (2026-02-30 is not one). */
export function isDateOnly(value) {
  if (typeof value !== 'string') return false
  const match = DATE_ONLY.exec(value)
  if (!match) return false
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

const toUtc = (dateOnly) => {
  const match = DATE_ONLY.exec(dateOnly)
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
}
const fromUtc = (date) =>
  `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`

/** `dateOnly` moved by whole days. Calendar arithmetic only, so no time zone can shift it. */
export function addDays(dateOnly, days) {
  const date = toUtc(dateOnly)
  date.setUTCDate(date.getUTCDate() + days)
  return fromUtc(date)
}

/**
 * The Monday of the week a date is in. A Saturday or Sunday belongs to the week
 * that just ended (its Monday is behind it), so on a weekend the page still
 * shows the week the person was working, not an empty one.
 */
export function mondayOf(dateOnly) {
  const weekday = toUtc(dateOnly).getUTCDay() // 0 Sunday ... 6 Saturday
  return addDays(dateOnly, -((weekday + 6) % 7))
}

/** True for a real date that is a Monday: the only thing a week may start on. */
export function isMonday(value) {
  return isDateOnly(value) && toUtc(value).getUTCDay() === 1
}

/** Monday to Friday of the week starting `weekStart`. */
export function weekDays(weekStart) {
  return [0, 1, 2, 3, 4].map((offset) => addDays(weekStart, offset))
}

/** The last day of the month a date is in. */
export function monthEndOf(dateOnly) {
  const date = toUtc(dateOnly)
  return fromUtc(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)))
}

const cleanText = (value, max) =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''

/**
 * One stored row, in the shape every reader gets, whatever was stored: days in
 * order with no repeats, a note that is always a string, and only marks this
 * file knows. Never throws; junk becomes the empty value.
 */
export function normalizeWeekPlanEntry(entry) {
  const plannedDays = [
    ...new Set((Array.isArray(entry?.plannedDays) ? entry.plannedDays : []).filter(isDateOnly)),
  ].sort()
  const taskMarks = {}
  const rawMarks =
    entry?.taskMarks && typeof entry.taskMarks === 'object' && !Array.isArray(entry.taskMarks)
      ? entry.taskMarks
      : {}
  for (const checklistId of Object.keys(rawMarks).sort()) {
    const mark = rawMarks[checklistId]
    if (!checklistId || !mark || typeof mark !== 'object') continue
    if (!WEEK_PLAN_MARK_STATUSES.includes(mark.status)) continue
    taskMarks[checklistId] = {
      status: mark.status,
      note: cleanText(mark.note, WEEK_PLAN_MARK_NOTE_MAX),
    }
  }
  return {
    clientId: typeof entry?.clientId === 'string' ? entry.clientId : '',
    plannedDays,
    note: cleanText(entry?.note, WEEK_PLAN_NOTE_MAX),
    taskMarks,
    updatedAt: typeof entry?.updatedAt === 'string' ? entry.updatedAt : null,
  }
}

/** A row with nothing on it: no day, no note, no mark. It is not kept. */
export function isEmptyWeekPlanEntry(entry) {
  return (
    (entry?.plannedDays ?? []).length === 0 &&
    !(entry?.note ?? '') &&
    Object.keys(entry?.taskMarks ?? {}).length === 0
  )
}

/**
 * Check what a person asked to save for one client and one week, and hand back
 * exactly what will be stored. The page sends the WHOLE row each time (days,
 * note, marks), so this is a replace, not a merge.
 *
 * Refused, with words the page can show: a week that does not start on a
 * Monday, a day outside that week's Monday to Friday, a note or a mark that is
 * not the right kind of thing. Quietly dropped, because they are stale rather
 * than wrong: a mark for a checklist that is not one of this client's any more
 * (finished, deleted or moved since the page loaded).
 *
 * @param {object} input - `{ weekStart, plannedDays, note, taskMarks }` from the request.
 * @param {{ checklistIds: Iterable<string> }} context - this client's checklists right now.
 * @returns {{ ok: true, value: { weekStart: string, plannedDays: string[], note: string, taskMarks: object } } | { ok: false, error: string }}
 */
export function normalizeWeekPlanInput(input, { checklistIds } = {}) {
  const weekStart = input?.weekStart
  if (!isMonday(weekStart)) {
    return { ok: false, error: 'The week must start on a Monday.' }
  }
  const rawDays = input?.plannedDays ?? []
  if (!Array.isArray(rawDays)) {
    return { ok: false, error: 'The days must be a list.' }
  }
  const allowedDays = new Set(weekDays(weekStart))
  for (const day of rawDays) {
    if (!allowedDays.has(day)) {
      return { ok: false, error: 'A day must be Monday to Friday of that week.' }
    }
  }
  if (input?.note !== undefined && input.note !== null && typeof input.note !== 'string') {
    return { ok: false, error: 'The note must be text.' }
  }
  const rawMarks = input?.taskMarks ?? {}
  if (!rawMarks || typeof rawMarks !== 'object' || Array.isArray(rawMarks)) {
    return { ok: false, error: 'The task statuses are not in a form this page understands.' }
  }
  const known = new Set(checklistIds ?? [])
  const taskMarks = {}
  for (const checklistId of Object.keys(rawMarks)) {
    const mark = rawMarks[checklistId]
    // "Work on this week" is the absence of a mark: null clears one.
    if (mark === null || mark === undefined) continue
    if (typeof mark !== 'object' || !WEEK_PLAN_MARK_STATUSES.includes(mark.status)) {
      return { ok: false, error: 'A task can be marked In questions or Finished for month.' }
    }
    if (mark.note !== undefined && mark.note !== null && typeof mark.note !== 'string') {
      return { ok: false, error: 'A status note must be text.' }
    }
    if (!known.has(checklistId)) continue
    taskMarks[checklistId] = mark
  }
  if (Object.keys(taskMarks).length > WEEK_PLAN_MAX_MARKS) {
    return { ok: false, error: 'That is more task statuses than one client can have.' }
  }
  const value = normalizeWeekPlanEntry({ plannedDays: rawDays, note: input?.note, taskMarks })
  return {
    ok: true,
    value: {
      weekStart,
      plannedDays: value.plannedDays,
      note: value.note,
      taskMarks: value.taskMarks,
    },
  }
}

const isLive = (checklist) =>
  Boolean(checklist) && !checklist.deletedAt && !isChecklistSkipped(checklist)

const openItems = (checklist) =>
  (Array.isArray(checklist?.items) ? checklist.items : []).filter((item) => !rollUpItemDone(item))

/**
 * Is this checklist open work of this person's? It is when it is not finished,
 * skipped or deleted, and either she is its assignee or one of its steps that
 * is still open is assigned to her by name. A checklist with no steps at all is
 * open (there is nothing to tick, so nothing says it is done).
 */
export function isOpenWorkFor(checklist, userId) {
  if (!userId || !isLive(checklist)) return false
  const items = Array.isArray(checklist.items) ? checklist.items : []
  const open = openItems(checklist)
  if (items.length > 0 && open.length === 0) return false
  if (checklist.assigneeId === userId) return true
  return open.some((item) => item.assigneeId === userId)
}

/**
 * The date a task is due FOR THIS PERSON: the soonest of the checklist's own
 * due date and the due date of any step still open. The Board buckets a
 * checklist the same way (`effectiveDue`), so a checklist due next month whose
 * open step is due this week is on this week's list and reads "due this week",
 * not left off until its last step. When only a step of the checklist is hers,
 * only HER open steps' dates count.
 */
export function taskDueFor(checklist, userId) {
  const holds = checklist.assigneeId === userId
  let due = checklist.dueDate
  for (const item of openItems(checklist)) {
    if (!holds && item.assigneeId !== userId) continue
    if (isDateOnly(item.dueDate) && item.dueDate < due) due = item.dueDate
  }
  return due
}

/**
 * The page, built from the work and the stored plan.
 *
 * @param {object} args
 * @param {Array<object>} args.checklists - the workspace's checklists.
 * @param {Array<{ id: string, name: string }>} args.clients
 * @param {Array<object>} [args.entries] - this person's stored rows for this week.
 * @param {string} args.userId - whose week.
 * @param {string} args.weekStart - the Monday, yyyy-mm-dd.
 * @param {string} args.today - yyyy-mm-dd (the firm's day).
 * @returns {{
 *   weekStart: string, days: string[], dueThrough: string,
 *   rows: Array<object>, notPlannedCount: number, questions: Array<object>,
 * }}
 */
export function buildWeekPlan({ checklists, clients, entries = [], userId, weekStart, today }) {
  const days = weekDays(weekStart)
  const friday = days[4]
  // "Due this month or overdue": everything due up to the end of the month the
  // week's Friday is in. An earlier due date is overdue and always shown.
  const dueThrough = monthEndOf(friday)
  const clientNames = new Map((clients ?? []).map((client) => [client.id, client.name]))
  const entryByClient = new Map()
  for (const raw of Array.isArray(entries) ? entries : []) {
    const entry = normalizeWeekPlanEntry(raw)
    if (entry.clientId) entryByClient.set(entry.clientId, entry)
  }

  const tasksByClient = new Map()
  for (const checklist of Array.isArray(checklists) ? checklists : []) {
    if (!isOpenWorkFor(checklist, userId)) continue
    if (typeof checklist.dueDate !== 'string') continue
    const dueDate = taskDueFor(checklist, userId)
    if (dueDate > dueThrough) continue
    if (!clientNames.has(checklist.clientId)) continue
    const items = Array.isArray(checklist.items) ? checklist.items : []
    const list = tasksByClient.get(checklist.clientId) ?? []
    list.push({
      checklistId: checklist.id,
      title: checklist.title ?? '',
      dueDate,
      overdue: dueDate < today,
      dueThisWeek: dueDate >= weekStart && dueDate <= friday,
      stepsDone: items.length - openItems(checklist).length,
      stepsTotal: items.length,
      stageIndex: typeof checklist.stageIndex === 'number' ? checklist.stageIndex : null,
      stageCount: typeof checklist.stageCount === 'number' ? checklist.stageCount : null,
      caseId: checklist.caseId ?? null,
      // Hers because she holds the checklist, or because a step of it is hers.
      mine: checklist.assigneeId === userId ? 'checklist' : 'step',
    })
    tasksByClient.set(checklist.clientId, list)
  }

  const rows = []
  const clientIds = new Set([...tasksByClient.keys()])
  // A client she put on a day or wrote a note on stays on the page after its
  // work is finished, so the day she planned does not empty itself under her.
  for (const [clientId, entry] of entryByClient) {
    if (!clientNames.has(clientId)) continue
    if (entry.plannedDays.length > 0 || entry.note) clientIds.add(clientId)
  }
  for (const clientId of clientIds) {
    const entry = entryByClient.get(clientId) ?? normalizeWeekPlanEntry({ clientId })
    const plannedDays = entry.plannedDays.filter((day) => days.includes(day))
    const planned = plannedDays.length > 0
    const tasks = (tasksByClient.get(clientId) ?? [])
      .map((task) => {
        const mark = entry.taskMarks[task.checklistId] ?? null
        return {
          ...task,
          status: mark ? mark.status : planned ? 'planned' : 'not_planned',
          markNote: mark ? mark.note : '',
        }
      })
      .sort(
        (a, b) =>
          a.dueDate.localeCompare(b.dueDate) ||
          a.title.localeCompare(b.title) ||
          a.checklistId.localeCompare(b.checklistId),
      )
    const count = (status) => tasks.filter((task) => task.status === status).length
    const rollup = {
      planned: count('planned'),
      notPlanned: count('not_planned'),
      questions: count('questions'),
      finished: count('finished'),
    }
    rows.push({
      clientId,
      clientName: clientNames.get(clientId) ?? '',
      plannedDays,
      note: entry.note,
      tasks,
      rollup,
      // Nothing of hers is open for this client any more (it stays because she planned it).
      noOpenWork: tasks.length === 0,
      // Every task is parked (in questions, or finished for the month): there
      // is nothing to pick up here today, so its place on a day is shown greyed.
      allParked: tasks.length > 0 && rollup.questions + rollup.finished === tasks.length,
      // She has done something about this client this week: a day, or a mark on a task.
      started: planned || rollup.questions + rollup.finished > 0,
    })
  }
  // Not started first, so the bottom of the list stops being the last to be seen.
  rows.sort(
    (a, b) =>
      Number(a.started) - Number(b.started) ||
      a.clientName.localeCompare(b.clientName) ||
      a.clientId.localeCompare(b.clientId),
  )

  const questions = []
  for (const row of rows) {
    for (const task of row.tasks) {
      if (task.status !== 'questions') continue
      questions.push({
        clientId: row.clientId,
        clientName: row.clientName,
        checklistId: task.checklistId,
        title: task.title,
        dueDate: task.dueDate,
        note: task.markNote,
      })
    }
  }

  return {
    weekStart,
    days,
    dueThrough,
    rows,
    notPlannedCount: rows.filter((row) => !row.started && !row.noOpenWork).length,
    questions,
  }
}
