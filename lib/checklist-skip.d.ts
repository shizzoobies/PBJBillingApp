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

export declare const PUSH_NEEDS_DATE_MESSAGE: string
export declare const PUSH_DATE_UNREADABLE_MESSAGE: string
export declare const PUSH_DATE_NOT_LATER_MESSAGE: string
export declare const PUSH_DATE_TOO_FAR_MESSAGE: string
export declare const PUSH_MAX_YEARS_AHEAD: number

/**
 * A push carries everything a skip does plus the new due date, which must be a
 * real `yyyy-mm-dd` strictly after the instance's current `dueDate` and no more
 * than {@link PUSH_MAX_YEARS_AHEAD} years past it.
 */
export declare function validatePushRequest(
  input?: {
    category?: string
    explanation?: string
    newDueDate?: string
  },
  checklist?: { dueDate?: string } | null,
):
  | { ok: true; error: null; category: SkipReasonCategory; explanation: string; newDueDate: string }
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

// ---- Skip a step (featreq-7e1827e0) ----

export type SkipMode = 'whole' | 'step'

export declare const SKIP_MODES: SkipMode[]

export declare function templateSkipMode(
  template: { skipMode?: string | null } | null | undefined,
): SkipMode

type SkipModeTemplate = { skipAllowed?: boolean; skipMode?: string | null } | null | undefined
type StagedChecklist =
  | { stageIndex?: number; stageCount?: number; onboardingForClientId?: string | null }
  | null
  | undefined

export declare function isStepSkip(template: SkipModeTemplate, checklist: StagedChecklist): boolean
export declare function isLastStepOfStepSkip(template: SkipModeTemplate, checklist: StagedChecklist): boolean
/** Push a step (featreq-78f09571): pushing this checklist opens the next step. Same rule as `isStepSkip`. */
export declare function isStepPush(template: SkipModeTemplate, checklist: StagedChecklist): boolean
export declare function stepPushDialogNote(args: {
  stageNumber: number
  nextPersonName?: string
  nextAlreadyOpen?: boolean
  /** The next step's work is already finished: nothing opens and nobody is told. */
  nextFinished?: boolean
}): string
export declare const SKIP_MODE_STEP_PUSH_NOTE: string
export declare const STEP_PUSHED_SUBJECT: string
export declare const STEP_PUSH_NOT_OPENED_SUBJECT: string
export declare function pushDateWords(value: string | null | undefined): string
export declare function skipButtonLabel(stepSkip: boolean): string
export declare function stepSkipDialogLead(args: {
  stageNumber: number
  stageCount: number
  stageName?: string
  nextPersonName?: string
  /** The next step is already open (Open next step now, or a finishing tick). */
  nextAlreadyOpen?: boolean
}): string
export declare const STEP_NOT_OPENED_SUBJECT: string
export declare const LAST_STEP_SKIP_NOTE: string
export declare const SKIP_MODE_WHOLE_LABEL: string
export declare const SKIP_MODE_STEP_LABEL: string
export declare const SKIP_MODE_ONE_STEP_NOTE: string
export declare function skipReasonThirdPerson(value: string | null | undefined): string

/** What a step skip leaves on the next step (`checklists.skip_notice`). */
export interface SkipNotice {
  skippedBy: string | null
  skippedByName: string | null
  /** The SKIPPED stage's 0-based index. */
  stageIndex: number
  stageName: string
  reasonCategory: string | null
  note: string
  at: string | null
  /** The checklist_skips record id. */
  skipId: string | null
  /** Push a step (featreq-78f09571): set on a PUSHED step's notice; absent on a skip's. */
  kind?: 'push'
  /** The date the step was pushed to (`yyyy-mm-dd`), on a push's notice. */
  newDueDate?: string | null
}

export declare function buildSkipNotice(args: {
  checklist: StagedChecklist
  stageName?: string
  skippedBy?: string | null
  skippedByName?: string | null
  reasonCategory?: string | null
  note?: string
  at?: string | null
  skipId?: string | null
}): SkipNotice
export declare function skipNoticeLine(notice: Partial<SkipNotice> | null | undefined): string
export declare function skipNoticeChip(notice: Partial<SkipNotice> | null | undefined): string
export declare function buildPushNotice(args: {
  checklist: StagedChecklist
  stageName?: string
  pushedBy?: string | null
  pushedByName?: string | null
  reasonCategory?: string | null
  note?: string
  at?: string | null
  skipId?: string | null
  newDueDate?: string | null
}): SkipNotice
export declare function isPushNotice(notice: Partial<SkipNotice> | null | undefined): boolean
export declare function stepSkipReviewLine(args: {
  skip: { id?: string; stepSkip?: boolean; kind?: string } | null | undefined
  checklists?: Array<{
    assigneeId?: string
    stageCount?: number
    skipNotice?: Partial<SkipNotice> | null
  }>
  employees?: Array<{ id?: string; name?: string }>
}): string
export declare function stepSkippedMessage(args: {
  skipperName: string
  stageIndex: number
  stageCount: number
  stageName?: string
  clientName?: string
  recipeTitle: string
  reasonCategory: string
  note: string
  /** The next step was already open: "Your step N was already open." */
  alreadyOpen?: boolean
}): string
export declare function stepPushedMessage(args: {
  pusherName: string
  stageIndex: number
  stageCount: number
  stageName?: string
  clientName?: string
  recipeTitle: string
  reasonCategory: string
  note: string
  newDueDate?: string | null
  alreadyOpen?: boolean
}): string
export declare function stepPushNotOpenedMessage(args: {
  pusherName: string
  stageIndex: number
  stageCount: number
  stageName?: string
  clientName?: string
  recipeTitle: string
  newDueDate?: string | null
  why: string
}): string
export declare function stepNotOpenedMessage(args: {
  skipperName: string
  stageIndex: number
  stageCount: number
  stageName?: string
  clientName?: string
  recipeTitle: string
  why: string
}): string

/**
 * Every task the viewer can edit, one-offs included — NOT gated by the
 * template's `skipAllowed`. `templates` is accepted and ignored so callers that
 * pass the same argument object to both gates still type-check.
 */
export declare function canOfferPush(args: {
  checklist:
    | { templateId?: string; skippedAt?: string | null; pushedToChecklistId?: string | null }
    | null
    | undefined
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
