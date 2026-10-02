/**
 * Types for the plain-JS `lib/periods.js`, so `src/` tests can import the
 * server's period rules.
 *
 * Keep the shapes here in sync with the actual exports in lib/periods.js.
 */

/** `month` ("2026-08"), `quarter` ("2026-Q3") or `year` ("2026"). */
export type PeriodType = 'month' | 'quarter' | 'year'

/** How many months each period type covers. */
export declare const MONTHS_IN_PERIOD: Record<PeriodType, number>

export declare function monthsInPeriodType(type: string): number

export declare function isValidPeriodType(type: unknown): type is PeriodType

export declare function isValidPeriod(type: string, period: unknown): boolean

/** The period containing `todayIso` (yyyy-mm-dd). */
export declare function currentPeriod(type: PeriodType, todayIso: string): string

/** Inclusive yyyy-mm-dd date range for a period. */
export declare function periodRange(
  type: PeriodType,
  period: string,
): { start: string; end: string }

export declare function shiftPeriod(type: PeriodType, period: string, dir: number): string

export declare function previousPeriod(type: PeriodType, period: string): string

export declare function periodLabel(type: PeriodType, period: string): string
