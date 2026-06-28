/**
 * Pure ordering + copy-formatting helpers for the owner-only "Updates" page.
 *
 * Kept side-effect-free (no DOM, no clipboard) so they're unit-testable. The
 * page calls these and then writes the result to the clipboard itself.
 */
import type { FeatureRequest, FeatureRequestPriority, FeatureRequestStatus } from './types'

/** Human label for an update's type, used in the copy block header. */
const TYPE_LABELS: Record<FeatureRequest['type'], string> = {
  feature: 'Feature',
  bug: 'Bug',
  improvement: 'Improvement',
}

/** Display labels for each priority level. */
export const PRIORITY_LABELS: Record<FeatureRequestPriority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

/** Sort weight per priority level — lower groups nearer the top. */
export const PRIORITY_ORDER: Record<FeatureRequestPriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
}

/** Weight for an item's priority level (unknown → medium). */
export function priorityWeight(priority: FeatureRequestPriority): number {
  return PRIORITY_ORDER[priority] ?? PRIORITY_ORDER.medium
}

/** Statuses considered "closed" — excluded from the prioritized backlog copy. */
const CLOSED_STATUSES: ReadonlySet<FeatureRequestStatus> = new Set<FeatureRequestStatus>([
  'done',
  'wont_do',
])

/**
 * Sort updates by priority level first (Urgent → High → Medium → Low), then by
 * priority rank (ascending) WITHIN a level, then by created-at (ascending) as a
 * stable tiebreaker. So "the last Urgent sits above the first High." Returns a
 * new array.
 */
export function sortFeatureRequests(items: FeatureRequest[]): FeatureRequest[] {
  return [...items].sort(
    (a, b) =>
      priorityWeight(a.priority) - priorityWeight(b.priority) ||
      a.priorityRank - b.priorityRank ||
      a.createdAt.localeCompare(b.createdAt),
  )
}

/**
 * Format a single update as a markdown block ready to paste into Claude Code.
 *
 *   ## [Bug] <title>  (priority: High)
 *   <description>
 *   Notes: <devNotes>                           // omitted when empty
 */
export function formatRequestForClaude(item: FeatureRequest): string {
  const label = TYPE_LABELS[item.type] ?? 'Feature'
  const priority = PRIORITY_LABELS[item.priority] ?? PRIORITY_LABELS.medium
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
    .map((item, index) => `${index + 1}. ${formatRequestForClaude(item)}`)
    .join('\n\n')
}
