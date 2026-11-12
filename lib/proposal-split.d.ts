/**
 * Types for the plain-JS `lib/proposal-split.js` (splitting a proposal into
 * parts, featreq-23b26bb1). Keep in sync with its exports.
 */

type SplitSelection = { serviceId: string }
type SplitProposalLike = {
  id: string
  status: string
  selections: readonly SplitSelection[]
  splitFromId?: string | null
  createdAt?: string | null
}
type SplitTotals = Partial<Record<'monthly' | 'annual' | 'oneTime' | 'cleanup' | 'software', number>>
type SplitLine = { group?: string | null; cadence?: string | null; amount?: number | null }

export const SPLIT_STATUSES: readonly string[]
export const SPLIT_PICK_ONE: string
export const SPLIT_LEAVE_ONE: string
export const SPLIT_LINE_GONE: string
export const SPLIT_CHANGED: string
export const SPLIT_SIGN_FIRST: string

export function canSplitProposal(
  proposal: { status: string; selections: readonly unknown[] } | null | undefined,
): boolean

export function splitSelections<T extends SplitSelection>(
  selections: readonly T[] | null | undefined,
  moveIds: readonly string[] | null | undefined,
): { move: T[]; stay: T[]; unknown: string[] }

export function splitRefusal(input: {
  status: string
  selections: readonly SplitSelection[] | null | undefined
  moveIds: readonly string[] | null | undefined
  statusWords?: string | null
}): string | null

export function splitFamily<T extends { id: string; splitFromId?: string | null; createdAt?: string | null }>(
  proposals: readonly T[] | null | undefined,
  id: string,
): T[]

export function splitSiblings<T extends { id: string; splitFromId?: string | null; createdAt?: string | null }>(
  proposals: readonly T[] | null | undefined,
  id: string,
): T[]

export function splitPartIds(
  proposals: readonly { id: string; splitFromId?: string | null }[] | null | undefined,
): Set<string>

export function splitTotalsWords(totals: SplitTotals | null | undefined): string

export function splitPartWords(
  proposal:
    | { pricingSnapshot?: { lines?: readonly unknown[]; totals?: SplitTotals } | null }
    | null
    | undefined,
): string

export function splitLineTotals(
  lines: readonly SplitLine[] | null | undefined,
): Record<'monthly' | 'annual' | 'oneTime' | 'cleanup' | 'software', number>

export function splitClientRefusal(clientName?: string | null): string

export const SPLIT_DRAFT_FIRST: string

export function splitSignRefusal(clientName?: string | null, options?: { tied?: boolean }): string

export type { SplitProposalLike }
