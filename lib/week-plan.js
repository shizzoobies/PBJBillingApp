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
 *  - one row per client with its tasks under it;
 *  - the STATUS IS ON EACH TASK, not on the client;
 *  - Monday to Friday.
 *
 * DAYS ARE ON EACH TASK TOO (her send-back, 2026-11-16: "for Associated ...
 * there are 3 task associated with it and I do not want to work on each task on
 * the same day. I need to be able to put them to different days."). The first
 * version put the CLIENT on a day. Now each task carries its own days, inside
 * its mark (`taskMarks[checklistId].days`), and the row's `plannedDays` is
 * only the union of them. A row saved by the first version has days on the
 * client and none on any task: it is read as every task being on those days
 * (`isClientDayRow`), which is what she had picked, and becomes per-task the
 * first time she changes a day on it.
 *
 * QUESTIONS SET THEMSELVES (ship 2, her answer 4: "I like this"). The team
 * already marks a step Waiting on a teammate or on the client. A task whose
 * every open step is held by such a wait is In questions without anyone setting
 * it, and says who it is waiting on and since when; when a wait is answered the
 * task reads Answered, which is the cue to pick it up again. A wait is read by
 * WHOSE MOVE it is for the person looking, the way the Delayed page splits
 * "Waiting on me" from "I am waiting on others": a step where she is the one
 * being asked is her work, never In questions. Nothing new is stored for this:
 * it is read off the waits each time.
 *
 * Pure: no clock, no store. The route and the page hand the data in. Shared by
 * the server (validating a save) and the page (building the view).
 */
import { rollUpItemDone } from './checklist-step-done.js'
import { isChecklistSkipped } from './checklist-skip.js'
import { dateOnlyInZone } from './firm-time.js'
import {
  canVerifyWaitingOn,
  isClientWait,
  isWaitingOnOpen,
  waitingOnStage,
} from './waiting-on-state.js'

/** The longest note a client row keeps. */
export const WEEK_PLAN_NOTE_MAX = 500
/** The longest note a hand-set task mark keeps. */
export const WEEK_PLAN_MARK_NOTE_MAX = 300
/** The most task marks one client row keeps (a client never has this many open tasks). */
export const WEEK_PLAN_MAX_MARKS = 200
/**
 * What a save from a page that still puts days on the CLIENT is answered with.
 * A page left open from before the days moved onto tasks reads the new rows
 * wrongly (it drops a task's days) and would save that back over them, so it is
 * not allowed to save at all: it is told to reload. The two pages save to
 * different addresses (see the routes in server.js), which is how they are
 * told apart, in both directions: yesterday's server has no route for today's
 * saves, so during a deploy hand-over it cannot half-understand one either.
 */
export const WEEK_PLAN_RELOAD_MESSAGE =
  'My Week has changed. Reload the page, then make the change again.'

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
    // A mark is what she set on a task: a status by hand, the days she means
    // to work on it, or both. One with neither says nothing and is not kept.
    const status = WEEK_PLAN_MARK_STATUSES.includes(mark.status) ? mark.status : null
    const days = [...new Set((Array.isArray(mark.days) ? mark.days : []).filter(isDateOnly))].sort()
    if (!status && days.length === 0) continue
    taskMarks[checklistId] = {
      status,
      note: status ? cleanText(mark.note, WEEK_PLAN_MARK_NOTE_MAX) : '',
      days,
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

/**
 * A row saved before days were per task: days on the client, none on any task.
 * It is read as every task of the client being on those days.
 */
export function isClientDayRow(entry) {
  return (
    (entry?.plannedDays ?? []).length > 0 &&
    !Object.values(entry?.taskMarks ?? {}).some((mark) => (mark?.days ?? []).length > 0)
  )
}

const unionOfDays = (taskMarks) =>
  [...new Set(Object.values(taskMarks ?? {}).flatMap((mark) => mark?.days ?? []))].sort()

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
 * Monday, a day outside that week's Monday to Friday (on the row or on a
 * task), a note or a mark that is not the right kind of thing.
 *
 * The row's own `plannedDays` is never taken from the request: it is always
 * the union of the tasks' days that are kept, so the two cannot disagree and a
 * row saved here can never read as the first version's "days on the client".
 Quietly dropped, because they are stale rather
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
    if (typeof mark !== 'object' || Array.isArray(mark)) {
      return { ok: false, error: 'A task can be marked In questions or Finished for month.' }
    }
    // No status is "Work on this week": allowed when the mark only carries days.
    if (mark.status !== undefined && mark.status !== null && !WEEK_PLAN_MARK_STATUSES.includes(mark.status)) {
      return { ok: false, error: 'A task can be marked In questions or Finished for month.' }
    }
    if (mark.note !== undefined && mark.note !== null && typeof mark.note !== 'string') {
      return { ok: false, error: 'A status note must be text.' }
    }
    if (mark.days !== undefined && mark.days !== null) {
      if (!Array.isArray(mark.days)) {
        return { ok: false, error: 'The days must be a list.' }
      }
      for (const day of mark.days) {
        if (!allowedDays.has(day)) {
          return { ok: false, error: 'A day must be Monday to Friday of that week.' }
        }
      }
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
      // Always the union of the tasks that were kept, an empty one included:
      // falling back to the days the request named would turn the row into
      // "the client is on these days" and put every task on them.
      plannedDays: unionOfDays(value.taskMarks),
      note: value.note,
      taskMarks: value.taskMarks,
    },
  }
}

/**
 * A row from the first version (days on the client), turned into days on each
 * of the client's tasks: every task on her page gets the client's days, which
 * is what the row was showing. A row that is already per-task is returned as it
 * is. Marks for tasks that are not on her page right now are kept untouched (a
 * task whose due date moved out of the month still has its status waiting for
 * it). The page runs every change through this first, so whatever she changes
 * on such a row (a day, a status, the note) it is saved per-task.
 *
 * @param {object} entry - the stored row (normalized).
 * @param {string[]} taskIds - the client's tasks on her page now.
 */
export function asPerTaskRow(entry, taskIds) {
  if (!isClientDayRow(entry)) return entry
  const taskMarks = { ...(entry.taskMarks ?? {}) }
  for (const id of Array.isArray(taskIds) ? taskIds : []) {
    const before = taskMarks[id] ?? null
    taskMarks[id] = { status: before?.status ?? null, note: before?.note ?? '', days: [...entry.plannedDays] }
  }
  const next = normalizeWeekPlanEntry({ ...entry, taskMarks })
  return { ...next, plannedDays: unionOfDays(next.taskMarks) }
}

/**
 * The row after she clicks a day on ONE task: that day is put on the task, or
 * taken off it if it was on. `taskIds` are the client's tasks on her page now.
 * Each task's days are read off the ROW (not off what is on screen, which can
 * be one click behind): its own, or the client's on a row from the first
 * version. Such a row turns per-task first (`asPerTaskRow`): every task keeps
 * the days it was on, and only the clicked one changes. No other mark is
 * touched, listed or not.
 *
 * @param {object} entry - the stored row (normalized).
 * @param {string[]} taskIds
 * @param {string} checklistId
 * @param {string} day - yyyy-mm-dd
 */
export function withTaskDayToggled(entry, taskIds, checklistId, day) {
  const base = asPerTaskRow(entry, taskIds)
  const before = base.taskMarks?.[checklistId] ?? null
  const had = before?.days ?? []
  const days = had.includes(day) ? had.filter((each) => each !== day) : [...had, day]
  // Only the clicked task changes. Every other mark stays, including one on a
  // task that is not on her page right now.
  const taskMarks = {
    ...(base.taskMarks ?? {}),
    [checklistId]: { status: before?.status ?? null, note: before?.note ?? '', days },
  }
  const next = normalizeWeekPlanEntry({ ...base, taskMarks })
  return { ...next, plannedDays: unionOfDays(next.taskMarks) }
}

/**
 * The row after she sets (or clears, with null) a status on ONE task by hand.
 * The task's days are kept. On a row from the first version nothing else is
 * touched, so it stays "the client is on these days" until she changes a day.
 */
export function withTaskStatusSet(entry, checklistId, status) {
  const before = entry?.taskMarks?.[checklistId] ?? null
  const taskMarks = {
    ...(entry?.taskMarks ?? {}),
    [checklistId]: {
      status: WEEK_PLAN_MARK_STATUSES.includes(status) ? status : null,
      note: before?.note ?? '',
      days: before?.days ?? [],
    },
  }
  return normalizeWeekPlanEntry({ ...entry, taskMarks })
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

/** The firm's calendar day of an instant, or null when it is not a real instant. */
const dayOf = (iso) => {
  if (typeof iso !== 'string' || !iso) return null
  const instant = new Date(iso)
  return Number.isNaN(instant.getTime()) ? null : dateOnlyInZone(instant)
}

/**
 * WHOSE MOVE a wait is, for the person looking. The Delayed page splits waits
 * the same way ("Waiting on me" / "I am waiting on others"), and for the same
 * reason: one wait is somebody's work and somebody else's hold.
 *
 *  - 'mine'     someone is waiting on HER and she has not done her part yet.
 *               That is work for her, never a hold.
 *  - 'answered' the person asked has done their part and it is HERS to confirm
 *               (she asked, or the step is assigned to her:
 *               `canVerifyWaitingOn`). The cue to pick the task up.
 *  - 'out'      it is someone else's move: a question still with the person
 *               asked or with the client, or an answer that someone else has to
 *               confirm. This is what holds a step for her.
 */
function waitMove(wait, userId, stepAssigneeId) {
  if (waitingOnStage(wait) === 'waiting') {
    if (!isClientWait(wait) && wait.blockerId === userId) return 'mine'
    // The person asked has asked a question back and she is the one who can
    // answer it (she asked, or the step is hers): until they hear from her
    // nothing moves, so it is her work, whatever the record says about whose
    // turn it formally is.
    const waitingSide = wait.requestedBy === userId || (Boolean(stepAssigneeId) && stepAssigneeId === userId)
    return waitingSide && hasFreshQuestion(wait) ? 'mine' : 'out'
  }
  return canVerifyWaitingOn({ entry: wait, userId, assigneeId: stepAssigneeId }) ? 'answered' : 'out'
}

const newestAt = (list) =>
  (Array.isArray(list) ? list : [])
    .map((entry) => (typeof entry?.at === 'string' ? entry.at : ''))
    .filter(Boolean)
    .sort()
    .pop() ?? ''

/**
 * Has the person asked sent a question back that nothing has followed? A
 * question older than the newest send-back belongs to an earlier lap of the
 * same wait and is not waiting on anyone any more.
 */
function hasFreshQuestion(wait) {
  const asked = newestAt(wait.questions)
  return asked !== '' && asked > newestAt(wait.sendBacks)
}

/** When the wait last became the other person's move: its newest send-back, or when it was made. */
function waitSince(wait) {
  const sentBack = (Array.isArray(wait.sendBacks) ? wait.sendBacks : [])
    .map((entry) => dayOf(entry?.at))
    .filter(Boolean)
    .sort()
  return sentBack.length > 0 ? sentBack[sentBack.length - 1] : dayOf(wait.createdAt)
}

/** One wait in the words the page needs: whose move, who to name, since when. */
function describeWait(wait, userId, stepAssigneeId) {
  const move = waitMove(wait, userId, stepAssigneeId)
  const resolved = waitingOnStage(wait) === 'resolved'
  const id = (value) => (typeof value === 'string' && value ? value : null)
  const fresh = !resolved && hasFreshQuestion(wait)
  // Her move because the person asked wants to know something from her.
  const asksHer = move === 'mine' && wait.blockerId !== userId
  return {
    move,
    // Who the page names: who answered, who is waiting on her (or asked her a
    // question), who has to confirm, or who is being asked.
    who:
      move === 'answered'
        ? id(wait.resolvedBy)
        : asksHer
          ? id(wait.blockerId)
          : move === 'mine'
            ? id(wait.requestedBy)
            : resolved
              ? id(wait.requestedBy)
              : isClientWait(wait)
                ? null
                : id(wait.blockerId),
    onClient: move === 'out' && !resolved && isClientWait(wait),
    // Out with someone who only has to confirm an answer that is already in.
    toConfirm: move === 'out' && resolved,
    // The person asked has asked a question back that nothing has followed.
    // On a 'mine' wait it is set only when the question is FOR her (not when
    // she is the one who asked it); on an 'out' wait it is someone else's
    // conversation and is only mentioned.
    askedBack: move === 'mine' ? asksHer : fresh,
    since: waitSince(wait),
    note: cleanText(wait.note, WEEK_PLAN_MARK_NOTE_MAX),
  }
}

/**
 * Read one open piece of work (a step, a sub-step or one beneath it) for this
 * person: is it HELD for her, and which waits are on it.
 *
 * Held means there is nothing for her to do on it until someone else moves:
 * it carries a wait (or the old plain Waiting flag) and every wait on it is
 * 'out'; or it has open pieces beneath it and every one of them is held. A
 * piece that is waiting itself is held even when a piece beneath it is open,
 * which is how the Board reads a waiting step (`stageOpenWorkAllWaiting`): the
 * flag on the step speaks for the step. A wait that is her move, or an answer
 * that is hers to confirm, is never a hold;
 * `taskWaitState` also refuses to call a task In questions while ANY wait on
 * its open work is her move, wherever in the task it sits.
 */
function readPiece(node, userId, stepAssigneeId, waits) {
  if (!node || rollUpItemDone(node)) return true
  const own = (Array.isArray(node.waitingOns) ? node.waitingOns : [])
    .filter(isWaitingOnOpen)
    .map((wait) => describeWait(wait, userId, stepAssigneeId))
  if (node.waiting === true && own.length === 0) {
    own.push({
      move: 'out',
      who: null,
      onClient: false,
      toConfirm: false,
      askedBack: false,
      since: null,
      note: cleanText(node.waitingOn, WEEK_PLAN_MARK_NOTE_MAX),
    })
  }
  waits.push(...own)
  const open = (Array.isArray(node.subItems) ? node.subItems : []).filter((sub) => !rollUpItemDone(sub))
  // Always read beneath, so a wait on a sub-step is reported even when the
  // step above it decides the hold.
  const beneath = open.map((sub) => readPiece(sub, userId, stepAssigneeId, waits))
  if (own.length > 0) return own.every((wait) => wait.move === 'out')
  return open.length > 0 && beneath.every(Boolean)
}

/**
 * What the Waiting flags say about one task of this person's, with nothing set
 * by hand:
 *  - 'answered' when a wait on her open work has been answered and is HERS to
 *    confirm: there is something to pick up;
 *  - 'questions' when EVERY open step of hers is held (see `readPiece`): there
 *    is nothing to do here until someone else moves, so she should not reopen it;
 *  - null otherwise. A waiting step beside an open step that is not waiting is
 *    ordinary work. So is a task with ANY wait that is her move, wherever it
 *    sits: beneath a step that is itself held, or on someone else's step of a
 *    checklist where only a step is hers. The Delayed page shows her those
 *    under "Waiting on me"; parking the task here would hide them.
 * When only a step of the checklist is hers, only her steps decide the hold.
 * The step's own assignee decides who confirms, as on the Delayed page.
 *
 * @returns {{ auto: 'answered' | 'questions' | null, waits: Array<object> }}
 */
export function taskWaitState(checklist, userId) {
  const open = openItems(checklist)
  const hers =
    checklist?.assigneeId === userId ? open : open.filter((item) => item.assigneeId === userId)
  const waits = []
  const held = hers.map((item) => readPiece(item, userId, item.assigneeId ?? null, waits))
  // Someone waiting on HER on a step that is not hers is still her move.
  for (const item of open) {
    if (hers.includes(item)) continue
    const theirs = []
    readPiece(item, userId, item.assigneeId ?? null, theirs)
    waits.push(...theirs.filter((wait) => wait.move === 'mine'))
  }
  if (waits.some((wait) => wait.move === 'answered')) return { auto: 'answered', waits }
  if (waits.some((wait) => wait.move === 'mine')) return { auto: null, waits }
  if (hers.length > 0 && held.every(Boolean)) return { auto: 'questions', waits }
  return { auto: null, waits }
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
 *   rows: Array<object>, byDay: Array<{ date: string, items: Array<object> }>,
 *   notPlannedCount: number, questions: Array<object>,
 *   answered: Array<object>, finishedClientCount: number,
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
      ...taskWaitState(checklist, userId),
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
    const inWeek = (list) => (list ?? []).filter((day) => days.includes(day))
    // Days are on each task. A row from the first version has them on the
    // client instead: every task is then on those days.
    const clientDays = isClientDayRow(entry) ? inWeek(entry.plannedDays) : null
    const tasks = (tasksByClient.get(clientId) ?? [])
      .map((task) => {
        const mark = entry.taskMarks[task.checklistId] ?? null
        const hand = mark ? mark.status : null
        const taskDays = clientDays ?? inWeek(mark?.days)
        const planned = taskDays.length > 0
        // What she set by hand as finished stands. Otherwise an answer that is
        // in outranks everything (it is the cue to pick the task up), then
        // questions, whether the waits say so or she does.
        const status =
          hand === 'finished'
            ? 'finished'
            : task.auto === 'answered'
              ? 'answered'
              : task.auto === 'questions' || hand === 'questions'
                ? 'questions'
                : planned
                  ? 'planned'
                  : 'not_planned'
        return {
          ...task,
          status,
          // The days she means to work on THIS task (Monday to Friday of the week).
          days: taskDays,
          // What she set herself ('questions' | 'finished'), or null: the picker shows this.
          hand,
          markNote: mark ? mark.note : '',
          // The waits behind the status shown: the answers that are in once
          // it is Answered, the ones out with someone else while the flags hold
          // it in questions. Under anything else, only the ones that are HER
          // move are kept ("Bob is waiting on you"): they are why it is work.
          waits:
            status === 'finished'
              ? []
              : status === 'answered'
                ? task.waits.filter((wait) => wait.move === 'answered')
                : status === 'questions' && task.auto === 'questions'
                  ? task.waits.filter((wait) => wait.move === 'out')
                  : task.waits.filter((wait) => wait.move === 'mine'),
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
      answered: count('answered'),
      finished: count('finished'),
    }
    // The days this client appears on: its tasks' days, or, once nothing of
    // hers is open for it, the days she had planned (so they do not empty).
    const plannedDays =
      tasks.length > 0
        ? [...new Set(tasks.flatMap((task) => task.days))].sort()
        : inWeek(entry.plannedDays)
    const planned = plannedDays.length > 0
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
      // She has done something about this client this week: a day, a mark on a
      // task, or questions that are out (or back) on one.
      started: planned || rollup.questions + rollup.answered + rollup.finished > 0,
    })
  }
  // Not started first, so the bottom of the list stops being the last to be seen.
  rows.sort(
    (a, b) =>
      Number(a.started) - Number(b.started) ||
      a.clientName.localeCompare(b.clientName) ||
      a.clientId.localeCompare(b.clientId),
  )

  // The five days, each with the TASKS she put on it (not whole clients). A
  // task in questions or finished stays on its day but is marked parked; a
  // client she had planned that has nothing open any more shows once, as that.
  const byDay = days.map((date) => {
    const items = []
    for (const row of rows) {
      if (row.noOpenWork) {
        if (row.plannedDays.includes(date)) {
          items.push({
            clientId: row.clientId,
            clientName: row.clientName,
            checklistId: null,
            title: '',
            parked: true,
            nothingOpen: true,
          })
        }
        continue
      }
      for (const task of row.tasks) {
        if (!task.days.includes(date)) continue
        items.push({
          clientId: row.clientId,
          clientName: row.clientName,
          checklistId: task.checklistId,
          title: task.title,
          parked: task.status === 'questions' || task.status === 'finished',
          nothingOpen: false,
        })
      }
    }
    items.sort(
      (a, b) =>
        a.clientName.localeCompare(b.clientName) ||
        a.title.localeCompare(b.title) ||
        String(a.checklistId).localeCompare(String(b.checklistId)),
    )
    return { date, items }
  })

  const questions = []
  const answered = []
  for (const row of rows) {
    for (const task of row.tasks) {
      if (task.status !== 'questions' && task.status !== 'answered') continue
      const line = {
        clientId: row.clientId,
        clientName: row.clientName,
        checklistId: task.checklistId,
        title: task.title,
        dueDate: task.dueDate,
        note: task.markNote,
        // Set by the Waiting flags (it clears by itself), or by her (she clears it).
        auto: task.status === 'answered' || task.auto === 'questions',
        // She set In questions herself: hers to clear, whatever the flags also say.
        byHand: task.hand === 'questions',
        waits: task.waits,
      }
      if (task.status === 'answered') answered.push(line)
      else questions.push(line)
    }
  }

  // Finished for the month, by itself: a client where every checklist she holds
  // that is due this month (not skipped, not deleted) is complete, and nothing
  // of hers is left open for it. Those clients are off the list (one she put on
  // a day stays, reading "Nothing open", and is not counted twice here); this
  // is the count of them, so finishing shows up somewhere.
  //
  // "This month" is today's month while the week on screen is the one today is
  // in, and otherwise the month that week's Monday is in. Reading it off the
  // Friday would empty the count on a Monday the 30th.
  const monthOf = today >= weekStart && today <= addDays(weekStart, 6) ? today : weekStart
  const monthStart = `${monthOf.slice(0, 8)}01`
  const monthEnd = monthEndOf(monthOf)
  const heldThisMonth = new Map()
  for (const checklist of Array.isArray(checklists) ? checklists : []) {
    if (!isLive(checklist) || checklist.assigneeId !== userId) continue
    if (typeof checklist.dueDate !== 'string') continue
    if (checklist.dueDate < monthStart || checklist.dueDate > monthEnd) continue
    if (!clientNames.has(checklist.clientId)) continue
    const items = Array.isArray(checklist.items) ? checklist.items : []
    const complete = items.length > 0 && openItems(checklist).length === 0
    const state = heldThisMonth.get(checklist.clientId) ?? { any: false, allComplete: true }
    state.any = true
    if (!complete) state.allComplete = false
    heldThisMonth.set(checklist.clientId, state)
  }
  let finishedClientCount = 0
  for (const [clientId, state] of heldThisMonth) {
    if (state.any && state.allComplete && !clientIds.has(clientId)) finishedClientCount += 1
  }

  return {
    weekStart,
    days,
    dueThrough,
    rows,
    byDay,
    notPlannedCount: rows.filter((row) => !row.started && !row.noOpenWork).length,
    questions,
    answered,
    finishedClientCount,
  }
}
