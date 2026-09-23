import { describe, expect, it } from 'vitest'
import { laborCost } from './payroll-cost.js'
import { costRateFor } from './rate-history.js'

const versions = [
  { userId: 'emp-lisa', effectiveDate: '1970-01-01', rate: 20 },
  { userId: 'emp-lisa', effectiveDate: '2026-09-15', rate: 24 },
]
const resolver = (employeeId, entryDate) => costRateFor(versions, employeeId, entryDate)

describe('laborCost by the day the work was done', () => {
  it('costs the day before a raise at the old rate and the day of it at the new', () => {
    const before = laborCost(
      [{ id: 'a', employeeId: 'emp-lisa', minutes: 60, billable: true, date: '2026-09-14' }],
      resolver,
    )
    const after = laborCost(
      [{ id: 'b', employeeId: 'emp-lisa', minutes: 60, billable: true, date: '2026-09-15' }],
      resolver,
    )
    expect(before).toBe(20)
    expect(after).toBe(24)
  })

  it('splits ONE person’s period across the raise instead of picking a side', () => {
    const total = laborCost(
      [
        { id: 'a', employeeId: 'emp-lisa', minutes: 60, billable: true, date: '2026-09-14' },
        { id: 'b', employeeId: 'emp-lisa', minutes: 60, billable: true, date: '2026-09-16' },
      ],
      resolver,
    )
    expect(total).toBe(44)
  })

  it('is unchanged for a resolver that ignores the date — every existing caller', () => {
    const flat = laborCost(
      [
        { id: 'a', employeeId: 'emp-lisa', minutes: 10, billable: true, date: '2026-09-01' },
        { id: 'b', employeeId: 'emp-lisa', minutes: 10, billable: true, date: '2026-09-02' },
        { id: 'c', employeeId: 'emp-lisa', minutes: 45, billable: true, date: '2026-09-03' },
      ],
      () => 30,
    )
    // 0.17 + 0.17 + 0.75 = 1.09h × 30 — the summed-rows rule, unchanged.
    expect(flat).toBe(32.7)
  })

  it('still counts a full-mode group once', () => {
    const total = laborCost(
      [
        { id: 'a', employeeId: 'emp-lisa', minutes: 60, billable: true, date: '2026-09-16', groupId: 'g1', groupAllocation: 'full' },
        { id: 'b', employeeId: 'emp-lisa', minutes: 60, billable: true, date: '2026-09-16', groupId: 'g1', groupAllocation: 'full' },
      ],
      resolver,
    )
    expect(total).toBe(24)
  })

  it('a person with no rate on that day costs nothing, never $0.00 by accident', () => {
    expect(
      laborCost(
        [{ id: 'a', employeeId: 'emp-lisa', minutes: 60, billable: true, date: '1969-12-31' }],
        resolver,
      ),
    ).toBe(0)
  })
})
