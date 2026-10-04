import { useEffect, useState } from 'react'
import { inviteToAutopayRequest, listAutopayRequest, turnOffAutopayRequest } from '../lib/api'
import type { AutopaySummary } from '../lib/types'
import { autopayStatusText } from '../lib/autopayText'

/**
 * Autopay, on a client's Billing tab (featreq-bef42b72): whether the client has
 * said "debit me when you send my invoice", and with what - and the two things
 * an owner can do about it: invite the client, or turn it off.
 *
 * OWNER-ONLY by where it is mounted (the Billing tab is owner-only) and by the
 * endpoints behind it. It shows words and a last four - the server never sends
 * the setup link, the payment method id or the mandate. Inviting EMAILS the
 * client a link; nothing is charged by anything on this panel.
 */
export function AutopayPanel({
  clientId,
  neverEmailed = false,
}: {
  clientId: string
  /**
   * This client's invoices are never emailed, so the invitation (an email) is
   * refused. The panel stays so an existing enrollment still shows and can be
   * turned off; only Invite is disabled, with the reason.
   */
  neverEmailed?: boolean
}) {
  const [summary, setSummary] = useState<AutopaySummary | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  const status = summary?.status ?? 'off'
  const waiting = status === 'invited' || status === 'pending_verification'

  const run = async (action: () => Promise<AutopaySummary>) => {
    setBusy(true)
    setError(null)
    try {
      setSummary(await action())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="field full-row autopay-panel">
      <span className="field-label-row">
        <strong>Automatic payments</strong>
      </span>
      <small className="field-helper" data-testid="autopay-status">
        {autopayStatusText(summary)}
      </small>
      <div className="autopay-actions">
        {status !== 'enrolled' ? (
          <button
            className="ghost-action"
            disabled={busy || neverEmailed}
            title={
              neverEmailed
                ? 'This client’s invoices are never emailed, so automatic payments are not offered'
                : undefined
            }
            onClick={() => void run(() => inviteToAutopayRequest(clientId))}
            type="button"
          >
            {waiting ? 'Send the invitation again' : 'Invite to autopay'}
          </button>
        ) : null}
        {status === 'enrolled' || waiting ? (
          <button
            className="ghost-action"
            disabled={busy}
            onClick={() => {
              if (
                !window.confirm(
                  'Turn off automatic payments for this client? Their saved payment method is removed, and each invoice will go out with a payment link again.',
                )
              ) {
                return
              }
              void run(() => turnOffAutopayRequest(clientId))
            }}
            type="button"
          >
            Turn off
          </button>
        ) : null}
      </div>
      {neverEmailed && status !== 'enrolled' ? (
        <small className="field-helper">
          This client’s invoices are never emailed, so automatic payments are not offered.
        </small>
      ) : null}
      {error ? (
        <small className="invoice-run-error" role="alert">
          {error}
        </small>
      ) : null}
    </div>
  )
}
