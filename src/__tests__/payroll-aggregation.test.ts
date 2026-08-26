import { describe, expect, it } from 'vitest'
import {
  allocatePersonCost,
  billableMinutes,
  displayHours,
  duplicateFullSliceIds,
  internalMinutes,
  laborCost,
  periodDisplayHours,
  periodMoney,
  personPeriodCost,
  roundToCent,
  sumDisplayHours,
  sumPersonCosts,
  trackedMinutes,
} from '../lib/payrollAggregation'
import type { PayrollSlice } from '../lib/payrollAggregation'
import { decimalHours } from '../lib/utils'

/**
 * The payroll side of group-time splits.
 *
 * A `full`-mode split deliberately puts the WHOLE block's minutes on every
 * slice — three clients each get billed the full hour. Payroll must not follow
 * that: the person worked one hour and the firm pays for one hour. So tracked
 * hours and labor cost count such a block once, while billable hours/$ still
 * count all three slices.
 */
const slice = (over: Partial<PayrollSlice> & { id: string }): PayrollSlice => ({
  employeeId: 'emp-1',
  minutes: 60,
  billable: true,
  ...over,
})

/** One 60-minute block billed in full to three clients. */
const fullTriple: PayrollSlice[] = [
  slice({ id: 'a', groupId: 'grp-1', groupAllocation: 'full' }),
  slice({ id: 'b', groupId: 'grp-1', groupAllocation: 'full' }),
  slice({ id: 'c', groupId: 'grp-1', groupAllocation: 'full' }),
]

const rateOf = (employeeId: string) => (employeeId === 'emp-1' ? 30 : null)

describe('duplicateFullSliceIds', () => {
  it('keeps the FIRST slice of a full-mode group and flags the rest', () => {
    expect([...duplicateFullSliceIds(fullTriple)]).toEqual(['b', 'c'])
  })

  it('flags nothing for even, custom or ungrouped entries', () => {
    const entries = [
      slice({ id: 'a', minutes: 20, groupId: 'grp-1', groupAllocation: 'even' }),
      slice({ id: 'b', minutes: 20, groupId: 'grp-1', groupAllocation: 'even' }),
      slice({ id: 'c', minutes: 45, groupId: 'grp-2', groupAllocation: 'custom' }),
      slice({ id: 'd', minutes: 15, groupId: 'grp-2', groupAllocation: 'custom' }),
      slice({ id: 'e', minutes: 30 }),
    ]
    expect(duplicateFullSliceIds(entries).size).toBe(0)
  })

  it('ignores a full allocation with no group id (nothing to dedupe against)', () => {
    const entries = [
      slice({ id: 'a', groupAllocation: 'full' }),
      slice({ id: 'b', groupAllocation: 'full' }),
    ]
    expect(duplicateFullSliceIds(entries).size).toBe(0)
  })

  it('dedupes each full-mode group independently', () => {
    const entries = [
      slice({ id: 'a1', groupId: 'grp-1', groupAllocation: 'full' }),
      slice({ id: 'b1', groupId: 'grp-2', groupAllocation: 'full' }),
      slice({ id: 'a2', groupId: 'grp-1', groupAllocation: 'full' }),
      slice({ id: 'b2', groupId: 'grp-2', groupAllocation: 'full' }),
    ]
    expect([...duplicateFullSliceIds(entries)].sort()).toEqual(['a2', 'b2'])
  })
})

describe('trackedMinutes / billableMinutes', () => {
  it('counts a full-mode triple ONCE for tracked but 3x for billable', () => {
    expect(trackedMinutes(fullTriple)).toBe(60)
    expect(billableMinutes(fullTriple)).toBe(180)
  })

  it('counts an even split normally — the slices sum back to the block', () => {
    const entries = [
      slice({ id: 'a', minutes: 20, groupId: 'grp-1', groupAllocation: 'even' }),
      slice({ id: 'b', minutes: 20, groupId: 'grp-1', groupAllocation: 'even' }),
      slice({ id: 'c', minutes: 20, groupId: 'grp-1', groupAllocation: 'even' }),
    ]
    expect(trackedMinutes(entries)).toBe(60)
    expect(billableMinutes(entries)).toBe(60)
  })

  it('counts a custom split normally', () => {
    const entries = [
      slice({ id: 'a', minutes: 45, groupId: 'grp-1', groupAllocation: 'custom' }),
      slice({ id: 'b', minutes: 15, groupId: 'grp-1', groupAllocation: 'custom' }),
    ]
    expect(trackedMinutes(entries)).toBe(60)
  })

  it('counts ordinary entries with no allocation normally', () => {
    const entries = [slice({ id: 'a', minutes: 30 }), slice({ id: 'b', minutes: 12.5 })]
    expect(trackedMinutes(entries)).toBe(42.5)
  })

  it('keeps fractional minutes exact — no rounding to whole minutes', () => {
    // 14.55 min = 873s, split evenly four ways.
    const entries = [
      slice({ id: 'a', minutes: 219 / 60, groupId: 'g', groupAllocation: 'even' }),
      slice({ id: 'b', minutes: 218 / 60, groupId: 'g', groupAllocation: 'even' }),
      slice({ id: 'c', minutes: 218 / 60, groupId: 'g', groupAllocation: 'even' }),
      slice({ id: 'd', minutes: 218 / 60, groupId: 'g', groupAllocation: 'even' }),
    ]
    expect(Math.round(trackedMinutes(entries) * 60)).toBe(873)
  })

  it('handles a mixed set: full deduped, everything else counted', () => {
    const entries = [
      ...fullTriple,
      slice({ id: 'd', minutes: 30, groupId: 'grp-2', groupAllocation: 'even' }),
      slice({ id: 'e', minutes: 30, groupId: 'grp-2', groupAllocation: 'even' }),
      slice({ id: 'f', minutes: 25, billable: false }),
    ]
    // 60 (block, once) + 60 (even split) + 25 (admin) = 145
    expect(trackedMinutes(entries)).toBe(145)
    // 180 (billed three times) + 60 = 240; the internal 25 never bills.
    expect(billableMinutes(entries)).toBe(240)
  })

  it('is empty-safe', () => {
    expect(trackedMinutes([])).toBe(0)
    expect(billableMinutes([])).toBe(0)
  })
})

describe('internalMinutes', () => {
  it('counts only non-billable time', () => {
    const entries = [
      slice({ id: 'a', minutes: 60 }),
      slice({ id: 'b', minutes: 25, billable: false }),
    ]
    expect(internalMinutes(entries)).toBe(25)
  })

  it('is unaffected by full-mode slices, which are always billable', () => {
    expect(internalMinutes(fullTriple)).toBe(0)
  })
})

describe('laborCost', () => {
  it('pays for a full-mode block once, not once per client', () => {
    // One hour at $30 — not three.
    expect(laborCost(fullTriple, rateOf)).toBe(30)
  })

  it('covers internal hours too — the firm pays for those as well', () => {
    const entries = [
      slice({ id: 'a', minutes: 60 }),
      slice({ id: 'b', minutes: 60, billable: false }),
    ]
    expect(laborCost(entries, rateOf)).toBe(60)
  })

  it('contributes nothing for someone with NO cost rate (e.g. an owner)', () => {
    const entries = [
      slice({ id: 'a', minutes: 60 }),
      slice({ id: 'b', employeeId: 'owner', minutes: 120 }),
    ]
    expect(laborCost(entries, rateOf)).toBe(30)
  })

  it('uses each person’s own rate across a mixed roster', () => {
    const entries = [
      slice({ id: 'a', minutes: 60 }),
      slice({ id: 'b', employeeId: 'emp-2', minutes: 30 }),
    ]
    expect(laborCost(entries, (id) => (id === 'emp-1' ? 30 : 40))).toBe(50)
  })

  it('accepts a precomputed duplicate set so callers can reuse one pass', () => {
    const duplicates = duplicateFullSliceIds(fullTriple)
    expect(laborCost(fullTriple, rateOf, duplicates)).toBe(30)
  })
})

/**
 * The reconcilability rule, pinned — and it is HER rule, stated in her words.
 *
 * The firm owner checked a period by hand and came out under the report. Her
 * arithmetic was fine: she multiplied the 2-decimal hours the report showed
 * her, while the report divided seconds. Neither number was wrong; they were
 * built by different rules, and only one of them can be the rule. Twice we
 * fixed the app's rounding and twice she sent it back, because the mismatch was
 * never arithmetic — it was policy. So we asked:
 *
 *   "I pay by the minute so if someone works 20 hours and 13.4 minutes rounded
 *    to the 2nd decimal then I would pay 20.22 times her cost and that time
 *    because the staple for all comparisons"
 *
 * That is the rule: ROUND THE HOURS FIRST, then multiply. Per person, per
 * period, at the grain the report prints. Totals are the sum of those
 * per-person cents, so adding up a visible Cost column always hits the shown
 * total — and so does multiplying a visible Hours cell by the pay rate.
 */
describe('personPeriodCost / sumPersonCosts — the canonical cost rule', () => {
  it('pays HER example: 20h 13.4min is 20.22 hours times the rate', () => {
    const minutes = 20 * 60 + 13.4
    expect(displayHours(minutes)).toBe(20.22)
    // Her arithmetic, at a $16 cost rate: 20.22 × 16 = $323.52.
    expect(personPeriodCost(minutes, 16)).toBe(323.52)
    // The rule the app used to apply — exact seconds, rounded once at the end —
    // said $323.57. Five cents she could not find on the page.
    expect(roundToCent((minutes / 60) * 16)).toBe(323.57)
  })

  it('rounds the HOURS first, not the dollars — the whole send-back in one case', () => {
    // 100 minutes is 1.6666…h → 1.67h shown → 1.67 × $37 = $61.79.
    expect(displayHours(100)).toBe(1.67)
    expect(personPeriodCost(100, 37)).toBe(61.79)
    // Dividing seconds gave $61.67. Different by 12¢, and unreproducible from
    // anything printed on the report.
    expect(roundToCent((100 / 60) * 37)).toBe(61.67)
  })

  it('takes the hours from the same rounding the reports print', () => {
    // 90 minutes 30 seconds reads "1.51h" and is priced at 1.51 × $28 = $42.28.
    expect(decimalHours(90.5)).toBe('1.51')
    expect(personPeriodCost(90.5, 28)).toBe(42.28)
  })

  it('rounds an exact half-hundredth of an hour UP, as written arithmetic does', () => {
    // 59.7 min is 0.995h, stored a hair below; a bare toFixed(2) would price it
    // at 0.99h. It reads "1.00h" on the report, so it costs 1.00 × the rate.
    expect(displayHours(59.7)).toBe(1)
    expect(personPeriodCost(59.7, 42)).toBe(42)
  })

  it('is null — not $0.00 — for someone with no cost rate', () => {
    expect(personPeriodCost(600, null)).toBeNull()
    expect(personPeriodCost(600, undefined)).toBeNull()
    expect(personPeriodCost(600, Number.NaN)).toBeNull()
  })

  it('still pays $0.00 for a real rate of zero', () => {
    expect(personPeriodCost(600, 0)).toBe(0)
  })

  it('sums in whole cents, so no float dust survives a long roster', () => {
    // 0.1 + 0.2 is the classic float trap; in cents it is exactly 0.30.
    expect(sumPersonCosts([0.1, 0.2])).toBe(0.3)
    expect(sumPersonCosts([61.67, 42.23, null, undefined])).toBe(103.9)
    expect(sumPersonCosts([])).toBe(0)
  })

  it('DIVERGES from the old exact-seconds total — hers is the one that stands', () => {
    // Two people, 10 minutes each at $37/h. Each reads "0.17h" and is paid
    // 0.17 × 37 = $6.29.
    const perPerson = [personPeriodCost(10, 37), personPeriodCost(10, 37)]
    expect(perPerson).toEqual([6.29, 6.29])
    // The rule: $12.58, which is what adding the two visible cells gives, and
    // also what 0.17h × $37 × 2 gives on a calculator.
    expect(sumPersonCosts(perPerson)).toBe(12.58)
    // Exact seconds — the rule the app shipped before — said $12.33.
    expect(roundToCent((10 / 60) * 37 + (10 / 60) * 37)).toBe(12.33)
  })

  it('rounds a true half-cent up rather than losing it to binary storage', () => {
    // 8.13 minutes at $29.52/h = $4.00 (…4.999…e-3 in binary) — must be 4.00,
    // and a clean half-cent must go up.
    expect(roundToCent(4.005)).toBe(4.01)
    expect(roundToCent(-0.004)).toBe(0)
  })

  it('makes a column of cost cells add up to the total exactly', () => {
    const people = [
      { minutes: 613.4, rate: 22.5 },
      { minutes: 487.9, rate: 31.75 },
      { minutes: 1002.3, rate: 18.4 },
      { minutes: 55.6, rate: null },
    ]
    const cells = people.map((person) => personPeriodCost(person.minutes, person.rate))
    const total = sumPersonCosts(cells)
    // What the owner does with a calculator: add the printed cells.
    const byHand = cells.reduce<number>((sum, cell) => sum + (cell ?? 0), 0)
    expect(total.toFixed(2)).toBe(byHand.toFixed(2))
  })

  it('lets the PRINTED hours be multiplied by hand, on every row', () => {
    // The property the whole change exists for: whatever the report shows in
    // the Hours cell, times the rate, is the Cost cell. No hidden precision.
    for (const [minutes, rate] of [
      [613.4, 22.5],
      [487.9, 31.75],
      [1002.3, 18.4],
      [873 / 60, 45],
      [20 * 60 + 13.4, 16],
      [59.7, 42],
    ] as const) {
      const byHand = roundToCent(Number(decimalHours(minutes)) * rate)
      expect(personPeriodCost(minutes, rate)).toBe(byHand)
    }
  })
})

describe('laborCost follows the canonical rule', () => {
  /**
   * REWRITTEN for featreq-7c8f64d7's fourth round. This test used to assert
   * $12.58 — the person's minutes summed and rounded ONCE — and that is the
   * defect she reopened it for.
   *
   * The report prints a row per entry and a total underneath that is the sum of
   * those rows. emp-1's two five-minute rows print 0.08h each and total 0.16h;
   * the owner multiplies what she sees, so the firm owes 0.16 × 37 = $5.92 and
   * not the $6.29 that re-rounding her 10 raw minutes produces. emp-2's single
   * ten-minute row prints 0.17h and stays $6.29.
   *
   * The two people are still grouped separately — that part was never wrong,
   * and this pins it: emp-1's rows are summed among themselves before pricing.
   */
  it('prices each person off the rows the report prints', () => {
    const entries = [
      slice({ id: 'a', employeeId: 'emp-1', minutes: 5 }),
      slice({ id: 'b', employeeId: 'emp-1', minutes: 5 }),
      slice({ id: 'c', employeeId: 'emp-2', minutes: 10 }),
    ]
    expect(periodDisplayHours([5, 5])).toBe(0.16)
    expect(periodMoney([5, 5], 37)).toBe(5.92)
    expect(periodMoney([10], 37)).toBe(6.29)
    expect(laborCost(entries, () => 37)).toBe(12.21)
  })

  it('still counts a full-mode block once — dedup happens before the grouping', () => {
    expect(laborCost(fullTriple, rateOf)).toBe(30)
  })

  it('matches the per-person helper on a deduped mixed set', () => {
    const entries = [
      ...fullTriple, // emp-1, 60 min counted once
      slice({ id: 'd', employeeId: 'emp-1', minutes: 40.5 }),
      slice({ id: 'e', employeeId: 'owner', minutes: 120 }), // no rate
    ]
    expect(laborCost(entries, rateOf)).toBe(personPeriodCost(100.5, 30))
  })

  it('returns a clean 0 when nobody on the set has a rate', () => {
    expect(laborCost([slice({ id: 'a', employeeId: 'owner' })], rateOf)).toBe(0)
  })
})

/**
 * `displayHours` is shared with `decimalHours` in src/lib/utils.ts on purpose:
 * the hours a report PRINTS and the hours a cost is priced from have to be the
 * same number, and the only way to guarantee that is one function.
 */
describe('displayHours is the printed hours, as a number', () => {
  // A TRIPWIRE, not independent coverage. `decimalHours` is a one-line wrapper
  // over `displayHours`, so this can only fail if someone re-implements the
  // rounding in one of them — which is exactly the drift that produced the
  // original bug, and exactly what this is here to catch.
  it('agrees with the reporting formatter, digit for digit', () => {
    for (const minutes of [0, 0.1, 0.75, 22.5, 30, 59.4, 59.7, 100, 613.4, 1213.4, -90]) {
      expect(displayHours(minutes).toFixed(2)).toBe(decimalHours(minutes))
    }
  })

  it('normalizes a negative sliver to zero rather than -0', () => {
    expect(Object.is(displayHours(-0.001), 0)).toBe(true)
  })
})

/**
 * TOTALS ARE THE SUM OF THE ROWS THE READER SEES.
 *
 * Rounding the underlying minutes gives a different, defensible answer that
 * contradicts the column printed above it. Since the hours became the costing
 * figure (and the exact Minutes column was retired), there is nothing on the
 * page to explain the contradiction with — so the visible column wins.
 */
describe('sumDisplayHours', () => {
  it('adds the printed rows, not the minutes behind them', () => {
    const minutes = [10, 10, 45]
    const rows = minutes.map((m) => displayHours(m))
    expect(rows).toEqual([0.17, 0.17, 0.75])
    expect(sumDisplayHours(rows)).toBe(1.09)
    // What rounding the raw 65 minutes would have said.
    expect(displayHours(65)).toBe(1.08)
  })

  it('adds in whole hundredths, so a long roster carries no float dust', () => {
    expect(sumDisplayHours([0.1, 0.2])).toBe(0.3)
    expect(sumDisplayHours(Array(10).fill(0.07))).toBe(0.7)
    expect(sumDisplayHours([])).toBe(0)
  })

  it('composes: summing day subtotals equals summing every row', () => {
    const days = [[12.5, 47.5, 3], [61.2, 8.8], [90]]
    const perDay = days.map((day) => sumDisplayHours(day.map((m) => displayHours(m))))
    const allRows = days.flat().map((m) => displayHours(m))
    expect(sumDisplayHours(perDay)).toBe(sumDisplayHours(allRows))
  })

  it('skips nulls the way sumPersonCosts does', () => {
    expect(sumDisplayHours([1.5, null, undefined, 0.25])).toBe(1.75)
  })
})

/**
 * The per-entry Cost column, which featreq-55212377 puts on the printed raw
 * time report. A row cannot be priced off its own hours AND add up to what the
 * person is paid for the period — the per-row rounding is up to half a
 * hundredth of an hour, and over a month of entries that reaches dollars. The
 * total is the half that has to be right, so rows are a SPLIT of it.
 */
describe('allocatePersonCost', () => {
  const rate = 37

  it('sums EXACTLY to the person’s period money, however the rows fall', () => {
    const rows = [10, 10, 45, 3.4, 118.6, 7, 22.5, 61.2]
    const costs = allocatePersonCost(rows, rate) as number[]
    // The target is the DISPLAYED hours × rate — the figure under the column —
    // not the re-rounded raw total, which is what this asserted before.
    expect(sumPersonCosts(costs)).toBe(periodMoney(rows, rate))
  })

  it('SPREADS the residual evenly — no row absorbs the whole gap', () => {
    // The guarantee that keeps a row honest: every row's adjustment against its
    // own hours × rate is within one penny of every other row's. A month of
    // entries cannot dump its accumulated rounding onto one unlucky line.
    const rows = [10, 10, 45, 3.4, 118.6, 7, 22.5, 61.2]
    const costs = allocatePersonCost(rows, rate) as number[]
    const adjustments = rows.map((minutes, index) =>
      Math.round((costs[index] - displayHours(minutes) * rate) * 100),
    )
    expect(Math.max(...adjustments) - Math.min(...adjustments)).toBeLessThanOrEqual(1)
  })

  it('keeps every row near its own hours × rate, and nearer as rows grow', () => {
    // Measured across the shapes that occur: mean deviation is a cent or two
    // and the worst case shrinks with the row count — the opposite of pricing
    // rows independently, where the error against the TOTAL grew with it.
    const deviations = (count: number) => {
      const rows = Array.from({ length: count }, (_, i) => 3 + ((i * 37.4) % 175))
      const costs = allocatePersonCost(rows, rate) as number[]
      return rows.map((minutes, index) =>
        Math.abs(costs[index] - roundToCent(displayHours(minutes) * rate)),
      )
    }
    expect(Math.max(...deviations(8))).toBeLessThanOrEqual(0.21)
    expect(Math.max(...deviations(60))).toBeLessThanOrEqual(0.05)
  })

  it('leaves a single row exactly equal to the period cost', () => {
    expect(allocatePersonCost([613.4], 22.5)).toEqual([personPeriodCost(613.4, 22.5)])
  })

  /**
   * The old version of this test is the clearest statement of the bug that
   * existed: "eight ten-minute rows each read 0.17h and would price at $6.29,
   * for $50.32 — but 80 minutes is 1.33h and pays $49.21. Eleven pennies come
   * off." Eleven pennies coming off a column that reads 0.17 eight times is
   * exactly what made the report un-multipliable.
   *
   * Now each row IS its own displayed hours × rate and they already sum to the
   * target, so nothing is taken back and nothing is handed out.
   */
  it('leaves identical rows alone — they already add up', () => {
    const costs = allocatePersonCost(Array(8).fill(10), rate) as number[]
    expect(costs).toEqual(Array(8).fill(6.29))
    expect(sumPersonCosts(costs)).toBe(50.32)
    expect(sumPersonCosts(costs)).toBe(periodMoney(Array(8).fill(10), rate))
  })

  it('still reconciles when the gap exceeds one penny per row', () => {
    // Two rows only, so a multi-penny residual has nowhere to spread but back
    // onto the same rows — the distribution has to wrap around.
    const costs = allocatePersonCost([10, 10], rate) as number[]
    expect(sumPersonCosts(costs)).toBe(periodMoney([10, 10], rate))
  })

  /**
   * THE INVARIANT, over shapes rather than one lucky example: whatever the rows
   * are, the column adds up to the hours printed under it times the rate. This
   * is the property she checks by hand, so it is the property under test.
   */
  it('reconciles for every row shape, not just the tidy ones', () => {
    const shapes = [
      [1],
      [1, 1, 1],
      [3.4, 118.6, 7],
      [10, 10, 45, 3.4, 118.6, 7, 22.5, 61.2],
      Array.from({ length: 63 }, (_, i) => 2 + ((i * 13.7) % 97)),
      Array.from({ length: 31 }, (_, i) => 0.5 + ((i * 7.3) % 45)),
    ]
    for (const rows of shapes) {
      const costs = allocatePersonCost(rows, rate) as number[]
      expect(sumPersonCosts(costs), `rows=${rows.length}`).toBe(periodMoney(rows, rate))
    }
  })

  it('is null per row — never $0.00 — for someone with no cost rate', () => {
    expect(allocatePersonCost([10, 20], null)).toEqual([null, null])
    expect(allocatePersonCost([10, 20], undefined)).toEqual([null, null])
  })

  it('pays a real rate of zero as zero, and is empty-safe', () => {
    expect(allocatePersonCost([10, 20], 0)).toEqual([0, 0])
    expect(allocatePersonCost([], rate)).toEqual([])
  })
})
