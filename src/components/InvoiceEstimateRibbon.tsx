import { useEffect, useState } from 'react'
import { invoiceEstimateRequest, type InvoiceEstimate, type InvoiceEstimateRow } from '../lib/api'
import { currency, getBillingPeriodLabel } from '../lib/utils'

/**
 * The owner's estimate of the month's invoices, above the Invoice Recap
 * (featreq-a5e14899). Month total / Service total / Reimburse total for the
 * invoices "to be sent": a client with a sent invoice is that invoice, every
 * other client is the Client Recap's projection (lib/invoice-estimate.js).
 *
 * Owner only, and the page decides: it renders this for the owner outside
 * preview and for nobody else, so staff never request the route at all. An
 * estimate that cannot be quoted for a client says "too early" or "no rates"
 * in that client's row; it is never shown as $0.00.
 */

const BASIS_LABEL: Record<InvoiceEstimateRow['basis'], string> = {
  sent: 'Sent',
  projected: 'Projected',
  too_early: 'Too early',
}

const money = (value: number | null) => (value === null ? '—' : currency.format(value))

export function InvoiceEstimateRibbon({ period }: { period: string }) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; estimate: InvoiceEstimate }
  >({ status: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    const load = async () => {
      setState({ status: 'loading' })
      try {
        const estimate = await invoiceEstimateRequest(period, controller.signal)
        if (!controller.signal.aborted) setState({ status: 'ready', estimate })
      } catch (err) {
        if (controller.signal.aborted) return
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : 'Could not load the estimate.',
        })
      }
    }
    void load()
    return () => controller.abort()
  }, [period])

  if (state.status === 'error') {
    return (
      <p className="invoice-run-error" role="alert">
        {state.message}
      </p>
    )
  }
  const ready = state.status === 'ready'
  const estimate = ready ? state.estimate : null
  const rows = estimate?.clients ?? []
  const sent = rows.filter((row) => row.basis === 'sent').length
  const projected = rows.filter((row) => row.basis === 'projected').length
  const tooEarly = rows.filter((row) => row.basis === 'too_early').length
  const note = ready
    ? `${rows.length} client${rows.length === 1 ? '' : 's'}: ${sent} sent, ${projected} projected${
        tooEarly > 0 ? `, ${tooEarly} too early` : ''
      }`
    : 'Loading the estimate…'

  return (
    <section className="invoice-estimate" aria-label="Estimated invoices">
      <p className="invoice-recap-hint">
        Your estimate for {getBillingPeriodLabel(period)}: invoices already sent as they stand, and
        every other client as the Client Recap projects it. Only you see this; the cards below are
        what has actually gone out.
      </p>
      <div className="invoice-run-stats">
        <div className="invoice-run-stat">
          <span>Month total</span>
          <strong>{estimate ? currency.format(estimate.monthTotal) : '—'}</strong>
        </div>
        <div className="invoice-run-stat">
          <span>Service total</span>
          <strong>{estimate ? currency.format(estimate.serviceTotal) : '—'}</strong>
        </div>
        <div className="invoice-run-stat">
          <span>Reimburse total</span>
          <strong>{estimate ? currency.format(estimate.reimburseTotal) : '—'}</strong>
        </div>
      </div>
      <p className="invoice-recap-none">{note}</p>
      <p className="invoice-recap-none">
        Sent rows: Service excludes prepayments and credits applied, so the three totals can
        differ.
      </p>
      {ready && rows.length > 0 ? (
        <details className="invoice-estimate-rows">
          <summary>Client by client</summary>
          <table className="invoice-estimate-table">
            <thead>
              <tr>
                <th scope="col">Client</th>
                <th scope="col">Basis</th>
                <th scope="col">Service</th>
                <th scope="col">Reimburse</th>
                <th scope="col">Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.clientId}>
                  <th scope="row">{row.clientName}</th>
                  <td>
                    {BASIS_LABEL[row.basis]}
                    {row.basis === 'sent' && row.invoiceNumber ? ` · ${row.invoiceNumber}` : ''}
                    {row.detail && row.basis !== 'too_early' ? ` · ${row.detail}` : ''}
                  </td>
                  <td>{row.service === null ? (row.detail ?? 'too early') : money(row.service)}</td>
                  <td>{row.basis === 'too_early' && row.reimburse === 0 ? '—' : currency.format(row.reimburse)}</td>
                  <td>{money(row.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </section>
  )
}
