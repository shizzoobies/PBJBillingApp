/**
 * The invoice email (I4) — what the client actually receives.
 *
 * Pure: builds a subject, an HTML body and the recipient list. Sending is the
 * caller's job, so this can be tested without a mail provider and without any
 * risk of a test accidentally emailing a real client.
 *
 * Three rules shape the markup. Email clients strip <style> blocks and ignore
 * most modern CSS, so everything is inline and laid out with tables. Images are
 * blocked by default in most inboxes, so nothing that matters may live only
 * inside one — the pay button is a background-colored table cell wrapping a
 * link, and every image carries alt text worth reading on its own. And the body
 * must stand on its own if the pay link is never clicked — a client who prints
 * it, or forwards it to their bookkeeper, still needs the full breakdown, the
 * total and the due date.
 */

import {
  COMBINED_INVOICE_COPY,
  DETAIL_SECTION_TITLE,
  INVOICE_FOOTER_DEFAULT,
  INVOICE_RENDER_MODES,
  cardChargedTotal,
  cardProcessingFee,
  clientFacingInvoiceLines,
  getBillingPeriodLabel,
  invoiceDetailRows,
  invoiceDocumentRenderMode,
  invoiceRenderMode,
  invoiceSections,
} from './invoice-lines.js'
import { resolveInvoiceRecipients } from './invoice-recipients.js'

/**
 * Re-exported rather than defined here: the React side has to show the owner
 * WHO an invoice is about to go to, and it must ask the same code the send
 * endpoint asks. The implementation moved to `lib/invoice-recipients.js` so it
 * can be imported by the browser bundle without this module's email markup;
 * this export keeps every existing server call site and test unchanged.
 */
export { resolveInvoiceRecipients }

/**
 * The rendering mode, re-exported for the same reason and on the same terms.
 * It lives in `lib/invoice-lines.js` beside `renderedInvoiceLines`, so the
 * browser's print sheet can ask it without pulling this module's brand markup
 * into the bundle; these exports keep the server call sites and tests here.
 */
export {
  COMBINED_INVOICE_COPY,
  DETAIL_SECTION_TITLE,
  INVOICE_FOOTER_DEFAULT,
  INVOICE_RENDER_MODES,
  clientFacingInvoiceLines,
  invoiceDocumentRenderMode,
  invoiceRenderMode,
}

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

/* -------------------------------------------------------------------------- */
/* The brand shell                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Where the two pre-rendered brand images live when `APP_PUBLIC_URL` is unset.
 *
 * An email is opened somewhere else entirely — a phone, days later, in an inbox
 * that has never heard of this server. A relative `/email/...` src resolves
 * against the mail client, and a `http://localhost:4173` one resolves against
 * the READER's machine; both render as a broken image in a client's inbox. So
 * there is no safe "just leave it unset" behavior, and the fallback is the real
 * production origin. Named rather than inlined so the tests can assert on it
 * instead of on whatever happens to be in the environment.
 */
export const EMAIL_ASSET_ORIGIN_FALLBACK = 'https://app.pbjsa.com'

/** Absolute URL for a file served out of `public/`. Trailing slashes tolerated. */
export function emailAssetUrl(pathname) {
  const configured = String(process.env.APP_PUBLIC_URL ?? '').trim()
  const origin = (configured || EMAIL_ASSET_ORIGIN_FALLBACK).replace(/\/+$/, '')
  return `${origin}${pathname}`
}

/**
 * The words the new branded shell adds, in ONE place — same discipline as
 * CARD_PAYMENT_COPY below, for the same reason: Brittany revises copy, and a
 * revision must be a one-line change rather than a hunt through markup.
 *
 * `quoteAlt` is not decoration. It is the exact sentence rendered inside
 * `brittany-quote.png`, so a client whose inbox blocks images still reads it.
 */
export const BRAND_EMAIL_COPY = {
  greeting: (clientName) => `Hi ${clientName}! Your invoice is ready.`,
  signOff: 'Thank you for letting us take the books off your plate.',
  logoAlt: 'PB&J Strategic Accounting',
  quoteAlt: INVOICE_FOOTER_DEFAULT,
}

/**
 * Brittany's own palette, lifted from pbjsa.com so the emails and the site read
 * as one firm: PINK is the call to action and nothing else, TEAL carries the
 * headings and the supporting structure, and pale ice-blue washes the page
 * behind the white card.
 */
const BRAND = {
  pink: '#ff43a4',
  teal: '#0e7490',
  cyan: '#48c2e0',
  ice: '#e8f5fa',
  panel: '#f3fafd',
  border: '#cbe6f0',
  ink: '#26333a',
  soft: '#6f8189',
  rule: '#e4eff4',
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"

/**
 * The ice-blue page, the white rounded content panel, the logo above it and
 * Brittany's quote plus the sign-off below it. All three emails — invoice,
 * acknowledgment, receipt — are this shell wrapped around different middles.
 */
function brandShell({ firmName, contentHtml }) {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:${BRAND.ice};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;background:${BRAND.ice};">
    <tr>
      <td align="center" style="padding:30px 14px;font-family:${FONT};">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;border-collapse:collapse;">
          <tr>
            <td align="center" style="padding:0 0 24px;">
              <img src="${esc(emailAssetUrl('/email/pbj-logo.png'))}" width="340" alt="${esc(
                BRAND_EMAIL_COPY.logoAlt,
              )}" style="display:block;width:340px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;" />
            </td>
          </tr>
          <tr>
            <td style="background:#ffffff;border-radius:22px;padding:34px 30px;">
              ${contentHtml}
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:30px 0 4px;">
              <img src="${esc(emailAssetUrl('/email/brittany-quote.png'))}" width="500" alt="${esc(
                BRAND_EMAIL_COPY.quoteAlt,
              )}" style="display:block;width:500px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;" />
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:16px 10px 6px;font-family:${FONT};">
              <div style="font-size:13px;font-weight:700;color:${BRAND.teal};letter-spacing:0.02em;">${esc(
                firmName,
              )}</div>
              <div style="font-size:12px;color:${BRAND.soft};line-height:1.6;padding-top:5px;">${esc(
                BRAND_EMAIL_COPY.signOff,
              )}</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body></html>`
}

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

/** The HTML breakdown. Omitted ad hoc lines are filtered out by the shared rule
 *  the PDF and the screen use, so the three documents always say the same. */
function lineRows(lines, { amounts = true } = {}) {
  return lines
    .map((line) => {
      const detail = line.detail
        ? `<div style="color:${BRAND.soft};font-size:12px;margin-top:3px;">${esc(line.detail)}</div>`
        : ''
      return `<tr>
        <td style="padding:10px 0;border-bottom:1px solid ${BRAND.rule};font-size:14px;color:${BRAND.ink};line-height:1.5;vertical-align:top;">
          ${esc(line.label)}${detail}
        </td>
        <td style="padding:10px 0;border-bottom:1px solid ${BRAND.rule};font-size:14px;color:${BRAND.ink};text-align:right;white-space:nowrap;vertical-align:top;">
          ${amounts ? money.format(Number(line.amount) || 0) : ''}
        </td>
      </tr>`
    })
    .join('')
}

/**
 * A section heading spanning the breakdown table. `title` comes off the section
 * object, never from a string typed here — see `sectionRows` below.
 */
function sectionHeadingRow(title) {
  return `<tr>
        <td colspan="2" style="padding:20px 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:0.1em;font-weight:700;color:${BRAND.teal};">${esc(
          title,
        )}</td>
      </tr>`
}

/** A role sub-heading inside the hours section. Quieter than the section above it. */
function groupHeadingRow(title) {
  return `<tr>
        <td colspan="2" style="padding:12px 0 2px;font-size:13px;font-weight:700;color:${BRAND.ink};">${esc(
          title,
        )}</td>
      </tr>`
}

/** The section's own total, in her wording, on the row that closes the block. */
function sectionTotalRow(label, total) {
  return `<tr>
        <td style="padding:10px 0;border-bottom:1px solid ${BRAND.rule};font-size:14px;font-weight:700;color:${BRAND.ink};">${esc(
          label,
        )}</td>
        <td style="padding:10px 0;border-bottom:1px solid ${BRAND.rule};font-size:14px;font-weight:700;color:${BRAND.ink};text-align:right;white-space:nowrap;">${money.format(
          Number(total) || 0,
        )}</td>
      </tr>`
}

/**
 * The breakdown, in her three sections.
 *
 * Every word of structure — the section title, the role sub-heading, the total's
 * label — comes off the section object built by `invoiceSections`. Nothing is
 * spelled out here, so the email, the PDF and the print sheet cannot word the
 * same invoice differently. A null title or totalLabel means DRAW NOTHING: that
 * is what keeps a billing master's document from stating a per-company split.
 */
function sectionRows(sections) {
  return sections
    .map((section) => {
      const body = section.groups
        ? section.groups
            .map((group) => `${group.title ? groupHeadingRow(group.title) : ''}${lineRows(group.rows)}`)
            .join('')
        : lineRows(section.rows)
      return `${section.title ? sectionHeadingRow(section.title) : ''}${body}${
        section.totalLabel ? sectionTotalRow(section.totalLabel, section.total) : ''
      }`
    })
    .join('')
}

/**
 * One breakdown row, as plain text. The HTML twin is `lineRows` above, and
 * `amounts` means the same thing in both: the detailed-hours rows are $0.00 by
 * invariant, and a column of zeroes beside an hours listing reads as a bug.
 */
function lineText(line, { amounts = true } = {}) {
  const money2 = amounts ? `  ${money.format(Number(line.amount) || 0)}` : ''
  return `${line.label}${line.detail ? ` (${line.detail})` : ''}${money2}`
}

/**
 * The same sections, as plain text. Built from the SAME section objects as the
 * HTML — a client reading the text alternative must not be shown a differently
 * organized invoice from the one in the HTML part of the very same message.
 */
function sectionTextLines(sections) {
  const out = []
  for (const section of sections) {
    // A blank line between blocks whether or not the block is titled — the
    // untitled charges block still has to read as its own thing.
    if (out.length > 0) out.push('')
    if (section.title) out.push(section.title)
    const emit = (rows) => {
      for (const line of rows) out.push(lineText(line))
    }
    if (section.groups) {
      for (const group of section.groups) {
        if (group.title) out.push(`  ${group.title}`)
        emit(group.rows)
      }
    } else {
      emit(section.rows)
    }
    if (section.totalLabel) {
      out.push(`${section.totalLabel}  ${money.format(Number(section.total) || 0)}`)
    }
  }
  return out
}

/** One label/value line inside the summary panel. Blank values drop out. */
function summaryRow(label, value) {
  if (!String(value ?? '').trim()) return ''
  return `<tr>
        <td style="padding:3px 0;font-size:13px;font-weight:600;color:${BRAND.teal};">${esc(
          label,
        )}</td>
        <td style="padding:3px 0;font-size:13px;color:${BRAND.ink};text-align:right;font-weight:600;white-space:nowrap;">${esc(
          value,
        )}</td>
      </tr>`
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
  // Same UTC-calendar-day rule the PDF's `stampDate` applies (slice(0, 10) of
  // the ISO string), so the two documents never disagree about which day
  // printed. `sentAt` when the invoice has gone out, `createdAt` before that.
  const invoiceDate = longDate(String(invoice.sentAt ?? invoice.createdAt ?? '').slice(0, 10))
  // The client-facing lines, which for a billing master are the single combined
  // line rather than the stored ones. Resolved ONCE so the HTML breakdown and
  // the plain-text alternative cannot describe different documents.
  const lines = clientFacingInvoiceLines(invoice, client)
  // Both renderings are built from these two, resolved once: the sections carry
  // the titles and the per-section totals, the detail rows are the hours block
  // that is page 2 on the PDF and simply the last block here — an email has no
  // pages. Combined mode yields one untitled section and no detail rows at all.
  const combined = invoiceDocumentRenderMode(invoice, client) === 'combined'
  const sections = invoiceSections(lines, { combined })
  const detailRows = invoiceDetailRows(lines)
  const blurb = String(invoice.blurb ?? '').trim()
  const total = Number(invoice.total) || 0
  const period = /^\d{4}-\d{2}$/.test(String(invoice.period ?? ''))
    ? getBillingPeriodLabel(invoice.period)
    : ''

  // The pay button is omitted entirely when there is no link, rather than
  // rendered dead — a button that does nothing is worse than no button.
  //
  // It is a bgcolor'd table cell wrapping the link, not a styled <a>: Outlook
  // drops the padding and the background off a bare anchor, and an inbox that
  // blocks images has to still show something a client can obviously press.
  const payBlock = payUrl
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
         <tr><td align="center" style="padding:26px 0 0;">
           <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">
             <tr><td align="center" bgcolor="${BRAND.pink}" style="background:${BRAND.pink};border-radius:999px;">
               <a href="${esc(payUrl)}" style="display:inline-block;padding:17px 46px;font-family:${FONT};font-size:18px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:999px;">${esc(
                 `Pay ${money.format(total)}`,
               )}</a>
             </td></tr>
           </table>
           <div style="color:${BRAND.soft};font-size:12px;padding-top:12px;line-height:1.6;">
             Paying by bank transfer takes about 4 business days to clear. You will see the payment
             marked as received once it settles.
           </div>
         </td></tr>
       </table>`
    : ''

  // Deliberately SECONDARY: a text link under the bank-transfer button, not a
  // second button beside it. Bank transfer is the default and the no-fee
  // channel, and two equal-weight buttons would say otherwise.
  const cardFee = cardPayUrl ? cardProcessingFee(invoice.total) : 0
  const cardBlock = cardPayUrl
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
         <tr><td align="center" style="padding:16px 0 0;">
           <div style="font-size:13px;color:${BRAND.ink};line-height:1.7;">
             ${esc(CARD_PAYMENT_COPY.lead)}
             <a href="${esc(cardPayUrl)}" style="color:${BRAND.pink};font-weight:700;text-decoration:underline;">${esc(
               CARD_PAYMENT_COPY.button(cardChargedTotal(invoice.total)),
             )}</a>
           </div>
           <div style="color:${BRAND.soft};font-size:12px;padding-top:5px;line-height:1.6;">
             ${esc(CARD_PAYMENT_COPY.note(cardFee))}
           </div>
         </td></tr>
       </table>`
    : ''

  const blurbBlock = blurb
    ? `<p style="margin:22px 0 0;font-size:14px;line-height:1.7;color:${BRAND.ink};white-space:pre-wrap;">${esc(
        blurb,
      )}</p>`
    : ''

  const footerBlock = footerNote
    ? `<p style="margin:18px 0 0;font-size:12px;color:${BRAND.soft};line-height:1.6;white-space:pre-wrap;">${esc(
        footerNote,
      )}</p>`
    : ''

  const contentHtml = `<h1 style="margin:0 0 8px;font-size:22px;line-height:1.35;font-weight:700;color:${
    BRAND.teal
  };">${esc(BRAND_EMAIL_COPY.greeting(client?.name ?? ''))}</h1>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;margin-top:20px;">
                <tr><td style="background:${BRAND.panel};border:1px solid ${
                  BRAND.border
                };border-radius:16px;padding:22px 22px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
                    ${summaryRow('Invoice no.', number)}
                    ${summaryRow('Invoice Date', invoiceDate)}
                    ${summaryRow('Billing Period', period)}
                  </table>
                  <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.12em;font-weight:700;color:${
                    BRAND.teal
                  };padding-top:16px;">Amount due</div>
                  <div style="font-size:36px;line-height:1.2;font-weight:800;color:${
                    BRAND.pink
                  };padding-top:2px;">${money.format(total)}</div>
                  ${
                    due
                      ? `<div style="font-size:13px;color:${BRAND.ink};padding-top:6px;">Due date: ${esc(
                          due,
                        )}</div>`
                      : ''
                  }
                </td></tr>
              </table>

              ${payBlock}${cardBlock}

              <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.12em;font-weight:700;color:${
                BRAND.teal
              };padding:28px 0 6px;">What's included</div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
                ${sectionRows(sections)}${
                  detailRows.length > 0
                    ? `${sectionHeadingRow(DETAIL_SECTION_TITLE)}${lineRows(detailRows, {
                        amounts: false,
                      })}`
                    : ''
                }
                <tr>
                  <td style="padding:14px 0 0;font-size:15px;font-weight:700;color:${
                    BRAND.ink
                  };">Total due</td>
                  <td style="padding:14px 0 0;font-size:15px;font-weight:700;color:${
                    BRAND.ink
                  };text-align:right;white-space:nowrap;">${money.format(total)}</td>
                </tr>
              </table>

              ${blurbBlock}
              ${footerBlock}`

  const html = brandShell({ firmName, contentHtml })

  // A plain-text alternative so the message is not spam-scored as HTML-only and
  // stays readable in clients that refuse HTML.
  const text = [
    `${firmName}`,
    `Invoice no. ${number}`,
    ...(invoiceDate ? [`Invoice Date: ${invoiceDate}`] : []),
    ...(period ? [`Billing Period: ${period}`] : []),
    `For ${client?.name ?? ''}${due ? ` · due ${due}` : ''}`,
    '',
    ...sectionTextLines(sections),
    ...(detailRows.length > 0
      ? ['', DETAIL_SECTION_TITLE, ...detailRows.map((line) => lineText(line, { amounts: false }))]
      : []),
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
    '',
    BRAND_EMAIL_COPY.quoteAlt,
  ].join('\n')

  return { subject, html, text }
}

/* -------------------------------------------------------------------------- */
/* What lands AFTER the money moves                                           */
/* -------------------------------------------------------------------------- */

/**
 * The shell both payment emails share: a heading, some sentences, and a small
 * label/value table of the facts (amount, method, date, invoice number), inside
 * the same branded wrapper the invoice uses. Same inline-everything,
 * tables-for-layout rules — email clients have not changed their minds.
 *
 * `accent` is the one thing that differs between them. There is no pay button
 * on either: the money has already moved, and a second one is the last thing
 * these two emails should invite.
 *   'processing' — a soft blush bar; the payment is authorized, not settled.
 *   'paid'       — a celebratory pink check; it landed.
 */
function paymentShell({ firmName, heading, paragraphs, rows, accent = 'processing' }) {
  const rowHtml = rows
    .filter(([, value]) => String(value ?? '').trim())
    .map(
      ([label, value]) => `<tr>
                    <td style="padding:8px 0;font-size:13px;font-weight:600;color:${
                      BRAND.teal
                    };">${esc(label)}</td>
                    <td style="padding:8px 0;font-size:14px;color:${
                      BRAND.ink
                    };text-align:right;font-weight:600;white-space:nowrap;">${esc(value)}</td>
                  </tr>`,
    )
    .join('')

  // The glyph is a character, not an image, so the celebration survives an
  // inbox with images switched off. The acknowledgment's soft bar carries its
  // own heading, so it does not repeat it underneath.
  const accentHtml =
    accent === 'paid'
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
                <tr><td align="center" style="padding:0 0 4px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">
                    <tr><td align="center" width="72" height="72" bgcolor="${BRAND.teal}" style="width:72px;height:72px;background:${BRAND.teal};border-radius:36px;font-family:${FONT};font-size:36px;line-height:72px;color:#ffffff;font-weight:700;">&#10003;</td></tr>
                  </table>
                </td></tr>
              </table>
              <h1 style="margin:18px 0 14px;font-size:22px;line-height:1.35;font-weight:700;color:${
                BRAND.teal
              };text-align:center;">${esc(heading)}</h1>`
      : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
                <tr><td align="center" style="background:${BRAND.ice};border:1px solid ${BRAND.cyan};border-radius:14px;padding:16px 18px;font-size:15px;font-weight:700;color:${BRAND.teal};letter-spacing:0.01em;">
                  ${esc(heading)} &mdash; processing
                </td></tr>
              </table>
              <div style="height:20px;line-height:20px;font-size:0;">&nbsp;</div>`

  const contentHtml = `${accentHtml}
              ${paragraphs
                .filter((line) => String(line ?? '').trim())
                .map(
                  (line) =>
                    `<p style="margin:0 0 12px;font-size:14.5px;line-height:1.7;color:${BRAND.ink};text-align:center;">${esc(
                      line,
                    )}</p>`,
                )
                .join('')}
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;margin-top:20px;">
                <tr><td style="background:${BRAND.panel};border:1px solid ${
                  BRAND.border
                };border-radius:16px;padding:8px 20px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
                    ${rowHtml}
                  </table>
                </td></tr>
              </table>`

  const html = brandShell({ firmName, contentHtml })

  const text = [
    firmName,
    heading,
    '',
    ...paragraphs.filter((line) => String(line ?? '').trim()),
    '',
    ...rows
      .filter(([, value]) => String(value ?? '').trim())
      .map(([label, value]) => `${label}: ${value}`),
    '',
    BRAND_EMAIL_COPY.quoteAlt,
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
    accent: 'processing',
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
    accent: 'paid',
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
