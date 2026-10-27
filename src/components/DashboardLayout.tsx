import { Children, createContext, isValidElement, useContext, type ReactElement, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, LayoutGrid } from 'lucide-react'
import {
  PINNED_DASHBOARD_PANEL,
  type DashboardLayout,
  type DashboardPanelKey,
} from '../../lib/dashboard-layout.js'
import {
  dashboardPanelLabel,
  SELF_FETCHING_PANELS,
  type DashboardArrangement,
} from '../lib/useDashboardArrangement'

/**
 * The Dashboard's panels and its Arrange list (2026-10-27). The state - the
 * saved layout, the draft, the chevron presses - is useDashboardArrangement's.
 *
 * - A hidden panel is never mounted, so a panel that loads its own data
 *   (Invoices past due) asks the server for nothing.
 * - "Arrange" swaps the panels for a short list with Move up / Move down,
 *   Hide / Show and Starts open / collapsed, then Done, Reset to default, Cancel.
 * - Preview (read-only) has no Arrange button.
 */

const ArrangementContext = createContext<DashboardArrangement | null>(null)

/**
 * The "Arrange" button for the Dashboard header; nothing in preview or while
 * arranging. Off until the server has answered with the saved arrangement, so
 * a draft is never built from the default or this browser's hint.
 */
export function DashboardArrangeButton({ arrangement }: { arrangement: DashboardArrangement }) {
  if (arrangement.readOnly || arrangement.draft) return null
  const ready = arrangement.serverAnswered
  return (
    <button
      type="button"
      className="quick-action"
      disabled={!ready}
      title={
        ready
          ? undefined
          : arrangement.loadFailed
            ? 'Your arrangement could not be loaded. Reload the page to arrange.'
            : 'Loading…'
      }
      onClick={arrangement.startArranging}
    >
      <LayoutGrid size={16} /> Arrange
    </button>
  )
}

function panelKeyOf(child: ReactNode): DashboardPanelKey | null {
  if (!isValidElement(child)) return null
  const panel = (child.props as { panel?: unknown }).panel
  return typeof panel === 'string' ? (panel as DashboardPanelKey) : null
}

/**
 * The Dashboard page. Children with a `panel` prop are the panels: they are
 * laid out in the saved order and a hidden one is not rendered at all. Any
 * other child (the header, a banner) stays first, in place. While arranging,
 * the panels give way to the arrange list.
 */
export function DashboardPanels({
  arrangement,
  className,
  children,
}: {
  arrangement: DashboardArrangement
  className: string
  children: ReactNode
}) {
  const framing: ReactNode[] = []
  const panels = new Map<DashboardPanelKey, ReactElement>()
  for (const child of Children.toArray(children)) {
    const key = panelKeyOf(child)
    if (key) panels.set(key, child as ReactElement)
    else framing.push(child)
  }
  return (
    <ArrangementContext.Provider value={arrangement}>
      <div className={className}>
        {framing}
        {arrangement.draft ? (
          <ArrangeList arrangement={arrangement} draft={arrangement.draft} />
        ) : (
          arrangement.layout.panels.map((setting) => {
            if (setting.hidden) return null
            if (SELF_FETCHING_PANELS.has(setting.key) && !arrangement.known) return null
            return panels.get(setting.key) ?? null
          })
        )}
      </div>
    </ArrangementContext.Provider>
  )
}

/**
 * One Dashboard panel: its section, with a chevron beside the heading that
 * collapses it for this visit. `label` is the section's accessible name and its
 * default heading; `title` overrides the heading text (a count, say). `empty`
 * renders nothing (a panel that shows only when it has rows). Alerts passes
 * `collapsible={false}`: no heading, always open.
 */
export function DashboardPanel({
  panel,
  label,
  title,
  className = 'dashboard-section',
  headerExtra,
  empty = false,
  collapsible = true,
  children,
}: {
  panel: DashboardPanelKey
  label: string
  title?: string
  className?: string
  headerExtra?: ReactNode
  empty?: boolean
  collapsible?: boolean
  children: ReactNode
}) {
  const arrangement = useContext(ArrangementContext)
  if (empty) return null
  if (!collapsible) {
    return (
      <section className={className} aria-label={label}>
        {children}
      </section>
    )
  }
  const collapsed = arrangement?.isCollapsed(panel) ?? false
  return (
    <section className={`${className}${collapsed ? ' dashboard-panel-collapsed' : ''}`} aria-label={label}>
      <div className="dashboard-panel-head">
        <button
          type="button"
          className="section-collapse-btn"
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}
          title={collapsed ? 'Expand' : 'Collapse'}
          onClick={() => arrangement?.toggleCollapsed(panel)}
        >
          {collapsed ? <ChevronRight size={18} /> : <ChevronDown size={18} />}
        </button>
        <h2>{title ?? label}</h2>
        {headerExtra ? <div className="dashboard-panel-head-extra">{headerExtra}</div> : null}
      </div>
      {collapsed ? null : children}
    </section>
  )
}

function ArrangeList({ arrangement, draft }: { arrangement: DashboardArrangement; draft: DashboardLayout }) {
  const { view } = arrangement
  const last = draft.panels.length - 1
  return (
    <section className="dashboard-section dashboard-arrange" aria-label="Arrange your dashboard">
      <h2>Arrange your dashboard</h2>
      <p className="dashboard-section-caption">
        Move panels up or down, hide the ones you do not use, and choose whether each one starts open or
        collapsed. Alerts always stays first.
      </p>
      <ol className="dashboard-arrange-list">
        {draft.panels.map((setting, index) => {
          const label = dashboardPanelLabel(view, setting.key)
          const pinned = setting.key === PINNED_DASHBOARD_PANEL
          return (
            <li
              key={setting.key}
              className={`dashboard-arrange-row${setting.hidden ? ' is-hidden' : ''}`}
              aria-label={label}
            >
              {/* The Hidden pill sits with the name, so the controls keep one shape. */}
              <span className="dashboard-arrange-title">
                <strong className="dashboard-arrange-name">{label}</strong>
                {setting.hidden ? <span className="status-pill">Hidden</span> : null}
              </span>
              {pinned ? (
                <span className="dashboard-arrange-note">Always first and always shown</span>
              ) : (
                <div className="dashboard-arrange-tools">
                  <button
                    type="button"
                    className="secondary-action"
                    aria-label={`Move ${label} up`}
                    title="Move up"
                    // aria-disabled, not disabled: a disabled button drops
                    // keyboard focus when a move lands it at the top.
                    aria-disabled={index <= 1}
                    onClick={() => {
                      if (index > 1) arrangement.moveInDraft(setting.key, -1)
                    }}
                  >
                    <ArrowUp size={14} />
                  </button>
                  <button
                    type="button"
                    className="secondary-action"
                    aria-label={`Move ${label} down`}
                    title="Move down"
                    aria-disabled={index >= last}
                    onClick={() => {
                      if (index < last) arrangement.moveInDraft(setting.key, 1)
                    }}
                  >
                    <ArrowDown size={14} />
                  </button>
                  <button
                    type="button"
                    className="secondary-action"
                    aria-label={`${setting.hidden ? 'Show' : 'Hide'} ${label}`}
                    onClick={() => arrangement.setDraftFlag(setting.key, 'hidden', !setting.hidden)}
                  >
                    {setting.hidden ? 'Show' : 'Hide'}
                  </button>
                  <select
                    aria-label={`How ${label} starts`}
                    value={setting.collapsed ? 'collapsed' : 'open'}
                    onChange={(event) =>
                      arrangement.setDraftFlag(setting.key, 'collapsed', event.target.value === 'collapsed')
                    }
                  >
                    <option value="open">Starts open</option>
                    <option value="collapsed">Starts collapsed</option>
                  </select>
                </div>
              )}
            </li>
          )
        })}
      </ol>
      <div className="dashboard-arrange-actions">
        <button
          type="button"
          className="primary-action"
          disabled={arrangement.saving}
          onClick={() => void arrangement.saveDraft()}
        >
          {arrangement.saving ? 'Saving…' : 'Done'}
        </button>
        <button type="button" className="secondary-action" disabled={arrangement.saving} onClick={arrangement.resetDraft}>
          Reset to default
        </button>
        <button type="button" className="secondary-action" disabled={arrangement.saving} onClick={arrangement.cancelArranging}>
          Cancel
        </button>
      </div>
      {arrangement.error ? (
        <p className="waiting-editor-error" role="alert">
          {arrangement.error}
        </p>
      ) : null}
    </section>
  )
}
