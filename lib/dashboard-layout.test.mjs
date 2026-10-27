import { describe, expect, it } from 'vitest'
import {
  DASHBOARD_PANELS,
  dashboardPanelKeys,
  dashboardViewForRole,
  defaultDashboardLayout,
  isDefaultDashboardLayout,
  moveDashboardPanel,
  sanitizeDashboardLayout,
  setDashboardPanelFlag,
} from './dashboard-layout.js'

const OWNER_KEYS = ['alerts', 'queue', 'team', 'cases', 'skipped', 'past_due', 'activity', 'kpi']
const STAFF_KEYS = ['alerts', 'waiting', 'my_queue', 'watching', 'my_cases', 'my_activity', 'my_kpi']

const keysOf = (layout) => layout.panels.map((panel) => panel.key)
const panel = (key, over = {}) => ({ key, hidden: false, collapsed: false, ...over })

describe('the two views and their default layouts', () => {
  it('lists each view’s panels in today’s order', () => {
    expect(dashboardPanelKeys('owner')).toEqual(OWNER_KEYS)
    expect(dashboardPanelKeys('staff')).toEqual(STAFF_KEYS)
    expect(DASHBOARD_PANELS.owner.find((entry) => entry.key === 'past_due').label).toBe('Invoices past due')
  })

  it('shows every panel open by default', () => {
    expect(defaultDashboardLayout('owner')).toEqual({ version: 1, panels: OWNER_KEYS.map((key) => panel(key)) })
    expect(defaultDashboardLayout('staff')).toEqual({ version: 1, panels: STAFF_KEYS.map((key) => panel(key)) })
  })

  it('maps the owner role to the owner view and everyone else to staff', () => {
    expect(dashboardViewForRole('owner')).toBe('owner')
    expect(dashboardViewForRole('employee')).toBe('staff')
    expect(dashboardViewForRole(undefined)).toBe('staff')
  })
})

describe('sanitizeDashboardLayout', () => {
  it('reads junk, a missing layout and another version as the default', () => {
    for (const raw of [null, undefined, 'x', 42, [], {}, { version: 2, panels: [] }, { version: '1', panels: [] }, { version: 1 }]) {
      expect(sanitizeDashboardLayout(raw, 'owner')).toEqual(defaultDashboardLayout('owner'))
    }
  })

  it('keeps a saved order with its hidden and collapsed flags', () => {
    const saved = {
      version: 1,
      panels: [
        panel('alerts'),
        panel('kpi', { collapsed: true }),
        panel('cases'),
        panel('queue', { hidden: true }),
        panel('team'),
        panel('skipped'),
        panel('past_due', { hidden: true, collapsed: true }),
        panel('activity'),
      ],
    }
    expect(sanitizeDashboardLayout(saved, 'owner')).toEqual(saved)
  })

  it('drops an unknown key, a duplicate and a malformed entry', () => {
    const clean = sanitizeDashboardLayout(
      {
        version: 1,
        panels: [panel('alerts'), panel('mystery'), panel('team', { hidden: true }), panel('team'), null, 'kpi', { hidden: true }],
      },
      'owner',
    )
    expect(keysOf(clean)).toEqual(['alerts', 'team', 'queue', 'cases', 'skipped', 'past_due', 'activity', 'kpi'])
    // The FIRST copy of a key wins.
    expect(clean.panels[1]).toEqual(panel('team', { hidden: true }))
  })

  it('drops a key from the other view', () => {
    const clean = sanitizeDashboardLayout({ version: 1, panels: [panel('my_queue', { hidden: true })] }, 'owner')
    expect(clean).toEqual(defaultDashboardLayout('owner'))
  })

  it('appends a missing panel open and shown, in default order', () => {
    const clean = sanitizeDashboardLayout(
      { version: 1, panels: [panel('alerts'), panel('kpi', { collapsed: true }), panel('team')] },
      'owner',
    )
    expect(keysOf(clean)).toEqual(['alerts', 'kpi', 'team', 'queue', 'cases', 'skipped', 'past_due', 'activity'])
    expect(clean.panels.slice(3).every((entry) => !entry.hidden && !entry.collapsed)).toBe(true)
  })

  it('pins Alerts first, never hidden and never collapsed', () => {
    const clean = sanitizeDashboardLayout(
      { version: 1, panels: [panel('my_kpi'), panel('waiting'), panel('alerts', { hidden: true, collapsed: true })] },
      'staff',
    )
    expect(clean.panels[0]).toEqual(panel('alerts'))
    expect(keysOf(clean)).toEqual(['alerts', 'my_kpi', 'waiting', 'my_queue', 'watching', 'my_cases', 'my_activity'])
  })

  it('treats only a strict true as hidden or collapsed', () => {
    const clean = sanitizeDashboardLayout(
      { version: 1, panels: [{ key: 'team', hidden: 'yes', collapsed: 1 }] },
      'owner',
    )
    expect(clean.panels.find((entry) => entry.key === 'team')).toEqual(panel('team'))
  })
})

describe('isDefaultDashboardLayout', () => {
  it('is true for the default and anything that cleans to it', () => {
    expect(isDefaultDashboardLayout(defaultDashboardLayout('owner'), 'owner')).toBe(true)
    expect(isDefaultDashboardLayout(null, 'staff')).toBe(true)
    expect(isDefaultDashboardLayout({ version: 1, panels: [panel('alerts', { hidden: true })] }, 'owner')).toBe(true)
  })

  it('is false once anything moves, hides or starts collapsed', () => {
    const base = defaultDashboardLayout('owner')
    expect(isDefaultDashboardLayout(moveDashboardPanel(base, 'kpi', -1, 'owner'), 'owner')).toBe(false)
    expect(isDefaultDashboardLayout(setDashboardPanelFlag(base, 'team', 'hidden', true, 'owner'), 'owner')).toBe(false)
    expect(isDefaultDashboardLayout(setDashboardPanelFlag(base, 'team', 'collapsed', true, 'owner'), 'owner')).toBe(false)
  })
})

describe('moving and flagging a panel', () => {
  const base = defaultDashboardLayout('owner')

  it('moves a panel one place up or down', () => {
    expect(keysOf(moveDashboardPanel(base, 'queue', 1, 'owner')).slice(0, 3)).toEqual(['alerts', 'team', 'queue'])
    expect(keysOf(moveDashboardPanel(base, 'kpi', -1, 'owner')).slice(-2)).toEqual(['kpi', 'activity'])
  })

  it('never moves Alerts, never moves anything above it, and ignores a move past the end', () => {
    expect(moveDashboardPanel(base, 'alerts', 1, 'owner')).toEqual(base)
    expect(moveDashboardPanel(base, 'queue', -1, 'owner')).toEqual(base)
    expect(moveDashboardPanel(base, 'kpi', 1, 'owner')).toEqual(base)
    expect(moveDashboardPanel(base, 'nope', 1, 'owner')).toEqual(base)
  })

  it('hides or collapses a panel but never Alerts', () => {
    expect(setDashboardPanelFlag(base, 'team', 'hidden', true, 'owner').panels[2]).toEqual(panel('team', { hidden: true }))
    expect(setDashboardPanelFlag(base, 'team', 'collapsed', true, 'owner').panels[2]).toEqual(panel('team', { collapsed: true }))
    expect(setDashboardPanelFlag(base, 'alerts', 'hidden', true, 'owner')).toEqual(base)
    expect(setDashboardPanelFlag(base, 'alerts', 'collapsed', true, 'owner')).toEqual(base)
  })

  it('never changes the layout it was handed', () => {
    const before = JSON.stringify(base)
    moveDashboardPanel(base, 'kpi', -1, 'owner')
    setDashboardPanelFlag(base, 'team', 'hidden', true, 'owner')
    expect(JSON.stringify(base)).toBe(before)
  })
})
