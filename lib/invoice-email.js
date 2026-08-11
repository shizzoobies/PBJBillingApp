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

/**
 * Every word a CLIENT reads after they pay, in ONE place — same discipline as
 * CARD_PAYMENT_COPY above, for the same reason. Brittany will revise this
 * wording, and when she does it must not mean reconciling three half-sentences
 * spread across an HTML table and a plain-text array.
 *
 * Two moments, two emails. A bank transfer is authorized days before it
 * settles, so the client gets an acknowledgment first and a receipt later; a
 * card settles at once, so it gets the receipt only.
 */
export const PAYMENT_ACK_COPY = {
  subject: (number) => `Payment received for invoice ${number} — processing`,
  heading: 'Payment received',
  lead: (amount, number) =>
    `Thank you — we have received your payment of ${amount} for invoice ${number}.`,
  timing:
    'Your receipt will follow when the transfer completes, typically a few business days from now.',
}

export const PAYMENT_RECEIPT_COPY = {
  subject: (number) => `Receipt for invoice ${number}`,
  heading: 'Payment received — thank you',
  lead: (amount, number) =>
    `We have received your payment of ${amount} for invoice ${number}. This email is your receipt.`,
  attachment: 'Your paid invoice is attached for your records.',
  thanks: (firmName) => `Thank you for your business. — ${firmName}`,
}

/**
 * How a payment method reads to a human. Stripe says `us_bank_account`; a
 * client reads "bank transfer". Lives here rather than at each call site
 * because the PDF's PAID stamp and the receipt email must say the same word.
 */
export function paymentMethodLabel(method) {
  const value = String(method ?? '').trim().toLowerCase()
  if (value === 'card') return 'Card'
  if (!value || value === 'us_bank_account' || value === 'ach_debit' || value === 'ach') {
    return 'Bank transfer'
  }
  return value.replace(/_/g, ' ').replace(/^./, (first) => first.toUpperCase())
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

/* -------------------------------------------------------------------------- */
/* What lands AFTER the money moves                                           */
/* -------------------------------------------------------------------------- */

/**
 * The shell both payment emails share: the firm's name, a heading, some
 * sentences, and a small label/value table of the facts (amount, method, date,
 * invoice number). Same inline-everything, tables-for-layout rules as the
 * invoice email above — email clients have not changed their minds.
 */
function paymentShell({ firmName, heading, paragraphs, rows }) {
  const rowHtml = rows
    .filter(([, value]) => String(value ?? '').trim())
    .map(
      ([label, value]) => `<tr>
        <td style="padding:7px 0;font-size:13px;color:#7d7269;">${esc(label)}</td>
        <td style="padding:7px 0;font-size:14px;color:#1f1d1a;text-align:right;font-weight:600;white-space:nowrap;">${esc(
          value,
        )}</td>
      </tr>`,
    )
    .join('')

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f5f1;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px;">
    <p style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#7d2a4d;margin:0 0 6px;font-weight:700;">${esc(
      firmName,
    )}</p>
    <h1 style="margin:0 0 14px;font-size:20px;color:#1f1d1a;">${esc(heading)}</h1>
    ${paragraphs
      .filter((line) => String(line ?? '').trim())
      .map(
        (line) =>
          `<p style="margin:0 0 12px;font-size:14.5px;line-height:1.6;color:#555049;">${esc(
            line,
          )}</p>`,
      )
      .join('')}
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin-top:8px;border-top:1px solid #ece8e1;">
      ${rowHtml}
    </table>
  </div>
</body></html>`

  const text = [
    firmName,
    heading,
    '',
    ...paragraphs.filter((line) => String(line ?? '').trim()),
    '',
    ...rows
      .filter(([, value]) => String(value ?? '').trim())
      .map(([label, value]) => `${label}: ${value}`),
  ].join('\n')

  return { html, text }
}

/**
 * The ACH acknowledgment: the bank has authorized the debit, the money has not
 * landed yet. No attachment — the invoice is not paid, so a PDF stamped either
 * way would be wrong.
 */
export function buildPaymentAckEmail({
  invoice,
  client,
  firmName = 'PB&J Strategic Accounting',
}) {
  const number = String(invoice?.number ?? '').trim()
  const amount = money.format(Number(invoice?.total) || 0)
  const { html, text } = paymentShell({
    firmName,
    heading: PAYMENT_ACK_COPY.heading,
    paragraphs: [PAYMENT_ACK_COPY.lead(amount, number), PAYMENT_ACK_COPY.timing],
    rows: [
      ['Amount', amount],
      ['Invoice', number],
      ['Client', String(client?.name ?? '')],
    ],
  })
  return { subject: PAYMENT_ACK_COPY.subject(number), html, text }
}

/**
 * The receipt: the money has settled. Built AFTER the payment is applied, so
 * the total it quotes already includes the card fee line when a card paid it.
 */
export function buildPaymentReceiptEmail({
  invoice,
  client,
  firmName = 'PB&J Strategic Accounting',
  hasAttachment = true,
}) {
  const number = String(invoice?.number ?? '').trim()
  const amount = money.format(Number(invoice?.total) || 0)
  const { html, text } = paymentShell({
    firmName,
    heading: PAYMENT_RECEIPT_COPY.heading,
    paragraphs: [
      PAYMENT_RECEIPT_COPY.lead(amount, number),
      hasAttachment ? PAYMENT_RECEIPT_COPY.attachment : '',
      PAYMENT_RECEIPT_COPY.thanks(firmName),
    ],
    rows: [
      ['Amount paid', amount],
      ['Method', paymentMethodLabel(invoice?.paymentMethod)],
      ['Paid on', longDate(String(invoice?.paidAt ?? '').slice(0, 10))],
      ['Invoice', number],
      ['Client', String(client?.name ?? '')],
    ],
  })
  return { subject: PAYMENT_RECEIPT_COPY.subject(number), html, text }
}

/**
 * Which payment email — if any — a freshly-applied status calls for.
 *
 * A card payment passes through `processing` for a second or two on its way to
 * `paid`, and telling that client their receipt will arrive "in a few business
 * days" would be wrong twice over. So the acknowledgment is the BANK channel's
 * only, and the receipt is both channels'.
 */
export function paymentEmailKindFor(status, { isCard = false } = {}) {
  if (status === 'paid') return 'receipt'
  if (status === 'processing') return isCard ? null : 'ack'
  return null
}

/** Has this kind of payment email already gone out successfully for this invoice? */
export function hasLoggedPaymentEmail(invoice, kind) {
  // Entries predating this feature carry no `kind` at all — they are invoice
  // sends, and they must never be mistaken for a receipt.
  return (invoice?.emailLog ?? []).some((entry) => entry?.kind === kind && entry?.ok)
}

/**
 * Send the client whichever payment email the transition calls for, once.
 *
 * The webhook is the only caller. Every dependency is injected — the mail
 * transport, the PDF builder, the email-log write — because this is the piece
 * that must be provable without a mail provider, a Stripe account or a
 * database: get it wrong and a client is either thanked twice for one payment
 * or never told their money arrived.
 *
 * TWO guards, deliberately belt-and-braces. `statusChanged` says the invoice
 * actually moved (a webhook replay that changes nothing sends nothing), and the
 * `email_log` check catches the case where it moved but we already wrote about
 * it. Stripe retries; neither guard alone is enough.
 *
 * Never throws for a delivery problem — the caller is a webhook handler that
 * must answer 200 whatever happens here.
 *
 * @returns {Promise<{kind: string|null, sent: boolean, reason: string|null}>}
 */
export async function sendInvoicePaymentEmail({
  invoice,
  client,
  contacts = [],
  firmName,
  statusChanged = false,
  isCard = false,
  buildPdf = null,
  sendEmail,
  recordSent = null,
}) {
  const kind = paymentEmailKindFor(invoice?.status, { isCard })
  if (!kind) return { kind: null, sent: false, reason: 'no_payment_email_for_status' }
  if (!statusChanged) return { kind, sent: false, reason: 'status_did_not_change' }
  if (hasLoggedPaymentEmail(invoice, kind)) return { kind, sent: false, reason: 'already_sent' }

  const recipients = resolveInvoiceRecipients({ client, contacts })
  if (recipients.to.length === 0) return { kind, sent: false, reason: 'no_recipient' }

  // The receipt carries the invoice as it now stands — PAID stamp, card fee
  // line and all. A PDF that will not build is a nicety lost, not a receipt
  // withheld: the client is still told their money arrived.
  let attachments = []
  if (kind === 'receipt' && typeof buildPdf === 'function') {
    try {
      attachments = await buildPdf()
    } catch (error) {
      console.error('[invoice] receipt PDF failed; sending without it:', error?.message || error)
      attachments = []
    }
  }

  const email =
    kind === 'receipt'
      ? buildPaymentReceiptEmail({
          invoice,
          client,
          firmName,
          hasAttachment: attachments.length > 0,
        })
      : buildPaymentAckEmail({ invoice, client, firmName })

  const result = await sendEmail({
    to: recipients.to,
    subject: email.subject,
    html: email.html,
    text: email.text,
    attachments,
  })

  // Logged either way, and tagged with its kind — the log is both the audit
  // trail and the second send-once guard.
  if (typeof recordSent === 'function') {
    try {
      await recordSent(invoice.id, {
        to: recipients.to,
        subject: email.subject,
        ok: Boolean(result?.ok),
        error: result?.error ?? null,
        kind,
      })
    } catch (error) {
      console.error('[invoice] payment email log write failed:', error?.message || error)
    }
  }

  return {
    kind,
    sent: Boolean(result?.ok),
    reason: result?.ok ? null : (result?.error ?? 'send_failed'),
  }
}
