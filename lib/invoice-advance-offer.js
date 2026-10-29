// A zero-value document attachment, never a service charge or a received credit.
export function invoiceAdvanceOffer(invoice) {
  return (invoice?.lineItems ?? invoice?.lines ?? []).find((line) => line.kind === 'advance_request')?.advanceOffer ?? null
}
export function advanceOfferText(invoice) {
  const offer = invoiceAdvanceOffer(invoice)
  if (!offer) return []
  const money = (n) => (n / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
  return ['Pay in advance amount', `${offer.optional ? 'Optional advance' : 'Agreed advance requested'}: ${money(offer.requestedCents)} (${offer.number})`,
    `Advance received when this section was prepared: ${money(offer.receivedCents)}`,
    `Advance still requested at preparation: ${money(offer.outstandingCents)}`,
    'This advance is separate from the current invoice total. Pay current charges using the invoice payment option; pay the advance separately. Only funds actually received become credit on account.',
    offer.forPeriod ? `Credit is reserved for ${offer.forPeriod} or later invoices.` : 'Received advance credit is drawn down by future invoices.',
    `Advance request and current remaining amount: ${offer.url}`,
    'Voiding this service invoice does not cancel the advance request or reverse received funds.']
}
