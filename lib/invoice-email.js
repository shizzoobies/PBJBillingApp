/**
 * The invoice email (I4) — what the client actually receives.
 *
 * Pure: builds a subject, an HTML body and the recipient list. Sending is the
 * caller's job, so this can be tested without a mail provider and without any
 * risk of a test accidentally emailing a real client.
 *
 * Two rules shape the markup. Email clients strip <style> blocks and ignore
 * most modern CSS, so everything is inline and laid out with tables. And the
 * body must stand on its own if the pay link is never clicked — a client who
 * prints it, or forwards it to their bookkeeper, still needs the full
 * breakdown, the total and the due date.
 */

import { cardChargedTotal, cardProcessingFee } from './invoice-lines.js'

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

/**
 * Every word of the card option, in ONE place.
 *
 * Brittany has not signed off on this wording yet, and when she revises it the
 * revision must not mean hunting through an HTML table and a plain-text array
 * for three half-sentences that have to keep agreeing with each other. Both
 * renderings below are built from exactly these three pieces.
 */
export const CARD_PAYMENT_COPY = {
  lead: 'Prefer to pay by card?',
  button: (chargedTotal) => `Pay ${money.format(chargedTotal)}`,
  note: (fee) =>
    `Includes a ${money.format(fee)} card processing fee — bank transfer has no fee.`,
}

/** Escape anything that reaches the HTML. Client names and notes are free text. */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** "2026-09-30" -> "September 30, 2026". Blank stays blank. */
export function longDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso ?? ''))) return ''
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(`${iso}T12:00:00`))
}

/**
 * Who the invoice goes to.
 *
 * Prefers the client's linked contacts — honoring a per-client email override
 * on a contact who appears on several clients — and falls back to the address
 * on the client record. Returns a REASON rather than an empty list when there
 * is nobody, so the UI can say what is missing instead of failing quietly.
 *
 * @returns {{to: string[], reason: string|null}}
 */
export function resolveInvoiceRecipients({ client, contacts = [] }) {
  const byId = new Map((contacts ?? []).map((contact) => [contact.id, contact]))
  const seen = new Set()
  const to = []

  const add = (raw) => {
    const email = String(raw ?? '').trim()
    // Deliberately loose: this is not a validator, it is a guard against
    // obviously-empty values. Resend rejects genuinely malformed addresses.
    if (!email || !email.includes('@')) return
    const key = email.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    to.push(email)
  }

  for (const contactId of client?.contactIds ?? []) {
    const contact = byId.get(contactId)
    if (!contact || contact.archivedAt) continue
    const override = (contact.companyEmails ?? []).find(
      (entry) => entry.clientId === client.id,
    )
    add(override?.email || contact.email)
  }

  add(client?.email)

  return {
    to,
    reason:
      to.length > 0
        ? null
        : 'No email address on file for this client — add one to the client or one of its contacts.',
  }
}

function lineRows(invoice) {
  return (invoice.lineItems ?? [])
    .map((line) => {
      const detail = line.detail
        ? `<div style="color:#7d7269;font-size:12px;margin-top:2px;">${esc(line.detail)}</div>`
        : ''
      return `<tr>
        <td style="padding:9px 0;border-bottom:1px solid #ece8e1;font-size:14px;color:#1f1d1a;">
          ${esc(line.label)}${detail}
        </td>
        <td style="padding:9px 0;border-bottom:1px solid #ece8e1;font-size:14px;color:#1f1d1a;text-align:right;white-space:nowrap;">
          ${money.format(Number(line.amount) || 0)}
        </td>
      </tr>`
    })
    .join('')
}

/**
 * Build the email.
 *
 * @param {object} args
 * @param {object} args.invoice
 * @param {object} args.client
 * @param {string} [args.firmName]
 * @param {string} [args.payUrl]   omitted -> no pay button, just the statement
 * @param {string} [args.cardPayUrl] omitted -> no card option at all, which is
 *   the case for every client who has not opted in. An ACH-only email is
 *   byte-for-byte what it was before card existed.
 * @param {string} [args.footerNote]
 * @returns {{subject: string, html: string, text: string}}
 */
export function buildInvoiceEmail({
  invoice,
  client,
  firmName = 'PB&J Strategic Accounting',
  payUrl = '',
  cardPayUrl = '',
  footerNote = '',
}) {
  const number = invoice.number ?? ''
  const subject = number
    ? `Invoice ${number} from ${firmName}`
    : `Invoice from ${firmName}`

  const due = longDate(invoice.dueDate)
  const blurb = String(invoice.blurb ?? '').trim()

  // The pay button is omitted entirely when there is no link, rather than
  // rendered dead — a button that does nothing is worse than no button.
  const payBlock = payUrl
    ? `<tr><td style="padding:22px 0 6px;">
         <a href="${esc(payUrl)}" style="display:inline-block;background:#7d2a4d;color:#ffffff;font-weight:600;text-decoration:none;padding:13px 26px;border-radius:8px;font-size:15px;">Pay by bank transfer</a>
         <div style="color:#7d7269;font-size:12px;margin-top:10px;line-height:1.5;">
           Paying by bank transfer takes about 4 business days to clear. You will see the payment
           marked as received once it settles.
         </div>
       </td></tr>`
    : ''

  // Deliberately SECONDARY: a text link under the bank-transfer button, not a
  // second button beside it. Bank transfer is the default and the no-fee
  // channel, and two equal-weight buttons would say otherwise.
  const cardFee = cardPayUrl ? cardProcessingFee(invoice.total) : 0
  const cardBlock = cardPayUrl
    ? `<tr><td style="padding:14px 0 0;">
         <div style="font-size:13px;color:#555049;line-height:1.6;">
           ${esc(CARD_PAYMENT_COPY.lead)}
           <a href="${esc(cardPayUrl)}" style="color:#7d2a4d;font-weight:600;text-decoration:underline;">${esc(
             CARD_PAYMENT_COPY.button(cardChargedTotal(invoice.total)),
           )}</a>
         </div>
         <div style="color:#7d7269;font-size:12px;margin-top:4px;line-height:1.5;">
           ${esc(CARD_PAYMENT_COPY.note(cardFee))}
         </div>
       </td></tr>`
    : ''

  const blurbBlock = blurb
    ? `<tr><td style="padding:4px 0 0;font-size:14px;line-height:1.6;color:#555049;white-space:pre-wrap;">${esc(
        blurb,
      )}</td></tr>`
    : ''

  const footerBlock = footerNote
    ? `<p style="margin:18px 0 0;font-size:12px;color:#7d7269;line-height:1.5;white-space:pre-wrap;">${esc(
        footerNote,
      )}</p>`
    : ''

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f5f1;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px;">
    <p style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#7d2a4d;margin:0 0 6px;font-weight:700;">${esc(
      firmName,
    )}</p>
    <h1 style="margin:0 0 4px;font-size:20px;color:#1f1d1a;">Invoice ${esc(number)}</h1>
    <p style="margin:0 0 18px;font-size:14px;color:#7d7269;">
      For ${esc(client?.name ?? '')}${due ? ` &middot; due ${esc(due)}` : ''}
    </p>

    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">
      ${lineRows(invoice)}
      <tr>
        <td style="padding:14px 0 0;font-size:15px;font-weight:700;color:#1f1d1a;">Total due</td>
        <td style="padding:14px 0 0;font-size:15px;font-weight:700;color:#1f1d1a;text-align:right;">${money.format(
          Number(invoice.total) || 0,
        )}</td>
      </tr>
      ${blurbBlock}
      ${payBlock}${cardBlock}
    </table>

    ${footerBlock}
  </div>
</body></html>`

  // A plain-text alternative so the message is not spam-scored as HTML-only and
  // stays readable in clients that refuse HTML.
  const text = [
    `${firmName}`,
    `Invoice ${number}`,
    `For ${client?.name ?? ''}${due ? ` · due ${due}` : ''}`,
    '',
    ...(invoice.lineItems ?? []).map(
      (line) => `${line.label}${line.detail ? ` (${line.detail})` : ''}  ${money.format(Number(line.amount) || 0)}`,
    ),
    '',
    `Total due: ${money.format(Number(invoice.total) || 0)}`,
    ...(blurb ? ['', blurb] : []),
    ...(payUrl ? ['', `Pay by bank transfer: ${payUrl}`, 'Bank transfers take about 4 business days to clear.'] : []),
    ...(cardPayUrl
      ? [
          '',
          `${CARD_PAYMENT_COPY.lead} ${CARD_PAYMENT_COPY.button(
            cardChargedTotal(invoice.total),
          )}: ${cardPayUrl}`,
          CARD_PAYMENT_COPY.note(cardFee),
        ]
      : []),
    ...(footerNote ? ['', footerNote] : []),
  ].join('\n')

  return { subject, html, text }
}
