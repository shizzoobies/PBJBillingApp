import { describe, expect, it } from 'vitest'
import {
  billRateAt,
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

describe('billRateAt', () => {
  const versions = [
    { userId: 'emp-jane', effectivePeriod: '2026-10', rate: 60 },
    { userId: 'emp-jane', effectivePeriod: '2027-01', rate: 70 },
    { userId: 'emp-lisa', effectivePeriod: '2026-06', rate: 40 },
  ]
  const jane = { id: 'emp-jane', billRate: 70 }

  it('reads the version at or before the pin first', () => {
    expect(billRateAt(versions, { id: 'emp-lisa', billRate: 99 }, '2026-06', '2026-11')).toBe(40)
    expect(billRateAt(versions, jane, '2027-01', '2027-02')).toBe(70)
  })

  it('holds the FIRST rate when nothing predates the pin, never the newest', () => {
    expect(billRateAt(versions, jane, '2026-06', '2026-11')).toBe(60)
    expect(billRateAt(versions, jane, '2026-06', '2027-05')).toBe(60)
  })

  it('is null before the person’s first rate has started, even with a mirror', () => {
    expect(billRateAt(versions, jane, '2026-06', '2026-09')).toBeNull()
  })

  it('reads the live billRate only for someone with no versions at all', () => {
    expect(billRateAt([], jane, '2026-06', '2026-11')).toBe(70)
    expect(billRateAt(undefined, jane, null, '2026-11')).toBe(70)
    expect(billRateAt(versions, { id: 'emp-new', billRate: 45 }, '2026-06', '2026-11')).toBe(45)
    expect(billRateAt([], { id: 'emp-new' }, '2026-06', '2026-11')).toBeNull()
  })

  it('uses the billing period when the client is unpinned', () => {
    expect(billRateAt(versions, jane, null, '2027-02')).toBe(70)
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

describe('ratePeriodAsOf reads the moves in the order they were made', () => {
  const move = (from, to, changedAt) => ({ from, to, changedAt, changedBy: 'emp-patrice' })
  const client = (...history) => ({ hourlyRatePeriod: history.at(-1).to, hourlyRateHistory: history })

  it('a CORRECTION replaces a move that had not started yet: October never bills at October', () => {
    // Moved to October, then — still in September — corrected to November.
    // The October move never took effect, so October stays on June.
    const corrected = client(
      move('2026-06', '2026-10', '2026-09-05T15:00:00.000Z'),
      move('2026-10', '2026-11', '2026-09-20T15:00:00.000Z'),
    )
    expect(ratePeriodAsOf(corrected, '2026-09')).toBe('2026-06')
    expect(ratePeriodAsOf(corrected, '2026-10')).toBe('2026-06')
    expect(ratePeriodAsOf(corrected, '2026-11')).toBe('2026-11')
    expect(ratePeriodAsOf(corrected, '2027-03')).toBe('2026-11')
  })

  it('an UNDO puts every month back on the original pin', () => {
    const undone = client(
      move('2026-06', '2026-10', '2026-09-05T15:00:00.000Z'),
      move('2026-10', '2026-06', '2026-09-06T15:00:00.000Z'),
    )
    for (const period of ['2026-05', '2026-06', '2026-09', '2026-10', '2026-11', '2027-06']) {
      expect(ratePeriodAsOf(undone, period), period).toBe('2026-06')
    }
  })

  it('a normal two-step move keeps both steps', () => {
    const twoStep = client(
      move('2026-06', '2026-09', '2026-08-15T15:00:00.000Z'),
      move('2026-09', '2026-12', '2026-11-10T15:00:00.000Z'),
    )
    expect(ratePeriodAsOf(twoStep, '2026-07')).toBe('2026-06')
    expect(ratePeriodAsOf(twoStep, '2026-08')).toBe('2026-06')
    expect(ratePeriodAsOf(twoStep, '2026-09')).toBe('2026-09')
    expect(ratePeriodAsOf(twoStep, '2026-11')).toBe('2026-09')
    expect(ratePeriodAsOf(twoStep, '2026-12')).toBe('2026-12')
    expect(ratePeriodAsOf(twoStep, '2027-04')).toBe('2026-12')
  })

  it('a RETROACTIVE move made in November reprices September through November', () => {
    // In August the client was moved to December; in November the owner
    // agreed the new rates should have started in September.
    const retro = client(
      move('2026-06', '2026-12', '2026-08-15T15:00:00.000Z'),
      move('2026-12', '2026-09', '2026-11-10T15:00:00.000Z'),
    )
    expect(ratePeriodAsOf(retro, '2026-08')).toBe('2026-06')
    expect(ratePeriodAsOf(retro, '2026-09')).toBe('2026-09')
    expect(ratePeriodAsOf(retro, '2026-11')).toBe('2026-09')
    expect(ratePeriodAsOf(retro, '2026-12')).toBe('2026-09')
    expect(ratePeriodAsOf(retro, '2027-02')).toBe('2026-09')
  })

  it('orders by changedAt, not by where the entry sits in the array', () => {
    const shuffled = {
      hourlyRatePeriod: '2026-06',
      hourlyRateHistory: [
        move('2026-10', '2026-06', '2026-09-06T15:00:00.000Z'),
        move('2026-06', '2026-10', '2026-09-05T15:00:00.000Z'),
      ],
    }
    expect(ratePeriodAsOf(shuffled, '2026-10')).toBe('2026-06')
    expect(ratePeriodAsOf(shuffled, '2026-12')).toBe('2026-06')
  })
})
