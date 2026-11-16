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

export type WeekPlanTaskStatus = 'not_planned' | 'planned' | WeekPlanMarkStatus

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
  markNote: string
}

export type WeekPlanRow = {
  clientId: string
  clientName: string
  plannedDays: string[]
  note: string
  tasks: WeekPlanTask[]
  rollup: { planned: number; notPlanned: number; questions: number; finished: number }
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
}

export type WeekPlanView = {
  weekStart: string
  days: string[]
  dueThrough: string
  rows: WeekPlanRow[]
  notPlannedCount: number
  questions: WeekPlanQuestion[]
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
