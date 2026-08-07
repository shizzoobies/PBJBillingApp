import { groupChecklist } from './utils'
import type { Checklist } from './types'

/**
 * Per-client task counts for the Clients list: how much is still open, and how
 * much of that is late.
 *
 * Built on `groupChecklist` — the SAME bucketing the Checklists page uses for
 * its "Overdue" section — so a client's past-due count can never disagree with
 * what she'd see after clicking through. That helper reads
 * `effectiveChecklistDue`, which honors a per-step due date earlier than the
 * checklist's own, so a task with one late step counts as late here too.
 *
 * Soft-deleted checklists (recycle bin) are excluded: they are not work.
 */
export type ClientTaskCounts = {
  /** Open tasks — not fully checked off, not deleted. */
  active: number
  /** The subset of `active` whose effective due date is already past. */
  pastDue: number
}

export const EMPTY_CLIENT_TASK_COUNTS: ClientTaskCounts = { active: 0, pastDue: 0 }

/**
 * One pass over every checklist, keyed by client id — the list renders a row
 * per client, so counting per row would be quadratic over the same array.
 *
 * `pastDue` is a SUBSET of `active`, never a separate total. Showing "3 active,
 * 1 past due" has to mean one of those three is late, not four tasks in all.
 */
export function buildClientTaskCounts(
  checklists: Checklist[],
  todayDateOnly: string,
): Map<string, ClientTaskCounts> {
  const counts = new Map<string, ClientTaskCounts>()
  for (const checklist of checklists ?? []) {
    if (!checklist || checklist.deletedAt) continue
    const bucket = groupChecklist(checklist, todayDateOnly)
    // 'completed' means every step is checked off — done, so not outstanding.
    if (bucket === 'completed') continue
    const clientId = checklist.clientId
    if (!clientId) continue
    const current = counts.get(clientId) ?? { active: 0, pastDue: 0 }
    current.active += 1
    if (bucket === 'overdue') current.pastDue += 1
    counts.set(clientId, current)
  }
  return counts
}
