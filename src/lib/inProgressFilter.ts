import { clientName, effectiveChecklistDue } from './utils'
import { inactiveClientIdSet } from './clientLifecycle'
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
  /**
   * The `?focus=` checklist, admitted unconditionally.
   *
   * A jump has to land on the card or it silently does nothing, and the report
   * period is what usually swallows it: the default is the current month, so a
   * task jumped to from the pinned Overdue panel — past due by definition — is
   * routinely outside it. The alternative was widening the period on the user's
   * behalf, which is not this page's to widen: `reportPeriod` is a SHARED,
   * PERSISTED preference, and quietly turning it into a custom range breaks the
   * Timesheet's weekly submit/lock (`isSingleWeek` goes false) and survives a
   * reload. Exempting one transient row costs nothing and touches no
   * preference. The param self-clears after ~1.5s, so this is not a way to pin
   * a row into the list.
   */
  focusId?: string | null
}

export function filterInProgressChecklists(
  checklists: Checklist[],
  scope: InProgressScope,
): Checklist[] {
  const q = (scope.query ?? '').trim().toLowerCase()
  const clients = scope.clients ?? []
  // featreq-60f24838: a typed search must not surface a retired client's
  // checklists. Built once — the filter below runs per checklist.
  const retired = q ? inactiveClientIdSet(clients) : null

  return checklists.filter((checklist) => {
    // Ahead of every other narrowing: see `focusId` above.
    if (scope.focusId && checklist.id === scope.focusId) return true
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
      if (retired?.has(checklist.clientId)) return false
    }
    return true
  })
}
