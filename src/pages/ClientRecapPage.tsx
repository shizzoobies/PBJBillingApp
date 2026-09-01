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
import { ApiError } from '../lib/types'
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

/** Her header note, verbatim intent: "Billing Type: Subscription/Hourly". */
const BILLING_TYPE_LABEL: Record<string, string> = {
  hourly: 'Hourly',
  subscription: 'Monthly subscription',
  annual: 'Annual',
}

/** The word for a period in a sentence — "a yearly review of one client". */
const PERIOD_ADJECTIVE: Record<ClientRecapPeriodType, string> = {
  month: 'monthly',
  quarter: 'quarterly',
  year: 'yearly',
}

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

/**
 * Green/red is chosen by what the row MEANS, never by the sign: hours over plan
 * is bad news, profit over plan is good news, and the same '+' leads both.
 * `goodDirection` says which way is the good way for this row.
 */
const varianceClass = (direction: ClientRecapDirection, goodDirection: 'over' | 'under') => {
  if (direction == null || direction === 'on') return 'recap-variance-none'
  return direction === goodDirection ? 'recap-variance-good' : 'recap-variance-bad'
}

/**
 * The OVER/UNDER cell, said the same way everywhere it appears.
 *
 * A null delta is an em dash and nothing else — no zero, no color, no
 * direction. Nothing is ever compared against an estimate nobody entered.
 */
const varianceText = (
  delta: number | null,
  direction: ClientRecapDirection,
  format: (value: number) => string,
) => {
  if (delta == null) return '—'
  if (direction === 'on') return 'On estimate'
  return `${signed(delta, format)} ${direction}`
}

/** "(monthly estimates × 3 months)" — empty for a monthly recap. */
const scaledEstimateNote = (monthsInPeriod: number) =>
  monthsInPeriod > 1 ? ` (monthly estimates × ${monthsInPeriod} months)` : ''

/**
 * What a billing master's roll-up will NOT add up, and why — one line each.
 *
 * These are the two figures `buildMasterRecap` returns as null on purpose. They
 * render as em dashes WITH the reason rather than being left out: a missing
 * card reads as a page that failed to load, and a zero would be a lie. The
 * wording matches the reasoning recorded beside the nulls in lib/client-recap.js
 * — if that ever changes, change it in both places.
 */
/**
 * Refusals from the recap route that are STATES, not failures — each shown as a
 * quiet notice carrying the server's own sentence, never in the alarm styling.
 *
 *   `master_without_subs`     (409) a billing master with nothing pointed at it.
 *                             Misconfigured; the fix is to point a company at it.
 *   `master_subs_not_visible` (403) a bookkeeper who is assigned some of the
 *                             group but not all of it. A partial roll-up would
 *                             be a worse answer than none — it would look like
 *                             the whole group's numbers. Partial assignment is a
 *                             normal way for a workspace to be arranged, so this
 *                             is not that person doing anything wrong.
 *
 * Matched on the CODE, never on the sentence: the wording is the server's to
 * reword, and matching on it would break silently the first time it changed.
 * Anything not listed here is a real error and is styled like one.
 */
const RECAP_NOTICE_CODES: ReadonlySet<string> = new Set([
  'master_without_subs',
  'master_subs_not_visible',
])

const MASTER_NOT_ROLLED_UP: ReadonlyArray<{ label: string; reason: string }> = [
  {
    label: 'Sales tax',
    reason:
      'A filing per company, each with its own status and due date — four of them do not add into one. Each company’s own recap carries theirs.',
  },
  {
    label: 'Projected end-of-month invoice',
    reason:
      'A projection carries a basis — actual, hourly, plan — and the companies can be on different ones, so a single figure would need a method sentence describing a mixture. Each company’s own recap carries theirs.',
  },
]

export function ClientRecapPage() {
  const { visibleClients } = useAppContext()
  const [clientId, setClientId] = useState(visibleClients[0]?.id ?? '')
  const [periodType, setPeriodType] = useState<ClientRecapPeriodType>('month')
  const [period, setPeriod] = useState(() => currentReviewPeriod('month'))
  const [recap, setRecap] = useState<ClientRecap | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  /**
   * Not a failure — a legitimate state the page can name. Held apart from
   * `error` so it renders as a quiet notice rather than in the alarm styling
   * something that actually broke gets. Neither of these is fixed by retrying.
   *
   * See {@link RECAP_NOTICE_CODES}.
   */
  const [notice, setNotice] = useState('')

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
      setNotice('')
      try {
        const result = await fetchClientRecap(effectiveClientId, periodType, period)
        if (!cancelled) setRecap(result)
      } catch (err) {
        if (cancelled) return
        // The old recap must not stay on screen under a message about a
        // different client — it would read as that client's numbers.
        setRecap(null)
        if (err instanceof ApiError && err.code && RECAP_NOTICE_CODES.has(err.code)) {
          setNotice(err.message)
          return
        }
        setError(err instanceof Error ? err.message : 'Failed to load recap')
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
              {recap?.isBillingMaster
                ? `A ${PERIOD_ADJECTIVE[periodType]} roll-up of ${
                    recap.subs?.length ?? 0
                  } companies.`
                : `A ${PERIOD_ADJECTIVE[periodType]} review of one client.`}
            </p>
            {/* Which way this client bills, right in the header — her margin
                note on the sent-back printout. A master has no mode of its own
                (billingMode null), so it says nothing rather than inventing. */}
            {recap?.client.billingMode ? (
              <p className="muted-text" style={{ margin: '2px 0 0' }}>
                Billing type: {BILLING_TYPE_LABEL[recap.client.billingMode] ?? recap.client.billingMode}
              </p>
            ) : null}
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

          {/* Monthly / Quarterly / Yearly. The prev/next arrows below step by
              whichever one is active — a month, a quarter, or a whole year. */}
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
            <button
              type="button"
              className={periodType === 'year' ? 'is-active' : ''}
              onClick={() => changePeriodType('year')}
            >
              Yearly
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
      {notice ? (
        <section className="panel recap-card">
          <p className="empty-state">{notice}</p>
        </section>
      ) : null}

      {recap && !loading ? (
        <>
          {/* SECTION ORDER IS THE OWNER'S, off her marked-up printout: hours,
              then the money, then the workflow. Tasks & workflow sits LAST —
              it used to be second, above Billing, and she moved it to the
              bottom because a recap is read for the numbers first. */}
          {/* A billing master's page opens by saying WHOSE numbers these are.
              Every figure below is these companies' figures added — the roll-up
              never re-derives anything from rows — so the list belongs above
              them, not in a footnote under them. */}
          {recap.isBillingMaster ? (
            <MasterSubsCard subs={recap.subs ?? []} onOpenSub={setClientId} />
          ) : null}

          <TimeAndHoursCard
            time={recap.time}
            monthsInPeriod={recap.monthsInPeriod}
            estimates={recap.estimates}
          />

          {/* Billing (owner only) */}
          {recap.billing ? (
            <section className="panel recap-card">
              <h3>Billing</h3>
              {/* Her tiles, off the sent-back printout: Estimated Invoice |
                  Actual Invoice | Over/Under. Service revenue on both sides —
                  reimbursements are excluded from both, and keep their own
                  line + list below. Over on revenue is the good direction. */}
              <div className="recap-stats">
                <div className="recap-stat">
                  <span className="recap-stat-value">
                    {money(recap.estimates?.profit.estimatedRevenue)}
                  </span>
                  <span className="recap-stat-label">Estimated invoice</span>
                </div>
                <div className="recap-stat">
                  <span className="recap-stat-value">{money(recap.billing.revenue)}</span>
                  <span className="recap-stat-label">Actual invoice</span>
                </div>
                <div className="recap-stat">
                  <span
                    className={
                      'recap-stat-value ' +
                      varianceClass(recap.estimates?.profit.revenueDirection ?? null, 'over')
                    }
                  >
                    {varianceText(
                      recap.estimates?.profit.revenueDelta ?? null,
                      recap.estimates?.profit.revenueDirection ?? null,
                      money,
                    )}
                  </span>
                  <span className="recap-stat-label">Over/Under</span>
                </div>
              </div>
              {recap.billing.planNames.length > 0 ? (
                <p className="muted-text">Plans: {recap.billing.planNames.join(', ')}</p>
              ) : null}
              {/* The reimbursements tile is gone; the figure is not. */}
              <p className="muted-text">
                Reimbursements this period: {money(recap.billing.reimbursementTotal)} — excluded
                from the invoice figures above.
              </p>
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
              {/* A multi-month period reprices every month at the client's
                  CURRENT rates and plans — no rate history is kept — so a rate
                  change part-way through will not reconcile against the
                  invoices that were actually issued. Say it rather than let her
                  find it. */}
              {recap.monthsInPeriod > 1 ? (
                <p className="recap-estimate-caption">
                  Priced at the client's current rates and plans, not the rates in force each
                  month. A rate or plan change part-way through the{' '}
                  {recap.periodType === 'year' ? 'year' : 'quarter'} is applied to all{' '}
                  {recap.monthsInPeriod} months, so this can differ from the invoices actually
                  issued.
                </p>
              ) : null}
            </section>
          ) : null}

          {/* Profitability (owner only) */}
          {recap.profitability ? (
            <ProfitabilityCard
              profitability={recap.profitability}
              estimates={recap.estimates}
              monthsInPeriod={recap.monthsInPeriod}
            />
          ) : null}

          {/* Projected invoice (owner only, monthly only) */}
          {recap.projection ? <ProjectionCard projection={recap.projection} /> : null}

          {/* What the roll-up declines to add, said out loud. Only on a master:
              on an ordinary client these figures are simply present. */}
          {recap.isBillingMaster ? <MasterNotRolledUpCard /> : null}

          {/* Tasks & workflow — last on the page, by request. */}
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
        </>
      ) : null}
    </section>
  )
}

/**
 * The companies behind a billing master's roll-up, each a way into its own
 * recap.
 *
 * Every figure on this page is these companies' figures ADDED — nothing here is
 * computed from their rows a second time — so "how did we get this number?" is
 * answered by opening the company, not by a formula. That is what the buttons
 * are for: they move the picker at the top of the page, which is the only
 * client selector this page has.
 *
 * A sub with no id cannot be opened (a company deleted while its recap stood);
 * it stays listed, because the roll-up above it still counted its work.
 */
export function MasterSubsCard({
  subs,
  onOpenSub,
}: {
  subs: NonNullable<ClientRecap['subs']>
  onOpenSub: (clientId: string) => void
}) {
  return (
    <section className="panel recap-card">
      <h3>Companies in this roll-up</h3>
      {subs.length === 0 ? (
        // A master with no companies pointed at it is misconfigured, not empty.
        <p className="muted-text">
          No companies point at this billing master yet, so there is nothing to add up.
        </p>
      ) : (
        <ul className="recap-list recap-subs">
          {subs.map((sub, index) => (
            <li key={sub.id ?? `sub-${index}`}>
              <span>{sub.name}</span>
              {sub.id ? (
                <button
                  type="button"
                  className="recap-sub-open"
                  onClick={() => onOpenSub(sub.id as string)}
                >
                  Open {sub.name}&rsquo;s recap
                </button>
              ) : (
                <span className="muted-text">No longer on file</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * The two figures a roll-up will not add, each with the reason it will not.
 *
 * An em dash and a sentence, never a zero and never an omission — see
 * {@link MASTER_NOT_ROLLED_UP}. Both are real per-company facts that live on
 * the companies' own recaps, which the card above links to.
 */
export function MasterNotRolledUpCard() {
  return (
    <section className="panel recap-card">
      <h3>Not rolled up</h3>
      <table className="report-table">
        <thead>
          <tr>
            <th>Figure</th>
            <th>Combined</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          {MASTER_NOT_ROLLED_UP.map((row) => (
            <tr key={row.label}>
              <td>{row.label}</td>
              <td>—</td>
              <td className="muted-text">{row.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

/**
 * Time & hours: ESTIMATE | ACTUAL | OVER/UNDER, one row per role, with a Total.
 *
 * This replaced four stat tiles — total, billable, administrative, vs. prior —
 * that the firm owner struck out on the printed recap. None of them answered
 * the question she opens the page with, which is whether the work is running to
 * plan and for whom.
 *
 * Rows are per ROLE because that is the grain the estimate is set at (the client
 * has Estimated monthly hours for CFO / Accountant / Bookkeeper, not per
 * person), and each row is NAMED by whoever fills that role — which reads as
 * one person per row, the way she drew it, because that is what a role usually
 * is. Nothing is split between two people on a guess.
 *
 * Everything on screen adds up: a role's actual is its people's printed hours
 * added, the Total is the roles added, and every over/under is that row's
 * actual minus that row's estimate. See lib/client-recap.js for the arithmetic.
 */
export function TimeAndHoursCard({
  time,
  monthsInPeriod,
  estimates = null,
}: {
  time: ClientRecap['time']
  monthsInPeriod: number
  /**
   * Owner payloads only — adds the Cost estimate | Actual | Over/Under columns
   * from her sent-back markup. Null (a staff payload) renders the hours-only
   * table exactly as before: cost columns are money, and money is owner-side.
   */
  estimates?: ClientRecapEstimates | null
}) {
  const { roleTotals } = time
  // Joined by tier — estimates.byTier is byRole priced, same rows, same order.
  const costByTier = new Map((estimates?.byTier ?? []).map((row) => [row.tier, row]))
  const showCost = estimates != null
  return (
    <section className="panel recap-card">
      <h3>Time &amp; hours</h3>

      {/* The honest-empty case is the COMMON one — most clients have no
          estimate on file — so it gets a banner that says where to fix it,
          not an error and not a silent column of dashes.

          Gated on `estimatesVisible`: a staff payload dashes the estimate
          columns because estimates are owner-side planning data, which is a
          different thing from "nobody has set any", and telling a staff member
          to go edit the Client page would be a dead end. */}
      {time.estimatesVisible && !time.hasEstimate ? (
        <p className="recap-estimate-banner">
          No estimate set for this client — the actual hours below are reported on their own. Set
          them on the {time.whereToSetEstimates} to compare plan against reality here.
        </p>
      ) : null}

      {time.byRole.length > 0 ? (
        <table className="report-table">
          <thead>
            <tr>
              <th>Team member</th>
              <th>Estimate{scaledEstimateNote(monthsInPeriod)}</th>
              <th>Actual</th>
              <th>Over/Under</th>
              {showCost ? (
                <>
                  {/* Her headers, verbatim: Cost Estimate | Actual | Over/Under. */}
                  <th>Cost estimate</th>
                  <th>Cost actual</th>
                  <th>Cost over/under</th>
                </>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {/* Server order is the display order: CFO tier, then Accountant,
                then Bookkeeper, then anything unmapped. Do NOT sort here. */}
            {time.byRole.map((row) => (
              <tr key={row.tier}>
                <td>
                  {row.people.length > 0 ? (
                    row.people.join(', ')
                  ) : (
                    <span className="muted-text">No time logged</span>
                  )}{' '}
                  <span className="recap-staff-tier">{row.tier}</span>
                </td>
                <td>
                  {row.estimatedHours == null ? (
                    <span className="muted-text">No estimate set</span>
                  ) : (
                    hrs(row.estimatedHours)
                  )}
                </td>
                <td>{hrs(row.actualHours)}</td>
                <td className={varianceClass(row.direction, 'under')}>
                  {varianceText(row.deltaHours, row.direction, hrs)}
                </td>
                {showCost
                  ? (() => {
                      const cost = costByTier.get(row.tier)
                      return (
                        <>
                          <td>
                            {cost?.estimatedCost == null ? (
                              <span className="muted-text">—</span>
                            ) : (
                              money(cost.estimatedCost)
                            )}
                          </td>
                          <td>{money(cost?.actualCost ?? 0)}</td>
                          {/* Under on cost is the good direction — spent less
                              than planned — mirroring the hours column. */}
                          <td className={varianceClass(cost?.costDirection ?? null, 'under')}>
                            {varianceText(cost?.costDelta ?? null, cost?.costDirection ?? null, money)}
                          </td>
                        </>
                      )
                    })()
                  : null}
              </tr>
            ))}
            <tr className="recap-total-row">
              <td>
                <strong>Total</strong>
              </td>
              <td>
                {roleTotals.estimatedHours == null ? (
                  <span className="muted-text">No estimate set</span>
                ) : (
                  <strong>{hrs(roleTotals.estimatedHours)}</strong>
                )}
              </td>
              <td>
                <strong>{hrs(roleTotals.actualHours)}</strong>
              </td>
              <td className={varianceClass(roleTotals.direction, 'under')}>
                <strong>
                  {varianceText(roleTotals.deltaHours, roleTotals.direction, hrs)}
                </strong>
              </td>
              {showCost && estimates ? (
                <>
                  <td>
                    {estimates.cost.estimated == null ? (
                      <span className="muted-text">—</span>
                    ) : (
                      <strong>{money(estimates.cost.estimated)}</strong>
                    )}
                  </td>
                  <td>
                    <strong>{money(estimates.cost.actual)}</strong>
                  </td>
                  <td className={varianceClass(estimates.cost.direction, 'under')}>
                    <strong>
                      {varianceText(estimates.cost.delta, estimates.cost.direction, money)}
                    </strong>
                  </td>
                </>
              ) : null}
            </tr>
          </tbody>
        </table>
      ) : (
        <p className="muted-text">No time logged this period.</p>
      )}

      {showCost ? (
        <p className="recap-estimate-caption">{LABOR_COST_BASIS_NOTE}</p>
      ) : null}

      {/* Said out loud rather than left to be spotted: unplanned work still
          counts as over plan in the Total, which is why the Total's variance
          can be bigger than the rows above it add to. */}
      {time.unestimatedRoles.length > 0 && time.hasEstimate ? (
        <p className="recap-estimate-caption">
          {time.unestimatedRoles.join(', ')} {time.unestimatedRoles.length === 1 ? 'has' : 'have'}{' '}
          hours but no estimate, so those hours show no variance of their own and still count
          toward the Total's over/under.
        </p>
      ) : null}
    </section>
  )
}

/**
 * Profitability: ESTIMATE | ACTUAL | OVER/UNDER for profit.
 *
 * The realized-rate and margin tiles are gone — the owner struck both out and
 * wrote the three columns over them. Margin has not disappeared with the tile:
 * it IS the Actual column here, the same `revenue − labor cost` figure it
 * always was, now standing next to the plan it is supposed to be judged
 * against.
 *
 * `estimates` is null only on a payload with no financials, which cannot reach
 * this card (it renders behind `profitability`); the guard keeps the actual
 * column truthful rather than the component optional.
 */
export function ProfitabilityCard({
  profitability,
  estimates,
  monthsInPeriod,
}: {
  profitability: NonNullable<ClientRecap['profitability']>
  estimates: ClientRecapEstimates | null
  monthsInPeriod: number
}) {
  const profit = estimates?.profit ?? null
  return (
    <section className="panel recap-card">
      <h3>Profitability</h3>
      <table className="report-table">
        <thead>
          <tr>
            <th>Profit</th>
            <th>Estimate{scaledEstimateNote(monthsInPeriod)}</th>
            <th>Actual</th>
            <th>Over/Under</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Profit this period</td>
            <td>
              {profit?.estimatedProfit == null ? (
                <span className="muted-text">No estimate set</span>
              ) : (
                money(profit.estimatedProfit)
              )}
            </td>
            <td>{money(profitability.margin)}</td>
            <td className={varianceClass(profit?.direction ?? null, 'over')}>
              {varianceText(profit?.delta ?? null, profit?.direction ?? null, money)}
            </td>
          </tr>
        </tbody>
      </table>

      {/* The definitions, on screen, because a profit figure nobody can restate
          is a figure nobody trusts. */}
      <p className="recap-estimate-caption">
        Estimated profit = expected revenue
        {profit?.estimatedRevenue == null ? '' : ` (${money(profit.estimatedRevenue)})`} − estimated
        cost
        {profit?.estimatedCost == null ? '' : ` (${money(profit.estimatedCost)})`}, where estimated
        cost is each role's estimated hours × that role's cost rate. Actual profit = invoiced
        service revenue ({money(profit?.actualRevenue ?? null)}) − actual labor cost (
        {money(profitability.laborCost)}) — the Billing panel's revenue, priced against the hours in
        the table above. Reimbursements are excluded from both sides. {LABOR_COST_BASIS_NOTE}
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
