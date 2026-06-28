/**
 * Pure ordering + copy-formatting helpers for the owner-only "Updates" page.
 *
 * Kept side-effect-free (no DOM, no clipboard) so they're unit-testable. The
 * page calls these and then writes the result to the clipboard itself.
 */
import type { FeatureRequest, FeatureRequestStatus } from './types'

/** Human label for an update's type, used in the copy block header. */
const TYPE_LABELS: Record<FeatureRequest['type'], string> = {
  feature: 'Feature',
  bug: 'Bug',
  improvement: 'Improvement',
}

/** Statuses considered "closed" — excluded from the prioritized backlog copy. */
const CLOSED_STATUSES: ReadonlySet<FeatureRequestStatus> = new Set<FeatureRequestStatus>([
  'done',
  'wont_do',
])

/**
 * Sort updates urgent-first, then by priority rank (ascending), then by
 * created-at (ascending) as a stable tiebreaker. Returns a new array.
 */
export function sortFeatureRequests(items: FeatureRequest[]): FeatureRequest[] {
  return [...items].sort(
    (a, b) =>
      Number(b.urgent) - Number(a.urgent) ||
      a.priorityRank - b.priorityRank ||
      a.createdAt.localeCompare(b.createdAt),
  )
}

/**
 * Format a single update as a markdown block ready to paste into Claude Code.
 *
 *   ## [Bug] <title>  (priority: Urgent)        // urgent
 *   ## [Feature] <title>  (priority: #3)        // otherwise, #<rank+1>
 *   <description>
 *   Notes: <devNotes>                           // omitted when empty
 *
 * `rank` is the 0-based display position (its index in the sorted backlog);
 * the header shows `#<rank + 1>`. When omitted, non-urgent items use
 * `priorityRank + 1`.
 */
export function formatRequestForClaude(item: FeatureRequest, rank?: number): string {
  const label = TYPE_LABELS[item.type] ?? 'Feature'
  const position = typeof rank === 'number' ? rank + 1 : item.priorityRank + 1
  const priority = item.urgent ? 'Urgent' : `#${position}`
  const lines = [`## [${label}] ${item.title.trim()}  (priority: ${priority})`]
  const description = item.description.trim()
  if (description) lines.push(description)
  const notes = (item.devNotes ?? '').trim()
  if (notes) lines.push(`Notes: ${notes}`)
  return lines.join('\n')
}

/**
 * Format the whole OPEN backlog (excludes Done / Won't do) as a numbered,
 * sorted markdown list for pasting into Claude Code. Each item is numbered by
 * its position in the sorted open list.
 */
export function formatBacklogForClaude(items: FeatureRequest[]): string {
  const open = sortFeatureRequests(items).filter((item) => !CLOSED_STATUSES.has(item.status))
  return open
    .map((item, index) => `${index + 1}. ${formatRequestForClaude(item, index)}`)
    .join('\n\n')
}
