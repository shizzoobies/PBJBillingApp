/**
 * The email that carries a questionnaire link to a prospect (featreq-8f139178).
 * Short on purpose: the link is the message. Sent through `sendInvoiceEmail`
 * with a `questionnaire_id` tag, like the proposal email, so the delivery webhook
 * files its events on the questionnaire.
 *
 * The prospect's address is the only thing about them that is used; the link is
 * the only thing in it that is private, and it appears in the button, not in the
 * subject.
 */

import { firmDetailLines } from './firm-lines.js'
import { QUESTIONNAIRE_WELCOME } from './proposal-questionnaire.js'

const DEFAULT_FIRM_NAME = 'PB&J Strategic Accounting'

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char])

/**
 * @param {{ link: string, firmSettings?: object|null, contactName?: string, expiresAt?: string|null }} args
 * @returns {{ subject: string, html: string, text: string }}
 */
export function buildQuestionnaireEmail({ link, firmSettings = null, contactName = '', expiresAt = null }) {
  const firmName = String(firmSettings?.name ?? '').trim() || DEFAULT_FIRM_NAME
  const name = String(contactName ?? '').trim()
  const subject = `A few questions from ${firmName}`
  const expires = expiresAt ? new Date(expiresAt) : null
  const expiryLine =
    expires && !Number.isNaN(expires.getTime())
      ? `The link works until ${expires.toLocaleDateString('en-US', {
          month: 'long',
          day: 'numeric',
          year: 'numeric',
          timeZone: 'America/New_York',
        })}.`
      : ''
  const intro = [
    name ? `Hi ${name},` : 'Hello,',
    '',
    QUESTIONNAIRE_WELCOME,
    '',
    'It works on a phone. Please do not send passwords, EINs, Social Security numbers or bank account numbers.',
  ]
  const closing = [
    ...(expiryLine ? ['', expiryLine] : []),
    'Reply to this email with any questions.',
    '',
    firmName,
    ...firmDetailLines(firmSettings),
  ]
  const text = [...intro, '', 'Answer the questions here:', link, ...closing].join('\n')
  const paragraph = (line) => (line ? `<p style="margin:0 0 4px;">${esc(line)}</p>` : '<br>')
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#1f1d1a;">${intro
    .map(paragraph)
    .join('')}<p style="margin:16px 0;"><a href="${esc(
    link,
  )}" style="display:inline-block;background:#7d2a4d;color:#ffffff;font-weight:600;text-decoration:none;padding:12px 24px;border-radius:8px;">Answer the questions</a></p>${closing
    .map(paragraph)
    .join('')}</div>`
  return { subject, html, text }
}
