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
