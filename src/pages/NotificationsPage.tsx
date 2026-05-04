import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  fetchNotifications,
  markAllNotificationsReadRequest,
  markNotificationReadRequest,
} from '../lib/api'
import type { NotificationEntry } from '../lib/types'

const PAGE_SIZE = 50

type Filter = 'all' | 'unread'

function formatTimestamp(iso: string) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString()
}

export function NotificationsPage() {
  const navigate = useNavigate()
  const [filter, setFilter] = useState<Filter>('all')
  const [entries, setEntries] = useState<NotificationEntry[]>([])
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()

    const load = async () => {
      setLoading(true)
      setError('')
      try {
        const { entries: list } = await fetchNotifications(
          { limit, unreadOnly: filter === 'unread' },
          controller.signal,
        )
        if (!cancelled) setEntries(list)
      } catch {
        if (!cancelled) setError('Could not load notifications.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [filter, limit])

  const handleRowClick = async (entry: NotificationEntry) => {
    if (!entry.readAt) {
      try {
        await markNotificationReadRequest(entry.id)
        setEntries((current) =>
          current.map((item) =>
            item.id === entry.id ? { ...item, readAt: new Date().toISOString() } : item,
          ),
        )
      } catch {
        // ignore
      }
    }
    if (entry.link) {
      navigate(entry.link)
    }
  }

  const handleMarkAll = async () => {
    try {
      await markAllNotificationsReadRequest()
      const now = new Date().toISOString()
      setEntries((current) => current.map((item) => ({ ...item, readAt: item.readAt ?? now })))
    } catch {
      // ignore
    }
  }

  const hasMore = entries.length >= limit

  return (
    <section className="page-section">
      <header className="section-heading">
        <div>
          <p className="section-kicker">Inbox</p>
          <h2>Notifications</h2>
        </div>
        <div className="topbar-actions">
          <div className="segmented" role="tablist" aria-label="Filter notifications">
            <button
              aria-pressed={filter === 'all'}
              className={filter === 'all' ? 'segmented-option active' : 'segmented-option'}
              onClick={() => setFilter('all')}
              type="button"
            >
              All
            </button>
            <button
              aria-pressed={filter === 'unread'}
              className={filter === 'unread' ? 'segmented-option active' : 'segmented-option'}
              onClick={() => setFilter('unread')}
              type="button"
            >
              Unread
            </button>
          </div>
          <button className="logout-button" onClick={handleMarkAll} type="button">
            Mark all as read
          </button>
        </div>
      </header>

      {error ? <p className="sync-banner sync-error">{error}</p> : null}

      <div className="notifications-page-list">
        {loading && entries.length === 0 ? (
          <p className="notification-empty">Loading...</p>
        ) : entries.length === 0 ? (
          <p className="notification-empty">No notifications to show.</p>
        ) : (
          entries.map((entry) => (
            <button
              className={`notification-page-row ${entry.readAt ? 'read' : 'unread'}`}
              key={entry.id}
              onClick={() => handleRowClick(entry)}
              type="button"
            >
              <div className="notification-page-row-main">
                <span className="notification-message">{entry.message}</span>
                <span className="notification-meta">{formatTimestamp(entry.createdAt)}</span>
              </div>
              {entry.readAt ? null : <span className="notification-dot" aria-hidden="true" />}
            </button>
          ))
        )}
      </div>

      {hasMore ? (
        <div className="notifications-page-footer">
          <button
            className="logout-button"
            onClick={() => setLimit((current) => current + PAGE_SIZE)}
            type="button"
          >
            Load more
          </button>
        </div>
      ) : null}
    </section>
  )
}
