/**
 * The invoice as a PDF — the thing a client files, forwards to their
 * bookkeeper, or hands to an auditor two years from now.
 *
 * Server-side and pure-JS (pdfkit + svg-to-pdfkit), so it runs on Railway with
 * no headless browser and no network round-trip. The content deliberately
 * mirrors the app's PRINT view rather than the email: the email is the payment
 * vehicle and can afford to be a summary, while this is the document of record
 * and has to stand alone.
 *
 * Money is formatted with `currency` from `lib/invoice-lines.js` — the ONE
 * money formatter — for the same reason the lines themselves come from one
 * calculator: an invoice and its PDF disagreeing by a cent is the kind of thing
 * an accounting firm gets asked about.
 *
 * Nothing here throws on bad input. A missing logo, an absent due date, a junk
 * amount: each degrades to something sensible, because the alternative is an
 * invoice email that does not go out.
 */

import PDFDocument from 'pdfkit'
import SVGtoPDF from 'svg-to-pdfkit'

import { longDate, paymentMethodLabel } from './invoice-email.js'
import { currency, getBillingPeriodLabel, renderedInvoiceLines } from './invoice-lines.js'

const DEFAULT_FIRM_NAME = 'PB&J Strategic Accounting'

const REGULAR = 'Helvetica'
const BOLD = 'Helvetica-Bold'

// The app's own palette, so the PDF and the screen are recognizably one thing.
const INK = '#1f1d1a'
const MUTED = '#7d7269'
const ACCENT = '#7d2a4d'
const RULE = '#ece8e1'

const MARGIN = 54
const LOGO_WIDTH = 150
const LOGO_HEIGHT = 46

/**
 * Decode the firm logo when — and only when — it is an SVG we can draw.
 *
 * `logoUrl` is whatever a FileReader produced from the file the owner uploaded
 * in Settings, so it can be an SVG data-URL, a PNG/JPEG data-URL, a remote URL,
 * or empty. Only SVG is rendered here (svg-to-pdfkit draws paths natively);
 * everything else returns null and the header falls back to the firm name in
 * text, which every invoice carries anyway.
 *
 * @returns {string|null} the SVG source, or null when there is nothing to draw
 */
export function decodeSvgLogo(logoUrl) {
  const value = String(logoUrl ?? '').trim()
  if (!value.toLowerCase().startsWith('data:image/svg+xml')) return null
  const comma = value.indexOf(',')
  if (comma === -1) return null
  const meta = value.slice(0, comma).toLowerCase()
  const payload = value.slice(comma + 1)
  try {
    const svg = meta.includes(';base64')
      ? Buffer.from(payload, 'base64').toString('utf8')
      : decodeURIComponent(payload)
    return svg.includes('<svg') ? svg : null
  } catch {
    // A truncated data-URL is not worth failing a send over.
    return null
  }
}

/** The firm's identity block under its name: tagline, address, contact. */
function firmDetailLines(firmSettings) {
  const cityLine = [firmSettings?.city, firmSettings?.state, firmSettings?.postalCode]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join(', ')
  return [
    firmSettings?.tagline,
    firmSettings?.addressLine1,
    firmSettings?.addressLine2,
    cityLine,
    firmSettings?.phone,
    firmSettings?.email,
  ]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
}

/** "2026-08-11T14:02:00.000Z" -> "August 11, 2026". Anything else -> ''. */
function stampDate(value) {
  return longDate(String(value ?? '').slice(0, 10))
}

/** A hairline the full width of the content column. */
function rule(doc, y, left, right) {
  doc.save().lineWidth(0.75).strokeColor(RULE).moveTo(left, y).lineTo(right, y).stroke().restore()
}

/** Small uppercase field label, the same one the print sheet uses. */
function fieldLabel(doc, text, x, y, width, align = 'left') {
  doc
    .font(BOLD)
    .fontSize(8)
    .fillColor(MUTED)
    .text(String(text).toUpperCase(), x, y, { width, align, characterSpacing: 0.6 })
}

/**
 * The PAID banner.
 *
 * Deliberately loud and near the top: the single most common reason anyone
 * reopens an invoice PDF is to check whether it was paid, and the answer should
 * not require reading the status of a line item. A card-paid invoice needs no
 * special-casing here — its fee line is already in the stored lines by the time
 * this runs.
 */
function drawPaidBanner(doc, invoice, { x, y, width }) {
  const height = 52
  doc.save()
  doc.roundedRect(x, y, width, height, 6).lineWidth(1.25).strokeColor(ACCENT).stroke()
  doc.font(BOLD).fontSize(17).fillColor(ACCENT).text('PAID', x + 16, y + 9, { width: width - 32 })
  const on = stampDate(invoice?.paidAt)
  const how = paymentMethodLabel(invoice?.paymentMethod).toLowerCase()
  doc
    .font(REGULAR)
    .fontSize(10)
    .fillColor(INK)
    .text(on ? `Paid ${on} by ${how}` : `Paid by ${how}`, x + 16, y + 31, { width: width - 32 })
  doc.restore()
  return y + height + 20
}

/** Column geometry for the line-items table, derived once from the page. */
function tableColumns(left, width) {
  return {
    label: { x: left, w: width * 0.46 },
    detail: { x: left + width * 0.48, w: width * 0.3 },
    amount: { x: left + width * 0.79, w: width * 0.21 },
  }
}

/** The table's heading row. Redrawn at the top of every page it flows onto. */
function drawTableHeader(doc, cols, { y, left, right }) {
  fieldLabel(doc, 'Description', cols.label.x, y, cols.label.w)
  fieldLabel(doc, 'Detail', cols.detail.x, y, cols.detail.w)
  fieldLabel(doc, 'Amount', cols.amount.x, y, cols.amount.w, 'right')
  rule(doc, y + 14, left, right)
  return y + 22
}

/**
 * The line items, in STORED order — the order is part of the record and the
 * PDF is not the place to re-sort it. Ad hoc lines the owner omitted are the
 * one thing dropped, through the shared filter every surface uses; they carry
 * $0.00, so the totals below are unaffected either way.
 */
function drawLineItems(doc, invoice, cols, { y, left, right, bottom }) {
  let cursor = y
  for (const item of renderedInvoiceLines(invoice?.lineItems)) {
    const label = String(item?.label ?? '')
    const detail = String(item?.detail ?? '')
    const amount = currency.format(Number(item?.amount) || 0)

    doc.font(REGULAR).fontSize(10)
    const height = Math.max(
      doc.heightOfString(label, { width: cols.label.w }),
      doc.heightOfString(detail, { width: cols.detail.w }),
      12,
    )
    // Flow onto a second page rather than running off the first one, and carry
    // the column headings across so the continuation is readable on its own.
    if (cursor + height + 10 > bottom) {
      doc.addPage()
      cursor = drawTableHeader(doc, cols, { y: doc.page.margins.top, left, right })
    }

    doc.fillColor(INK).font(REGULAR).fontSize(10).text(label, cols.label.x, cursor, {
      width: cols.label.w,
    })
    doc.fillColor(MUTED).fontSize(9).text(detail, cols.detail.x, cursor + 1, {
      width: cols.detail.w,
    })
    doc.fillColor(INK).fontSize(10).text(amount, cols.amount.x, cursor, {
      width: cols.amount.w,
      align: 'right',
    })
    cursor += height + 8
    rule(doc, cursor - 4, left, right)
  }
  return cursor
}

/** One right-hand totals row: a label over the detail column, a figure over amount. */
function drawTotalRow(doc, cols, { y, label, value, strong }) {
  doc
    .font(strong ? BOLD : REGULAR)
    .fontSize(strong ? 12 : 10)
    .fillColor(strong ? INK : MUTED)
    .text(label, cols.detail.x, y, { width: cols.detail.w, align: 'right' })
  doc
    .font(strong ? BOLD : REGULAR)
    .fontSize(strong ? 12 : 10)
    .fillColor(INK)
    .text(value, cols.amount.x, y, { width: cols.amount.w, align: 'right' })
  return y + (strong ? 20 : 16)
}

/** Everything on the page, in reading order. */
function drawInvoice(doc, { invoice, client, firmSettings }) {
  const left = doc.page.margins.left
  const right = doc.page.width - doc.page.margins.right
  const width = right - left
  const bottom = doc.page.height - doc.page.margins.bottom

  /* ---- firm header ---------------------------------------------------- */
  const firmName = String(firmSettings?.name ?? '').trim() || DEFAULT_FIRM_NAME
  const top = doc.page.margins.top
  const svg = decodeSvgLogo(firmSettings?.logoUrl)
  if (svg) {
    try {
      SVGtoPDF(doc, svg, right - LOGO_WIDTH, top, {
        width: LOGO_WIDTH,
        height: LOGO_HEIGHT,
        preserveAspectRatio: 'xMaxYMin meet',
      })
    } catch (error) {
      // A logo that will not parse is a cosmetic problem. The firm name below
      // is the fallback, and it is already on the page.
      console.error('[invoice-pdf] could not draw the firm logo:', error?.message || error)
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

  /* ---- invoice title -------------------------------------------------- */
  const number = String(invoice?.number ?? '').trim()
  doc
    .font(BOLD)
    .fontSize(20)
    .fillColor(INK)
    .text(number ? `Invoice ${number}` : 'Invoice', left, y, { width })
  y = doc.y + 3
  const period = String(invoice?.period ?? '')
  if (/^\d{4}-\d{2}$/.test(period)) {
    doc.font(REGULAR).fontSize(11).fillColor(MUTED).text(getBillingPeriodLabel(period), left, y, {
      width,
    })
    y = doc.y
  }
  y += 18

  if (invoice?.status === 'paid') y = drawPaidBanner(doc, invoice, { x: left, y, width })

  /* ---- bill-to and dates ---------------------------------------------- */
  const columnWidth = (width - 24) / 2
  const metaTop = y
  fieldLabel(doc, 'Bill to', left, metaTop, columnWidth)
  doc
    .font(BOLD)
    .fontSize(12)
    .fillColor(INK)
    .text(String(client?.name ?? ''), left, doc.y + 3, { width: columnWidth })
  const billToDetails = [client?.contactName, client?.email, client?.phone]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
  if (billToDetails.length > 0) {
    doc
      .font(REGULAR)
      .fontSize(9.5)
      .fillColor(MUTED)
      .text(billToDetails.join('\n'), left, doc.y + 2, { width: columnWidth, lineGap: 1 })
  }
  const billToBottom = doc.y

  const dateColumnX = left + columnWidth + 24
  let dateY = metaTop
  for (const [label, value] of [
    ['Issued', stampDate(invoice?.sentAt ?? invoice?.createdAt)],
    ['Due', longDate(invoice?.dueDate)],
  ]) {
    if (!value) continue
    fieldLabel(doc, label, dateColumnX, dateY, columnWidth, 'right')
    doc
      .font(REGULAR)
      .fontSize(11)
      .fillColor(INK)
      .text(value, dateColumnX, doc.y + 2, { width: columnWidth, align: 'right' })
    dateY = doc.y + 10
  }

  y = Math.max(billToBottom, dateY) + 22

  /* ---- line items ----------------------------------------------------- */
  const cols = tableColumns(left, width)
  y = drawTableHeader(doc, cols, { y, left, right })
  y = drawLineItems(doc, invoice, cols, { y, left, right, bottom })

  y += 8
  y = drawTotalRow(doc, cols, {
    y,
    label: 'Subtotal',
    value: currency.format(Number(invoice?.subtotal) || 0),
    strong: false,
  })
  y = drawTotalRow(doc, cols, {
    y,
    label: 'Total due',
    value: currency.format(Number(invoice?.total) || 0),
    strong: true,
  })
  y += 14

  /* ---- terms, note, footer -------------------------------------------- */
  const terms = String(client?.paymentTerms ?? '').trim()
  if (terms) {
    doc.font(REGULAR).fontSize(10).fillColor(MUTED).text(`Payment terms: ${terms}`, left, y, {
      width,
    })
    y = doc.y + 10
  }

  const blurb = String(invoice?.blurb ?? '').trim()
  if (blurb) {
    doc.font(REGULAR).fontSize(10).fillColor(INK).text(blurb, left, y, { width, lineGap: 2 })
    y = doc.y + 12
  }

  const footerNote = String(client?.footerNote ?? '').trim()
  doc
    .font(REGULAR)
    .fontSize(9)
    .fillColor(MUTED)
    .text(footerNote || `Thank you for trusting ${firmName}.`, left, y, { width, lineGap: 1 })
}

/**
 * Render one invoice to a PDF buffer.
 *
 * @param {object} args
 * @param {object} args.invoice   the STORED invoice — lines, totals, status
 * @param {object} args.client    the client it bills (name, contact, terms)
 * @param {object} [args.firmSettings] name, logo and address of the firm
 * @param {boolean} [args.compress] stream compression; off makes the text
 *   readable straight out of the buffer, which is how the tests assert on it
 * @returns {Promise<Buffer>}
 */
export function buildInvoicePdf({ invoice, client, firmSettings = null, compress = true }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: MARGIN,
      compress,
      info: {
        Title: `Invoice ${String(invoice?.number ?? '').trim()}`.trim(),
        Author: String(firmSettings?.name ?? '').trim() || DEFAULT_FIRM_NAME,
      },
    })
    const chunks = []
    doc.on('data', (chunk) => chunks.push(chunk))
    doc.on('error', reject)
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    try {
      drawInvoice(doc, { invoice, client, firmSettings })
      doc.end()
    } catch (error) {
      reject(error)
    }
  })
}

/** `INV-2026-08-001` -> `INV-2026-08-001.pdf`, with anything path-ish stripped. */
export function invoicePdfFilename(invoice) {
  const number = String(invoice?.number ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    // Nothing leading or trailing that reads as a path or a hidden file.
    .replace(/^[.-]+|[.-]+$/g, '')
  return `${number || 'invoice'}.pdf`
}
