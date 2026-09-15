/**
 * Types for the plain-JS `lib/invoice-draft.js`, so `src/` can print a terms
 * line by the same rule the PDF does instead of keeping a second copy of it.
 *
 * Only the payment-window half of the module is declared. The draft builders
 * themselves (`buildInvoiceDraft`, `buildConsolidatedInvoiceDraft`, the
 * numbering) are server-side money code that nothing in `src/` calls — add
 * their types here if that ever changes, rather than importing them untyped.
 */

/** Days from issue to due, unless a client's own terms are longer. */
export declare const DEFAULT_PAYMENT_WINDOW_DAYS: number

/**
 * The terms line to PRINT beside an invoice's due date: the client's own
 * wording when it parses to a `Net N` at or beyond `windowDays`, and
 * `Net <windowDays>` for everything else.
 */
export declare function paymentTermsLabel(
  terms?: string | null,
  windowDays?: number,
): string
