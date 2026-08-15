import type { DelayedTab } from '../../lib/waiting-on-state.js'

/**
 * The Delayed page's two halves. Her words, featreq-b05a2f3a: "maybe a waiting
 * on me and a I am waiting on others tabs within delayed to keep it organized."
 *
 * Same treatment as the approvals page and the month run — the shared
 * `.task-area-tabs` underline bar — and the same resolution rules as
 * {@link resolveApprovalSection}, which this deliberately mirrors rather than
 * reinvents. Nothing about which waits go where lives here; that is
 * `waitingOnDelayedTab` in `lib/waiting-on-state.js`, shared with the server's
 * own state machine.
 */

export const DELAYED_TAB_KEYS: DelayedTab[] = ['blocking', 'requesting']

export const DELAYED_TAB_LABELS: Record<DelayedTab, string> = {
  blocking: 'Waiting on me',
  requesting: "I'm waiting on others",
}

function asTab(value: string | null | undefined): DelayedTab | null {
  return DELAYED_TAB_KEYS.includes(value as DelayedTab) ? (value as DelayedTab) : null
}

/**
 * Which tab to open, in priority order:
 *
 * 1. `?tab=` when it names a real tab — an explicit click always wins, which is
 *    why the page WRITES this param even for the tab that would have been the
 *    default. Without it, clicking a quiet tab would bounce you straight back
 *    to whichever one happens to have work in it.
 * 2. The first tab that has work. "Waiting on me" comes first because it is the
 *    one with a button on it; landing on a read-only reminder list while
 *    somebody is blocked on you is exactly backwards.
 * 3. The first tab.
 *
 * Derived from the URL on every render rather than mirrored into state, so a
 * link that arrives after mount still wins and there is no post-paint flash.
 */
export function resolveDelayedTab(params: {
  tabParam?: string | null
  counts?: Record<DelayedTab, number>
}): DelayedTab {
  const explicit = asTab(params.tabParam)
  if (explicit) return explicit

  const counts = params.counts
  if (counts) {
    const firstWithWork = DELAYED_TAB_KEYS.find((key) => (counts[key] ?? 0) > 0)
    if (firstWithWork) return firstWithWork
  }

  return DELAYED_TAB_KEYS[0]
}
