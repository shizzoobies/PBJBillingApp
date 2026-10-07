import { describe, expect, it } from 'vitest'

import { buildInvoiceEmail } from './invoice-email.js'
import { buildInvoicePdf } from './invoice-pdf.js'

/**
 * Billing period (stage 2): an anchor-month invoice carries `prepayment` lines for
 * the later months. The client reads them under their own "Prepayment" heading with
 * a section total on every document - the PDF, the email (html and text) - and the
 * total due includes them. (The in-app print sheet renders the same sections; its
 * test is src/__tests__/invoice-print-prepayment.test.tsx.)
 */

const client = { id: 'c1', name: 'Clover Ridge Dental', contactName: 'Ann Reyes', email: 'ann@acme.com', contactIds: [] }

const invoice = {
  id: 'inv-1',
  number: 'INV-2026-10-001',
  period: '2026-10',
  status: 'sent',
  kind: 'monthly',
  lineItems: [
    { kind: 'plan', label: 'Monthly service', detail: 'Monthly service', amount: 500 },
    { kind: 'prepayment', label: 'Prepayment for November 2026', detail: '', amount: 500, period: '2026-11' },
    { kind: 'prepayment', label: 'Prepayment for December 2026', detail: '', amount: 500, period: '2026-12' },
  ],
  subtotal: 1500,
  total: 1500,
  dueDate: '2026-11-30',
  blurb: '',
  sentAt: '2026-10-31T10:00:00.000Z',
  createdAt: '2026-10-01T00:00:00.000Z',
}

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

describe('prepayment lines on the client documents', () => {
  it('the email shows a Prepayment section, its rows and its total, and the amount due', () => {
    const { html, text } = buildInvoiceEmail({ invoice, client, payUrl: 'https://checkout.stripe.com/x' })
    for (const surface of [html, text]) {
      expect(surface).toContain('Prepayment')
      expect(surface).toContain('Prepayment for November 2026')
      expect(surface).toContain('Prepayment for December 2026')
      expect(surface).toContain('Total Prepayment')
      expect(surface).toContain('$1,000.00')
      expect(surface).toContain('$1,500.00')
    }
    expect(html).toContain('Pay $1,500.00')
    // Subscription Plan first, Prepayment after it.
    expect(text.indexOf('Total Subscription Plan')).toBeLessThan(text.indexOf('Total Prepayment'))
  })

  it('the PDF shows the Prepayment section with its rows, its total and the total due', async () => {
    const text = pdfText(await buildInvoicePdf({ invoice, client, firmSettings: { name: 'PB&J' }, compress: false }))
    expect(text).toContain('Prepayment for November 2026')
    expect(text).toContain('Prepayment for December 2026')
    expect(text).toContain('Total Prepayment')
    expect(text).toContain('$1,000.00')
    expect(text).toContain('$1,500.00')
    expect(text.indexOf('Total Subscription Plan')).toBeLessThan(text.indexOf('Total Prepayment'))
  })

  it('a master with a billing period still shows the prepayment rows beside its one combined line', () => {
    const master = { ...client, id: 'master', isBillingMaster: true }
    const combined = {
      ...invoice,
      lineItems: [
        { kind: 'plan', label: 'Sub A fee', detail: '', amount: 500, sourceClientId: 'sub-a' },
        ...invoice.lineItems.slice(1),
      ],
    }
    const { html, text } = buildInvoiceEmail({ invoice: combined, client: master })
    expect(text).toContain('Prepayment for November 2026')
    expect(text).toContain('Prepayment for December 2026')
    expect(html).not.toContain('Sub A fee')
    expect(text).not.toContain('Sub A fee')
  })
})
