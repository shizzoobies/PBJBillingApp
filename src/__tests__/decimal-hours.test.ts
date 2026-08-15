import { describe, expect, it } from 'vitest'
import { decimalHours, formatDecimalHours, formatHoursMinutes } from '../lib/utils'

/**
 * The two-decimal hours formatter, from the firm owner's request: "any time a
 * time measurement is being used it should be 2 decimals through the whole
 * site". Two decimals ALWAYS — a column only adds up by eye when every cell has
 * the same shape.
 *
 * It replaced a one-decimal formatter, which is the interesting case: 20.2214
 * hours used to read "20.2h", and no amount of squinting reconciles that with a
 * dollar figure.
 */
describe('formatDecimalHours', () => {
  it('always shows two decimals, including whole and half hours', () => {
    expect(formatDecimalHours(60)).toBe('1.00h')
    expect(formatDecimalHours(120)).toBe('2.00h')
    expect(formatDecimalHours(30)).toBe('0.50h')
    expect(formatDecimalHours(90)).toBe('1.50h')
  })

  it('reads zero as 0.00h, never "0h" or "-0.00h"', () => {
    expect(formatDecimalHours(0)).toBe('0.00h')
    expect(formatDecimalHours(-0)).toBe('0.00h')
  })

  it('rounds to the nearest hundredth of an hour', () => {
    // The disputed period, in her real numbers.
    expect(formatDecimalHours(1213.2833)).toBe('20.22h') // Lisa, 20.2214h
    expect(formatDecimalHours(1260.8333)).toBe('21.01h') // Allison, 21.0139h
    // Rounds up, not truncates: 0.375h.
    expect(formatDecimalHours(22.5)).toBe('0.38h')
    // Just under and just over the last hundredth before a full hour.
    expect(formatDecimalHours(59.4)).toBe('0.99h')
    expect(formatDecimalHours(59.8)).toBe('1.00h')
  })

  it('rounds an exact half-hundredth UP, the way written arithmetic does', () => {
    // 59.7 min is 0.995h, which has no exact binary form and lands a hair
    // BELOW — a bare toFixed(2) reports "0.99h". This audience checks
    // arithmetic by hand (a 17-cent discrepancy started this whole thread), so
    // the formatter normalizes through a fixed-precision string first, the same
    // way roundToCent does for money.
    expect(formatDecimalHours(59.7)).toBe('1.00h')
    expect(formatDecimalHours(0.3)).toBe('0.01h') // 0.005h exactly
    expect(formatDecimalHours(9.3)).toBe('0.16h') // 0.155h exactly
  })

  it('keeps sub-minute time visible as a nonzero figure where it can be', () => {
    // 45 seconds = 0.0125h, below half a hundredth, so it rounds to 0.01h.
    expect(formatDecimalHours(0.75)).toBe('0.01h')
    // A genuinely tiny slice still reads 0.00h — the honest answer at 2dp, and
    // the reason entry surfaces keep h/m instead (see below).
    expect(formatDecimalHours(0.1)).toBe('0.00h')
  })

  it('shows a negative delta with its sign (the recap prints vs. prior)', () => {
    expect(formatDecimalHours(-90)).toBe('-1.50h')
  })

  it('never rounds to a single decimal — the old behavior', () => {
    // formatHours used to give "20.2h" here, and "1h" for 60 minutes.
    expect(formatDecimalHours(1213.2833)).not.toBe('20.2h')
    expect(formatDecimalHours(60)).not.toBe('1h')
  })
})

describe('decimalHours', () => {
  it('is formatDecimalHours without the unit, so the two cannot drift', () => {
    for (const minutes of [0, 0.75, 30, 59.7, 1213.2833, -90]) {
      expect(`${decimalHours(minutes)}h`).toBe(formatDecimalHours(minutes))
    }
  })
})

/**
 * The deliberate exception. Live time-ENTRY and approval surfaces keep h/m: when
 * someone is logging or approving ONE piece of work, "23m" is the honest
 * reading and "0.38h" is not. This pins that the friendly formatter still
 * exists and still behaves — converting it everywhere was never the plan.
 */
describe('formatHoursMinutes still reads in hours and minutes', () => {
  it('renders a specific piece of work the way it was logged', () => {
    expect(formatHoursMinutes(80)).toBe('1h 20m')
    expect(formatHoursMinutes(23)).toBe('23m')
    expect(formatHoursMinutes(120)).toBe('2h')
    expect(formatHoursMinutes(45)).toBe('45m')
  })

  it('keeps sub-minute stops visible, which 2dp hours cannot', () => {
    expect(formatHoursMinutes(0.75)).toBe('45s')
    expect(formatDecimalHours(0.75)).toBe('0.01h')
  })
})
