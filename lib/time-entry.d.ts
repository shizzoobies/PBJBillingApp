/**
 * Types for the plain-JS `lib/time-entry.js`, so `src/` can import the shared
 * weekly-submission rules instead of keeping a second TypeScript copy that
 * drifts away from the server's.
 *
 * This matters most for `listBlockingWeeks`: the server uses it to decide which
 * prior weeks gate new time, and the guided submit flow
 * (`src/lib/timesheetSubmitPlan.ts`) uses the SAME call to decide which prior
 * weeks to walk the user through. One definition, so the prompt can never name
 * a week the gate considers settled (or stay silent about one it doesn't).
 *
 * Keep the shapes here in sync with the actual exports in lib/time-entry.js.
 */

/** Why a prior week still needs the user's attention. */
export type BlockingWeekReason = 'unsubmitted' | 'rejected'

export interface BlockingWeek {
  /** Sunday-anchored week start ('YYYY-MM-DD'). */
  weekStart: string
  reason: BlockingWeekReason
}

export declare function normalizeTimeEntryMethod(payload?: {
  entryMethod?: unknown
  manualReason?: unknown
}): {
  entryMethod: 'timer' | 'manual'
  manualReason: string | undefined
  error: string | null
}

/** The three fields a human must fill in before time can be logged. */
export type TimeEntryRequiredField = 'client' | 'task' | 'detail'

/** Field-level prompts, so each one renders under the field it belongs to. */
export declare const TIME_ENTRY_FIELD_PROMPTS: Record<TimeEntryRequiredField, string>

export declare function validateTimeEntryRequiredFields(input?: {
  isAdministrative?: unknown
  clientId?: unknown
  groupClientIds?: unknown
  groupId?: unknown
  taskId?: unknown
  taskLabel?: unknown
  description?: unknown
}): { missing: TimeEntryRequiredField[]; error: string | null }

export declare function validateTimeEntryEdit(
  entry?: { description?: unknown },
  // The whole PATCH body: only `description` is inspected, but any other field
  // may ride along (that IS the case being allowed — editing everything else).
  payload?: ({ description?: unknown } & Record<string, unknown>) | null,
): { error: string | null }

/**
 * What `isAdhoc` becomes on an edit, or `undefined` for "leave it alone".
 * Takes the admin state AFTER the re-target — see the implementation for why
 * the ordering is the point.
 */
export declare function adhocAfterEntryEdit(args: {
  // The whole PATCH body: only `isAdhoc` is inspected, but the rest rides along
  // — the same shape `validateTimeEntryEdit` takes, and for the same reason.
  payload?: ({ isAdhoc?: unknown } & Record<string, unknown>) | null
  effectiveIsAdministrative: boolean
  becameAdministrative?: boolean
}): boolean | undefined

/**
 * Whether an edit costs the entry its approval. See the implementation for the
 * one exemption: an owner changing nothing but the ad hoc flag.
 */
export declare function editRequiresReapproval(
  approvalStatus: string,
  patch?: Record<string, unknown>,
  isOwner?: boolean,
): boolean

export declare function normalizeWorkSessions(rawSessions?: unknown): {
  sessions?: { startAt: string; endAt: string }[]
  minutes?: number
  startAt?: string
  endAt?: string
  error?: string | null
}

/** The Sunday ('YYYY-MM-DD') that anchors the Sun–Sat week containing `dateStr`. */
export declare function weekStartOf(dateStr: string): string

/**
 * `todayWeekStart` is REQUIRED (and so `lockedPeriods` can no longer be
 * elided): the weekly gate only fires for an entry in the current week or
 * later, and a caller that forgets today's week would silently gate past-week
 * backfills again. Missing it is a compile error here and a throw at runtime.
 */
export declare function findBlockingWeek(
  entryWeekStart: string,
  priorWeekStarts: Iterable<string>,
  submissions: ReadonlyArray<{ weekStart: string; status: string }>,
  lockedPeriods: Iterable<string> | undefined,
  todayWeekStart: string,
): BlockingWeek | null

/** Every prior week that must be (re)submitted, oldest → newest. */
export declare function listBlockingWeeks(
  entryWeekStart: string,
  priorWeekStarts: Iterable<string>,
  submissions: ReadonlyArray<{ weekStart: string; status: string }>,
  lockedPeriods: Iterable<string> | undefined,
  todayWeekStart: string,
): BlockingWeek[]
