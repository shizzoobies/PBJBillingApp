/**
 * Types for the plain-JS `lib/engagement-record.js`: the sign dialog asks the same
 * question the store does about an amendment.
 */

export declare function engagementIsPureRecord(
  engagement:
    | {
        kind?: string | null
        figures?: { totals?: object | null; lines?: ReadonlyArray<unknown> | null } | null
        planIds?: ReadonlyArray<string> | null
        packageId?: string | null
        retainerAmount?: number | null
        feeMode?: string | null
      }
    | null
    | undefined,
): boolean
