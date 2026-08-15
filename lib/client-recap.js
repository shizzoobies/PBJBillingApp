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

import { buildInvoiceLines } from './invoice-lines.js'
import { periodLabel, periodRange, previousPeriod } from './periods.js'

const hoursOf = (entry) => Number(entry?.minutes || 0) / 60
const round2 = (n) => Math.round(n * 100) / 100
const inRange = (date, start, end) => typeof date === 'string' && date >= start && date <= end

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
          .filter((line) => line.kind === 'plan' || line.kind === 'hourly')
          .reduce((lineSum, line) => lineSum + line.amount, 0)
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
  let laborCost = 0
  let marginAvailable = true
  for (const e of entries) {
    const rate = costRates[e.employeeId]
    if (rate == null) marginAvailable = false
    else laborCost += hoursOf(e) * rate
  }
  recap.profitability = {
    realizedRate: totalHours > 0 ? round2(revenue / totalHours) : null,
    marginAvailable,
    laborCost: marginAvailable ? round2(laborCost) : null,
    margin: marginAvailable ? round2(revenue - laborCost) : null,
  }

  return recap
}
