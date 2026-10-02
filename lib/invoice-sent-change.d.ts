/**
 * Types for `lib/invoice-sent-change.js`: did an edit change anything the client
 * would read. Plain JS so `db/store.js` can import it; the declarations let the
 * month run ask the same question without a second TypeScript copy.
 */

/** The `changes` an `invoice_review_events` row carries; only these two matter. */
export interface InvoiceEditChanges {
  lineItems?: { before?: unknown; after?: unknown }
  blurb?: { before?: unknown; after?: unknown }
}

export declare function editChangesWhatClientSees(
  changes: InvoiceEditChanges | null | undefined,
): boolean

/** Did the lines, the note or the total move between two reads of one invoice? */
export declare function invoiceContentChanged(
  before: { lineItems?: unknown; blurb?: unknown; total?: unknown } | null | undefined,
  after: { lineItems?: unknown; blurb?: unknown; total?: unknown } | null | undefined,
): boolean

/** Whole cents, so two totals that differ by float dust are the same total. */
export declare function totalsDiffer(before: unknown, after: unknown): boolean
