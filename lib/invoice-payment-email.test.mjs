import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  PAYMENT_ACK_COPY,
  PAYMENT_RECEIPT_COPY,
  buildPaymentAckEmail,
  buildPaymentReceiptEmail,
  hasLoggedPaymentEmail,
  paymentEmailKindFor,
  paymentMethodLabel,
  sendInvoicePaymentEmail,
} from './invoice-email.js'
import { sendInvoiceEmail } from './notify.js'

/**
 * What a CLIENT receives once their money moves, and — much more importantly —
 * how many times they receive it.
 *
 * The webhook is retried by Stripe as a matter of course, and a bank payment
 * fires two events on its way through. Thanking a client twice for one payment
 * is the kind of thing that gets a bookkeeper a phone call, so there are TWO
 * independent guards and both are exercised here: the transition flag from the
 * store, and the `kind`-tagged entry in the invoice's own email log.
 */

const client = {
  id: 'c1',
  name: 'Clover Ridge Dental',
  email: 'ann@acme.com',
  contactIds: [],
}

function invoice(overrides = {}) {
  return {
    id: 'inv-1',
    number: 'INV-2026-08-001',
    period: '2026-08',
    status: 'processing',
    lineItems: [{ kind: 'plan', label: 'Monthly service', detail: '', amount: 945 }],
    subtotal: 945,
    total: 945,
    paidAt: null,
    paymentMethod: null,
    emailLog: [{ at: '2026-08-11T10:00:00.000Z', to: ['ann@acme.com'], subject: 'x', ok: true }],
    ...overrides,
  }
}

/** A transport and a log that remember what they were asked to do. */
function harness({ ok = true, error = null } = {}) {
  const sent = []
  const logged = []
  return {
    sent,
    logged,
    sendEmail: async (message) => {
      sent.push(message)
      return { ok, error }
    },
    recordSent: async (id, entry) => {
      logged.push({ id, ...entry })
    },
  }
}

const pdfAttachment = async () => [
  { filename: 'INV-2026-08-001.pdf', content: Buffer.from('%PDF-1.3 fake') },
]

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('paymentEmailKindFor', () => {
  it('acknowledges a bank payment that has started', () => {
    expect(paymentEmailKindFor('processing')).toBe('ack')
  })

  // A card settles in seconds. "Your receipt will follow in a few business
  // days" would be wrong twice over, so the card channel skips the ack.
  it('sends a card payment no acknowledgment at all', () => {
    expect(paymentEmailKindFor('processing', { isCard: true })).toBeNull()
  })

  it('receipts a completed payment on either channel', () => {
    expect(paymentEmailKindFor('paid')).toBe('receipt')
    expect(paymentEmailKindFor('paid', { isCard: true })).toBe('receipt')
  })

  it('says nothing for a status that is not about money moving', () => {
    for (const status of ['draft', 'reviewed', 'sent', 'overdue', 'void', undefined]) {
      expect(paymentEmailKindFor(status)).toBeNull()
    }
  })
})

describe('hasLoggedPaymentEmail', () => {
  it('tolerates the entries written before kinds existed', () => {
    expect(hasLoggedPaymentEmail(invoice(), 'receipt')).toBe(false)
    expect(hasLoggedPaymentEmail({}, 'ack')).toBe(false)
  })

  it('sees a successful send of that kind', () => {
    const withReceipt = invoice({
      emailLog: [{ at: '1', to: [], subject: '', ok: true, kind: 'receipt' }],
    })
    expect(hasLoggedPaymentEmail(withReceipt, 'receipt')).toBe(true)
    expect(hasLoggedPaymentEmail(withReceipt, 'ack')).toBe(false)
  })

  // A failed attempt is a record that we TRIED, not that the client was told.
  it('does not count a failed attempt as sent', () => {
    const failed = invoice({
      emailLog: [{ at: '1', to: [], subject: '', ok: false, kind: 'receipt' }],
    })
    expect(hasLoggedPaymentEmail(failed, 'receipt')).toBe(false)
  })
})

describe('the acknowledgment email', () => {
  it('says what arrived, for which invoice, and when the receipt follows', () => {
    const email = buildPaymentAckEmail({ invoice: invoice(), client })

    expect(email.subject).toBe(PAYMENT_ACK_COPY.subject('INV-2026-08-001'))
    for (const body of [email.html, email.text]) {
      expect(body).toContain('$945.00')
      expect(body).toContain('INV-2026-08-001')
      expect(body).toContain('few business days')
    }
    expect(email.text).toContain('Clover Ridge Dental')
  })
})

describe('the receipt email', () => {
  const paid = invoice({
    status: 'paid',
    paidAt: '2026-08-20T15:00:00.000Z',
    paymentMethod: 'us_bank_account',
  })

  it('gives the amount, the method, the date, the number and a thank-you', () => {
    const email = buildPaymentReceiptEmail({ invoice: paid, client })

    expect(email.subject).toBe(PAYMENT_RECEIPT_COPY.subject('INV-2026-08-001'))
    for (const body of [email.html, email.text]) {
      expect(body).toContain('$945.00')
      expect(body).toContain('Bank transfer')
      expect(body).toContain('August 20, 2026')
      expect(body).toContain('INV-2026-08-001')
      expect(body).toContain('Thank you for your business')
    }
  })

  it('mentions the attachment only when there is one', () => {
    expect(buildPaymentReceiptEmail({ invoice: paid, client }).text).toContain(
      PAYMENT_RECEIPT_COPY.attachment,
    )
    expect(
      buildPaymentReceiptEmail({ invoice: paid, client, hasAttachment: false }).text,
    ).not.toContain(PAYMENT_RECEIPT_COPY.attachment)
  })

  it('names the card channel when a card paid it', () => {
    const email = buildPaymentReceiptEmail({
      invoice: invoice({ status: 'paid', paidAt: '2026-08-20T15:00:00.000Z', paymentMethod: 'card' }),
      client,
    })
    expect(email.text).toContain('Card')
  })
})

describe('paymentMethodLabel', () => {
  it('says what a client would say', () => {
    expect(paymentMethodLabel('us_bank_account')).toBe('Bank transfer')
    expect(paymentMethodLabel('card')).toBe('Card')
    expect(paymentMethodLabel('')).toBe('Bank transfer')
    expect(paymentMethodLabel(null)).toBe('Bank transfer')
    expect(paymentMethodLabel('cashapp_pay')).toBe('Cashapp pay')
  })
})

/**
 * The ACH flow end to end: authorization, then settlement four business days
 * later. Two emails, in that order, and never the same one twice.
 */
describe('sendInvoicePaymentEmail — the bank-transfer flow', () => {
  it('acknowledges the authorization, with no attachment', async () => {
    const rail = harness()
    const result = await sendInvoicePaymentEmail({
      invoice: invoice({ status: 'processing' }),
      client,
      statusChanged: true,
      buildPdf: pdfAttachment,
      ...rail,
    })

    expect(result).toMatchObject({ kind: 'ack', sent: true })
    expect(rail.sent).toHaveLength(1)
    expect(rail.sent[0].to).toEqual(['ann@acme.com'])
    expect(rail.sent[0].attachments).toEqual([])
    expect(rail.logged[0]).toMatchObject({ id: 'inv-1', kind: 'ack', ok: true })
  })

  it('receipts the settlement, with the paid invoice attached', async () => {
    const rail = harness()
    const result = await sendInvoicePaymentEmail({
      invoice: invoice({ status: 'paid', paidAt: '2026-08-20T15:00:00.000Z' }),
      client,
      statusChanged: true,
      buildPdf: pdfAttachment,
      ...rail,
    })

    expect(result).toMatchObject({ kind: 'receipt', sent: true })
    expect(rail.sent[0].attachments).toHaveLength(1)
    expect(rail.sent[0].attachments[0].filename).toBe('INV-2026-08-001.pdf')
    expect(rail.logged[0]).toMatchObject({ kind: 'receipt', ok: true })
  })
})

/**
 * The card flow: straight to paid. One email, ever.
 */
describe('sendInvoicePaymentEmail — the card flow', () => {
  it('sends nothing on the moment a card payment passes through processing', async () => {
    const rail = harness()
    const result = await sendInvoicePaymentEmail({
      invoice: invoice({ status: 'processing' }),
      client,
      statusChanged: true,
      isCard: true,
      buildPdf: pdfAttachment,
      ...rail,
    })

    expect(result.kind).toBeNull()
    expect(rail.sent).toHaveLength(0)
    expect(rail.logged).toHaveLength(0)
  })

  it('receipts the card payment, and only receipts it', async () => {
    const rail = harness()
    const paid = invoice({
      status: 'paid',
      paidAt: '2026-08-20T15:00:00.000Z',
      paymentMethod: 'card',
      // The fee line the store appended when the payment landed.
      lineItems: [
        { kind: 'plan', label: 'Monthly service', detail: '', amount: 945 },
        { kind: 'card-fee', label: 'Card processing fee', detail: 'Paid by card', amount: 28.5 },
      ],
      total: 973.5,
    })

    const result = await sendInvoicePaymentEmail({
      invoice: paid,
      client,
      statusChanged: true,
      isCard: true,
      buildPdf: pdfAttachment,
      ...rail,
    })

    expect(result).toMatchObject({ kind: 'receipt', sent: true })
    expect(rail.sent).toHaveLength(1)
    // The amount quoted is what the card was actually charged, fee included.
    expect(rail.sent[0].text).toContain('$973.50')
  })
})

/**
 * Both send-once guards, separately. Stripe retries webhooks; neither guard on
 * its own is enough, so each is proven to stop a second email by itself.
 */
describe('sendInvoicePaymentEmail — sending once', () => {
  it('sends nothing when the status did not actually move', async () => {
    const rail = harness()
    const result = await sendInvoicePaymentEmail({
      invoice: invoice({ status: 'paid', paidAt: '2026-08-20T15:00:00.000Z' }),
      client,
      statusChanged: false,
      buildPdf: pdfAttachment,
      ...rail,
    })

    expect(result).toMatchObject({ kind: 'receipt', sent: false, reason: 'status_did_not_change' })
    expect(rail.sent).toHaveLength(0)
  })

  it('sends nothing when the log already shows that email went out', async () => {
    const rail = harness()
    const result = await sendInvoicePaymentEmail({
      invoice: invoice({
        status: 'paid',
        paidAt: '2026-08-20T15:00:00.000Z',
        emailLog: [{ at: '1', to: ['ann@acme.com'], subject: '', ok: true, kind: 'receipt' }],
      }),
      client,
      // Deliberately claiming a transition: the log alone must stop this.
      statusChanged: true,
      buildPdf: pdfAttachment,
      ...rail,
    })

    expect(result).toMatchObject({ sent: false, reason: 'already_sent' })
    expect(rail.sent).toHaveLength(0)
  })

  it('does not treat the invoice send itself as a receipt', async () => {
    const rail = harness()
    await sendInvoicePaymentEmail({
      invoice: invoice({ status: 'paid', paidAt: '2026-08-20T15:00:00.000Z' }),
      client,
      statusChanged: true,
      buildPdf: pdfAttachment,
      ...rail,
    })
    // The seeded log holds one untagged entry — the invoice going out.
    expect(rail.sent).toHaveLength(1)
  })

  it('says nothing to a client with no address on file', async () => {
    const rail = harness()
    const result = await sendInvoicePaymentEmail({
      invoice: invoice({ status: 'paid' }),
      client: { id: 'c2', name: 'No Contact Co', contactIds: [] },
      statusChanged: true,
      ...rail,
    })

    expect(result).toMatchObject({ sent: false, reason: 'no_recipient' })
    expect(rail.sent).toHaveLength(0)
    expect(rail.logged).toHaveLength(0)
  })
})

/**
 * Failure. The payment has already been recorded by the time any of this runs,
 * so nothing here may throw — the webhook has to answer 200 regardless.
 */
describe('sendInvoicePaymentEmail — when things go wrong', () => {
  it('sends the receipt without the PDF when the PDF will not build', async () => {
    const rail = harness()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await sendInvoicePaymentEmail({
      invoice: invoice({ status: 'paid', paidAt: '2026-08-20T15:00:00.000Z' }),
      client,
      statusChanged: true,
      buildPdf: async () => {
        throw new Error('pdfkit exploded')
      },
      ...rail,
    })

    expect(result.sent).toBe(true)
    expect(rail.sent[0].attachments).toEqual([])
    // ...and the body no longer promises an attachment that is not there.
    expect(rail.sent[0].text).not.toContain(PAYMENT_RECEIPT_COPY.attachment)
  })

  it('logs a refused send and reports it, without throwing', async () => {
    const rail = harness({ ok: false, error: 'The domain is not verified.' })

    const result = await sendInvoicePaymentEmail({
      invoice: invoice({ status: 'paid', paidAt: '2026-08-20T15:00:00.000Z' }),
      client,
      statusChanged: true,
      buildPdf: pdfAttachment,
      ...rail,
    })

    expect(result).toMatchObject({ sent: false, reason: 'The domain is not verified.' })
    expect(rail.logged[0]).toMatchObject({ kind: 'receipt', ok: false })
  })

  it('survives an email log that cannot be written', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await sendInvoicePaymentEmail({
      invoice: invoice({ status: 'paid' }),
      client,
      statusChanged: true,
      sendEmail: async () => ({ ok: true, error: null }),
      recordSent: async () => {
        throw new Error('database is on fire')
      },
    })
    expect(result.sent).toBe(true)
  })
})

/**
 * The attachment's last mile: the shape Resend is actually posted.
 *
 * A Buffer must arrive base64-encoded under the filename we chose. Getting this
 * wrong produces a perfectly successful send with a corrupt or missing PDF —
 * the failure nobody notices until a client asks for their invoice.
 */
describe('sendInvoiceEmail attachments', () => {
  function stubResend() {
    const calls = []
    vi.stubEnv('RESEND_API_KEY', 're_test_key')
    vi.stubEnv('INVOICE_EMAIL_FROM', 'billing@pbjsa.com')
    vi.stubGlobal('fetch', async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) })
      return { ok: true, status: 200, text: async () => '' }
    })
    return calls
  }

  it('maps a Buffer into Resend attachments as base64 under its filename', async () => {
    const calls = stubResend()
    const pdf = Buffer.from('%PDF-1.3 pretend document')

    const result = await sendInvoiceEmail({
      to: ['ann@acme.com'],
      subject: 'Invoice INV-2026-08-001',
      html: '<p>hi</p>',
      text: 'hi',
      attachments: [{ filename: 'INV-2026-08-001.pdf', content: pdf }],
    })

    expect(result.ok).toBe(true)
    expect(calls[0].body.attachments).toEqual([
      { filename: 'INV-2026-08-001.pdf', content: pdf.toString('base64') },
    ])
    expect(Buffer.from(calls[0].body.attachments[0].content, 'base64').toString()).toBe(
      '%PDF-1.3 pretend document',
    )
  })

  it('leaves the key out entirely when there is nothing attached', async () => {
    const calls = stubResend()
    await sendInvoiceEmail({ to: ['ann@acme.com'], subject: 's', html: '<p>hi</p>' })
    expect(calls[0].body).not.toHaveProperty('attachments')
  })

  it('passes an already-encoded attachment through untouched', async () => {
    const calls = stubResend()
    await sendInvoiceEmail({
      to: ['ann@acme.com'],
      subject: 's',
      html: '<p>hi</p>',
      attachments: [{ filename: 'a.pdf', content: 'YWJj' }],
    })
    expect(calls[0].body.attachments[0].content).toBe('YWJj')
  })
})
