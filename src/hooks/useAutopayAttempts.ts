import { useCallback, useEffect, useState } from 'react'
import { listAutopayAttemptsRequest } from '../lib/api'
import type { AutopayAttemptSummary } from '../lib/types'

/**
 * The month run's autopay badges (featreq-bef42b72): the latest attempt per
 * invoice, and whether charging is switched on (which decides whether "Charge
 * again" is offered at all).
 *
 * SILENT on failure, like the AI ratings beside it: this decides whether an
 * advisory badge appears, and an error banner over the month run would make the
 * badge's absence her problem. No badges is what every pre-autopay month shows.
 *
 * `refreshKey` is anything that should make it look again (a send or a payment
 * changes an invoice, and so changes the key); `reload` looks again on demand.
 */
export function useAutopayAttempts(refreshKey: string) {
  const [state, setState] = useState<{
    chargingEnabled: boolean
    byInvoice: Record<string, AutopayAttemptSummary>
  }>({ chargingEnabled: false, byInvoice: {} })
  const [reloads, setReloads] = useState(0)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const { chargingEnabled, attempts } = await listAutopayAttemptsRequest()
        if (cancelled) return
        setState({
          chargingEnabled: chargingEnabled === true,
          byInvoice: Object.fromEntries(attempts.map((attempt) => [attempt.invoiceId, attempt])),
        })
      } catch {
        /* no badges; the invoices themselves are unaffected */
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [refreshKey, reloads])

  const reload = useCallback(() => setReloads((count) => count + 1), [])
  return { ...state, reload }
}
