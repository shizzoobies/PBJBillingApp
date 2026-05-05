import {
  CalendarDays,
  CircleDollarSign,
  Clock3,
  ListChecks,
  ShieldCheck,
} from 'lucide-react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { formatHours, getBillingPeriodLabel, isInBillingPeriod } from '../lib/utils'
import { NotificationBell } from './NotificationBell'
import { SummaryItem } from './SummaryItem'
import { navItems } from './navItems'

export function AppLayout() {
  const {
    sessionUser,
    ownerMode,
    visibleClients,
    visibleEntries,
    visibleChecklists,
    billingPeriod,
    setBillingPeriod,
    handleLogout,
    dataSyncState,
    syncMessage,
  } = useAppContext()

  const location = useLocation()
  const showSummaryStrip = !ownerMode && location.pathname.startsWith('/time')

  const periodVisibleEntries = showSummaryStrip
    ? visibleEntries.filter((entry) => isInBillingPeriod(entry, billingPeriod))
    : []
  const billingPeriodLabel = getBillingPeriodLabel(billingPeriod)

  const billableMinutes = periodVisibleEntries
    .filter((entry) => entry.billable)
    .reduce((total, entry) => total + entry.minutes, 0)
  const openChecklistItems = visibleChecklists.reduce(
    (total, checklist) => total + checklist.items.filter((item) => !item.done).length,
    0,
  )

  const roleLabel = ownerMode ? 'Owner access' : sessionUser?.staffRole ?? 'Employee access'

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            PB
          </div>
          <div>
            <strong>PB&amp;J</strong>
            <span>Strategic Accounting</span>
          </div>
        </div>

        <nav className="nav-list">
          {navItems
            .filter((item) => ownerMode || !item.ownerOnly)
            .map((item) => {
              const Icon = item.icon
              return (
                <NavLink
                  className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}
                  key={item.to}
                  to={item.to}
                >
                  <Icon size={17} />
                  <span>{item.label}</span>
                </NavLink>
              )
            })}
        </nav>

        <div className="security-note">
          <ShieldCheck size={17} />
          <span>{ownerMode ? 'All client billing visible' : 'Assigned to me only'}</span>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="eyeline">PB&amp;J Strategic Accounting</p>
            <h1>Time, checklists, and client billing</h1>
            <p className={`sync-banner sync-${dataSyncState}`}>{syncMessage}</p>
          </div>
          <div className="topbar-actions">
            <label className="period-control">
              <CalendarDays size={16} />
              <span>Billing month</span>
              <input
                aria-label="Billing month"
                onChange={(event) => setBillingPeriod(event.target.value)}
                type="month"
                value={billingPeriod}
              />
            </label>
            <NotificationBell />
            <div className="account-pill" aria-label="Current account">
              <strong>{sessionUser.name}</strong>
              <span>{sessionUser.staffRole}</span>
            </div>
            <button className="logout-button" onClick={handleLogout} type="button">
              Log out
            </button>
          </div>
        </header>

        {showSummaryStrip ? (
          <section className="summary-strip" aria-label="Workspace summary">
            <SummaryItem
              icon={Clock3}
              label="My billable time"
              value={formatHours(billableMinutes)}
              detail={`${periodVisibleEntries.length} in ${billingPeriodLabel}`}
            />
            <SummaryItem
              icon={ListChecks}
              label="Assigned checklist items"
              value={openChecklistItems.toString()}
              detail={`${visibleChecklists.length} assigned checklists`}
            />
            <SummaryItem
              icon={CircleDollarSign}
              label="Visible clients"
              value={visibleClients.length.toString()}
              detail={roleLabel}
            />
          </section>
        ) : null}

        <Outlet />
      </main>
    </div>
  )
}
