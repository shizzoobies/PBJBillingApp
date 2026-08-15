/**
 * Types for the plain-JS `lib/checklist-skip.js`, so `src/` can import the
 * shared quiet-skip rules without a second TypeScript copy drifting away from
 * the server's.
 */

/** The three reason categories, in Brittany's words. */
export type SkipReasonCategory = 'me' | 'colleague' | 'client'

export interface SkipReasonOption {
  value: SkipReasonCategory
  label: string
}

export declare const SKIP_REASON_CATEGORIES: SkipReasonOption[]

export declare function isSkipReasonCategory(value: unknown): value is SkipReasonCategory
export declare function skipReasonLabel(value: string): string

export declare const SKIP_NOT_ENABLED_MESSAGE: string
export declare const SKIP_NEEDS_CATEGORY_MESSAGE: string
export declare const SKIP_NEEDS_EXPLANATION_MESSAGE: string
export declare const SKIP_ALREADY_SKIPPED_MESSAGE: string
export declare const SKIP_EXPLANATION_MAX_LENGTH: number

export declare function validateSkipRequest(input?: {
  category?: string
  explanation?: string
}):
  | { ok: true; error: null; category: SkipReasonCategory; explanation: string }
  | { ok: false; error: string }

/**
 * Accepts any checklist-shaped object: callers pass real `Checklist` values and
 * test fixtures alike, and an object that simply has no `skippedAt` is the
 * common, correct case (an unskipped task), not a type error.
 */
export declare function isChecklistSkipped(
  checklist: { skippedAt?: string | null; [key: string]: unknown } | null | undefined,
): boolean

export declare function isSkipAllowedForChecklist(
  checklist: { templateId?: string } | null | undefined,
  templates?: { id?: string; skipAllowed?: boolean }[],
): boolean

export declare function canOfferSkip(args: {
  checklist: { templateId?: string; skippedAt?: string | null } | null | undefined
  templates?: { id?: string; skipAllowed?: boolean }[]
  canWrite: boolean
}): boolean

export declare function skipNotificationRecipients(args?: {
  client?: { assignedBookkeeperIds?: string[] } | null
  employees?: { id?: string; role?: string }[]
  skipperId?: string
}): string[]

export declare function pendingSkipReviews<
  T extends { skippedAt?: string | null; reviewedAt?: string | null },
>(skips: T[], year: number): T[]
