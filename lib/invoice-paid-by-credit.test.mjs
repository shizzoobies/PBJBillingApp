import { describe, expect, it } from 'vitest'

import {
  creditPaymentWords,
  invoiceAsPaidByCredit,
  invoiceCoveredByCredit,
  invoicePaidByCreditAtSend,
} from './invoice-lines.js'
import { buildInvoiceEmail, paymentMethodLabel } from './invoice-email.js'
import { buildInvoiceDocuments } from './invoice-documents.js'
import { buildInvoicePdf } from './invoice-pdf.js'
import { paymentEmailKindFor } from './invoice-email.js'

/**
 * Credit on account, stage 1d: an invoice a credit line covers in full is PAID by
 * credit at Send, and every paid invoice's email says it is paid. The store half
 * (the stamp on both backends) is in db/store-staleness.test.mjs; the route's
 * wiring is in lib/invoice-paid-by-credit-routes.test.mjs.
 */

const service = { kind: 'service', label: 'Monthly bookkeeping', detail: '', amount: 500 }
const accountCredit = (amount = -500, label = 'Credit on account') => ({
  kind: 'account_credit',
  label,
  detail: '',
  amount,
  draws: [{ creditId: 'cr-1', amount: Math.abs(amount) }],
})
const retainerCredit = (amount = -500) => ({
  kind: 'retainer_credit',
  label: 'Retainer applied — credit',
  detail: 'Retainer INV-RET-1',
  amount,
  retainerInvoiceId: 'ret-1',
})

const invoice = (over = {}) => ({
  id: 'inv-1',
  number: 'INV-2026-10-001',
  clientId: 'c1',
  period: '2026-10',
  kind: 'monthly',
  status: 'reviewed',
  lineItems: [service, accountCredit()],
  subtotal: 500,
  total: 0,
  dueDate: null,
  blurb: '',
  sentAt: '2026-10-31T12:00:00.000Z',
  paidAt: null,
  paymentMethod: null,
  ...over,
})
const client = { id: 'c1', name: 'Acme LLC', contactIds: [], footerNote: '', paymentTerms: '' }
const firmSettings = { name: 'PB&J Strategic Accounting' }

const paidBy = (method, over = {}) =>
  invoice({
    status: 'paid',
    paymentMethod: method,
    paidAt: '2026-10-31T15:00:00.000Z',
    ...over,
  })

/** The text runs of a rendered PDF, as the PDF suite reads them (hex-encoded TJ/Tj runs). */
function textOf(buffer) {
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
async function pdfText(inv) {
  return textOf(await buildInvoicePdf({ invoice: inv, client, firmSettings, compress: false }))
}

describe('which invoices a credit pays at Send', () => {
  it('is a $0 invoice with an account credit line, or a retainer credit line, or both', () => {
    expect(invoiceCoveredByCredit(invoice())).toBe(true)
    expect(invoiceCoveredByCredit(invoice({ lineItems: [service, retainerCredit()] }))).toBe(true)
    expect(
      invoiceCoveredByCredit(
        invoice({ lineItems: [service, retainerCredit(-200), accountCredit(-300)] }),
      ),
    ).toBe(true)
  })

  it('is NOT a genuine nothing-to-bill $0 invoice (no credit line)', () => {
    expect(
      invoiceCoveredByCredit(
        invoice({ lineItems: [{ kind: 'service', label: 'Nothing', detail: '', amount: 0 }], subtotal: 0 }),
      ),
    ).toBe(false)
    expect(invoiceCoveredByCredit(invoice({ lineItems: [] }))).toBe(false)
  })

  it('is NOT a partly covered invoice: that one goes out for the remainder', () => {
    expect(
      invoiceCoveredByCredit(invoice({ lineItems: [service, accountCredit(-200)], total: 300 })),
    ).toBe(false)
  })

  it('is not an invoice whose credit line carries no money', () => {
    expect(invoiceCoveredByCredit(invoice({ lineItems: [service, accountCredit(0)] }))).toBe(false)
    expect(invoiceCoveredByCredit(null)).toBe(false)
  })

  it('is stamped only before money has moved: not paid, processing or void', () => {
    for (const status of ['draft', 'reviewed', 'sent', 'overdue']) {
      expect(invoicePaidByCreditAtSend(invoice({ status }))).toBe(true)
    }
    for (const status of ['paid', 'processing', 'void']) {
      expect(invoicePaidByCreditAtSend(invoice({ status }))).toBe(false)
    }
  })

  it('reads as paid by credit, at the stamp, for the preview', () => {
    const as = invoiceAsPaidByCredit(invoice(), '2026-10-31T15:00:00.000Z')
    expect(as).toMatchObject({
      status: 'paid',
      paymentMethod: 'credit',
      paidAt: '2026-10-31T15:00:00.000Z',
    })
  })
})

describe('how the credit is named', () => {
  it('is "credit on account", or "your prepayment" when the credit was meant for a month', () => {
    expect(creditPaymentWords(invoice())).toBe('credit on account')
    expect(creditPaymentWords(invoice({ lineItems: [service, retainerCredit()] }))).toBe('credit on account')
    expect(
      creditPaymentWords(
        invoice({ lineItems: [service, accountCredit(-500, 'Credit on account - meant for October 2026')] }),
      ),
    ).toBe('your prepayment')
  })

  it('labels the credit method everywhere paymentMethodLabel is used', () => {
    expect(paymentMethodLabel('credit')).toBe('Credit on account')
    // The others are unchanged.
    expect(paymentMethodLabel('card')).toBe('Card')
    expect(paymentMethodLabel('us_bank_account')).toBe('Bank transfer')
  })
})

describe('the invoice email for a PAID invoice', () => {
  const build = (inv, extra = {}) => buildInvoiceEmail({ invoice: inv, client, firmSettings, ...extra })

  it.each([
    ['credit', 'Paid October 31, 2026 by credit on account'],
    ['card', 'Paid October 31, 2026 by card'],
    ['us_bank_account', 'Paid October 31, 2026 by bank transfer'],
  ])('says it is paid in full when paid by %s', (method, line) => {
    const { html, text } = build(paidBy(method))
    for (const body of [html, text]) {
      expect(body).toContain('Paid in full - nothing is owed')
      expect(body).toContain(line)
      expect(body).not.toContain('Amount due')
      expect(body).not.toContain('due on receipt')
      expect(body).not.toContain('Total due')
    }
    expect(text).not.toMatch(/Amount due/i)
  })

  it('says "your prepayment" when the credit carried a month', () => {
    const inv = paidBy('credit', {
      lineItems: [service, accountCredit(-500, 'Credit on account - meant for October 2026')],
    })
    const { html, text } = build(inv)
    expect(html).toContain('Paid October 31, 2026 by your prepayment')
    expect(text).toContain('Paid October 31, 2026 by your prepayment')
  })

  it('a hand-recorded payment reads "Paid <date>" with no method', () => {
    const { html, text } = build(paidBy('manual'))
    expect(html).toContain('Paid in full - nothing is owed')
    expect(text).toContain('Paid October 31, 2026')
    expect(text).not.toMatch(/by manual/i)
    expect(html).not.toMatch(/by manual/i)
  })

  it('names the day in the firm\'s zone: 9 pm Eastern on the 31st is still the 31st', () => {
    // 01:00 UTC on November 1 is 9 pm Eastern on October 31.
    const { text } = build(paidBy('credit', { paidAt: '2026-11-01T01:00:00.000Z' }))
    expect(text).toContain('Paid October 31, 2026 by credit on account')
  })

  it('never carries a pay button, a card link or an autopay promise, whatever it is handed', () => {
    const { html, text } = build(paidBy('credit'), {
      payUrl: 'https://app.test/pay/tok',
      cardPayUrl: 'https://app.test/pay/tok/card',
      autopay: {
        chargedAmount: 500,
        cardFee: 0,
        methodWords: 'your bank account',
        withdrawUrl: 'https://app.test/autopay/x/withdraw',
      },
    })
    for (const body of [html, text]) {
      expect(body).not.toContain('https://app.test/pay/tok')
      expect(body).not.toContain('withdraw')
    }
  })

  it('still lists the lines, the credit line and the total', () => {
    const { html, text } = build(paidBy('credit'))
    expect(html).toContain('Monthly bookkeeping')
    expect(html).toContain('Credit on account')
    expect(text).toContain('Credit on account')
    expect(text).toContain('Total: $0.00')
  })

  it('leaves an UNPAID invoice\'s email exactly as it was', () => {
    const unpaid = invoice({ status: 'sent', total: 500, lineItems: [service], subtotal: 500 })
    const { html, text } = build(unpaid)
    expect(html).toContain('Amount due')
    expect(html).toContain('is due on receipt')
    expect(text).toContain('Total due: $500.00')
    expect(html).not.toContain('Paid in full')
  })

  it('a $0 invoice with no credit line (nothing to bill) is not called paid', () => {
    const zero = invoice({
      status: 'sent',
      lineItems: [{ kind: 'service', label: 'Nothing', detail: '', amount: 0 }],
      subtotal: 0,
    })
    expect(build(zero).html).not.toContain('Paid in full')
  })
})

describe('the PDF for a credit-paid invoice', () => {
  it('stamps PAID and names the credit', async () => {
    const text = await pdfText(paidBy('credit'))
    expect(text).toContain('PAID')
    expect(text).toContain('Paid October 31, 2026 by credit on account')
  })

  it('names the prepayment when the credit carried a month', async () => {
    const text = await pdfText(
      paidBy('credit', {
        lineItems: [service, accountCredit(-500, 'Credit on account - meant for October 2026')],
      }),
    )
    expect(text).toContain('Paid October 31, 2026 by your prepayment')
  })

  it('says only the date for a hand-recorded payment', async () => {
    const text = await pdfText(paidBy('manual'))
    expect(text).toContain('Paid October 31, 2026')
    expect(text).not.toMatch(/by manual/i)
  })
})

describe('the preview builds the same paid copy as the send', () => {
  it('buildInvoiceDocuments on the as-paid invoice is the paid email and the PAID PDF', async () => {
    const stamp = '2026-10-31T15:00:00.000Z'
    const docs = await buildInvoiceDocuments({
      invoice: invoiceAsPaidByCredit(invoice(), stamp),
      client,
      firmSettings,
      buildPdf: (args) => buildInvoicePdf({ ...args, compress: false }),
    })
    expect(docs.email.html).toContain('Paid in full - nothing is owed')
    expect(docs.email.text).toContain('Paid October 31, 2026 by credit on account')
    expect(docs.email).toEqual(
      buildInvoiceEmail({
        invoice: paidBy('credit', { paidAt: stamp }),
        client,
        firmSettings,
        footerNote: client.footerNote,
        firmName: firmSettings.name,
      }),
    )
    expect(Buffer.isBuffer(docs.pdf)).toBe(true)
    expect(textOf(docs.pdf)).toContain('by credit on account')
  })
})

describe('the webhook\'s receipt kind is untouched by a credit payment', () => {
  it('still answers a receipt for paid and an ack for a bank payment in flight', () => {
    expect(paymentEmailKindFor('paid', { isCard: false })).toBe('receipt')
    expect(paymentEmailKindFor('processing', { isCard: false })).toBe('ack')
  })
})
