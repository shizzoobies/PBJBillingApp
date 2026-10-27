/**
 * Types for the per-user Dashboard layout. The implementation is plain JS so
 * the server can import it directly; this file lets the React side use it too.
 */

export type DashboardView = 'owner' | 'staff'

export type OwnerDashboardPanelKey =
  | 'alerts'
  | 'queue'
  | 'team'
  | 'cases'
  | 'skipped'
  | 'past_due'
  | 'activity'
  | 'kpi'

export type StaffDashboardPanelKey =
  | 'alerts'
  | 'waiting'
  | 'my_queue'
  | 'watching'
  | 'my_cases'
  | 'my_activity'
  | 'my_kpi'

export type DashboardPanelKey = OwnerDashboardPanelKey | StaffDashboardPanelKey

export type DashboardPanelSetting = {
  key: DashboardPanelKey
  hidden: boolean
  collapsed: boolean
}

export type DashboardLayout = {
  version: 1
  panels: DashboardPanelSetting[]
}

export declare const DASHBOARD_LAYOUT_VERSION: 1
export declare const PINNED_DASHBOARD_PANEL: 'alerts'
export declare const DASHBOARD_PANELS: Record<
  DashboardView,
  ReadonlyArray<{ key: DashboardPanelKey; label: string }>
>

export declare function dashboardViewForRole(role: string | null | undefined): DashboardView
export declare function dashboardPanelKeys(view: DashboardView): DashboardPanelKey[]
export declare function defaultDashboardLayout(view: DashboardView): DashboardLayout
export declare function sanitizeDashboardLayout(raw: unknown, view: DashboardView): DashboardLayout
export declare function isDefaultDashboardLayout(layout: unknown, view: DashboardView): boolean
export declare function moveDashboardPanel(
  layout: DashboardLayout,
  key: DashboardPanelKey,
  direction: -1 | 1,
  view: DashboardView,
): DashboardLayout
export declare function setDashboardPanelFlag(
  layout: DashboardLayout,
  key: DashboardPanelKey,
  flag: 'hidden' | 'collapsed',
  value: boolean,
  view: DashboardView,
): DashboardLayout
