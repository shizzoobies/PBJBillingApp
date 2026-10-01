/**
 * Types for the plain-JS `lib/series-step-delete.js` (the rules behind the
 * "this and future" step delete), so a test or `src/` can import them.
 */

export declare const LAST_RECURRING_STEP_MESSAGE: string
export declare function normalizeStepLabel(label: unknown): string
export declare function normalizedLabelSql(column: string): string
export declare function stepCarriesWork(item: unknown): boolean
export declare function untouchedStepSql(alias?: string): string
export declare function sameLabelOrdinal(items: { id: string; label?: string }[], itemId: string): number
export declare function pickCopyToRemove(
  copies: { id: string; carriesWork: boolean }[],
  ordinal: number,
): { removeId: string | null; kept: boolean }
