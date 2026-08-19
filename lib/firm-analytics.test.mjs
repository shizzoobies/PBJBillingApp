import { describe, expect, it } from 'vitest'
import { capacity, clientProfitability, deadlines, timeSummary } from './firm-analytics.js'
import { laborCost } from './payroll-cost.js'

// Minutes: 600=10h, 300=5h, 240=4h, 60=1h, 120=2h.
const data = {
  clients: [
    { id: 'c1', name: 'Fixed Co', billingMode: 'fixed', monthlyRate: 1000 },
    { id: 'c2', name: 'Hourly Co', billingMode: 'hourly', hourlyRate: 100 },
    { id: 'c3', name: 'Archived Co', billingMode: 'fixed', monthlyRate: 500, archivedAt: '2026-01-01' },
  ],
  employees: [
    { id: 'e1', name: 'Avery', role: 'Bookkeeper' },
    { id: 'e2', name: 'Jordan', role: 'Accountant' },
    { id: 'owner', name: 'Brittany', role: 'Owner' },
  ],
  timeEntries: [
    { employeeId: 'e1', clientId: 'c1', date: '2026-06-10', minutes: 600, billable: true },
    { employeeId: 'e2', clientId: 'c1', date: '2026-06-10', minutes: 300, billable: true },
    { employeeId: 'e1', clientId: 'c2', date: '2026-06-10', minutes: 240, billable: true },
    { employeeId: 'e1', clientId: 'c2', date: '2026-06-10', minutes: 60, billable: false },
    { employeeId: 'e1', clientId: '', date: '2026-06-10', minutes: 120, billable: false, isAdministrative: true },
  ],
  checklists: [
    { id: 'k1', title: 'Overdue task', clientId: 'c1', assigneeId: 'e1', dueDate: '2026-06-01', items: [{ done: false }] },
    { id: 'k2', title: 'Due soon task', clientId: 'c2', assigneeId: 'e2', dueDate: '2026-06-12', items: [{ done: false }] },
    { id: 'k3', title: 'Done task', clientId: 'c1', assigneeId: 'e1', dueDate: '2026-06-02', items: [{ done: true }] },
    { id: 'k4', title: 'Deleted', clientId: 'c1', dueDate: '2026-06-01', deletedAt: 'x', items: [{ done: false }] },
  ],
}

describe('clientProfitability', () => {
  it('computes realization and margin, worst realization first, excluding archived', () => {
    const result = clientProfitability(data, { month: '2026-06', costRates: { e1: 30, e2: 50 }, lowRealizationThreshold: 50 })
    expect(result.clients.map((c) => c.client)).toEqual(['Fixed Co', 'Hourly Co'])

    const c1 = result.clients.find((c) => c.client === 'Fixed Co')
    expect(c1.revenue).toBe(1000)
    expect(c1.totalHours).toBe(15)
    expect(c1.realizedRate).toBeCloseTo(66.67, 1)
    expect(c1.laborCost).toBe(550) // 10*30 + 5*50
    expect(c1.margin).toBe(450)
    expect(c1.marginAvailable).toBe(true)

    const c2 = result.clients.find((c) => c.client === 'Hourly Co')
    expect(c2.revenue).toBe(400) // 4 billable h * 100
    expect(c2.totalHours).toBe(5)
    expect(c2.realizedRate).toBe(80)
    expect(c2.margin).toBe(250) // 400 - 5*30
  })

  it('prices a contributor with no cost rate at zero rather than withholding margin', () => {
    // e2 has no cost rate. That is the OWNER's situation — she draws no hourly
    // wage and logs on nearly every client — so withholding margin here blanked
    // almost every row and contradicted the Recap page, which counts it as zero.
    const result = clientProfitability(data, { month: '2026-06', costRates: { e1: 30 } })
    const c1 = result.clients.find((c) => c.client === 'Fixed Co')
    expect(c1.marginAvailable).toBe(true)
    expect(c1.laborCost).toBe(300) // e1's 10h at 30; e2's 5h cost nothing
    expect(c1.margin).toBe(700) // 1000 fee - 300
    expect(c1.realizedRate).toBeCloseTo(66.67, 1) // realization unchanged
  })

  it('returns nothing for a month with no activity', () => {
    const result = clientProfitability(data, { month: '2025-01', costRates: {} })
    expect(result.clients).toEqual([])
  })
})

describe('clientProfitability labor cost parity with the payroll rule', () => {
  // This fixture is built to make the OLD local `hours × rate` loop disagree
  // with lib/payroll-cost.js in both of the ways that mattered:
  //   1. Rounding order. 30 min at $8.01/hr is arithmetically $4.005, stored
  //      as 4.00499999… — `round2` truncated it to $4.00 while the payroll
  //      report pays $4.01, and with two people on half-cents the sum-then-
  //      round loop lost a further cent against per-person rounding.
  //   2. Full-mode dedup. Every slice of a full-mode group carries the whole
  //      block's minutes; wall time (and therefore cost) must count the block
  //      ONCE per considered set, exactly as the payroll report and the
  //      Client Recap do.
  const parityData = {
    clients: [
      { id: 'a', name: 'Alpha', billingMode: 'hourly', hourlyRate: 100 },
      { id: 'b', name: 'Beta', billingMode: 'hourly', hourlyRate: 100 },
    ],
    employees: [
      { id: 'p1', name: 'Pat', role: 'Bookkeeper' },
      { id: 'p2', name: 'Quinn', role: 'Bookkeeper' },
    ],
    timeEntries: [
      // Two people each land on a half-cent for Alpha.
      { id: 't1', employeeId: 'p1', clientId: 'a', date: '2026-08-05', minutes: 30, billable: true },
      { id: 't2', employeeId: 'p2', clientId: 'a', date: '2026-08-05', minutes: 30, billable: true },
      // A full-mode group split across Alpha and Beta: each client's set holds
      // one slice, so each client is costed for the whole block — the same
      // answer the Client Recap gives for each of them.
      { id: 't3', employeeId: 'p1', clientId: 'a', date: '2026-08-06', minutes: 60, billable: true, groupId: 'g1', groupAllocation: 'full' },
      { id: 't4', employeeId: 'p1', clientId: 'b', date: '2026-08-06', minutes: 60, billable: true, groupId: 'g1', groupAllocation: 'full' },
      // A full-mode group whose slices land in the SAME client's set: the old
      // loop double-counted the block's cost; the payroll rule counts it once.
      { id: 't5', employeeId: 'p2', clientId: 'b', date: '2026-08-07', minutes: 90, billable: true, groupId: 'g2', groupAllocation: 'full' },
      { id: 't6', employeeId: 'p2', clientId: 'b', date: '2026-08-07', minutes: 90, billable: true, groupId: 'g2', groupAllocation: 'full' },
    ],
    checklists: [],
  }
  const costRates = { p1: 8.01, p2: 8.01 }
  const costRateOf = (employeeId) => costRates[employeeId] ?? null

  it('rounds per person to the cent, the way payroll pays — not sum-then-round2', () => {
    const result = clientProfitability(parityData, { month: '2026-08', costRates })
    const alpha = result.clients.find((c) => c.client === 'Alpha')
    // Pat: 90 min → 1.5h × 8.01 = 12.015 → $12.02. Quinn: 30 min → $4.005 →
    // $4.01. Payroll pays 12.02 + 4.01 = $16.03; the old loop said $16.02.
    expect(alpha.laborCost).toBe(16.03)
    expect(alpha.margin).toBe(200 - 16.03) // 2 billable hours × $100
  })

  it('counts a full-mode group once in cost, never once per slice', () => {
    const result = clientProfitability(parityData, { month: '2026-08', costRates })
    const beta = result.clients.find((c) => c.client === 'Beta')
    // Pat: one 60-min slice → $8.01. Quinn: the g2 block counts ONCE, 90 min →
    // $12.02. The old loop costed Quinn's block twice and said $32.04.
    expect(beta.laborCost).toBe(20.03)
  })

  it('matches lib/payroll-cost.js laborCost exactly for every client row', () => {
    const result = clientProfitability(parityData, { month: '2026-08', costRates })
    for (const client of parityData.clients) {
      const mine = parityData.timeEntries.filter((e) => e.clientId === client.id)
      const row = result.clients.find((c) => c.client === client.name)
      expect(row.laborCost).toBe(laborCost(mine, costRateOf))
    }
  })
})

describe('timeSummary', () => {
  it('groups hours by client and staff with billable/admin splits', () => {
    const result = timeSummary(data, { from: '2026-06-01', to: '2026-06-30', groupBy: 'both' })
    expect(result.totalHours).toBe(22)
    expect(result.billableHours).toBe(19)
    expect(result.byStaff.find((s) => s.name === 'Avery').hours).toBe(17)
    expect(result.byStaff.find((s) => s.name === 'Jordan').hours).toBe(5)
    expect(result.byClient.find((c) => c.name === 'Administrative').adminHours).toBe(2)
  })
})

describe('deadlines', () => {
  it('buckets overdue vs due-soon, skipping done and deleted tasks', () => {
    const result = deadlines(data, { asOf: '2026-06-10', horizonDays: 7 })
    expect(result.overdue.map((t) => t.title)).toEqual(['Overdue task'])
    expect(result.dueSoon.map((t) => t.title)).toEqual(['Due soon task'])
    expect(result.overdue[0].client).toBe('Fixed Co')
    expect(result.overdue[0].assignee).toBe('Avery')
  })
})

describe('capacity', () => {
  it('flags who is over a weekly target', () => {
    const result = capacity(data, { weekStart: '2026-06-07', targetHours: 15 })
    const avery = result.staff.find((s) => s.name === 'Avery')
    const jordan = result.staff.find((s) => s.name === 'Jordan')
    expect(avery.hours).toBe(17)
    expect(avery.status).toBe('over')
    expect(jordan.status).toBe('ok')
    expect(result.staff.find((s) => s.name === 'Brittany')).toBeUndefined() // owner excluded
  })
})
