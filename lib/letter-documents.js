import { firmDetailLines } from './firm-lines.js'
import { letterParagraphs } from './letter-bold.js'
import { buildLetterPdf, letterPdfFilename } from './letter-pdf.js'
import { fillTemplate, letterValues } from './letter-template.js'

const DEFAULT_FIRM_NAME = 'PB&J Strategic Accounting'

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char])

/** Typed text with one line ending, so the PDF and the email never see a stray \r. */
const normalized = (value) => String(value ?? '').replace(/\r\n?/g, '\n')

/**
 * The two documents a client receives for an engagement letter - the email and
 * the PDF that rides along - built in ONE place, the way
 * `lib/invoice-documents.js` builds an invoice's.
 *
 * The Letters preview and the send both call this with the same inputs (the
 * stored template, the client, its contacts, the firm's settings), so what the
 * owner previews is what the send builds by construction. The template's three
 * boxes are filled once with the client's values; `fill` carries what that
 * found, merged across the three boxes, for the caller to refuse or show:
 * `missing` (a required placeholder that was blank for this client) and
 * `unknown` (a token the app does not fill in).
 *
 * Unlike an invoice's, the PDF is the letter itself - without it nothing is
 * sent - but the builder still does not throw for it: a rendering failure yields
 * `pdf: null` and the error in `pdfError`, and the caller skips that client and
 * says why.
 *
 * @param {object} args
 * @param {{subject?: string, emailBody?: string, letterBody?: string}} args.template
 * @param {object} args.client
 * @param {object[]} [args.contacts]
 * @param {object|null} [args.firmSettings]
 * @param {Date} [args.now]             injectable for tests
 * @param {string} [args.senderName]    fills {{sender_name}}
 * @param {typeof buildLetterPdf} [args.buildPdf]  injectable for tests
 * @returns {Promise<{
 *   email: {subject: string, html: string, text: string},
 *   pdf: Buffer|null,
 *   pdfFilename: string,
 *   pdfError: Error|null,
 *   fill: {missing: string[], unknown: string[], retired: string[]},
 * }>}
 */
export async function buildLetterDocuments({
  template,
  client,
  contacts = [],
  firmSettings = null,
  now = new Date(),
  senderName = '',
  buildPdf = buildLetterPdf,
}) {
  const values = letterValues({ client, contacts, firmSettings, now, senderName })
  const subjectFill = fillTemplate(template?.subject, values)
  const emailFill = fillTemplate(normalized(template?.emailBody), values)
  const letterFill = fillTemplate(normalized(template?.letterBody), values)

  const fill = { missing: [], unknown: [], retired: [] }
  for (const part of [subjectFill, emailFill, letterFill]) {
    for (const key of part.missing) if (!fill.missing.includes(key)) fill.missing.push(key)
    for (const key of part.unknown) if (!fill.unknown.includes(key)) fill.unknown.push(key)
    for (const key of part.retired) if (!fill.retired.includes(key)) fill.retired.push(key)
  }

  const firmName = values.firm_name || DEFAULT_FIRM_NAME
  // One line, as a mail client shows it, and inside the provider's length.
  const subject =
    subjectFill.text.replace(/\s+/g, ' ').trim().slice(0, 200) || `A letter from ${firmName}`

  // The email is what she typed, a paragraph per blank line, then the firm's
  // details as a signature block (the same lines proposal-email.js closes with).
  // `**bold**` (lib/letter-bold.js) is read from the text AS TYPED, then the
  // placeholders are filled inside each run, so a client's value is never markup
  // (a name with ** in it prints them). Bold is <strong> in the HTML part; the
  // plain-text part has no markers. The subject is never bolded - a mail client
  // shows it as plain text. `emailFill` above is only the report (missing/unknown).
  const fillRun = (runText) => fillTemplate(runText, values).text
  const signature = [firmName, ...firmDetailLines(firmSettings)]
  const paragraphs = letterParagraphs(normalized(template?.emailBody), fillRun)
  const text = [...paragraphs.map((runs) => runs.map((run) => run.text).join('')), signature.join('\n')].join('\n\n')
  const paragraphHtml = (runs) =>
    runs
      .map((run) => (run.bold ? `<strong>${esc(run.text)}</strong>` : esc(run.text)))
      .join('')
      .replace(/\n/g, '<br>')
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#1f1d1a;">${[
    ...paragraphs.map((runs) => `<p style="margin:0 0 14px;">${paragraphHtml(runs)}</p>`),
    `<p style="margin:18px 0 0;font-size:12px;color:#7d7269;">${signature.map(esc).join('<br>')}</p>`,
  ].join('')}</div>`

  let pdf = null
  let pdfError = null
  try {
    pdf = await buildPdf({
      bodyText: letterFill.text,
      // What the PDF draws: the letter's runs, read before filling (as for the email).
      paragraphs: letterParagraphs(normalized(template?.letterBody), fillRun),
      client,
      firmSettings,
      dateLabel: values.today,
      title: subject,
    })
  } catch (error) {
    pdfError = error instanceof Error ? error : new Error(String(error))
  }
  return {
    email: { subject, html, text },
    pdf,
    pdfFilename: letterPdfFilename(client, values.year),
    pdfError,
    fill,
  }
}
