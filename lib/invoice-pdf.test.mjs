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

/**
 * The three sections (featreq-97ae3214).
 *
 * Her wording is the point: the headings and the section-total labels come off
 * `invoiceSections`, so the PDF, the email and the print sheet cannot word the
 * same invoice differently. Asserted on the drawn text, and the totals are
 * asserted as the SUM OF THE ROWS ABOVE THEM — that is Alex's constraint on
 * this feature, stated on the document a client reads.
 *
 * `fieldLabel` uppercases, so a section heading reads SUBSCRIPTION PLAN on the
 * page while the section-total labels keep her capitalization.
 */
describe('the invoice’s sections', () => {
  const SECTIONED_LINES = [
    { kind: 'plan', label: 'Monthly service', detail: 'Monthly service', amount: 900 },
    { kind: 'hourly', label: 'Billable hours - unassigned', detail: '1h', amount: 100 },
    {
      kind: 'hourly',
      label: 'Billable hours - Brittany Ferguson',
      detail: '3.5h at $150.00/hr',
      amount: 525,
      roleTier: 'CFO',
    },
    {
      kind: 'hourly',
      label: 'Billable hours - Kim Ledger',
      detail: '2h at $100.00/hr',
      amount: 200,
      roleTier: 'Accountant',
    },
    {
      kind: 'adhoc',
      label: 'Billable hours - Lisa Mockabee',
      detail: '4h at $125.00/hr',
      amount: 500,
      roleTier: 'Bookkeeper',
    },
    { kind: 'reimbursement', label: 'Reimbursement: Filing fee', detail: 'Aug 3, 2026', amount: 45 },
    { kind: 'card-fee', label: 'Card processing fee', detail: 'Paid by card', amount: 12 },
  ]

  const sectioned = () =>
    render({ lineItems: SECTIONED_LINES, subtotal: 2270, total: 2282 })

  it('heads each block with her title', async () => {
    const text = pdfText(await sectioned())
    expect(text).toContain('SUBSCRIPTION PLAN')
    expect(text).toContain('AD-HOC / BILLABLE HOURS')
    expect(text).toContain('CLIENT REIMBURSED EXPENSES')
  })

  it('closes each block with a total in her wording', async () => {
    const text = pdfText(await sectioned())
    expect(text).toContain('Total Subscription Plan')
    expect(text).toContain('Total Ad-Hoc/Billable Hours')
    expect(text).toContain('Total Client Reimbursed Expenses')
    // Never the bare word — a combined-mode test asserts its absence.
    expect(text).not.toContain('Subtotal Subscription')
  })

  // The constraint Alex attached to this feature, read straight off the page.
  it('states a section total that equals the sum of the rows above it', async () => {
    const text = pdfText(await sectioned())
    expect(text).toMatch(/Total Subscription Plan\n\$900\.00/)
    // 100 + 525 + 200 + 500
    expect(text).toMatch(/Total Ad-Hoc\/Billable Hours\n\$1,325\.00/)
    expect(text).toMatch(/Total Client Reimbursed Expenses\n\$45\.00/)
  })

  it('sub-heads the hours by role, in the fixed order', async () => {
    const text = pdfText(await sectioned())
    const at = (needle) => text.indexOf(needle)
    expect(at('CFO / Advisory Services')).toBeGreaterThan(-1)
    expect(at('CFO / Advisory Services')).toBeLessThan(at('Accounting Services'))
    expect(at('Accounting Services')).toBeLessThan(at('Bookkeeping Services'))
    // A row with no role is printed first and untitled, never under a guess.
    expect(at('Billable hours - unassigned')).toBeLessThan(at('CFO / Advisory Services'))
  })

  it('leaves the charges block untitled and un-totaled', async () => {
    const text = pdfText(await sectioned())
    expect(text).toContain('Card processing fee')
    expect(text).not.toContain('Total Card')
    expect(text).not.toContain('CHARGES')
  })
})

/**
 * The letterhead and the footer, per her markup: no tagline, the number as a
 * field of its own, "Invoice Date" rather than "Issued", and the period spelled
 * out so nobody reads it as the invoice's date.
 */
describe('the letterhead and the footer', () => {
  it('labels the number, the invoice date and the due date', async () => {
    const text = pdfText(await render())
    expect(text).toContain('INVOICE NO.')
    expect(text).toContain('INVOICE DATE')
    expect(text).toContain('DUE')
    expect(text).toContain('August 11, 2026')
    expect(text).not.toContain('Issued')
    expect(text).not.toContain('ISSUED')
  })

  it('names the billing period in words', async () => {
    expect(pdfText(await render())).toContain('Billing Period: August 2026')
  })

  it('drops the firm tagline from the letterhead', async () => {
    const buffer = await render()
    expect(pdfText(buffer)).not.toContain('Strategic bookkeeping')
    expect(buffer.toString('latin1')).not.toContain('Strategic bookkeeping')
    // The rest of the identity block is still there.
    expect(pdfText(buffer)).toContain('Austin, TX, 78701')
  })

  it('signs off with her sentence when the client has no note of its own', async () => {
    const buffer = await buildInvoicePdf({
      invoice: invoice(),
      client: { ...client, footerNote: '' },
      firmSettings,
      compress: false,
    })
    expect(pdfText(buffer)).toContain(
      'Spread success, not stress, thanks for choosing PB&J Strategic Accounting.',
    )
  })

  it('still lets a per-client footer note win', async () => {
    expect(pdfText(await render())).toContain('Thank you for trusting us.')
  })
})

/**
 * Page 2 — the detailed hours.
 *
 * Every `time_detail` row is $0.00 by invariant, so moving the block onto its
 * own page cannot move a total. The breakdown is OFF for every client today,
 * which is why the one-page case is asserted beside the two-page one.
 */
describe('page 2 — the detailed hours', () => {
  const DETAIL_LINES = [
    { kind: 'time_detail', label: 'Lisa Mockabee', detail: 'Aug 6, 2026 - 2.28 hours', amount: 0 },
    { kind: 'time_detail', label: 'Lisa Mockabee', detail: 'Aug 7, 2026 - 3.10 hours', amount: 0 },
  ]

  it('gives an invoice WITH a breakdown a second page, headed', async () => {
    const buffer = await render({
      lineItems: [...invoice().lineItems, ...DETAIL_LINES],
    })
    expect(pageCount(buffer)).toBe(2)
    const text = pdfText(buffer)
    expect(text).toContain('Detailed Hours')
    expect(text).toContain('Aug 6, 2026 - 2.28 hours')
    // The heading sits AFTER the totals block it is an appendix to.
    expect(text.indexOf('Total due')).toBeLessThan(text.indexOf('Detailed Hours'))
  })

  it('leaves an invoice WITHOUT one on a single page', async () => {
    const buffer = await render()
    expect(pageCount(buffer)).toBe(1)
    expect(pdfText(buffer)).not.toContain('Detailed Hours')
  })

  // The rows are informational: a column of $0.00 beside an hours listing reads
  // as a bug, and the money is stated by the section above.
  it('prints no amount column on the appendix', async () => {
    const text = pdfText(await render({ lineItems: [...invoice().lineItems, ...DETAIL_LINES] }))
    expect(text).not.toContain('$0.00')
  })
})

/**
 * The KLC combined document (Brittany's Q3 answer: "2").
 *
 * Asserted on the REAL bytes, like everything else here, and mostly with
 * NEGATIVES: a sub company's name must not be findable in the file a client
 * receives. This is the one thing a send cannot take back.
 */
describe('buildInvoicePdf — the combined master document', () => {
  const masterClient = {
    id: 'client-master',
    name: 'KLC Master',
    contactName: 'Kelly Lane',
    paymentTerms: 'Net 15',
    footerNote: 'Thank you for trusting us.',
    isBillingMaster: true,
  }

  const masterInvoice = (over = {}) =>
    invoice({
      lineItems: [
        { kind: 'hourly', label: 'Billable hours line Lisa Chemtrex', detail: 'Chemtrex 3.5h', amount: 262.5, sourceClientId: 'client-chemtrex' },
        { kind: 'recurring', label: 'QuickBooks Online XAct', detail: 'Covers September 1 to September 30', amount: 90, sourceClientId: 'client-xact' },
        { kind: 'plan', label: 'Monthly service Bright Tower', detail: 'August', amount: 592.5, sourceClientId: 'client-bt' },
      ],
      subtotal: 945,
      total: 945,
      ...over,
    })

  const renderMaster = (over = {}, who = masterClient) =>
    buildInvoicePdf({
      invoice: masterInvoice(over),
      client: who,
      firmSettings,
      compress: false,
    })

  it('prints ONE description line, named for the month', async () => {
    const text = pdfText(await renderMaster())
    expect(text).toContain('Bookkeeping services')
    expect(text).toContain('August 2026')
    expect(text.split('Bookkeeping services').length - 1).toBe(1)
  })

  it('names no sub company anywhere in the file', async () => {
    const buffer = await renderMaster()
    const text = pdfText(buffer)
    for (const name of ['Chemtrex', 'XAct', 'Bright Tower', 'Lisa']) {
      expect(text).not.toContain(name)
      // Belt and braces: not in the raw bytes either, metadata included.
      expect(buffer.toString('latin1')).not.toContain(name)
    }
  })

  it('suppresses the coverage window the reimbursement line carries', async () => {
    const text = pdfText(await renderMaster())
    expect(text).not.toContain('Covers')
    expect(text).not.toContain('September 1 to September 30')
    // The due date is still a September date — that one belongs on the page.
    expect(text).toContain('September 15, 2026')
  })

  // One line stating the total, and one Total due beneath it. A Subtotal row
  // could only repeat the figure or contradict it.
  it('drops the subtotal row and keeps the total', async () => {
    const text = pdfText(await renderMaster())
    expect(text).not.toContain('Subtotal')
    expect(text).toContain('Total due')
    expect(text).toContain('$945.00')
  })

  /**
   * The sections are suppressed WHOLESALE here, headings included. A master's
   * resolved document is one line that fits none of her three names, and a
   * per-section total there would restate the split the client chose to hide.
   */
  it('renders no section heading and no section total', async () => {
    const text = pdfText(await renderMaster())
    for (const heading of [
      'SUBSCRIPTION PLAN',
      'Subscription Plan',
      'AD-HOC / BILLABLE HOURS',
      'Ad-Hoc / Billable Hours',
      'CLIENT REIMBURSED EXPENSES',
      'Client Reimbursed Expenses',
      'Total Subscription Plan',
      'Total Ad-Hoc/Billable Hours',
      'Total Client Reimbursed Expenses',
      'Bookkeeping Services',
      'CFO / Advisory Services',
    ]) {
      expect(text).not.toContain(heading)
    }
  })

  // `time_detail` does not survive the merge, so a master's page 2 would be
  // blank. It is not opened at all.
  it('never opens a page 2, even with a breakdown stored', async () => {
    const buffer = await renderMaster({
      lineItems: [
        ...masterInvoice().lineItems,
        { kind: 'time_detail', label: 'Lisa', detail: 'Aug 6 - 2.28 hours', amount: 0 },
      ],
    })
    expect(pageCount(buffer)).toBe(1)
    expect(pdfText(buffer)).not.toContain('Detailed Hours')
  })

  it('keeps the firm header, bill-to, due date, terms and blurb intact', async () => {
    const text = pdfText(await renderMaster())
    expect(text).toContain('PB&J Strategic Accounting')
    expect(text).toContain('Invoice INV-2026-08-001')
    expect(text).toContain('KLC Master')
    expect(text).toContain('Kelly Lane')
    expect(text).toContain('September 15, 2026')
    expect(text).toContain('Payment terms: Net 15')
    expect(text).toContain('Thanks for a great month.')
    expect(text).toContain('Thank you for trusting us.')
  })

  // The symptom this guards: a card-paid receipt showing one line at the
  // fee-inclusive total, never mentioning the fee the email promised to state.
  it('still states the card processing fee on a card-paid receipt', async () => {
    const text = pdfText(
      await renderMaster({
        status: 'paid',
        paymentMethod: 'card',
        paidAt: '2026-09-02T10:00:00.000Z',
        lineItems: [
          ...masterInvoice().lineItems,
          { kind: 'card-fee', label: 'Card processing fee', detail: 'Paid by card', amount: 28.69 },
        ],
        total: 973.69,
      }),
    )
    expect(text).toContain('Bookkeeping services')
    expect(text).toContain('Card processing fee')
    expect(text).toContain('$945.00') // the combined line, fee excluded
    expect(text).toContain('$28.69')
    expect(text).toContain('$973.69') // total due, both together
    // Still no company names on the document that states the fee.
    for (const name of ['Chemtrex', 'XAct', 'Bright Tower']) expect(text).not.toContain(name)
  })

  // The regression that matters: an ordinary client's PDF did not move.
  it('leaves an ordinary client’s invoice exactly as it was', async () => {
    const text = pdfText(await renderMaster({}, client))
    expect(text).toContain('Billable hours line Lisa Chemtrex')
    expect(text).toContain('Monthly service Bright Tower')
    expect(text).toContain('Subtotal')
    expect(text).not.toContain('Bookkeeping services')
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
