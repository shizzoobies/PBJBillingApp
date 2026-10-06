import { describe, expect, it } from 'vitest'
import type { ClientRecap } from '../lib/api'
import { buildClientRecapCsv, clientRecapCsvFilename } from '../lib/clientRecapCsv'

/**
 * Client Recap export (featreq-0f761138, Alex): one CSV with every figure the
 * page shows for the selected period, in a long "Section, Row, Field, Value"
 * layout so a spreadsheet can filter or pivot it. Owner payloads carry the
 * money sections; a staff payload (no financials) exports only what it shows.
 */

const RECAP: ClientRecap = {
  client: { id: 'c1', name: '17 Signature, LLC', billingMode: 'hourly' },
  periodType: 'quarter',
  period: '2026-Q1',
  periodLabel: 'Q1 2026',
  range: { start: '2026-01-01', end: '2026-03-31' },
  monthsInPeriod: 3,
  includeFinancials: true,
  time: {
    totalHours: 18.35,
    billableHours: 18.35,
    adminHours: 0,
    priorHours: 12,
    deltaHours: 6.35,
    byStaff: [
      { name: 'Brittany Ferguson', tier: 'CFO', hours: 8.13, billableHours: 8.13 },
      { name: 'Lisa Mockabee', tier: 'Bookkeeper', hours: 10.22, billableHours: 10.22 },
    ],
    byRole: [
      {
        tier: 'CFO',
        people: ['Brittany Ferguson'],
        estimatedHours: 9,
        actualHours: 8.13,
        deltaHours: -0.87,
        direction: 'under',
      },
      {
        tier: 'Bookkeeper',
        people: ['Lisa Mockabee'],
        estimatedHours: 9,
        actualHours: 10.22,
        deltaHours: 1.22,
        direction: 'over',
      },
    ],
    roleTotals: { estimatedHours: 18, actualHours: 18.35, deltaHours: 0.35, direction: 'over' },
    estimatesVisible: true,
    hasEstimate: true,
    unestimatedRoles: [],
    whereToSetEstimates: 'Client page → Estimated monthly hours',
  },
  tasks: {
    dueThisPeriod: [
      { title: 'Monthly close', dueDate: '2026-01-31', assignee: 'Lisa Mockabee', done: true, overdue: false },
      { title: 'Sales tax filing', dueDate: '2026-03-20', assignee: null, done: false, overdue: true },
    ],
    dueCount: 2,
    completedCount: 1,
    overdueCount: 1,
    openCount: 1,
  },
  salesTax: {
    status: 'overdue',
    taskTitle: 'Sales tax filing',
    dueDate: '2026-03-20',
    figures: { taxableSales: 12000, taxCollected: 840, taxOwed: 840, notes: '', updatedAt: null },
  },
  billing: {
    billingMode: 'hourly',
    hourlyRate: 120,
    monthlyRate: null,
    monthsInPeriod: 3,
    planNames: ['Monthly Bookkeeping'],
    revenue: 2202,
    reimbursements: [{ date: '2026-02-03', description: 'Filing fee', amount: 50 }],
    reimbursementTotal: 50,
  },
  profitability: { realizedRate: 120, laborCost: 480, margin: 1722 },
  estimates: {
    hasEstimate: true,
    monthsInPeriod: 3,
    whereToSet: 'Client page → Estimated monthly hours',
    byTier: [
      {
        tier: 'CFO',
        people: ['Brittany Ferguson'],
        estimatedHours: 9,
        actualHours: 8.13,
        deltaHours: -0.87,
        direction: 'under',
        serviceValue: 1626,
        costRate: null,
        costRateBasis: null,
        costRatePeopleCount: 0,
        estimatedCost: null,
        actualCost: 0,
        costDelta: null,
        costDirection: null,
      },
      {
        tier: 'Bookkeeper',
        people: ['Lisa Mockabee'],
        estimatedHours: 9,
        actualHours: 10.22,
        deltaHours: 1.22,
        direction: 'over',
        serviceValue: 774,
        costRate: 40,
        costRateBasis: 'assigned',
        costRatePeopleCount: 1,
        estimatedCost: 360,
        actualCost: 480,
        costDelta: 120,
        costDirection: 'over',
      },
    ],
    cost: { estimated: 360, actual: 480, delta: 120, direction: 'over' },
    hours: { estimated: 18, actual: 18.35, delta: 0.35, direction: 'over' },
    profit: {
      estimatedRevenue: 2160,
      estimatedCost: 360,
      estimatedProfit: 1800,
      actualRevenue: 2202,
      actualCost: 480,
      actualProfit: 1722,
      delta: -78,
      direction: 'under',
      revenueDelta: 42,
      revenueDirection: 'over',
      serviceValue: 2400,
      serviceValueDelta: 198,
      serviceValueDirection: 'over',
    },
  },
  projection: null,
}

const find = (rows: Array<Array<string | number | null>>, section: string, row: string, field: string) =>
  rows.find((r) => r[0] === section && r[1] === row && r[2] === field)?.[3]

describe('buildClientRecapCsv', () => {
  const { headers, rows } = buildClientRecapCsv(RECAP)

  it('is a long table: Section, Row, Field, Value', () => {
    expect(headers).toEqual(['Section', 'Row', 'Field', 'Value'])
    expect(rows.every((r) => r.length === 4)).toBe(true)
  })

  it('names the client and the period first', () => {
    expect(rows[0]).toEqual(['Client', '', 'Name', '17 Signature, LLC'])
    expect(find(rows, 'Period', '', 'Type')).toBe('Quarterly')
    expect(find(rows, 'Period', '', 'Label')).toBe('Q1 2026')
    expect(find(rows, 'Period', '', 'Start')).toBe('2026-01-01')
    expect(find(rows, 'Period', '', 'End')).toBe('2026-03-31')
  })

  it('carries the Billing tiles as the page shows them', () => {
    expect(find(rows, 'Billing', '', 'Service value')).toBe(2400)
    expect(find(rows, 'Billing', '', 'Invoice')).toBe(2202)
    expect(find(rows, 'Billing', '', 'Over/Under')).toBe(198)
    expect(find(rows, 'Billing', '', 'Over/Under direction')).toBe('over')
    expect(find(rows, 'Time & hours', 'Bookkeeper', 'Cost over/under direction')).toBe('over')
    expect(find(rows, 'Time & hours', 'Total', 'Cost over/under direction')).toBe('over')
    expect(find(rows, 'Billing', '', 'Plans')).toBe('Monthly Bookkeeping')
    expect(find(rows, 'Billing', '', 'Reimbursements total')).toBe(50)
    expect(find(rows, 'Billing', 'Reimbursement 1', 'Description')).toBe('Filing fee')
    expect(find(rows, 'Billing', 'Reimbursement 1', 'Amount')).toBe(50)
  })

  it('carries every column of the Time & hours table, one row per role, plus the Total', () => {
    expect(find(rows, 'Time & hours', 'Bookkeeper', 'People')).toBe('Lisa Mockabee')
    expect(find(rows, 'Time & hours', 'Bookkeeper', 'Estimate (hours)')).toBe(9)
    expect(find(rows, 'Time & hours', 'Bookkeeper', 'Actual (hours)')).toBe(10.22)
    expect(find(rows, 'Time & hours', 'Bookkeeper', 'Over/Under (hours)')).toBe(1.22)
    expect(find(rows, 'Time & hours', 'Bookkeeper', 'Cost estimate')).toBe(360)
    expect(find(rows, 'Time & hours', 'Bookkeeper', 'Cost actual')).toBe(480)
    expect(find(rows, 'Time & hours', 'Bookkeeper', 'Cost over/under')).toBe(120)
    expect(find(rows, 'Time & hours', 'Bookkeeper', 'Service value')).toBe(774)
    // A role with no cost rate exports a blank, like the dash on screen.
    expect(find(rows, 'Time & hours', 'CFO', 'Cost estimate')).toBe('')
    expect(find(rows, 'Time & hours', 'Total', 'Actual (hours)')).toBe(18.35)
    expect(find(rows, 'Time & hours', 'Total', 'Cost actual')).toBe(480)
    expect(find(rows, 'Hours by person', 'Lisa Mockabee', 'Billable hours')).toBe(10.22)
    expect(find(rows, 'Hours by person', '', 'Total hours')).toBe(18.35)
    expect(find(rows, 'Hours by person', '', 'Prior period hours')).toBe(12)
  })

  it('carries Profitability, the tasks and the sales tax figures', () => {
    expect(find(rows, 'Profitability', '', 'Estimated profit')).toBe(1800)
    expect(find(rows, 'Profitability', '', 'Actual profit')).toBe(1722)
    expect(find(rows, 'Profitability', '', 'Over/Under')).toBe(-78)
    expect(find(rows, 'Profitability', '', 'Labor cost')).toBe(480)
    // Row = title + due date, so a title that recurs month to month (or across
    // a master's companies) never collapses into one key.
    expect(find(rows, 'Tasks', 'Sales tax filing (2026-03-20)', 'Status')).toBe('Overdue')
    expect(find(rows, 'Tasks', 'Monthly close (2026-01-31)', 'Status')).toBe('Done')
    expect(find(rows, 'Tasks', 'Monthly close (2026-01-31)', 'Assignee')).toBe('Lisa Mockabee')
    expect(find(rows, 'Tasks', 'Monthly close (2026-01-31)', 'Title')).toBe('Monthly close')
    expect(find(rows, 'Tasks', '', 'Due this period')).toBe(2)
    expect(find(rows, 'Sales tax', '', 'Status')).toBe('Overdue')
    expect(find(rows, 'Sales tax', '', 'Tax owed')).toBe(840)
  })

  it('exports only what a staff member sees when the payload has no financials', () => {
    const staff: ClientRecap = {
      ...RECAP,
      includeFinancials: false,
      billing: null,
      profitability: null,
      estimates: null,
      salesTax: null,
    }
    const { rows: staffRows } = buildClientRecapCsv(staff)
    expect(staffRows.some((r) => r[0] === 'Billing')).toBe(false)
    expect(staffRows.some((r) => r[0] === 'Profitability')).toBe(false)
    expect(staffRows.some((r) => r[0] === 'Time & hours' && r[2] === 'Cost actual')).toBe(false)
    expect(find(staffRows, 'Time & hours', 'Bookkeeper', 'Actual (hours)')).toBe(10.22)
  })

  it('calls an exact match on the Billing tile "Matches invoice", as the page does, not "On estimate"', () => {
    const matched: ClientRecap = {
      ...RECAP,
      estimates: {
        ...RECAP.estimates!,
        profit: { ...RECAP.estimates!.profit, serviceValue: 2202, serviceValueDelta: 0, serviceValueDirection: 'on' },
      },
    }
    const { rows: r } = buildClientRecapCsv(matched)
    expect(find(r, 'Billing', '', 'Over/Under direction')).toBe('Matches invoice')
    // The plan-vs-actual rows keep the page's "On estimate".
    const onHours: ClientRecap = {
      ...RECAP,
      time: { ...RECAP.time, roleTotals: { ...RECAP.time.roleTotals, deltaHours: 0, direction: 'on' } },
    }
    expect(find(buildClientRecapCsv(onHours).rows, 'Time & hours', 'Total', 'Over/Under direction')).toBe('On estimate')
  })

  it('exports a billing master roll-up with its companies and no billing mode', () => {
    const master: ClientRecap = {
      ...RECAP,
      client: { id: 'm1', name: 'KLC Master', billingMode: null },
      isBillingMaster: true,
      subs: [
        { id: 'c1', name: 'Clover' },
        { id: 'c2', name: 'Northstar' },
      ],
      salesTax: null,
      projection: null,
    }
    const { rows: r } = buildClientRecapCsv(master)
    expect(find(r, 'Client', '', 'Billing type')).toBe('Billing master (roll-up)')
    expect(find(r, 'Client', '', 'Companies')).toBe('Clover, Northstar')
    expect(r.some((row) => row[0] === 'Sales tax')).toBe(false)
  })

  it('keeps text that starts like a formula from being run by the spreadsheet', () => {
    const tricky: ClientRecap = {
      ...RECAP,
      billing: {
        ...RECAP.billing!,
        reimbursements: [{ date: '2026-02-03', description: '=HYPERLINK("x")', amount: 1 }],
      },
      tasks: {
        ...RECAP.tasks,
        dueThisPeriod: [{ title: '-Minus first', dueDate: '2026-01-05', assignee: null, done: false, overdue: false }],
      },
    }
    const { rows: r } = buildClientRecapCsv(tricky)
    expect(find(r, 'Billing', 'Reimbursement 1', 'Description')).toBe(`'=HYPERLINK("x")`)
    expect(find(r, 'Tasks', `'-Minus first (2026-01-05)`, 'Title')).toBe(`'-Minus first`)
  })

  it('includes the projection when there is one', () => {
    const withProjection: ClientRecap = {
      ...RECAP,
      projection: {
        basis: 'hourly',
        isEstimate: true,
        amount: 2500,
        serviceAmount: 2450,
        reimbursementsToDate: 50,
        hoursToDate: 10,
        businessDaysElapsed: 10,
        businessDaysInMonth: 21,
        method: 'Hours so far, scaled to the month.',
      },
    }
    const { rows: projected } = buildClientRecapCsv(withProjection)
    expect(find(projected, 'Projected invoice', '', 'Projected total')).toBe(2500)
    expect(find(projected, 'Projected invoice', '', 'Basis')).toBe('Hours so far, scaled to the month.')
    expect(find(projected, 'Projected invoice', '', 'Estimate?')).toBe('Yes')
  })
})

describe('clientRecapCsvFilename', () => {
  it('names the file by client and period, safe for any filesystem', () => {
    expect(clientRecapCsvFilename(RECAP)).toBe('client-recap-17-signature-llc-2026-Q1.csv')
  })

  it('falls back to the client id when the name has nothing to slug, and caps a long name', () => {
    expect(
      clientRecapCsvFilename({ ...RECAP, client: { ...RECAP.client, id: 'client-x9', name: '!!!' } }),
    ).toBe('client-recap-client-x9-2026-Q1.csv')
    const long = clientRecapCsvFilename({ ...RECAP, client: { ...RECAP.client, name: 'a'.repeat(100) } })
    expect(long.length).toBeLessThan(100)
    expect(long.endsWith('-2026-Q1.csv')).toBe(true)
  })
})
