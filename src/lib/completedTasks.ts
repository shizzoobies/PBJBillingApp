import { isChecklistItemDone } from './utils'
import { openTaskAssigneeScope, scopeChecklistsToOpenTaskOwners } from './openTaskScope'
import type { Checklist, Client } from './types'

/**
 * The Completed tasks tab's data.
 *
 * Completed work never moved anywhere: a finished checklist stays in the
 * `checklists` table and is only filtered out of the active views. So this is a
 * VIEW over the same list every other tab reads, not a separate archive.
 *
 * What did NOT exist until recently is the audit trail — `checklist_items.done`
 * was a bare boolean with no timestamp. Rows completed before
 * `checklist_items.completed_at` shipped therefore have no date and were NOT
 * backfilled: a fabricated date on an audit screen is worse than an honest gap.
 * `completedAt: null` is how that is carried here, and the UI renders it as a
 * placeholder.
 */
export type CompletedTaskRow = {
  checklistId: string
  title: string
  clientId: string
  /**
   * Who is on the hook for the task. The toggle endpoint requires the step's own
   * responsible person, so this is who completed it — but note it is the
   * RESPONSIBLE person, not a separately recorded actor. Nothing stores the
   * clicking user id per item.
   */
  assigneeId: string
  /** ISO timestamp of the last step completed, or null when unrecorded. */
  completedAt: string | null
}

/** A checklist counts as completed when it has steps and every one is done. */
export function isChecklistComplete(checklist: Checklist): boolean {
  const items = checklist.items ?? []
  if (items.length === 0) return false
  return items.every((item) => isChecklistItemDone(item))
}

/**
 * The moment a task finished: the LAST of its steps' completion stamps. Null
 * when no step carries one — a partially-stamped task (some steps completed
 * before the column existed, some after) still reports the real latest stamp,
 * which is the moment the task as a whole became complete.
 */
export function checklistCompletedAt(checklist: Checklist): string | null {
  let latest: string | null = null
  for (const item of checklist.items ?? []) {
    const stamp = item.completedAt
    if (!stamp) continue
    if (!latest || stamp > latest) latest = stamp
  }
  return latest
}

/**
 * Whose completed tasks a viewer may see.
 *
 * Deliberately the SAME rule as the open-task badge (`openTaskAssigneeScope`):
 * an employee sees their own, an Accountant additionally sees the people staffed
 * on the clients they are assigned to, the owner sees everything. Reusing it
 * means there is one definition of "their bookkeepers" in the app rather than
 * two that can drift apart.
 *
 * The server has already narrowed `checklists` to the viewer's clients, so this
 * only ever removes rows.
 */
export function completedTaskRows({
  checklists,
  viewerId,
  isOwner,
  staffRole,
  clients,
}: {
  checklists: Checklist[]
  viewerId: string
  isOwner: boolean
  staffRole?: string
  clients: Client[]
}): CompletedTaskRow[] {
  const scope = openTaskAssigneeScope({ viewerId, isOwner, staffRole, clients })
  const scoped = scopeChecklistsToOpenTaskOwners(
    (checklists ?? []).filter((checklist) => !checklist.deletedAt && isChecklistComplete(checklist)),
    scope,
  )

  return scoped
    .map((checklist) => ({
      checklistId: checklist.id,
      title: checklist.title,
      clientId: checklist.clientId,
      assigneeId: checklist.assigneeId ?? '',
      completedAt: checklistCompletedAt(checklist),
    }))
    .sort(sortNewestFirst)
}

/**
 * Newest first. Undated rows sort LAST rather than first: they are the oldest
 * work in the system (they predate the timestamp), so putting them at the top
 * would bury the recent history the tab exists to show. Ties break on title so
 * the order is stable between renders.
 */
function sortNewestFirst(a: CompletedTaskRow, b: CompletedTaskRow): number {
  if (a.completedAt && b.completedAt) {
    if (a.completedAt === b.completedAt) return a.title.localeCompare(b.title)
    return a.completedAt < b.completedAt ? 1 : -1
  }
  if (a.completedAt) return -1
  if (b.completedAt) return 1
  return a.title.localeCompare(b.title)
}

/**
 * Client / person / date-range narrowing. Empty values mean "no filter".
 * The date range is compared on the DATE part of the stamp so a `to` of
 * 2026-08-14 includes everything completed that day. Undated rows are dropped
 * as soon as either end of the range is set — there is no honest way to decide
 * whether an unknown date falls inside a window.
 */
export function filterCompletedTaskRows(
  rows: CompletedTaskRow[],
  filters: { clientId?: string; assigneeId?: string; from?: string; to?: string },
): CompletedTaskRow[] {
  const { clientId, assigneeId, from, to } = filters
  return rows.filter((row) => {
    if (clientId && row.clientId !== clientId) return false
    if (assigneeId && row.assigneeId !== assigneeId) return false
    if (from || to) {
      if (!row.completedAt) return false
      const day = row.completedAt.slice(0, 10)
      if (from && day < from) return false
      if (to && day > to) return false
    }
    return true
  })
}
