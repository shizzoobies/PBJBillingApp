/**
 * The engagement letter as a PDF (featreq-5e195707): the document a client reads,
 * signs and sends back by email.
 *
 * Server-side pdfkit like the proposal PDF (lib/proposal-pdf.js), whose
 * letterhead and paragraph renderer this is lifted from, so it runs on Railway
 * with no browser. The text is already filled in (lib/letter-template.js) - this
 * module only lays it on a page: the firm's letterhead, the date, the client's
 * address block, the paragraphs, the firm footer. Nothing here knows what a
 * placeholder is.
 */

import PDFDocument from 'pdfkit'
import SVGtoPDF from 'svg-to-pdfkit'

import { firmDetailLines } from './firm-lines.js'
import { decodeSvgLogo } from './invoice-pdf.js'
import { letterParagraphs } from './letter-bold.js'
import { mailingAddressLines } from './mailing-address.js'

const DEFAULT_FIRM_NAME = 'PB&J Strategic Accounting'
/**
 * The text tags SignWell reads out of a PDF to place the signer's signature and date fields
 * (`{{type:signer:required}}`; the verified facts are in lib/signwell.js). `buildLetterPdf`
 * writes them in WHITE at the letter's own "Signature:" and "Date:" lines when asked.
 */
export const SIGNATURE_TAG = '{{signature:1:y}}'
export const DATE_TAG = '{{date:1:y}}'
const TAG_COLOR = '#ffffff'
const FALLBACK_SIGNATURE_LINES = ['Signature: ______________________', 'Date: ______________']
const REGULAR = 'Helvetica'
const BOLD = 'Helvetica-Bold'
// The invoice and proposal PDFs' palette, so the firm's documents read as one.
const INK = '#1f1d1a'
const MUTED = '#7d7269'
const RULE = '#ece8e1'
const MARGIN = 54
const LOGO_WIDTH = 150
const LOGO_HEIGHT = 46

function rule(doc, y, left, right) {
  doc.save().lineWidth(0.75).strokeColor(RULE).moveTo(left, y).lineTo(right, y).stroke().restore()
}

/** Room for `needed` points, or a fresh page. */
function room(doc, y, needed) {
  const bottom = doc.page.height - doc.page.margins.bottom
  if (y + needed <= bottom) return y
  doc.addPage()
  return doc.page.margins.top
}

const SIGNATURE_LINE = /^\s*signature\s*:\s*/i
const DATE_LINE = /^\s*date\s*:\s*/i
const plainOf = (runs) => (Array.isArray(runs) ? runs.map((run) => run.text).join('') : '')

/**
 * Write one invisible (white) tag at the end of a label line already drawn at `top`: `lineIndex`
 * lines down, past the label (`Signature: `), where the underscores are. The page's cursor is
 * left where it was.
 */
function drawTagOnLine(doc, tag, lines, lineIndex, { left, top, width }) {
  const above = lineIndex === 0 ? 0 : doc.heightOfString(lines.slice(0, lineIndex).join('\n'), { width, lineGap: 2 })
  const label = (lines[lineIndex].match(/^\s*[A-Za-z]+\s*:\s*/) ?? [''])[0]
  const keepX = doc.x
  const keepY = doc.y
  doc
    .save()
    .font(REGULAR)
    .fontSize(10.5)
    .fillColor(TAG_COLOR)
    .text(tag, left + doc.widthOfString(label), top + above, { lineBreak: false })
    .restore()
  doc.x = keepX
  doc.y = keepY
}

function drawLetter(doc, { bodyText, paragraphRuns, client, firmSettings, dateLabel, signatureTags = false }) {
  const left = doc.page.margins.left
  const right = doc.page.width - doc.page.margins.right
  const width = right - left
  const top = doc.page.margins.top

  /* ---- firm header ---------------------------------------------------- */
  const firmName = String(firmSettings?.name ?? '').trim() || DEFAULT_FIRM_NAME
  const svg = decodeSvgLogo(firmSettings?.logoUrl)
  if (svg) {
    try {
      SVGtoPDF(doc, svg, right - LOGO_WIDTH, top, {
        width: LOGO_WIDTH,
        height: LOGO_HEIGHT,
        preserveAspectRatio: 'xMaxYMin meet',
      })
    } catch (error) {
      console.error('[letter-pdf] could not draw the firm logo:', error?.message || error)
    }
  }
  const headerWidth = width - LOGO_WIDTH - 18
  doc.font(BOLD).fontSize(15).fillColor(INK).text(firmName, left, top, { width: headerWidth })
  const detailLines = firmDetailLines(firmSettings)
  if (detailLines.length > 0) {
    doc
      .font(REGULAR)
      .fontSize(9)
      .fillColor(MUTED)
      .text(detailLines.join('\n'), left, doc.y + 3, { width: headerWidth, lineGap: 1 })
  }
  let y = Math.max(doc.y, top + LOGO_HEIGHT) + 16
  rule(doc, y, left, right)
  y += 22

  /* ---- date and addressee --------------------------------------------- */
  const date = String(dateLabel ?? '').trim()
  if (date) {
    doc.font(REGULAR).fontSize(10.5).fillColor(INK).text(date, left, y, { width })
    y = doc.y + 16
  }
  const clientName = String(client?.name ?? '').trim()
  const addressee = [clientName, ...mailingAddressLines(client)].filter(Boolean)
  if (addressee.length > 0) {
    doc.font(REGULAR).fontSize(10.5).fillColor(INK).text(addressee.join('\n'), left, y, {
      width,
      lineGap: 2,
    })
    y = doc.y + 20
  }

  /* ---- the letter ------------------------------------------------------ */
  // The runs as lib/letter-documents.js read them (bold found before the values were
  // filled in), or, called with text alone, `**bold**` read from that text.
  const paragraphs = Array.isArray(paragraphRuns) ? paragraphRuns : letterParagraphs(bodyText)
  doc.font(REGULAR).fontSize(10.5)
  // With signature tags: the LAST paragraph with a "Signature:" line is the one signed on.
  let signingParagraph = -1
  if (signatureTags) {
    paragraphs.forEach((runs, index) => {
      if (plainOf(runs).split('\n').some((line) => SIGNATURE_LINE.test(line))) signingParagraph = index
    })
  }
  for (const [paragraphIndex, runs] of paragraphs.entries()) {
    // One text call per run, chained with `continued` so the runs share the
    // paragraph's lines and wrap as one block of text.
    if (!Array.isArray(runs) || runs.length === 0) continue
    const plain = runs.map((run) => run.text).join('')
    const height = doc.heightOfString(plain, { width, lineGap: 2 })
    // The signing paragraph is kept whole on one page (the tags and the lines they sit on must share a
    // page); any other paragraph only needs room for its start.
    y = room(doc, y, (paragraphIndex === signingParagraph ? height : Math.min(height, 120)) + 10)
    const paragraphTop = y
    if (paragraphIndex === signingParagraph) {
      // The tags go UNDER the paragraph: white ink first, then the letter's own ink over it, so a tag
      // never paints a white gap into the underscores of the signature line.
      const lines = plain.split('\n')
      const place = { left, top: paragraphTop, width }
      drawTagOnLine(doc, SIGNATURE_TAG, lines, lines.findIndex((line) => SIGNATURE_LINE.test(line)), place)
      const dateAt = lines.findIndex((line) => DATE_LINE.test(line))
      if (dateAt !== -1) drawTagOnLine(doc, DATE_TAG, lines, dateAt, place)
    }
    doc.fillColor(INK)
    runs.forEach((run, index) => {
      const options = { width, lineGap: 2, continued: index < runs.length - 1 }
      // A SignWell field tag the letter carries (`{{initial:1:y}}`, task 17) is drawn in white where it was
      // typed: it keeps its room on the line for SignWell's field and is never seen. Same on a plain send.
      doc.font(run.bold && !run.esignTag ? BOLD : REGULAR).fillColor(run.esignTag ? TAG_COLOR : INK)
      // SignWell reads a tag only on one line, and a label's hyphen or slash is a break point: a tag that
      // does not fit the rest of this line ends it and starts the next one, whole. `continuedX` is pdfkit's
      // width already used on the line by the runs before (pinned by the tests: a tag never wraps).
      const used = run.esignTag && index > 0 ? Number(doc._wrapper?.continuedX) : 0
      if (Number.isFinite(used) && used > 0 && used + doc.widthOfString(run.text) > width) {
        doc.text('', { width, lineGap: 2, continued: false })
        doc.text(run.text, left, doc.y + doc.currentLineHeight(true) + 2, options)
      } else if (index === 0) doc.text(run.text, left, y, options)
      else doc.text(run.text, options)
    })
    doc.font(REGULAR).fillColor(INK)
    y = doc.y + 10
  }
  // No "Signature:" line in the letter (she wrote her own closing): add one, so the signer always has
  // somewhere to sign.
  if (signatureTags && signingParagraph === -1) {
    y = room(doc, y + 8, 50)
    // Tags first (white), the visible lines over them, as above.
    const place = { left, top: y, width }
    doc.font(REGULAR).fontSize(10.5)
    drawTagOnLine(doc, SIGNATURE_TAG, FALLBACK_SIGNATURE_LINES, 0, place)
    drawTagOnLine(doc, DATE_TAG, FALLBACK_SIGNATURE_LINES, 1, place)
    doc.fillColor(INK).text(FALLBACK_SIGNATURE_LINES.join('\n'), left, y, { width, lineGap: 2 })
    y = doc.y + 10
  }

  /* ---- footer --------------------------------------------------------- */
  const footer = [firmName, firmSettings?.email, firmSettings?.phone]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join('  ·  ')
  y = room(doc, y + 18, 20)
  doc.font(REGULAR).fontSize(8.5).fillColor(MUTED).text(footer, left, y, { width, align: 'center' })
}

/**
 * Render one engagement letter to a PDF buffer.
 *
 * @param {object} args
 * @param {string} args.bodyText         the letter, placeholders already filled; blank lines start a paragraph
 * @param {Array<Array<{text: string, bold: boolean, esignTag?: true}>>} [args.paragraphs]  the letter as runs
 *                                       (lib/letter-bold.js `letterParagraphs`); drawn instead of `bodyText` when
 *                                       given. An `esignTag` run is drawn in white, in place.
 * @param {object} args.client           printed as the addressee: its name and mailing address
 * @param {object} [args.firmSettings]   name, logo, address and contact of the firm
 * @param {string} [args.dateLabel]      the date line, e.g. "October 8, 2026"
 * @param {string} [args.title]          the document's Title property
 * @param {boolean} [args.compress]      off makes the text readable out of the buffer
 * @param {boolean} [args.signatureTags] write SignWell's signature and date text tags, in white, at the
 *                                       letter's "Signature:" and "Date:" lines (a plain send leaves it off)
 * @returns {Promise<Buffer>}
 */
export function buildLetterPdf({
  bodyText,
  paragraphs = null,
  client,
  firmSettings = null,
  dateLabel = '',
  title = '',
  compress = true,
  signatureTags = false,
}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: MARGIN,
      compress,
      info: {
        Title: String(title ?? '').trim() || `Letter for ${String(client?.name ?? '').trim()}`.trim(),
        Author: String(firmSettings?.name ?? '').trim() || DEFAULT_FIRM_NAME,
      },
    })
    const chunks = []
    doc.on('data', (chunk) => chunks.push(chunk))
    doc.on('error', reject)
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    try {
      drawLetter(doc, { bodyText, paragraphRuns: paragraphs, client, firmSettings, dateLabel, signatureTags })
      doc.end()
    } catch (error) {
      reject(error)
    }
  })
}

/** "Acme Books" + 2026 -> "Engagement-Letter-Acme-Books-2026.pdf", with anything path-ish stripped. */
export function letterPdfFilename(client, year) {
  const slug = (value) =>
    String(value ?? '')
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[.-]+|[.-]+$/g, '')
  return `${['Engagement-Letter', slug(client?.name) || 'client', slug(year)].filter(Boolean).join('-')}.pdf`
}
