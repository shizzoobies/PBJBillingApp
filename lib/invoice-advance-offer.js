import { cardProcessingFee } from './invoice-lines.js'

// A zero-value document attachment, never a service charge or a received credit.
export function invoiceAdvanceOffer(invoice) {
  return (invoice?.lineItems ?? invoice?.lines ?? []).find((line) => line.kind === 'advance_request')?.advanceOffer ?? null
}

/** How the attached advance is collected. Offers saved before the choice existed are 'separate'. */
export function advanceOfferCollection(offer) {
  return offer?.collection === 'invoice' ? 'invoice' : 'separate'
}

const money = (cents) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

/**
 * The client-facing words for the advance section. ONE source for the email,
 * the PDF and the in-app preview, keyed on what the documents actually carry:
 *  - `carried`: this document's payment link really carries the advance (a
 *    link exists AND the live `invoiceCheckoutAdvance` answer was non-null when
 *    it was built). Only then does it say "included in this invoice's payment
 *    link". False (no link: paid by credit, autopay, Stripe off; or the request
 *    is canceled, received, or already being collected) falls back to the
 *    advance page, worded by the request's payment method. Undefined (the
 *    in-app view, which cannot know) describes the attached choice.
 *  - `autopay`: this invoice is charged automatically, never with the advance.
 *  - `card`: the client is offered the card link, which never carries an
 *    OPTIONAL advance.
 *  - `settlement`: the PAID copy after a payment of this invoice:
 *    `{ advanceCents, pending }` says what that payment brought toward the advance.
 */
export function advanceOfferText(invoice, { carried, autopay = false, card = false, settlement = null } = {}) {
  const offer = invoiceAdvanceOffer(invoice)
  if (!offer) return []
  const head = ['Pay in advance amount', `${offer.optional ? 'Optional advance' : 'Agreed advance requested'}: ${money(offer.requestedCents)} (${offer.number})`,
    `Advance received when this section was prepared: ${money(offer.receivedCents)}`,
    `Advance still requested at preparation: ${money(offer.outstandingCents)}`]
  const chargesOnly = 'The invoice total above is for current charges only. The advance becomes credit on account once it is received.'
  const onPage = offer.collectionMethod === 'bank'
    ? 'Pay the advance from the advance request page below; it shows the current remaining amount.'
    : 'To pay the advance, contact the firm; the advance request page below shows the current remaining amount.'
  let how
  if (advanceOfferCollection(offer) === 'separate') {
    how = ['This advance is separate from the current invoice total. Pay current charges using the invoice payment option; pay the advance separately. Only funds actually received become credit on account.']
  } else if (settlement) {
    how = settlement.advanceCents > 0
      ? [settlement.pending
          ? `This payment includes ${money(settlement.advanceCents)} toward the advance. It becomes credit on account once the bank payment settles.`
          : `Received with this payment toward the advance: ${money(settlement.advanceCents)}. It is now credit on account.`]
      : ['The advance was not included in this payment. The advance request page below shows what remains.']
  } else if (carried ?? !autopay) {
    how = [`This advance is included in this invoice's payment link: pay current charges and the advance together in one payment.${offer.optional ? ' You may remove the advance on the payment page.' : ''}${offer.optional && card ? ' The card payment option covers current charges only.' : ''}`, chargesOnly]
  } else {
    how = [...(autopay ? ['This advance is not charged automatically with this invoice.'] : []), onPage, chargesOnly]
  }
  return [...head, ...how,
    offer.forPeriod ? `Credit is reserved for ${offer.forPeriod} or later invoices.` : 'Received advance credit is drawn down by future invoices.',
    `Advance request and current remaining amount: ${offer.url}`,
    'Voiding this service invoice does not cancel the advance request or reverse received funds.']
}

/**
 * The advance a payment link on `channel` carries, or null. The card link never
 * carries an OPTIONAL advance: Stripe cannot make the fee line follow the
 * payer removing the advance line.
 * @param {{requestId: string, number: string, cents: number, optional: boolean}|null} advance
 */
export function linkAdvanceFor(advance, channel) {
  if (!advance || !Number.isSafeInteger(advance.cents) || advance.cents <= 0) return null
  if (channel === 'card' && advance.optional) return null
  return advance
}

/**
 * What one payment link collects, in cents: the invoice, the advance it carries
 * and (card) the processing fee, worked on invoice + advance so the firm nets
 * both. The same numbers the Checkout session is built from.
 */
export function advancePaymentSummary({ total, advance = null, channel = 'ach' }) {
  const invoiceCents = Math.round((Number(total) || 0) * 100)
  const carried = linkAdvanceFor(advance, channel)
  const advanceCents = carried ? carried.cents : 0
  const feeCents = channel === 'card' ? Math.round(cardProcessingFee((invoiceCents + advanceCents) / 100) * 100) : 0
  return { invoiceCents, advanceCents, feeCents, totalCents: invoiceCents + advanceCents + feeCents, advance: carried }
}

/** The rows a payer is shown before paying: [label, formatted amount]. Empty when no advance is carried. */
export function advancePaymentRows(summary) {
  if (!summary?.advance) return []
  return [['Invoice amount', money(summary.invoiceCents)],
    [`Advance payment ${summary.advance.number}${summary.advance.optional ? ' (optional)' : ''}`, money(summary.advanceCents)],
    ...(summary.feeCents > 0 ? [['Processing fee', money(summary.feeCents)]] : []),
    ['Total to pay', money(summary.totalCents)]]
}
