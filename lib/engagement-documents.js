import { firmDetailLines } from './firm-lines.js'
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
 *  - the three boxes are filled once with `values` (from `engagementValues`) against
 *    the ENGAGEMENT placeholder list; `fill` carries the merged missing / unknown /
 *    retired keys for the caller to refuse or show;
 *  - `**bold**` is read after the placeholders are filled: `<strong>` in the email's
 *    HTML, the markers dropped in its plain text; the PDF renderer bolds the letter;
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

// TODO(merge feat/letters-v2): delete boldRuns / withoutBoldMarks below and
//   import { boldRuns, withoutBoldMarks } from './letter-bold.js'
// They are a copy of that module's rule (laneB, commit 3c03174), kept here only
// until it reaches main: `**` opens a run, the next `**` closes it, a blank or
// unmatched pair stays as typed, runs never cross a paragraph.
const MARK = '**'

function boldRuns(text) {
  const source = String(text ?? '')
  const runs = []
  let plain = ''
  let at = 0
  while (at < source.length) {
    const open = source.indexOf(MARK, at)
    if (open < 0) break
    const close = source.indexOf(MARK, open + MARK.length)
    if (close < 0) break
    const inner = source.slice(open + MARK.length, close)
    if (!inner.trim()) {
      plain += source.slice(at, open + MARK.length)
      at = open + MARK.length
      continue
    }
    plain += source.slice(at, open)
    if (plain) runs.push({ text: plain, bold: false })
    plain = ''
    runs.push({ text: inner, bold: true })
    at = close + MARK.length
  }
  plain += source.slice(at)
  if (plain) runs.push({ text: plain, bold: false })
  return runs
}

function withoutBoldMarks(text) {
  return boldRuns(text)
    .map((run) => run.text)
    .join('')
}

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
  // One line, as a mail client shows it, and inside the provider's length. Never bolded.
  const subject =
    withoutBoldMarks(subjectFill.text).replace(/\s+/g, ' ').trim().slice(0, 200) ||
    `Engagement letter from ${firmName}`

  const signature = [firmName, ...firmDetailLines(firmSettings)]
  const paragraphs = emailFill.text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
  const text = [...paragraphs.map(withoutBoldMarks), signature.join('\n')].join('\n\n')
  const paragraphHtml = (paragraph) =>
    boldRuns(paragraph)
      .map((run) => (run.bold ? `<strong>${esc(run.text)}</strong>` : esc(run.text)))
      .join('')
      .replace(/\n/g, '<br>')
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#1f1d1a;">${[
    ...paragraphs.map((paragraph) => `<p style="margin:0 0 14px;">${paragraphHtml(paragraph)}</p>`),
    `<p style="margin:18px 0 0;font-size:12px;color:#7d7269;">${signature.map(esc).join('<br>')}</p>`,
  ].join('')}</div>`

  const addressee = addresseeOf(engagement, filled, client)
  let pdf = null
  let pdfError = null
  try {
    pdf = await buildPdf({
      bodyText: letterFill.text,
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
