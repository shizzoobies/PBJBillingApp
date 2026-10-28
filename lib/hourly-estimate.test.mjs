/**
 * The one "estimated monthly invoice" helper (featreq-a9de307f, featreq-2ce41d5f):
 * estimated hours per role x that role's bill rate. The Billing tab and the
 * Client Recap both call it, so the last test pins that they agree.
 */
import { describe, expect, it } from 'vitest'
import { buildClientRecap } from './client-recap.js'
import { estimatedMonthlyInvoice } from './hourly-estimate.js'

const employees = [
  { id: 'lisa', name: 'Lisa', role: 'Bookkeeper' },
  { id: 'tom', name: 'Tom', role: 'Bookkeeper' },
  { id: 'ann', name: 'Ann', role: 'Accountant' },
  { id: 'brit', name: 'Brittany', role: 'Owner' },
]
const versions = [
  { userId: 'lisa', effectivePeriod: '2026-01', rate: 90 },
  { userId: 'tom', effectivePeriod: '2026-01', rate: 100 },
  { userId: 'ann', effectivePeriod: '2026-01', rate: 150 },
]
const client = {
  id: 'c1',
  billingMode: 'hourly',
  hourlyRate: 0,
  assignedBookkeeperIds: ['lisa', 'tom', 'ann'],
  estimatedBookkeeperHours: 10,
  estimatedAccountantHours: 2,
}

describe('estimatedMonthlyInvoice', () => {
  it('prices each role at the mean of its assigned team and sums', () => {
    const r = estimatedMonthlyInvoice({ client, employees, billRateVersions: versions, period: '2026-08' })
    const bk = r.tiers.find((t) => t.tier === 'Bookkeeper')
    expect(bk).toMatchObject({ hours: 10, rate: 95, amount: 950, employeeCount: 2, source: 'assigned' })
    const acct = r.tiers.find((t) => t.tier === 'Accountant')
    expect(acct).toMatchObject({ hours: 2, rate: 150, amount: 300, employeeCount: 1 })
    expect(r.total).toBe(1250)
    expect(r.basis).toBe('rates')
    expect(r.hasEstimate).toBe(true)
  })

  it('lists all three roles; an unset role is zero hours and adds nothing', () => {
    const r = estimatedMonthlyInvoice({ client, employees, billRateVersions: versions, period: '2026-08' })
    expect(r.tiers.map((t) => t.tier)).toEqual(['CFO', 'Accountant', 'Bookkeeper'])
    const cfo = r.tiers.find((t) => t.tier === 'CFO')
    expect(cfo).toMatchObject({ hours: 0, hasEstimate: false, amount: 0 })
  })

  it('prices at the client pin, not at the newest rate', () => {
    const raised = [...versions, { userId: 'ann', effectivePeriod: '2026-07', rate: 200 }]
    const unpinned = estimatedMonthlyInvoice({ client, employees, billRateVersions: raised, period: '2026-08' })
    expect(unpinned.tiers.find((t) => t.tier === 'Accountant').rate).toBe(200)
    const pinned = estimatedMonthlyInvoice({
      client: { ...client, hourlyRatePeriod: '2026-03' },
      employees,
      billRateVersions: raised,
      period: '2026-08',
    })
    expect(pinned.tiers.find((t) => t.tier === 'Accountant').rate).toBe(150)
  })

  it('falls back to the people who logged time, then to the client rate', () => {
    const unassigned = { ...client, assignedBookkeeperIds: [], hourlyRate: 80 }
    const none = estimatedMonthlyInvoice({ client: unassigned, employees, billRateVersions: versions, period: '2026-08' })
    expect(none.basis).toBe('client_rate')
    expect(none.total).toBe(960) // 12 h x $80
    expect(none.tiers.find((t) => t.tier === 'Bookkeeper').source).toBe('client_rate')

    const logged = estimatedMonthlyInvoice({
      client: unassigned,
      employees,
      billRateVersions: versions,
      period: '2026-08',
      loggedEmployeeIds: ['lisa', 'lisa'],
    })
    expect(logged.tiers.find((t) => t.tier === 'Bookkeeper')).toMatchObject({ rate: 90, source: 'logged', employeeCount: 1 })
    expect(logged.total).toBe(900 + 160) // 10 x 90, then 2 Accountant hours at the client rate
    expect(logged.basis).toBe('rates')
  })

  it('says "none" when nothing has a rate, and still totals zero', () => {
    const r = estimatedMonthlyInvoice({
      client: { ...client, assignedBookkeeperIds: [] },
      employees,
      billRateVersions: [],
      period: '2026-08',
    })
    expect(r.basis).toBe('none')
    expect(r.total).toBe(0)
    expect(r.tiers.every((t) => t.rate === null)).toBe(true)
  })

  it('names a role with hours and no rate instead of pricing it at zero', () => {
    const r = estimatedMonthlyInvoice({
      client: { ...client, estimatedCfoHours: 2 },
      employees,
      billRateVersions: versions,
      period: '2026-08',
    })
    expect(r.unrated).toEqual(['CFO'])
    expect(r.tiers.find((t) => t.tier === 'CFO')).toMatchObject({ rate: null, hours: 2 })
    expect(r.total).toBe(1250) // the CFO hours are not in it
    const rated = estimatedMonthlyInvoice({ client, employees, billRateVersions: versions, period: '2026-08' })
    expect(rated.unrated).toEqual([])
  })

  it('has no estimate when no role has hours', () => {
    const r = estimatedMonthlyInvoice({
      client: { ...client, estimatedBookkeeperHours: undefined, estimatedAccountantHours: undefined },
      employees,
      billRateVersions: versions,
      period: '2026-08',
    })
    expect(r.hasEstimate).toBe(false)
    expect(r.total).toBe(0)
  })

  it('scales hours by months and rounds the total once, to cents', () => {
    const r = estimatedMonthlyInvoice({
      client: { ...client, estimatedBookkeeperHours: 1.25, estimatedAccountantHours: undefined },
      employees,
      billRateVersions: versions,
      period: '2026-08',
      months: 3,
    })
    expect(r.tiers.find((t) => t.tier === 'Bookkeeper').hours).toBe(3.75)
    expect(r.total).toBe(356.25)
  })

  it('is what the Client Recap quotes as estimated revenue', () => {
    const data = { clients: [client], plans: [], employees, timeEntries: [], reimbursements: [], recurringReimbursements: [] }
    const recap = buildClientRecap(data, {
      clientId: 'c1',
      periodType: 'month',
      period: '2026-08',
      today: '2026-08-31',
      includeFinancials: true,
      billRateVersions: versions,
    })
    const helper = estimatedMonthlyInvoice({ client, employees, billRateVersions: versions, period: '2026-08' })
    expect(recap.estimates.profit.estimatedRevenue).toBe(helper.total)
  })
})
