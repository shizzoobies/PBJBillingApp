import { describe, expect, it } from 'vitest'
import { advanceOfferText } from './invoice-advance-offer.js'
import { buildInvoiceEmail } from './invoice-email.js'
import { renderedInvoiceLines } from './invoice-lines.js'
import { invoiceContentChanged } from './invoice-sent-change.js'
import { sanitizeInvoiceLines } from '../db/store.js'
import { handleAdvancePaymentRoute } from './advance-payment-routes.js'

const offer = { requestId: 'synthetic', number: 'ADV-SYNTHETIC', requestedCents: 150000, receivedCents: 0, outstandingCents: 150000, optional: true, forPeriod: null, url: `http://localhost/advance-pay/${'a'.repeat(48)}`, preparedAt: '2026-10-28', preparedBy: 'test-owner' }
const attachment = { kind: 'advance_request', label: 'Pay in advance amount', detail: '', amount: 0, advanceOffer: offer }
describe('combined service invoice and separate advance section', () => {
  it('shows the advance on a fully paid current invoice without increasing its total or service lines', () => {
    const invoice = { id: 'synthetic', number: 'INV-SYNTHETIC', period: '2026-10', status: 'paid', paidAt: '2026-10-28', total: 0, lineItems: [attachment] }
    const email = buildInvoiceEmail({ invoice, client: { name: 'Synthetic client' } })
    expect(email.text).toContain('Pay in advance amount')
    expect(email.text).toContain('Optional advance: $1,500.00')
    expect(email.html).toContain(`href="${offer.url}"`)
    expect(invoice.total).toBe(0)
    expect(renderedInvoiceLines(invoice.lineItems)).toEqual([])
  })
  it('includes optionality and statements in the delivery fingerprint; ordinary line edits cannot forge an advance', () => {
    expect(invoiceContentChanged({ lineItems: [attachment] }, { lineItems: [{ ...attachment, advanceOffer: { ...offer, optional: false } }] })).toBe(true)
    expect(sanitizeInvoiceLines([attachment])).toEqual([])
    expect(sanitizeInvoiceLines([{ ...attachment, amount: 999, advanceOffer: { ...offer, requestedCents: 1 } }], { storedLines: [attachment] })).toEqual([attachment])
    expect(advanceOfferText({ lineItems: [attachment] }).join(' ')).toContain('Only funds actually received')
  })
  it('renders a canceled durable request without creating checkout or exposing client details', async () => {
    let body = '', status = null
    const response = { writeHead: (value) => { status = value }, end: (value) => { body = value } }
    const result = await handleAdvancePaymentRoute({ request: { method: 'GET' }, response, pathname: `/advance-pay/${'a'.repeat(48)}`, store: { listAdvancePayments: async () => ({ requests: [{ ...offer, id: 'synthetic', publicToken: 'a'.repeat(48), canceledAt: '2026-10-28', outstandingCents: 0 }] }) } })
    expect(result).toBe(true); expect(status).toBe(200)
    expect(body).toContain('No further payment is requested')
    expect(body).not.toContain('<form')
    expect(body).not.toContain('Synthetic client')
  })
})
