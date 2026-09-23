import { describe, expect, it } from 'vitest'
import { buildClientRecap } from './client-recap.js'
import { clientProfitability } from './firm-analytics.js'

const billRateVersions = [
  { userId: 'emp-lisa', effectivePeriod: '2026-06', rate: 40 },
  { userId: 'emp-lisa', effectivePeriod: '2026-09', rate: 55 },
]

const data = {
  clients: [
    {
      id: 'c1',
      name: 'Acme',
      billingMode: 'hourly',
      hourlyRate: 100,
      // Moved to September's rates in August, so July still bills at June's.
      hourlyRatePeriod: '2026-09',
      hourlyRateHistory: [
        { from: null, to: '2026-06', changedAt: '2026-06-01T00:00:00.000Z', changedBy: 'u' },
        { from: '2026-06', to: '2026-09', changedAt: '2026-08-20T00:00:00.000Z', changedBy: 'u' },
      ],
    },
  ],
  employees: [{ id: 'emp-lisa', name: 'Lisa', role: 'Bookkeeper' }],
  plans: [],
  reimbursements: [],
  recurringReimbursements: [],
  timeEntries: [
    { id: 't-jul', clientId: 'c1', employeeId: 'emp-lisa', minutes: 60, billable: true, date: '2026-07-10' },
    { id: 't-sep', clientId: 'c1', employeeId: 'emp-lisa', minutes: 60, billable: true, date: '2026-09-10' },
  ],
  checklists: [],
}

describe('a quarterly recap prices each month at the pin that applied THEN', () => {
  it('bills July at the old pin and September at the new one', () => {
    const recap = buildClientRecap(data, {
      clientId: 'c1',
      periodType: 'quarter',
      period: '2026-Q3',
      today: '2026-10-01',
      includeFinancials: true,
      billRateVersions,
    })
    // July 40 + August 0 + September 55.
    expect(recap.billing.revenue).toBe(95)
  })

  it('a monthly recap of July still reads 40, not today’s 55', () => {
    const recap = buildClientRecap(data, {
      clientId: 'c1',
      periodType: 'month',
      period: '2026-07',
      today: '2026-10-01',
      includeFinancials: true,
      billRateVersions,
    })
    expect(recap.billing.revenue).toBe(40)
  })
})

describe('clientProfitability prices hourly revenue through the resolver', () => {
  it('uses the pin that applied in the month asked about', () => {
    const july = clientProfitability(data, { month: '2026-07', billRateVersions })
    expect(july.clients.find((row) => row.client === 'Acme').revenue).toBe(40)
    const september = clientProfitability(data, { month: '2026-09', billRateVersions })
    expect(september.clients.find((row) => row.client === 'Acme').revenue).toBe(55)
  })

  it('still falls back to the client’s own rate when there is no history', () => {
    const plain = clientProfitability(data, { month: '2026-09' })
    expect(plain.clients.find((row) => row.client === 'Acme').revenue).toBe(100)
  })
})
