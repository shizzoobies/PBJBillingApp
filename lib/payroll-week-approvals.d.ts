/** Types for the plain-JS `lib/payroll-week-approvals.js` (Payroll review ship 2). Keep in sync with its exports. */

import type { CheckEntry, PayrollFlag } from './payroll-week-checks.js'

export type TickableFlagKind =
  | 'manual'
  | 'overlap'
  | 'possible_duplicate'
  | 'typed_hours'
  | 'block_parts'
  | 'long_entry'
  | 'changed'
export declare const TICKABLE_FLAG_KINDS: TickableFlagKind[]
export type PartnerFlagKind = 'overlap' | 'possible_duplicate'
export declare const PARTNER_FLAG_KINDS: PartnerFlagKind[]
export type MarkPartners = Partial<Record<PartnerFlagKind, string[]>>
export type SignatureFields = {
  person: string
  date: string
  seconds: number
  client: string
  administrative: boolean
  stretches: Array<[number, number]>
  group: string
}
export declare function normalizePartners(raw: unknown): MarkPartners
export declare function normalizeFields(raw: unknown): SignatureFields | null
export type MarkKind = 'ok' | 'sent_back'
export declare const MARK_KINDS: MarkKind[]
export declare const PAYROLL_NOTE_MAX: number
export declare const ENTRY_CHANGED_MESSAGE: string

export type EntryMark = {
  kind: MarkKind
  by: string
  byName: string
  at: string
  note: string
  signature: string
  flags: TickableFlagKind[]
  fields?: SignatureFields
  partners?: MarkPartners
}

export type SignatureEntry = CheckEntry & { groupAllocation?: string; billable?: boolean; approvedAt?: string }

export declare function signatureFields(entry: SignatureEntry): SignatureFields
export declare function entrySignature(entry: SignatureEntry): string
export declare function isSignature(value: unknown): value is string
export declare function markIsCurrent(mark: EntryMark | null | undefined, entry: SignatureEntry | null | undefined): boolean
export declare function normalizeMark(raw: unknown): EntryMark | null
export declare function normalizeMarks(raw: unknown): Record<string, EntryMark>
export declare function normalizeNote(value: unknown): { ok: true; value: string } | { ok: false; error: string }
export declare function isWeekStart(value: unknown): boolean

type Refusal = { ok: false; error: string; status?: number }
export declare function normalizeMarkInput(
  body: unknown,
): { ok: true; value: { entryId: string; remove: boolean; signature?: string; flags?: TickableFlagKind[]; partners?: MarkPartners } } | Refusal
export declare function normalizeSendBackInput(
  body: unknown,
): { ok: true; value: { entryId: string; signature: string; note: string } } | Refusal
export declare function normalizeDenyInput(
  body: unknown,
): { ok: true; value: { entryId: string; signatures: Record<string, string>; note: string } } | Refusal
export declare function normalizeUndoInput(
  body: unknown,
): { ok: true; value: { userId: string; weekStart: string; denialId: string } } | Refusal

export declare function payrollHoursOf(entries: ReadonlyArray<{ id: string; minutes: number; groupId?: string; groupAllocation?: string }>): number

/** The app-shaped facts of one denied entry, as the page lists it. */
export type DenialPart = {
  id: string
  employeeId: string
  date: string
  clientId: string
  isAdministrative: boolean
  taskId: string | null
  taskLabel?: string
  description: string
  minutes: number
  groupId?: string
  groupAllocation?: string
  billable: boolean
  startAt?: string
  endAt?: string
  sessions?: Array<{ startAt: string; endAt: string }>
}
export declare function denialPart(entry: SignatureEntry): DenialPart

export declare function dayText(date: string): string
export declare function weekdayDayText(date: string): string
export declare function instantDayText(iso: string | undefined): string

type MessagePart = { date: string; job: string; task: string }
export declare function deniedMessage(args: { ownerName: string; hours: number; parts: MessagePart[]; note: string }): string
export declare function noteInSentence(note: string): string
export declare function sentBackMessage(args: { ownerName: string; hours: number; parts: MessagePart[]; note: string }): string
export declare function changeWords(
  before: SignatureFields | undefined,
  entry: SignatureEntry,
  options?: { clientName?: (id: string) => string; personName?: (id: string) => string },
): string[]
export declare function restoredMessage(args: { ownerName: string; hours: number; parts: MessagePart[] }): string
export declare const UNSENT_INVOICE_STATUSES: string[]
export type InvoicedFact = { clientId: string; invoiceClientId: string; period: string; carriedTo?: string; status: string; sent: boolean }
export declare function weekInvoiceMonths(weekStart: string): string[]
export declare function invoicedFacts(
  evidence: ReadonlyArray<{
    clientId: string | null
    period: string | null
    kind: string
    status: string | null
    sourceClientIds: string[]
    rolledIntoPeriod?: string | null
  }>,
  weekStart: string,
): InvoicedFact[]
export declare function denialAuditTarget(args: { userId: string; weekStart: string; hours: number; entryIds: string[] }): string

/** A flag after her marks: `seen` = covered by a current OK tick (not counted). */
export type MarkedFlag = Omit<PayrollFlag, 'tier' | 'kind'> & {
  kind: PayrollFlag['kind'] | 'changed' | 'ok_changed'
  tier: PayrollFlag['tier'] | 'seen'
  seenBy?: string
}
export declare function applyEntryMarks(
  flags: readonly PayrollFlag[],
  options?: {
    entry?: SignatureEntry
    mark?: EntryMark | null
    personName?: string
    partners?: MarkPartners
    clientName?: (id: string) => string
    personNameOf?: (id: string) => string
  },
): { flags: MarkedFlag[]; ok: 'current' | 'changed' | null; tickable: TickableFlagKind[] }
