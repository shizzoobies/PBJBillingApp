/** Types for the plain-JS `lib/week-plan.js` (the server validates a save with it; the My Week page builds its view with it). */

export declare const WEEK_PLAN_NOTE_MAX: number
export declare const WEEK_PLAN_MARK_NOTE_MAX: number
export declare const WEEK_PLAN_MAX_MARKS: number
export declare const WEEK_PLAN_MARK_STATUSES: readonly ['questions', 'finished']

/** What a person can set on a task by hand. No mark means "Work on this week". */
export type WeekPlanMarkStatus = 'questions' | 'finished'
export type WeekPlanMark = { status: WeekPlanMarkStatus; note: string }

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
  stepsDone: number
  stepsTotal: number
  stageIndex: number | null
  stageCount: number | null
  caseId: string | null
  mine: 'checklist' | 'step'
  status: WeekPlanTaskStatus
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
}

export type WeekPlanView = {
  weekStart: string
  days: string[]
  dueThrough: string
  rows: WeekPlanRow[]
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
}): WeekPlanView
