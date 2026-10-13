/**
 * When a payment reminder may go out (featreq-3f1d63b6, the manual "Send
 * reminder" button) - ONE rule, read by both the server route and the month
 * run, so the button's disabled reason and the server's 409 can never disagree.
 *
 * PURE and browser-safe: no Stripe, no store, no clock. "Today" is a parameter
 * (the firm's day, `firmToday()`), and whether an autopay attempt is in flight
 * is a boolean the caller works out from its own attempt list.
 *
 * Alex's decisions (2026-10-13):
 *  - only a SENT invoice that is still owed is reminded: never a draft or
 *    reviewed one (not sent yet), a Processing one (a bank payment is clearing),
 *    a paid or void one, or one that owes nothing;
 *  - never a client billed outside the app or never emailed;
 *  - an autopay client is refused ONLY while an attempt is in flight (claimed,
 *    processing, succeeded) - a failed attempt is exactly when a reminder helps;
 *  - never while the invoice is Changed since sent (Send again is the action);
 *  - no day-based cooldown, but never twice on the same FIRM day: a second
 *    reminder the same Eastern day as the last ok reminder or the last ok send
 *    is refused.
 *
 * A reminder entry (`kind: 'reminder'`) is a tagged entry, so it is never a send:
 * it does not move the sent date, the status or the due date, does not count as
 * autopay's first send, and leaves a Payment failed invoice where it is.
 */

import { dateOnlyInZone } from './firm-time.js'
import { latestInvoiceSend } from './invoice-overdue.js'

/** The email-log tag a reminder is written with. */
export const REMINDER_KIND = 'reminder'

/** The newest reminder that actually left (ok), or null. "Last reminded <date>". */
export function latestInvoiceReminder(emailLog) {
  let latest = null
  for (const entry of emailLog ?? []) {
    if (!entry || entry.kind !== REMINDER_KIND || entry.ok !== true || typeof entry.at !== 'string') continue
    // `>=` so a later position wins a tie, as with the other log readers.
    if (!latest || entry.at >= latest.at) latest = entry
  }
  return latest
}

/**
 * The newer of the last ok reminder and the last ok send of the invoice itself,
 * as the ISO instant it was logged at - or null when neither exists.
 */
export function lastRemindedOrSentAt(emailLog) {
  const reminded = latestInvoiceReminder(emailLog)?.at ?? null
  const sent = latestInvoiceSend(emailLog)?.at ?? null
  if (!reminded) return sent
  if (!sent) return reminded
  return Date.parse(reminded) >= Date.parse(sent) ? reminded : sent
}

/**
 * Why a reminder may not go out now, as a code - or null when it may.
 *
 * Checked in the order a person would explain it: what the invoice is, whether
 * anything is owed, whether the client is emailed at all, whether money is
 * already moving, whether the client holds the current version, and last,
 * whether they already heard from us today.
 *
 * @param {object} args
 * @param {object|null} args.invoice
 * @param {object|null} args.client the invoice's own client record
 * @param {boolean} args.autopayActive an autopay attempt is claimed, processing or succeeded
 * @param {boolean} args.changedSinceSent the invoice was edited after its last send
 * @param {string} args.today the firm's day, YYYY-MM-DD
 * @returns {string|null}
 */
export function reminderRefusalCode({ invoice, client, autopayActive, changedSinceSent, today }) {
  const status = invoice?.status
  if (!invoice || status === 'void') return 'invoice_voided'
  if (status === 'processing') return 'payment_clearing'
  if (status === 'paid') return 'invoice_paid'
  if (status !== 'sent' && status !== 'overdue') return 'invoice_not_sent'
  if (!(Number(invoice.total) > 0)) return 'nothing_owed'
  if (client?.platformInvoicingOptOut === true) return 'client_opted_out'
  if (client?.invoiceNoEmail === true) return 'client_not_emailed'
  if (autopayActive === true) return 'autopay_in_flight'
  if (changedSinceSent === true) return 'changed_since_sent'
  const last = lastRemindedOrSentAt(invoice.emailLog)
  if (last && today && dateOnlyInZone(new Date(last)) === today) return 'reminded_today'
  return null
}

/** The month run's short reason on the disabled "Send reminder" button (Brittany's words). */
export const REMINDER_REFUSAL_TIPS = Object.freeze({
  invoice_voided: 'This invoice is voided',
  invoice_not_sent: 'Not sent yet',
  payment_clearing: 'A bank payment is clearing',
  invoice_paid: 'Nothing is owed',
  nothing_owed: 'Nothing is owed',
  client_opted_out: 'Client is not emailed',
  client_not_emailed: 'Client is not emailed',
  autopay_in_flight: 'Autopay is collecting this one',
  changed_since_sent: 'Changed since sent - use Send again',
  reminded_today: 'Already reminded today',
})

/** The server's plain sentence for a refusal (the 409's `message`). */
export function reminderRefusalMessage(code, clientName = 'This client') {
  switch (code) {
    case 'invoice_voided':
      return 'This invoice is voided, so no reminder was sent.'
    case 'invoice_not_sent':
      return 'This invoice has not been sent yet, so there is nothing to remind the client about. Send it first.'
    case 'payment_clearing':
      return 'A bank payment is clearing on this invoice, so no reminder was sent.'
    case 'invoice_paid':
      return 'This invoice is paid, so no reminder was sent.'
    case 'nothing_owed':
      return 'Nothing is owed on this invoice, so no reminder was sent.'
    // The send route's own sentences, so the two buttons explain a client the same way.
    case 'client_opted_out':
      return `${clientName} is invoiced outside the app.`
    case 'client_not_emailed':
      return `${clientName}'s invoices are delivered outside the app and never emailed.`
    case 'autopay_in_flight':
      return 'An automatic payment is collecting this invoice, so no reminder was sent.'
    case 'changed_since_sent':
      return 'This invoice changed after it was sent. Use Send again so the client has the current version; no reminder was sent.'
    case 'reminded_today':
      return 'This client already heard about this invoice today (a reminder or the invoice itself), so no reminder was sent. Try again tomorrow.'
    default:
      return 'No reminder was sent.'
  }
}
