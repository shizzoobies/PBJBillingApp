import { useEffect, useState } from 'react'
import { listAutopayRequest } from '../lib/api'
import type { AutopaySummary } from '../lib/types'
import { autopayStatusText } from '../lib/autopayText'

/**
 * Autopay, on a client's Billing tab (featreq-bef42b72): whether the client has
 * said "debit me when you send my invoice", and with what.
 *
 * OWNER-ONLY by where it is mounted (the Billing tab is owner-only) and by the
 * endpoint behind it. It shows words and a last four - the server never sends
 * the setup link, the payment method id or the mandate.
 */

export function AutopayPanel({ clientId }: { clientId: string }) {
  const [summary, setSummary] = useState<AutopaySummary | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)

  // Fetched once per mount; the caller keys this by client, so a different
  // client is a fresh mount rather than this one being talked into forgetting.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const rows = await listAutopayRequest()
        if (!cancelled) setSummary(rows.find((row) => row.clientId === clientId) ?? null)
      } catch {
        // A panel that cannot load says nothing rather than guessing a status.
        if (!cancelled) setFailed(true)
      } finally {
        if (!cancelled) setLoaded(true)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [clientId])

  if (!loaded || failed) return null
  return (
    <div className="field full-row autopay-panel">
      <span className="field-label-row">
        <strong>Automatic payments</strong>
      </span>
      <small className="field-helper" data-testid="autopay-status">
        {autopayStatusText(summary)}
      </small>
    </div>
  )
}
