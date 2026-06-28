import { describe, expect, it } from 'vitest'
import {
  defaultReportPeriod,
  isInReportPeriod,
  isSingleWeek,
  normalizeReportPeriod,
  presetRange,
  reportPeriodLabel,
  type ReportPeriod,
} from '../lib/reportPeriod'

// A fixed "today" — Wed 2026-06-24 — so every range is deterministic.
const TODAY = '2026-06-24'

describe('presetRange', () => {
  it('week → the Sun–Sat week containing today', () => {
    // 2026-06-24 is a Wednesday; its week is Sun 06-21 … Sat 06-27.
    expect(presetRange('week', TODAY)).toEqual({ from: '2026-06-21', to: '2026-06-27' })
  })

  it('month → first..last of today’s month', () => {
    expect(presetRange('month', TODAY)).toEqual({ from: '2026-06-01', to: '2026-06-30' })
  })

  it('quarter → the calendar quarter containing today', () => {
    expect(presetRange('quarter', TODAY)).toEqual({ from: '2026-04-01', to: '2026-06-30' })
  })

  it('ytd → Jan 1 .. today', () => {
    expect(presetRange('ytd', TODAY)).toEqual({ from: '2026-01-01', to: '2026-06-24' })
  })
})

describe('defaultReportPeriod', () => {
  it('is the current month', () => {
    expect(defaultReportPeriod(TODAY)).toEqual({
      preset: 'month',
      from: '2026-06-01',
      to: '2026-06-30',
    })
  })
})

describe('isInReportPeriod', () => {
  const period: ReportPeriod = { preset: 'month', from: '2026-06-01', to: '2026-06-30' }

  it('includes both boundaries (inclusive)', () => {
    expect(isInReportPeriod('2026-06-01', period)).toBe(true)
    expect(isInReportPeriod('2026-06-30', period)).toBe(true)
  })

  it('excludes the day before and the day after', () => {
    expect(isInReportPeriod('2026-05-31', period)).toBe(false)
    expect(isInReportPeriod('2026-07-01', period)).toBe(false)
  })

  it('treats an empty date as not in range', () => {
    expect(isInReportPeriod('', period)).toBe(false)
  })
})

describe('normalizeReportPeriod', () => {
  it('re-derives the bounds for a non-custom preset from today', () => {
    // A stored "month" period from an old month must snap to THIS month.
    const stored = { preset: 'month', from: '2026-01-01', to: '2026-01-31' }
    expect(normalizeReportPeriod(stored, TODAY)).toEqual({
      preset: 'month',
      from: '2026-06-01',
      to: '2026-06-30',
    })
  })

  it('preserves a valid custom range', () => {
    const stored = { preset: 'custom', from: '2026-03-10', to: '2026-03-20' }
    expect(normalizeReportPeriod(stored, TODAY)).toEqual({
      preset: 'custom',
      from: '2026-03-10',
      to: '2026-03-20',
    })
  })

  it('swaps a reversed custom range', () => {
    const stored = { preset: 'custom', from: '2026-03-20', to: '2026-03-10' }
    expect(normalizeReportPeriod(stored, TODAY)).toEqual({
      preset: 'custom',
      from: '2026-03-10',
      to: '2026-03-20',
    })
  })

  it('falls back to the default month for junk / invalid custom dates', () => {
    expect(normalizeReportPeriod(null, TODAY)).toEqual(defaultReportPeriod(TODAY))
    expect(normalizeReportPeriod('nope', TODAY)).toEqual(defaultReportPeriod(TODAY))
    expect(
      normalizeReportPeriod({ preset: 'custom', from: 'bad', to: '2026-03-20' }, TODAY),
    ).toEqual(defaultReportPeriod(TODAY))
  })
})

describe('isSingleWeek', () => {
  it('true when the range is exactly one Sun–Sat week', () => {
    const week: ReportPeriod = { preset: 'week', from: '2026-06-21', to: '2026-06-27' }
    expect(isSingleWeek(week, TODAY)).toBe(true)
  })

  it('false for a whole month', () => {
    const month: ReportPeriod = { preset: 'month', from: '2026-06-01', to: '2026-06-30' }
    expect(isSingleWeek(month, TODAY)).toBe(false)
  })

  it('false when from is a Sunday but to is not the matching Saturday', () => {
    const off: ReportPeriod = { preset: 'custom', from: '2026-06-21', to: '2026-06-26' }
    expect(isSingleWeek(off, TODAY)).toBe(false)
  })
})

describe('reportPeriodLabel', () => {
  it('renders a same-year range with one year suffix', () => {
    expect(
      reportPeriodLabel({ preset: 'month', from: '2026-06-01', to: '2026-06-30' }),
    ).toBe('Jun 1 – Jun 30, 2026')
  })

  it('shows the year on both ends when the range crosses a year', () => {
    expect(
      reportPeriodLabel({ preset: 'custom', from: '2025-12-01', to: '2026-01-31' }),
    ).toBe('Dec 1, 2025 – Jan 31, 2026')
  })
})
