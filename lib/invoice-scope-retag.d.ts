/**
 * Types for the scope re-tag rule. Implementation is plain JS so the server and
 * the store can import it; this lets the React side use it too.
 */

import type { AdhocMode } from './invoice-lines'

/** The three things one piece of time can be, as the invoicing panel words them. */
export type ScopeTag = 'in-scope' | 'out-of-scope' | 'adhoc'

export const SCOPE_TAGS: readonly ScopeTag[]

/** What one entry is tagged as right now, read off its own two booleans. */
export function scopeTagOfEntry(entry: {
  billable?: boolean
  isAdhoc?: boolean
} | null | undefined): ScopeTag

/** The entry flags one tag means — the one place the tag becomes the booleans. */
export function entryFlagsForScopeTag(tag: string): { billable: boolean; isAdhoc: boolean }

export function isScopeTag(value: unknown): value is ScopeTag

/** One staged decision: the tag, plus what to do with it when it is ad hoc. */
export type ScopeTagEdit = { tag: ScopeTag; adhocMode?: AdhocMode }

/** Staged decisions, keyed by time entry id. */
export type ScopeTagEdits = Record<string, ScopeTagEdit>

/** One time entry as every function here reads it. */
type ScopeEntry = {
  id: string
  employeeId: string
  clientId: string
  date: string
  minutes: number
  description?: string
  billable?: boolean
  isAdhoc?: boolean
}

type ScopeEmployee = { id: string; name?: string; role?: string; billRate?: number | null }

type ScopeClient = {
  id?: string
  billingMode?: string
  isBillingMaster?: boolean
  hourlyRate?: number
} | null

/** Can re-tagging move money on this invoice at all? */
export function scopeRetagApplies(client: ScopeClient, period: string): boolean

/**
 * What each entry's own ad hoc line already says, keyed by entry id — matched
 * by `entryId` first, then by the label+detail an un-stamped draft carries.
 */
export function savedAdhocModesForEntries(args: {
  lines?: Array<{ kind?: string; label?: string; detail?: string; adhocMode?: string }>
  entries?: ScopeEntry[]
  employees?: ScopeEmployee[]
  client?: ScopeClient
  defaultHourlyRate?: number
}): Record<string, AdhocMode>

/**
 * Entry ids whose ALREADY SAVED tag the invoice's lines do not carry — the
 * warning that has to outlive the save, because a blocked tag saves anyway and
 * the line on the other side of it is still unadjusted.
 */
export function unaccountedScopeEntries(args: {
  lines?: Array<{ kind?: string; label?: string; detail?: string; hours?: number; rate?: number }>
  entries?: ScopeEntry[]
  employees?: ScopeEmployee[]
  client?: ScopeClient
  period?: string
  defaultHourlyRate?: number
}): string[]

/**
 * Generic in the LINE type for the same reason `renderedInvoiceLines` is: the
 * editor hands it `PersistedInvoiceLine[]` and the server hands it plain
 * generated lines, and both get their own type back rather than a cast.
 */
export function applyScopeRetag<
  T extends { kind?: string; label?: string; detail?: string; amount?: number },
>(args: {
  lines?: T[]
  entries?: Array<{
    id: string
    employeeId: string
    clientId: string
    date: string
    minutes: number
    description?: string
    billable?: boolean
    isAdhoc?: boolean
  }>
  tagEdits?: ScopeTagEdits
  employees?: Array<{
    id: string
    name?: string
    role?: string
    billRate?: number | null
  }>
  client?: {
    id?: string
    billingMode?: string
    isBillingMaster?: boolean
    hourlyRate?: number
  } | null
  period?: string
  defaultHourlyRate?: number
}): {
  lines: T[]
  /** False on subscription / annual / pre-cutover invoices — lines untouched. */
  applicable: boolean
  changed: boolean
  /**
   * Entry ids whose re-tag these lines cannot carry: the hours could not be
   * taken off the line they are currently billed on, so nothing was added
   * either. Almost always a retyped hourly line with no hours or rate on it —
   * the common shape in production. The tag is still hers to set; the invoice
   * line has to be adjusted by hand.
   */
  blocked: string[]
}
