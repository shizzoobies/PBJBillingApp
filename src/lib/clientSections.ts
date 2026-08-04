/**
 * The four tabs of the client detail page: Overview / Billing / Checklists /
 * Time.
 *
 * The page used to be one long stacked scroll of a dozen panels with a sticky
 * "jump to section" pill bar on top of it. The ask was to put *everything* for
 * a client on that client's page, which only works if the page stops being a
 * scroll — so the panels are grouped into four tabs, and a per-client Time view
 * joins them.
 *
 * The resolution rules live here (rather than inline in the page) for the same
 * reason `approvalSections.ts` and `taskAreas.ts` do: a tab that is not open is
 * not MOUNTED, so a deep link that fails to select the right tab looks like a
 * dead link rather than an error. Two things can break silently:
 *
 *  - Every `#client-section-…` anchor that the old jump-nav scrolled to still
 *    exists in the markup, but only inside its own tab. `CLIENT_SECTION_LEGACY_
 *    ANCHORS` maps each one to the tab that now holds it.
 *  - Staff never get the Billing tab (every panel in it is owner-only). A
 *    `?tab=billing` link forwarded to a bookkeeper must fall back to Overview,
 *    NOT render an empty tab — hence `available`.
 *
 * Nothing here decides what a role may see; the page still wraps owner-only
 * panels in the same `ownerMode` guards they always had. This only decides
 * which tab opens.
 */

import type { Checklist, TimeEntry } from './types'
import { deriveChecklistStatus } from './utils'

export type ClientSection = 'overview' | 'billing' | 'checklists' | 'time'

/** Tab order. Overview is first, and is the default. */
export const CLIENT_SECTION_KEYS: ClientSection[] = ['overview', 'billing', 'checklists', 'time']

/** Anchor id rendered on each tab panel, so `#client-tab-time` works as a link. */
export const CLIENT_SECTION_ANCHORS: Record<ClientSection, string> = {
  overview: 'client-tab-overview',
  billing: 'client-tab-billing',
  checklists: 'client-tab-checklists',
  time: 'client-tab-time',
}

/**
 * The per-panel anchor ids the page has always rendered, mapped to the tab that
 * now contains them. These are what an existing `#client-section-invoice` style
 * link points at.
 */
export const CLIENT_SECTION_LEGACY_ANCHORS: Record<string, ClientSection> = {
  'client-section-profile': 'overview',
  'client-section-contacts': 'overview',
  'client-section-team': 'overview',
  'client-section-branding': 'overview',
  'client-section-notes': 'overview',
  'client-section-billing': 'billing',
  'client-section-plan-checklists': 'billing',
  'client-section-expenses': 'billing',
  'client-section-invoice': 'billing',
  'client-section-checklists': 'checklists',
  'client-section-recurring': 'checklists',
  'client-section-activity': 'checklists',
  'client-section-time': 'time',
}

function asSection(value: string | null | undefined): ClientSection | null {
  return CLIENT_SECTION_KEYS.includes(value as ClientSection) ? (value as ClientSection) : null
}

/**
 * Which tab to open, in priority order:
 *
 * 1. `?tab=` when it names a tab this viewer actually has — an explicit click
 *    always wins, which is why the page WRITES this param even for Overview.
 * 2. A `#anchor`: a tab anchor, a legacy per-panel anchor, or a bare tab key.
 * 3. Overview.
 *
 * Anything naming a tab the viewer does not have (staff + `billing`) is treated
 * as if it named nothing, so they land on Overview instead of an empty page.
 *
 * Derived from the URL on every render rather than mirrored into state, so a
 * link that arrives after mount still wins and there is no post-paint flash.
 */
export function resolveClientSection(params: {
  tabParam?: string | null
  hash?: string | null
  /** Tabs this viewer has, in tab order. Defaults to all of them. */
  available?: ClientSection[]
}): ClientSection {
  const available =
    params.available && params.available.length > 0 ? params.available : CLIENT_SECTION_KEYS
  const allow = (section: ClientSection | null | undefined): ClientSection | null =>
    section && available.includes(section) ? section : null

  const explicit = allow(asSection(params.tabParam))
  if (explicit) return explicit

  const hash = (params.hash ?? '').replace(/^#/, '')
  if (hash) {
    const byTabAnchor = CLIENT_SECTION_KEYS.find((key) => CLIENT_SECTION_ANCHORS[key] === hash)
    const resolved =
      allow(byTabAnchor) ?? allow(CLIENT_SECTION_LEGACY_ANCHORS[hash]) ?? allow(asSection(hash))
    if (resolved) return resolved
  }

  return available[0]
}

/**
 * The checklists the Checklists tab lists as "Active" for one client: this
 * client's, not deleted, not finished. Shared with the tab's count so the
 * number on the tab and the rows under it can never disagree — the Checklists
 * page shipped a count derived from a different filter once, and it read as a
 * bug every time the two diverged.
 */
export function activeChecklistsForClient(
  checklists: Checklist[],
  clientId: string,
  today: string,
): Checklist[] {
  return checklists.filter(
    (entry) =>
      entry.clientId === clientId &&
      !entry.deletedAt &&
      deriveChecklistStatus(entry, today) !== 'Done',
  )
}

export type ClientMonthTime = {
  trackedMinutes: number
  billableMinutes: number
  entryCount: number
}

/**
 * This client's time for one month (`YYYY-MM`), from whatever entries the
 * viewer already holds — a bookkeeper's `/api/app-data` is scoped to their own
 * entries, so this summarizes exactly the rows listed beneath it and nothing
 * more. `entryCount` is what the Time tab's count label shows.
 */
export function summarizeClientMonthTime(
  entries: TimeEntry[],
  clientId: string,
  month: string,
): ClientMonthTime {
  let trackedMinutes = 0
  let billableMinutes = 0
  let entryCount = 0
  for (const entry of entries) {
    if (entry.clientId !== clientId) continue
    if (!entry.date.startsWith(month)) continue
    entryCount += 1
    trackedMinutes += entry.minutes
    if (entry.billable) billableMinutes += entry.minutes
  }
  return { trackedMinutes, billableMinutes, entryCount }
}
