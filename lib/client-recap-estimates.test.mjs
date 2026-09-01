/**
 * TRACKER featreq-926862e2 — "the client recap does not show how planned work
 * compares to what actually happened".
 *
 * Two things are being pinned here, and the second matters more than the first:
 *
 *   1. the arithmetic (10 estimated vs 12 worked, and the profit equivalent);
 *   2. the HONESTY of the empty case. Only 21 of 47 active clients have any
 *      estimate set, so "no estimate" is the normal state of this panel. It
 *      must never be compared against zero and must never render a variance.
 *
 * Profit is asserted AGAINST the shared calculators (lib/payroll-cost.js for
 * cost, lib/invoice-lines.js for money) rather than by restating their
 * arithmetic here — a test that recomputes the sum by hand would pass happily
 * while the page showed a number no other surface agrees with.
 */
import { describe, expect, it } from 'vitest'
import { buildClientRecap } from './client-recap.js'
import { buildInvoiceLines } from './invoice-lines.js'
import { laborCost, personPeriodCost, sumPersonCosts } from './payroll-cost.js'

/**
 * Lisa is the only Bookkeeper, so "Lisa had 10 estimated hours but worked 12"
 * is exactly the Bookkeeper tier row. 720 minutes = 12.00 hours.
 */
const lisaData = {
  clients: [
    {
      id: 'c1',
      name: 'Clover',
      billingMode: 'hourly',
      hourlyRate: 100,
      planIds: [],
      assignedBookkeeperIds: ['lisa'],
      estimatedBookkeeperHours: 10,
    },
  ],
  plans: [],
  employees: [{ id: 'lisa', name: 'Lisa', role: 'Bookkeeper', billRate: 120 }],
  timeEntries: [
    { id: 't1', employeeId: 'lisa', clientId: 'c1', date: '2026-08-10', minutes: 720, billable: true },
  ],
  reimbursements: [],
  recurringReimbursements: [],
}

const ownerOpts = {
  clientId: 'c1',
  periodType: 'month',
  period: '2026-08',
  today: '2026-08-31',
  includeFinancials: true,
  costRates: { lisa: 40 },
}

describe('estimated vs actual — hours', () => {
  const r = buildClientRecap(lisaData, ownerOpts)
  const bookkeeper = r.estimates.byTier.find((row) => row.tier === 'Bookkeeper')

  it('reports the owner’s own example: 10 estimated, 12 worked, 2 over', () => {
    expect(bookkeeper.estimatedHours).toBe(10)
    expect(bookkeeper.actualHours).toBe(12)
    expect(bookkeeper.deltaHours).toBe(2)
    expect(bookkeeper.direction).toBe('over')
  })

  it('calls an underrun under, and an exact match on', () => {
    const under = buildClientRecap(
      { ...lisaData, timeEntries: [{ ...lisaData.timeEntries[0], minutes: 450 }] },
      ownerOpts,
    ).estimates.byTier.find((row) => row.tier === 'Bookkeeper')
    expect(under.deltaHours).toBe(-2.5)
    expect(under.direction).toBe('under')

    const exact = buildClientRecap(
      { ...lisaData, timeEntries: [{ ...lisaData.timeEntries[0], minutes: 600 }] },
      ownerOpts,
    ).estimates.byTier.find((row) => row.tier === 'Bookkeeper')
    expect(exact.deltaHours).toBe(0)
    expect(exact.direction).toBe('on')
  })

  it('keeps hours at two decimals, like every other hours figure', () => {
    const odd = buildClientRecap(
      { ...lisaData, timeEntries: [{ ...lisaData.timeEntries[0], minutes: 1213.2833 }] },
      ownerOpts,
    ).estimates.byTier.find((row) => row.tier === 'Bookkeeper')
    expect(odd.actualHours).toBe(20.22)
    expect(odd.deltaHours).toBe(10.22)
  })

  it('scales the MONTHLY estimate across a quarterly recap', () => {
    const q = buildClientRecap(lisaData, { ...ownerOpts, periodType: 'quarter', period: '2026-Q3' })
    expect(q.estimates.monthsInPeriod).toBe(3)
    expect(q.estimates.byTier.find((row) => row.tier === 'Bookkeeper').estimatedHours).toBe(30)
  })

  it('scales it by TWELVE across a yearly recap, and prices the year to match', () => {
    const y = buildClientRecap(lisaData, { ...ownerOpts, periodType: 'year', period: '2026' })
    expect(y.estimates.monthsInPeriod).toBe(12)
    const bookkeeper = y.estimates.byTier.find((row) => row.tier === 'Bookkeeper')
    expect(bookkeeper.estimatedHours).toBe(120) // 10/month × 12
    // Cost and expected revenue follow the scaled hours, not the monthly ones:
    // 120h at Lisa's $40 cost, 120h at her $120 bill rate.
    expect(y.estimates.profit.estimatedCost).toBe(sumPersonCosts([personPeriodCost(120 * 60, 40)]))
    expect(y.estimates.profit.estimatedRevenue).toBe(14400)
    expect(y.estimates.profit.estimatedProfit).toBe(14400 - 4800)
  })

  it('totals match the time panel exactly, so the two can never disagree', () => {
    expect(r.estimates.hours.actual).toBe(r.time.totalHours)
    expect(r.estimates.hours.estimated).toBe(10)
    expect(r.estimates.hours.delta).toBe(2)
  })
})

describe('estimated vs actual — the no-estimate case is the common case', () => {
  const noEstimate = {
    ...lisaData,
    clients: [{ ...lisaData.clients[0], estimatedBookkeeperHours: undefined }],
  }
  const r = buildClientRecap(noEstimate, ownerOpts)
  const bookkeeper = r.estimates.byTier.find((row) => row.tier === 'Bookkeeper')

  it('says there is no estimate rather than inventing a zero', () => {
    expect(r.estimates.hasEstimate).toBe(false)
    expect(bookkeeper.estimatedHours).toBeNull()
    expect(r.estimates.hours.estimated).toBeNull()
  })

  it('NEVER produces a variance against nothing', () => {
    expect(bookkeeper.deltaHours).toBeNull()
    expect(bookkeeper.direction).toBeNull()
    expect(r.estimates.hours.delta).toBeNull()
    expect(r.estimates.hours.direction).toBeNull()
    expect(r.estimates.profit.estimatedProfit).toBeNull()
    expect(r.estimates.profit.delta).toBeNull()
    expect(r.estimates.profit.direction).toBeNull()
  })

  it('still reports the actual side in full, and where to set the estimate', () => {
    expect(bookkeeper.actualHours).toBe(12)
    expect(r.estimates.profit.actualProfit).toBe(r.profitability.margin)
    expect(r.estimates.whereToSet).toMatch(/Estimated monthly hours/)
  })

  it('omits an unestimated tier that nobody logged time in, rather than zero-filling', () => {
    expect(r.estimates.byTier.map((row) => row.tier)).toEqual(['Bookkeeper'])
  })
})

describe('estimated vs actual — profit uses the shared calculators', () => {
  const r = buildClientRecap(lisaData, ownerOpts)

  it('actual cost IS lib/payroll-cost.js, not a fourth copy of the arithmetic', () => {
    const expected = laborCost(lisaData.timeEntries, () => 40)
    expect(r.estimates.profit.actualCost).toBe(expected)
    expect(r.profitability.laborCost).toBe(expected)
  })

  it('actual revenue IS lib/invoice-lines.js, the one money calculator', () => {
    const built = buildInvoiceLines({
      client: lisaData.clients[0],
      entries: lisaData.timeEntries,
      plans: [],
      billingPeriod: '2026-08',
      employees: lisaData.employees,
      defaultHourlyRate: 100,
    })
    const service = built.lines
      .filter((line) => line.kind === 'plan' || line.kind === 'hourly')
      .reduce((sum, line) => sum + line.amount, 0)
    expect(r.estimates.profit.actualRevenue).toBe(service)
    expect(r.estimates.profit.actualRevenue).toBe(r.billing.revenue)
  })

  it('estimated cost is estimated hours priced by personPeriodCost at the tier rate', () => {
    // Lisa is the assigned Bookkeeper, so her $40 cost rate prices the tier.
    expect(r.estimates.byTier[0].costRate).toBe(40)
    expect(r.estimates.byTier[0].costRateBasis).toBe('assigned')
    expect(r.estimates.profit.estimatedCost).toBe(
      sumPersonCosts([personPeriodCost(10 * 60, 40)]),
    )
  })

  it('prices an hourly client’s expected revenue at the tier BILL rate', () => {
    // 10 estimated hours at Lisa's $120 bill rate — the rate an invoice would
    // actually charge, not the client's legacy $100 fallback.
    expect(r.estimates.profit.estimatedRevenue).toBe(1200)
    expect(r.estimates.profit.estimatedProfit).toBe(1200 - 400)
  })

  it('reports the profit difference and its direction', () => {
    // Actual: 12h billed at $120 = $1,440 revenue, $480 cost -> $960 profit.
    expect(r.estimates.profit.actualProfit).toBe(960)
    expect(r.estimates.profit.delta).toBe(160)
    expect(r.estimates.profit.direction).toBe('over')
  })

  it('uses the client’s own monthly rate as expected revenue for a plan client', () => {
    const plan = {
      ...lisaData,
      clients: [
        {
          ...lisaData.clients[0],
          billingMode: 'subscription',
          monthlyRate: 900,
        },
      ],
    }
    const p = buildClientRecap(plan, ownerOpts)
    expect(p.estimates.profit.estimatedRevenue).toBe(900)
    expect(p.estimates.profit.estimatedProfit).toBe(900 - 400)
  })

  it('averages the tier rate when the assigned people cost different amounts', () => {
    const twoBookkeepers = {
      ...lisaData,
      clients: [{ ...lisaData.clients[0], assignedBookkeeperIds: ['lisa', 'dana'] }],
      employees: [
        ...lisaData.employees,
        { id: 'dana', name: 'Dana', role: 'Bookkeeper', billRate: 120 },
      ],
    }
    const t = buildClientRecap(twoBookkeepers, { ...ownerOpts, costRates: { lisa: 40, dana: 60 } })
    expect(t.estimates.byTier[0].costRate).toBe(50)
    expect(t.estimates.byTier[0].costRatePeopleCount).toBe(2)
    expect(t.estimates.profit.estimatedCost).toBe(personPeriodCost(10 * 60, 50))
  })

  /**
   * NO COST RATE MEANS NO LABOR COST, on both sides of the comparison.
   *
   * Measured on August 2026 production: the firm owner logged 51.84h across 31
   * of the 34 clients with any time, and she correctly has no cost rate — an
   * owner draws no hourly wage. The old rule withheld cost and profit whenever
   * ANY contributor lacked a rate, which would have blanked this panel on 91%
   * of her clients. A rate-less person now contributes zero, exactly as
   * personPeriodCost and the payroll report have always treated them.
   */
  it('prices a rate-less role at zero instead of withholding the estimate', () => {
    const noRate = buildClientRecap(lisaData, { ...ownerOpts, costRates: {} })
    expect(noRate.estimates.byTier[0].costRate).toBeNull()
    expect(noRate.estimates.profit.estimatedCost).toBe(0)
    // Estimated profit is the whole expected fee, because nothing costs anything.
    expect(noRate.estimates.profit.estimatedProfit).toBe(1200)
  })

  it('still shows profit for a client whose ONLY time is a rate-less owner', () => {
    const ownerOnly = {
      ...lisaData,
      clients: [
        {
          ...lisaData.clients[0],
          assignedBookkeeperIds: ['brittany'],
          estimatedBookkeeperHours: undefined,
          estimatedCfoHours: 8,
        },
      ],
      employees: [{ id: 'brittany', name: 'Brittany', role: 'Owner', billRate: 150 }],
      timeEntries: [
        {
          id: 't1',
          employeeId: 'brittany',
          clientId: 'c1',
          date: '2026-08-10',
          minutes: 600,
          billable: true,
        },
      ],
    }
    // Her id is in the cost-rate map with a null rate, which is how the server
    // reports "no rate on file" — the exact production shape.
    const r = buildClientRecap(ownerOnly, { ...ownerOpts, costRates: { brittany: null } })
    expect(r.profitability.laborCost).toBe(0)
    expect(r.profitability.margin).toBe(1500) // 10h × her $150 bill rate, no cost
    expect(r.estimates.profit.actualCost).toBe(0)
    expect(r.estimates.profit.actualProfit).toBe(1500)
    expect(r.estimates.profit.estimatedCost).toBe(0)
    expect(r.estimates.profit.estimatedProfit).toBe(1200) // 8 estimated hours × $150
    expect(r.estimates.profit.delta).toBe(300)
    expect(r.estimates.profit.direction).toBe('over')
    // Nothing anywhere reads as unavailable.
    expect(r.estimates.byTier.find((row) => row.tier === 'CFO').actualCost).toBe(0)
  })
})

describe('projected end-of-month invoice', () => {
  it('extrapolates an hourly client from the business days elapsed', () => {
    // August 2026 has 21 business days; through the 14th, 10 have passed.
    // 12h at Lisa's $120 = $1,440 booked -> $1,440 × 21/10 = $3,024.
    const r = buildClientRecap(lisaData, { ...ownerOpts, today: '2026-08-14' })
    expect(r.projection.basis).toBe('hourly')
    expect(r.projection.isEstimate).toBe(true)
    expect(r.projection.businessDaysInMonth).toBe(21)
    expect(r.projection.businessDaysElapsed).toBe(10)
    expect(r.projection.hoursToDate).toBe(12)
    expect(r.projection.amount).toBe(3024)
    expect(r.projection.method).toMatch(/12.00 billable hours over 10 of 21 business days/)
  })

  it('adds recorded reimbursements as-is instead of extrapolating them', () => {
    const withReimbursement = {
      ...lisaData,
      reimbursements: [
        { id: 'r1', clientId: 'c1', date: '2026-08-03', description: 'Filing fee', amount: 50 },
      ],
    }
    const r = buildClientRecap(withReimbursement, { ...ownerOpts, today: '2026-08-14' })
    expect(r.projection.reimbursementsToDate).toBe(50)
    expect(r.projection.amount).toBe(3074) // 3024 projected service + the $50 as recorded
  })

  it('uses the KNOWN plan amount for a subscription client, plus reimbursements to date', () => {
    const plan = {
      ...lisaData,
      clients: [{ ...lisaData.clients[0], billingMode: 'subscription', monthlyRate: 900 }],
      reimbursements: [
        { id: 'r1', clientId: 'c1', date: '2026-08-03', description: 'Filing fee', amount: 50 },
      ],
    }
    const r = buildClientRecap(plan, { ...ownerOpts, today: '2026-08-14' })
    expect(r.projection.basis).toBe('plan')
    expect(r.projection.isEstimate).toBe(true)
    expect(r.projection.serviceAmount).toBe(900)
    expect(r.projection.amount).toBe(950)
    expect(r.projection.method).toMatch(/plan amount is fixed/)
  })

  it('shows a COMPLETED month as the actual invoice, never as a projection', () => {
    const r = buildClientRecap(lisaData, { ...ownerOpts, today: '2026-09-04' })
    expect(r.projection.basis).toBe('actual')
    expect(r.projection.isEstimate).toBe(false)
    // The real invoice total for the month, from the one money calculator.
    const built = buildInvoiceLines({
      client: lisaData.clients[0],
      entries: lisaData.timeEntries,
      plans: [],
      billingPeriod: '2026-08',
      employees: lisaData.employees,
      defaultHourlyRate: 100,
    })
    expect(r.projection.amount).toBe(built.total)
    expect(r.projection.method).toMatch(/closed/)
  })

  it('refuses to project an hourly month that has not started', () => {
    const r = buildClientRecap(lisaData, { ...ownerOpts, today: '2026-07-20' })
    expect(r.projection.basis).toBe('too_early')
    expect(r.projection.amount).toBeNull()
  })

  it('offers no projection at all for a quarterly recap', () => {
    const r = buildClientRecap(lisaData, { ...ownerOpts, periodType: 'quarter', period: '2026-Q3' })
    expect(r.projection).toBeNull()
  })
})

describe('owner-only', () => {
  it('gives staff no estimates, no projection, and no profit at all', () => {
    const staff = buildClientRecap(lisaData, {
      ...ownerOpts,
      includeFinancials: false,
      costRates: {},
    })
    expect(staff.estimates).toBeNull()
    expect(staff.projection).toBeNull()
    expect(staff.billing).toBeNull()
    expect(staff.profitability).toBeNull()
    // Serialized as it would be sent: not one cost, profit or projected figure
    // survives anywhere in the payload.
    const payload = JSON.stringify(staff)
    expect(payload).not.toMatch(/estimatedProfit|projected|costRate|laborCost/i)
    // Hours are operational and still reported.
    expect(staff.time.totalHours).toBe(12)
  })
})

/**
 * Round two of featreq-926862e2, off her marked-up printout: the roles table
 * gains Cost Estimate | Actual | Over/Under columns, and the Billing tiles
 * become Estimated Invoice | Actual Invoice | Over/Under. The variances are
 * DERIVED HERE, in the payload, so every surface that shows one is subtracting
 * the same two figures.
 */
describe('estimated vs actual — the cost and invoice variances ride the payload', () => {
  const r = buildClientRecap(lisaData, ownerOpts)

  it('each tier row carries its own cost over/under', () => {
    // Lisa: 10 estimated hours × $40 = $400 against 12 worked × $40 = $480.
    expect(r.estimates.byTier[0].estimatedCost).toBe(400)
    expect(r.estimates.byTier[0].actualCost).toBe(480)
    expect(r.estimates.byTier[0].costDelta).toBe(80)
    expect(r.estimates.byTier[0].costDirection).toBe('over')
  })

  it('the cost Total row is the same figures the profit block holds', () => {
    expect(r.estimates.cost).toEqual({
      estimated: r.estimates.profit.estimatedCost,
      actual: r.estimates.profit.actualCost,
      delta: 80,
      direction: 'over',
    })
  })

  it('the invoice comparison subtracts the two revenue figures already shown', () => {
    // 12h at Lisa's $120 bill rate = $1,440 against a $1,200 estimate.
    expect(r.estimates.profit.revenueDelta).toBe(240)
    expect(r.estimates.profit.revenueDirection).toBe('over')
    expect(r.estimates.profit.revenueDelta).toBe(
      Math.round((r.estimates.profit.actualRevenue - r.estimates.profit.estimatedRevenue) * 100) /
        100,
    )
  })

  it('no estimate means null variances — never a comparison against zero', () => {
    const noEstimate = {
      ...lisaData,
      clients: [{ ...lisaData.clients[0], estimatedBookkeeperHours: undefined }],
    }
    const bare = buildClientRecap(noEstimate, ownerOpts)
    expect(bare.estimates.byTier[0].costDelta).toBeNull()
    expect(bare.estimates.byTier[0].costDirection).toBeNull()
    expect(bare.estimates.cost.estimated).toBeNull()
    expect(bare.estimates.cost.delta).toBeNull()
    expect(bare.estimates.profit.revenueDelta).toBeNull()
  })

  it('a staff payload has no estimates block at all, so no cost columns exist to leak', () => {
    const staff = buildClientRecap(lisaData, { ...ownerOpts, includeFinancials: false })
    expect(staff.estimates).toBeNull()
  })
})
