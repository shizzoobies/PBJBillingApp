/**
 * featreq-8dffdff7 (Client Recap): "When looking at the client by quarter or by
 * year it shows data and calculates months that were not active. Ie the client
 * started in August, but the aggregate of data pulls as if the client was
 * active all year distorting the numbers."
 *
 * A quarter or a year now counts only the months the client was ACTIVE: from
 * its first time entry / invoice / creation through the current month (an
 * inactive client stops at its last evidence). See clientActiveMonths in
 * lib/client-recap.js for the rule.
 *
 * "Today" is pinned through the recap's own `today` (a firm-day yyyy-mm-dd),
 * never the clock.
 */
import { describe, expect, it } from 'vitest'
import { buildClientRecap, buildMasterRecap, clientActiveMonths } from './client-recap.js'

const NOVEMBER = '2026-11-12'

const employees = [{ id: 'lisa', name: 'Lisa', role: 'Bookkeeper', billRate: 120 }]
const costRateVersions = [{ userId: 'lisa', effectiveDate: '1970-01-01', rate: 40 }]

/**
 * Bright Tower's shape: created by signing in August 2026, first time in August.
 * $900 a month, 10 Bookkeeper hours a month planned.
 */
const augustStarter = {
  id: 'bt',
  name: 'Bright Tower',
  billingMode: 'subscription',
  monthlyRate: 900,
  planIds: [],
  assignedBookkeeperIds: ['lisa'],
  estimatedBookkeeperHours: 10,
  createdAt: '2026-08-14T16:00:00.000Z',
}

/**
 * An IMPORTED client: the row was created on the import day (2026-08-14), but
 * its time goes back to January - createdAt alone would wrongly start it in August.
 */
const imported = {
  id: 'old',
  name: 'Old Faithful',
  billingMode: 'subscription',
  monthlyRate: 500,
  planIds: [],
  assignedBookkeeperIds: ['lisa'],
  estimatedBookkeeperHours: 4,
  createdAt: '2026-08-14T16:00:00.000Z',
}

const entry = (id, clientId, date, minutes = 120) => ({
  id,
  employeeId: 'lisa',
  clientId,
  date,
  minutes,
  billable: true,
})

const data = {
  clients: [augustStarter, imported],
  plans: [],
  employees,
  timeEntries: [
    entry('a1', 'bt', '2026-08-20', 600),
    entry('a2', 'bt', '2026-10-03', 300),
    entry('o1', 'old', '2026-01-09'),
    entry('o2', 'old', '2026-06-15'),
  ],
  checklists: [],
  reimbursements: [],
  recurringReimbursements: [],
}

const opts = (over = {}) => ({
  clientId: 'bt',
  periodType: 'year',
  period: '2026',
  today: NOVEMBER,
  includeFinancials: true,
  costRateVersions,
  ...over,
})

describe('a client that started in August, viewed by year and by quarter', () => {
  const year = buildClientRecap(data, opts())

  it('counts August through November of 2026 - not twelve months', () => {
    expect(year.calendarMonthsInPeriod).toBe(12)
    expect(year.monthsInPeriod).toBe(4)
    expect(year.activeMonths).toEqual(['2026-08', '2026-09', '2026-10', '2026-11'])
    expect(year.activeInPeriod).toBe(true)
    expect(year.clientSince).toBe('2026-08')
  })

  it('scales the monthly estimates by those four months', () => {
    expect(year.estimates.monthsInPeriod).toBe(4)
    expect(year.time.byRole.find((row) => row.tier === 'Bookkeeper').estimatedHours).toBe(40)
    expect(year.estimates.hours.estimated).toBe(40)
    // 40 hours at Lisa's $40 cost.
    expect(year.estimates.profit.estimatedCost).toBe(1600)
    expect(year.estimates.profit.estimatedRevenue).toBe(3600) // 4 x $900
  })

  it('prices the plan for the active months only, and the tile says so', () => {
    expect(year.billing.revenue).toBe(3600)
    expect(year.billing.monthsInPeriod).toBe(4)
    expect(year.billing.invoice).toMatchObject({
      amount: 3600,
      months: 4,
      sentMonths: 0,
      caption: 'Not invoiced yet',
    })
    const withAugust = buildClientRecap(
      data,
      opts({
        invoices: [
          {
            id: 'inv-aug',
            clientId: 'bt',
            period: '2026-08',
            kind: 'monthly',
            status: 'sent',
            number: 31,
            sentAt: '2026-09-02T14:00:00.000Z',
            total: 900,
            lineItems: [{ kind: 'plan', amount: 900 }],
          },
        ],
      }),
    )
    expect(withAugust.billing.invoice.caption).toBe('1 of 4 months from sent invoices')
    expect(withAugust.billing.invoice.months).toBe(4)
  })

  it('counts August and September for the third quarter', () => {
    const q3 = buildClientRecap(data, opts({ periodType: 'quarter', period: '2026-Q3' }))
    expect(q3.calendarMonthsInPeriod).toBe(3)
    expect(q3.monthsInPeriod).toBe(2)
    expect(q3.activeMonths).toEqual(['2026-08', '2026-09'])
    expect(q3.estimates.profit.estimatedRevenue).toBe(1800)
    expect(q3.time.byRole.find((row) => row.tier === 'Bookkeeper').estimatedHours).toBe(20)
    expect(q3.billing.invoice.months).toBe(2)
  })

  it('says the first quarter is not an active period, with nothing planned against it', () => {
    const q1 = buildClientRecap(data, opts({ periodType: 'quarter', period: '2026-Q1' }))
    expect(q1.monthsInPeriod).toBe(0)
    expect(q1.activeMonths).toEqual([])
    expect(q1.activeInPeriod).toBe(false)
    expect(q1.clientSince).toBe('2026-08')
    // Nothing planned: NULL, never a zero to print a variance against.
    expect(q1.estimates.profit.estimatedRevenue).toBeNull()
    expect(q1.estimates.profit.estimatedCost).toBeNull()
    expect(q1.estimates.hasEstimate).toBe(false)
    expect(q1.time.hasEstimate).toBe(false)
    expect(q1.time.byRole).toEqual([])
    expect(q1.periodNotStarted).toBe(false)
    expect(q1.uncountedMonths.beforeStart).toEqual(['2026-01', '2026-02', '2026-03'])
    expect(q1.billing.revenue).toBe(0)
    expect(q1.billing.invoice).toMatchObject({ amount: 0, months: 0, caption: 'Not active in this period' })
    // The actual side still shows whatever exists - here, nothing.
    expect(q1.time.totalHours).toBe(0)
  })
})

describe('a client active all along', () => {
  it('keeps every month of a closed quarter - its time goes back to January', () => {
    const q1 = buildClientRecap(data, opts({ clientId: 'old', periodType: 'quarter', period: '2026-Q1' }))
    expect(q1.monthsInPeriod).toBe(3)
    expect(q1.clientSince).toBe('2026-01')
    expect(q1.estimates.profit.estimatedRevenue).toBe(1500)
  })

  it('keeps all twelve months of a closed year', () => {
    const year = buildClientRecap(data, opts({ clientId: 'old', today: '2027-01-05' }))
    expect(year.monthsInPeriod).toBe(12)
    expect(year.estimates.profit.estimatedRevenue).toBe(6000)
    expect(year.time.byRole.find((row) => row.tier === 'Bookkeeper').estimatedHours).toBe(48)
  })

  it('leaves out the months of the current year that have not started yet', () => {
    const year = buildClientRecap(data, opts({ clientId: 'old' }))
    expect(year.monthsInPeriod).toBe(11) // January through November; December has not begun
    expect(year.activeMonths[0]).toBe('2026-01')
    expect(year.activeMonths.at(-1)).toBe('2026-11')
    expect(year.billing.revenue).toBe(5500)
    // December is left out because it has not begun - not because the client was idle.
    expect(year.uncountedMonths).toEqual({ beforeStart: [], notYetBegun: ['2026-12'], afterLastActivity: [] })
  })

  it('a period after this month has not started yet - it is not called inactive', () => {
    const next = buildClientRecap(data, opts({ clientId: 'old', periodType: 'quarter', period: '2027-Q1' }))
    expect(next.activeInPeriod).toBe(false)
    expect(next.periodNotStarted).toBe(true)
    expect(next.estimates.profit.estimatedRevenue).toBeNull()
    expect(next.billing.invoice.caption).toBe('Period not started yet')
    expect(next.uncountedMonths.notYetBegun).toEqual(['2027-01', '2027-02', '2027-03'])
  })

  it('takes an earlier invoice as the start, from any period the caller loaded', () => {
    const since2025 = buildClientRecap(
      data,
      opts({
        clientId: 'old',
        period: '2025',
        activityInvoices: [
          { id: 'x', clientId: 'old', period: '2025-05', kind: 'monthly', status: 'paid' },
          // A void and a retainer are not evidence.
          { id: 'v', clientId: 'old', period: '2025-02', kind: 'monthly', status: 'void' },
          { id: 'r', clientId: 'old', period: '2025-01', kind: 'retainer', status: 'paid' },
          // The store's narrow evidence row for a master's invoice carrying this client.
          { clientId: 'some-master', period: '2025-03', kind: 'monthly', status: 'sent', sourceClientIds: ['other'] },
        ],
      }),
    )
    expect(since2025.clientSince).toBe('2025-05')
    expect(since2025.monthsInPeriod).toBe(8) // May through December 2025
  })
})

describe('what the rule leaves alone', () => {
  const hourlyClient = {
    id: 'hr',
    name: 'Hourly Co',
    billingMode: 'hourly',
    hourlyRate: 100,
    planIds: [],
    assignedBookkeeperIds: ['lisa'],
    estimatedBookkeeperHours: 10,
    createdAt: '2026-08-14T16:00:00.000Z',
  }
  const hourlyData = {
    ...data,
    clients: [hourlyClient],
    timeEntries: [entry('h1', 'hr', '2026-08-20', 720), entry('h2', 'hr', '2026-09-03', 60)],
  }

  it('an hourly client keeps its service value and revenue; only the estimate shrinks', () => {
    const year = buildClientRecap(hourlyData, opts({ clientId: 'hr' }))
    const aug = buildClientRecap(hourlyData, opts({ clientId: 'hr', periodType: 'month', period: '2026-08' }))
    const sep = buildClientRecap(hourlyData, opts({ clientId: 'hr', periodType: 'month', period: '2026-09' }))
    // 13 hours at Lisa's $120, wherever they fall.
    expect(year.estimates.profit.serviceValue).toBe(1560)
    expect(year.estimates.profit.serviceValue).toBe(
      aug.estimates.profit.serviceValue + sep.estimates.profit.serviceValue,
    )
    expect(year.billing.revenue).toBe(1560)
    expect(year.time.totalHours).toBe(13)
    expect(year.monthsInPeriod).toBe(4)
    expect(year.estimates.hours.estimated).toBe(40)
  })

  it('a month before the start is not active; any other month is unchanged', () => {
    const july = buildClientRecap(data, opts({ periodType: 'month', period: '2026-07' }))
    expect(july.activeInPeriod).toBe(false)
    expect(july.monthsInPeriod).toBe(0)
    expect(july.estimates.profit.estimatedRevenue).toBeNull()
    expect(july.billing.invoice.caption).toBe('Not active in this period')
    // No plan figure to project for a month the client did not have.
    expect(july.projection).toBeNull()

    const august = buildClientRecap(data, opts({ periodType: 'month', period: '2026-08' }))
    expect(august.monthsInPeriod).toBe(1)
    expect(august.estimates.profit.estimatedRevenue).toBe(900)
    // A month view of a month not yet begun stays the plain one-month view.
    const december = buildClientRecap(data, opts({ periodType: 'month', period: '2026-12' }))
    expect(december.monthsInPeriod).toBe(1)
    expect(december.estimates.profit.estimatedRevenue).toBe(900)
  })

  it('caps an inactive client at its last month with time or an invoice', () => {
    const gone = { ...imported, id: 'gone', name: 'Gone Co', lifecycleStage: 'inactive' }
    const goneData = {
      ...data,
      clients: [gone],
      timeEntries: [entry('g1', 'gone', '2026-03-02'), entry('g2', 'gone', '2026-06-30')],
    }
    const year = buildClientRecap(goneData, opts({ clientId: 'gone' }))
    expect(year.activeMonths).toEqual(['2026-03', '2026-04', '2026-05', '2026-06'])
    expect(year.uncountedMonths.afterLastActivity).toEqual(['2026-07', '2026-08', '2026-09', '2026-10', '2026-11'])
    expect(year.uncountedMonths.notYetBegun).toEqual(['2026-12'])
    expect(year.estimates.profit.estimatedRevenue).toBe(2000)
  })

  it('never drops a month that has time in it, even one not yet begun', () => {
    const early = { ...data, timeEntries: [...data.timeEntries, entry('a3', 'bt', '2026-12-01', 60)] }
    const year = buildClientRecap(early, opts())
    expect(year.activeMonths.at(-1)).toBe('2026-12')
    expect(year.monthsInPeriod).toBe(5)
  })

  it('reads an evening creation on the firm calendar, not the UTC one', () => {
    // 10:30 pm Eastern on July 31 is already August 1 in UTC.
    const result = clientActiveMonths({
      client: { id: 'z', createdAt: '2026-08-01T02:30:00.000Z' },
      rangeMonths: ['2026-07', '2026-08', '2026-09'],
      periodType: 'quarter',
      today: '2026-09-15',
    })
    expect(result.clientSince).toBe('2026-07')
    expect(result.activeMonths).toEqual(['2026-07', '2026-08', '2026-09'])
  })

  it('with no evidence at all, every month of the range counts (the old behavior)', () => {
    const result = clientActiveMonths({
      client: { id: 'z' },
      rangeMonths: ['2026-01', '2026-02', '2026-03'],
      periodType: 'quarter',
      today: '2026-02-10',
    })
    expect(result).toMatchObject({ activeMonths: ['2026-01', '2026-02', '2026-03'], clientSince: null })
  })

  it('a staff payload carries the months but still no estimates', () => {
    const staff = buildClientRecap(data, opts({ includeFinancials: false }))
    expect(staff.monthsInPeriod).toBe(4)
    expect(staff.activeMonths).toHaveLength(4)
    expect(staff.estimates).toBeNull()
    expect(staff.time.byRole.every((row) => row.estimatedHours === null)).toBe(true)
  })
})

describe('a billing master whose companies started in different months', () => {
  const master = { id: 'm', name: 'KLC Master', isBillingMaster: true }
  const subA = { ...imported, id: 'sa', name: 'KLC Floors', billToClientId: 'm' }
  const subB = { ...augustStarter, id: 'sb', name: 'KLC & More', billToClientId: 'm' }
  const groupData = {
    ...data,
    clients: [master, subA, subB],
    timeEntries: [entry('s1', 'sa', '2026-01-20'), entry('s2', 'sb', '2026-08-20')],
  }
  const subRecaps = ['sa', 'sb'].map((clientId) => buildClientRecap(groupData, opts({ clientId })))
  const rolled = buildMasterRecap({ master, subRecaps })

  it('scales each company by its own active months, then adds', () => {
    expect(subRecaps.map((sub) => sub.monthsInPeriod)).toEqual([11, 4])
    // 11 x $500 + 4 x $900
    expect(rolled.estimates.profit.estimatedRevenue).toBe(5500 + 3600)
    expect(rolled.billing.revenue).toBe(5500 + 3600)
    // 11 x 4h + 4 x 10h
    expect(rolled.time.roleTotals.estimatedHours).toBe(84)
  })

  it('reports the widest count, per-company months, and that they differ', () => {
    expect(rolled.monthsInPeriod).toBe(11)
    expect(rolled.calendarMonthsInPeriod).toBe(12)
    expect(rolled.activeMonthsUniform).toBe(false)
    expect(rolled.clientSince).toBe('2026-01')
    expect(rolled.subs).toEqual([
      expect.objectContaining({ id: 'sa', monthsInPeriod: 11, clientSince: '2026-01' }),
      expect.objectContaining({ id: 'sb', monthsInPeriod: 4, clientSince: '2026-08' }),
    ])
  })
})

describe('evidence rows from the store (listInvoiceEvidence)', () => {
  it('a billing master invoice carrying this client counts as its first invoice', () => {
    const result = clientActiveMonths({
      client: { id: 'sub', createdAt: '2026-08-14T16:00:00.000Z' },
      invoices: [
        { clientId: 'm', period: '2026-02', kind: 'monthly', status: 'paid', sourceClientIds: ['sub'] },
        { clientId: 'm', period: '2026-01', kind: 'monthly', status: 'paid', sourceClientIds: ['someone-else'] },
      ],
      rangeMonths: ['2026-01', '2026-02', '2026-03'],
      periodType: 'quarter',
      today: NOVEMBER,
    })
    expect(result.clientSince).toBe('2026-02')
    expect(result.activeMonths).toEqual(['2026-02', '2026-03'])
    expect(result.uncountedMonths.beforeStart).toEqual(['2026-01'])
  })
})
