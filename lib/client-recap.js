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
import { buildInvoiceLines } from './invoice-lines.js'
import { laborCost, personPeriodCost, sumPersonCosts } from './payroll-cost.js'
import { periodLabel, periodRange, previousPeriod } from './periods.js'

const hoursOf = (entry) => Number(entry?.minutes || 0) / 60
const round2 = (n) => Math.round(n * 100) / 100
const inRange = (date, start, end) => typeof date === 'string' && date >= start && date <= end
const isNumber = (n) => typeof n === 'number' && Number.isFinite(n)

/**
 * THE role tier mapping for the Client Recap — the one place it is written down.
 *
 * The firm owner asks for the recap's people to read "CFO hours, Accountant,
 * Bookkeeper" and to stay in that order every month. The app has no "CFO" staff
 * role: `employees[].role` (and the `users.staff_role` column behind it) allows
 * exactly three values — 'Owner', 'Accountant', 'Bookkeeper'. What IS called CFO
 * is the client-side planning field `estimatedCfoHours`, which sits beside
 * `estimatedAccountantHours` and `estimatedBookkeeperHours` on a client. Those
 * three estimate fields are the tiers she means, so the mapping is:
 *
 *   estimatedCfoHours         <- role 'Owner'        (the firm owner does the CFO work)
 *   estimatedAccountantHours  <- role 'Accountant'   (db role 'senior_bookkeeper')
 *   estimatedBookkeeperHours  <- role 'Bookkeeper'
 *
 * Anything else — a role that has not been set, or a value added later — lands
 * in 'Other' and sorts last rather than silently jumping the queue.
 *
 * A tier nobody logged time in is OMITTED, not shown as a zero row: `byStaff` is
 * a list of people, and inventing a person to hold a zero would be worse than a
 * short list. The ORDER of the tiers that are present never changes, which is
 * what "the same order month to month" actually needs.
 */
export const RECAP_STAFF_TIERS = ['CFO', 'Accountant', 'Bookkeeper', 'Other']

export function recapStaffTier(employeeRole) {
  switch (employeeRole) {
    case 'Owner':
      return 'CFO'
    case 'Accountant':
      return 'Accountant'
    case 'Bookkeeper':
      return 'Bookkeeper'
    default:
      return 'Other'
  }
}

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
 * @param {object} data   appDataStore.read() snapshot
 * @param {object} opts
 * @param {string} opts.clientId
 * @param {'month'|'quarter'} opts.periodType
 * @param {string} opts.period         e.g. "2026-08" or "2026-Q3"
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
  const monthsInPeriod = periodType === 'quarter' ? 3 : 1
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
      hours: round2(b.hours),
      billableHours: round2(b.billableHours),
    }))
    .sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || a.name.localeCompare(b.name))

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
    includeFinancials: Boolean(includeFinancials),
    // Two decimals, not one: the page prints these as x.xx, and rounding to a
    // single decimal here would have made that second digit a permanent zero.
    time: {
      totalHours: round2(totalHours),
      billableHours: round2(billableHours),
      adminHours: round2(adminHours),
      priorHours: round2(priorHours),
      deltaHours: round2(totalHours - priorHours),
      byStaff,
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
   * both directions. Profit is measured against this number, so it has to be
   * the invoice's number.
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
          // amounts become an invoice — this promises to be the invoice's
          // number, so it has to round where the invoice rounds. One aggregated
          // line hid the difference; ad hoc puts one line on the invoice per
          // piece of work, so the drift would grow with every one of them.
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
   * per person, minutes kept exact, rounded once to the cent, and a full-mode
   * group counted once. This used to be a local `hours × rate` loop — a fourth
   * implementation of the firm's cost arithmetic that rounded in a different
   * order from the payroll report and double-counted a full-mode split. The
   * number the owner compares profit against has to be the number payroll pays.
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
  // three months it covers, which is the only reading that lets a quarter be
  // compared with anything.
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

  const estimateTierRows = []
  for (const tier of [...ESTIMATE_TIERS, 'Other']) {
    const field = RECAP_TIER_ESTIMATE_FIELD[tier]
    const perMonth = field && isNumber(client[field]) ? client[field] : null
    const tierEntries = entriesByTier.get(tier) ?? []
    // 'Other' has no estimate field, so it only appears when someone actually
    // logged time in it — never as an empty row.
    if (perMonth === null && tierEntries.length === 0) continue
    const estimatedHours = perMonth === null ? null : round2(perMonth * monthsInPeriod)
    const actualHours = round2(tierEntries.reduce((sum, e) => sum + hoursOf(e), 0))
    const deltaHours = estimatedHours === null ? null : round2(actualHours - estimatedHours)
    const cost = resolveTierRate(tier, costRateOf)
    // Same rule on BOTH sides of the comparison: a tier whose rate resolves to
    // null (the CFO tier, since the owner fills it) costs nothing rather than
    // making the estimate unavailable. `personPeriodCost` returns null for "no
    // rate" and `sumPersonCosts` adds it as zero — the shared calculator's
    // stance, kept intact here so the row and the total can never disagree.
    const estimatedCost =
      estimatedHours === null ? null : personPeriodCost(estimatedHours * 60, cost.rate)
    const actualCost = laborCost(tierEntries, costRateOf)
    estimateTierRows.push({
      tier,
      estimatedHours,
      actualHours,
      deltaHours,
      direction: varianceDirection(deltaHours),
      costRate: cost.rate === null ? null : round2(cost.rate),
      costRateBasis: cost.basis,
      costRatePeopleCount: cost.peopleCount,
      estimatedCost,
      actualCost,
    })
  }

  const estimatedTiers = estimateTierRows.filter((row) => row.estimatedHours !== null)
  const hasEstimate = estimatedTiers.length > 0
  const estimatedHoursTotal = hasEstimate
    ? round2(estimatedTiers.reduce((sum, row) => sum + row.estimatedHours, 0))
    : null
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

  recap.estimates = {
    hasEstimate,
    monthsInPeriod,
    /** Where to go set them, so "No estimate set" is actionable, not a dead end. */
    whereToSet: 'Client page → Estimated monthly hours',
    byTier: estimateTierRows,
    hours: {
      estimated: estimatedHoursTotal,
      // Every tier's actual, including any 'Other' time — the same figure as
      // time.totalHours, so the two panels can never disagree.
      actual: recap.time.totalHours,
      delta: estimatedHoursTotal === null ? null : round2(recap.time.totalHours - estimatedHoursTotal),
      direction:
        estimatedHoursTotal === null
          ? null
          : varianceDirection(round2(recap.time.totalHours - estimatedHoursTotal)),
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
    },
  }

  // ---- Projected end-of-month invoice (owner only) ----
  //
  // An ESTIMATE, and labelled as one everywhere it appears. Quarterly recaps
  // get none: "projected end-of-month invoice" is a month-shaped question, and
  // stretching it over a quarter would be a made-up number wearing a real one's
  // clothes.
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
