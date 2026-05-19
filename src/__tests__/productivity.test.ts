import { describe, expect, it } from 'vitest'
import {
  businessDaysIn,
  periodsBetween,
  rangeForPreset,
} from '../lib/productivity'

// All of these helpers accept an injected date (or operate on ISO strings),
// so every assertion below is deterministic and clock-independent.

describe('rangeForPreset', () => {
  it('"this-week" returns the Monday–Sunday window containing today', () => {
    // 2026-05-20 is a Wednesday.
    const wednesday = new Date(2026, 4, 20, 12, 0, 0)
    const { from, to } = rangeForPreset('this-week', wednesday)
    expect(from).toBe('2026-05-18') // Monday
    expect(to).toBe('2026-05-24') // Sunday
  })

  it('"this-week" treats Sunday as the last day of the current week', () => {
    // 2026-05-24 is a Sunday — Monday is still 2026-05-18.
    const sunday = new Date(2026, 4, 24, 12, 0, 0)
    const { from, to } = rangeForPreset('this-week', sunday)
    expect(from).toBe('2026-05-18')
    expect(to).toBe('2026-05-24')
  })

  it('"last-week" returns the full prior Monday–Sunday window', () => {
    const wednesday = new Date(2026, 4, 20, 12, 0, 0)
    const { from, to } = rangeForPreset('last-week', wednesday)
    expect(from).toBe('2026-05-11') // previous Monday
    expect(to).toBe('2026-05-17') // previous Sunday
  })

  it('"this-month" spans the first to the last calendar day', () => {
    const midMay = new Date(2026, 4, 20, 12, 0, 0)
    const { from, to } = rangeForPreset('this-month', midMay)
    expect(from).toBe('2026-05-01')
    expect(to).toBe('2026-05-31')
  })

  it('"last-month" rolls back across a year boundary', () => {
    // January 2026 -> last month is December 2025.
    const january = new Date(2026, 0, 15, 12, 0, 0)
    const { from, to } = rangeForPreset('last-month', january)
    expect(from).toBe('2025-12-01')
    expect(to).toBe('2025-12-31')
  })
})

describe('periodsBetween', () => {
  it('daily granularity yields one ISO date per inclusive day', () => {
    const days = periodsBetween('2026-05-18', '2026-05-21', 'daily')
    expect(days).toEqual(['2026-05-18', '2026-05-19', '2026-05-20', '2026-05-21'])
  })

  it('weekly granularity anchors each bucket to a Monday', () => {
    // 2026-05-20 (Wed) .. 2026-06-02 (Tue) spans three Monday-anchored weeks.
    const weeks = periodsBetween('2026-05-20', '2026-06-02', 'weekly')
    expect(weeks).toEqual(['2026-05-18', '2026-05-25', '2026-06-01'])
  })

  it('returns an empty array when the range is inverted', () => {
    expect(periodsBetween('2026-05-21', '2026-05-18', 'daily')).toEqual([])
  })
})

describe('businessDaysIn', () => {
  it('excludes weekends from an inclusive day count', () => {
    // 2026-05-18 (Mon) .. 2026-05-24 (Sun): 5 weekdays.
    expect(businessDaysIn('2026-05-18', '2026-05-24')).toBe(5)
  })

  it('counts zero across a pure weekend', () => {
    // 2026-05-23 (Sat) .. 2026-05-24 (Sun).
    expect(businessDaysIn('2026-05-23', '2026-05-24')).toBe(0)
  })

  it('counts a single weekday as 1', () => {
    expect(businessDaysIn('2026-05-20', '2026-05-20')).toBe(1)
  })
})
