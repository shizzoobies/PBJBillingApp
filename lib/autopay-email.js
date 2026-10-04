/**
 * The email that invites a client to set up automatic payments (featreq-bef42b72).
 *
 * Same branded shell as the invoice and the payment emails; every word a client
 * reads is in AUTOPAY_EMAIL_COPY, in one place, because Brittany revises client
 * wording and a revision must not mean hunting through markup.
 *
 * The invoice and receipt emails carry their own autopay sentences, from the
 * same lib/autopay-copy.js.
 */

import { firmDetailLines } from './firm-lines.js'
import { AUTOPAY_EMAIL_COPY } from './autopay-copy.js'
import { BRAND, FONT, brandShell, esc } from './invoice-email.js'

/**
 * @param {object} args
 * @param {{name?: string}} args.client
 * @param {string} args.setupUrl the client's durable /autopay/<token> link
 * @param {boolean} [args.cardsOffered]
 * @returns {{subject: string, html: string, text: string}}
 */
export function buildAutopayInviteEmail({
  client,
  setupUrl,
  cardsOffered = false,
  firmName = 'PB&J Strategic Accounting',
  firmSettings = null,
}) {
  const copy = AUTOPAY_EMAIL_COPY
  const fee = cardsOffered ? [copy.bankNote, copy.cardNote] : [copy.bankNote]
  const paragraph = (text) =>
    `<p style="margin:0 0 14px;font-size:14.5px;line-height:1.7;color:${BRAND.ink};">${esc(text)}</p>`
  const contentHtml = `<h1 style="margin:0 0 14px;font-size:22px;line-height:1.35;font-weight:700;color:${BRAND.teal};">${esc(
    `Hi ${client?.name ?? ''}! ${copy.inviteHeading}`,
  )}</h1>
              ${paragraph(copy.inviteLead(cardsOffered))}
              ${paragraph(fee.join(' '))}
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
                <tr><td align="center" style="padding:14px 0 18px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">
                    <tr><td align="center" bgcolor="${BRAND.pink}" style="background:${BRAND.pink};border-radius:999px;">
                      <a href="${esc(setupUrl)}" style="display:inline-block;padding:17px 46px;font-family:${FONT};font-size:18px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:999px;">${esc(
                        copy.button,
                      )}</a>
                    </td></tr>
                  </table>
                </td></tr>
              </table>
              ${paragraph(copy.control)}`
  const html = brandShell({
    firmName,
    contentHtml,
    footerLines: firmDetailLines(firmSettings),
  })
  const contactLines = firmDetailLines(firmSettings)
  const text = [
    firmName,
    `Hi ${client?.name ?? ''}! ${copy.inviteHeading}`,
    '',
    copy.inviteLead(cardsOffered),
    fee.join(' '),
    '',
    `${copy.button}: ${setupUrl}`,
    '',
    copy.control,
    ...(contactLines.length > 0 ? ['', firmName, ...contactLines] : []),
  ].join('\n')
  return { subject: copy.inviteSubject(firmName), html, text }
}
