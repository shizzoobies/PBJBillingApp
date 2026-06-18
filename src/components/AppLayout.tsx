import {
  AlertTriangle,
  CalendarDays,
  CircleDollarSign,
  Clock3,
  ListChecks,
  Menu,
  ShieldCheck,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import {
  formatHours,
  getBillingPeriodLabel,
  isInBillingPeriod,
  isSafeImageSrc,
} from '../lib/utils'
import { ConversationProvider } from '@elevenlabs/react'
import { AssistantPanel } from './AssistantPanel'
import { NotificationBell } from './NotificationBell'
import { SummaryItem } from './SummaryItem'
import { navItems } from './navItems'

// Who the user should contact when the app can't save. Surfaced in the big
// red "not connected" alarm so Brittany knows exactly who to reach out to
// (Alex owns/maintains the app).
const SUPPORT_CONTACT_NAME = 'Alex'
const SUPPORT_CONTACT_EMAIL = 'asoalexander@gmail.com'

export function AppLayout() {
  const {
    sessionUser,
    ownerMode,
    previewMode,
    effectiveUser,
    setPreviewUserId,
    visibleClients,
    visibleEntries,
    visibleChecklists,
    billingPeriod,
    setBillingPeriod,
    handleLogout,
    dataSyncState,
    syncMessage,
    firmSettings,
  } = useAppContext()

  const firmName = firmSettings?.name || 'PB&J Strategic Accounting'
  const firmTagline = firmSettings?.tagline || 'Strategic Accounting'
  const firmLogoUrl = firmSettings?.logoUrl || ''
  const initials = firmName
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
    .slice(0, 3) || 'PB'

  // Grace period before alarming: transient blips (an SSE reconnect during
  // navigation, one failed poll) flip dataSyncState to offline/error for a
  // moment and recover on their own. The red banner only appears if the bad
  // state persists past the grace window; until then we show a calm
  // "Saving…" (which is what's really happening — the client is retrying).
  const isSyncAlarm = dataSyncState === 'offline' || dataSyncState === 'error'
  const [syncAlarmVisible, setSyncAlarmVisible] = useState(false)
  useEffect(() => {
    const delay = !isSyncAlarm ? 0 : dataSyncState === 'offline' ? 4000 : 1500
    const timer = window.setTimeout(() => setSyncAlarmVisible(isSyncAlarm), delay)
    return () => window.clearTimeout(timer)
  }, [isSyncAlarm, dataSyncState])
  const inSyncGrace = isSyncAlarm && !syncAlarmVisible
  const displayedSyncState = inSyncGrace ? 'saving' : dataSyncState
  const displayedSyncMessage = inSyncGrace ? 'Saving…' : syncMessage

  // Mobile nav drawer. Closed via the backdrop, the Escape-free X-less
  // pattern of tapping any nav link, or toggling the hamburger again.
  // Desktop ignores all of this — the sidebar is permanently visible.
  const [navOpen, setNavOpen] = useState(false)

  const location = useLocation()
  const showSummaryStrip = !ownerMode && location.pathname.startsWith('/time')

  const periodVisibleEntries = showSummaryStrip
    ? visibleEntries.filter((entry) => isInBillingPeriod(entry, billingPeriod))
    : []
  const billingPeriodLabel = getBillingPeriodLabel(billingPeriod)

  const billableMinutes = periodVisibleEntries
    .filter((entry) => entry.billable)
    .reduce((total, entry) => total + entry.minutes, 0)
  // Staff now receive every task for their assigned clients, so scope this
  // summary to tasks actually assigned to this person — the label says
  // "assigned checklist items", and it should stay literally that.
  const myChecklists = visibleChecklists.filter(
    (checklist) => checklist.assigneeId === effectiveUser?.id,
  )
  const openChecklistItems = myChecklists.reduce(
    (total, checklist) => total + checklist.items.filter((item) => !item.done).length,
    0,
  )

  const roleLabel = ownerMode
    ? 'Owner access'
    : effectiveUser?.staffRole ?? 'Employee access'

  return (
    <div className="app-shell">
      {navOpen ? (
        <button
          type="button"
          className="nav-backdrop"
          aria-label="Close navigation"
          onClick={() => setNavOpen(false)}
        />
      ) : null}
      <aside className={navOpen ? 'sidebar open' : 'sidebar'} aria-label="Primary navigation">
        {isSafeImageSrc(firmLogoUrl) ? (
          // Logo-only header: the firm's name is assumed to be baked
          // into the image, so we drop the text lockup entirely. The
          // logo gets its own block-level styles in CSS so it can
          // actually fill the sidebar width instead of being crammed
          // into a 44px badge.
          <div className="brand-logo-only">
            <img alt={firmName} src={firmLogoUrl} className="brand-logo-full" />
          </div>
        ) : (
          <div className="brand-lockup">
            <div className="brand-mark" aria-hidden="true">
              {initials}
            </div>
            <div>
              <strong>{firmName}</strong>
              {firmTagline ? <span>{firmTagline}</span> : null}
            </div>
          </div>
        )}

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
                  onClick={() => setNavOpen(false)}
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
        {syncAlarmVisible ? (
          <div className="sync-alarm-bar" role="alert" aria-live="assertive">
            <AlertTriangle size={30} className="sync-alarm-icon" aria-hidden="true" />
            <div className="sync-alarm-copy">
              <strong>Not connected — your work is NOT being saved.</strong>
              <span>
                The app can’t reach the server right now, so anything you change may be
                lost. Please stop editing and reach out to {SUPPORT_CONTACT_NAME} right
                away so he can fix it:{' '}
                <a href={`mailto:${SUPPORT_CONTACT_EMAIL}`}>{SUPPORT_CONTACT_EMAIL}</a>.
              </span>
            </div>
          </div>
        ) : null}
        {previewMode ? (
          <div className="preview-banner" role="status">
            <div>
              <strong>Viewing as {effectiveUser.name}</strong>
              <span> · You can see what they see but cannot make changes from here.</span>
            </div>
            <button
              type="button"
              className="preview-banner-exit"
              onClick={() => setPreviewUserId(null)}
            >
              Exit preview
            </button>
          </div>
        ) : null}
        <header className="topbar">
          <button
            type="button"
            className="nav-toggle"
            aria-label="Open navigation"
            aria-expanded={navOpen}
            onClick={() => setNavOpen((current) => !current)}
          >
            <Menu size={18} />
          </button>
          <div className="topbar-heading">
            <p className="eyeline">{firmName}</p>
            <p className={`sync-banner sync-${displayedSyncState}`}>{displayedSyncMessage}</p>
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
              detail={`${myChecklists.length} assigned checklists`}
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

      {/* Owner-only AI assistant. ownerMode is the EFFECTIVE role, so the
          panel also disappears while previewing a bookkeeper's view. The
          ConversationProvider scopes the ElevenLabs voice session to it. */}
      {ownerMode ? (
        <ConversationProvider>
          <AssistantPanel />
        </ConversationProvider>
      ) : null}
    </div>
  )
}
