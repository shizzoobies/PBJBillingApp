import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAppContext } from '../AppContext'
import {
  fetchClientRecap,
  saveSalesTaxRecord,
  type ClientRecap,
  type ClientRecapPeriodType,
  type SalesTaxFigures,
} from '../lib/api'
import { currentReviewPeriod, shiftReviewPeriod } from '../lib/utils'

const money = (n: number | null | undefined) =>
  n == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
const hrs = (n: number) => `${n}h`

const SALES_TAX_LABELS: Record<ClientRecap['salesTax']['status'], string> = {
  not_started: 'Not started',
  open: 'In progress',
  overdue: 'Overdue',
  done: 'Filed',
}

export function ClientRecapPage() {
  const { visibleClients, ownerMode } = useAppContext()
  const [clientId, setClientId] = useState(visibleClients[0]?.id ?? '')
  const [periodType, setPeriodType] = useState<ClientRecapPeriodType>('month')
  const [period, setPeriod] = useState(() => currentReviewPeriod('month'))
  const [recap, setRecap] = useState<ClientRecap | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Derived so we never sync state in an effect: falls back to the first
  // visible client until the user picks one (handles visibleClients arriving
  // after first render).
  const effectiveClientId = clientId || visibleClients[0]?.id || ''

  useEffect(() => {
    if (!effectiveClientId) return
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError('')
      try {
        const result = await fetchClientRecap(effectiveClientId, periodType, period)
        if (!cancelled) setRecap(result)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load recap')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [effectiveClientId, periodType, period])

  const changePeriodType = (next: ClientRecapPeriodType) => {
    setPeriodType(next)
    setPeriod(currentReviewPeriod(next))
  }

  const refresh = () => {
    if (effectiveClientId) {
      fetchClientRecap(effectiveClientId, periodType, period)
        .then(setRecap)
        .catch(() => {})
    }
  }

  if (visibleClients.length === 0) {
    return (
      <section className="content-grid one-column" id="client-recap">
        <section className="panel">
          <h2>Client Recap</h2>
          <p className="empty-state">You don't have any clients assigned yet.</p>
        </section>
      </section>
    )
  }

  return (
    <section className="content-grid one-column" id="client-recap">
      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Client Recap</h2>
            <p className="muted-text" style={{ margin: '4px 0 0' }}>
              A {periodType === 'quarter' ? 'quarterly' : 'monthly'} review of one client.
            </p>
          </div>
        </div>

        <div className="recap-controls">
          <label className="field">
            <span>Client</span>
            <select
              className="input"
              value={effectiveClientId}
              onChange={(event) => setClientId(event.target.value)}
            >
              {visibleClients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </label>

          <div className="recap-period-toggle" role="group" aria-label="Review period">
            <button
              type="button"
              className={periodType === 'month' ? 'is-active' : ''}
              onClick={() => changePeriodType('month')}
            >
              Monthly
            </button>
            <button
              type="button"
              className={periodType === 'quarter' ? 'is-active' : ''}
              onClick={() => changePeriodType('quarter')}
            >
              Quarterly
            </button>
          </div>

          <div className="recap-period-nav">
            <button
              type="button"
              aria-label="Previous period"
              onClick={() => setPeriod((p) => shiftReviewPeriod(periodType, p, -1))}
            >
              <ChevronLeft size={16} />
            </button>
            <strong>{recap?.periodLabel ?? period}</strong>
            <button
              type="button"
              aria-label="Next period"
              onClick={() => setPeriod((p) => shiftReviewPeriod(periodType, p, 1))}
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </section>

      {loading ? <section className="panel">Loading…</section> : null}
      {error ? <section className="panel auth-error">{error}</section> : null}

      {recap && !loading ? (
        <>
          {/* Time & hours */}
          <section className="panel recap-card">
            <h3>Time &amp; hours</h3>
            <div className="recap-stats">
              <div className="recap-stat">
                <span className="recap-stat-value">{hrs(recap.time.totalHours)}</span>
                <span className="recap-stat-label">Total hours</span>
              </div>
              <div className="recap-stat">
                <span className="recap-stat-value">{hrs(recap.time.billableHours)}</span>
                <span className="recap-stat-label">Billable</span>
              </div>
              <div className="recap-stat">
                <span className="recap-stat-value">{hrs(recap.time.adminHours)}</span>
                <span className="recap-stat-label">Administrative</span>
              </div>
              <div className="recap-stat">
                <span className="recap-stat-value">
                  {recap.time.deltaHours >= 0 ? '+' : ''}
                  {hrs(recap.time.deltaHours)}
                </span>
                <span className="recap-stat-label">vs. prior ({hrs(recap.time.priorHours)})</span>
              </div>
            </div>
            {recap.time.byStaff.length > 0 ? (
              <ul className="recap-list">
                {recap.time.byStaff.map((row) => (
                  <li key={row.name}>
                    <span>{row.name}</span>
                    <span>
                      {hrs(row.hours)} ({hrs(row.billableHours)} billable)
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted-text">No time logged this period.</p>
            )}
          </section>

          {/* Tasks & workflow */}
          <section className="panel recap-card">
            <h3>Tasks &amp; workflow</h3>
            <div className="recap-stats">
              <div className="recap-stat">
                <span className="recap-stat-value">{recap.tasks.dueCount}</span>
                <span className="recap-stat-label">Due this period</span>
              </div>
              <div className="recap-stat">
                <span className="recap-stat-value">{recap.tasks.completedCount}</span>
                <span className="recap-stat-label">Completed</span>
              </div>
              <div className="recap-stat">
                <span className="recap-stat-value">{recap.tasks.overdueCount}</span>
                <span className="recap-stat-label">Overdue</span>
              </div>
            </div>
            {recap.tasks.dueThisPeriod.length > 0 ? (
              <ul className="recap-list">
                {recap.tasks.dueThisPeriod.map((task, index) => (
                  <li key={index}>
                    <span>
                      {task.title}
                      {task.assignee ? ` · ${task.assignee}` : ''}
                    </span>
                    <span
                      className={
                        task.done
                          ? 'recap-badge recap-badge-done'
                          : task.overdue
                            ? 'recap-badge recap-badge-overdue'
                            : 'recap-badge'
                      }
                    >
                      {task.done ? 'Done' : task.overdue ? 'Overdue' : `Due ${task.dueDate}`}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted-text">No tasks due this period.</p>
            )}
          </section>

          {/* Sales tax */}
          <section className="panel recap-card">
            <h3>Sales tax</h3>
            <p className="recap-tax-status">
              Filing status:{' '}
              <span
                className={
                  recap.salesTax.status === 'done'
                    ? 'recap-badge recap-badge-done'
                    : recap.salesTax.status === 'overdue'
                      ? 'recap-badge recap-badge-overdue'
                      : 'recap-badge'
                }
              >
                {SALES_TAX_LABELS[recap.salesTax.status]}
              </span>
              {recap.salesTax.dueDate ? (
                <span className="muted-text"> · due {recap.salesTax.dueDate}</span>
              ) : null}
            </p>
            {recap.salesTax.figures ? (
              <SalesTaxEditor
                key={`${recap.client.id}:${recap.periodType}:${recap.period}`}
                clientId={recap.client.id}
                periodType={recap.periodType}
                period={recap.period}
                figures={recap.salesTax.figures}
                editable={ownerMode}
                onSaved={refresh}
              />
            ) : ownerMode ? null : (
              <p className="muted-text">Recorded figures are visible to the owner only.</p>
            )}
          </section>

          {/* Billing (owner only) */}
          {recap.billing ? (
            <section className="panel recap-card">
              <h3>Billing</h3>
              <div className="recap-stats">
                <div className="recap-stat">
                  <span className="recap-stat-value">{money(recap.billing.revenue)}</span>
                  <span className="recap-stat-label">Revenue this period</span>
                </div>
                <div className="recap-stat">
                  <span className="recap-stat-value">
                    {recap.billing.billingMode === 'hourly'
                      ? `${money(recap.billing.hourlyRate)}/h`
                      : `${money(recap.billing.monthlyRate)}/mo`}
                  </span>
                  <span className="recap-stat-label">
                    {recap.billing.billingMode === 'hourly' ? 'Hourly rate' : 'Monthly rate'}
                  </span>
                </div>
                <div className="recap-stat">
                  <span className="recap-stat-value">{money(recap.billing.reimbursementTotal)}</span>
                  <span className="recap-stat-label">Reimbursements</span>
                </div>
              </div>
              {recap.billing.planNames.length > 0 ? (
                <p className="muted-text">Plans: {recap.billing.planNames.join(', ')}</p>
              ) : null}
              {recap.billing.reimbursements.length > 0 ? (
                <ul className="recap-list">
                  {recap.billing.reimbursements.map((r, index) => (
                    <li key={index}>
                      <span>
                        {r.date} · {r.description}
                      </span>
                      <span>{money(r.amount)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}

          {/* Profitability (owner only) */}
          {recap.profitability ? (
            <section className="panel recap-card">
              <h3>Profitability</h3>
              <div className="recap-stats">
                <div className="recap-stat">
                  <span className="recap-stat-value">{money(recap.profitability.realizedRate)}</span>
                  <span className="recap-stat-label">Realized rate (fee ÷ hours)</span>
                </div>
                <div className="recap-stat">
                  <span className="recap-stat-value">
                    {recap.profitability.marginAvailable ? money(recap.profitability.margin) : '—'}
                  </span>
                  <span className="recap-stat-label">Margin</span>
                </div>
              </div>
              {!recap.profitability.marginAvailable ? (
                <p className="muted-text">
                  Set cost rates for the team members on this client (Team page) to see margin.
                </p>
              ) : null}
            </section>
          ) : null}
        </>
      ) : null}
    </section>
  )
}

function SalesTaxEditor({
  clientId,
  periodType,
  period,
  figures,
  editable,
  onSaved,
}: {
  clientId: string
  periodType: ClientRecapPeriodType
  period: string
  figures: SalesTaxFigures
  editable: boolean
  onSaved: () => void
}) {
  const toStr = (n: number | null) => (n == null ? '' : String(n))
  const [taxableSales, setTaxableSales] = useState(toStr(figures.taxableSales))
  const [taxCollected, setTaxCollected] = useState(toStr(figures.taxCollected))
  const [taxOwed, setTaxOwed] = useState(toStr(figures.taxOwed))
  const [notes, setNotes] = useState(figures.notes)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')

  if (!editable) {
    return (
      <div className="recap-stats">
        <div className="recap-stat">
          <span className="recap-stat-value">{money(figures.taxableSales)}</span>
          <span className="recap-stat-label">Taxable sales</span>
        </div>
        <div className="recap-stat">
          <span className="recap-stat-value">{money(figures.taxCollected)}</span>
          <span className="recap-stat-label">Tax collected</span>
        </div>
        <div className="recap-stat">
          <span className="recap-stat-value">{money(figures.taxOwed)}</span>
          <span className="recap-stat-label">Tax owed</span>
        </div>
      </div>
    )
  }

  const num = (s: string) => (s.trim() === '' ? null : Number(s))
  const handleSave = async () => {
    setSaving(true)
    setStatus('')
    try {
      await saveSalesTaxRecord({
        clientId,
        periodType,
        period,
        taxableSales: num(taxableSales),
        taxCollected: num(taxCollected),
        taxOwed: num(taxOwed),
        notes: notes.trim(),
      })
      setStatus('Saved')
      onSaved()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="recap-tax-form">
      <label className="field">
        <span>Taxable sales</span>
        <input
          className="input"
          type="number"
          min="0"
          step="0.01"
          value={taxableSales}
          onChange={(event) => setTaxableSales(event.target.value)}
        />
      </label>
      <label className="field">
        <span>Tax collected</span>
        <input
          className="input"
          type="number"
          min="0"
          step="0.01"
          value={taxCollected}
          onChange={(event) => setTaxCollected(event.target.value)}
        />
      </label>
      <label className="field">
        <span>Tax owed</span>
        <input
          className="input"
          type="number"
          min="0"
          step="0.01"
          value={taxOwed}
          onChange={(event) => setTaxOwed(event.target.value)}
        />
      </label>
      <label className="field recap-tax-notes">
        <span>Notes</span>
        <input
          className="input"
          type="text"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </label>
      <div className="recap-tax-save">
        <button type="button" className="primary-action" disabled={saving} onClick={() => void handleSave()}>
          {saving ? 'Saving…' : 'Save figures'}
        </button>
        {status ? <span className="muted-text">{status}</span> : null}
      </div>
    </div>
  )
}
