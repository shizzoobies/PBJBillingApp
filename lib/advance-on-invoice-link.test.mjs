import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * One link, one payment (Brittany, 2026-11-01): an advance attached with
 * collection 'invoice' rides the invoice's payment link, and the webhook splits
 * the single payment back into the invoice and the advance receipt.
 *
 * A fake Stripe SDK records what each session is created with (as in
 * stripe-session-payload.test.mjs). Everything here is synthetic.
 */

const created = []
vi.mock('stripe', () => {
  class FakeStripe {
    constructor() {
      this.checkout = {
        sessions: {
          create: async (params) => {
            created.push(params)
            return { id: `cs_fake_${created.length}`, url: 'https://checkout.stripe.test/session' }
          },
        },
      }
    }
  }
  return { default: FakeStripe }
})

const { createInvoiceCardCheckoutSession, createInvoiceCheckoutSession, buildCheckoutLineItems } = await import('./stripe-rail.js')
const { CARD_PROCESSING_FEE_LABEL, cardProcessingFee, cardProcessingFeeLine } = await import('./invoice-lines.js')
const { advanceOfferText, advancePaymentRows, advancePaymentSummary } = await import('./invoice-advance-offer.js')
const { combinedAdvanceCents, paymentAmountMismatch } = await import('./payment-amount-mismatch.js')
const { invoiceCheckoutAdvance, stripeAdvanceReceipt, advanceRequest } = await import('./advance-payments.js')
const { collectingInvoiceFor, handleAdvancePaymentRoute, settleCombinedAdvance, advanceCheckout } = await import('./advance-payment-routes.js')
const { buildInvoiceEmail, buildInvoiceReminderEmail } = await import('./invoice-email.js')

const savedKey = process.env.STRIPE_SECRET_KEY
beforeEach(() => {
  created.length = 0
  process.env.STRIPE_SECRET_KEY = 'sk_test_advance_link'
})
afterEach(() => {
  if (savedKey === undefined) delete process.env.STRIPE_SECRET_KEY
  else process.env.STRIPE_SECRET_KEY = savedKey
})

const token = 'b'.repeat(48)
const offer = (patch = {}) => ({ requestId: 'req-synthetic-0001', number: 'ADV-2026-SYNTHETI', requestedCents: 17000, receivedCents: 0, outstandingCents: 17000, optional: true, collection: 'invoice', forPeriod: null, url: `http://localhost/advance-pay/${token}`, preparedAt: '2026-11-01', preparedBy: 'owner-test', ...patch })
const invoice = (offerPatch = {}, patch = {}) => ({
  id: 'inv-synthetic', number: 'INV-2026-10-SYN', clientId: 'c1', period: '2026-10', status: 'sent', total: 153.75,
  lineItems: [{ kind: 'hours', label: 'Bookkeeping', amount: 153.75 }, { kind: 'advance_request', label: 'Pay in advance amount', detail: '', amount: 0, advanceOffer: offer(offerPatch) }],
  ...patch,
})
const client = { id: 'c1', name: 'Synthetic Beach LLC' }
const advance = (optional) => ({ requestId: 'req-synthetic-0001', number: 'ADV-2026-SYNTHETI', cents: 17000, optional })
const args = (optional) => ({ invoice: invoice({ optional }), client, customerId: 'cus_1', appUrl: 'https://app.example.test', advance: advance(optional) })
const feeCents = (dollars) => Math.round(cardProcessingFee(dollars) * 100)

describe('payment link line items and metadata', () => {
  it('ACH + optional advance: one removable advance line after the invoice lines, metadata on session and intent', async () => {
    expect((await createInvoiceCheckoutSession(args(true))).ok).toBe(true)
    const params = created[0]
    expect(params.line_items.map((line) => line.price_data.unit_amount)).toEqual([15375, 17000])
    expect(params.line_items[1]).toMatchObject({ quantity: 1, adjustable_quantity: { enabled: true, minimum: 0, maximum: 1 },
      price_data: { product_data: { name: 'Advance payment ADV-2026-SYNTHETI', description: 'Held as credit toward future invoices; not a charge for services' } } })
    const metadata = { invoiceId: 'inv-synthetic', invoiceNumber: 'INV-2026-10-SYN', advancePaymentRequestId: 'req-synthetic-0001', advanceCents: '17000' }
    expect(params.metadata).toEqual(metadata)
    expect(params.payment_intent_data.metadata).toEqual(metadata)
  })
  it('ACH + agreed advance: a fixed quantity line', async () => {
    await createInvoiceCheckoutSession(args(false))
    expect(created[0].line_items[1].adjustable_quantity).toBeUndefined()
    expect(created[0].line_items[1].quantity).toBe(1)
  })
  it('card + optional advance: the card link omits it, fee on the invoice alone, no advance metadata', async () => {
    await createInvoiceCardCheckoutSession(args(true))
    const params = created[0]
    expect(params.line_items.map((line) => line.price_data.unit_amount)).toEqual([15375, feeCents(153.75)])
    expect(params.metadata).toEqual({ invoiceId: 'inv-synthetic', invoiceNumber: 'INV-2026-10-SYN', channel: 'card' })
  })
  it('card + agreed advance: fee worked on invoice + advance so the firm nets both', async () => {
    await createInvoiceCardCheckoutSession(args(false))
    const params = created[0]
    const fee = feeCents(323.75)
    expect(fee).toBeGreaterThan(feeCents(153.75))
    expect(params.line_items.map((line) => line.price_data.unit_amount)).toEqual([15375, 17000, fee])
    expect(params.line_items[2].price_data.product_data.name).toBe(CARD_PROCESSING_FEE_LABEL)
    expect(params.payment_intent_data.metadata).toMatchObject({ channel: 'card', invoiceId: 'inv-synthetic', advancePaymentRequestId: 'req-synthetic-0001', advanceCents: '17000' })
    // The fee line the webhook appends is the fee the card was charged.
    expect(Math.round(cardProcessingFeeLine({ total: 153.75 }, 17000).amount * 100)).toBe(fee)
  })
  it('still collapses negative lines first and keeps the $0 refusal', async () => {
    const credited = invoice({ optional: false }, { total: 100, lineItems: [{ kind: 'hours', label: 'Work', amount: 150 }, { kind: 'credit', label: 'Credit', amount: -50 }] })
    expect(buildCheckoutLineItems(credited, client, advance(false)).map((line) => line.price_data.unit_amount)).toEqual([10000, 17000])
    const zero = { ...credited, total: 0, lineItems: [] }
    expect(buildCheckoutLineItems(zero, client, advance(false))).toEqual([])
    expect((await createInvoiceCheckoutSession({ ...args(false), invoice: zero })).ok).toBe(false)
    expect(created).toHaveLength(0)
  })
})

describe('the live advance a link carries', () => {
  const store = (rows) => ({ listAdvancePayments: async () => ({ requests: rows }) })
  const request = { id: 'req-synthetic-0001', clientId: 'c1', number: 'ADV-2026-SYNTHETI', canceledAt: null, outstandingCents: 12000 }
  it('reads the CURRENT outstanding amount, not the frozen snapshot', async () => {
    expect(await invoiceCheckoutAdvance(store([request]), invoice({ optional: false }))).toEqual({ requestId: 'req-synthetic-0001', number: 'ADV-2026-SYNTHETI', cents: 12000, optional: false })
  })
  it('carries nothing for a separate (or older) offer, a canceled or fully received request', async () => {
    const throws = { listAdvancePayments: async () => { throw new Error('must not read') } }
    expect(await invoiceCheckoutAdvance(throws, invoice({ collection: 'separate' }))).toBeNull()
    expect(await invoiceCheckoutAdvance(throws, invoice({ collection: undefined }))).toBeNull()
    expect(await invoiceCheckoutAdvance(throws, { lineItems: [] })).toBeNull()
    expect(await invoiceCheckoutAdvance(store([{ ...request, canceledAt: '2026-11-01' }]), invoice())).toBeNull()
    expect(await invoiceCheckoutAdvance(store([{ ...request, outstandingCents: 0 }]), invoice())).toBeNull()
  })
})

describe('splitting one payment back into invoice and advance', () => {
  const object = (amount, patch = {}) => ({ id: 'pi_combined', status: 'succeeded', currency: 'usd', amount_received: amount, metadata: { invoiceId: 'inv-synthetic', advancePaymentRequestId: 'req-synthetic-0001', advanceCents: '17000', ...patch } })
  const plain = invoice()
  it('ACH: received - invoice total is the advance; a removed optional advance is 0', () => {
    expect(combinedAdvanceCents({ eventType: 'payment_intent.succeeded', object: object(32375), invoice: plain, isCard: false })).toBe(17000)
    expect(combinedAdvanceCents({ eventType: 'payment_intent.succeeded', object: object(15375), invoice: plain, isCard: false })).toBe(0)
    // checkout.session.completed carries the session total instead.
    expect(combinedAdvanceCents({ eventType: 'checkout.session.completed', object: { amount_total: 32375, metadata: object(0).metadata }, invoice: plain, isCard: false })).toBe(17000)
  })
  it('card: the fee (worked on invoice + advance) comes off, whether or not the fee line is already on the invoice', () => {
    const received = 32375 + feeCents(323.75)
    expect(combinedAdvanceCents({ eventType: 'payment_intent.succeeded', object: object(received), invoice: plain, isCard: true })).toBe(17000)
    const withFee = { ...plain, total: 153.75 + feeCents(323.75) / 100, lineItems: [...plain.lineItems, cardProcessingFeeLine(plain, 17000)] }
    expect(combinedAdvanceCents({ eventType: 'payment_intent.succeeded', object: object(received), invoice: withFee, isCard: true })).toBe(17000)
  })
  it('never credits a shortfall as advance, and needs both ids and a valid amount', () => {
    expect(combinedAdvanceCents({ eventType: 'payment_intent.succeeded', object: object(25000), invoice: plain, isCard: false })).toBe(0)
    expect(combinedAdvanceCents({ eventType: 'payment_intent.succeeded', object: object(40000), invoice: plain, isCard: false })).toBe(17000)
    expect(combinedAdvanceCents({ eventType: 'payment_intent.succeeded', object: object(32375, { invoiceId: undefined }), invoice: plain, isCard: false })).toBe(0)
    expect(combinedAdvanceCents({ eventType: 'payment_intent.succeeded', object: object(32375, { advanceCents: 'x' }), invoice: plain, isCard: false })).toBe(0)
  })
  it('the amount check expects invoice total (+ fee) + the advance recorded, so a combined payment is not a mismatch', () => {
    expect(paymentAmountMismatch({ eventType: 'payment_intent.succeeded', object: object(32375), invoice: plain, advanceCents: 17000 })).toBeNull()
    expect(paymentAmountMismatch({ eventType: 'payment_intent.succeeded', object: object(32375), invoice: plain })).toEqual({ expectedCents: 15375, receivedCents: 32375 })
    const paidByCard = { ...plain, total: 153.75 + feeCents(323.75) / 100 }
    expect(paymentAmountMismatch({ eventType: 'payment_intent.succeeded', object: object(32375 + feeCents(323.75)), invoice: paidByCard, advanceCents: 17000 })).toBeNull()
    expect(paymentAmountMismatch({ eventType: 'payment_intent.succeeded', object: object(40000), invoice: plain, advanceCents: 17000 })).toEqual({ expectedCents: 32375, receivedCents: 40000 })
  })
  it('a receipt takes the explicit advance portion but keys on the intent', () => {
    const request = advanceRequest({ id: 'req-synthetic-0001', clientId: 'c1', amount: 170 }, '2026-11-01T12:00:00.000Z')
    const receipt = stripeAdvanceReceipt(object(32375), request, '2026-11-01', '2026-11-01T12:00:00.000Z', '2026-11-01', 17000)
    expect(receipt).toMatchObject({ cents: 17000, sourceRef: 'stripe:pi_combined', method: 'stripe', receivedOn: '2026-11-01' })
    for (const cents of [0, -1, 1.5, 32376]) expect(() => stripeAdvanceReceipt(object(32375), request, '2026-11-01', '2026-11-01T12:00:00.000Z', '2026-11-01', cents)).toThrow()
  })
  it('the webhook step records the portion once per intent, nothing for a removed optional advance', async () => {
    const recorded = []
    const store = { recordAdvancePayment: async (input, actor, intent, cents) => { recorded.push({ input, intent: intent.id, cents }); return { cents } } }
    const close = vi.fn(async () => {})
    const event = (amount) => ({ type: 'payment_intent.succeeded', data: { object: object(amount) } })
    expect(await settleCombinedAdvance({ store, event: event(32375), invoice: plain, isCard: false, receivedOn: '2026-11-01', close })).toBe(17000)
    expect(recorded).toEqual([{ input: { requestId: 'req-synthetic-0001', receivedOn: '2026-11-01' }, intent: 'pi_combined', cents: 17000 }])
    expect(close).toHaveBeenCalledTimes(1)
    expect(await settleCombinedAdvance({ store, event: event(15375), invoice: plain, isCard: false, receivedOn: '2026-11-01', close })).toBe(0)
    expect(await settleCombinedAdvance({ store, event: { type: 'checkout.session.completed', data: { object: object(32375) } }, invoice: plain, isCard: false, receivedOn: '2026-11-01', close })).toBe(0)
    expect(recorded).toHaveLength(1)
  })
})

describe('the double-collection guard on the advance page', () => {
  const request = { id: 'req-synthetic-0001', clientId: 'c1', number: 'ADV-2026-SYNTHETI', publicToken: token, requestedCents: 17000, receivedCents: 0, outstandingCents: 17000, canceledAt: null, collectionMethod: 'bank' }
  const store = ({ status = 'sent', collection = 'invoice', attempts = [] } = {}) => ({
    listAdvancePayments: async () => ({ requests: [request] }),
    listInvoices: async () => [invoice({ collection }, { status })],
    listAutopayAttempts: async () => attempts,
    getClientById: async () => client,
  })
  const page = async (method, s) => {
    let body = '', status = null
    const response = { writeHead: (value) => { status = value }, end: (value) => { body = value ?? '' } }
    const sent = []
    await handleAdvancePaymentRoute({ request: { method, headers: {} }, response, pathname: `/advance-pay/${token}`, store: s, isCrossSiteOrigin: () => false, sendJson: (_r, code, value) => sent.push({ code, value }), appUrl: 'http://localhost' })
    return { status, body, sent }
  }
  it('names the invoice and offers no pay button while that invoice is unpaid', async () => {
    const { status, body } = await page('GET', store())
    expect(status).toBe(200)
    expect(body).toContain('This advance is collected together with invoice INV-2026-10-SYN')
    expect(body).not.toContain('<form')
    const post = await page('POST', store())
    expect(post.sent).toEqual([{ code: 409, value: { error: expect.stringContaining('collected together with invoice INV-2026-10-SYN') } }])
  })
  it('refuses the owner bank link with the same sentence', async () => {
    await expect(advanceCheckout({ store: store(), request, client, appUrl: 'http://localhost', stripe: {} })).rejects.toThrow('collected together with invoice INV-2026-10-SYN')
  })
  it('behaves as before once the invoice is paid or void, for a separate offer, or while autopay is charging it', async () => {
    for (const s of [store({ status: 'paid' }), store({ status: 'void' }), store({ collection: 'separate' }), store({ attempts: [{ status: 'processing' }] })]) {
      expect(await collectingInvoiceFor(s, request)).toBeNull()
      const { body } = await page('GET', s)
      expect(body).toContain('Pay advance by bank')
    }
  })
})

describe('wording: one text source for email, PDF and preview', () => {
  it('says the advance rides this link, one payment, removable when optional, total is current charges only', () => {
    const text = advanceOfferText(invoice({ optional: true })).join(' ')
    expect(text).toContain("included in this invoice's payment link: pay current charges and the advance together in one payment")
    expect(text).toContain('You may remove the advance on the payment page.')
    expect(text).toContain('The invoice total above is for current charges only. The advance becomes credit on account once it is received.')
    expect(text).toContain(`Advance request and current remaining amount: http://localhost/advance-pay/${token}`)
    expect(text).not.toContain('pay the advance separately')
    expect(advanceOfferText(invoice({ optional: false })).join(' ')).not.toContain('remove the advance')
    expect(advanceOfferText(invoice({ optional: true }), { card: true }).join(' ')).toContain('The card payment option covers current charges only.')
  })
  it('autopay: not charged automatically, pay from the advance page', () => {
    const text = advanceOfferText(invoice(), { autopay: true }).join(' ')
    expect(text).toContain('This advance is not charged automatically with this invoice.')
    expect(text).not.toContain("included in this invoice's payment link")
  })
  it('an older offer (no collection) keeps the separate wording', () => {
    expect(advanceOfferText(invoice({ collection: undefined })).join(' ')).toContain('pay the advance separately')
  })
  it('the pay rows add to Total to pay, with the processing fee on the card variant', () => {
    expect(advancePaymentRows(advancePaymentSummary({ total: 153.75, advance: advance(true), channel: 'ach' }))).toEqual([
      ['Invoice amount', '$153.75'], ['Advance payment ADV-2026-SYNTHETI (optional)', '$170.00'], ['Total to pay', '$323.75']])
    const card = advancePaymentRows(advancePaymentSummary({ total: 153.75, advance: advance(false), channel: 'card' }))
    expect(card.map(([label]) => label)).toEqual(['Invoice amount', 'Advance payment ADV-2026-SYNTHETI', 'Processing fee', 'Total to pay'])
    expect(card[3][1]).toBe(`$${((32375 + feeCents(323.75)) / 100).toFixed(2)}`)
    expect(advancePaymentRows(advancePaymentSummary({ total: 153.75, advance: advance(true), channel: 'card' }))).toEqual([])
  })
  it('the invoice email and the reminder button say the amount the payment page asks for', () => {
    const email = buildInvoiceEmail({ invoice: invoice({ optional: false }), client, payUrl: 'https://app.example.test/pay/tok', cardPayUrl: 'https://app.example.test/pay/tok/card', advance: advance(false) })
    expect(email.text).toContain('Total to pay: $323.75')
    expect(email.text).toContain('Pay $323.75 by bank transfer: https://app.example.test/pay/tok')
    expect(email.html).toContain('Pay $323.75')
    expect(email.text).toContain(`Pay $${((32375 + feeCents(323.75)) / 100).toFixed(2)}: https://app.example.test/pay/tok/card`)
    expect(email.text).toContain('Total due: $153.75')
    const plainEmail = buildInvoiceEmail({ invoice: invoice({ optional: false }), client, payUrl: 'https://app.example.test/pay/tok' })
    expect(plainEmail.text).not.toContain('Total to pay')
    const reminder = buildInvoiceReminderEmail({ invoice: invoice({ optional: true }), client, payUrl: 'https://app.example.test/pay/tok', advance: advance(true) })
    expect(reminder.html).toContain('Pay $323.75')
    expect(reminder.text).toContain('Total to pay')
  })
})
