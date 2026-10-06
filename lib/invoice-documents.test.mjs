import { describe, expect, it } from 'vitest'
import { buildInvoiceDocuments } from './invoice-documents.js'
import { buildInvoiceEmail } from './invoice-email.js'
import { invoicePdfFilename } from './invoice-pdf.js'

/**
 * The email and the PDF a client receives are built in ONE place
 * (featreq-459bdfc2 item 3): the send route and the preview route both call
 * this, so the preview is what the send builds by construction.
 */

const invoice = {
  id: 'inv-1',
  number: 'INV-2026-09-001',
  clientId: 'c1',
  period: '2026-09',
  kind: 'monthly',
  status: 'reviewed',
  lineItems: [{ kind: 'service', label: 'Monthly bookkeeping', detail: '', amount: 500 }],
  subtotal: 500,
  total: 500,
  dueDate: null,
  blurb: '',
  sentAt: '2026-09-30T12:00:00.000Z',
  paidAt: null,
}
const client = {
  id: 'c1',
  name: 'Acme LLC',
  contactIds: [],
  footerNote: 'Thank you for your business.',
  paymentTerms: '',
}
const firmSettings = { name: 'PB&J Strategic Accounting' }

describe('buildInvoiceDocuments', () => {
  it('builds the email and the PDF from the same invoice, client and firm', async () => {
    const docs = await buildInvoiceDocuments({
      invoice,
      client,
      firmSettings,
      payUrl: 'https://app.test/pay/tok',
    })
    expect(docs.email.subject).toBe('Invoice INV-2026-09-001 from PB&J Strategic Accounting')
    expect(docs.email.html).toContain('Thank you for your business.')
    expect(docs.email.html).toContain('https://app.test/pay/tok')
    expect(docs.email.text).toContain('INV-2026-09-001')
    expect(Buffer.isBuffer(docs.pdf)).toBe(true)
    expect(docs.pdfFilename).toBe(invoicePdfFilename(invoice))
    expect(docs.pdfError).toBeNull()
  })

  // The refactor's whole claim: the send route used to call buildInvoiceEmail
  // itself with exactly these arguments. The email must be the same one.
  it('builds the very email the send route used to build by hand', async () => {
    const payUrl = 'https://app.test/pay/tok'
    const cardPayUrl = 'https://app.test/pay/tok/card'
    const docs = await buildInvoiceDocuments({ invoice, client, firmSettings, payUrl, cardPayUrl })
    expect(docs.email).toEqual(
      buildInvoiceEmail({
        invoice,
        client,
        payUrl,
        cardPayUrl,
        autopay: null,
        footerNote: client.footerNote,
        firmName: firmSettings.name,
        firmSettings,
      }),
    )
    expect(docs.email.html).toContain(cardPayUrl)
  })

  it('falls back to the builder\'s own firm name when there are no firm settings', async () => {
    const docs = await buildInvoiceDocuments({ invoice, client, firmSettings: null })
    expect(docs.email.subject).toBe('Invoice INV-2026-09-001 from PB&J Strategic Accounting')
    expect(docs.email).toEqual(
      buildInvoiceEmail({ invoice, client, autopay: null, footerNote: client.footerNote, firmSettings: null }),
    )
  })

  it('keeps the email when the PDF cannot be built, and says why', async () => {
    const docs = await buildInvoiceDocuments({
      invoice,
      client,
      firmSettings,
      buildPdf: async () => {
        throw new Error('boom')
      },
    })
    expect(docs.email.subject).toContain('INV-2026-09-001')
    expect(docs.pdf).toBeNull()
    expect(docs.pdfError?.message).toBe('boom')
  })

  it('passes an autopay send through, which drops the pay button', async () => {
    const docs = await buildInvoiceDocuments({
      invoice,
      client,
      firmSettings,
      payUrl: 'https://app.test/pay/tok',
      autopay: {
        chargedAmount: 500,
        cardFee: 0,
        methodWords: 'bank account ending in 1234',
        withdrawUrl: 'https://app.test/autopay/x/withdraw',
      },
    })
    expect(docs.email.html).not.toContain('https://app.test/pay/tok')
    expect(docs.email.html).toContain('bank account ending in 1234')
  })
})
