import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * One link, one payment (Brittany, 2026-11-01): an advance attached with
 * collection 'invoice' rides the invoice's payment link, and the webhook splits
 * the single payment back into the invoice and the advance receipt.
 *
 * A fake Stripe SDK records what each session is created with (as in
 * stripe-session-payload.test.mjs) and answers retrieve/expire from `stripeState`.
 * Everything here is synthetic.
 */

const created = []
const stripeState = { sessions: new Map(), intents: new Map(), expired: [], failRetrieve: false }
vi.mock('stripe', () => {
  class FakeStripe {
    constructor() {
      this.checkout = {
        sessions: {
          create: async (params) => {
            created.push(params)
            return { id: `cs_fake_${created.length}`, url: 'https://checkout.stripe.test/session' }
          },
          retrieve: async (id) => {
            if (stripeState.failRetrieve) throw new Error('Stripe unreachable (synthetic)')
            return { id, status: 'expired', ...stripeState.sessions.get(id) }
          },
          expire: async (id) => { stripeState.expired.push(id); return { id, status: 'expired' } },
        },
      }
      this.paymentIntents = { retrieve: async (id) => ({ id, ...stripeState.intents.get(id) }) }
    }
  }
  return { default: FakeStripe }
})

const { createInvoiceCardCheckoutSession, createInvoiceCheckoutSession, buildCheckoutLineItems } = await import('./stripe-rail.js')
const { CARD_PROCESSING_FEE_LABEL, cardProcessingFee, cardProcessingFeeLine } = await import('./invoice-lines.js')
const { advanceOfferText, advancePaymentRows, advancePaymentSummary } = await import('./invoice-advance-offer.js')
const { combinedAdvanceCents, flagDuplicatePayment, flagPaymentAmountMismatch, paymentAmountMismatch } = await import('./payment-amount-mismatch.js')
const { advanceCredits, stripeAdvanceReceipt, advanceRequest } = await import('./advance-payments.js')
const { advanceCheckout, advanceCollection, handleAdvancePaymentRoute, invoiceAdvanceSettlement, invoiceCheckoutAdvance, settleCombinedAdvance, settleCombinedAdvanceOrRelease } = await import('./advance-payment-routes.js')
const { payLinkAdvanceStep, renderPaySummaryPage } = await import('./pay-link-advance.js')
const { buildInvoiceEmail, buildInvoiceReminderEmail, buildPaymentAckEmail, buildPaymentReceiptEmail } = await import('./invoice-email.js')
const { buildInvoiceDocuments } = await import('./invoice-documents.js')

const savedKey = process.env.STRIPE_SECRET_KEY
beforeEach(() => {
  created.length = 0
  stripeState.sessions.clear(); stripeState.intents.clear(); stripeState.expired.length = 0; stripeState.failRetrieve = false
  process.env.STRIPE_SECRET_KEY = 'sk_test_advance_link'
})
afterEach(() => {
  if (savedKey === undefined) delete process.env.STRIPE_SECRET_KEY
  else process.env.STRIPE_SECRET_KEY = savedKey
})

const token = 'b'.repeat(48)
const offer = (patch = {}) => ({ requestId: 'req-synthetic-0001', number: 'ADV-2026-SYNTHETI', requestedCents: 17000, receivedCents: 0, outstandingCents: 17000, optional: true, collection: 'invoice', collectionMethod: null, forPeriod: null, url: `http://localhost/advance-pay/${token}`, preparedAt: '2026-11-01', preparedBy: 'owner-test', ...patch })
const invoice = (offerPatch = {}, patch = {}) => ({
  id: 'inv-synthetic', number: 'INV-2026-10-SYN', clientId: 'c1', period: '2026-10', status: 'sent', total: 153.75, payToken: 'tok-synthetic',
  lineItems: [{ kind: 'hours', label: 'Bookkeeping', amount: 153.75 }, { kind: 'advance_request', label: 'Pay in advance amount', detail: '', amount: 0, advanceOffer: offer(offerPatch) }],
  ...patch,
})
const client = { id: 'c1', name: 'Synthetic Beach LLC' }
const advance = (optional) => ({ requestId: 'req-synthetic-0001', number: 'ADV-2026-SYNTHETI', cents: 17000, optional })
const args = (optional) => ({ invoice: invoice({ optional }), client, customerId: 'cus_1', appUrl: 'https://app.example.test', advance: advance(optional) })
const feeCents = (dollars) => Math.round(cardProcessingFee(dollars) * 100)
const liveRequest = { id: 'req-synthetic-0001', clientId: 'c1', number: 'ADV-2026-SYNTHETI', publicToken: token, requestedCents: 17000, receivedCents: 0, outstandingCents: 17000, canceledAt: null, collectionMethod: 'bank' }

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
    const store = { listAdvancePayments: async () => ({ requests: [liveRequest], receipts: [] }), recordAdvancePayment: async (input, actor, intent, cents) => { recorded.push({ input, intent: intent.id, cents }); return { cents } } }
    const close = vi.fn(async () => {})
    const notifyOwners = vi.fn(async () => {})
    const event = (amount) => ({ type: 'payment_intent.succeeded', data: { object: object(amount) } })
    expect(await settleCombinedAdvance({ store, event: event(32375), invoice: plain, isCard: false, receivedOn: '2026-11-01', close, notifyOwners })).toBe(17000)
    expect(recorded).toEqual([{ input: { requestId: 'req-synthetic-0001', receivedOn: '2026-11-01' }, intent: 'pi_combined', cents: 17000 }])
    expect(close).toHaveBeenCalledTimes(1)
    expect(notifyOwners).not.toHaveBeenCalled()
    expect(await settleCombinedAdvance({ store, event: event(15375), invoice: plain, isCard: false, receivedOn: '2026-11-01', close })).toBe(0)
    expect(await settleCombinedAdvance({ store, event: { type: 'checkout.session.completed', data: { object: object(32375) } }, invoice: plain, isCard: false, receivedOn: '2026-11-01', close })).toBe(0)
    expect(recorded).toHaveLength(1)
  })
  it('over-collection: still records the money, and tells the owners with the amounts and numbers', async () => {
    const paidMeanwhile = { ...liveRequest, receivedCents: 17000, outstandingCents: 0 }
    const store = { listAdvancePayments: async () => ({ requests: [paidMeanwhile], receipts: [] }), recordAdvancePayment: async (_i, _a, _intent, cents) => ({ cents }) }
    const notifyOwners = vi.fn(async () => {})
    expect(await settleCombinedAdvance({ store, event: { type: 'payment_intent.succeeded', data: { object: object(32375) } }, invoice: plain, isCard: false, receivedOn: '2026-11-01', close: async () => {}, notifyOwners })).toBe(17000)
    expect(notifyOwners).toHaveBeenCalledTimes(1)
    expect(notifyOwners.mock.calls[0][0]).toContain('INV-2026-10-SYN')
    expect(notifyOwners.mock.calls[0][0]).toContain('ADV-2026-SYNTHETI')
    expect(notifyOwners.mock.calls[0][0]).toContain('$170.00')
    // A redelivery of the same intent (receipt already there) is not a second notice.
    const again = { ...store, listAdvancePayments: async () => ({ requests: [paidMeanwhile], receipts: [{ sourceRef: 'stripe:pi_combined', cents: 17000 }] }) }
    await settleCombinedAdvance({ store: again, event: { type: 'payment_intent.succeeded', data: { object: object(32375) } }, invoice: plain, isCard: false, receivedOn: '2026-11-01', close: async () => {}, notifyOwners })
    expect(notifyOwners).toHaveBeenCalledTimes(1)
  })
  it('a failed advance write releases the event for redelivery and tells the owners', async () => {
    const forgotten = []
    const store = { listAdvancePayments: async () => ({ requests: [liveRequest], receipts: [] }), recordAdvancePayment: async () => { throw new Error('synthetic write failure') }, forgetStripeEvent: async (id) => { forgotten.push(id); return true } }
    const notifyOwners = vi.fn(async () => {})
    await expect(settleCombinedAdvanceOrRelease({ store, event: { id: 'evt_fail', type: 'payment_intent.succeeded', data: { object: object(32375) } }, invoice: plain, isCard: false, receivedOn: '2026-11-01', notifyOwners })).rejects.toThrow('synthetic write failure')
    expect(forgotten).toEqual(['evt_fail'])
    expect(notifyOwners.mock.calls[0][0]).toContain('pi_combined')
    expect(notifyOwners.mock.calls[0][0]).toContain('$323.75 received')
    expect(notifyOwners.mock.calls[0][0]).toContain('$170.00 toward the advance')
    expect(notifyOwners.mock.calls[0][0]).toContain('Do not record the advance by hand until those retries have stopped')
  })
})

describe('the amount check at checkout.session.completed', () => {
  const store = () => ({ recordInvoiceAmountMismatch: vi.fn(async () => ({ emailLog: [] })), getClientNameById: async () => 'Synthetic Beach LLC', getTeamMembers: async () => [{ id: 'owner-1', role: 'owner' }] })
  const event = { type: 'checkout.session.completed', created: 1793534400, data: { object: { id: 'cs_combined', payment_intent: 'pi_combined', amount_total: 32375, currency: 'usd', metadata: { invoiceId: 'inv-synthetic', advancePaymentRequestId: 'req-synthetic-0001', advanceCents: '17000' } } } }
  it('expects the invoice plus the advance the session carried: no flag, no notice', async () => {
    const s = store(), notify = vi.fn(async () => {})
    const advanceCents = combinedAdvanceCents({ eventType: event.type, object: event.data.object, invoice: invoice(), isCard: false })
    await flagPaymentAmountMismatch({ store: s, notify, event, invoice: invoice(), advanceCents })
    expect(s.recordInvoiceAmountMismatch).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })
  it('without the advance portion the same payment would be flagged', async () => {
    const s = store(), notify = vi.fn(async () => {})
    await flagPaymentAmountMismatch({ store: s, notify, event, invoice: invoice() })
    expect(s.recordInvoiceAmountMismatch).toHaveBeenCalledWith('inv-synthetic', expect.objectContaining({ expectedCents: 15375, receivedCents: 32375 }))
  })
  it('a second (duplicate) payment says it carries an advance portion to split by hand', async () => {
    const s = store(), notify = vi.fn(async () => {})
    await flagDuplicatePayment({ store: s, notify, event, invoice: invoice({}, { status: 'paid' }), isCard: false, advanceNote: { cents: 17000, number: 'ADV-2026-SYNTHETI' } })
    expect(notify.mock.calls[0][3].message).toContain('includes an advance portion of $170.00 for request ADV-2026-SYNTHETI, which must be split by hand')
  })
})

describe('the live advance a link carries', () => {
  const store = ({ requests = [{ ...liveRequest, outstandingCents: 12000 }], sessions = [], receipts = [], invoices = [invoice({ optional: false })] } = {}) => ({
    listAdvancePayments: async () => ({ requests, sessions, receipts }),
    listInvoices: async () => invoices,
  })
  it('reads the CURRENT outstanding amount, not the frozen snapshot', async () => {
    expect(await invoiceCheckoutAdvance(store(), invoice({ optional: false }))).toEqual({ requestId: 'req-synthetic-0001', number: 'ADV-2026-SYNTHETI', cents: 12000, optional: false })
  })
  it('carries nothing for a separate (or older) offer, a canceled or fully received request', async () => {
    const throws = { listAdvancePayments: async () => { throw new Error('must not read') } }
    expect(await invoiceCheckoutAdvance(throws, invoice({ collection: 'separate' }))).toBeNull()
    expect(await invoiceCheckoutAdvance(throws, invoice({ collection: undefined }))).toBeNull()
    expect(await invoiceCheckoutAdvance(throws, { lineItems: [] })).toBeNull()
    expect(await invoiceCheckoutAdvance(store({ requests: [{ ...liveRequest, canceledAt: '2026-11-01' }] }), invoice())).toBeNull()
    expect(await invoiceCheckoutAdvance(store({ requests: [{ ...liveRequest, outstandingCents: 0 }] }), invoice())).toBeNull()
  })
  it('carries nothing while another invoice carrying it is mid-payment', async () => {
    const other = invoice({}, { id: 'inv-other', number: 'INV-OTHER', status: 'processing' })
    expect(await invoiceCheckoutAdvance(store({ invoices: [invoice(), other] }), invoice())).toBeNull()
    expect(await invoiceCheckoutAdvance(store({ invoices: [invoice(), { ...other, status: 'paid' }] }), invoice())).not.toBeNull()
  })
  it('carries nothing while an advance-only link is open or its payment is in flight or unrecorded', async () => {
    const sessions = [{ id: 'cs_adv', requestId: 'req-synthetic-0001' }]
    stripeState.sessions.set('cs_adv', { status: 'open' })
    expect(await invoiceCheckoutAdvance(store({ sessions }), invoice())).toBeNull()
    stripeState.sessions.set('cs_adv', { status: 'complete', payment_intent: 'pi_adv' })
    stripeState.intents.set('pi_adv', { status: 'processing' })
    expect(await invoiceCheckoutAdvance(store({ sessions }), invoice())).toBeNull()
    stripeState.intents.set('pi_adv', { status: 'succeeded' })
    expect(await invoiceCheckoutAdvance(store({ sessions }), invoice())).toBeNull()
    expect(await invoiceCheckoutAdvance(store({ sessions, receipts: [{ sourceRef: 'stripe:pi_adv' }] }), invoice())).not.toBeNull()
    stripeState.sessions.set('cs_adv', { status: 'expired' })
    expect(await invoiceCheckoutAdvance(store({ sessions }), invoice())).not.toBeNull()
    stripeState.failRetrieve = true
    expect(await invoiceCheckoutAdvance(store({ sessions }), invoice())).toBeNull()
  })
})

describe('the advance page and the owner routes', () => {
  const store = ({ status = 'sent', collection = 'invoice', attempts = [], invoicePatch = {}, request = liveRequest, sessions = [], others = [] } = {}) => ({
    listAdvancePayments: async () => ({ requests: [request], receipts: [], sessions }),
    listInvoices: async () => [invoice({ collection }, { status, stripeCheckoutSessionId: 'cs_invoice', stripeCardSessionId: 'cs_invoice_card', ...invoicePatch }), ...others],
    listAutopayAttempts: async () => attempts,
    getClientById: async () => client,
    recordAdvancePayment: async () => ({ cents: 17000 }),
    cancelAdvancePayment: async () => ({ ...request, canceledAt: '2026-11-01' }),
  })
  const page = async (method, s, rateLimited = () => false) => {
    let body = '', status = null
    const response = { writeHead: (value) => { status = value }, end: (value) => { body = value ?? '' } }
    const sent = []
    await handleAdvancePaymentRoute({ request: { method, headers: {} }, response, pathname: `/advance-pay/${token}`, store: s, isCrossSiteOrigin: () => false, sendJson: (_r, code, value) => sent.push({ code, value }), appUrl: 'http://localhost', rateLimited, clientIp: '203.0.113.9' })
    return { status, body, sent }
  }
  const owner = async (action, s, body = {}) => {
    const sent = []
    await handleAdvancePaymentRoute({ request: { method: 'POST', headers: { 'content-type': 'application/json' } }, response: {}, pathname: `/api/advance-payments/req-synthetic-0001/${action}`, url: new URL('http://localhost/api'), store: s,
      requireSession: async () => ({ user: { id: 'owner-1', role: 'owner' } }), isCrossSiteOrigin: () => false, readJsonBody: async () => body, sendJson: (_r, code, value) => sent.push({ code, value }), appUrl: 'http://localhost' })
    return sent[0]
  }
  it('offers no pay button while an unpaid invoice with a link carries it, and names no invoice number publicly', async () => {
    const { status, body } = await page('GET', store())
    expect(status).toBe(200)
    expect(body).toContain('This advance is collected together with an invoice from the firm')
    expect(body).not.toContain('INV-2026-10-SYN')
    expect(body).not.toContain('<form')
    const post = await page('POST', store())
    expect(post.sent).toEqual([{ code: 409, value: { error: expect.stringContaining('collected together with an invoice from the firm') } }])
  })
  it('refuses the owner bank link, naming the invoice', async () => {
    await expect(advanceCheckout({ store: store(), request: liveRequest, client, appUrl: 'http://localhost', stripe: {} })).rejects.toThrow('collected together with invoice INV-2026-10-SYN')
  })
  it('keeps its pay button once the invoice is paid or void, for a separate offer, while autopay charges it, with no pay token, or rewound to draft', async () => {
    for (const s of [store({ status: 'paid' }), store({ status: 'void' }), store({ collection: 'separate' }), store({ attempts: [{ status: 'processing' }] }), store({ invoicePatch: { payToken: null } }), store({ status: 'draft' }), store({ status: 'reviewed' })]) {
      expect(await advanceCollection(s, liveRequest)).toBeNull()
      expect((await page('GET', s)).body).toContain('Pay advance by bank')
    }
  })
  // ONE predicate: the advance page, the owner's bank link and the pay link agree.
  const agree = async (s) => {
    const body = (await page('GET', s)).body
    const owner = await advanceCheckout({ store: s, request: liveRequest, client, appUrl: 'http://localhost' }).then(() => 'allowed', (error) => error.message)
    return {
      page: body.includes('<form') ? 'button' : body.includes('being processed') ? 'in-flight' : body.includes('collected together') ? 'invoice' : 'other',
      owner: owner.includes('collected together') ? 'invoice' : owner.includes('payment in progress') ? 'in-flight' : 'allowed',
      link: (await invoiceCheckoutAdvance(s, invoice())) ? 'carries' : 'none',
    }
  }
  it('agrees: a sent invoice with a pay token serves it (page and owner refuse, link carries)', async () => {
    expect(await agree(store())).toEqual({ page: 'invoice', owner: 'invoice', link: 'carries' })
  })
  it('agrees: an open advance-only link is the place to pay (link carries nothing, page keeps its button)', async () => {
    stripeState.sessions.set('cs_adv', { status: 'open' })
    expect(await agree(store({ sessions: [{ id: 'cs_adv', requestId: 'req-synthetic-0001' }] }))).toEqual({ page: 'button', owner: 'allowed', link: 'none' })
  })
  it('agrees: Stripe unreachable fails CLOSED on the link and the advance page does not refuse', async () => {
    stripeState.failRetrieve = true
    expect(await agree(store({ sessions: [{ id: 'cs_adv', requestId: 'req-synthetic-0001' }] }))).toEqual({ page: 'button', owner: 'allowed', link: 'none' })
  })
  it('agrees: another carrier mid-payment means nobody collects until it settles', async () => {
    const busy = invoice({}, { id: 'inv-busy', number: 'INV-BUSY', status: 'processing' })
    expect(await agree(store({ others: [busy] }))).toEqual({ page: 'in-flight', owner: 'in-flight', link: 'none' })
    expect((await page('GET', store({ others: [busy] }))).body).not.toContain('INV-BUSY')
  })
  it('agrees: a $0 sent invoice with a pay token is not collecting', async () => {
    expect(await advanceCollection(store({ invoicePatch: { total: 0 } }), liveRequest)).toBeNull()
    expect((await page('GET', store({ invoicePatch: { total: 0 } }))).body).toContain('Pay advance by bank')
  })
  it('a failed owner notice is retried on the next delivery', async () => {
    const store = { listAdvancePayments: async () => { throw new Error('synthetic read failure') }, forgetStripeEvent: async () => true }
    const event = { id: 'evt_notice', type: 'payment_intent.succeeded', data: { object: { id: 'pi_notice', status: 'succeeded', currency: 'usd', amount_received: 32375, metadata: { invoiceId: 'inv-synthetic', advancePaymentRequestId: 'req-synthetic-0001', advanceCents: '17000' } } } }
    const failing = vi.fn(async () => { throw new Error('mail down') })
    await expect(settleCombinedAdvanceOrRelease({ store, event, invoice: invoice(), isCard: false, receivedOn: '2026-11-01', notifyOwners: failing })).rejects.toThrow('synthetic read failure')
    const working = vi.fn(async () => {})
    await expect(settleCombinedAdvanceOrRelease({ store, event, invoice: invoice(), isCard: false, receivedOn: '2026-11-01', notifyOwners: working })).rejects.toThrow('synthetic read failure')
    await expect(settleCombinedAdvanceOrRelease({ store, event, invoice: invoice(), isCard: false, receivedOn: '2026-11-01', notifyOwners: working })).rejects.toThrow('synthetic read failure')
    expect(working).toHaveBeenCalledTimes(1)
  })
  it('agrees: a draft rewound from sent is not collecting', async () => {
    const result = await agree(store({ status: 'draft' }))
    expect(result.page).toBe('button')
    expect(result.owner).toBe('allowed')
  })
  it('a race on the public POST never shows the invoice number', async () => {
    let raced = false
    const s = { ...store(), listInvoices: async () => (raced ? [invoice({}, { stripeCheckoutSessionId: 'cs_invoice' })] : []), getClientById: async () => { raced = true; return client } }
    const post = await page('POST', s)
    expect(post.sent).toEqual([{ code: 409, value: { error: "This advance is collected together with an invoice from the firm. Pay it with that invoice's payment link." } }])
  })
  it('is rate limited like the pay link: by source address, and payment starts by link', async () => {
    const keys = []
    const limited = (key) => { keys.push(key); return key.startsWith('ip:') }
    const { status, body } = await page('GET', store(), limited)
    expect(status).toBe(429)
    expect(body).toContain('Too many attempts')
    keys.length = 0
    await page('POST', store(), (key) => { keys.push(key); return false })
    expect(keys).toEqual(['ip:203.0.113.9', `advance-token:${token}`])
  })
  it('a manual receipt or a cancellation closes the invoice links that still carry the advance', async () => {
    stripeState.sessions.set('cs_invoice', { status: 'open' })
    stripeState.sessions.set('cs_invoice_card', { status: 'complete' })
    const receipt = await owner('receipt', store(), { id: 'cccccccc-dddd-eeee-ffff', amount: 170, receivedOn: '2026-11-01' })
    expect(receipt.code).toBe(200)
    expect(receipt.value.linkWarning).toBeNull()
    expect(stripeState.expired).toEqual(['cs_invoice'])
    stripeState.expired.length = 0
    const canceled = await owner('cancel', store())
    expect(canceled.code).toBe(200)
    expect(stripeState.expired).toEqual(['cs_invoice'])
    stripeState.failRetrieve = true
    expect((await owner('cancel', store())).value.linkWarning).toContain('invoice payment link that carried this advance could not be closed')
  })
})

describe('the pay link with an advance: summary first, then mint', () => {
  const params = (query) => new URLSearchParams(query)
  it('a link with an advance shows the summary; go=1 and the route\'s own retry=1 mint; no advance always mints', () => {
    expect(payLinkAdvanceStep({ carried: true, searchParams: params('') })).toBe('summary')
    expect(payLinkAdvanceStep({ carried: true, searchParams: params('go=1') })).toBe('mint')
    expect(payLinkAdvanceStep({ carried: true, searchParams: params('retry=1') })).toBe('mint')
    expect(payLinkAdvanceStep({ carried: true, searchParams: params('cancelled=1') })).toBe('summary')
    expect(payLinkAdvanceStep({ carried: false, searchParams: params('') })).toBe('mint')
  })
  it('the summary lists what Stripe will, adds to Total to pay, and continues to go=1', () => {
    const html = renderPaySummaryPage({ number: 'INV-2026-10-SYN', rows: advancePaymentRows(advancePaymentSummary({ total: 153.75, advance: advance(false), channel: 'card' })), optional: false, continueHref: '/pay/tok/card?go=1' })
    for (const text of ['Invoice amount', '$153.75', 'Advance payment ADV-2026-SYNTHETI', '$170.00', 'Processing fee', 'Total to pay', 'href="/pay/tok/card?go=1"']) expect(html).toContain(text)
    expect(html).not.toContain('Synthetic Beach LLC')
    expect(renderPaySummaryPage({ number: 'X', rows: [], optional: true, continueHref: '/pay/t?go=1' })).toContain('you may remove it on the next page')
  })
})

describe('a refund on a combined payment', () => {
  it('is partial for the advance receipt unless it covers the whole charge', () => {
    const request = { id: 'req-synthetic-0001', number: 'ADV-2026-SYNTHETI', forPeriod: null }
    const receipt = { requestId: request.id, clientId: 'c1', sourceRef: 'stripe:pi_combined', cents: 17000, receivedOn: '2026-11-01' }
    const refund = (cents) => ({ id: `evt_${cents}`, sourceRef: 'stripe:pi_combined', kind: 'refund', cents, chargeCents: 32375, at: '2026-11-02T00:00:00.000Z' })
    expect(advanceCredits([request], [receipt], [refund(17000)])[0].reversal).toMatchObject({ holds: true, partial: true })
    expect(advanceCredits([request], [receipt], [refund(32375)])[0].reversal).toMatchObject({ holds: true, partial: false })
    // An advance-only receipt (no charge amount stored) keeps the old rule.
    expect(advanceCredits([request], [receipt], [{ ...refund(17000), chargeCents: null }])[0].reversal.partial).toBe(false)
  })
})

describe('wording: one text source for email, PDF and preview, keyed on what the link carries', () => {
  it('a link that carries it: one payment, removable when optional, total is current charges only', () => {
    const text = advanceOfferText(invoice({ optional: true }), { carried: true }).join(' ')
    expect(text).toContain("included in this invoice's payment link: pay current charges and the advance together in one payment")
    expect(text).toContain('You may remove the advance on the payment page.')
    expect(text).toContain('The invoice total above is for current charges only. The advance becomes credit on account once it is received.')
    expect(text).toContain(`Advance request and current remaining amount: http://localhost/advance-pay/${token}`)
    expect(text).not.toContain('pay the advance separately')
    expect(advanceOfferText(invoice({ optional: false }), { carried: true }).join(' ')).not.toContain('remove the advance')
    expect(advanceOfferText(invoice({ optional: true }), { carried: true, card: true }).join(' ')).toContain('The card payment option covers current charges only.')
  })
  it('a link that does not carry it falls back to the advance page, by payment method', () => {
    const bank = advanceOfferText(invoice({ collectionMethod: 'bank' }), { carried: false }).join(' ')
    expect(bank).toContain('Pay the advance from the advance request page below')
    expect(bank).not.toContain("included in this invoice's payment link")
    const unset = advanceOfferText(invoice({ collectionMethod: null }), { carried: false }).join(' ')
    expect(unset).toContain('To pay the advance, contact the firm')
  })
  it('the documents built for each case say what the link really does', () => {
    const payUrl = 'https://app.example.test/pay/tok'
    const words = (email) => email.text
    // Paid by credit at Send: the paid copy has no link.
    expect(words(buildInvoiceEmail({ invoice: invoice({}, { status: 'paid', total: 0 }), client, payUrl, advance: advance(true) }))).not.toContain("included in this invoice's payment link")
    // Autopay first send: not charged automatically.
    const autopay = words(buildInvoiceEmail({ invoice: invoice(), client, autopay: { chargedAmount: 153.75, methodWords: 'bank account ending 6789', withdrawUrl: 'https://app.example.test/autopay/x/withdraw' }, advance: advance(true) }))
    expect(autopay).toContain('This advance is not charged automatically with this invoice.')
    expect(autopay).not.toContain("included in this invoice's payment link")
    // Stripe off: no link.
    expect(words(buildInvoiceEmail({ invoice: invoice(), client }))).toContain('To pay the advance, contact the firm')
    // Canceled or fully received between attach and send: a link, but no live advance.
    const gone = words(buildInvoiceEmail({ invoice: invoice(), client, payUrl, advance: null }))
    expect(gone).not.toContain("included in this invoice's payment link")
    expect(gone).not.toContain('Total to pay')
    // A link that carries it.
    expect(words(buildInvoiceEmail({ invoice: invoice(), client, payUrl, advance: advance(true) }))).toContain("included in this invoice's payment link")
  })
  it('the PAID copy says what this payment brought toward the advance', () => {
    expect(advanceOfferText(invoice(), { settlement: { advanceCents: 17000, pending: false } }).join(' ')).toContain('Received with this payment toward the advance: $170.00. It is now credit on account.')
    expect(advanceOfferText(invoice(), { settlement: { advanceCents: 17000, pending: true } }).join(' ')).toContain('once the bank payment settles')
    expect(advanceOfferText(invoice(), { settlement: { advanceCents: 0 } }).join(' ')).toContain('The advance was not included in this payment.')
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

describe('payment emails state what a combined payment charged', () => {
  const paid = (patch = {}) => invoice({}, { status: 'paid', paidAt: '2026-11-01T12:00:00.000Z', paymentMethod: 'us_bank_account', ...patch })
  it('without an advance both emails are exactly as before', () => {
    expect(buildPaymentAckEmail({ invoice: paid(), client, advance: null })).toEqual(buildPaymentAckEmail({ invoice: paid(), client }))
    expect(buildPaymentReceiptEmail({ invoice: paid(), client, advance: { cents: 0, number: 'ADV' } })).toEqual(buildPaymentReceiptEmail({ invoice: paid(), client }))
    expect(buildPaymentReceiptEmail({ invoice: paid(), client }).text).toContain('Amount paid: $153.75')
    expect(buildPaymentAckEmail({ invoice: paid(), client }).text).toContain('Amount: $153.75')
  })
  it('the acknowledgment and the receipt list invoice, advance and amount paid', () => {
    const advanceNote = { cents: 17000, number: 'ADV-2026-SYNTHETI' }
    for (const email of [buildPaymentAckEmail({ invoice: paid(), client, advance: advanceNote }), buildPaymentReceiptEmail({ invoice: paid(), client, advance: advanceNote })]) {
      expect(email.text).toContain('Invoice amount: $153.75')
      expect(email.text).toContain('Advance payment ADV-2026-SYNTHETI: $170.00')
      expect(email.text).toContain('Amount paid: $323.75')
      expect(email.text).toContain('payment of $323.75 for invoice INV-2026-10-SYN and advance ADV-2026-SYNTHETI')
      expect(email.text).not.toContain('Processing fee')
    }
  })
  it('a card payment adds the processing fee row', () => {
    const fee = feeCents(323.75)
    const byCard = paid({ total: 153.75 + fee / 100, paymentMethod: 'card', lineItems: [...invoice().lineItems, cardProcessingFeeLine(invoice(), 17000)] })
    const email = buildPaymentReceiptEmail({ invoice: byCard, client, advance: { cents: 17000, number: 'ADV-2026-SYNTHETI' } })
    expect(email.text).toContain('Invoice amount: $153.75')
    expect(email.text).toContain(`Processing fee: $${(fee / 100).toFixed(2)}`)
    expect(email.text).toContain(`Amount paid: $${((32375 + fee) / 100).toFixed(2)}`)
  })
})

describe('neutral and settled wording', () => {
  it('with no context (in-app view, print sheet) it describes the attachment and promises no link', () => {
    const text = advanceOfferText(invoice()).join(' ')
    expect(text).toContain('This advance is attached to this invoice and is not part of its total.')
    expect(text).not.toContain("included in this invoice's payment link")
    expect(text).not.toContain('contact the firm')
  })
  it('a paid re-send or preview says what its payment brought, from the receipt on its intent', async () => {
    const s = { listAdvancePayments: async () => ({ receipts: [{ sourceRef: 'stripe:pi_paid', cents: 17000 }] }) }
    const settlement = await invoiceAdvanceSettlement(s, invoice({}, { status: 'paid', stripePaymentIntentId: 'pi_paid' }))
    expect(settlement).toEqual({ advanceCents: 17000, pending: false })
    expect(await invoiceAdvanceSettlement(s, invoice({}, { status: 'paid', stripePaymentIntentId: 'pi_other' }))).toEqual({ advanceCents: 0, pending: false })
    expect(await invoiceAdvanceSettlement(s, invoice({}, { status: 'processing', stripePaymentIntentId: 'pi_x' }))).toEqual({ advanceCents: null, pending: true })
    expect(await invoiceAdvanceSettlement(s, invoice({}, { status: 'paid', stripePaymentIntentId: null }))).toBeNull()
    let pdfText = null
    const docs = await buildInvoiceDocuments({ invoice: invoice({}, { status: 'paid', paidAt: '2026-11-01T12:00:00.000Z' }), client, advanceSettlement: settlement, buildPdf: async ({ advanceText }) => { pdfText = advanceText; return Buffer.from('%PDF') } })
    expect(docs.email.text).toContain('Received with this payment toward the advance: $170.00')
    expect(docs.email.text).not.toContain('Pay the advance from the advance request page')
    expect(pdfText.settlement).toEqual(settlement)
    expect(advanceOfferText(invoice(), { settlement: { advanceCents: null, pending: true } }).join(' ')).toContain('A payment for this invoice is being processed.')
  })
})
