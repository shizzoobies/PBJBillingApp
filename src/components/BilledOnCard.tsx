import { useEffect, useState } from 'react'
import { listBilledOnInvoicesRequest, type BilledOnInvoice } from '../lib/api'
import { INVOICE_STATUS_LABELS, currency, formatSentOn } from '../lib/utils'

/**
 * "Billed on" — the invoices a company appears on that are not its own.
 *
 * A client pointed at a billing master (`billToClientId`) generates no invoice
 * of its own: its lines are merged into the master's one document. Without this
 * card its page would show nothing for the month, which does not read as
 * "billed elsewhere" — it reads as "we forgot to bill them". That was called
 * out in the plan as one of the four surfaces that has to be taught otherwise.
 *
 * READ-ONLY, deliberately. The sub is not the client on that document, so there
 * is nothing here to edit, send or print; the number is the pointer, and the
 * month run is where the invoice itself is worked on.
 *
 * The amount shown is THIS company's share — its lines on the master's invoice
 * added up — not the master's total. One payment settles the whole document, so
 * a company is paid when the invoice is; there is no pro-rata apportionment to
 * report and none is invented here.
 */
export function BilledOnCard({
  clientId,
  masterName,
}: {
  /** The SUB — the company whose work is billed elsewhere. */
  clientId: string
  /**
   * The billing master's name, resolved from the workspace. Null when it is not
   * on file: the sentence then says "another client", because a name we cannot
   * vouch for is worse than none.
   */
  masterName: string | null
}) {
  const [invoices, setInvoices] = useState<BilledOnInvoice[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  /*
   * Fetched once. Nothing here writes, so there is nothing to reload after.
   *
   * There is deliberately no "reset to loading" here: the caller keys this
   * component by client id, so a different client is a fresh mount with fresh
   * state rather than this one being talked into forgetting the last answer.
   * That also keeps the effect free of a synchronous setState, which is a
   * cascading render and is what the lint rule is about.
   */
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const rows = await listBilledOnInvoicesRequest(clientId)
        if (!cancelled) setInvoices(rows)
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : 'Could not load the invoices this is billed on.',
          )
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [clientId])

  return (
    <div className="billed-on-card">
      {/* The one line that explains the whole page: why there is no invoice of
          this company's own, anywhere. */}
      <p className="billed-on-note">
        Invoiced on {masterName ?? 'another client'}&rsquo;s combined invoice.
      </p>

      {error ? (
        <p className="invoice-run-error" role="alert">
          {error}
        </p>
      ) : null}
      {loading ? <p className="invoice-run-empty">Loading…</p> : null}
      {!loading && !error && invoices.length === 0 ? (
        <p className="invoice-run-empty">
          Nothing has been billed on {masterName ?? 'the master'}&rsquo;s invoice yet.
        </p>
      ) : null}

      {invoices.length > 0 ? (
        <ul className="billed-on-list">
          {invoices.map((invoice) => (
            <li className="billed-on-row" key={invoice.invoiceId}>
              <span className="billed-on-line">
                {invoice.number ?? '—'} ({invoice.masterClientName}) —{' '}
                {currency.format(invoice.subtotal)}
                {/* Only when it has actually been paid. A blank date beside a
                    Sent invoice would read as a rendering fault. */}
                {invoice.paidAt ? ` · paid ${formatSentOn(invoice.paidAt)}` : null}
              </span>
              <span className={`invoice-status is-${invoice.status}`}>
                {INVOICE_STATUS_LABELS[invoice.status] ?? invoice.status}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
