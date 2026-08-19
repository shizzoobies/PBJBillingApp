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
    expect(r.profitability.laborCost).toBe(580)
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
    // e1 has no cost rate, so e1's time carries no labor cost — margin is the
    // full fee, not a withheld "—". See the profitability comment in
    // client-recap.js: no rate means no cost, not cost unknown.
    expect(r.profitability.laborCost).toBe(0)
    expect(r.profitability.margin).toBe(1500)
  })
})

/**
 * featreq-7c8f64d7 — labor cost is the PRINTED hours × the rate.
 *
 * The recap prints per-person hours at two decimals and a single client-level
 * labor cost. Under the owner's rule those two have to line up: pricing each
 * person's printed hours and adding the results IS the labor cost, so she can
 * check the recap with the byStaff list and a calculator.
 */
describe('buildClientRecap — labor cost off the printed hours', () => {
  const costData = {
    clients: [{ id: 'c1', name: 'Clover', billingMode: 'hourly', hourlyRate: 100, planIds: [] }],
    plans: [],
    employees: [
      { id: 'e1', name: 'Avery', role: 'Bookkeeper' },
      { id: 'e2', name: 'Jordan', role: 'Accountant' },
    ],
    // Seconds-precision minutes, so round-then-multiply and the old
    // multiply-then-round land on different pennies.
    timeEntries: [
      { employeeId: 'e1', clientId: 'c1', date: '2026-08-12', minutes: 613.4, billable: true },
      { employeeId: 'e2', clientId: 'c1', date: '2026-08-13', minutes: 487.9, billable: true },
    ],
    checklists: [],
    reimbursements: [],
  }
  const r = buildClientRecap(costData, {
    clientId: 'c1',
    periodType: 'month',
    period: '2026-08',
    today: '2026-08-25',
    includeFinancials: true,
    costRates: { e1: 22.5, e2: 31.75 },
  })

  it('prices each person at the hours the recap prints for them', () => {
    const avery = r.time.byStaff.find((s) => s.name === 'Avery')
    const jordan = r.time.byStaff.find((s) => s.name === 'Jordan')
    expect(avery.hours).toBe(10.22) // 613.4 min
    expect(jordan.hours).toBe(8.13) // 487.9 min
    // 10.22 × 22.5 = 229.95; 8.13 × 31.75 = 258.13 (258.1275, cent-rounded).
    expect(r.profitability.laborCost).toBe(229.95 + 258.13)
  })

  it('adds up from the byStaff rows a reader can see', () => {
    const rates = { Avery: 22.5, Jordan: 31.75 }
    const byHand = r.time.byStaff.reduce(
      (sum, s) => sum + Math.round(s.hours * rates[s.name] * 100),
      0,
    )
    expect(r.profitability.laborCost).toBe(byHand / 100)
  })

  it('is NOT the old exact-seconds figure — that is the send-back, twice over', () => {
    // (613.4/60)×22.5 + (487.9/60)×31.75, each cent-rounded, was $488.21.
    expect(r.profitability.laborCost).toBe(488.08)
    expect(r.profitability.laborCost).not.toBe(488.21)
  })

  /**
   * The hours TOTAL on the card is the sum of the byStaff rows under it. This
   * fixture separates the two: 10.22 + 8.13 = 18.35, while the raw 1101.3
   * minutes round to 18.36. The list is what she adds up.
   */
  it('totals the byStaff rows rather than rounding the seconds behind them', () => {
    expect(r.time.totalHours).toBe(18.35)
    expect(r.time.totalHours).toBe(
      r.time.byStaff.reduce((sum, s) => sum + Math.round(s.hours * 100), 0) / 100,
    )
    expect(r.time.billableHours).toBe(18.35)
  })

  it('subtracts vs-prior exactly, so Total − prior lands on the delta printed', () => {
    // All three sit on the same card; if the delta were rounded from the raw
    // seconds it would not equal the subtraction the reader can do by eye.
    expect(r.time.deltaHours).toBe(
      Math.round((r.time.totalHours - r.time.priorHours) * 100) / 100,
    )
  })
})

/**
 * ITEM 1, second half: "on the client recap it needs to keep everyone in the
 * same order month to month — so CFO hours, Accountant, Bookkeeper."
 *
 * The list used to sort by hours descending, so it reshuffled every month as
 * workload moved. Now it is tier then name, and the tier mapping is the one in
 * `recapStaffTier`: Owner -> CFO, Accountant -> Accountant, Bookkeeper ->
 * Bookkeeper, anything else -> Other, last.
 */
describe('buildClientRecap — fixed staff order', () => {
  const staff = [
    { id: 'cfo', name: 'Zara Owner', role: 'Owner' },
    { id: 'acct-b', name: 'Brenda Accountant', role: 'Accountant' },
    { id: 'acct-a', name: 'Adrian Accountant', role: 'Accountant' },
    { id: 'book', name: 'Casey Bookkeeper', role: 'Bookkeeper' },
    { id: 'unset', name: 'Alex Nobody' },
  ]
  const EXPECTED = [
    'Zara Owner',
    'Adrian Accountant',
    'Brenda Accountant',
    'Casey Bookkeeper',
    'Alex Nobody',
  ]

  /** Everyone logs time in `month`, with the hours deliberately reordered. */
  const monthOf = (month, minutesEach) => ({
    ...data,
    employees: staff,
    timeEntries: staff.map((s, index) => ({
      employeeId: s.id,
      clientId: 'c1',
      date: `${month}-05`,
      minutes: minutesEach[index],
      billable: true,
    })),
  })

  const order = (snapshot, period) =>
    buildClientRecap(snapshot, { ...ownerOpts, period, costRates: {} }).time.byStaff.map(
      (row) => row.name,
    )

  it('lists CFO tier, then Accountant, then Bookkeeper, then unmapped', () => {
    expect(order(monthOf('2026-08', [60, 600, 30, 900, 45]), '2026-08')).toEqual(EXPECTED)
  })

  it('sorts by name inside a tier, not by hours', () => {
    const rows = buildClientRecap(monthOf('2026-08', [60, 600, 30, 900, 45]), {
      ...ownerOpts,
      costRates: {},
    }).time.byStaff
    const accountants = rows.filter((row) => row.tier === 'Accountant')
    // Brenda logged 600 min to Adrian's 30 and still comes second.
    expect(accountants.map((row) => row.name)).toEqual(['Adrian Accountant', 'Brenda Accountant'])
  })

  it('produces the SAME order in two different months of different data', () => {
    const august = order(monthOf('2026-08', [60, 600, 30, 900, 45]), '2026-08')
    // September: every workload swapped, one person barely there.
    const september = order(monthOf('2026-09', [900, 15, 720, 5, 480]), '2026-09')
    expect(september).toEqual(august)
    expect(september).toEqual(EXPECTED)
  })

  it('tags every row with its tier so the page never has to guess', () => {
    const rows = buildClientRecap(monthOf('2026-08', [60, 600, 30, 900, 45]), {
      ...ownerOpts,
      costRates: {},
    }).time.byStaff
    expect(rows.map((row) => row.tier)).toEqual([
      'CFO',
      'Accountant',
      'Accountant',
      'Bookkeeper',
      'Other',
    ])
  })

  it('omits a tier nobody logged time in, and the rest keep their order', () => {
    // Only the owner and the bookkeeper worked — no Accountant row appears, and
    // no zero placeholder is invented for one.
    const snapshot = {
      ...data,
      employees: staff,
      timeEntries: [
        { employeeId: 'book', clientId: 'c1', date: '2026-08-05', minutes: 300, billable: true },
        { employeeId: 'cfo', clientId: 'c1', date: '2026-08-06', minutes: 60, billable: true },
      ],
    }
    const rows = buildClientRecap(snapshot, { ...ownerOpts, costRates: {} }).time.byStaff
    expect(rows.map((row) => row.name)).toEqual(['Zara Owner', 'Casey Bookkeeper'])
    expect(rows.some((row) => row.tier === 'Accountant')).toBe(false)
  })

  it('reports hours at two decimals, not one', () => {
    // 1213.2833 minutes = 20.2214h — the figure the owner disputed. One decimal
    // gave 20.2 and there was no second digit for the page to print.
    const snapshot = {
      ...data,
      employees: staff,
      timeEntries: [
        {
          employeeId: 'cfo',
          clientId: 'c1',
          date: '2026-08-05',
          minutes: 1213.2833,
          billable: true,
        },
      ],
    }
    const r = buildClientRecap(snapshot, { ...ownerOpts, costRates: {} })
    expect(r.time.byStaff[0].hours).toBe(20.22)
    expect(r.time.totalHours).toBe(20.22)
  })
})

/**
 * featreq-926862e2 rework — the Time & hours section is now
 * ESTIMATE | ACTUAL | OVER/UNDER per role, with a Total row, and the four stat
 * tiles it replaced are gone.
 *
 * The contract the owner checks with a pen: every row subtracts, and the Total
 * row is the rows added up. The fixture is built so the naive implementations
 * fail — 613.4 + 487.9 minutes is 18.36h if you round the raw sum, and 18.35h
 * if you add the two printed rows, which is what she does.
 */
describe('buildClientRecap — the role table adds up', () => {
  const roleData = {
    clients: [
      {
        id: 'c1',
        name: 'Clover',
        billingMode: 'hourly',
        hourlyRate: 100,
        planIds: [],
        estimatedBookkeeperHours: 10,
        estimatedAccountantHours: 8,
      },
    ],
    plans: [],
    employees: [
      { id: 'e1', name: 'Avery', role: 'Bookkeeper' },
      { id: 'e2', name: 'Jordan', role: 'Accountant' },
    ],
    timeEntries: [
      { employeeId: 'e1', clientId: 'c1', date: '2026-08-12', minutes: 613.4, billable: true },
      { employeeId: 'e2', clientId: 'c1', date: '2026-08-13', minutes: 487.9, billable: true },
    ],
    checklists: [],
    reimbursements: [],
  }
  const opts = {
    clientId: 'c1',
    periodType: 'month',
    period: '2026-08',
    today: '2026-08-25',
    includeFinancials: true,
    costRates: {},
  }
  const r = buildClientRecap(roleData, opts)
  const row = (tier) => r.time.byRole.find((entry) => entry.tier === tier)

  it('names each role by the people who filled it, in the fixed tier order', () => {
    expect(r.time.byRole.map((entry) => entry.tier)).toEqual(['Accountant', 'Bookkeeper'])
    expect(row('Accountant').people).toEqual(['Jordan'])
    expect(row('Bookkeeper').people).toEqual(['Avery'])
  })

  it('puts the estimate beside the actual, with a signed over/under per row', () => {
    expect(row('Bookkeeper')).toMatchObject({
      estimatedHours: 10,
      actualHours: 10.22,
      deltaHours: 0.22,
      direction: 'over',
    })
    expect(row('Accountant')).toMatchObject({
      estimatedHours: 8,
      actualHours: 8.13,
      deltaHours: 0.13,
      direction: 'over',
    })
  })

  it('subtracts every row exactly: over/under IS actual − estimate as printed', () => {
    for (const entry of r.time.byRole) {
      expect(entry.deltaHours).toBe(
        Math.round(entry.actualHours * 100 - entry.estimatedHours * 100) / 100,
      )
    }
  })

  it('totals the rows, and the Total over/under is the sum of the row over/unders', () => {
    const sum = (key) =>
      r.time.byRole.reduce((acc, entry) => acc + Math.round(entry[key] * 100), 0) / 100
    expect(r.time.roleTotals.estimatedHours).toBe(sum('estimatedHours')) // 18
    expect(r.time.roleTotals.actualHours).toBe(sum('actualHours')) // 18.35
    expect(r.time.roleTotals.deltaHours).toBe(sum('deltaHours')) // 0.35
    expect(r.time.roleTotals.deltaHours).toBe(0.35)
    expect(r.time.roleTotals.direction).toBe('over')
  })

  it('totals the DISPLAYED rows, not the raw seconds behind them', () => {
    // 1101.3 minutes rounds to 18.36h; the two printed rows add to 18.35h.
    expect(r.time.roleTotals.actualHours).toBe(18.35)
    // And it is the same total the by-staff list and the estimates panel report.
    expect(r.time.roleTotals.actualHours).toBe(r.time.totalHours)
    expect(r.estimates.hours.actual).toBe(r.time.totalHours)
    expect(r.estimates.hours.delta).toBe(r.time.roleTotals.deltaHours)
  })

  it('mirrors the same rows into the owner-only priced payload', () => {
    expect(r.estimates.byTier.map((entry) => entry.tier)).toEqual(
      r.time.byRole.map((entry) => entry.tier),
    )
    for (const entry of r.estimates.byTier) {
      expect(entry).toMatchObject(row(entry.tier))
    }
  })

  it('multiplies the MONTHLY estimate by twelve for a yearly recap', () => {
    const y = buildClientRecap(roleData, { ...opts, periodType: 'year', period: '2026' })
    expect(y.monthsInPeriod).toBe(12)
    expect(y.periodLabel).toBe('2026')
    expect(y.range).toEqual({ start: '2026-01-01', end: '2026-12-31' })
    expect(y.time.byRole.find((entry) => entry.tier === 'Bookkeeper').estimatedHours).toBe(120)
    expect(y.time.byRole.find((entry) => entry.tier === 'Accountant').estimatedHours).toBe(96)
    expect(y.time.roleTotals.estimatedHours).toBe(216)
    // The August hours are inside 2026, so the actual side is unchanged and the
    // year is badly under its plan.
    expect(y.time.roleTotals.actualHours).toBe(18.35)
    expect(y.time.roleTotals.deltaHours).toBe(-197.65)
    expect(y.time.roleTotals.direction).toBe('under')
    // A year-shaped period gets no end-of-MONTH projection.
    expect(y.projection).toBeNull()
  })

  it('gives an unestimated role no variance of its own, and says why', () => {
    // Someone whose staff role was never set lands in 'Other', which has no
    // estimate field. Their hours are real and still count toward the Total.
    const withOther = {
      ...roleData,
      employees: [...roleData.employees, { id: 'e3', name: 'Sam' }],
      timeEntries: [
        ...roleData.timeEntries,
        { employeeId: 'e3', clientId: 'c1', date: '2026-08-14', minutes: 120, billable: true },
      ],
    }
    const o = buildClientRecap(withOther, opts)
    const other = o.time.byRole.find((entry) => entry.tier === 'Other')
    expect(other.estimatedHours).toBeNull()
    expect(other.deltaHours).toBeNull()
    expect(other.direction).toBeNull()
    expect(other.actualHours).toBe(2)
    // Unplanned work IS over plan, so the Total counts it — and the payload
    // names the role so the page can print the reason.
    expect(o.time.roleTotals.actualHours).toBe(20.35)
    expect(o.time.roleTotals.deltaHours).toBe(2.35)
    expect(o.time.unestimatedRoles).toEqual(['Other'])
  })

  it('shows a role that was estimated but never worked, at zero actual', () => {
    // The CFO estimate is set and the owner logged nothing: this is the row
    // that catches "we planned eight hours of CFO time and did none of it".
    const cfo = buildClientRecap(
      {
        ...roleData,
        clients: [{ ...roleData.clients[0], estimatedCfoHours: 8 }],
      },
      opts,
    )
    const cfoRow = cfo.time.byRole.find((entry) => entry.tier === 'CFO')
    expect(cfoRow.people).toEqual([])
    expect(cfoRow.actualHours).toBe(0)
    expect(cfoRow.deltaHours).toBe(-8)
    expect(cfoRow.direction).toBe('under')
  })

  it('reports no estimate at all rather than a column of zeros', () => {
    const bare = buildClientRecap(
      { ...roleData, clients: [{ ...roleData.clients[0], estimatedBookkeeperHours: undefined, estimatedAccountantHours: undefined }] },
      opts,
    )
    expect(bare.time.hasEstimate).toBe(false)
    expect(bare.time.roleTotals.estimatedHours).toBeNull()
    expect(bare.time.roleTotals.deltaHours).toBeNull()
    expect(bare.time.roleTotals.direction).toBeNull()
    expect(bare.time.byRole.every((entry) => entry.estimatedHours === null)).toBe(true)
    expect(bare.time.whereToSetEstimates).toMatch(/Estimated monthly hours/)
  })

  /**
   * Staff get the TABLE but not the PLAN.
   *
   * Hours worked are operational; how many hours the firm intended to spend on
   * a client is planning data set on the Client page, which staff do not
   * manage — the same call the Board's scoping makes. So a staff payload keeps
   * the rows, the order and the actual hours (identical to the owner's, so the
   * two can never disagree) and em-dashes the estimate and over/under columns.
   */
  describe('staff see the actual column and none of the plan', () => {
    const staff = buildClientRecap(roleData, { ...opts, includeFinancials: false, costRates: {} })

    it('keeps the same rows, in the same order, with the same actual hours', () => {
      expect(staff.time.byRole.map((entry) => entry.tier)).toEqual(['Accountant', 'Bookkeeper'])
      expect(staff.time.byRole.map((entry) => entry.actualHours)).toEqual([8.13, 10.22])
      expect(staff.time.roleTotals.actualHours).toBe(18.35)
      expect(staff.time.totalHours).toBe(18.35)
    })

    it('carries NO estimated hours and NO variance anywhere in the payload', () => {
      for (const entry of staff.time.byRole) {
        expect(entry.estimatedHours).toBeNull()
        expect(entry.deltaHours).toBeNull()
        expect(entry.direction).toBeNull()
      }
      expect(staff.time.roleTotals.estimatedHours).toBeNull()
      expect(staff.time.roleTotals.deltaHours).toBeNull()
      expect(staff.time.roleTotals.direction).toBeNull()
      expect(staff.estimates).toBeNull()
      // The owner's own numbers, checked against the same fixture, so this test
      // fails if the redaction is ever quietly dropped.
      expect(r.time.roleTotals.estimatedHours).toBe(18)
    })

    it('says the estimates are HIDDEN, not absent — the page must not offer to set them', () => {
      expect(staff.time.estimatesVisible).toBe(false)
      expect(staff.time.hasEstimate).toBe(false)
      expect(staff.time.unestimatedRoles).toEqual([])
      // The owner, on the very same client, does have estimates on file.
      expect(r.time.estimatesVisible).toBe(true)
      expect(r.time.hasEstimate).toBe(true)
    })

    it('drops a role that was estimated but never worked — nothing is left to say', () => {
      const cfo = buildClientRecap(
        { ...roleData, clients: [{ ...roleData.clients[0], estimatedCfoHours: 8 }] },
        { ...opts, includeFinancials: false, costRates: {} },
      )
      expect(cfo.time.byRole.some((entry) => entry.tier === 'CFO')).toBe(false)
      // It carried 0.00 actual hours, so dropping it moves no total.
      expect(cfo.time.roleTotals.actualHours).toBe(18.35)
    })

    it('leaks no cost, rate or profit figure', () => {
      expect(JSON.stringify(staff)).not.toMatch(/costRate|laborCost|estimatedCost|margin/i)
    })
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
