import { describe, expect, it } from 'vitest'
import { buildClientRecap } from './client-recap.js'

const data = {
  clients: [
    { id: 'c1', name: 'Clover', billingMode: 'hourly', hourlyRate: 100, planIds: [] },
    { id: 'c2', name: 'Northstar', billingMode: 'subscription', monthlyRate: 500, planIds: ['p1'] },
  ],
  plans: [{ id: 'p1', name: 'Core' }],
  employees: [
    { id: 'e1', name: 'Avery', role: 'Bookkeeper' },
    { id: 'e2', name: 'Jordan', role: 'Accountant' },
  ],
  timeEntries: [
    { employeeId: 'e1', clientId: 'c1', date: '2026-08-12', minutes: 600, billable: true },
    { employeeId: 'e2', clientId: 'c1', date: '2026-08-13', minutes: 300, billable: true },
    { employeeId: 'e1', clientId: 'c1', date: '2026-08-14', minutes: 60, billable: false },
    { employeeId: 'e1', clientId: 'c1', date: '2026-07-10', minutes: 120, billable: true }, // prior month
    { employeeId: 'e1', clientId: 'c2', date: '2026-08-01', minutes: 120, billable: true },
  ],
  checklists: [
    { id: 'k1', title: 'Monthly Sales Tax - CD', clientId: 'c1', assigneeId: 'e1', dueDate: '2026-08-20', items: [{ done: false }] },
    { id: 'k2', title: 'Bank rec', clientId: 'c1', assigneeId: 'e1', dueDate: '2026-08-10', items: [{ done: true }] },
    { id: 'k3', title: 'July task', clientId: 'c1', assigneeId: 'e1', dueDate: '2026-07-05', items: [{ done: false }] },
  ],
  reimbursements: [
    { id: 'r1', clientId: 'c1', date: '2026-08-05', description: 'Filing fee', amount: 50 },
    { id: 'r2', clientId: 'c1', date: '2026-07-01', description: 'Old', amount: 999 },
  ],
}

const ownerOpts = {
  clientId: 'c1',
  periodType: 'month',
  period: '2026-08',
  today: '2026-08-25',
  includeFinancials: true,
  costRates: { e1: 30, e2: 50 },
  salesTaxRecord: { taxableSales: 1000, taxCollected: 80, taxOwed: 80, notes: 'filed', updatedAt: '2026-08-21T00:00:00Z' },
}

describe('buildClientRecap — owner', () => {
  const r = buildClientRecap(data, ownerOpts)

  it('totals hours for the period only, with prior-period delta and by-staff', () => {
    expect(r.time.totalHours).toBe(16) // 10 + 5 + 1
    expect(r.time.billableHours).toBe(15)
    expect(r.time.priorHours).toBe(2)
    expect(r.time.deltaHours).toBe(14)
    expect(r.time.byStaff.find((s) => s.name === 'Avery').hours).toBe(11)
    expect(r.time.byStaff.find((s) => s.name === 'Jordan').hours).toBe(5)
  })

  it('buckets tasks due in the period (excluding July)', () => {
    expect(r.tasks.dueCount).toBe(2)
    expect(r.tasks.completedCount).toBe(1)
    expect(r.tasks.overdueCount).toBe(1) // sales tax due 08-20, not done, past today
  })

  it('detects sales-tax filing status + includes figures for the owner', () => {
    expect(r.salesTax.status).toBe('overdue')
    expect(r.salesTax.taskTitle).toBe('Monthly Sales Tax - CD')
    expect(r.salesTax.figures.taxCollected).toBe(80)
  })

  it('computes hourly revenue, reimbursements, realization and margin', () => {
    expect(r.billing.revenue).toBe(1500) // 15 billable h * 100
    expect(r.billing.reimbursementTotal).toBe(50) // July reimbursement excluded
    expect(r.profitability.realizedRate).toBeCloseTo(93.75, 2) // 1500 / 16
    expect(r.profitability.margin).toBe(920) // 1500 - (11*30 + 5*50)
    expect(r.profitability.marginAvailable).toBe(true)
  })
})

describe('buildClientRecap — staff (no financials)', () => {
  const r = buildClientRecap(data, { ...ownerOpts, includeFinancials: false, costRates: {} })

  it('omits all financial data but keeps operational data', () => {
    expect(r.billing).toBeNull()
    expect(r.profitability).toBeNull()
    expect(r.salesTax.figures).toBeNull()
    // Operational data still present:
    expect(r.time.totalHours).toBe(16)
    expect(r.salesTax.status).toBe('overdue')
    expect(r.tasks.dueCount).toBe(2)
  })
})

describe('buildClientRecap — subscription + quarterly', () => {
  it('bills the monthly rate across the months in the period', () => {
    const r = buildClientRecap(data, {
      clientId: 'c2',
      periodType: 'quarter',
      period: '2026-Q3',
      today: '2026-08-25',
      includeFinancials: true,
      costRates: {},
    })
    expect(r.billing.revenue).toBe(1500) // 500/mo * 3 months
    expect(r.billing.planNames).toEqual(['Core'])
    expect(r.profitability.marginAvailable).toBe(false) // e1 has no cost rate
  })
})

describe('buildClientRecap — sales-tax edge cases', () => {
  it('reports not_started when there is no tax task in the period', () => {
    const r = buildClientRecap(data, { ...ownerOpts, period: '2026-09' })
    expect(r.salesTax.status).toBe('not_started')
  })

  it('reports done when the tax task is complete', () => {
    const done = {
      ...data,
      checklists: [{ id: 'k1', title: 'Sales Tax', clientId: 'c1', assigneeId: 'e1', dueDate: '2026-08-20', items: [{ done: true }] }],
    }
    expect(buildClientRecap(done, ownerOpts).salesTax.status).toBe('done')
  })
})
