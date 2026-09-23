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

/** Anything with an id and, optionally, the pre-rate-history live mirror. */
export type RatedEmployee = {
  id: string
  billRate?: number | null
}

/**
 * The one bill-rate chain every pricing surface shares: the version at or
 * before the pin (`ratePeriod ?? billingPeriod`); else the person's EARLIEST
 * version if it has started by `billingPeriod`; else, ONLY for someone with no
 * versions at all, their live `billRate`; else null (the caller falls back to
 * the client's own rate).
 */
export declare function billRateAt(
  versions: readonly BillRateVersion[] | null | undefined,
  employee: RatedEmployee | null | undefined,
  ratePeriod: string | null | undefined,
  billingPeriod: string | null | undefined,
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

/**
 * The client's pin as it stood in `period`. Replays `hourlyRateHistory` in
 * written order (`changedAt`, else array order): a later move supersedes every
 * earlier move whose `to` is at or after its own, and cancels any earlier move
 * whose `to` had not started when it was made. A month before every standing
 * move falls back to the first entry's `from`; no history reads the live
 * `hourlyRatePeriod`; null means unpinned.
 */
export declare function ratePeriodAsOf(
  client: PinnedClient | null | undefined,
  period: string | null | undefined,
): string | null
