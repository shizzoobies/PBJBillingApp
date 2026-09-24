/**
 * The email that carries a proposal PDF to a prospect (featreq-311473e2,
 * spec §5.4). Short on purpose: the proposal is the attachment. The subject is
 * the letter's own subject line when there is one.
 */

import { firmDetailLines } from './firm-lines.js'

const DEFAULT_FIRM_NAME = 'PB&J Strategic Accounting'

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char])

/**
 * @param {{ proposal: object, firmSettings?: object|null }} args
 * @returns {{ subject: string, html: string, text: string }}
 */
export function buildProposalEmail({ proposal, firmSettings = null }) {
  const firmName = String(firmSettings?.name ?? '').trim() || DEFAULT_FIRM_NAME
  const subject =
    String(proposal?.letter?.subject ?? '').trim().slice(0, 200) || `Your proposal from ${firmName}`
  const contactName = String(proposal?.prospect?.contactName ?? '').trim()
  const lines = [
    contactName ? `Hi ${contactName},` : 'Hello,',
    '',
    `Thank you for the chance to work with you. Your proposal from ${firmName} is attached as a PDF.`,
    'Reply to this email with any questions — we are glad to walk through it with you.',
    '',
    firmName,
    ...firmDetailLines(firmSettings),
  ]
  const text = lines.join('\n')
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#1f1d1a;">${lines
    .map((line) => (line ? `<p style="margin:0 0 4px;">${esc(line)}</p>` : '<br>'))
    .join('')}</div>`
  return { subject, html, text }
}
