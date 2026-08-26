import { describe, expect, it } from 'vitest'
import {
  allocatePersonCost,
  periodDisplayHours,
  periodMoney,
  sumPersonCosts,
} from '../lib/payrollAggregation'

/**
 * featreq-7c8f64d7, round four — pinned with the REAL DATA she reopened it on.
 *
 * Brittany, 2026-08-26, off the 8/8-8/22 payroll run:
 *
 *   "On Allison her total hours calculate to 14.75 multiply that by 38 total is
 *   $560.50 cost line shows $561.60 her billable time total equals 14.16 times
 *   115 equals $1,628.40 billable amount shows $1,631.68
 *   On Lisa her total hours calculate to 22.61 multiply that by 16 total is
 *   $361.80 cost line shows $361.40 her billable time total equals 22.61 times
 *   75 equals $1,695.75 billable amount shows $1,694.23"
 *
 * The arrays below are those two people's actual entry minutes for that period,
 * read out of production. The SHAPE is the whole problem: 31 rows for Allison
 * and 63 for Lisa, whose two-decimal hours sum to something other than their
 * raw totals rounded — 14.75 against 14.78 one way, 22.61 against 22.59 the
 * other. That opposite-direction pair is why three earlier passes read this as
 * a rounding bug when it never was: nothing rounds the wrong way, the report
 * printed one figure and charged another.
 *
 * Her note on the tracker made the point better than the code did: "Note
 * Allison's cost/billable are HIGHER than hand math while Lisa's are LOWER, so
 * it's not a simple rounding-up bug."
 *
 * Only minutes are recorded here — no names, clients or descriptions.
 */

// Allison Lehmann, 2026-08-08 .. 2026-08-22 — 31 entries, cost 38, bill 115.
const ALLISON_ALL = [
  19, 8, 4.15, 6.666666666666667, 6.666666666666667, 101, 6.666666666666667,
  6.283333333333333, 5, 6.283333333333333, 5, 65, 3.683333333333333, 4.2, 199,
  5.233333333333333, 138, 5.233333333333333, 2.3666666666666667, 13.883333333333333, 24.05,
  34.81666666666667, 34.233333333333334, 6.7, 110, 5.483333333333333, 6.316666666666666,
  1.4666666666666666, 1.9333333333333333, 15, 35.53333333333333,
]
const ALLISON_BILLABLE = [
  19, 8, 4.15, 6.666666666666667, 6.666666666666667, 101, 6.666666666666667,
  6.283333333333333, 5, 6.283333333333333, 5, 65, 3.683333333333333, 4.2, 199,
  5.233333333333333, 138, 5.233333333333333, 2.3666666666666667, 13.883333333333333, 24.05,
  34.81666666666667, 34.233333333333334, 6.7, 110, 5.483333333333333, 6.316666666666666,
  1.4666666666666666, 1.9333333333333333, 15,
]

// Lisa Mockabee, same period — 63 entries, cost 16, bill 75.
const LISA_ALL = [
  60, 64, 49, 25.05, 9.9, 23.866666666666667, 25.883333333333333, 4.216666666666667, 1.25,
  1.25, 27.916666666666668, 7.233333333333333, 1.25, 1.25, 1.25, 1.25, 54, 1.25, 1.25, 1.25,
  1.25, 1.2666666666666666, 1.25, 1.25, 9.8, 1.25, 1.25, 1.25, 1.25, 1.25,
  1.2666666666666666, 2.816666666666667, 13.116666666666667, 12.683333333333334, 8, 3.1,
  16.3, 2.8, 5.283333333333333, 6.716666666666667, 6.716666666666667, 10.6,
  25.666666666666668, 26.85, 16.966666666666665, 29.55, 7.6, 16.583333333333332,
  32.31666666666667, 4.016666666666667, 74.9, 26.883333333333333, 2.433333333333333,
  3.8666666666666667, 18.533333333333335, 20.85, 26.516666666666666, 32.81666666666667,
  108.46666666666667, 137.31666666666666, 85.05, 55, 130.45,
]
const LISA_BILLABLE = [
  60, 64, 49, 25.05, 9.9, 23.866666666666667, 25.883333333333333, 4.216666666666667, 1.25,
  1.25, 27.916666666666668, 7.233333333333333, 1.25, 1.25, 1.25, 1.25, 54, 1.25, 1.25, 1.25,
  1.25, 1.2666666666666666, 1.25, 1.25, 9.8, 1.25, 1.25, 1.25, 1.25, 1.25,
  1.2666666666666666, 2.816666666666667, 13.116666666666667, 12.683333333333334, 8, 3.1,
  16.3, 2.8, 5.283333333333333, 6.716666666666667, 6.716666666666667, 10.6,
  25.666666666666668, 26.85, 16.966666666666665, 29.55, 7.6, 16.583333333333332,
  32.31666666666667, 4.016666666666667, 74.9, 26.883333333333333, 2.433333333333333,
  3.8666666666666667, 18.533333333333335, 20.85, 26.516666666666666, 32.81666666666667,
  108.46666666666667, 137.31666666666666, 85.05, 55, 130.45,
]

describe('the 8/8-8/22 payroll run she sent back', () => {
  it('prints the hours she read off the report', () => {
    expect(periodDisplayHours(ALLISON_ALL)).toBe(14.75)
    expect(periodDisplayHours(ALLISON_BILLABLE)).toBe(14.16)
    expect(periodDisplayHours(LISA_ALL)).toBe(22.61)
    expect(periodDisplayHours(LISA_BILLABLE)).toBe(22.61)
  })

  // The four figures she computed by hand. Each is the printed hours times the
  // rate, which is the entire specification.
  it('charges exactly those hours times the rate', () => {
    expect(periodMoney(ALLISON_ALL, 38)).toBe(560.5)
    expect(periodMoney(ALLISON_BILLABLE, 115)).toBe(1628.4)
    expect(periodMoney(LISA_ALL, 16)).toBe(361.76)
    expect(periodMoney(LISA_BILLABLE, 75)).toBe(1695.75)
  })

  /**
   * The exact wrong answers, named so they cannot come back quietly. Each is
   * the raw or re-rounded total rather than the printed one.
   */
  it('no longer produces any of the four figures she was shown', () => {
    expect(periodMoney(ALLISON_ALL, 38)).not.toBe(561.64)
    expect(periodMoney(ALLISON_BILLABLE, 115)).not.toBe(1631.69)
    expect(periodMoney(LISA_ALL, 16)).not.toBe(361.44)
    expect(periodMoney(LISA_BILLABLE, 75)).not.toBe(1694.27)
  })

  // She reads down the column as well as across: the per-entry Cost and
  // Billable $ cells have to add to the total printed underneath them.
  it('has columns that add up to those totals', () => {
    for (const [rows, rate] of [
      [ALLISON_ALL, 38],
      [ALLISON_BILLABLE, 115],
      [LISA_ALL, 16],
      [LISA_BILLABLE, 75],
    ] as const) {
      expect(sumPersonCosts(allocatePersonCost(rows, rate))).toBe(periodMoney(rows, rate))
    }
  })
})
