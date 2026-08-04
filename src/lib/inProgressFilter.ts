import { clientName, effectiveChecklistDue } from './utils'
import { isInReportPeriod, type ReportPeriod } from './reportPeriod'
import type { Checklist, Client } from './types'

/**
 * Filter-bar status bucket for a checklist. Moved here from ChecklistsPage so
 * the page and the tab count share one definition rather than two that can
 * drift apart.
 */
export function statusForChecklist(checklist: Checklist, todayDateOnly: string) {
  const completed = checklist.items.filter((item) => item.done).length
  const total = checklist.items.length
  const allDone = total > 0 && completed === total
  if (allDone) return 'completed'
  if (checklist.dueDate < todayDateOnly) return 'overdue'
  return 'active'
}

/**
 * The scope of the "In progress" list: report period + filter bar (+ optional
 * search text).
 *
 * Extracted so the TAB COUNT and the LIST cannot disagree. They did: the count
 * was `visibleChecklists.length` (an unfiltered total) while the list applied
 * the report period and filters, so with a one-day custom report period the tab
 * read "568" above a body showing 13. A count that contradicts what is beneath
 * it is worse than no count at all.
 */
export type InProgressScope = {
  reportPeriod: ReportPeriod
  /** Filter-bar assignee id, '' for All. */
  assignee?: string
  /** Filter-bar client id, '' for All. */
  client?: string
  /** Filter-bar status, '' or 'all' for All. */
  status?: string
  /** yyyy-mm-dd, for the status buckets. */
  today: string
  /**
   * Free-text search. Deliberately OPTIONAL, and deliberately excluded from the
   * tab count: the search box reports its own "N of M", and a tab count that
   * moved on every keystroke would be noise rather than signal.
   */
  query?: string
  /** Needed only to match the query against client names. */
  clients?: Client[]
}

export function filterInProgressChecklists(
  checklists: Checklist[],
  scope: InProgressScope,
): Checklist[] {
  const q = (scope.query ?? '').trim().toLowerCase()
  const clients = scope.clients ?? []

  return checklists.filter((checklist) => {
    if (!isInReportPeriod(effectiveChecklistDue(checklist), scope.reportPeriod)) return false
    if (scope.assignee && checklist.assigneeId !== scope.assignee) return false
    if (scope.client && checklist.clientId !== scope.client) return false
    if (scope.status && scope.status !== 'all') {
      if (statusForChecklist(checklist, scope.today) !== scope.status) return false
    }
    if (q) {
      const nameMatch = clientName(clients, checklist.clientId).toLowerCase().includes(q)
      const titleMatch = checklist.title.toLowerCase().includes(q)
      if (!nameMatch && !titleMatch) return false
    }
    return true
  })
}
