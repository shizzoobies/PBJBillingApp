/**
 * The three sections of the Time Approvals page: Weekly submissions /
 * Approval queue / Timesheet locks.
 *
 * They used to be stacked, so signing off a month meant scrolling past every
 * submitted week AND every pending entry — in production that is a very long
 * page. Each is now one click away, using the same tab treatment the Checklists
 * page ships (see `taskAreas.ts`, whose deep-link reasoning applies here too).
 *
 * Only the navigation changed: every section still renders exactly as it did,
 * and no approval behavior lives in this file.
 */

export type ApprovalSection = 'weekly' | 'queue' | 'locks'

export const APPROVAL_SECTION_KEYS: ApprovalSection[] = ['weekly', 'queue', 'locks']

/**
 * Anchor ids kept on each section so an existing `#…` link still lands on the
 * right tab now that the sections aren't all mounted at once. Nothing links
 * here with a hash today (the server's notification link is a bare
 * `/time-approvals`), so this is insurance against a link that already exists
 * in someone's email silently doing nothing.
 */
export const APPROVAL_SECTION_ANCHORS: Record<ApprovalSection, string> = {
  weekly: 'weekly-submissions',
  queue: 'approval-queue',
  locks: 'timesheet-locks',
}

function asSection(value: string | null | undefined): ApprovalSection | null {
  return APPROVAL_SECTION_KEYS.includes(value as ApprovalSection)
    ? (value as ApprovalSection)
    : null
}

/**
 * Which section to open, in priority order:
 *
 * 1. `?section=` when it names a real section — an explicit click always wins,
 *    which is why the page WRITES this param even for the section that would
 *    have been the default. Without it, clicking a quiet tab would bounce you
 *    straight back to whichever one happens to have pending work.
 * 2. A `#anchor` (or `#section-key`) naming a section.
 * 3. The first section that has pending work — landing on an empty tab while
 *    another one has a queue is exactly the scrolling problem this replaced.
 * 4. The first section.
 *
 * Derived from the URL on every render rather than mirrored into state, so a
 * link that arrives after mount still wins and there is no post-paint flash.
 */
export function resolveApprovalSection(params: {
  sectionParam?: string | null
  hash?: string | null
  counts?: Record<ApprovalSection, number>
}): ApprovalSection {
  const explicit = asSection(params.sectionParam)
  if (explicit) return explicit

  const hash = (params.hash ?? '').replace(/^#/, '')
  if (hash) {
    const byAnchor = APPROVAL_SECTION_KEYS.find(
      (key) => APPROVAL_SECTION_ANCHORS[key] === hash,
    )
    if (byAnchor) return byAnchor
    const byKey = asSection(hash)
    if (byKey) return byKey
  }

  const counts = params.counts
  if (counts) {
    const firstWithWork = APPROVAL_SECTION_KEYS.find((key) => (counts[key] ?? 0) > 0)
    if (firstWithWork) return firstWithWork
  }

  return APPROVAL_SECTION_KEYS[0]
}
