/** Types for the plain-JS `lib/payroll-week-checks.js` (the weekly payroll review's rules). Keep in sync with its exports. */

export declare const PAY_PERIOD_ANCHOR: string
export declare const LONG_ENTRY_HOURS: number
export declare const LONG_DAY_HOURS: number
export declare const OVERLAP_TOLERANCE_MINUTES: number

export declare function addDaysIso(date: string, days: number): string
export declare function sundayOf(date: string): string
export declare function weekDates(weekStart: string): string[]
export declare function lastCompletedWeekStart(today: string): string

export type PayPeriod = {
  start: string
  end: string
  weekNumber: 1 | 2
  weekStarts: [string, string]
}
export declare function payPeriodOf(date: string): PayPeriod

/** The entry fields these rules read. Structural so tests can pass literals. */
export type CheckEntry = {
  id: string
  employeeId: string
  date?: string
  minutes: number
  clientId?: string | null
  isAdministrative?: boolean
  taskId?: string | null
  taskLabel?: string
  description?: string
  groupId?: string
  entryMethod?: 'timer' | 'manual'
  approvalStatus?: string
  approvalNote?: string
  startAt?: string
  endAt?: string
  sessions?: ReadonlyArray<{ startAt: string; endAt: string }>
}

export type Stretch = { startAt: string; endAt: string; startMs: number; endMs: number }
export declare function stretchesOf(entry: CheckEntry): Stretch[]

export type OverlapHit = { otherId: string; startAt: string; endAt: string; minutes: number }
export declare function findOverlaps(entries: readonly CheckEntry[]): Map<string, OverlapHit[]>

export type LoggedTwiceHit = { otherId: string; rule: 'same_start' | 'same_hours'; startAt?: string }
export declare function findLoggedTwice(entries: readonly CheckEntry[]): Map<string, LoggedTwiceHit[]>

export type EntryFlagKind =
  | 'manual'
  | 'overlap'
  | 'possible_duplicate'
  | 'typed_hours'
  | 'block_parts'
  | 'sent_back'
  | 'long_entry'
  | 'clock_edited'
  | 'not_approved'
export type FlagKind = EntryFlagKind | 'long_day'
/** 'look' = NEEDS A LOOK (a counted chip); 'note' = plain text on the row, never counted. */
export type FlagTier = 'look' | 'note'
export type PayrollFlag = { kind: FlagKind; tier: FlagTier; label: string; sentence: string }

export declare const FLAG_TIERS: Record<FlagKind, FlagTier>
export declare const ENTRY_FLAG_KINDS: EntryFlagKind[]
export declare const FLAG_LABELS: Record<FlagKind, string>
export declare const CLOCK_EDITED_SENTENCE: string
export declare const MANUAL_SENTENCE: string
export declare const NOT_APPROVED_SENTENCE: string
export declare function formatMinutes(minutes: number): string
export declare function formatOverlap(minutes: number): string

export declare function entryFlags<E extends CheckEntry>(
  entries: readonly E[],
  options?: {
    factsOf?: (entry: E) => { logged?: string; mismatchNote?: string; typedHours?: boolean }
    nameOf?: (entry: E) => string
    formatTime?: (iso: string) => string
    others?: readonly E[]
  },
): Map<string, PayrollFlag[]>

export declare function lookFlags(flags: readonly PayrollFlag[] | undefined): PayrollFlag[]
export declare function dayFlags(dayHours: number): PayrollFlag[]
