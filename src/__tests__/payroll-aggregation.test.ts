import { describe, expect, it } from 'vitest'
import {
  billableMinutes,
  duplicateFullSliceIds,
  internalMinutes,
  laborCost,
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
