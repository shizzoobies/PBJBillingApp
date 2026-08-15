import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAppContext } from '../AppContext'
import {
  fetchClientRecap,
  type ClientRecap,
  type ClientRecapDirection,
  type ClientRecapEstimates,
  type ClientRecapPeriodType,
  type ClientRecapProjection,
} from '../lib/api'
import { currentReviewPeriod, formatDecimalHours, shiftReviewPeriod } from '../lib/utils'

const money = (n: number | null | undefined) =>
  n == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
/**
 * Always x.xx. The recap reports HOURS (the payroll report reports minutes), so
 * convert back to minutes for the shared formatter rather than keeping a second
 * two-decimal rule here that could drift from it.
 */
const hrs = (n: number) => formatDecimalHours(n * 60)
const signed = (n: number, format: (value: number) => string) =>
  `${n > 0 ? '+' : ''}${format(n)}`

/**
 * Green/red is chosen by what the row MEANS, never by the sign: hours over plan
 * is bad news, profit over plan is good news, and the same '+' leads both.
 * `goodDirection` says which way is the good way for this row.
 */
/**
 * Printed once on every panel that shows a cost or a profit.
 *
 * Labor cost counts whoever has a pay rate on file and nobody else — the owner
 * draws no hourly wage, so her time adds no cost, and a client she works alone
 * shows its full fee as profit. That is the intended reading, but it is not a
 * guessable one, so it is stated rather than left to be discovered. Kept beside
 * the other captions so the wording stays in one revisable place.
 */
const LABOR_COST_BASIS_NOTE =
  'Labor cost counts team members who have a pay rate on file; owner time carries no hourly cost.'

const varianceClass = (direction: ClientRecapDirection, goodDirection: 'over' | 'under') => {
  if (direction == null || direction === 'on') return 'recap-variance-none'
  return direction === goodDirection ? 'recap-variance-good' : 'recap-variance-bad'
}

export function ClientRecapPage() {
  const { visibleClients } = useAppContext()
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
              /* Server order is the display order: CFO tier, then Accountant,
                 then Bookkeeper, by name inside a tier — the same sequence every
                 month. Do NOT sort here. A tier nobody logged time in simply
                 does not appear. */
              <ul className="recap-list">
                {recap.time.byStaff.map((row) => (
                  <li key={row.name}>
                    <span>
                      {row.name} <span className="recap-staff-tier">{row.tier}</span>
                    </span>
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
          {recap.profitability ? <ProfitabilityCard profitability={recap.profitability} /> : null}

          {/* Estimated vs. actual (owner only) */}
          {recap.estimates ? (
            <EstimateVsActualCard estimates={recap.estimates} periodType={recap.periodType} />
          ) : null}

          {/* Projected invoice (owner only, monthly only) */}
          {recap.projection ? <ProjectionCard projection={recap.projection} /> : null}
        </>
      ) : null}
    </section>
  )
}

/**
 * Realized rate and margin. Margin is always a figure now — a team member with
 * no pay rate contributes no cost rather than blanking the panel — so the note
 * explaining what labor cost counts is not optional decoration here.
 */
export function ProfitabilityCard({
  profitability,
}: {
  profitability: NonNullable<ClientRecap['profitability']>
}) {
  return (
    <section className="panel recap-card">
      <h3>Profitability</h3>
      <div className="recap-stats">
        <div className="recap-stat">
          <span className="recap-stat-value">{money(profitability.realizedRate)}</span>
          <span className="recap-stat-label">Realized rate (fee ÷ hours)</span>
        </div>
        <div className="recap-stat">
          <span className="recap-stat-value">{money(profitability.margin)}</span>
          <span className="recap-stat-label">Margin</span>
        </div>
      </div>
      <p className="recap-estimate-caption">{LABOR_COST_BASIS_NOTE}</p>
    </section>
  )
}

/**
 * Plan against reality, for hours and for profit.
 *
 * The honest-empty case is the COMMON one — most clients have no estimate on
 * file — so "No estimate set" is a first-class state here, not an error state:
 * the actual column still reports everything it knows, and nothing is ever
 * compared against a zero nobody entered.
 */
export function EstimateVsActualCard({
  estimates,
  periodType,
}: {
  estimates: ClientRecapEstimates
  periodType: ClientRecapPeriodType
}) {
  const { profit } = estimates
  const perPeriod =
    periodType === 'quarter' && estimates.monthsInPeriod > 1
      ? ` (monthly estimates × ${estimates.monthsInPeriod} months)`
      : ''

  return (
    <section className="panel recap-card">
      <h3>Estimated vs. actual</h3>
      {!estimates.hasEstimate ? (
        <p className="muted-text">
          No estimate set for this client — the actual hours below are reported on their own. Set
          them on the {estimates.whereToSet} to compare plan against reality here.
        </p>
      ) : null}

      <table className="report-table">
        <thead>
          <tr>
            <th>Role</th>
            <th>Estimated hours{perPeriod}</th>
            <th>Actual hours</th>
            <th>Difference</th>
          </tr>
        </thead>
        <tbody>
          {estimates.byTier.map((row) => (
            <tr key={row.tier}>
              <td>{row.tier}</td>
              <td>
                {row.estimatedHours == null ? (
                  <span className="muted-text">No estimate set</span>
                ) : (
                  hrs(row.estimatedHours)
                )}
              </td>
              <td>{hrs(row.actualHours)}</td>
              <td className={varianceClass(row.direction, 'under')}>
                {row.deltaHours == null
                  ? '—'
                  : row.direction === 'on'
                    ? 'On estimate'
                    : `${signed(row.deltaHours, hrs)} ${row.direction}`}
              </td>
            </tr>
          ))}
          {estimates.byTier.length > 0 ? (
            <tr>
              <td>
                <strong>Total</strong>
              </td>
              <td>
                {estimates.hours.estimated == null ? (
                  <span className="muted-text">No estimate set</span>
                ) : (
                  <strong>{hrs(estimates.hours.estimated)}</strong>
                )}
              </td>
              <td>
                <strong>{hrs(estimates.hours.actual)}</strong>
              </td>
              <td className={varianceClass(estimates.hours.direction, 'under')}>
                {estimates.hours.delta == null
                  ? '—'
                  : estimates.hours.direction === 'on'
                    ? 'On estimate'
                    : `${signed(estimates.hours.delta, hrs)} ${estimates.hours.direction}`}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <div className="recap-stats" style={{ marginTop: 14 }}>
        <div className="recap-stat">
          <span className="recap-stat-value">
            {profit.estimatedProfit == null ? '—' : money(profit.estimatedProfit)}
          </span>
          <span className="recap-stat-label">
            {profit.estimatedProfit == null ? 'Estimated profit — no estimate set' : 'Estimated profit'}
          </span>
        </div>
        <div className="recap-stat">
          <span className="recap-stat-value">{money(profit.actualProfit)}</span>
          <span className="recap-stat-label">Actual profit</span>
        </div>
        <div className="recap-stat">
          <span className={`recap-stat-value ${varianceClass(profit.direction, 'over')}`}>
            {profit.delta == null ? '—' : signed(profit.delta, (n) => money(n))}
          </span>
          <span className="recap-stat-label">Difference</span>
        </div>
      </div>

      {/* The definitions, on screen, because a profit figure nobody can restate
          is a figure nobody trusts. */}
      <p className="recap-estimate-caption">
        Estimated profit = expected revenue{' '}
        {profit.estimatedRevenue == null ? '' : `(${money(profit.estimatedRevenue)}) `}− estimated
        cost{' '}
        {profit.estimatedCost == null ? '' : `(${money(profit.estimatedCost)}) `}, where estimated
        cost is each role's estimated hours × that role's cost rate. Actual profit = invoiced
        service revenue ({money(profit.actualRevenue)}) − actual labor cost (
        {money(profit.actualCost)}), the same figures the Billing and Profitability panels show.
        Reimbursements are excluded from both sides. {LABOR_COST_BASIS_NOTE}
      </p>
    </section>
  )
}

/**
 * The projected invoice. Its whole job is to be believable, so the basis line is
 * not optional decoration — it renders under the figure every time, and a
 * closed month says plainly that it is no longer a projection at all.
 */
export function ProjectionCard({ projection }: { projection: ClientRecapProjection }) {
  return (
    <section className="panel recap-card">
      <h3>
        {projection.isEstimate ? 'Projected end-of-month invoice' : 'End-of-month invoice'}
        {projection.isEstimate ? <span className="recap-badge">Estimate</span> : null}
      </h3>
      <div className="recap-stats">
        <div className="recap-stat">
          <span className="recap-stat-value">{money(projection.amount)}</span>
          <span className="recap-stat-label">
            {projection.isEstimate ? 'Projected total' : 'Invoice total'}
          </span>
        </div>
        <div className="recap-stat">
          <span className="recap-stat-value">{money(projection.serviceAmount)}</span>
          <span className="recap-stat-label">Service</span>
        </div>
        <div className="recap-stat">
          <span className="recap-stat-value">{money(projection.reimbursementsToDate)}</span>
          <span className="recap-stat-label">Reimbursements recorded</span>
        </div>
      </div>
      <p className="recap-estimate-caption">{projection.method}</p>
    </section>
  )
}
