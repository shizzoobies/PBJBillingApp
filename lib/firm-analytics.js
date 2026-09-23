/**
 * Deterministic firm analytics for the assistant (Phase 4, Track A).
 *
 * Pure functions over an appDataStore.read() snapshot plus the firm's
 * EFFECTIVE-DATED rate lists — `billRateVersions` ({ userId, effectivePeriod,
 * rate }) and `costRateVersions` ({ userId, effectiveDate, rate }) — rather
 * than one rate per person. A bill rate is resolved for the BILLING PERIOD
 * (the client's pin as it stood that month, exactly as the invoice bills it); a
 * cost rate is resolved for THE DAY THE ENTRY WAS WORKED, because a raise
 * lands on a payday. So a month the assistant is asked about tomorrow reads
 * the same as it read the day it closed. All "current date" inputs (month,
 * asOf, weekStart) are passed in by the caller so these stay deterministic and
 * unit-testable — no Date.now() in here. The server wires the results into
 * read-only assistant tools; nothing here mutates or touches invoices.
 *
 * Money note: the app stores CLIENT billing rates (hourlyRate, monthlyRate)
 * but a per-employee cost rate is optional. "Realization" (fee ÷ hours) is
 * always available. "Margin" (revenue − labor cost) is ALSO always reported:
 * someone with no cost rate contributes NO labor cost. Role is not part of that
 * test — an owner with a cost rate on file is costed like anyone else
 * (featreq-6fdd9e98). Labor cost itself comes from THE payroll cost rule
 * (lib/payroll-cost.js `laborCost`: minutes grouped per person, rounded to the
 * two-decimal hours the reports print and then multiplied by the cost rate,
 * full-mode group slices counted once) — the same call the
 * Client Recap and the payroll report make, which is the point: the assistant
 * must not tell her a margin that disagrees with the Recap page it is
 * describing. `marginAvailable` is kept as a constant true so an older caller
 * can't break on its absence.
 */

import {
  displayHours,
  laborCost,
  periodMoney,
  sumDisplayHours,
  sumPersonCosts,
} from './payroll-cost.js'
import { PER_EMPLOYEE_BILLING_START } from './invoice-lines.js'
import { billRateAt, costRateFor, ratePeriodAsOf } from './rate-history.js'

const hoursOf = (entry) => Number(entry?.minutes || 0) / 60
const round2 = (n) => Math.round(n * 100) / 100
/**
 * Hours the assistant QUOTES are the hours the pages PRINT — two decimals, the
 * same rounding cost is priced from. These used to be one decimal, which read
 * fine in a sentence and was wrong beside a dollar figure: the assistant would
 * say "10.2 hours" about a cost built from 10.22, and the manifest promises no
 * two surfaces can disagree about the same hour.
 */
const hours2 = (hours) => displayHours(hours * 60)

function nameMaps(data) {
  const clientName = new Map((data.clients ?? []).map((c) => [c.id, c.name]))
  const employeeName = new Map((data.employees ?? []).map((e) => [e.id, e.name]))
  return { clientName, employeeName }
}

function monthEntries(data, month) {
  return (data.timeEntries ?? []).filter(
    (e) => typeof e.date === 'string' && e.date.slice(0, 7) === month,
  )
}

/**
 * Per-client economics for a calendar month (yyyy-mm). Worst realization
 * first. `lowRealizationThreshold` is $/hour below which a client is flagged.
 */
export function clientProfitability(
  data,
  { month, billRateVersions = [], costRateVersions = [], lowRealizationThreshold = 50 },
) {
  const { clientName } = nameMaps(data)
  const entries = monthEntries(data, month)
  const clients = (data.clients ?? []).filter((c) => !c.archivedAt && !c.deletedAt)
  const costRateOf = (employeeId, entryDate) =>
    costRateFor(costRateVersions, employeeId, entryDate)

  const rows = []
  for (const client of clients) {
    const mine = entries.filter((e) => e.clientId === client.id)
    const totalHours = mine.reduce((sum, e) => sum + hoursOf(e), 0)

    // Realization and margin both need logged time — skip clients with no
    // hours this month (a fixed fee alone says nothing about effort). Checked
    // HERE, before any pricing, so a client with nothing logged costs nothing
    // to consider.
    if (totalHours === 0) continue

    const billableHours = mine.reduce((sum, e) => sum + (e.billable ? hoursOf(e) : 0), 0)
    const isHourly = client.billingMode === 'hourly'
    const fee = typeof client.monthlyRate === 'number' ? client.monthlyRate : 0
    /**
     * Hourly revenue, at last, through the SAME rule the invoice bills by.
     *
     * This used to be `billableHours × client.hourlyRate` — the retired
     * per-client rate, which invoices stopped using at the June 2026 cutover.
     * It is the known inconsistency the rate-history build closes (spec §3):
     * one rate per client, applied to everybody's hours, could disagree with
     * the invoice in both directions and did on 16 of 19 hourly clients in
     * July 2026.
     *
     * The fallback chain is `buildInvoiceLines`'s, in the same order, so a
     * client with no versions and people with no bill rates still reads
     * exactly what it read before.
     *
     * AND ONLY FROM THE CUTOVER ON. `buildInvoiceLines` still bills a month
     * before {@link PER_EMPLOYEE_BILLING_START} as one aggregate line at the
     * client's own `hourlyRate`, so pricing such a month per person here would
     * make the assistant contradict the invoice — and the Recap page — for
     * every month the firm billed that way. Same cutover, same side of it.
     */
    const ratePeriod = ratePeriodAsOf(client, month)
    const billRateOf = (employeeId) => {
      const employee = (data.employees ?? []).find((entry) => entry.id === employeeId)
      return (
        billRateAt(billRateVersions, employee ?? { id: employeeId }, ratePeriod, month) ??
        (Number(client.hourlyRate) || 0)
      )
    }
    const hourlyRevenue = () => {
      if (month < PER_EMPLOYEE_BILLING_START) {
        return round2(billableHours * (Number(client.hourlyRate) || 0))
      }
      const rowsByEmployee = new Map()
      for (const entry of mine) {
        if (!entry.billable) continue
        const rows = rowsByEmployee.get(entry.employeeId)
        if (rows) rows.push(entry.minutes)
        else rowsByEmployee.set(entry.employeeId, [entry.minutes])
      }
      return sumPersonCosts(
        [...rowsByEmployee].map(([employeeId, minutesPerRow]) =>
          periodMoney(minutesPerRow, billRateOf(employeeId)),
        ),
      )
    }
    const revenue = isHourly ? round2(hourlyRevenue()) : fee

    // Labor cost is THE payroll cost rule (lib/payroll-cost.js), the same call
    // the Client Recap makes over the same entries: minutes grouped per person,
    // rounded to two-decimal hours and multiplied by the cost rate, a full-mode
    // group's slices counted once.
    // This used to be a local `hours × rate` loop — another implementation of
    // the firm's cost arithmetic, off by a cent from the payroll report and
    // blind to full-mode duplicates.
    //
    // No cost rate means NO LABOR COST, not "cost unknowable". The owner had
    // no rate on file and logs on nearly every client (measured 2026-08-15:
    // 51.84h across 31 of the 34 clients with time that month), so withholding
    // margin whenever a rate-less person contributed blanked almost every row.
    // The Client Recap and the payroll report both count it as zero
    // (personPeriodCost returns null and sumPersonCosts adds it as nothing);
    // this is the same rule, so the assistant can't contradict the page it is
    // describing. An owner WITH a cost rate (featreq-6fdd9e98) is costed here
    // like any other contributor — the map is keyed by person, not by role.
    const clientLaborCost = laborCost(mine, costRateOf)
    const realizedRate = totalHours > 0 ? round2(revenue / totalHours) : null

    rows.push({
      client: client.name || clientName.get(client.id) || client.id,
      billingMode: client.billingMode || 'fixed',
      revenue,
      totalHours: hours2(totalHours),
      billableHours: hours2(billableHours),
      realizedRate,
      marginAvailable: true,
      laborCost: clientLaborCost,
      margin: round2(revenue - clientLaborCost),
      lowRealization: realizedRate != null && realizedRate < lowRealizationThreshold,
    })
  }

  rows.sort((a, b) => {
    if (a.realizedRate == null) return 1
    if (b.realizedRate == null) return -1
    return a.realizedRate - b.realizedRate
  })

  const anyCostRates = (costRateVersions ?? []).length > 0
  return {
    month,
    lowRealizationThreshold,
    clients: rows,
    note: anyCostRates
      ? 'Margin counts the hours of everyone who has a cost rate set — owners included; anyone without one adds no cost.'
      : 'No cost rates set, so only realization (fee ÷ hours) is shown — add cost rates on the Team page for true margin.',
  }
}

/**
 * Hours grouped by client and/or staff over [from, to] (inclusive yyyy-mm-dd).
 * groupBy: 'client' | 'staff' | 'both'.
 */
export function timeSummary(data, { from, to, groupBy = 'both' }) {
  const { clientName, employeeName } = nameMaps(data)
  const entries = (data.timeEntries ?? []).filter(
    (e) => typeof e.date === 'string' && e.date >= from && e.date <= to,
  )

  const bucket = () => ({ hours: 0, billableHours: 0, adminHours: 0 })
  const byClientMap = new Map()
  const byStaffMap = new Map()
  let totalHours = 0
  let billableHours = 0

  for (const e of entries) {
    const h = hoursOf(e)
    totalHours += h
    if (e.billable) billableHours += h

    if (groupBy === 'client' || groupBy === 'both') {
      const key = e.isAdministrative ? '__admin__' : e.clientId || '__unassigned__'
      const label = e.isAdministrative
        ? 'Administrative'
        : clientName.get(e.clientId) || 'Unassigned'
      const b = byClientMap.get(key) || { name: label, ...bucket() }
      b.hours += h
      if (e.billable) b.billableHours += h
      if (e.isAdministrative) b.adminHours += h
      byClientMap.set(key, b)
    }
    if (groupBy === 'staff' || groupBy === 'both') {
      const b = byStaffMap.get(e.employeeId) || {
        name: employeeName.get(e.employeeId) || e.employeeId,
        ...bucket(),
      }
      b.hours += h
      if (e.billable) b.billableHours += h
      if (e.isAdministrative) b.adminHours += h
      byStaffMap.set(e.employeeId, b)
    }
  }

  const finalize = (map) =>
    [...map.values()]
      .map((b) => ({
        name: b.name,
        hours: hours2(b.hours),
        billableHours: hours2(b.billableHours),
        adminHours: hours2(b.adminHours),
      }))
      .sort((a, b) => b.hours - a.hours)

  const byClient = groupBy === 'client' || groupBy === 'both' ? finalize(byClientMap) : null
  const byStaff = groupBy === 'staff' || groupBy === 'both' ? finalize(byStaffMap) : null
  // Either grouping PARTITIONS the same entries, so the grand total is the sum
  // of the rows returned alongside it and the assistant can read the list and
  // the total out in one breath. With no grouping there are no rows to sum.
  const rows = byStaff ?? byClient
  const result = {
    from,
    to,
    totalHours: rows ? sumDisplayHours(rows.map((r) => r.hours)) : hours2(totalHours),
    billableHours: rows ? sumDisplayHours(rows.map((r) => r.billableHours)) : hours2(billableHours),
  }
  if (byClient) result.byClient = byClient
  if (byStaff) result.byStaff = byStaff
  return result
}

const addDays = (isoDate, days) => {
  const d = new Date(`${isoDate}T12:00:00`)
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Open checklist tasks bucketed into overdue (due before asOf) and dueSoon
 * (asOf .. asOf+horizonDays). A task is "open" if it isn't deleted and has at
 * least one incomplete item.
 */
export function deadlines(data, { asOf, horizonDays = 7 }) {
  const { clientName, employeeName } = nameMaps(data)
  const horizon = addDays(asOf, horizonDays)
  const overdue = []
  const dueSoon = []

  for (const checklist of data.checklists ?? []) {
    if (checklist.deletedAt) continue
    const due = checklist.dueDate
    if (!due || typeof due !== 'string') continue
    const items = checklist.items ?? []
    if (items.length > 0 && items.every((item) => item.done)) continue

    const row = {
      title: checklist.title || 'Untitled task',
      client: clientName.get(checklist.clientId) || null,
      assignee: employeeName.get(checklist.assigneeId) || null,
      dueDate: due,
    }
    if (due < asOf) overdue.push(row)
    else if (due <= horizon) dueSoon.push(row)
  }

  const byDate = (a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0)
  overdue.sort(byDate)
  dueSoon.sort(byDate)
  return { asOf, horizonDays, overdueCount: overdue.length, dueSoonCount: dueSoon.length, overdue, dueSoon }
}

/**
 * Logged hours per team member for the Sun–Sat week starting weekStart,
 * versus a weekly target. status: 'over' (> target), 'near' (>= 85%), else 'ok'.
 */
export function capacity(data, { weekStart, targetHours = 40 }) {
  const { employeeName } = nameMaps(data)
  const weekEnd = addDays(weekStart, 6)
  const hoursById = new Map()
  for (const e of data.timeEntries ?? []) {
    if (typeof e.date !== 'string' || e.date < weekStart || e.date > weekEnd) continue
    hoursById.set(e.employeeId, (hoursById.get(e.employeeId) || 0) + hoursOf(e))
  }

  const staff = (data.employees ?? [])
    .filter((emp) => emp.role !== 'Owner')
    .map((emp) => {
      const hours = hoursById.get(emp.id) || 0
      const pct = targetHours > 0 ? Math.round((hours / targetHours) * 100) : 0
      const status = hours > targetHours ? 'over' : pct >= 85 ? 'near' : 'ok'
      return { name: employeeName.get(emp.id) || emp.name || emp.id, hours: hours2(hours), pctOfTarget: pct, status }
    })
    .sort((a, b) => b.hours - a.hours)

  return { weekStart, weekEnd, targetHours, staff }
}
