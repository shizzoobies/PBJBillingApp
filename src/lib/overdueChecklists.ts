import type { Checklist } from './types'
import { effectiveChecklistDue, groupChecklist } from './utils'

/**
 * The one definition of "overdue" the Checklists page works from.
 *
 * INVARIANT: this and the "Overdue" group inside the In-progress list are the
 * SAME predicate — both are `groupChecklist(...) === 'overdue'`. The pinned
 * panel sits directly above a list that also labels work overdue; if the two
 * ever disagreed, the pin would be arguing with the page it is pinned to.
 * Anything that needs "is this overdue" on this page calls here rather than
 * re-deriving it.
 *
 * Overdue = not fully complete AND the EFFECTIVE due date (the soonest of the
 * task's own deadline and any still-open step's) is strictly before today. The
 * effective date is what makes a month-end task with a step due the 15th read
 * as late on the 16th.
 *
 * Two things this deliberately does NOT re-implement:
 *
 *   - Quiet skips. A skipped occurrence is dropped in ONE place, `App.tsx`'s
 *     `visibleChecklists`, and nowhere else — which is exactly what stops a
 *     skip ever reading as overdue. Re-checking `isChecklistSkipped` here would
 *     be a second copy of that rule, free to drift.
 *   - Viewer scope. `checklistsVisibleTo` has already narrowed the same list to
 *     the viewer's own work (owners see everything).
 *
 * So callers MUST pass `visibleChecklists`, never `data.checklists`.
 *
 * Not `boardChecklistStatus` (src/lib/activeBoard.ts) on purpose: the Board
 * demotes a blocked task to "pending" instead of "overdue", because a column
 * view is about what you can act on right now. A past-due task nobody has
 * chased is still late whether or not someone is waiting on a client, and the
 * Checklists page has always counted it that way.
 *
 * Oldest first — the thing that has been late longest is the thing to open.
 * Ties break on title so the order is stable across renders.
 */
export function overdueChecklists(
  checklists: readonly Checklist[],
  todayDateOnly: string,
): Checklist[] {
  return checklists
    .filter((checklist) => groupChecklist(checklist, todayDateOnly) === 'overdue')
    .sort(
      (a, b) =>
        effectiveChecklistDue(a).localeCompare(effectiveChecklistDue(b)) ||
        a.title.localeCompare(b.title),
    )
}
