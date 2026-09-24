/**
 * The proposal as a PDF (featreq-311473e2, spec §5.4): the document a prospect
 * reads, forwards and signs off on.
 *
 * Server-side pdfkit like the invoice PDF (lib/invoice-pdf.js), so it runs on
 * Railway with no browser. Every figure on it comes from the proposal's stored
 * `pricingSnapshot` — the calculator's answer — and the letter text is the one
 * she edited. Nothing here prices anything.
 */

import PDFDocument from 'pdfkit'
import SVGtoPDF from 'svg-to-pdfkit'

import { firmDetailLines } from './firm-lines.js'
import { decodeSvgLogo } from './invoice-pdf.js'
import { PROPOSAL_GROUPS, formatProposalMoney } from './proposal-pricing.js'

const DEFAULT_FIRM_NAME = 'PB&J Strategic Accounting'
const REGULAR = 'Helvetica'
const BOLD = 'Helvetica-Bold'
// The invoice PDF's palette, so the two documents are recognizably one firm.
const INK = '#1f1d1a'
const MUTED = '#7d7269'
const RULE = '#ece8e1'
const MARGIN = 54
const LOGO_WIDTH = 150
const LOGO_HEIGHT = 46

const TOTAL_ROWS = [
  ['monthly', 'Monthly fee'],
  ['annual', 'Annual fees'],
  ['oneTime', 'One-time fees'],
  ['cleanup', 'Clean-up'],
]

/** "August 11, 2026" for a Date. */
function longDateOf(date) {
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

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

function drawProposal(doc, { proposal, firmSettings, preparedOn }) {
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
      console.error('[proposal-pdf] could not draw the firm logo:', error?.message || error)
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
  y += 18

  /* ---- title and prospect ---------------------------------------------- */
  doc.font(BOLD).fontSize(20).fillColor(INK).text('Proposal', left, y, { width })
  doc
    .font(REGULAR)
    .fontSize(11)
    .fillColor(MUTED)
    .text(`Prepared ${longDateOf(preparedOn)}`, left, doc.y + 3, { width })
  y = doc.y + 16

  const prospect = proposal?.prospect ?? {}
  doc.font(BOLD).fontSize(8).fillColor(MUTED).text('PREPARED FOR', left, y, { width })
  doc
    .font(BOLD)
    .fontSize(12)
    .fillColor(INK)
    .text(String(prospect.company || prospect.contactName || ''), left, doc.y + 3, { width })
  const prospectLines = [prospect.company ? prospect.contactName : '', prospect.email, prospect.phone]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
  if (prospectLines.length > 0) {
    doc.font(REGULAR).fontSize(9.5).fillColor(MUTED).text(prospectLines.join('\n'), left, doc.y + 2, {
      width,
      lineGap: 1,
    })
  }
  y = doc.y + 20

  /* ---- the letter she edited ----------------------------------------- */
  const headings = new Set(
    (Array.isArray(proposal?.letter?.sections) ? proposal.letter.sections : []).map((section) =>
      String(section?.heading ?? '').trim(),
    ),
  )
  const paragraphs = String(proposal?.letter?.text ?? '')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
  for (const paragraph of paragraphs) {
    const isHeading = headings.has(paragraph)
    doc.font(isHeading ? BOLD : REGULAR).fontSize(isHeading ? 12 : 10.5)
    y = room(doc, y, doc.heightOfString(paragraph, { width }) + 8)
    doc.fillColor(INK).text(paragraph, left, y, { width, lineGap: 2 })
    y = doc.y + (isHeading ? 4 : 10)
  }

  /* ---- the pricing table ---------------------------------------------- */
  const lines = Array.isArray(proposal?.pricingSnapshot?.lines) ? proposal.pricingSnapshot.lines : []
  const totals = proposal?.pricingSnapshot?.totals ?? {}
  y = room(doc, y + 8, 60)
  doc.font(BOLD).fontSize(14).fillColor(INK).text('Pricing', left, y, { width })
  y = doc.y + 6
  rule(doc, y, left, right)
  y += 8
  const amountWidth = 110
  for (const group of PROPOSAL_GROUPS) {
    const rows = lines.filter((line) => line.group === group)
    if (rows.length === 0) continue
    y = room(doc, y, 40)
    doc.font(BOLD).fontSize(8).fillColor(MUTED).text(group.toUpperCase(), left, y, {
      width,
      characterSpacing: 0.6,
    })
    y = doc.y + 4
    for (const line of rows) {
      y = room(doc, y, 18)
      const label = line.tier ? `${line.name} (${line.tier})` : line.name
      doc.font(REGULAR).fontSize(10).fillColor(INK).text(label, left, y, {
        width: width - amountWidth - 12,
      })
      const isPriced = Number(line.amount) > 0
      doc
        .font(REGULAR)
        .fontSize(10)
        .fillColor(isPriced ? INK : MUTED)
        .text(isPriced ? formatProposalMoney(line.amount) : 'Not yet priced', right - amountWidth, y, {
          width: amountWidth,
          align: 'right',
        })
      y = doc.y + 4
    }
    y += 6
  }
  rule(doc, y, left, right)
  y += 8
  for (const [key, label] of TOTAL_ROWS) {
    const value = Number(totals[key]) || 0
    if (value <= 0) continue
    y = room(doc, y, 20)
    doc.font(BOLD).fontSize(11).fillColor(INK).text(label, left, y, {
      width: width - amountWidth - 12,
    })
    doc.text(formatProposalMoney(value), right - amountWidth, y, { width: amountWidth, align: 'right' })
    y = doc.y + 6
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
 * Render one proposal to a PDF buffer.
 *
 * @param {object} args
 * @param {object} args.proposal      the stored proposal (prospect, letter, snapshot)
 * @param {object} [args.firmSettings] name, logo and address of the firm
 * @param {Date} [args.preparedOn]    the date printed under the title (tests pin it)
 * @param {boolean} [args.compress]   off makes the text readable out of the buffer
 * @returns {Promise<Buffer>}
 */
export function buildProposalPdf({
  proposal,
  firmSettings = null,
  preparedOn = new Date(),
  compress = true,
}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: MARGIN,
      compress,
      info: {
        Title: `Proposal for ${String(proposal?.prospect?.company || proposal?.prospect?.contactName || '').trim()}`.trim(),
        Author: String(firmSettings?.name ?? '').trim() || DEFAULT_FIRM_NAME,
      },
    })
    const chunks = []
    doc.on('data', (chunk) => chunks.push(chunk))
    doc.on('error', reject)
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    try {
      drawProposal(doc, { proposal, firmSettings, preparedOn })
      doc.end()
    } catch (error) {
      reject(error)
    }
  })
}

/** "Acme Books" -> "Proposal-Acme-Books.pdf", with anything path-ish stripped. */
export function proposalPdfFilename(proposal) {
  const name = String(proposal?.prospect?.company || proposal?.prospect?.contactName || proposal?.id || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
  return `Proposal-${name || 'draft'}.pdf`
}
