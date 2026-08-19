/**
 * Types for the covered-date window helpers. Implementation is plain JS so the
 * server generator and the store can import it; this lets the React side use
 * the same resolver for its invoice preview.
 */

/**
 * Why the owner is being asked to confirm a window before it bills.
 * `backfill` is a period generated BEHIND one already billed.
 */
export type CoverageReason = 'gap' | 'resumed' | 'backfill'

/** Where a resolved window came from — see `resolveCoverageForPeriod`. */
export type CoverageSource = 'ledger' | 'seed' | 'advance'

export type CoverageRange = {
  /** yyyy-mm-dd, inclusive start of the window this invoice covers. */
  start: string
  /** yyyy-mm-dd, the day the cycle turns. Becomes the NEXT window's start. */
  end: string
}

export type ResolvedCoverage = CoverageRange & {
  needsConfirmation: boolean
  reason: CoverageReason | null
  source: CoverageSource
}

/** One period's stored answer, as it lives in the expense's ledger. */
export type CoverageLedgerEntry = CoverageRange & {
  needsConfirmation?: boolean
  reason?: CoverageReason | null
}

/** Ledger keyed by billing period ("2026-08"). */
export type CoverageLedger = Record<string, CoverageLedgerEntry>

/** The coverage half of a recurring reimbursement record. */
export type CoverageConfig = {
  coverageEnabled?: boolean
  coverageTemplate?: string
  /** yyyy-mm-dd — the first window's start, typed once at setup. */
  coverageStart?: string | null
  /** yyyy-mm-dd — the first window's end. Its day-of-month seeds the anchor. */
  coverageEnd?: string | null
  /**
   * The day of the month the cycle turns on. STORED rather than re-derived, so
   * a window the owner confirmed onto a different day does not snap back.
   */
  coverageAnchorDay?: number | null
  coveragePaused?: boolean
  /** Set when a paused expense is switched back on; forces one confirmation. */
  coverageResumePending?: boolean
  coverageHistory?: CoverageLedger
  description?: string
  frequency?: string
}

export const COVERAGE_PLACEHOLDERS: string[]
export const DEFAULT_COVERAGE_TEMPLATE: string

export function coverageStepMonths(frequency: unknown): number
export function isIsoDate(value: unknown): boolean
export function addMonthsClamped(iso: string, months: number): string | null
export function withDayClamped(iso: string, day: unknown): string | null
export function nextCoverageRange(
  range: { end?: string } | null | undefined,
  options?: { months?: number; anchorDay?: number | null },
): CoverageRange | null

export function formatCoverageDate(iso: string): string
export function formatCoverageRange(start: string, end: string): string
export function applyCoverageTemplate(
  template: unknown,
  values?: { start?: string; end?: string; description?: string },
): string

export function hasCoverage(expense: CoverageConfig | null | undefined): boolean
export function anchorDayOf(expense: CoverageConfig | null | undefined): number | null
export function anchorDayFromRange(end: string | null | undefined): number | null
export function normalizeRecurringReimbursement<T>(record: T): T
export function resolveCoverageForPeriod(
  expense: CoverageConfig | null | undefined,
  period: string,
): ResolvedCoverage | null
export function coverageLineLabel(
  expense: CoverageConfig | null | undefined,
  coverage: CoverageRange | null | undefined,
): string | null
export function hasUnconfirmedCoverage(
  lineItems: Array<{ kind?: string; needsCoverageConfirmation?: boolean }> | null | undefined,
): boolean
export function coverageConfirmationPrompt(reason: unknown): string
