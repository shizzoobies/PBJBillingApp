import { useEffect, useRef, useState } from 'react'
import {
  fetchNotificationPrefs,
  updateNotificationPrefsRequest,
  type EmailNotificationPrefType,
  type EmailNotificationPrefs,
} from '../lib/api'
import { CollapsibleSection } from './SectionKit'

/**
 * Per-user email notification toggles. Rendered on the Notifications page
 * (every user, including bookkeepers — they have no Settings page) and on the
 * owner's Settings page. Toggles gate EMAILS only; in-app bell notifications
 * always arrive.
 */
export function EmailNotificationPrefsSection() {
  const [types, setTypes] = useState<EmailNotificationPrefType[]>([])
  const [prefs, setPrefs] = useState<EmailNotificationPrefs>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [savedFlash, setSavedFlash] = useState(false)
  const savedTimeoutRef = useRef<number | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchNotificationPrefs(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return
        setTypes(data.types)
        setPrefs(data.prefs)
        setLoading(false)
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setError('Could not load your email preferences.')
        setLoading(false)
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    return () => {
      if (savedTimeoutRef.current) {
        window.clearTimeout(savedTimeoutRef.current)
      }
    }
  }, [])

  const flashSaved = () => {
    setSavedFlash(true)
    if (savedTimeoutRef.current) {
      window.clearTimeout(savedTimeoutRef.current)
    }
    savedTimeoutRef.current = window.setTimeout(() => setSavedFlash(false), 1500)
  }

  const handleToggle = async (key: string, enabled: boolean) => {
    const previous = prefs
    const optimistic = { ...prefs, [key]: enabled }
    setPrefs(optimistic)
    setError('')
    try {
      const { prefs: stored } = await updateNotificationPrefsRequest(optimistic)
      setPrefs(stored)
      flashSaved()
    } catch {
      setPrefs(previous)
      setError('Could not save that change — try again.')
    }
  }

  return (
    <CollapsibleSection
      kicker="Email"
      title="Email notifications"
      storageKey="email-notification-prefs"
      headerAction={savedFlash ? <span className="saved-flash">Saved</span> : null}
    >
      <p className="muted-text" style={{ marginTop: 0 }}>
        Choose which notifications also reach you by email. Everything still shows up in the bell
        here either way — these toggles only control emails.
      </p>
      {loading ? (
        <p className="muted-text">Loading your preferences…</p>
      ) : (
        <div className="form-grid">
          {types.map((type) => (
            <label className="field toggle-field" key={type.key}>
              <span className="toggle-label">
                <input
                  checked={prefs[type.key] !== false}
                  onChange={(event) => void handleToggle(type.key, event.target.checked)}
                  type="checkbox"
                />
                <strong>{type.label}</strong>
              </span>
              <small className="field-helper">{type.description}</small>
            </label>
          ))}
        </div>
      )}
      {error ? <p className="auth-error">{error}</p> : null}
    </CollapsibleSection>
  )
}
