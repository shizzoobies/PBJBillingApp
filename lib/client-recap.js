/**
 * Client Recap assembler (Client Recap page).
 *
 * Pure + deterministic: `data` is an appDataStore.read() snapshot, all dates
 * (today) are passed in, and financial gating is explicit. The caller
 * (server.js) enforces per-client access (visibleClientIdSet) and sets
 * `includeFinancials = role === 'owner'` — when false, NO revenue, margin, or
 * sales-tax dollar figures are included in the result at all (defense in depth,
 * not just hidden in the UI).
 */

import { assignedTeamIds } from './data-scope.js'
import { RECAP_STAFF_TIERS, recapStaffTier } from './staff-tiers.js'
import { buildInvoiceLines } from './invoice-lines.js'
import {
  displayHours,
  laborCost,
  personPeriodCost,
  sumDisplayHours,
  sumPersonCosts,
} from './payroll-cost.js'
import { monthsInPeriodType, periodLabel, periodRange, previousPeriod } from './periods.js'

const hoursOf = (entry) => Number(entry?.minutes || 0) / 60
/**
 * Money and ratios to two decimals.
 *
 * The `=== 0` branch is not defensive noise: `Math.round` hands back -0 for
 * anything in [-0.5, 0), and `Intl` renders that as "-$0.00" — which is exactly
 * what the Profitability panel's Actual column would print for a client whose
 * revenue and labor cost cancel to a fraction of a cent. Normalized away here
 * for the same reason `roundToCent` normalizes it in lib/payroll-cost.js.
 */
const round2 = (n) => {
  const hundredths = Math.round(n * 100)
  return hundredths === 0 ? 0 : hundredths / 100
}
/**
 * Hours for DISPLAY, rounded exactly the way `personPeriodCost` rounds the
 * hours it multiplies — an hours figure printed here must be the same figure
 * the labor cost beside it was priced from, or the recap stops reconciling by
 * hand. `round2` still handles money and ratios, which have no such contract.
 */
const hours2 = (hours) => displayHours(hours * 60)
const inRange = (date, start, end) => typeof date === 'string' && date >= start && date <= end
const isNumber = (n) => typeof n === 'number' && Number.isFinite(n)

/**
 * The role tier mapping lives in `lib/staff-tiers.js` now and is re-exported
 * here so every existing reader of `client-recap` keeps working unchanged.
 *
 * It moved when the invoice redesign needed the SAME tiers to group an
 * invoice's hours lines by role. This module cannot be the home any more: it
 * imports `buildInvoiceLines` from `./invoice-lines.js`, so invoice-lines
 * importing back would be a cycle. Copying the switch would have been worse —
 * two mappings that agree today and drift the first time a staff role is
 * added. See `lib/staff-tiers.js` for why the four names are what they are.
 */
export { RECAP_STAFF_TIERS, recapStaffTier }

const tierRank = (tier) => {
  const index = RECAP_STAFF_TIERS.indexOf(tier)
  return index === -1 ? RECAP_STAFF_TIERS.length : index
}

/**
 * Tier -> the client field holding that tier's ESTIMATED monthly hours.
 *
 * The same three tiers as {@link RECAP_STAFF_TIERS}, which is the whole point:
 * the planning fields the owner already fills in on a client map one-for-one
 * onto the tiers the recap already groups people into, so estimated and actual
 * hours can be put side by side without inventing a second grouping.
 *
 * 'Other' is deliberately absent — there is no estimate field for a person
 * whose role was never set, and inventing one would be a guess. Their actual
 * hours still show, against "No estimate set".
 *
 * The store already folds the legacy single `estimatedMonthlyHours` into
 * `estimatedBookkeeperHours` on read (db/store.js), so only these three are
 * read here.
 */
export const RECAP_TIER_ESTIMATE_FIELD = {
  CFO: 'estimatedCfoHours',
  Accountant: 'estimatedAccountantHours',
  Bookkeeper: 'estimatedBookkeeperHours',
}

/** The tiers an estimate can be set for, in the recap's fixed display order. */
export const ESTIMATE_TIERS = ['CFO', 'Accountant', 'Bookkeeper']

/**
 * Where the estimates live, said once. The Time & hours table prints this when
 * a client has none, and the (owner-only) estimates payload repeats it, so the
 * two can never point at different screens.
 */
export const WHERE_TO_SET_ESTIMATES = 'Client page → Estimated monthly hours'

/**
 * Which way a variance runs. `null` when there is nothing to compare against —
 * NEVER 'over' by default, because a missing estimate is not a zero estimate.
 */
function varianceDirection(delta) {
  if (delta == null) return null
  if (delta > 0) return 'over'
  if (delta < 0) return 'under'
  return 'on'
}

/** Mon–Fri days in an inclusive yyyy-mm-dd range. UTC, so no DST can shift it. */
function businessDaysBetween(startIso, endIso) {
  if (typeof startIso !== 'string' || typeof endIso !== 'string' || endIso < startIso) return 0
  const asUtc = (iso) => {
    const [y, m, d] = iso.split('-').map(Number)
    return Date.UTC(y, m - 1, d)
  }
  const last = asUtc(endIso)
  const cursor = new Date(asUtc(startIso))
  let count = 0
  for (let guard = 0; guard < 400 && cursor.getTime() <= last; guard += 1) {
    const day = cursor.getUTCDay()
    if (day !== 0 && day !== 6) count += 1
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return count
}

/**
 * The YYYY-MM months a recap range covers — one for a month period, three for a
 * quarter. The invoice builder works a month at a time, so revenue is summed
 * per month rather than approximated by a rate times a month count.
 */
function monthsInRange(start, end) {
  const months = []
  let year = Number(String(start).slice(0, 4))
  let month = Number(String(start).slice(5, 7))
  const last = String(end).slice(0, 7)
  for (let guard = 0; guard < 24; guard += 1) {
    const key = `${year}-${String(month).padStart(2, '0')}`
    months.push(key)
    if (key >= last) break
    month += 1
    if (month > 12) { month = 1; year += 1 }
  }
  return months
}

/**
 * Sum figures that are allowed to be MISSING.
 *
 * `null` means "there is nothing to state" — no estimate was set, no rate was
 * resolved — and it is not zero. A roll-up of four companies where three have
 * estimates should report those three rather than black the panel out (the same
 * call this file already makes for a cost rate nobody set), so nulls are
 * skipped and the answer is null only when every contributor was null. Which
 * subs came up short is reported alongside, so the shortfall is stated rather
 * than hidden — exactly what `unestimatedRoles` does one level down.
 */
const sumPresent = (values, add) => {
  const present = values.filter(isNumber)
  return present.length === 0 ? null : add(present)
}
const sumMoney = (values) => sumPresent(values, (v) => round2(v.reduce((s, n) => s + n, 0)))
const sumHours = (values) => sumPresent(values, sumDisplayHours)

/**
 * The BILLING MASTER's recap: its subs' recaps added up.
 *
 * KLC's master row holds no time, no checklists and no estimates of its own —
 * "no data entered or collected but shows data for the 4 combined", in
 * Brittany's words. So there is nothing here to compute FROM. Every figure
 * below is the sum of figures `buildClientRecap` already produced for the subs,
 * which is the ONE MONEY CALCULATOR RULE applied at this level: the roll-up
 * adds, it never re-derives from rows. Re-pricing the subs' entries here would
 * be a second implementation of the firm's cost arithmetic, and the whole point
 * of the rule is that there is only one.
 *
 * Per-sub recaps are untouched. The page shows each sub, then this.
 *
 * @param {object} args
 * @param {object} args.master        the billing-master client row
 * @param {Array<object>} [args.subRecaps]  each sub's `buildClientRecap` result,
 *   all for the SAME period, in the order they should read
 * @returns {object|null} null when there are no subs — a master with none is
 *   misconfigured, and the caller says so rather than printing a page of zeros
 */
export function buildMasterRecap({ master, subRecaps = [] }) {
  const subs = (Array.isArray(subRecaps) ? subRecaps : []).filter(Boolean)
  if (!master || subs.length === 0) return null

  const first = subs[0]
  const subLabel = (sub) => sub.client?.name ?? sub.client?.id ?? ''

  // ---- Time & hours ----
  //
  // byStaff merges by PERSON: one bookkeeper working three of the four
  // companies is one person on the master's list, with her hours added. Hours
  // are added as whole hundredths (`sumDisplayHours`), so the master's total is
  // literally the rows added up — the same contract the per-client table has.
  const staffByName = new Map()
  for (const recap of subs) {
    for (const row of recap.time?.byStaff ?? []) {
      const existing = staffByName.get(row.name)
      if (existing) {
        existing.hours.push(row.hours)
        existing.billableHours.push(row.billableHours)
      } else {
        staffByName.set(row.name, {
          name: row.name,
          tier: row.tier,
          hours: [row.hours],
          billableHours: [row.billableHours],
        })
      }
    }
  }
  const byStaff = [...staffByName.values()]
    .map((row) => ({
      name: row.name,
      tier: row.tier,
      hours: sumDisplayHours(row.hours),
      billableHours: sumDisplayHours(row.billableHours),
    }))
    .sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || a.name.localeCompare(b.name))

  // byRole merges by TIER, which is the grain an estimate is set at. A tier no
  // sub reports simply does not appear.
  const roleByTier = new Map()
  for (const recap of subs) {
    for (const row of recap.time?.byRole ?? []) {
      if (!roleByTier.has(row.tier)) {
        roleByTier.set(row.tier, { tier: row.tier, people: [], estimated: [], actual: [] })
      }
      const merged = roleByTier.get(row.tier)
      for (const person of row.people ?? []) {
        if (!merged.people.includes(person)) merged.people.push(person)
      }
      merged.estimated.push(row.estimatedHours)
      merged.actual.push(row.actualHours)
    }
  }
  const byRole = [...roleByTier.values()]
    .sort((a, b) => tierRank(a.tier) - tierRank(b.tier))
    .map((row) => {
      const estimatedHours = sumHours(row.estimated)
      const actualHours = sumHours(row.actual) ?? 0
      const deltaHours =
        estimatedHours === null ? null : sumDisplayHours([actualHours, -estimatedHours])
      return {
        tier: row.tier,
        people: row.people.sort((a, b) => a.localeCompare(b)),
        estimatedHours,
        actualHours,
        deltaHours,
        direction: varianceDirection(deltaHours),
      }
    })
  const roleEstimatedTotal = sumHours(byRole.map((row) => row.estimatedHours))
  const roleActualTotal = sumDisplayHours(byRole.map((row) => row.actualHours))
  const roleDeltaTotal =
    roleEstimatedTotal === null ? null : sumDisplayHours([roleActualTotal, -roleEstimatedTotal])
  const roleTotals = {
    estimatedHours: roleEstimatedTotal,
    actualHours: roleActualTotal,
    deltaHours: roleDeltaTotal,
    direction: varianceDirection(roleDeltaTotal),
  }

  // Financials roll up only when EVERY sub carried them. A staff payload that
  // silently reported three companies' money because the fourth was redacted
  // would be a worse leak than the one the redaction exists to prevent.
  const includeFinancials = subs.every((sub) => sub.includeFinancials)
  const estimatesVisible = subs.every((sub) => sub.time?.estimatesVisible)

  const totalHours = sumDisplayHours(subs.map((sub) => sub.time?.totalHours))
  const priorHours = sumDisplayHours(subs.map((sub) => sub.time?.priorHours))

  const dueThisPeriod = subs
    .flatMap((sub) =>
      (sub.tasks?.dueThisPeriod ?? []).map((task) => ({ ...task, client: subLabel(sub) })),
    )
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0))

  const recap = {
    client: { id: master.id, name: master.name, billingMode: master.billingMode ?? null },
    /** What tells the page this is the roll-up and not a fifth company. */
    isBillingMaster: true,
    /** The subs behind every figure, in order — the page lists them, then this. */
    subs: subs.map((sub) => ({ id: sub.client?.id ?? null, name: subLabel(sub) })),
    periodType: first.periodType,
    period: first.period,
    periodLabel: first.periodLabel,
    range: first.range,
    monthsInPeriod: first.monthsInPeriod,
    includeFinancials,
    time: {
      totalHours,
      billableHours: sumDisplayHours(subs.map((sub) => sub.time?.billableHours)),
      adminHours: sumDisplayHours(subs.map((sub) => sub.time?.adminHours)),
      priorHours,
      deltaHours: sumDisplayHours([totalHours, -priorHours]),
      byStaff,
      byRole,
      roleTotals,
      estimatesVisible,
      hasEstimate: estimatesVisible && byRole.some((row) => row.estimatedHours !== null),
      unestimatedRoles: estimatesVisible
        ? byRole
            .filter((row) => row.estimatedHours === null && row.actualHours > 0)
            .map((row) => row.tier)
        : [],
      whereToSetEstimates: WHERE_TO_SET_ESTIMATES,
    },
    tasks: {
      dueThisPeriod,
      dueCount: dueThisPeriod.length,
      completedCount: dueThisPeriod.filter((task) => task.done).length,
      overdueCount: dueThisPeriod.filter((task) => task.overdue).length,
      openCount: dueThisPeriod.filter((task) => !task.done).length,
    },
    /**
     * NOT rolled up. Sales tax is a filing per company with its own status and
     * its own due date; four of them do not add into one, and there is no
     * honest single status to print. The per-sub recaps carry theirs.
     */
    salesTax: null,
    billing: null,
    profitability: null,
    estimates: null,
    /**
     * NOT rolled up in v1. A projection carries a BASIS — actual, hourly,
     * plan, too_early — and four subs can be on four different ones, so a
     * summed amount would need a method sentence describing a mixture. The
     * master's real projected invoice is a question worth answering properly
     * rather than approximating here.
     */
    projection: null,
  }

  if (!includeFinancials) return recap

  // ---- Billing (owner only) ----
  //
  // A master has no billing machinery of its own — no mode, no rate — so those
  // fields are null rather than a copy of some sub's.
  recap.billing = {
    billingMode: null,
    hourlyRate: null,
    monthlyRate: null,
    monthsInPeriod: first.monthsInPeriod,
    planNames: [
      ...new Set(subs.flatMap((sub) => sub.billing?.planNames ?? [])),
    ],
    revenue: sumMoney(subs.map((sub) => sub.billing?.revenue)) ?? 0,
    // Tagged with the company, because "Filing fee — $50" four times over says
    // nothing on a combined page.
    reimbursements: subs.flatMap((sub) =>
      (sub.billing?.reimbursements ?? []).map((item) => ({ ...item, client: subLabel(sub) })),
    ),
    reimbursementTotal: sumMoney(subs.map((sub) => sub.billing?.reimbursementTotal)) ?? 0,
  }

  // ---- Profitability (owner only) ----
  const rolledLaborCost = sumMoney(subs.map((sub) => sub.profitability?.laborCost)) ?? 0
  recap.profitability = {
    // The one ratio here, taken from the two ROLLED-UP figures rather than from
    // anybody's rows — the same formula a sub uses, over summed inputs.
    realizedRate: totalHours > 0 ? round2(recap.billing.revenue / totalHours) : null,
    laborCost: rolledLaborCost,
    margin: sumMoney(subs.map((sub) => sub.profitability?.margin)) ?? 0,
  }

  // ---- Estimated vs. actual (owner only) ----
  const costByTier = new Map()
  for (const sub of subs) {
    for (const row of sub.estimates?.byTier ?? []) {
      if (!costByTier.has(row.tier)) costByTier.set(row.tier, { estimated: [], actual: [] })
      costByTier.get(row.tier).estimated.push(row.estimatedCost)
      costByTier.get(row.tier).actual.push(row.actualCost)
    }
  }
  const byTier = byRole.map((row) => {
    const costs = costByTier.get(row.tier) ?? { estimated: [], actual: [] }
    return {
      ...row,
      // A RATE cannot be rolled up: averaging four companies' resolved rates
      // would invent a fifth number nobody pays. The costs beside it are real
      // sums; the rate that produced them is a per-company fact.
      costRate: null,
      costRateBasis: null,
      costRatePeopleCount: 0,
      estimatedCost: sumMoney(costs.estimated),
      actualCost: sumMoney(costs.actual) ?? 0,
    }
  }).map((row) => {
    // Same derivation as a sub's rows: subtraction of two already-summed
    // figures, not a re-computation from anybody's entries.
    const costDelta =
      row.estimatedCost === null ? null : round2(row.actualCost - row.estimatedCost)
    return { ...row, costDelta, costDirection: varianceDirection(costDelta) }
  })

  const estimatedRevenue = sumMoney(subs.map((sub) => sub.estimates?.profit?.estimatedRevenue))
  const estimatedCost = sumMoney(subs.map((sub) => sub.estimates?.profit?.estimatedCost))
  const estimatedProfit = sumMoney(subs.map((sub) => sub.estimates?.profit?.estimatedProfit))
  const actualProfit = recap.profitability.margin
  const profitDelta =
    estimatedProfit === null ? null : round2(actualProfit - estimatedProfit)

  const masterCostDelta =
    estimatedCost === null ? null : round2(recap.profitability.laborCost - estimatedCost)
  const masterRevenueDelta =
    estimatedRevenue === null ? null : round2(recap.billing.revenue - estimatedRevenue)

  recap.estimates = {
    hasEstimate: subs.some((sub) => sub.estimates?.hasEstimate),
    monthsInPeriod: first.monthsInPeriod,
    whereToSet: WHERE_TO_SET_ESTIMATES,
    /** Subs with nothing planned — why the roll-up's estimate can run short. */
    unestimatedSubs: subs.filter((sub) => !sub.estimates?.hasEstimate).map(subLabel),
    byTier,
    cost: {
      estimated: estimatedCost,
      actual: recap.profitability.laborCost,
      delta: masterCostDelta,
      direction: varianceDirection(masterCostDelta),
    },
    hours: {
      estimated: roleTotals.estimatedHours,
      actual: roleTotals.actualHours,
      delta: roleTotals.deltaHours,
      direction: roleTotals.direction,
    },
    profit: {
      estimatedRevenue,
      estimatedCost,
      estimatedProfit,
      actualRevenue: recap.billing.revenue,
      actualCost: recap.profitability.laborCost,
      actualProfit,
      delta: profitDelta,
      direction: varianceDirection(profitDelta),
      revenueDelta: masterRevenueDelta,
      revenueDirection: varianceDirection(masterRevenueDelta),
    },
  }

  return recap
}

/**
 * @param {object} data   appDataStore.read() snapshot
 * @param {object} opts
 * @param {string} opts.clientId
 * @param {'month'|'quarter'|'year'} opts.periodType
 * @param {string} opts.period         e.g. "2026-08", "2026-Q3" or "2026"
 * @param {string} opts.today          yyyy-mm-dd
 * @param {boolean} opts.includeFinancials
 * @param {Record<string, number|null>} [opts.costRates]
 * @param {object|null} [opts.salesTaxRecord]
 */
export function buildClientRecap(data, opts) {
  const { clientId, periodType, period, today, includeFinancials, costRates = {}, salesTaxRecord = null } = opts
  const client = (data.clients ?? []).find((c) => c.id === clientId)
  if (!client) return null

  const { start, end } = periodRange(periodType, period)
  const prior = previousPeriod(periodType, period)
  const priorRange = periodRange(periodType, prior)
  // 1 / 3 / 12 — the multiplier that turns the client's per-MONTH planning
  // estimates into this period's figure. Owned by lib/periods.js so the picker,
  // the range and the estimate scaling can never disagree about what a year is.
  const monthsInPeriod = monthsInPeriodType(periodType)
  const employeeName = new Map((data.employees ?? []).map((e) => [e.id, e.name]))
  const employeeRole = new Map((data.employees ?? []).map((e) => [e.id, e.role]))

  // ---- Time & hours ----
  const entries = (data.timeEntries ?? []).filter(
    (e) => e.clientId === clientId && inRange(e.date, start, end),
  )
  const totalHours = entries.reduce((sum, e) => sum + hoursOf(e), 0)
  const billableHours = entries.reduce((sum, e) => sum + (e.billable ? hoursOf(e) : 0), 0)
  const adminHours = entries.reduce((sum, e) => sum + (e.isAdministrative ? hoursOf(e) : 0), 0)
  const priorHours = (data.timeEntries ?? [])
    .filter((e) => e.clientId === clientId && inRange(e.date, priorRange.start, priorRange.end))
    .reduce((sum, e) => sum + hoursOf(e), 0)

  const byStaffMap = new Map()
  for (const e of entries) {
    const b = byStaffMap.get(e.employeeId) || {
      name: employeeName.get(e.employeeId) || e.employeeId,
      tier: recapStaffTier(employeeRole.get(e.employeeId)),
      hours: 0,
      billableHours: 0,
    }
    b.hours += hoursOf(e)
    if (e.billable) b.billableHours += hoursOf(e)
    byStaffMap.set(e.employeeId, b)
  }
  /**
   * FIXED order: CFO tier, then Accountant, then Bookkeeper, then anything
   * unmapped — and by name inside a tier. It used to sort by hours descending,
   * which reshuffled the list every single month as workload moved around, and
   * that churn is exactly what the owner asked us to stop. Name is a stable tie
   * break (locale compare so it matches how the names read on screen), so two
   * different months of data produce the same sequence of people.
   */
  const byStaff = [...byStaffMap.values()]
    .map((b) => ({
      name: b.name,
      tier: b.tier,
      hours: hours2(b.hours),
      billableHours: hours2(b.billableHours),
    }))
    .sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || a.name.localeCompare(b.name))

  // ---- Time & hours: ESTIMATE | ACTUAL | OVER/UNDER, per role ----
  //
  // The shape the firm owner drew over the printed recap: one row per role,
  // named by the people who fill it, with the plan beside the reality. It
  // replaced four stat tiles (total / billable / administrative / vs. prior)
  // that told her nothing she could act on.
  //
  // Rows are per ROLE and not per person because that is the grain an estimate
  // is set at — the client says "10 Bookkeeper hours", never "10 hours of
  // Lisa". Her markup writes a person's name on each row, and in practice a
  // role IS one person; when it is more than one, the row names all of them
  // rather than splitting a role estimate between people on a guess.
  //
  // HOW IT RECONCILES, which is the whole contract:
  //   - actual  = the SUM OF THE DISPLAYED byStaff ROWS in the role, added in
  //     whole hundredths (`sumDisplayHours`), so the role's actual is literally
  //     the people under it added up, and the Total is the roles added up —
  //     and equals `time.totalHours` by construction.
  //   - estimate = the per-month field × the months in the period, at 2dp.
  //   - over/under = displayed actual − displayed estimate, so every row
  //     subtracts by hand. Because all three are exact hundredths, the Total's
  //     over/under is the sum of the rows' over/unders EXACTLY whenever every
  //     row has an estimate.
  // A role with NO estimate shows an em dash rather than a variance against a
  // zero nobody typed; its actual hours still count toward the Total, so the
  // Total's over/under can exceed the sum of the row variances. That is the
  // truthful answer — unplanned work is still over plan — and the page says so
  // in words when it happens.
  const staffByTier = new Map()
  for (const row of byStaff) {
    if (!staffByTier.has(row.tier)) staffByTier.set(row.tier, [])
    staffByTier.get(row.tier).push(row)
  }
  const byRole = []
  for (const tier of [...ESTIMATE_TIERS, 'Other']) {
    const field = RECAP_TIER_ESTIMATE_FIELD[tier]
    const perMonth = field && isNumber(client[field]) ? client[field] : null
    const people = staffByTier.get(tier) ?? []
    // 'Other' has no estimate field, so it only appears when someone actually
    // logged time in it — never as an empty row. Same for an estimable role
    // that is neither estimated nor worked.
    if (perMonth === null && people.length === 0) continue
    const estimatedHours = perMonth === null ? null : round2(perMonth * monthsInPeriod)
    const actualHours = sumDisplayHours(people.map((p) => p.hours))
    const deltaHours =
      estimatedHours === null ? null : sumDisplayHours([actualHours, -estimatedHours])
    byRole.push({
      tier,
      people: people.map((p) => p.name),
      estimatedHours,
      actualHours,
      deltaHours,
      direction: varianceDirection(deltaHours),
    })
  }
  const hasEstimate = byRole.some((row) => row.estimatedHours !== null)
  const roleEstimatedTotal = hasEstimate
    ? sumDisplayHours(byRole.map((row) => row.estimatedHours))
    : null
  const roleActualTotal = sumDisplayHours(byRole.map((row) => row.actualHours))
  const roleDeltaTotal =
    roleEstimatedTotal === null ? null : sumDisplayHours([roleActualTotal, -roleEstimatedTotal])
  const roleTotals = {
    estimatedHours: roleEstimatedTotal,
    actualHours: roleActualTotal,
    deltaHours: roleDeltaTotal,
    direction: varianceDirection(roleDeltaTotal),
  }
  /** Roles carrying real hours against no plan — why the Total can out-run the rows. */
  const unestimatedRoles = byRole
    .filter((row) => row.estimatedHours === null && row.actualHours > 0)
    .map((row) => row.tier)

  /**
   * THE ESTIMATE SIDE IS OWNER-ONLY; the actual side is not.
   *
   * How many hours the firm planned to spend on a client is planning data — it
   * is set on the Client page, which staff do not manage — and it is the same
   * call the Board makes about what a staff member is scoped to see. Hours
   * WORKED are operational and stay visible to everyone, so a staff payload
   * gets the same table with the estimate and over/under columns em-dashed.
   *
   * Redacted rather than differently-computed: the rows, their order and their
   * actual hours are identical either way, so the two payloads can never
   * disagree about how much time a role took. A role that was estimated but
   * never worked has nothing left to say once its estimate is gone, so it drops
   * out of a staff payload — it carries 0.00 actual hours and therefore cannot
   * move any total.
   */
  const estimatesVisible = Boolean(includeFinancials)
  const publicRoleRows = estimatesVisible
    ? byRole
    : byRole
        .filter((row) => row.people.length > 0)
        .map((row) => ({ ...row, estimatedHours: null, deltaHours: null, direction: null }))
  const publicRoleTotals = estimatesVisible
    ? roleTotals
    : { ...roleTotals, estimatedHours: null, deltaHours: null, direction: null }

  // ---- Tasks & workflow ----
  const clientChecklists = (data.checklists ?? []).filter(
    (c) => c.clientId === clientId && !c.deletedAt,
  )
  const isComplete = (c) => (c.items ?? []).length > 0 && (c.items ?? []).every((i) => i.done)
  const dueThisPeriod = clientChecklists
    .filter((c) => inRange(c.dueDate, start, end))
    .map((c) => ({
      title: c.title || 'Untitled task',
      dueDate: c.dueDate,
      assignee: employeeName.get(c.assigneeId) || null,
      done: isComplete(c),
      overdue: !isComplete(c) && typeof c.dueDate === 'string' && c.dueDate < today,
    }))
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0))
  const tasks = {
    dueThisPeriod,
    dueCount: dueThisPeriod.length,
    completedCount: dueThisPeriod.filter((t) => t.done).length,
    overdueCount: dueThisPeriod.filter((t) => t.overdue).length,
    openCount: dueThisPeriod.filter((t) => !t.done).length,
  }

  // ---- Sales tax: filing task status (everyone) ----
  //
  // MONTH-SHAPED, and only coherently answered for a month or a quarter. This
  // picks the LATEST tax task in the range and reports that one task's status,
  // which is a fair summary of one filing period and a poor one of twelve: a
  // yearly recap can have a dozen filings behind this single "done". Nothing
  // renders `salesTax` today; anyone who adds a panel for it should either
  // scope it to month/quarter or report the filings as a list. The sales-tax
  // FIGURES have the same shape problem and the PUT route refuses a yearly
  // period outright (server.js).
  const taxTask = clientChecklists
    .filter(
      (c) => /sales\s*tax/i.test(c.title || '') && inRange(c.dueDate, start, end),
    )
    .sort((a, b) => (a.dueDate < b.dueDate ? 1 : -1))[0]
  let taxStatus = 'not_started'
  if (taxTask) {
    taxStatus = isComplete(taxTask) ? 'done' : taxTask.dueDate < today ? 'overdue' : 'open'
  }
  const salesTax = {
    status: taxStatus,
    taskTitle: taxTask?.title ?? null,
    dueDate: taxTask?.dueDate ?? null,
    // Recorded dollar figures are financial — owner only.
    figures: includeFinancials
      ? {
          taxableSales: salesTaxRecord?.taxableSales ?? null,
          taxCollected: salesTaxRecord?.taxCollected ?? null,
          taxOwed: salesTaxRecord?.taxOwed ?? null,
          notes: salesTaxRecord?.notes ?? '',
          updatedAt: salesTaxRecord?.updatedAt ?? null,
        }
      : null,
  }

  const recap = {
    client: { id: client.id, name: client.name, billingMode: client.billingMode },
    periodType,
    period,
    periodLabel: periodLabel(periodType, period),
    range: { start, end },
    /** 1 / 3 / 12 — what a per-month estimate is multiplied by for this period. */
    monthsInPeriod,
    includeFinancials: Boolean(includeFinancials),
    // Two decimals, not one: every hours figure the app reports is x.xx.
    //
    // Total and Billable are the SUM OF THE byStaff ROWS, not the rounding of
    // the raw seconds behind them — the two differ, and the one that has to be
    // right is the one she gets by adding the list. `deltaHours` subtracts the
    // two DISPLAYED figures for the same reason. adminHours has no row list of
    // its own, so it stays a straight rounding.
    //
    // billableHours, adminHours, priorHours and deltaHours are KEPT FOR API
    // CONSUMERS (the AI assistant reads this payload) but are no longer
    // rendered: the four stat tiles that printed them were replaced by the role
    // table below. Same for `profitability.realizedRate`. Do not delete them
    // just because `src/` has no reader — and do not assume a page shows them.
    time: {
      totalHours: sumDisplayHours(byStaff.map((s) => s.hours)),
      billableHours: sumDisplayHours(byStaff.map((s) => s.billableHours)),
      adminHours: hours2(adminHours),
      priorHours: hours2(priorHours),
      deltaHours: sumDisplayHours([
        sumDisplayHours(byStaff.map((s) => s.hours)),
        -hours2(priorHours),
      ]),
      byStaff,
      // The estimate/actual/over-under table the page now leads with. The
      // ACTUAL column is operational and goes to everyone; the estimate and
      // over/under columns are planning data and are em-dashed for staff.
      byRole: publicRoleRows,
      roleTotals: publicRoleTotals,
      /** False for staff: the estimate columns are dashes, not "none are set". */
      estimatesVisible,
      hasEstimate: estimatesVisible && hasEstimate,
      unestimatedRoles: estimatesVisible ? unestimatedRoles : [],
      whereToSetEstimates: WHERE_TO_SET_ESTIMATES,
    },
    tasks,
    salesTax,
    billing: null,
    profitability: null,
    // Estimated-vs-actual and the projected invoice are cost/profit surfaces,
    // so they are owner-only exactly like billing and profitability: absent
    // from a staff payload, not merely hidden by the page.
    estimates: null,
    projection: null,
  }

  if (!includeFinancials) return recap

  // ---- Billing (owner only) ----
  const isHourly = client.billingMode === 'hourly'
  const monthlyRate = typeof client.monthlyRate === 'number' ? client.monthlyRate : 0
  /**
   * Revenue comes from the SAME builder that produces the actual invoice, one
   * month at a time (a recap period may be a quarter), summing only the service
   * lines — reimbursements are reported separately below and would double-count.
   *
   * This used to be `billableHours * client.hourlyRate`, the legacy per-client
   * rate. Invoices have billed each employee's own rate since 2026-06, so on
   * July 2026 production data the two disagreed for 16 of 19 hourly clients, in
   * both directions. Profit is measured against this number, so for a MONTHLY
   * recap it is the invoice's number.
   *
   * OVER A QUARTER OR A YEAR IT IS A RESTATEMENT, NOT A RECONCILIATION. Every
   * month is priced with the client's rates and plans AS THEY STAND NOW,
   * because that is all a snapshot holds — no rate history is kept. A client
   * whose rate changed in March therefore has January and February repriced at
   * the new rate here, and this figure will not match the twelve invoices
   * actually issued. It answers "what is a year of this client's work worth at
   * today's rates", which is the useful question for a plan-vs-actual read, and
   * the Billing panel says so on screen whenever the period spans more than one
   * month. Do not quietly promote it to "what we billed".
   *
   * Ad hoc lines count as service revenue at their DEFAULT — "invoice it" —
   * because this is built from live time data, not from the stored invoice, so
   * it cannot see a courtesy or omit the owner set on a particular draft. That
   * is the same thing it already does with any hand-edited line: this is what
   * the work is worth, not a copy of what was billed.
   *
   * RETAINERS ARE ABSENT FROM THIS NUMBER, and that is correct rather than an
   * oversight. A retainer invoice is money held on account, not service revenue
   * in the month it is paid; it is recognized through the monthly invoices it
   * later offsets, and those months are already counted here in full. The
   * exclusion needs no code because this reads live time data rather than stored
   * invoices: a retainer invoice has no time behind it, and a `retainer_credit`
   * line exists only on a stored invoice. Crediting the final invoice therefore
   * does not dent the revenue the recap reports for that month — the work was
   * still worth what it was worth.
   */
  const revenue = round2(
    monthsInRange(start, end).reduce((sum, month) => {
      const built = buildInvoiceLines({
        client,
        entries: data.timeEntries ?? [],
        plans: data.plans ?? [],
        billingPeriod: month,
        employees: data.employees ?? [],
        defaultHourlyRate: Number(client.hourlyRate) || 0,
      })
      return (
        sum +
        built.lines
          .filter(
            (line) => line.kind === 'plan' || line.kind === 'hourly' || line.kind === 'adhoc',
          )
          // Rounded PER LINE, exactly as the draft generator does before the
          // amounts become an invoice — so it rounds where the invoice rounds.
          // One aggregated line hid the difference; ad hoc puts one line on the
          // invoice per piece of work, so the drift would grow with every one.
          .reduce((lineSum, line) => lineSum + round2(line.amount), 0)
      )
    }, 0),
  )
  const planNames = (client.planIds ?? [])
    .map((id) => (data.plans ?? []).find((p) => p.id === id)?.name)
    .filter(Boolean)
  const reimbursements = (data.reimbursements ?? [])
    .filter((r) => r.clientId === clientId && inRange(r.date, start, end))
    .map((r) => ({ date: r.date, description: r.description, amount: Number(r.amount) || 0 }))
  const reimbursementTotal = round2(reimbursements.reduce((sum, r) => sum + r.amount, 0))
  recap.billing = {
    billingMode: client.billingMode,
    hourlyRate: isHourly ? Number(client.hourlyRate) || 0 : null,
    monthlyRate: isHourly ? null : monthlyRate,
    monthsInPeriod,
    planNames,
    revenue,
    reimbursements,
    reimbursementTotal,
  }

  // ---- Profitability (owner only) ----
  /**
   * Actual labor cost comes from THE payroll cost rule (lib/payroll-cost.js):
   * per person, minutes summed exact, rounded to the two-decimal hours this
   * page prints, multiplied by the cost rate, and a full-mode group counted
   * once. This used to be a local `hours × rate` loop — a fourth implementation
   * of the firm's cost arithmetic that rounded in a different order from the
   * payroll report and double-counted a full-mode split. The number the owner
   * compares profit against has to be the number payroll pays.
   *
   * The dedup is a no-op HERE and that is not an accident worth hedging about:
   * a recap is scoped to ONE client, and a full-mode group puts exactly one
   * slice in each client's set. Pricing the byStaff hours by hand therefore
   * reproduces this figure — there is no split case where it wouldn't.
   */
  const costRateOf = (employeeId) => (isNumber(costRates[employeeId]) ? costRates[employeeId] : null)
  /**
   * NO COST RATE MEANS NO LABOR COST — not "cost unknowable".
   *
   * The recap used to withhold labor cost and margin entirely when ANY person
   * who logged time had no cost rate on file. That reads as caution and behaves
   * as a blackout: the firm owner draws no hourly wage (correctly no rate), and
   * on August 2026 production data she had logged time on 31 of the 34 clients
   * with any — so margin, and every plan-vs-actual profit built on it, would
   * have been "—" on 91% of her clients.
   *
   * A person with no rate simply contributes zero, which is what
   * `personPeriodCost` and the payroll report have always done. The recap was
   * the outlier; it now matches instead of carrying a second rule. The page
   * says so once, in plain words, wherever cost or profit appears — the answer
   * to "why is cost lower than I expected" is printed, not hidden.
   */
  const actualLaborCost = laborCost(entries, costRateOf)
  recap.profitability = {
    realizedRate: totalHours > 0 ? round2(revenue / totalHours) : null,
    laborCost: actualLaborCost,
    margin: round2(revenue - actualLaborCost),
  }

  // ---- Estimated vs. actual (owner only) ----
  //
  // The owner's ask: "Lisa had 10 estimated hours but worked 12" — and the same
  // comparison for profit — so overruns get caught instead of noticed in
  // hindsight. Estimates are per TIER on the client, not per person, so the
  // comparison is per tier; the per-person hours are already above in byStaff.
  //
  // Estimates are stated per MONTH. A quarterly recap multiplies them by the
  // three months it covers and a yearly one by twelve, which is the only
  // reading that lets a longer period be compared with anything.
  const employeeById = new Map((data.employees ?? []).map((e) => [e.id, e]))
  const billRateOf = (employeeId) => {
    const employee = employeeById.get(employeeId)
    return isNumber(employee?.billRate) ? employee.billRate : null
  }
  const entriesByTier = new Map()
  for (const e of entries) {
    const tier = recapStaffTier(employeeRole.get(e.employeeId))
    if (!entriesByTier.has(tier)) entriesByTier.set(tier, [])
    entriesByTier.get(tier).push(e)
  }
  // TEAM, not visibility (2026-09-04 split). This prices an ESTIMATE from the
  // people PLANNED to do the work, which is the owner-picked team by
  // definition. Task assignees fall through to rule 2 below (whoever actually
  // logged time), where they belong — they are evidence of the real crew, not
  // of the plan.
  const assignedIds = assignedTeamIds(client)
  const tierOf = (employeeId) => recapStaffTier(employeeRole.get(employeeId))

  /**
   * The rate to price a TIER's estimate at.
   *
   * An estimate says "10 Bookkeeper hours", never "10 hours of Lisa", so a rate
   * has to be resolved from people. Most specific first:
   *
   *   1. the client's ASSIGNED team in that tier (lib/data-scope.js — the one
   *      source of assignment). These are the people planned to do the work, so
   *      their rate is the defensible price of the plan.
   *   2. failing that, whoever actually LOGGED time in that tier this period. A
   *      client with nobody formally assigned still has a real crew.
   *
   * Several people at different rates AVERAGE (plain mean): the estimate does
   * not say who takes which hour, so no weighting is defensible. The basis and
   * the head count ride along in the payload so the page can say which rule
   * produced the number and the owner can argue with it.
   *
   * Nobody with a rate -> null, and that tier's estimated cost is reported as
   * unavailable rather than $0.00 (same stance as personPeriodCost).
   */
  const resolveTierRate = (tier, rateOf) => {
    const mean = (ids) => {
      const rates = [...new Set(ids)].map(rateOf).filter(isNumber)
      if (rates.length === 0) return null
      return { rate: rates.reduce((sum, r) => sum + r, 0) / rates.length, peopleCount: rates.length }
    }
    const fromAssigned = mean(assignedIds.filter((id) => tierOf(id) === tier))
    if (fromAssigned) return { ...fromAssigned, basis: 'assigned' }
    const fromLogged = mean((entriesByTier.get(tier) ?? []).map((e) => e.employeeId))
    if (fromLogged) return { ...fromLogged, basis: 'logged' }
    return { rate: null, peopleCount: 0, basis: null }
  }

  /**
   * The SAME rows the Time & hours table prints, priced.
   *
   * Hours, variance and row set are taken from `byRole` rather than recomputed,
   * so the two surfaces cannot drift: whatever "12.00h actual" means in the
   * table is the figure this cost is derived against.
   */
  const estimateTierRows = byRole.map((row) => {
    const tierEntries = entriesByTier.get(row.tier) ?? []
    const cost = resolveTierRate(row.tier, costRateOf)
    // Same rule on BOTH sides of the comparison: a tier whose rate resolves to
    // null (the CFO tier, since the owner fills it) costs nothing rather than
    // making the estimate unavailable. `personPeriodCost` returns null for "no
    // rate" and `sumPersonCosts` adds it as zero — the shared calculator's
    // stance, kept intact here so the row and the total can never disagree.
    const estimatedCost =
      row.estimatedHours === null ? null : personPeriodCost(row.estimatedHours * 60, cost.rate)
    return {
      ...row,
      costRate: cost.rate === null ? null : round2(cost.rate),
      costRateBasis: cost.basis,
      costRatePeopleCount: cost.peopleCount,
      estimatedCost,
      actualCost: laborCost(tierEntries, costRateOf),
    }
  }).map((row) => {
    // The cost OVER/UNDER, derived here so every surface says the same thing.
    // Null when there is no estimated cost — a variance against an estimate
    // nobody entered is not a number (same stance as deltaHours).
    const costDelta =
      row.estimatedCost === null ? null : round2(row.actualCost - row.estimatedCost)
    return { ...row, costDelta, costDirection: varianceDirection(costDelta) }
  })

  const estimatedTiers = estimateTierRows.filter((row) => row.estimatedHours !== null)
  const estimatedHoursTotal = roleTotals.estimatedHours
  // A rate-less tier contributes zero (sumPersonCosts skips nulls), so the only
  // reason estimated cost is unavailable is that there is no estimate at all.
  const estimatedCost = hasEstimate
    ? sumPersonCosts(estimatedTiers.map((row) => row.estimatedCost))
    : null

  /**
   * Expected revenue for the period — the top half of estimated profit.
   *
   *   subscription -> the client's own monthly rate × months in the period. A
   *                   known, contracted number; no estimate needed for it.
   *   annual       -> the yearly fee spread evenly (annualRate ÷ 12 × months).
   *                   The INVOICE bills it once, in one month; smoothing is the
   *                   only way a single month's plan-vs-actual profit means
   *                   anything, and it is labelled on screen as a monthly share.
   *   hourly       -> the estimated hours priced at each tier's BILL rate,
   *                   resolved the same way the cost rate is and falling back to
   *                   the client's own hourly rate exactly as invoices do.
   *                   Estimated hours are treated as billable — that is what the
   *                   planning field is for.
   */
  let estimatedRevenue = null
  if (client.billingMode === 'subscription') {
    estimatedRevenue = round2(monthlyRate * monthsInPeriod)
  } else if (client.billingMode === 'annual') {
    estimatedRevenue = round2(((Number(client.annualRate) || 0) / 12) * monthsInPeriod)
  } else if (hasEstimate) {
    const fallbackRate = Number(client.hourlyRate) || 0
    estimatedRevenue = round2(
      estimatedTiers.reduce((sum, row) => {
        const tierBill = resolveTierRate(row.tier, billRateOf).rate
        return sum + row.estimatedHours * (tierBill === null ? fallbackRate : tierBill)
      }, 0),
    )
  }

  const estimatedProfit =
    estimatedRevenue !== null && estimatedCost !== null
      ? round2(estimatedRevenue - estimatedCost)
      : null
  const actualProfit = recap.profitability.margin
  const profitDelta =
    estimatedProfit !== null && actualProfit !== null ? round2(actualProfit - estimatedProfit) : null

  // Actual - estimated, per her marked-up recap (featreq-926862e2 round two):
  // the Billing tiles become Estimated Invoice | Actual Invoice | Over/Under,
  // and the roles table gains the same three columns in dollars. Null estimate
  // -> null delta, never a variance against zero.
  const costDeltaTotal = estimatedCost === null ? null : round2(actualLaborCost - estimatedCost)
  const revenueDelta = estimatedRevenue === null ? null : round2(revenue - estimatedRevenue)

  recap.estimates = {
    hasEstimate,
    monthsInPeriod,
    /** Where to go set them, so "No estimate set" is actionable, not a dead end. */
    whereToSet: WHERE_TO_SET_ESTIMATES,
    byTier: estimateTierRows,
    /** The roles table's cost Total row — the same figures the tiers add to. */
    cost: {
      estimated: estimatedCost,
      actual: actualLaborCost,
      delta: costDeltaTotal,
      direction: varianceDirection(costDeltaTotal),
    },
    hours: {
      estimated: estimatedHoursTotal,
      // Every tier's actual, including any 'Other' time — the same figure as
      // time.totalHours and the table's Total row, so no two surfaces can
      // disagree about how many hours this period held.
      actual: roleTotals.actualHours,
      delta: roleTotals.deltaHours,
      direction: roleTotals.direction,
    },
    profit: {
      estimatedRevenue,
      estimatedCost,
      estimatedProfit,
      // The actual side is the SAME revenue and cost the Billing and
      // Profitability panels show — read from them rather than recomputed.
      actualRevenue: revenue,
      actualCost: recap.profitability.laborCost,
      actualProfit,
      delta: profitDelta,
      direction: varianceDirection(profitDelta),
      // Estimated Invoice vs Actual Invoice — the Billing tiles' comparison.
      // Service revenue on both sides; reimbursements excluded from both, as
      // the profitability footnote already states.
      revenueDelta,
      revenueDirection: varianceDirection(revenueDelta),
    },
  }

  // ---- Projected end-of-month invoice (owner only) ----
  //
  // An ESTIMATE, and labeled as one everywhere it appears. Quarterly and
  // yearly recaps get none: "projected end-of-month invoice" is a month-shaped
  // question, and stretching it over a quarter or a year would be a made-up
  // number wearing a real one's clothes.
  if (periodType === 'month') {
    const built = buildInvoiceLines({
      client,
      entries: data.timeEntries ?? [],
      plans: data.plans ?? [],
      billingPeriod: period,
      reimbursements: data.reimbursements ?? [],
      recurringReimbursements: data.recurringReimbursements ?? [],
      employees: data.employees ?? [],
      defaultHourlyRate: Number(client.hourlyRate) || 0,
    })
    const serviceToDate = round2(
      built.lines
        .filter(
          (line) => line.kind === 'plan' || line.kind === 'hourly' || line.kind === 'adhoc',
        )
        // Per line, matching the draft generator — see the revenue figure above.
        .reduce((sum, line) => sum + round2(line.amount), 0),
    )
    // Everything that is not the service line: reimbursements and recurring
    // items. These are recorded facts, never extrapolated — a filing fee that
    // happened once does not happen 2.4 times because the month is 40% gone.
    const extrasToDate = round2(built.total - serviceToDate)
    const hoursToDate = round2(built.billableMinutes / 60)
    const businessDaysInMonth = businessDaysBetween(start, end)
    const businessDaysElapsed = today < start ? 0 : businessDaysBetween(start, today < end ? today : end)
    const monthComplete = today > end

    if (monthComplete) {
      recap.projection = {
        basis: 'actual',
        isEstimate: false,
        amount: round2(built.total),
        serviceAmount: serviceToDate,
        reimbursementsToDate: extrasToDate,
        hoursToDate,
        businessDaysElapsed,
        businessDaysInMonth,
        method: `${periodLabel(periodType, period)} is closed — this is the invoice as it stands, not a projection.`,
      }
    } else if (isHourly && businessDaysElapsed > 0) {
      const projectedService = round2(
        serviceToDate * (businessDaysInMonth / businessDaysElapsed),
      )
      recap.projection = {
        basis: 'hourly',
        isEstimate: true,
        amount: round2(projectedService + extrasToDate),
        serviceAmount: projectedService,
        reimbursementsToDate: extrasToDate,
        hoursToDate,
        businessDaysElapsed,
        businessDaysInMonth,
        method: `Estimate — projected from ${hoursToDate.toFixed(2)} billable hours over ${businessDaysElapsed} of ${businessDaysInMonth} business days. Reimbursements are only those already recorded.`,
      }
    } else if (isHourly) {
      recap.projection = {
        basis: 'too_early',
        isEstimate: true,
        amount: null,
        serviceAmount: null,
        reimbursementsToDate: extrasToDate,
        hoursToDate,
        businessDaysElapsed,
        businessDaysInMonth,
        method: 'No business days of this month have passed yet — there is nothing to project from.',
      }
    } else {
      recap.projection = {
        basis: 'plan',
        isEstimate: true,
        amount: round2(built.total),
        serviceAmount: serviceToDate,
        reimbursementsToDate: extrasToDate,
        hoursToDate,
        businessDaysElapsed,
        businessDaysInMonth,
        method:
          'Estimate — the plan amount is fixed and known; reimbursements are only those already recorded, and more may still land.',
      }
    }
  }

  return recap
}
