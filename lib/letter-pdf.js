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
import { mailingAddressLines } from './mailing-address.js'

const DEFAULT_FIRM_NAME = 'PB&J Strategic Accounting'
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

function drawLetter(doc, { bodyText, client, firmSettings, dateLabel }) {
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
  const paragraphs = String(bodyText ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
  doc.font(REGULAR).fontSize(10.5)
  for (const paragraph of paragraphs) {
    y = room(doc, y, Math.min(doc.heightOfString(paragraph, { width, lineGap: 2 }), 120) + 10)
    doc.fillColor(INK).text(paragraph, left, y, { width, lineGap: 2 })
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
 * @param {object} args.client           printed as the addressee: its name and mailing address
 * @param {object} [args.firmSettings]   name, logo, address and contact of the firm
 * @param {string} [args.dateLabel]      the date line, e.g. "October 8, 2026"
 * @param {string} [args.title]          the document's Title property
 * @param {boolean} [args.compress]      off makes the text readable out of the buffer
 * @returns {Promise<Buffer>}
 */
export function buildLetterPdf({
  bodyText,
  client,
  firmSettings = null,
  dateLabel = '',
  title = '',
  compress = true,
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
      drawLetter(doc, { bodyText, client, firmSettings, dateLabel })
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
