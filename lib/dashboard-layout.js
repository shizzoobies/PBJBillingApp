/**
 * Per-user Dashboard layout (2026-10-27): which panels show, in what order,
 * and whether each one starts open or collapsed.
 *
 * Stored on `users.dashboard_layout` (jsonb, NULL = the default layout) as
 *   { version: 1, panels: [{ key, hidden, collapsed }, ...] }   (in order)
 *
 * One cleaner for every reader and writer: the PUT route cleans what the
 * browser sends, the GET route cleans what is stored, and the Dashboard cleans
 * what it is handed. So a stored layout from an older build (a panel that has
 * since been removed, one added after it was saved) can never break the page.
 *
 * The rules:
 *   - an unknown key is dropped, and so is a second copy of a key;
 *   - a panel the stored layout does not name is appended, open and shown, in
 *     its default order (a panel added later turns up rather than vanishing);
 *   - Alerts is always first, never hidden and never collapsed: it carries the
 *     overdue / due-this-week / stuck counts, the one panel that must not be
 *     arranged out of sight;
 *   - anything that is not version 1 (or not a layout at all) is the default.
 *
 * The owner's Dashboard and a staff member's are different pages with
 * different panels, so every function takes the VIEW ('owner' | 'staff').
 */

export const DASHBOARD_LAYOUT_VERSION = 1

/** The panel that is pinned first and always shown, on both views. */
export const PINNED_DASHBOARD_PANEL = 'alerts'

/** Each view's panels, in their default order. The keys are stored: never rename one. */
export const DASHBOARD_PANELS = {
  owner: [
    { key: 'alerts', label: 'Alerts' },
    { key: 'queue', label: 'Your queue' },
    { key: 'team', label: 'Team' },
    { key: 'cases', label: 'Cases in flight' },
    { key: 'skipped', label: 'Skipped and pushed tasks to review' },
    { key: 'past_due', label: 'Invoices past due' },
    { key: 'activity', label: 'Recent activity' },
    { key: 'kpi', label: 'This month at a glance' },
  ],
  staff: [
    { key: 'alerts', label: 'Alerts' },
    { key: 'waiting', label: 'Waiting on you' },
    { key: 'my_queue', label: 'My queue' },
    { key: 'watching', label: 'Watching' },
    { key: 'my_cases', label: 'My cases in flight' },
    { key: 'my_activity', label: 'My recent activity' },
    { key: 'my_kpi', label: 'My month at a glance' },
  ],
}

/** Most entries a stored or sent layout is read for; the rest is ignored. */
const MAX_PANEL_ENTRIES = 50

/** The owner's own Dashboard is the owner view; everyone else's is the staff view. */
export function dashboardViewForRole(role) {
  return role === 'owner' ? 'owner' : 'staff'
}

function viewOrStaff(view) {
  return view === 'owner' ? 'owner' : 'staff'
}

/** The view's panel keys, in default order. */
export function dashboardPanelKeys(view) {
  return DASHBOARD_PANELS[viewOrStaff(view)].map((panel) => panel.key)
}

/** Every panel shown and open, in the default order. */
export function defaultDashboardLayout(view) {
  return {
    version: DASHBOARD_LAYOUT_VERSION,
    panels: dashboardPanelKeys(view).map((key) => ({ key, hidden: false, collapsed: false })),
  }
}

/** The cleaned layout (see the rules at the top). Never throws; junk reads as the default. */
export function sanitizeDashboardLayout(raw, view) {
  const keys = dashboardPanelKeys(view)
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    raw.version !== DASHBOARD_LAYOUT_VERSION ||
    !Array.isArray(raw.panels)
  ) {
    return defaultDashboardLayout(view)
  }
  const allowed = new Set(keys)
  const seen = new Set()
  const panels = []
  for (const entry of raw.panels.slice(0, MAX_PANEL_ENTRIES)) {
    if (!entry || typeof entry !== 'object') continue
    const key = entry.key
    if (typeof key !== 'string' || !allowed.has(key) || seen.has(key)) continue
    seen.add(key)
    panels.push({ key, hidden: entry.hidden === true, collapsed: entry.collapsed === true })
  }
  for (const key of keys) {
    if (!seen.has(key)) panels.push({ key, hidden: false, collapsed: false })
  }
  const rest = panels.filter((panel) => panel.key !== PINNED_DASHBOARD_PANEL)
  return {
    version: DASHBOARD_LAYOUT_VERSION,
    panels: [{ key: PINNED_DASHBOARD_PANEL, hidden: false, collapsed: false }, ...rest],
  }
}

/** True when the layout is the default one (the store then keeps NULL). */
export function isDefaultDashboardLayout(layout, view) {
  const clean = sanitizeDashboardLayout(layout, view)
  const fallback = defaultDashboardLayout(view)
  return clean.panels.every((panel, index) => {
    const other = fallback.panels[index]
    return panel.key === other.key && panel.hidden === other.hidden && panel.collapsed === other.collapsed
  })
}

/**
 * Move one panel a place up (-1) or down (+1). Alerts never moves and nothing
 * moves above it; a move past either end is no change. Returns a new layout.
 */
export function moveDashboardPanel(layout, key, direction, view) {
  const clean = sanitizeDashboardLayout(layout, view)
  const panels = clean.panels.slice()
  const from = panels.findIndex((panel) => panel.key === key)
  const to = from + (direction < 0 ? -1 : 1)
  if (from <= 0 || to <= 0 || to >= panels.length) return clean
  ;[panels[from], panels[to]] = [panels[to], panels[from]]
  return { ...clean, panels }
}

/** Change one panel's `hidden` or `collapsed`. Alerts keeps both false. Returns a new layout. */
export function setDashboardPanelFlag(layout, key, flag, value, view) {
  const clean = sanitizeDashboardLayout(layout, view)
  if (key === PINNED_DASHBOARD_PANEL || (flag !== 'hidden' && flag !== 'collapsed')) return clean
  return {
    ...clean,
    panels: clean.panels.map((panel) => (panel.key === key ? { ...panel, [flag]: value === true } : panel)),
  }
}
