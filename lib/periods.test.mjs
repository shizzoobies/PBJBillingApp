import { describe, expect, it } from 'vitest'
import {
  currentPeriod,
  isValidPeriod,
  isValidPeriodType,
  monthsInPeriodType,
  periodLabel,
  periodRange,
  previousPeriod,
  shiftPeriod,
} from './periods.js'

describe('currentPeriod', () => {
  it('derives the month and quarter for a date', () => {
    expect(currentPeriod('month', '2026-08-14')).toBe('2026-08')
    expect(currentPeriod('quarter', '2026-08-14')).toBe('2026-Q3')
    expect(currentPeriod('quarter', '2026-01-01')).toBe('2026-Q1')
    expect(currentPeriod('quarter', '2026-12-31')).toBe('2026-Q4')
  })
})

describe('periodRange', () => {
  it('bounds a month inclusively, handling 30/31/28 days', () => {
    expect(periodRange('month', '2026-08')).toEqual({ start: '2026-08-01', end: '2026-08-31' })
    expect(periodRange('month', '2026-04')).toEqual({ start: '2026-04-01', end: '2026-04-30' })
    expect(periodRange('month', '2026-02')).toEqual({ start: '2026-02-01', end: '2026-02-28' })
  })

  it('bounds a quarter across its three months', () => {
    expect(periodRange('quarter', '2026-Q1')).toEqual({ start: '2026-01-01', end: '2026-03-31' })
    expect(periodRange('quarter', '2026-Q3')).toEqual({ start: '2026-07-01', end: '2026-09-30' })
    expect(periodRange('quarter', '2026-Q4')).toEqual({ start: '2026-10-01', end: '2026-12-31' })
  })
})

describe('shiftPeriod / previousPeriod', () => {
  it('rolls months across year boundaries', () => {
    expect(shiftPeriod('month', '2026-01', -1)).toBe('2025-12')
    expect(shiftPeriod('month', '2026-12', 1)).toBe('2027-01')
    expect(previousPeriod('month', '2026-08')).toBe('2026-07')
  })

  it('rolls quarters across year boundaries', () => {
    expect(shiftPeriod('quarter', '2026-Q1', -1)).toBe('2025-Q4')
    expect(shiftPeriod('quarter', '2026-Q4', 1)).toBe('2027-Q1')
    expect(previousPeriod('quarter', '2026-Q3')).toBe('2026-Q2')
  })
})

describe('isValidPeriod', () => {
  it('validates format and bounds', () => {
    expect(isValidPeriod('month', '2026-08')).toBe(true)
    expect(isValidPeriod('month', '2026-13')).toBe(false)
    expect(isValidPeriod('month', '2026-Q3')).toBe(false)
    expect(isValidPeriod('quarter', '2026-Q3')).toBe(true)
    expect(isValidPeriod('quarter', '2026-Q5')).toBe(false)
    expect(isValidPeriod('quarter', '2026-08')).toBe(false)
  })
})

describe('periodLabel', () => {
  it('labels months and quarters', () => {
    expect(periodLabel('month', '2026-08')).toBe('August 2026')
    expect(periodLabel('quarter', '2026-Q3')).toBe('Q3 2026')
  })
})

/**
 * The YEARLY period, added because the recap's Quarterly view answered "how is
 * the plan holding up" three months at a time and the firm owner wanted the
 * same question asked of a whole year. A year is a calendar year and TWELVE
 * monthly estimates — nothing about it is prorated or fiscal.
 */
describe('yearly periods', () => {
  it('accepts "year" as a period type and a bare 4-digit year as its period', () => {
    expect(isValidPeriodType('year')).toBe(true)
    expect(isValidPeriod('year', '2026')).toBe(true)
    // The other two shapes must not be mistaken for a year, or the recap would
    // silently range over the wrong dates.
    expect(isValidPeriod('year', '2026-08')).toBe(false)
    expect(isValidPeriod('year', '2026-Q3')).toBe(false)
    expect(isValidPeriod('month', '2026')).toBe(false)
    expect(isValidPeriod('quarter', '2026')).toBe(false)
  })

  it('derives, bounds and labels a calendar year', () => {
    expect(currentPeriod('year', '2026-08-14')).toBe('2026')
    expect(periodRange('year', '2026')).toEqual({ start: '2026-01-01', end: '2026-12-31' })
    expect(periodLabel('year', '2026')).toBe('2026')
  })

  it('steps a whole year at a time, in both directions', () => {
    expect(shiftPeriod('year', '2026', 1)).toBe('2027')
    expect(shiftPeriod('year', '2026', -1)).toBe('2025')
    expect(previousPeriod('year', '2026')).toBe('2025')
  })

  it('counts a year as twelve monthly estimates', () => {
    expect(monthsInPeriodType('month')).toBe(1)
    expect(monthsInPeriodType('quarter')).toBe(3)
    expect(monthsInPeriodType('year')).toBe(12)
  })
})
