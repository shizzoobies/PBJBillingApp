import { useEffect, useState } from 'react'
import { RefreshCw, X } from 'lucide-react'
import { extractEntryScript, runningEntryScript } from '../lib/appVersion'

/** How often an idle tab re-checks for a new deploy. */
const CHECK_INTERVAL_MS = 5 * 60 * 1000

/**
 * Small fixed toast that appears when the server is serving a newer build
 * than the one this tab is running (see lib/appVersion.ts). Checks on an
 * interval AND the moment the tab regains visibility — returning to a
 * long-abandoned tab is exactly when the prompt matters. Silent in dev
 * (no fingerprinted bundle to compare) and on any fetch failure.
 */
export function NewVersionToast() {
  const [stale, setStale] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const running = runningEntryScript()
    if (!running) return // dev server or unexpected markup — nothing to compare

    let alive = true
    const check = async () => {
      try {
        const response = await fetch('/', { cache: 'no-store', credentials: 'same-origin' })
        if (!response.ok) return
        const served = extractEntryScript(await response.text())
        if (alive && served && served !== running) setStale(true)
      } catch {
        /* offline or transient — try again next tick */
      }
    }

    const interval = window.setInterval(() => void check(), CHECK_INTERVAL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  if (!stale || dismissed) return null

  return (
    <div className="new-version-toast" role="status">
      <span className="new-version-toast-text">
        A new version of the app is ready.
      </span>
      <button
        type="button"
        className="primary-action new-version-toast-refresh"
        onClick={() => window.location.reload()}
      >
        <RefreshCw size={14} aria-hidden="true" /> Refresh
      </button>
      <button
        type="button"
        className="new-version-toast-dismiss"
        aria-label="Dismiss"
        title="Dismiss — you can refresh anytime"
        onClick={() => setDismissed(true)}
      >
        <X size={14} />
      </button>
    </div>
  )
}
