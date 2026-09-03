import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import { invoiceRecapRequest, type InvoiceRecapRow } from '../lib/api'
import {
  INVOICE_STATUS_LABELS,
  currency,
  getBillingPeriodLabel,
  shiftReviewPeriod,
} from '../lib/utils'

/**
 * The monthly invoice recap (featreq-0c2d4ce5) — the one invoicing surface
 * staff can see, built so they can record each month's deposits correctly:
 * per client, the total billed, the accounting-services remainder, and every
 * client-reimbursed expense as its own labeled line ("they need to see each
 * one separate so they know what each reimbursed was for").
 *
 * Scoping is SERVER-side (visibleClientIdSet): each team member receives only
 * their assigned clients' invoices, owners receive everything. The page just
 * renders what it is handed; there is deliberately no client filter to get
 * wrong here.
 */

function currentMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

export function InvoiceRecapPage() {
  const [period, setPeriod] = useState(currentMonth)
  const [rows, setRows] = useState<InvoiceRecapRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const result = await invoiceRecapRequest(period)
        if (!cancelled) setRows(result.rows)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load the recap.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [period])

  return (
    <section className="panel" id="invoice-recap">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Monthly bills</p>
          <h2>Invoice Recap</h2>
        </div>
        <div className="period-control">
          <button
            type="button"
            className="period-step"
            aria-label="Previous month"
            onClick={() => setPeriod((current) => shiftReviewPeriod('month', current, -1))}
          >
            <ChevronLeft size={16} />
          </button>
          <label>
            <span className="visually-hidden">Month</span>
            <input
              type="month"
              className="input"
              value={period}
              onChange={(event) => setPeriod(event.target.value || currentMonth())}
            />
          </label>
          <button
            type="button"
            className="period-step"
            aria-label="Next month"
            onClick={() => setPeriod((current) => shiftReviewPeriod('month', current, 1))}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      <p className="invoice-recap-hint">
        Every invoice sent for {getBillingPeriodLabel(period)} for your clients: the total
        billed, the accounting-services amount, and each client-reimbursed expense listed
        separately so you can record what each one was for.
      </p>

      {error ? (
        <p className="invoice-run-error" role="alert">
          {error}
        </p>
      ) : null}
      {loading ? <p className="invoice-run-empty">Loading…</p> : null}
      {!loading && !error && rows.length === 0 ? (
        <p className="invoice-run-empty">
          No sent invoices for {getBillingPeriodLabel(period)} among your clients.
        </p>
      ) : null}

      <div className="invoice-recap-list">
        {rows.map((row) => (
          <article className="invoice-recap-card" key={row.invoiceId}>
            <header className="invoice-recap-head">
              <div>
                <h3>{row.clientName}</h3>
                <p className="invoice-recap-meta">
                  {row.number ?? 'No number'} ·{' '}
                  {INVOICE_STATUS_LABELS[row.status] ?? row.status}
                </p>
              </div>
              <div className="invoice-recap-totals">
                <div className="invoice-recap-total">
                  <span>Invoice total</span>
                  <strong>{currency.format(row.total)}</strong>
                </div>
                <div className="invoice-recap-total">
                  <span>Accounting services</span>
                  <strong>{currency.format(row.accountingTotal)}</strong>
                </div>
                <div className="invoice-recap-total">
                  <span>Reimbursed expenses</span>
                  <strong>{currency.format(row.reimbursedTotal)}</strong>
                </div>
              </div>
            </header>
            {row.reimbursedLines.length > 0 ? (
              <ul className="invoice-recap-lines">
                {row.reimbursedLines.map((line, index) => (
                  <li key={index}>
                    <span className="invoice-recap-line-label">
                      {line.label}
                      {line.company ? (
                        <span className="invoice-recap-line-company"> — {line.company}</span>
                      ) : null}
                    </span>
                    {line.detail ? (
                      <span className="invoice-recap-line-detail">{line.detail}</span>
                    ) : null}
                    <span className="invoice-recap-line-amount">
                      {currency.format(line.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="invoice-recap-none">No reimbursed expenses on this invoice.</p>
            )}
          </article>
        ))}
      </div>
    </section>
  )
}
