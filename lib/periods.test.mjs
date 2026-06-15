import { describe, expect, it } from 'vitest'
import {
  currentPeriod,
  isValidPeriod,
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
