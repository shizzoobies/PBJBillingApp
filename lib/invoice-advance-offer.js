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
 * the PDF and the in-app preview. `autopay`: this invoice is charged
 * automatically (the charge never includes the advance). `card`: the client
 * is offered the card link (which never carries an OPTIONAL advance).
 */
export function advanceOfferText(invoice, { autopay = false, card = false } = {}) {
  const offer = invoiceAdvanceOffer(invoice)
  if (!offer) return []
  const head = ['Pay in advance amount', `${offer.optional ? 'Optional advance' : 'Agreed advance requested'}: ${money(offer.requestedCents)} (${offer.number})`,
    `Advance received when this section was prepared: ${money(offer.receivedCents)}`,
    `Advance still requested at preparation: ${money(offer.outstandingCents)}`]
  const how = advanceOfferCollection(offer) === 'separate'
    ? ['This advance is separate from the current invoice total. Pay current charges using the invoice payment option; pay the advance separately. Only funds actually received become credit on account.']
    : autopay
      ? ['This advance is not charged automatically with this invoice. Pay it from the advance request page below. The invoice total above is for current charges only; the advance becomes credit on account once it is received.']
      : [`This advance is included in this invoice's payment link: pay current charges and the advance together in one payment.${offer.optional ? ' You may remove the advance on the payment page.' : ''}${offer.optional && card ? ' The card payment option covers current charges only.' : ''}`,
        'The invoice total above is for current charges only. The advance becomes credit on account once it is received.']
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
