/**
 * Types for the shared past-due / payment-failure rules. The implementation is
 * plain JS so `server.js` can import it; these declarations let `src/` use the
 * same functions without a second TypeScript copy drifting away from it.
 *
 * The entry shapes below mirror `src/lib/types.ts`'s `InvoiceEmailLogEntry`
 * union deliberately loosely (the `lib/invoice-lines.d.ts` convention): a
 * `PersistedInvoice` from the app satisfies them structurally, and so does a
 * row the server read straight out of the store.
 */

/** One email we tried to send about an invoice. An untagged one IS the send. */
export interface InvoiceSendLogEntry {
  at: string
  to: string[]
  subject: string
  ok: boolean
  total?: number
  error?: string
  kind?: 'ack' | 'receipt' | 'link'
  providerId?: string | null
}

/** What the mail provider did with one of those sends. */
export interface InvoiceDeliveryLogEntry {
  kind: 'delivery'
  event: string
  at: string
  providerId: string | null
  to: string[]
  detail?: string
}

/** A client's payment attempt that failed, written by the Stripe webhook. */
export interface InvoicePaymentFailureLogEntry {
  kind: 'payment'
  event: 'failed'
  at: string
  paymentIntentId: string | null
  detail?: string
}

/** The owner was told once that this invoice passed its past-due line. */
export interface InvoicePastDueLogEntry {
  kind: 'past-due'
  event: 'noticed'
  at: string
  dueDate: string | null
}

export type InvoiceLogEntry =
  | InvoiceSendLogEntry
  | InvoiceDeliveryLogEntry
  | InvoicePaymentFailureLogEntry
  | InvoicePastDueLogEntry

/** Everything these rules read off an invoice, and nothing more. */
export interface InvoiceSignalSource {
  status?: string
  dueDate?: string | null
  emailLog?: InvoiceLogEntry[]
}

/** How far past the line, and which line. */
export interface PastDueInvoice {
  /** The stored due date it passed, YYYY-MM-DD. */
  dueDate: string
  /** Whole days from that date to the "today" the caller supplied. Always > 0. */
  daysPastDue: number
}

export declare function latestInvoiceSend(
  emailLog: InvoiceLogEntry[] | undefined,
): InvoiceSendLogEntry | null

export declare function unresolvedPaymentFailure(
  invoice: InvoiceSignalSource | null | undefined,
): InvoicePaymentFailureLogEntry | null

/** `todayDateOnly` is YYYY-MM-DD: the SPA's `localDateOnly()`, the server's `todayIso()`. */
export declare function pastDueInvoice(
  invoice: InvoiceSignalSource | null | undefined,
  todayDateOnly: string,
): PastDueInvoice | null

export declare function daysPastDueLabel(days: number): string
