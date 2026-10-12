import type { Checklist, TaskReportRow, TimeEntry } from './types'

/** The grouping key of the synthetic "Unassigned" row. */
export const UNASSIGNED_KEY = '__unassigned__'

/**
 * The Reports page's "Hours by task" rows: minutes summed per task, most first.
 *
 * - An entry attached to a checklist (`taskId`) groups under that checklist,
 *   exactly as before — one row per checklist id, titled by the checklist.
 * - An entry with no checklist but a typed task (`taskLabel` — a standard task
 *   such as "Payroll", or the person's own words; every group timer carries
 *   one since 2026-10-08) groups by that name: trimmed, matched without regard
 *   to case, shown in the casing first seen. Before featreq-e413267a these all
 *   fell under Unassigned although the Time lists, approvals and the Raw/detail
 *   reports already showed the task (see `taskTitleFor` in `./utils`).
 * - An entry with neither stays under the synthetic "Unassigned" row.
 *
 * `key` is unique per row (the React key and the grouping key), since typed-task
 * rows and Unassigned all have `taskId === null`.
 */
export function groupHoursByTask(entries: TimeEntry[], checklists: Checklist[]): TaskReportRow[] {
  const titles = new Map(checklists.map((checklist) => [checklist.id, checklist.title]))
  const totals = new Map<string, TaskReportRow>()

  for (const entry of entries) {
    const taskId = entry.taskId || null
    const label = entry.taskLabel?.trim() ?? ''
    let key: string
    let taskTitle: string
    if (taskId) {
      key = `task:${taskId}`
      taskTitle = titles.get(taskId) ?? 'Unassigned'
    } else if (label) {
      key = `label:${label.toLowerCase()}`
      taskTitle = label
    } else {
      key = UNASSIGNED_KEY
      taskTitle = 'Unassigned'
    }

    const row = totals.get(key) ?? { key, taskId, taskTitle, minutes: 0, entryCount: 0 }
    row.minutes += entry.minutes
    row.entryCount += 1
    totals.set(key, row)
  }

  return [...totals.values()].sort((left, right) => right.minutes - left.minutes)
}

