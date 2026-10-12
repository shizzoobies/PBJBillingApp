import { firmDetailLines } from './firm-lines.js'
import { letterParagraphs, withoutBoldMarks } from './letter-bold.js'
import { buildLetterPdf, letterPdfFilename } from './letter-pdf.js'
import { fillTemplate, placeholdersFor } from './letter-template.js'
import { mailingAddressLines } from './mailing-address.js'

/**
 * The two documents a party receives for an ENGAGEMENT letter - the cover email and
 * the PDF letter that rides along (docs/plans/engagements-2026-10.md, stage 2A).
 * The same shape and the same rules as `buildLetterDocuments` in
 * lib/letter-documents.js, so the engagement preview and the send build what the
 * Letters ones build:
 *
 *  - the three boxes are filled once each, as whole texts, with `values` (from
 *    `engagementValues`) against the ENGAGEMENT placeholder list; `fill` carries the
 *    merged missing / unknown / retired keys for the caller to refuse or show;
 *  - `**bold**` (lib/letter-bold.js `letterParagraphs`) is read from the text AS TYPED
 *    and the placeholders are filled inside each run afterwards, so
 *    `**{{client_name}}**` bolds the name while a value containing `**` prints
 *    literally. Bold is `<strong>` in the email's HTML, no markers in its plain text,
 *    the bold face in the PDF (handed the runs as `paragraphs`); the subject is plain;
 *  - the PDF is addressed to the party (an engagement's prospect has no client record
 *    yet), dated `values.today`, titled with the subject; a rendering failure is
 *    `pdf: null` + `pdfError`, never a throw.
 */

const DEFAULT_FIRM_NAME = 'PB&J Strategic Accounting'

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char])

/** Typed text with one line ending, so the PDF and the email never see a stray \r. */
const normalized = (value) => String(value ?? '').replace(/\r\n?/g, '\n')

const clean = (value) => String(value ?? '').trim()

/** Paragraphs of runs back to plain text: no markers, a blank line between paragraphs. */
const plainText = (paragraphs) => paragraphs.map((runs) => runs.map((run) => run.text).join('')).join('\n\n')

/**
 * The addressee the PDF prints: the party's name and address - or, when the party
 * has no address, the linked client's - as the client-shaped object `buildLetterPdf`
 * and `letterPdfFilename` read.
 */
function addresseeOf(engagement, values, client) {
  const party = engagement?.party && typeof engagement.party === 'object' ? engagement.party : {}
  const source = mailingAddressLines(party).length ? party : (client ?? {})
  return {
    name: clean(values?.client_name) || clean(party.company) || clean(client?.name) || clean(party.contactName),
    addressLine1: clean(source.addressLine1),
    addressLine2: clean(source.addressLine2),
    city: clean(source.city),
    state: clean(source.state),
    postalCode: clean(source.postalCode),
  }
}

/**
 * @param {object} args
 * @param {{subject?: string, emailBody?: string, letterBody?: string, party?: object}} args.engagement
 * @param {Record<string, string>} args.values   from `engagementValues`
 * @param {object|null} [args.firmSettings]
 * @param {object|null} [args.client]            the linked client: the PDF's address when the party has none
 * @param {typeof buildLetterPdf} [args.buildPdf]  injectable for tests
 * @returns {Promise<{
 *   email: {subject: string, html: string, text: string},
 *   pdf: Buffer|null,
 *   pdfFilename: string,
 *   pdfError: Error|null,
 *   fill: {missing: string[], unknown: string[], retired: string[]},
 * }>}
 */
export async function buildEngagementDocuments({
  engagement,
  values,
  firmSettings = null,
  client = null,
  buildPdf = buildLetterPdf,
}) {
  const filled = values && typeof values === 'object' ? values : {}
  const placeholders = placeholdersFor('engagement')
  // Whole-text fills: the report (missing / unknown / retired) and the subject.
  const subjectFill = fillTemplate(engagement?.subject, filled, placeholders)
  const emailFill = fillTemplate(normalized(engagement?.emailBody), filled, placeholders)
  const letterFill = fillTemplate(normalized(engagement?.letterBody), filled, placeholders)

  const fill = { missing: [], unknown: [], retired: [] }
  for (const part of [subjectFill, emailFill, letterFill]) {
    for (const key of part.missing) if (!fill.missing.includes(key)) fill.missing.push(key)
    for (const key of part.unknown) if (!fill.unknown.includes(key)) fill.unknown.push(key)
    for (const key of part.retired) if (!fill.retired.includes(key)) fill.retired.push(key)
  }

  const firmName = clean(filled.firm_name) || clean(firmSettings?.name) || DEFAULT_FIRM_NAME
  // One line, as a mail client shows it, and inside the provider's length. Never bolded:
  // the markers come off the subject AS TYPED, before filling, so a value's own `**`
  // stays literal (the same order as the runs below).
  const subject =
    fillTemplate(withoutBoldMarks(engagement?.subject), filled, placeholders)
      .text.replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200) || `Engagement letter from ${firmName}`

  // What the documents draw: the runs read from the text as typed, filled run by run.
  const fillRun = (runText) => fillTemplate(runText, filled, placeholders).text
  const emailParagraphs = letterParagraphs(normalized(engagement?.emailBody), fillRun)
  const letterParagraphsDrawn = letterParagraphs(normalized(engagement?.letterBody), fillRun)

  const signature = [firmName, ...firmDetailLines(firmSettings)]
  const text = [plainText(emailParagraphs), signature.join('\n')].filter(Boolean).join('\n\n')
  const paragraphHtml = (runs) =>
    runs
      .map((run) => (run.bold ? `<strong>${esc(run.text)}</strong>` : esc(run.text)))
      .join('')
      .replace(/\n/g, '<br>')
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#1f1d1a;">${[
    ...emailParagraphs.map((runs) => `<p style="margin:0 0 14px;">${paragraphHtml(runs)}</p>`),
    `<p style="margin:18px 0 0;font-size:12px;color:#7d7269;">${signature.map(esc).join('<br>')}</p>`,
  ].join('')}</div>`

  const addressee = addresseeOf(engagement, filled, client)
  let pdf = null
  let pdfError = null
  try {
    pdf = await buildPdf({
      // The plain text (no markers) for any reader of bodyText; the PDF draws `paragraphs`.
      bodyText: plainText(letterParagraphsDrawn),
      paragraphs: letterParagraphsDrawn,
      client: addressee,
      firmSettings,
      dateLabel: filled.today ?? '',
      title: subject,
    })
  } catch (error) {
    pdfError = error instanceof Error ? error : new Error(String(error))
  }
  return {
    email: { subject, html, text },
    pdf,
    pdfFilename: letterPdfFilename(addressee, filled.year),
    pdfError,
    fill,
  }
}
