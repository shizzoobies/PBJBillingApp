import { describe, expect, it } from 'vitest'
import { capacity, clientProfitability, deadlines, timeSummary } from './firm-analytics.js'

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

  it('marks margin unavailable when a contributor has no cost rate', () => {
    const result = clientProfitability(data, { month: '2026-06', costRates: { e1: 30 } })
    const c1 = result.clients.find((c) => c.client === 'Fixed Co')
    expect(c1.marginAvailable).toBe(false) // e2 contributed but has no rate
    expect(c1.margin).toBeNull()
    expect(c1.realizedRate).toBeCloseTo(66.67, 1) // realization still works
  })

  it('returns nothing for a month with no activity', () => {
    const result = clientProfitability(data, { month: '2025-01', costRates: {} })
    expect(result.clients).toEqual([])
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
