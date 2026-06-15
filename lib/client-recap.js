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

import { periodLabel, periodRange, previousPeriod } from './periods.js'

const hoursOf = (entry) => Number(entry?.minutes || 0) / 60
const round1 = (n) => Math.round(n * 10) / 10
const round2 = (n) => Math.round(n * 100) / 100
const inRange = (date, start, end) => typeof date === 'string' && date >= start && date <= end

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
      hours: 0,
      billableHours: 0,
    }
    b.hours += hoursOf(e)
    if (e.billable) b.billableHours += hoursOf(e)
    byStaffMap.set(e.employeeId, b)
  }
  const byStaff = [...byStaffMap.values()]
    .map((b) => ({ name: b.name, hours: round1(b.hours), billableHours: round1(b.billableHours) }))
    .sort((a, b) => b.hours - a.hours)

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
    time: {
      totalHours: round1(totalHours),
      billableHours: round1(billableHours),
      adminHours: round1(adminHours),
      priorHours: round1(priorHours),
      deltaHours: round1(totalHours - priorHours),
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
  const revenue = isHourly
    ? round2(billableHours * (Number(client.hourlyRate) || 0))
    : monthlyRate * monthsInPeriod
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
