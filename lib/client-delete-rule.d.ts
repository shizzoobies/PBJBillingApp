/**
 * Types for the shared "may this client be deleted?" rule. Same convention as
 * `checklist-write-permission.d.ts` - the implementation is plain JS so the
 * server can import it directly, and this file lets the React side use it too.
 */

export const CLIENT_HAS_TIME_REASON: string
export const CLIENT_HAS_INVOICES_REASON: string
export const CLIENT_HAS_TIME_REASON_RETIRED: string
export const CLIENT_HAS_INVOICES_REASON_RETIRED: string

export type ClientHistoryCounts = {
  timeEntryCount?: number
  invoiceCount?: number
}

export type ClientDeleteVerdict =
  | { deletable: true; reason: null; retiredReason: null }
  | { deletable: false; reason: string; retiredReason: string }

export function clientDeleteVerdict(counts?: ClientHistoryCounts): ClientDeleteVerdict

export function clientHistoryRefusal(
  name: string,
  history: { hasTime: boolean; hasInvoices: boolean },
): string
