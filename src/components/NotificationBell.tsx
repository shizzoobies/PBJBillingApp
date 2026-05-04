import { useEffect, useRef, useState } from 'react'
import { Bell } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import {
  fetchNotifications,
  fetchUnreadNotificationCount,
  markAllNotificationsReadRequest,
  markNotificationReadRequest,
} from '../lib/api'
import type { NotificationEntry } from '../lib/types'
import { useAppContext } from '../AppContext'

const POLL_INTERVAL_MS = 60_000

function relativeTime(iso: string) {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diffMs = Date.now() - then
  const min = Math.round(diffMs / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  if (day < 7) return `${day}d ago`
  return new Date(iso).toLocaleDateString()
}

export function NotificationBell() {
  const navigate = useNavigate()
  const { dataSyncState } = useAppContext()
  const [open, setOpen] = useState(false)
  const [unreadCount, setUnreadCount] = useState(0)
  const [entries, setEntries] = useState<NotificationEntry[]>([])
  const [loading, setLoading] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Initial load + 60s poll for the badge.
  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()

    const loadCount = async () => {
      try {
        const { count } = await fetchUnreadNotificationCount(controller.signal)
        if (!cancelled) setUnreadCount(count)
      } catch {
        // Silent — badge just won't update this tick.
      }
    }

    void loadCount()
    const intervalId = window.setInterval(loadCount, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      controller.abort()
      window.clearInterval(intervalId)
    }
  }, [])

  // Refresh the badge after any user action that just synced (toggle item, etc.).
  useEffect(() => {
    if (dataSyncState !== 'synced') return
    let cancelled = false
    const controller = new AbortController()
    const refresh = async () => {
      try {
        const { count } = await fetchUnreadNotificationCount(controller.signal)
        if (!cancelled) setUnreadCount(count)
      } catch {
        // ignore
      }
    }
    void refresh()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [dataSyncState])

  // Fetch list when opened.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    const controller = new AbortController()
    const load = async () => {
      setLoading(true)
      try {
        const { entries: list } = await fetchNotifications({ limit: 20 }, controller.signal)
        if (!cancelled) setEntries(list)
      } catch {
        if (!cancelled) setEntries([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [open])

  // Click-outside to close.
  useEffect(() => {
    if (!open) return
    const handler = (event: MouseEvent) => {
      if (!containerRef.current) return
      if (!containerRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [open])

  const handleRowClick = async (entry: NotificationEntry) => {
    setOpen(false)
    if (!entry.readAt) {
      try {
        await markNotificationReadRequest(entry.id)
        setUnreadCount((current) => Math.max(0, current - 1))
        setEntries((current) =>
          current.map((item) =>
            item.id === entry.id ? { ...item, readAt: new Date().toISOString() } : item,
          ),
        )
      } catch {
        // ignore — still navigate
      }
    }
    if (entry.link) {
      navigate(entry.link)
    }
  }

  const handleMarkAll = async () => {
    try {
      await markAllNotificationsReadRequest()
      setUnreadCount(0)
      const now = new Date().toISOString()
      setEntries((current) => current.map((item) => ({ ...item, readAt: item.readAt ?? now })))
    } catch {
      // ignore
    }
  }

  const badgeLabel = unreadCount > 9 ? '9+' : String(unreadCount)

  return (
    <div className="notification-bell" ref={containerRef}>
      <button
        aria-label={`Notifications${unreadCount ? ` (${unreadCount} unread)` : ''}`}
        className="bell-button"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <Bell size={18} />
        {unreadCount > 0 ? <span className="bell-badge">{badgeLabel}</span> : null}
      </button>

      {open ? (
        <div className="notification-dropdown" role="dialog" aria-label="Notifications">
          <header className="notification-dropdown-header">
            <strong>Notifications</strong>
          </header>

          <div className="notification-dropdown-list">
            {loading ? (
              <p className="notification-empty">Loading...</p>
            ) : entries.length === 0 ? (
              <p className="notification-empty">You&apos;re all caught up.</p>
            ) : (
              entries.map((entry) => (
                <button
                  className={`notification-row ${entry.readAt ? 'read' : 'unread'}`}
                  key={entry.id}
                  onClick={() => handleRowClick(entry)}
                  type="button"
                >
                  <span className="notification-message">{entry.message}</span>
                  <span className="notification-meta">{relativeTime(entry.createdAt)}</span>
                  {entry.readAt ? null : <span className="notification-dot" aria-hidden="true" />}
                </button>
              ))
            )}
          </div>

          <footer className="notification-dropdown-footer">
            <button
              className="link-button"
              disabled={unreadCount === 0}
              onClick={handleMarkAll}
              type="button"
            >
              Mark all as read
            </button>
            <button
              className="link-button"
              onClick={() => {
                setOpen(false)
                navigate('/notifications')
              }}
              type="button"
            >
              View all
            </button>
          </footer>
        </div>
      ) : null}
    </div>
  )
}
