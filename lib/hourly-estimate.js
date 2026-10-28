/**
 * THE estimated monthly invoice for an hourly client: the estimated hours the
 * client page records (one number per role) priced at that role's bill rate.
 *
 * One function so the two places that quote this figure can never disagree: the
 * Billing tab's "Estimated monthly invoice" line (featreq-a9de307f) and the
 * Client Recap's estimated revenue / projected end-of-month invoice
 * (featreq-2ce41d5f). Pure: no store access, no clock.
 *
 * An estimate says "10 Bookkeeper hours", never "10 hours of Lisa", so a rate
 * has to be resolved from people. Most specific first (this is the rule the
 * recap has always used; it moved here unchanged):
 *
 *   1. the client's ASSIGNED team in that role - the people planned to do the
 *      work, so their rate is the defensible price of the plan;
 *   2. failing that, whoever actually LOGGED time in that role this period
 *      (`loggedEmployeeIds`, passed by the recap; the Billing tab has none);
 *   3. failing that, the client's own `hourlyRate`, exactly as invoices fall
 *      back.
 *
 * Several people at different rates AVERAGE (plain mean). Each person's rate is
 * `billRateAt` through the client's pinned rate period (an unpinned client
 * resolves at `period` itself) - the one chain the invoice bills by.
 */

import { assignedTeamIds } from './data-scope.js'
import { billRateAt, ratePeriodAsOf } from './rate-history.js'
import { recapStaffTier } from './staff-tiers.js'

/** Which client field holds each role's estimated monthly hours. */
export const RECAP_TIER_ESTIMATE_FIELD = {
  CFO: 'estimatedCfoHours',
  Accountant: 'estimatedAccountantHours',
  Bookkeeper: 'estimatedBookkeeperHours',
}

/** The roles an estimate can be set for, in the fixed display order. */
export const ESTIMATE_TIERS = ['CFO', 'Accountant', 'Bookkeeper']

const isNumber = (n) => typeof n === 'number' && Number.isFinite(n)

/** Money to two decimals; never -0 (same rule as the recap's own round2). */
const round2 = (n) => {
  const hundredths = Math.round(n * 100)
  return hundredths === 0 ? 0 : hundredths / 100
}

/**
 * @param {object} opts
 * @param {object} opts.client
 * @param {Array}  opts.employees          [{ id, role, billRate? }]
 * @param {Array}  [opts.billRateVersions] dated bill rates (lib/rate-history.js)
 * @param {string} opts.period             'YYYY-MM' the estimate is priced in
 * @param {number} [opts.months]           1 for a month; the recap passes 3 / 12
 * @param {string[]} [opts.loggedEmployeeIds]  who logged time (rule 2 above)
 * @returns {{
 *   total: number,
 *   hasEstimate: boolean,
 *   basis: 'rates' | 'client_rate' | 'none',
 *   tiers: Array<{ tier: string, hours: number, hasEstimate: boolean, rate: number | null,
 *                  amount: number, employeeCount: number,
 *                  source: 'assigned' | 'logged' | 'client_rate' | null }>,
 * }}
 */
export function estimatedMonthlyInvoice({
  client,
  employees = [],
  billRateVersions = [],
  period,
  months = 1,
  loggedEmployeeIds = [],
}) {
  const employeeById = new Map((employees ?? []).map((e) => [e.id, e]))
  const tierOf = (id) => recapStaffTier(employeeById.get(id)?.role)
  const ratePeriod = ratePeriodAsOf(client, period)
  const rateOf = (id) =>
    billRateAt(billRateVersions, employeeById.get(id) ?? { id }, ratePeriod, period)
  const clientRate = Number(client?.hourlyRate) || 0
  const assigned = assignedTeamIds(client)

  const meanRate = (ids) => {
    const rates = [...new Set(ids)].map(rateOf).filter(isNumber)
    if (rates.length === 0) return null
    return { rate: rates.reduce((sum, r) => sum + r, 0) / rates.length, count: rates.length }
  }

  let exactTotal = 0
  let anyEstimate = false
  let anyEmployeeRate = false
  const tiers = ESTIMATE_TIERS.map((tier) => {
    const field = RECAP_TIER_ESTIMATE_FIELD[tier]
    const perMonth = isNumber(client?.[field]) ? client[field] : null
    const hours = perMonth === null ? 0 : round2(perMonth * months)
    const fromAssigned = meanRate(assigned.filter((id) => tierOf(id) === tier))
    const fromLogged = fromAssigned
      ? null
      : meanRate(loggedEmployeeIds.filter((id) => tierOf(id) === tier))
    const found = fromAssigned ?? fromLogged
    const rate = found ? found.rate : clientRate
    if (found) anyEmployeeRate = true
    if (perMonth !== null) {
      anyEstimate = true
      exactTotal += hours * rate
    }
    return {
      tier,
      hours,
      hasEstimate: perMonth !== null,
      rate: found || clientRate > 0 ? rate : null,
      amount: round2(hours * rate),
      employeeCount: found ? found.count : 0,
      source: fromAssigned ? 'assigned' : fromLogged ? 'logged' : clientRate > 0 ? 'client_rate' : null,
    }
  })

  return {
    // The whole is rounded once from exact products (not the sum of rounded
    // rows) - the recap's long-standing rule, so its figure does not move.
    total: round2(exactTotal),
    hasEstimate: anyEstimate,
    basis: anyEmployeeRate ? 'rates' : clientRate > 0 ? 'client_rate' : 'none',
    tiers,
  }
}
