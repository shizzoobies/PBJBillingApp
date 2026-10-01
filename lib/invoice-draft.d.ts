/**
 * Types for the plain-JS `lib/invoice-draft.js`, so `src/` can print a terms
 * line by the same rule the PDF does instead of keeping a second copy of it.
 *
 * Only the payment-window half of the module is declared. The draft builders
 * themselves (`buildInvoiceDraft`, `buildConsolidatedInvoiceDraft`, the
 * numbering) are server-side money code that nothing in `src/` calls — add
 * their types here if that ever changes, rather than importing them untyped.
 */

/**
 * Days from issue to the firm's INTERNAL past-due line, unless a client's own
 * terms are longer. Not what the client is told — see `paymentTermsLabel`.
 */
export declare const DEFAULT_PAYMENT_WINDOW_DAYS: number

/** What the customer is told when their record names no window of its own. */
export declare const DUE_ON_RECEIPT_LABEL: string

/** The `Net N` a client's free-text terms name, or null when they name none. */
export declare function parsedNetDays(terms?: string | null): number | null

/**
 * The window the CUSTOMER is held to, or null when they are asked to pay on
 * receipt. Only a `Net N` at or beyond `windowDays` counts.
 */
export declare function customerNetDays(
  terms?: string | null,
  windowDays?: number,
): number | null

/**
 * The terms line to PRINT on the client's invoice: their own wording when it
 * names a longer window, and "Due on receipt" for everything else.
 */
export declare function paymentTermsLabel(
  terms?: string | null,
  windowDays?: number,
): string

/** First billing month the period-end invoice date applies to. */
export declare const PERIOD_END_INVOICE_DATE_FROM: string

/**
 * The date PRINTED on an invoice (YYYY-MM-DD), or null when it has none: the
 * issue day, except a monthly invoice from September 2026 on prints the last
 * day of its billing month when that day is earlier than the issue day.
 */
export declare function invoiceDisplayDate(invoice?: {
  period?: string | null
  kind?: string | null
  sentAt?: string | null
  createdAt?: string | null
}): string | null
