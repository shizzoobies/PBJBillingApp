import { describe, expect, it } from 'vitest'
import {
  billableMinutes,
  duplicateFullSliceIds,
  exactHoursCell,
  exactMinutesCell,
  internalMinutes,
  laborCost,
  personPeriodCost,
  roundToCent,
  sumPersonCosts,
  trackedMinutes,
} from '../lib/payrollAggregation'
import type { PayrollSlice } from '../lib/payrollAggregation'

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
 * The reconcilability rule, pinned.
 *
 * The firm owner checked a period by hand and came out 16¢ under the report.
 * Her arithmetic was fine — she used the 2-decimal hours the report showed her,
 * while the report divided seconds. Neither number was wrong; they were built
 * by different rules, and only one of them can be the rule.
 *
 * That rule is: per person, sum exact minutes, convert to hours, multiply by
 * the cost rate, round ONCE to the cent. Every total is then the sum of those
 * per-person cents — never a float sum of parts, and never a sum of per-entry
 * roundings — so adding up a visible Cost column always hits the shown total.
 */
describe('personPeriodCost / sumPersonCosts — the canonical cost rule', () => {
  it('rounds a person’s whole period once, to the cent', () => {
    // 100 minutes at $37/h = $61.6666… → $61.67, not $61.66.
    expect(personPeriodCost(100, 37)).toBe(61.67)
  })

  it('keeps seconds-exact minutes exact until the final rounding', () => {
    // 90 minutes 30 seconds at $28/h = 90.5/60 × 28 = $42.2333… → $42.23.
    expect(personPeriodCost(90.5, 28)).toBe(42.23)
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

  it('DIVERGES from the old float total — and the per-person rule is the one that stands', () => {
    // Two people, 10 minutes each at $37/h. Each is $6.1666… → $6.17.
    const perPerson = [personPeriodCost(10, 37), personPeriodCost(10, 37)]
    expect(perPerson).toEqual([6.17, 6.17])
    // The rule: $12.34, which is what adding the two visible cells gives.
    expect(sumPersonCosts(perPerson)).toBe(12.34)
    // The old way — sum the floats, round at display — showed $12.33. That
    // penny is precisely what could never be reconciled by hand.
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
})

describe('laborCost follows the canonical rule', () => {
  it('groups by person BEFORE rounding, so two people can’t round into a third answer', () => {
    const entries = [
      slice({ id: 'a', employeeId: 'emp-1', minutes: 5 }),
      slice({ id: 'b', employeeId: 'emp-1', minutes: 5 }),
      slice({ id: 'c', employeeId: 'emp-2', minutes: 10 }),
    ]
    // emp-1: 10 min → $6.17. emp-2: 10 min → $6.17. Total $12.34.
    // Rounding each of the three ENTRIES first would give 3.08+3.08+6.17=12.33.
    expect(laborCost(entries, () => 37)).toBe(12.34)
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

describe('export reconciliation cells', () => {
  it('reports minutes verbatim, with binary dust trimmed but nothing rounded away', () => {
    expect(exactMinutesCell(90.5)).toBe('90.5')
    expect(exactMinutesCell(60)).toBe('60')
    // 3.65 the hard way — the stored double is 3.6500000000000004.
    expect(exactMinutesCell(1.2 + 2.45)).toBe('3.65')
    // Seconds-exact logging: 14.55 min = 873s survives intact.
    expect(exactMinutesCell(873 / 60)).toBe('14.55')
  })

  it('reports hours at four decimals, which two decimals cannot do', () => {
    expect(exactHoursCell(100)).toBe('1.6667')
    expect(exactHoursCell(90.5)).toBe('1.5083')
    expect(exactHoursCell(0)).toBe('0.0000')
  })

  it('lets the exact Minutes column reproduce the shown cost EXACTLY, always', () => {
    // Minutes are the authoritative reconciliation key: they are the stored
    // value, so re-running the rule off them is the same computation.
    for (const [minutes, rate] of [
      [100, 37],
      [613.4, 22.5],
      [487.9, 31.75],
      [873 / 60, 45],
      [1002.3, 18.4],
    ] as const) {
      const byHand = personPeriodCost(Number(exactMinutesCell(minutes)), rate)
      expect(byHand).toBe(personPeriodCost(minutes, rate))
    }
  })

  it('lets 4dp hours × rate land on the cost, within a cent', () => {
    // 4 decimals of an hour is 0.18 seconds, so hours × rate is good to about a
    // tenth of a cent — enough to check a figure by eye. It is NOT exact on a
    // knife-edge: 613.4 min at $22.50 is $230.025000 on the nose, where 4dp
    // hours fall to $230.02 and the rule rounds the half-cent up to $230.03.
    // That is why the exact Minutes column ships alongside it.
    for (const [minutes, rate] of [
      [100, 37],
      [613.4, 22.5],
      [487.9, 31.75],
      [873 / 60, 45],
    ] as const) {
      const byHand = roundToCent(Number(exactHoursCell(minutes)) * rate)
      const shown = personPeriodCost(minutes, rate) as number
      expect(Math.abs(byHand - shown)).toBeLessThanOrEqual(0.01)
    }
  })

  it('cannot be reproduced from the 2-decimal hours column — the reason 4dp exists', () => {
    // The reported bug in miniature: 2dp hours are off by a cent or more.
    const twoDecimal = roundToCent(Number((613.4 / 60).toFixed(2)) * 22.5)
    expect(twoDecimal).not.toBe(personPeriodCost(613.4, 22.5))
  })
})
