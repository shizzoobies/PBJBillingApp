/**
 * Types for the plain-JS `lib/rate-history.js`, so `src/` can resolve a rate
 * client-side (the Client page's "Hourly rates" block) through the very
 * function the server prices with.
 *
 * Keep these in sync with the actual exports in lib/rate-history.js.
 */

export type BillRateVersion = {
  userId: string
  /** 'YYYY-MM' — the first billing period this rate applies to. */
  effectivePeriod: string
  rate: number
  createdAt?: string
  createdBy?: string | null
}

export type CostRateVersion = {
  userId: string
  /** 'YYYY-MM-DD' — the first day worked at this rate. */
  effectiveDate: string
  rate: number
  createdAt?: string
  createdBy?: string | null
}

export type RateHistoryEntry = {
  from: string | null
  to: string
  changedAt: string
  changedBy: string
}

export type PinnedClient = {
  hourlyRatePeriod?: string | null
  hourlyRateHistory?: readonly RateHistoryEntry[] | null
}

export declare function billRateFor(
  versions: readonly BillRateVersion[] | null | undefined,
  employeeId: string,
  ratePeriod: string | null | undefined,
): number | null

export declare function costRateFor(
  versions: readonly CostRateVersion[] | null | undefined,
  employeeId: string,
  entryDate: string | null | undefined,
): number | null

export declare function latestBillRate(
  versions: readonly BillRateVersion[] | null | undefined,
  employeeId: string,
): number | null

export declare function latestCostRate(
  versions: readonly CostRateVersion[] | null | undefined,
  employeeId: string,
): number | null

export declare function ratePeriodAsOf(
  client: PinnedClient | null | undefined,
  period: string | null | undefined,
): string | null
