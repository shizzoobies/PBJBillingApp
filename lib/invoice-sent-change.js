/**
 * Did an edit change anything the CLIENT would read on the invoice?
 *
 * Asked about the `changes` an `invoice_review_events` row carries (see
 * `buildInvoiceChangeDiff` in db/store.js) when the question is "has this
 * invoice been changed since it was sent". An edit counts when it moves the note
 * to the client or any line the client's copy prints, and so, because the total
 * is the sum of those lines, when it moves the total.
 *
 * What does NOT count: the due date (the client's copy says "due on receipt"),
 * the review status, and the fields on a line that only the app reads (the
 * "confirm the dates" flags, which expense it came from, which time entry it
 * names). The covered DATES themselves do count.
 * Saving an invoice with a different internal flag must not tell her to send it
 * again.
 *
 * PURE: no clock, no store.
 */

import { renderedInvoiceLines, withoutEmptyLines } from './invoice-lines.js'

/**
 * The line fields that print on the client's copy. `rateManual` (she typed the
 * rate) and `employeeId` (whose hours the line holds) are the app's own
 * bookkeeping: stamping or changing them alone is not a change the client sees.
 */
const CLIENT_VISIBLE_LINE_FIELDS = [
  'kind',
  'label',
  'detail',
  'amount',
  'hours',
  'rate',
  'roleTier',
  // Moving a line between "Client Reimbursed Expenses" and "Software" changes
  // the heading the client reads it under.
  'section',
  // The dates are in the label the client reads; moving them is a change even
  // when she has typed a label of her own that does not repeat them.
  'coverageStart',
  'coverageEnd',
]

/**
 * The lines as the client's copy prints them, reduced to the fields it prints.
 * A line left off the client's copy (an omitted ad hoc line, a $0 plan line, an
 * hours row with no hours) is not in the answer, so adding or removing one is not
 * a change. The filter is `withoutEmptyLines`, the one the client's copy itself
 * applies (`clientFacingInvoiceLines`), not a copy of it.
 */
function clientVisibleLines(lines) {
  return withoutEmptyLines(renderedInvoiceLines(lines)).map((line) =>
    CLIENT_VISIBLE_LINE_FIELDS.map((field) => line?.[field] ?? null),
  )
}

/**
 * @param {{ lineItems?: { before?: unknown, after?: unknown }, blurb?: { before?: unknown, after?: unknown } } | null | undefined} changes
 * @returns {boolean}
 */
export function editChangesWhatClientSees(changes) {
  if (!changes || typeof changes !== 'object') return false
  if (changes.blurb && String(changes.blurb.before ?? '') !== String(changes.blurb.after ?? '')) {
    return true
  }
  if (changes.lineItems) {
    return (
      JSON.stringify(clientVisibleLines(changes.lineItems.before)) !==
      JSON.stringify(clientVisibleLines(changes.lineItems.after))
    )
  }
  return false
}

/**
 * Has the invoice moved between two reads of it, in a way the client would see?
 * The send route asks this of the invoice it BUILT the email from and the one it
 * re-reads just before sending: the lines, the note, or the total.
 *
 * @param {{lineItems?: unknown, blurb?: unknown, total?: unknown} | null | undefined} before
 * @param {{lineItems?: unknown, blurb?: unknown, total?: unknown} | null | undefined} after
 */
export function invoiceContentChanged(before, after) {
  return (
    totalsDiffer(before?.total, after?.total) ||
    editChangesWhatClientSees({
      lineItems: { before: before?.lineItems, after: after?.lineItems },
      blurb: { before: before?.blurb, after: after?.blurb },
    })
  )
}

/**
 * Whole cents, so two totals that differ by float dust are the same total.
 * The one comparison the route's session expiry and the store's tag share.
 */
export function totalsDiffer(before, after) {
  return Math.round((Number(before) || 0) * 100) !== Math.round((Number(after) || 0) * 100)
}
