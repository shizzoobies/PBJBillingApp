import { describe, expect, it } from 'vitest'
import {
  billRateFor,
  costRateFor,
  latestBillRate,
  latestCostRate,
  ratePeriodAsOf,
} from './rate-history.js'

const bill = [
  { userId: 'emp-lisa', effectivePeriod: '2026-06', rate: 40 },
  { userId: 'emp-lisa', effectivePeriod: '2027-01', rate: 55 },
  { userId: 'emp-allison', effectivePeriod: '2026-09', rate: 70 },
]

describe('billRateFor', () => {
  it('hits an exact month', () => {
    expect(billRateFor(bill, 'emp-lisa', '2026-06')).toBe(40)
    expect(billRateFor(bill, 'emp-lisa', '2027-01')).toBe(55)
  })

  it('carries the latest version forward to a later month', () => {
    expect(billRateFor(bill, 'emp-lisa', '2026-12')).toBe(40)
    expect(billRateFor(bill, 'emp-lisa', '2030-03')).toBe(55)
  })

  it('is null before the first version', () => {
    expect(billRateFor(bill, 'emp-lisa', '2026-05')).toBeNull()
    expect(billRateFor(bill, 'emp-allison', '2026-08')).toBeNull()
  })

  it('does not read one person’s versions for another', () => {
    expect(billRateFor(bill, 'emp-allison', '2026-09')).toBe(70)
    expect(billRateFor(bill, 'emp-nobody', '2026-09')).toBeNull()
  })

  it('does not depend on the input order', () => {
    const shuffled = [bill[1], bill[2], bill[0]]
    expect(billRateFor(shuffled, 'emp-lisa', '2026-12')).toBe(40)
  })

  it('answers null for a missing period or a missing list', () => {
    expect(billRateFor(bill, 'emp-lisa', null)).toBeNull()
    expect(billRateFor(null, 'emp-lisa', '2026-06')).toBeNull()
  })
})

const cost = [
  { userId: 'emp-lisa', effectiveDate: '1970-01-01', rate: 20 },
  { userId: 'emp-lisa', effectiveDate: '2026-09-15', rate: 24 },
]

describe('costRateFor', () => {
  it('costs the day before a raise at the old rate and the day of it at the new', () => {
    expect(costRateFor(cost, 'emp-lisa', '2026-09-14')).toBe(20)
    expect(costRateFor(cost, 'emp-lisa', '2026-09-15')).toBe(24)
    expect(costRateFor(cost, 'emp-lisa', '2026-09-16')).toBe(24)
  })

  it('is null before the first version', () => {
    expect(costRateFor(cost, 'emp-lisa', '1969-12-31')).toBeNull()
  })
})

describe('latestBillRate / latestCostRate', () => {
  it('returns the greatest version, whatever the order', () => {
    expect(latestBillRate([bill[1], bill[0]], 'emp-lisa')).toBe(55)
    expect(latestCostRate(cost, 'emp-lisa')).toBe(24)
  })

  it('is null for someone with no versions', () => {
    expect(latestBillRate(bill, 'emp-nobody')).toBeNull()
    expect(latestCostRate(cost, 'emp-nobody')).toBeNull()
  })
})

describe('ratePeriodAsOf', () => {
  const moved = {
    hourlyRatePeriod: '2026-09',
    hourlyRateHistory: [
      { from: null, to: '2026-06', changedAt: '2026-06-01T00:00:00.000Z', changedBy: 'emp-patrice' },
      { from: '2026-06', to: '2026-09', changedAt: '2026-08-20T00:00:00.000Z', changedBy: 'emp-patrice' },
    ],
  }

  it('reads the pin that applied in a past month, not today’s', () => {
    expect(ratePeriodAsOf(moved, '2026-07')).toBe('2026-06')
    expect(ratePeriodAsOf(moved, '2026-09')).toBe('2026-09')
    expect(ratePeriodAsOf(moved, '2026-12')).toBe('2026-09')
  })

  it('falls back to the earliest from when the month predates every move', () => {
    expect(ratePeriodAsOf(moved, '2026-05')).toBeNull()
  })

  it('uses the live pin when there is no history', () => {
    expect(ratePeriodAsOf({ hourlyRatePeriod: '2026-06', hourlyRateHistory: [] }, '2026-09')).toBe('2026-06')
    expect(ratePeriodAsOf({ hourlyRatePeriod: '2026-06' }, '2026-09')).toBe('2026-06')
  })

  it('is null for a client with neither', () => {
    expect(ratePeriodAsOf({}, '2026-09')).toBeNull()
    expect(ratePeriodAsOf(null, '2026-09')).toBeNull()
  })
})
