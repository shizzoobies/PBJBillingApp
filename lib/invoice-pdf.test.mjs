import { describe, expect, it } from 'vitest'

import { buildInvoicePdf, decodeSvgLogo, invoicePdfFilename } from './invoice-pdf.js'

/**
 * The invoice PDF — the copy of the invoice that leaves our systems entirely.
 *
 * Everything here asserts on the REAL bytes rather than on an intermediate
 * model, because the failure this guards against is a document that renders
 * blank, or silently loses a line, and still returns a perfectly valid Buffer.
 *
 * PDFs are built with compression off so the text is readable straight out of
 * the buffer. `pdfText` below is the reader: PDFKit writes each drawn line as a
 * `TJ` array of hex-encoded WinAnsi runs (the numbers between them are kerning
 * adjustments), so the text is reassembled by concatenating the runs. Assertions
 * stay on ASCII substrings for that reason — an em dash is one byte in WinAnsi
 * and three in UTF-8, and comparing the two proves nothing about the PDF.
 */
function pdfText(buffer) {
  const raw = buffer.toString('latin1')
  const runs = []
  for (const match of raw.matchAll(/\[([^\]]*)\]\s*TJ/g)) runs.push(match[1])
  for (const match of raw.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) runs.push(`<${match[1]}>`)
  return runs
    .map((run) =>
      [...run.matchAll(/<([0-9A-Fa-f]*)>/g)]
        .map((hex) => Buffer.from(hex[1], 'hex').toString('latin1'))
        .join(''),
    )
    .join('\n')
}

/** How many pages the document actually has — `/Type /Pages` is the tree, not a page. */
function pageCount(buffer) {
  return (buffer.toString('latin1').match(/\/Type \/Page[^s]/g) ?? []).length
}

const svgDataUrl = (svg) =>
  `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`

const LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40">' +
  '<path d="M0 0 H120 V40 H0 Z" fill="#7d2a4d"/></svg>'

const firmSettings = {
  name: 'PB&J Strategic Accounting',
  tagline: 'Strategic bookkeeping',
  logoUrl: svgDataUrl(LOGO_SVG),
  city: 'Austin',
  state: 'TX',
  postalCode: '78701',
}

const client = {
  id: 'c1',
  name: 'Clover Ridge Dental',
  contactName: 'Ann Reyes',
  email: 'ann@acme.com',
  paymentTerms: 'Net 15',
  footerNote: 'Thank you for trusting us.',
}

function invoice(overrides = {}) {
  return {
    id: 'inv-1',
    number: 'INV-2026-08-001',
    period: '2026-08',
    status: 'sent',
    lineItems: [
      { kind: 'plan', label: 'Monthly service', detail: 'Monthly service', amount: 900 },
      { kind: 'reimbursement', label: 'Reimbursement: Filing fee', detail: 'Aug 3, 2026', amount: 45 },
    ],
    subtotal: 945,
    total: 945,
    dueDate: '2026-09-15',
    blurb: 'Thanks for a great month.',
    sentAt: '2026-08-11T10:00:00.000Z',
    paidAt: null,
    paymentMethod: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

const render = (overrides = {}, settings = firmSettings) =>
  buildInvoicePdf({ invoice: invoice(overrides), client, firmSettings: settings, compress: false })

describe('buildInvoicePdf', () => {
  it('produces a real PDF', async () => {
    const buffer = await render()
    expect(Buffer.isBuffer(buffer)).toBe(true)
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(buffer.length).toBeGreaterThan(1000)
  })

  it('carries the number, the client, every line label and the total', async () => {
    const text = pdfText(await render())

    expect(text).toContain('Invoice INV-2026-08-001')
    expect(text).toContain('August 2026')
    expect(text).toContain('Clover Ridge Dental')
    expect(text).toContain('Ann Reyes')
    expect(text).toContain('Monthly service')
    expect(text).toContain('Reimbursement: Filing fee')
    expect(text).toContain('$945.00')
    expect(text).toContain('Total due')
    expect(text).toContain('Payment terms: Net 15')
    expect(text).toContain('Thanks for a great month.')
    expect(text).toContain('Thank you for trusting us.')
    expect(text).toContain('September 15, 2026')
  })

  // The lines are the record. Re-sorting them in the PDF would make the document
  // the client files disagree with the one in the app.
  it('keeps the lines in stored order', async () => {
    const text = pdfText(await render())
    expect(text.indexOf('Monthly service')).toBeLessThan(text.indexOf('Reimbursement: Filing fee'))
  })

  it('says nothing about payment while the invoice is unpaid', async () => {
    expect(pdfText(await render())).not.toContain('PAID')
  })
})

/**
 * The PAID stamp. The single most common reason anyone reopens an invoice PDF
 * is to check whether it was paid, so the answer is a banner, and it names both
 * the date and the channel — "we paid that" / "we paid that by card" are
 * different conversations.
 */
describe('the PAID stamp', () => {
  it('stamps a bank-transfer payment with its date and method', async () => {
    const text = pdfText(
      await render({
        status: 'paid',
        paidAt: '2026-08-20T15:00:00.000Z',
        paymentMethod: 'us_bank_account',
      }),
    )
    expect(text).toContain('PAID')
    expect(text).toContain('Paid August 20, 2026 by bank transfer')
  })

  it('stamps a card payment as card', async () => {
    const text = pdfText(
      await render({ status: 'paid', paidAt: '2026-08-20T15:00:00.000Z', paymentMethod: 'card' }),
    )
    expect(text).toContain('Paid August 20, 2026 by card')
  })

  // A card-paid invoice already carries its fee line by the time this renders —
  // the store appended it when the payment landed. No special-casing here.
  it('shows the card fee line a card payment added, in the total', async () => {
    const text = pdfText(
      await render({
        status: 'paid',
        paidAt: '2026-08-20T15:00:00.000Z',
        paymentMethod: 'card',
        lineItems: [
          { kind: 'plan', label: 'Monthly service', detail: 'Monthly service', amount: 900 },
          { kind: 'card-fee', label: 'Card processing fee', detail: 'Paid by card', amount: 27.14 },
        ],
        subtotal: 927.14,
        total: 927.14,
      }),
    )
    expect(text).toContain('Card processing fee')
    expect(text).toContain('$927.14')
  })

  it('still stamps PAID when the paid date is missing', async () => {
    const text = pdfText(await render({ status: 'paid', paidAt: null, paymentMethod: 'card' }))
    expect(text).toContain('PAID')
    expect(text).toContain('Paid by card')
  })
})

/**
 * The logo. `logoUrl` is whatever a FileReader made of the file the owner
 * uploaded in Settings, so it is not guaranteed to be an SVG — or to be
 * anything at all. None of those cases may stop an invoice going out.
 */
describe('the firm logo', () => {
  it('draws an SVG logo into the document', async () => {
    const withLogo = await render()
    const withoutLogo = await render({}, { ...firmSettings, logoUrl: '' })
    // The vector path is real content: the file with a logo is measurably bigger.
    expect(withLogo.length).toBeGreaterThan(withoutLogo.length)
  })

  it('falls back to the firm name when there is no logo at all', async () => {
    const text = pdfText(await render({}, { ...firmSettings, logoUrl: '' }))
    expect(text).toContain('PB&J Strategic Accounting')
  })

  it('falls back to the firm name for a non-SVG logo', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
    const text = pdfText(await render({}, { ...firmSettings, logoUrl: png }))
    expect(text).toContain('PB&J Strategic Accounting')
  })

  it('renders with no firm settings whatsoever', async () => {
    const buffer = await buildInvoicePdf({ invoice: invoice(), client, compress: false })
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(pdfText(buffer)).toContain('PB&J Strategic Accounting')
  })
})

describe('decodeSvgLogo', () => {
  it('decodes a base64 SVG data-URL', () => {
    expect(decodeSvgLogo(svgDataUrl(LOGO_SVG))).toBe(LOGO_SVG)
  })

  it('decodes a URL-encoded SVG data-URL', () => {
    const url = `data:image/svg+xml,${encodeURIComponent(LOGO_SVG)}`
    expect(decodeSvgLogo(url)).toBe(LOGO_SVG)
  })

  it('returns null for anything that is not an SVG we can draw', () => {
    expect(decodeSvgLogo('')).toBeNull()
    expect(decodeSvgLogo(null)).toBeNull()
    expect(decodeSvgLogo('https://example.com/logo.svg')).toBeNull()
    expect(decodeSvgLogo('data:image/png;base64,iVBORw0KGgo=')).toBeNull()
    expect(decodeSvgLogo('data:image/svg+xml;base64')).toBeNull()
    expect(decodeSvgLogo('data:image/svg+xml;base64,bm90IGFuIHN2Zw==')).toBeNull()
  })
})

describe('a long invoice', () => {
  it('flows onto a second page instead of running off the first', async () => {
    const lineItems = Array.from({ length: 60 }, (_, index) => ({
      kind: 'hourly',
      label: `Billable hours line ${index + 1}`,
      detail: '4h at $150.00/hr',
      amount: 600,
    }))
    const buffer = await render({ lineItems, subtotal: 36000, total: 36000 })

    expect(pageCount(buffer)).toBeGreaterThan(1)
    const text = pdfText(buffer)
    expect(text).toContain('Billable hours line 1')
    expect(text).toContain('Billable hours line 60')
    expect(text).toContain('$36,000.00')
  })

  it('stays on one page for a typical invoice', async () => {
    expect(pageCount(await render())).toBe(1)
  })
})

describe('invoicePdfFilename', () => {
  it('names the file after the invoice number', () => {
    expect(invoicePdfFilename({ number: 'INV-2026-08-001' })).toBe('INV-2026-08-001.pdf')
  })

  it('never produces a path out of a numberless or hostile invoice', () => {
    expect(invoicePdfFilename({ number: null })).toBe('invoice.pdf')
    expect(invoicePdfFilename({})).toBe('invoice.pdf')
    expect(invoicePdfFilename({ number: '../../etc/passwd' })).toBe('etc-passwd.pdf')
  })
})
