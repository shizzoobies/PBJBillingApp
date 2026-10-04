/**
 * Every word a client reads about autopay, in ONE place (featreq-bef42b72).
 * Brittany revises client wording; a revision must not mean hunting through
 * markup in three emails. No imports: the invite, the invoice and the receipt
 * emails all read from here, so they can never disagree about what autopay does.
 */

export const AUTOPAY_EMAIL_COPY = {
  inviteSubject: (firmName) => `Set up automatic payments with ${firmName}`,
  inviteHeading: 'Set up automatic payments',
  inviteLead: (cardsOffered) =>
    `You can have your invoices paid automatically. Once you save a bank account${
      cardsOffered ? ' or card' : ''
    }, we charge it for the total of each invoice at the moment we email it to you, and there is nothing more for you to do.`,
  bankNote: 'Bank transfers have no fee.',
  cardNote: 'A card payment adds the card processing fee, shown on each invoice.',
  control:
    'You are always in control: you can turn automatic payments off at any time from the same link, or from the link in any of our invoice emails.',
  button: 'Set up automatic payments',
  // On an invoice email sent under autopay (no Pay button).
  invoiceLine: (amount) =>
    `We will charge ${amount} to your saved payment method automatically. There is nothing you need to do.`,
  invoiceMethod: (method) => `Payment method: ${method}`,
  withdrawLead: 'Prefer not to pay this way?',
  withdrawLink: 'Turn off automatic payments',
}

/** "bank account ending 6789", "card ending 4242". */
export function autopayMethodWords({ methodType, last4 } = {}) {
  const kind = methodType === 'card' ? 'card' : 'bank account'
  return last4 ? `${kind} ending ${last4}` : kind
}
