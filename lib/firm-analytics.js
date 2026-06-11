/**
 * Deterministic firm analytics for the assistant (Phase 4, Track A).
 *
 * Pure functions over an appDataStore.read() snapshot plus a costRates map
 * ({ employeeId: number|null }). All "current date" inputs (month, asOf,
 * weekStart) are passed in by the caller so these stay deterministic and
 * unit-testable — no Date.now() in here. The server wires the results into
 * read-only assistant tools; nothing here mutates or touches invoices.
 *
 * Money note: the app stores CLIENT billing rates (hourlyRate, monthlyRate)
 * but a per-employee cost rate is optional. So "realization" (fee ÷ hours) is
 * always available; "margin" (revenue − labor cost) is only reported when
 * every contributing employee has a cost rate — otherwise marginAvailable is
 * false and we fall back to realization.
 */

const hoursOf = (entry) => Number(entry?.minutes || 0) / 60
const round1 = (n) => Math.round(n * 10) / 10
const round2 = (n) => Math.round(n * 100) / 100

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
export function clientProfitability(data, { month, costRates = {}, lowRealizationThreshold = 50 }) {
  const { clientName } = nameMaps(data)
  const entries = monthEntries(data, month)
  const clients = (data.clients ?? []).filter((c) => !c.archivedAt && !c.deletedAt)

  const rows = []
  for (const client of clients) {
    const mine = entries.filter((e) => e.clientId === client.id)
    const totalHours = mine.reduce((sum, e) => sum + hoursOf(e), 0)
    const billableHours = mine.reduce((sum, e) => sum + (e.billable ? hoursOf(e) : 0), 0)
    const isHourly = client.billingMode === 'hourly'
    const fee = typeof client.monthlyRate === 'number' ? client.monthlyRate : 0
    const revenue = isHourly ? round2(billableHours * (Number(client.hourlyRate) || 0)) : fee

    // Realization and margin both need logged time — skip clients with no
    // hours this month (a fixed fee alone says nothing about effort).
    if (totalHours === 0) continue

    let laborCost = 0
    let marginAvailable = true
    for (const e of mine) {
      const rate = costRates[e.employeeId]
      if (rate == null) {
        marginAvailable = false
      } else {
        laborCost += hoursOf(e) * rate
      }
    }
    const realizedRate = totalHours > 0 ? round2(revenue / totalHours) : null

    rows.push({
      client: client.name || clientName.get(client.id) || client.id,
      billingMode: client.billingMode || 'fixed',
      revenue,
      totalHours: round1(totalHours),
      billableHours: round1(billableHours),
      realizedRate,
      marginAvailable,
      laborCost: marginAvailable ? round2(laborCost) : null,
      margin: marginAvailable ? round2(revenue - laborCost) : null,
      lowRealization: realizedRate != null && realizedRate < lowRealizationThreshold,
    })
  }

  rows.sort((a, b) => {
    if (a.realizedRate == null) return 1
    if (b.realizedRate == null) return -1
    return a.realizedRate - b.realizedRate
  })

  const anyCostRates = Object.values(costRates).some((r) => r != null)
  return {
    month,
    lowRealizationThreshold,
    clients: rows,
    note: anyCostRates
      ? 'Margin shown where every contributing team member has a cost rate set.'
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
        hours: round1(b.hours),
        billableHours: round1(b.billableHours),
        adminHours: round1(b.adminHours),
      }))
      .sort((a, b) => b.hours - a.hours)

  const result = {
    from,
    to,
    totalHours: round1(totalHours),
    billableHours: round1(billableHours),
  }
  if (groupBy === 'client' || groupBy === 'both') result.byClient = finalize(byClientMap)
  if (groupBy === 'staff' || groupBy === 'both') result.byStaff = finalize(byStaffMap)
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
      return { name: employeeName.get(emp.id) || emp.name || emp.id, hours: round1(hours), pctOfTarget: pct, status }
    })
    .sort((a, b) => b.hours - a.hours)

  return { weekStart, weekEnd, targetHours, staff }
}
