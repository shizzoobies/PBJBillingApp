/** Types for the plain-JS `lib/week-plan.js` (the server validates a save with it; the My Week page builds its view with it). */

export declare const WEEK_PLAN_NOTE_MAX: number
export declare const WEEK_PLAN_MARK_NOTE_MAX: number
export declare const WEEK_PLAN_MAX_MARKS: number
export declare const WEEK_PLAN_MARK_STATUSES: readonly ['questions', 'finished']
/** The key in `taskMarks` for work on the client that is not tied to a task (days only). */
export declare const WEEK_PLAN_OTHER_KEY: '*'
/** What a save from a page left open from before the days moved onto tasks is answered with. */
export declare const WEEK_PLAN_RELOAD_MESSAGE: string

/** What a person can set on a task by hand. No status means "Work on this week". */
export type WeekPlanMarkStatus = 'questions' | 'finished'
/** What she set on one task: a status by hand, the days she means to work on it, or both. */
export type WeekPlanMark = {
  status: WeekPlanMarkStatus | null
  note: string
  days: string[]
  /** Brought into this week from a later week (stored only when true). */
  brought?: boolean
  /** Pushed out of this week to next week (stored only when true). */
  pushed?: boolean
}

/** One stored row: one person, one week, one client. */
export type WeekPlanEntry = {
  clientId: string
  plannedDays: string[]
  note: string
  taskMarks: Record<string, WeekPlanMark>
  updatedAt: string | null
}

/** 'answered' is never set by hand: a wait on the task has been answered and is hers to confirm. */
export type WeekPlanTaskStatus = 'not_planned' | 'planned' | 'answered' | WeekPlanMarkStatus

/**
 * One wait on a task, read for the person looking. `move` is whose turn it is:
 * 'mine' (someone is waiting on her), 'answered' (an answer is hers to
 * confirm), 'out' (someone else's turn: this is what holds a step).
 */
export type WeekPlanWait = {
  move: 'mine' | 'answered' | 'out'
  /** Who the page names: who answered, who is waiting on her, who must confirm, or who is asked. Null for the client or an old-style flag. */
  who: string | null
  onClient: boolean
  /** An answer is in and someone else has to confirm it. */
  toConfirm: boolean
  /** The person asked has asked a question back that nothing has followed. On a 'mine' wait it is hers to answer. */
  askedBack: boolean
  since: string | null
  note: string
}

export type WeekPlanTask = {
  checklistId: string
  title: string
  dueDate: string
  overdue: boolean
  dueThisWeek: boolean
  /** On this week's list because she brought it forward from a later week. */
  brought: boolean
  stepsDone: number
  stepsTotal: number
  stageIndex: number | null
  stageCount: number | null
  caseId: string | null
  mine: 'checklist' | 'step'
  status: WeekPlanTaskStatus
  /** The days she means to work on this task. */
  days: string[]
  /** What the Waiting flags say with nothing set by hand. */
  auto: 'answered' | 'questions' | null
  /** What she set herself, or null ("Work on this week"). */
  hand: WeekPlanMarkStatus | null
  markNote: string
  /** The waits behind the status shown; under Planned / Not planned, only the ones that are her move. */
  waits: WeekPlanWait[]
}

export type WeekPlanRow = {
  clientId: string
  clientName: string
  plannedDays: string[]
  note: string
  tasks: WeekPlanTask[]
  /** The days she put work with no task on. */
  otherDays: string[]
  rollup: { planned: number; notPlanned: number; questions: number; answered: number; finished: number }
  noOpenWork: boolean
  allParked: boolean
  started: boolean
}

export type WeekPlanQuestion = {
  clientId: string
  clientName: string
  checklistId: string
  title: string
  dueDate: string
  note: string
  /** Set by the Waiting flags (clears by itself) rather than by her. */
  auto: boolean
  /** She set In questions herself (hers to clear). */
  byHand: boolean
  waits: WeekPlanWait[]
  /** Only on an Answered line for a task that is not on this week's list: due in a later week, or pushed. */
  offList?: 'later' | 'pushed'
}

/** One thing on a day: a task, or a planned client with nothing open any more. */
export type WeekPlanDayItem = {
  clientId: string
  clientName: string
  checklistId: string | null
  title: string
  parked: boolean
  nothingOpen: boolean
  /** Work on the client with no task. */
  other: boolean
}

/** A task off this week's list: due in a later week, or pushed to next week. */
export type WeekPlanOffListTask = {
  checklistId: string
  title: string
  dueDate: string
  /** The state it is in, read as on the list; null when nothing is set. */
  status: 'answered' | 'questions' | 'finished' | null
  /** The waits behind that state; with nothing set, only the ones that are her move. */
  waits: WeekPlanWait[]
  /** An answer is in, or someone is waiting on her: hers to pick up. */
  needsHer: boolean
}

export type WeekPlanView = {
  weekStart: string
  days: string[]
  /** The week's Sunday: a task due on or before it is this week's. */
  weekEnd: string
  dueThrough: string
  rows: WeekPlanRow[]
  /** Her open tasks due after this week's Sunday, through `dueThrough`, by client. */
  later: Array<{ clientId: string; clientName: string; tasks: WeekPlanOffListTask[] }>
  /** Tasks she pushed out of this week. */
  pushed: Array<WeekPlanOffListTask & { clientId: string; clientName: string }>
  /** Monday to Friday, each with the tasks put on it. */
  byDay: Array<{ date: string; items: WeekPlanDayItem[] }>
  notPlannedCount: number
  questions: WeekPlanQuestion[]
  /** Tasks with an answer in, waiting for her to pick them up. */
  answered: WeekPlanQuestion[]
  /** Clients where everything she holds that is due this month is complete. */
  finishedClientCount: number
}

export declare function isDateOnly(value: unknown): boolean
export declare function addDays(dateOnly: string, days: number): string
export declare function mondayOf(dateOnly: string): string
export declare function isMonday(value: unknown): boolean
export declare function weekDays(weekStart: string): string[]
export declare function monthEndOf(dateOnly: string): string
export declare function normalizeWeekPlanEntry(entry: unknown): WeekPlanEntry
/** A row saved before days were per task: days on the client, none on any task. */
export declare function isClientDayRow(entry: {
  plannedDays?: string[]
  taskMarks?: Record<string, { days?: string[] }>
} | null | undefined): boolean
/** A first-version row (days on the client) as days on each listed task; any other row unchanged. */
export declare function asPerTaskRow(entry: WeekPlanEntry, taskIds: string[]): WeekPlanEntry
export declare function withTaskDayToggled(
  entry: WeekPlanEntry,
  taskIds: string[],
  checklistId: string,
  day: string,
): WeekPlanEntry
export declare function withTaskStatusSet(
  entry: WeekPlanEntry,
  checklistId: string,
  status: WeekPlanMarkStatus | null,
): WeekPlanEntry
/** "Bring to this week": the task is on this week's list. */
export declare function withTaskBrought(entry: WeekPlanEntry, checklistId: string): WeekPlanEntry
/** "Put back": a brought task goes back to its own week; its days in this week are cleared. */
export declare function withTaskPutBack(entry: WeekPlanEntry, checklistId: string): WeekPlanEntry
/** "Push to next week": off this week's list, its days here cleared, a stale `brought` cleared. */
export declare function withTaskPushed(entry: WeekPlanEntry, checklistId: string): WeekPlanEntry
/** "Bring back to this week": undo a push. */
export declare function withTaskBroughtBack(entry: WeekPlanEntry, checklistId: string): WeekPlanEntry
/** A save from a page that does not know the two week flags: the stored flags are kept. */
export declare function withStoredWeekFlags(
  value: { weekStart: string; plannedDays: string[]; note: string; taskMarks: Record<string, WeekPlanMark> },
  stored: unknown,
  context?: { checklistIds?: Iterable<string> },
): { weekStart: string; plannedDays: string[]; note: string; taskMarks: Record<string, WeekPlanMark> }
export declare function isEmptyWeekPlanEntry(entry: {
  plannedDays?: string[]
  note?: string
  taskMarks?: Record<string, unknown>
} | null | undefined): boolean
export declare function normalizeWeekPlanInput(
  input: unknown,
  context?: { checklistIds?: Iterable<string> },
):
  | {
      ok: true
      value: {
        weekStart: string
        plannedDays: string[]
        note: string
        taskMarks: Record<string, WeekPlanMark>
      }
    }
  | { ok: false; error: string }
export declare function isOpenWorkFor(checklist: unknown, userId: string): boolean
export declare function taskWaitState(
  checklist: unknown,
  userId: string,
): { auto: 'answered' | 'questions' | null; waits: WeekPlanWait[] }
/** The soonest of the checklist's due date and its still-open steps' (hers only, when just a step is hers). */
export declare function taskDueFor(
  checklist: { assigneeId?: string; dueDate: string; items?: unknown[] },
  userId: string,
): string
export declare function buildWeekPlan(args: {
  checklists: unknown[]
  clients: Array<{ id: string; name: string }>
  entries?: unknown[]
  userId: string
  weekStart: string
  today: string
  /** Clients she just added on the page to plan work with no task. */
  extraClientIds?: string[]
}): WeekPlanView
