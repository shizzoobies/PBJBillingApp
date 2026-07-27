import { UNCATEGORIZED_ID, UNCATEGORIZED_NAME } from './activeBoard'
import type { Checklist, ServiceCategory } from './types'

/**
 * Service-category tabs for the Checklists page.
 *
 * The page's top level is a tab per service category — the same set that forms
 * the Board's columns. The point of tabs over the previous accordion is the
 * COUNTS: an accordion only ever tells you the size of what you already opened,
 * so you cannot see the shape of the workload without clicking through it.
 *
 * Kept here rather than inline in the component so the bucketing and the
 * landing-tab rules can be tested directly, the way the rest of this repo's
 * grouping logic is (see checklist-grouping.test.ts).
 */

export type CategoryTab = {
  key: string
  label: string
  count: number
}

/**
 * Which tab a checklist belongs in.
 *
 * An id pointing at a category that no longer exists resolves to Uncategorized,
 * matching `buildActiveBoard`'s `knownIds` check. This is not defensive
 * decoration: deleting a category leaves its `category_id` on every checklist
 * that referenced it (the Board's own delete copy says the checklists "move to
 * an Uncategorized column"), so without it those checklists would match no tab
 * and silently vanish from the page.
 */
export function categoryKeyFor(
  categoryId: string | null | undefined,
  knownIds: Set<string>,
): string {
  return categoryId && knownIds.has(categoryId) ? categoryId : UNCATEGORIZED_ID
}

/**
 * Build the tab list, in Board column order, with a count each.
 *
 * Real categories ALWAYS keep their tab, even at zero — an empty tab is real
 * signal ("nothing is due in Payroll this period"), the same reasoning the
 * Updates page uses. "Uncategorized" is the exception: it is an absence rather
 * than a category, so an empty one says nothing and is omitted. That also
 * mirrors the Board, which only appends its Uncategorized column when it has
 * something in it.
 */
export function buildCategoryTabs(
  checklists: Checklist[],
  categories: ServiceCategory[],
): CategoryTab[] {
  const knownIds = new Set(categories.map((category) => category.id))
  const counts = new Map<string, number>()
  for (const checklist of checklists) {
    const key = categoryKeyFor(checklist.categoryId, knownIds)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  const tabs: CategoryTab[] = [...categories]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map((category) => ({
      key: category.id,
      label: category.name,
      count: counts.get(category.id) ?? 0,
    }))

  const uncategorized = counts.get(UNCATEGORIZED_ID) ?? 0
  if (uncategorized > 0) {
    tabs.push({ key: UNCATEGORIZED_ID, label: UNCATEGORIZED_NAME, count: uncategorized })
  }
  return tabs
}

/**
 * The tab to open, in priority order:
 *
 * 1. A `?focus=` checklist's category — deep links (a notification, "show me
 *    the task I just made") must be able to cross tabs, or they scroll to an
 *    element that was never rendered and appear to do nothing.
 * 2. The `?cat=` URL param, when it still names a real tab.
 * 3. The FULLEST tab.
 *
 * Rule 3 is deliberately not "the first tab". Against production the first tab
 * in Board order holds 2 open checklists while 300 of ~554 are Uncategorized —
 * so defaulting to first would drop the owner onto a near-empty view with the
 * bulk of the work hidden. Ties break by tab order, so it stays deterministic.
 *
 * The final fallback also covers a `?cat=` naming a category that has since
 * been deleted or emptied out of existence, so a stale link cannot strand
 * someone on a tab that no longer exists.
 */
export function resolveActiveCategory({
  tabs,
  focusedKey = null,
  param = null,
}: {
  tabs: CategoryTab[]
  focusedKey?: string | null
  param?: string | null
}): string {
  if (focusedKey && tabs.some((tab) => tab.key === focusedKey)) return focusedKey
  if (param && tabs.some((tab) => tab.key === param)) return param

  let best: CategoryTab | undefined
  for (const tab of tabs) {
    if (!best || tab.count > best.count) best = tab
  }
  return best?.key ?? UNCATEGORIZED_ID
}
