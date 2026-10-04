import { describe, expect, it, vi } from 'vitest'

import {
  AUTOPAY_STATUSES,
  applyAutopaySetupEvent,
  autopayBadgeFor,
  autopayChargeCents,
  autopayChargeDecision,
  autopayChargingEnabled,
  autopayFailureRevokes,
  autopaySummary,
  buildAutopayPaymentIntent,
  buildAutopaySetupSessionParams,
  chargeAutopayInvoice,
  classifySetupEvent,
  createAutopaySetupSession,
  describeSetupIntent,
  emptyAutopay,
  hasActiveAutopayAttempt,
  findInvoiceIntents,
  hasPriorOkInvoiceSend,
  isDefiniteStripeRefusal,
  moneyMovedIntent,
  retireCheckoutSessions,
  latestAttemptByInvoice,
  newSetupToken,
  turnOffAutopay,
} from './stripe-autopay.js'
import { cardProcessingFee } from './invoice-lines.js'
import { toStripeAmount } from './stripe-rail.js'

describe('autopaySummary', () => {
  const row = {
    clientId: 'c1',
    status: 'enrolled',
    paymentMethodId: 'pm_secret',
    methodType: 'us_bank_account',
    last4: '6789',
    bankOrBrand: 'TEST BANK',
    mandateId: 'mandate_secret',
    consentedAt: '2026-10-05T12:00:00.000Z',
    invitedAt: '2026-10-04T12:00:00.000Z',
    setupToken: 'tok_secret',
    withdrawnAt: null,
    updatedAt: '2026-10-05T12:00:00.000Z',
  }

  it('says what the owner needs to read', () => {
    expect(autopaySummary(row)).toEqual({
      clientId: 'c1',
      status: 'enrolled',
      methodType: 'us_bank_account',
      last4: '6789',
      bankOrBrand: 'TEST BANK',
      invitedAt: '2026-10-04T12:00:00.000Z',
      consentedAt: '2026-10-05T12:00:00.000Z',
      withdrawnAt: null,
    })
  })

  it('never carries the setup token, the payment method id or the mandate id', () => {
    const text = JSON.stringify(autopaySummary(row))
    for (const secret of ['tok_secret', 'pm_secret', 'mandate_secret']) {
      expect(text).not.toContain(secret)
    }
  })

  it('reads an unknown or missing status as off', () => {
    expect(autopaySummary({ clientId: 'c1', status: 'weird' }).status).toBe('off')
    expect(autopaySummary(null).status).toBe('off')
    expect(autopaySummary(emptyAutopay('c1')).status).toBe('off')
  })

  it('knows the six statuses', () => {
    expect(AUTOPAY_STATUSES).toEqual([
      'off',
      'invited',
      'pending_verification',
      'enrolled',
      'withdrawn',
      'revoked',
    ])
  })
})

describe('the invoice badge', () => {
  const attempt = (invoiceId, attemptNo, status) => ({ invoiceId, attemptNo, status })

  it('uses the highest attempt number per invoice', () => {
    const latest = latestAttemptByInvoice([
      attempt('a', 2, 'processing'),
      attempt('a', 1, 'failed'),
      attempt('b', 1, 'succeeded'),
    ])
    expect(latest.get('a').attemptNo).toBe(2)
    expect(latest.get('b').status).toBe('succeeded')
  })

  it('is autopay while claimed, in flight or collected', () => {
    for (const status of ['claimed', 'processing', 'succeeded']) {
      expect(autopayBadgeFor(attempt('a', 1, status))).toBe('autopay')
    }
  })

  it('is failed when the latest attempt failed, and nothing when there was none', () => {
    expect(autopayBadgeFor(attempt('a', 1, 'failed'))).toBe('failed')
    expect(autopayBadgeFor(undefined)).toBeNull()
    expect(autopayBadgeFor(attempt('a', 1, 'mystery'))).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* Enrollment                                                                  */
/* -------------------------------------------------------------------------- */

const setupArgs = {
  client: { id: 'c1', name: 'Acme', cardPaymentsEnabled: false },
  customerId: 'cus_1',
  appUrl: 'https://app.example.com',
  token: 'tok_abc',
  firmName: 'PB&J Strategic Accounting',
}

describe('the setup Checkout payload', () => {
  it('is a setup-mode session on the client’s customer, bank only by default', () => {
    const params = buildAutopaySetupSessionParams(setupArgs)
    expect(params.mode).toBe('setup')
    expect(params.customer).toBe('cus_1')
    expect(params.payment_method_types).toEqual(['us_bank_account'])
    expect(params.payment_method_options.us_bank_account).toEqual({
      verification_method: 'automatic',
      financial_connections: { permissions: ['payment_method'] },
    })
  })

  it('adds card ONLY for a client with card payments on', () => {
    const params = buildAutopaySetupSessionParams({
      ...setupArgs,
      client: { ...setupArgs.client, cardPaymentsEnabled: true },
    })
    expect(params.payment_method_types).toEqual(['us_bank_account', 'card'])
    expect(params.custom_text.submit.message).toMatch(/card processing fee/)
  })

  it('never says anything about a card fee to a client who is not offered a card', () => {
    expect(buildAutopaySetupSessionParams(setupArgs).custom_text.submit.message).not.toMatch(/card/i)
  })

  // A setup is a statement about a CLIENT. Anything that reads an invoice id
  // off an event must never be able to mistake it for a payment.
  it('carries the client and the purpose, and NEVER an invoice id', () => {
    const params = buildAutopaySetupSessionParams(setupArgs)
    expect(params.metadata).toEqual({ clientId: 'c1', purpose: 'autopay' })
    expect(params.setup_intent_data.metadata).toEqual({ clientId: 'c1', purpose: 'autopay' })
    expect(JSON.stringify(params)).not.toMatch(/invoice_?id|invoiceNumber/i)
  })

  it('has no line items and no currency: it is not a payment', () => {
    const params = buildAutopaySetupSessionParams(setupArgs)
    expect(params).not.toHaveProperty('line_items')
    expect(params).not.toHaveProperty('currency')
    expect(params).not.toHaveProperty('payment_intent_data')
  })

  it('returns to the client’s own autopay page, not the authenticated app', () => {
    const params = buildAutopaySetupSessionParams(setupArgs)
    expect(params.success_url).toBe('https://app.example.com/autopay/tok_abc?done=1')
    expect(params.cancel_url).toBe('https://app.example.com/autopay/tok_abc?cancelled=1')
  })

  it('mints a session, or says why not without throwing', async () => {
    const create = vi.fn(async () => ({ id: 'cs_1', url: 'https://checkout.stripe.test/x' }))
    const ok = await createAutopaySetupSession({ ...setupArgs, stripe: { checkout: { sessions: { create } } } })
    expect(ok).toMatchObject({ ok: true, session: { id: 'cs_1' } })
    expect(create).toHaveBeenCalledTimes(1)

    const refused = await createAutopaySetupSession({
      ...setupArgs,
      stripe: { checkout: { sessions: { create: async () => { throw new Error('nope') } } } },
    })
    expect(refused).toEqual({ ok: false, reason: 'Stripe refused the setup page: nope' })
    expect((await createAutopaySetupSession({ ...setupArgs, stripe: null })).ok).toBe(false)
  })

  it('makes a distinct unguessable token every time', () => {
    const a = newSetupToken()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(newSetupToken()).not.toBe(a)
  })
})

describe('describeSetupIntent', () => {
  it('reads a bank account and its mandate acceptance time', () => {
    expect(
      describeSetupIntent({
        payment_method: {
          id: 'pm_1',
          type: 'us_bank_account',
          us_bank_account: { last4: '6789', bank_name: 'TEST BANK' },
        },
        mandate: { id: 'mandate_1', customer_acceptance: { accepted_at: 1_790_000_000 } },
      }),
    ).toEqual({
      paymentMethodId: 'pm_1',
      methodType: 'us_bank_account',
      last4: '6789',
      bankOrBrand: 'TEST BANK',
      mandateId: 'mandate_1',
      consentedAt: new Date(1_790_000_000 * 1000).toISOString(),
    })
  })

  it('reads a card, which has no mandate, as consenting now', () => {
    const now = new Date('2026-10-05T12:00:00.000Z')
    expect(
      describeSetupIntent(
        { payment_method: { id: 'pm_2', type: 'card', card: { last4: '4242', brand: 'visa' } }, mandate: null },
        { now },
      ),
    ).toEqual({
      paymentMethodId: 'pm_2',
      methodType: 'card',
      last4: '4242',
      bankOrBrand: 'visa',
      mandateId: null,
      consentedAt: '2026-10-05T12:00:00.000Z',
    })
  })
})

describe('classifySetupEvent', () => {
  const ours = { metadata: { clientId: 'c1', purpose: 'autopay' } }
  it.each([
    [{ type: 'checkout.session.completed', data: { object: { mode: 'setup', ...ours, setup_intent: 'seti_1' } } }, 'session_completed'],
    [{ type: 'setup_intent.succeeded', data: { object: { id: 'seti_1', ...ours } } }, 'succeeded'],
    [{ type: 'setup_intent.setup_failed', data: { object: { id: 'seti_1', ...ours } } }, 'failed'],
    [{ type: 'setup_intent.created', data: { object: { id: 'seti_1', ...ours } } }, 'ignored'],
    [{ type: 'setup_intent.succeeded', data: { object: { id: 'seti_9', metadata: {} } } }, 'ignored'],
  ])('%#: reads the event as %s', (event, kind) => {
    expect(classifySetupEvent(event).kind).toBe(kind)
  })

  it('is null for a payment event, so the invoice path keeps them', () => {
    expect(classifySetupEvent({ type: 'checkout.session.completed', data: { object: { mode: 'payment' } } })).toBeNull()
    expect(classifySetupEvent({ type: 'payment_intent.succeeded', data: { object: {} } })).toBeNull()
  })
})

/** The two store methods setup events are allowed to use, with the real guard semantics. */
function enrollmentStore(initial = null) {
  let row = initial
  const calls = []
  return {
    calls,
    get row() {
      return row
    },
    async getClientAutopay() {
      return row
    },
    async updateClientAutopay(clientId, patch, { onlyIfStatus = null } = {}) {
      calls.push({ clientId, patch, onlyIfStatus })
      if (Array.isArray(onlyIfStatus) && (!row || !onlyIfStatus.includes(row.status))) return null
      row = { ...(row ?? { clientId, status: 'off' }), ...patch, clientId }
      return row
    },
  }
}
const setupIntent = (paymentMethodId = 'pm_new') => ({
  payment_method: { id: paymentMethodId, type: 'us_bank_account', us_bank_account: { last4: '6789', bank_name: 'TEST BANK' } },
  mandate: { id: 'mandate_1', customer_acceptance: { accepted_at: 1_790_000_000 } },
})
const stripeFor = (intent = setupIntent()) => ({
  setupIntents: { retrieve: vi.fn(async () => intent) },
  paymentMethods: { detach: vi.fn(async () => ({})) },
})
const setupEvent = (type, extra = {}) => ({
  id: 'evt_1',
  type,
  data: { object: { id: 'seti_1', metadata: { clientId: 'c1', purpose: 'autopay' }, ...extra } },
})

describe('applying setup events', () => {
  it('a completed setup Checkout moves invited to pending_verification and nothing else', async () => {
    const store = enrollmentStore({ clientId: 'c1', status: 'invited' })
    await applyAutopaySetupEvent({
      store,
      stripe: stripeFor(),
      event: { type: 'checkout.session.completed', data: { object: { mode: 'setup', metadata: { clientId: 'c1' } } } },
    })
    expect(store.row.status).toBe('pending_verification')
  })

  it('a late completed-checkout never walks an enrolled client back', async () => {
    const store = enrollmentStore({ clientId: 'c1', status: 'enrolled', paymentMethodId: 'pm_1' })
    await applyAutopaySetupEvent({
      store,
      stripe: stripeFor(),
      event: { type: 'checkout.session.completed', data: { object: { mode: 'setup', metadata: { clientId: 'c1' } } } },
    })
    expect(store.row.status).toBe('enrolled')
  })

  it('setup_intent.succeeded enrolls, storing the method, the mandate and the consent time', async () => {
    const store = enrollmentStore({ clientId: 'c1', status: 'pending_verification' })
    const result = await applyAutopaySetupEvent({ store, stripe: stripeFor(), event: setupEvent('setup_intent.succeeded') })
    expect(store.row).toMatchObject({
      status: 'enrolled',
      paymentMethodId: 'pm_new',
      methodType: 'us_bank_account',
      last4: '6789',
      mandateId: 'mandate_1',
      consentedAt: new Date(1_790_000_000 * 1000).toISOString(),
    })
    expect(result.notify).toMatchObject({ event: 'autopay_enrolled', clientId: 'c1' })
  })

  it('applying the same success again changes nothing and tells nobody twice', async () => {
    const store = enrollmentStore({ clientId: 'c1', status: 'invited' })
    const stripe = stripeFor()
    await applyAutopaySetupEvent({ store, stripe, event: setupEvent('setup_intent.succeeded') })
    const again = await applyAutopaySetupEvent({ store, stripe, event: setupEvent('setup_intent.succeeded') })
    expect(again.notify).toBeNull()
    expect(store.row.status).toBe('enrolled')
    expect(stripe.paymentMethods.detach).not.toHaveBeenCalled()
  })

  it.each(['off', 'withdrawn', 'revoked'])(
    'a setup that finishes for a client who is %s enrolls nobody and detaches the new method',
    async (status) => {
      const store = enrollmentStore({ clientId: 'c1', status })
      const stripe = stripeFor()
      const result = await applyAutopaySetupEvent({ store, stripe, event: setupEvent('setup_intent.succeeded') })
      expect(store.row.status).toBe(status)
      expect(stripe.paymentMethods.detach).toHaveBeenCalledWith('pm_new')
      expect(result.notify).toBeNull()
    },
  )

  it('a client with no enrollment row at all is not enrolled by a stray event', async () => {
    const store = enrollmentStore(null)
    const stripe = stripeFor()
    await applyAutopaySetupEvent({ store, stripe, event: setupEvent('setup_intent.succeeded') })
    expect(store.row).toBeNull()
    expect(stripe.paymentMethods.detach).toHaveBeenCalledWith('pm_new')
  })

  it('a second setup replaces the method and detaches the old one', async () => {
    const store = enrollmentStore({ clientId: 'c1', status: 'enrolled', paymentMethodId: 'pm_old' })
    const stripe = stripeFor(setupIntent('pm_new'))
    const result = await applyAutopaySetupEvent({ store, stripe, event: setupEvent('setup_intent.succeeded') })
    expect(store.row.paymentMethodId).toBe('pm_new')
    expect(stripe.paymentMethods.detach).toHaveBeenCalledWith('pm_old')
    expect(result.notify).not.toBeNull()
  })

  it('a failed setup puts a verifying client back to invited', async () => {
    const store = enrollmentStore({ clientId: 'c1', status: 'pending_verification' })
    await applyAutopaySetupEvent({ store, stripe: stripeFor(), event: setupEvent('setup_intent.setup_failed') })
    expect(store.row.status).toBe('invited')
  })

  it('a failed setup never un-enrolls an enrolled client', async () => {
    const store = enrollmentStore({ clientId: 'c1', status: 'enrolled', paymentMethodId: 'pm_1' })
    await applyAutopaySetupEvent({ store, stripe: stripeFor(), event: setupEvent('setup_intent.setup_failed') })
    expect(store.row.status).toBe('enrolled')
  })

  // The webhook takes the event back out of its ledger when this throws, so
  // Stripe's retry gets another go.
  it('throws when Stripe cannot be read, and writes nothing', async () => {
    const store = enrollmentStore({ clientId: 'c1', status: 'invited' })
    const stripe = {
      setupIntents: { retrieve: async () => { throw new Error('stripe down') } },
      paymentMethods: { detach: vi.fn() },
    }
    await expect(
      applyAutopaySetupEvent({ store, stripe, event: setupEvent('setup_intent.succeeded') }),
    ).rejects.toThrow('stripe down')
    expect(store.row.status).toBe('invited')
  })

  it('does nothing for an event that is not ours', async () => {
    const store = enrollmentStore({ clientId: 'c1', status: 'invited' })
    await applyAutopaySetupEvent({
      store,
      stripe: stripeFor(),
      event: { type: 'setup_intent.succeeded', data: { object: { id: 'seti_x', metadata: {} } } },
    })
    expect(store.calls).toEqual([])
  })
})

describe('turning autopay off', () => {
  it('a client withdrawing detaches the method and clears every id that could charge', async () => {
    const store = enrollmentStore({
      clientId: 'c1',
      status: 'enrolled',
      paymentMethodId: 'pm_1',
      mandateId: 'mandate_1',
      last4: '6789',
      setupToken: 'tok',
    })
    const stripe = stripeFor()
    const result = await turnOffAutopay({
      store,
      stripe,
      clientId: 'c1',
      by: 'client',
      now: new Date('2026-10-09T12:00:00.000Z'),
    })
    expect(result.changed).toBe(true)
    expect(store.row).toMatchObject({
      status: 'withdrawn',
      paymentMethodId: null,
      mandateId: null,
      withdrawnAt: '2026-10-09T12:00:00.000Z',
      setupToken: 'tok',
    })
    expect(stripe.paymentMethods.detach).toHaveBeenCalledWith('pm_1')
  })

  it('the owner turning it off also kills the link', async () => {
    const store = enrollmentStore({ clientId: 'c1', status: 'invited', setupToken: 'tok' })
    const result = await turnOffAutopay({ store, stripe: stripeFor(), clientId: 'c1', by: 'owner' })
    expect(result.changed).toBe(true)
    expect(store.row).toMatchObject({ status: 'off', setupToken: null })
  })

  it('is a no-op for a client who is already off, withdrawn or unknown', async () => {
    for (const row of [{ clientId: 'c1', status: 'off' }, { clientId: 'c1', status: 'withdrawn' }, null]) {
      const store = enrollmentStore(row)
      const stripe = stripeFor()
      expect((await turnOffAutopay({ store, stripe, clientId: 'c1', by: 'client' })).changed).toBe(false)
      expect(stripe.paymentMethods.detach).not.toHaveBeenCalled()
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Charging                                                                    */
/* -------------------------------------------------------------------------- */

const ON = { AUTOPAY_CHARGING: 'on' }
const enrolledBank = {
  clientId: 'c1',
  status: 'enrolled',
  paymentMethodId: 'pm_bank',
  methodType: 'us_bank_account',
  mandateId: 'mandate_1',
  last4: '6789',
  setupToken: 'tok',
}
const enrolledCard = { ...enrolledBank, paymentMethodId: 'pm_card', methodType: 'card', mandateId: null }
const sentInvoice = {
  id: 'inv-1',
  number: 'INV-2026-10-001',
  status: 'reviewed',
  total: 100,
  lineItems: [{ kind: 'plan', label: 'Monthly service', detail: '', amount: 100 }],
  emailLog: [],
}
const chargeClient = { id: 'c1', name: 'Acme', cardPaymentsEnabled: false }
const decide = (over = {}) =>
  autopayChargeDecision({
    client: chargeClient,
    invoice: sentInvoice,
    enrollment: enrolledBank,
    attempts: [],
    env: ON,
    ...over,
  })

describe('the kill switch', () => {
  it('is on only for exactly "on"', () => {
    expect(autopayChargingEnabled({ AUTOPAY_CHARGING: 'on' })).toBe(true)
    for (const value of [undefined, '', 'off', 'ON', 'true', '1', 'yes', ' on']) {
      expect(autopayChargingEnabled({ AUTOPAY_CHARGING: value }), String(value)).toBe(false)
    }
    expect(autopayChargingEnabled({})).toBe(false)
  })

  it('reads the real environment by default, where it is unset', () => {
    const saved = process.env.AUTOPAY_CHARGING
    delete process.env.AUTOPAY_CHARGING
    try {
      expect(autopayChargingEnabled()).toBe(false)
      expect(autopayChargeDecision({ client: chargeClient, invoice: sentInvoice, enrollment: enrolledBank })).toEqual({
        ok: false,
        reason: 'charging_off',
      })
    } finally {
      if (saved !== undefined) process.env.AUTOPAY_CHARGING = saved
    }
  })
})

describe('who gets charged', () => {
  it('an enrolled bank client on a first send of a positive, unsent invoice', () => {
    expect(decide()).toEqual({ ok: true, channel: 'ach' })
  })

  it('every gate fails closed', () => {
    const cases = {
      charging_off: { env: {} },
      no_enrollment: { enrollment: null },
      not_enrolled: { enrollment: { ...enrolledBank, status: 'invited' } },
      method_not_allowed: { enrollment: { ...enrolledBank, methodType: 'sepa_debit' } },
      client_opted_out: { client: { ...chargeClient, platformInvoicingOptOut: true } },
      nothing_owed: { invoice: { ...sentInvoice, total: 0 } },
      invoice_void: { invoice: { ...sentInvoice, status: 'void' } },
      invoice_paid: { invoice: { ...sentInvoice, status: 'paid' } },
      invoice_processing: { invoice: { ...sentInvoice, status: 'processing' } },
      not_first_send: { invoice: { ...sentInvoice, emailLog: [{ ok: true, to: ['a@b.test'] }] } },
      already_attempted: { attempts: [{ invoiceId: 'inv-1', attemptNo: 1, status: 'failed' }] },
    }
    for (const [reason, over] of Object.entries(cases)) {
      expect(decide(over), reason).toEqual({ ok: false, reason })
    }
  })

  it('a client with no way to withdraw (no setup link) or no saved method is not charged', () => {
    expect(decide({ enrollment: { ...enrolledBank, setupToken: null } }).ok).toBe(false)
    expect(decide({ enrollment: { ...enrolledBank, paymentMethodId: null } }).ok).toBe(false)
  })

  it('a card is charged only while the client still has card payments on', () => {
    expect(decide({ enrollment: enrolledCard }).ok).toBe(false)
    expect(
      decide({ enrollment: enrolledCard, client: { ...chargeClient, cardPaymentsEnabled: true } }),
    ).toEqual({ ok: true, channel: 'card' })
  })

  it('a failed earlier send, a payment email, a link open and a delivery event are not a prior send', () => {
    const noise = [
      { ok: false, error: 'bounced' },
      { ok: true, kind: 'receipt' },
      { ok: true, kind: 'link' },
      { kind: 'delivery', event: 'delivered' },
      { kind: 'payment', event: 'failed' },
    ]
    expect(hasPriorOkInvoiceSend({ emailLog: noise })).toBe(false)
    expect(hasPriorOkInvoiceSend({ emailLog: [...noise, { ok: true }] })).toBe(true)
    expect(decide({ invoice: { ...sentInvoice, emailLog: noise } }).ok).toBe(true)
  })

  it('"Charge again" (attempt 2) needs the latest attempt to have failed, and skips only the first-send rule', () => {
    const resent = { ...sentInvoice, status: 'sent', emailLog: [{ ok: true }] }
    const failed = [{ invoiceId: 'inv-1', attemptNo: 1, status: 'failed' }]
    expect(decide({ invoice: resent, attempts: failed, attemptNo: 2 })).toEqual({ ok: true, channel: 'ach' })
    for (const status of ['claimed', 'processing', 'succeeded']) {
      expect(
        decide({ invoice: resent, attempts: [{ invoiceId: 'inv-1', attemptNo: 1, status }], attemptNo: 2 }).reason,
        status,
      ).toBe('previous_attempt_not_failed')
    }
    expect(decide({ invoice: resent, attempts: [], attemptNo: 2 }).reason).toBe('previous_attempt_not_failed')
    // The other gates still hold on attempt 2.
    expect(decide({ invoice: { ...resent, status: 'void' }, attempts: failed, attemptNo: 2 }).ok).toBe(false)
    expect(decide({ invoice: resent, attempts: failed, attemptNo: 2, env: {} }).ok).toBe(false)
    expect(decide({ invoice: resent, attempts: failed, attemptNo: 3 }).reason).toBe('previous_attempt_not_failed')
  })

  it('an active attempt is recognized', () => {
    expect(hasActiveAutopayAttempt([{ status: 'failed' }])).toBe(false)
    expect(hasActiveAutopayAttempt([{ status: 'failed' }, { status: 'claimed' }])).toBe(true)
    expect(hasActiveAutopayAttempt([])).toBe(false)
  })
})

describe('the PaymentIntent that is created', () => {
  const args = { invoice: sentInvoice, client: chargeClient, customerId: 'cus_1', attemptNo: 1 }

  it('a bank charge: confirmed off-session on the saved method, with the mandate', () => {
    const { params, options } = buildAutopayPaymentIntent({ ...args, enrollment: enrolledBank, channel: 'ach' })
    expect(params).toMatchObject({
      amount: 10000,
      currency: 'usd',
      customer: 'cus_1',
      payment_method: 'pm_bank',
      payment_method_types: ['us_bank_account'],
      confirm: true,
      off_session: true,
      mandate: 'mandate_1',
    })
    expect(params.metadata).toEqual({
      invoiceId: 'inv-1',
      invoiceNumber: 'INV-2026-10-001',
      autopay: '1',
      attempt: '1',
    })
    expect(params.metadata).not.toHaveProperty('channel')
    expect(options).toEqual({ idempotencyKey: 'autopay:inv-1:1' })
  })

  it('a card charge adds the processing fee and says channel: card, with no mandate', () => {
    const { params } = buildAutopayPaymentIntent({ ...args, enrollment: enrolledCard, channel: 'card' })
    const fee = toStripeAmount(cardProcessingFee(100))
    expect(fee).toBeGreaterThan(0)
    expect(params.amount).toBe(10000 + fee)
    expect(params.amount).toBe(autopayChargeCents(sentInvoice, 'card'))
    expect(params.payment_method_types).toEqual(['card'])
    expect(params.metadata.channel).toBe('card')
    expect(params).not.toHaveProperty('mandate')
  })

  it('the idempotency key names the invoice and the attempt', () => {
    const second = buildAutopayPaymentIntent({ ...args, attemptNo: 2, enrollment: enrolledBank, channel: 'ach' })
    expect(second.options.idempotencyKey).toBe('autopay:inv-1:2')
    expect(second.params.metadata.attempt).toBe('2')
  })

  it('never carries a pay session or a return URL: this is not a Checkout', () => {
    const { params } = buildAutopayPaymentIntent({ ...args, enrollment: enrolledBank, channel: 'ach' })
    expect(params).not.toHaveProperty('success_url')
    expect(params).not.toHaveProperty('line_items')
  })
})

describe('chargeAutopayInvoice', () => {
  const details = {
    invoice: sentInvoice,
    client: chargeClient,
    enrollment: enrolledBank,
    customerId: 'cus_1',
    attemptNo: 1,
    channel: 'ach',
  }
  const stripeThat = (create) => ({ paymentIntents: { create: vi.fn(create) } })

  it('creates exactly one PaymentIntent, with the payload and the idempotency key', async () => {
    const stripe = stripeThat(async () => ({ id: 'pi_1', status: 'processing' }))
    const result = await chargeAutopayInvoice({ stripe, ...details })
    expect(result).toEqual({ ok: true, intentId: 'pi_1', status: 'processing' })
    expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1)
    expect(stripe.paymentIntents.create.mock.calls[0][1]).toEqual({ idempotencyKey: 'autopay:inv-1:1' })
  })

  it('answers succeeded for a card that went straight through', async () => {
    const result = await chargeAutopayInvoice({
      stripe: stripeThat(async () => ({ id: 'pi_2', status: 'succeeded' })),
      ...details,
    })
    expect(result).toMatchObject({ ok: true, status: 'succeeded' })
  })

  it('an intent that needs the client is a definite failure, never a success', async () => {
    const result = await chargeAutopayInvoice({
      stripe: stripeThat(async () => ({ id: 'pi_3', status: 'requires_action' })),
      ...details,
    })
    expect(result).toMatchObject({ ok: false, definite: true, intentId: 'pi_3', code: 'requires_action' })
  })

  it('a declined card is a definite failure and keeps the intent id and the code', async () => {
    const declined = Object.assign(new Error('Your card was declined.'), {
      type: 'StripeCardError',
      code: 'card_declined',
      payment_intent: { id: 'pi_4' },
    })
    const result = await chargeAutopayInvoice({
      stripe: stripeThat(async () => {
        throw declined
      }),
      ...details,
    })
    expect(result).toEqual({
      ok: false,
      definite: true,
      intentId: 'pi_4',
      code: 'card_declined',
      message: 'Your card was declined.',
    })
  })

  // THE DOUBLE-CHARGE CASE. A dropped connection may have reached Stripe.
  it('a connection error is AMBIGUOUS, never a definite failure', async () => {
    for (const type of ['StripeConnectionError', 'StripeAPIError', undefined]) {
      const result = await chargeAutopayInvoice({
        stripe: stripeThat(async () => {
          throw Object.assign(new Error('socket hang up'), { type })
        }),
        ...details,
      })
      expect(result.ok, String(type)).toBe(false)
      expect(result.definite, String(type)).toBe(false)
      expect(result.intentId).toBeNull()
    }
  })

  it('no Stripe client means no charge', async () => {
    expect(await chargeAutopayInvoice({ stripe: null, ...details })).toMatchObject({ ok: false, definite: true })
  })
})

describe('what revokes autopay', () => {
  it('the three bank codes that mean the account cannot be debited again', () => {
    for (const code of ['debit_not_authorized', 'account_closed', 'no_account']) {
      expect(autopayFailureRevokes(code), code).toBe(true)
    }
    for (const code of ['insufficient_funds', 'card_declined', 'expired_card', 'authentication_required', null, undefined]) {
      expect(autopayFailureRevokes(code), String(code)).toBe(false)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Review fixes: ambiguity, what Stripe already holds, sessions                 */
/* -------------------------------------------------------------------------- */

describe('which errors are DEFINITE refusals', () => {
  const error = (over) => Object.assign(new Error('x'), over)

  // THE DOUBLE-CHARGE CASE FROM REVIEW: a create that timed out and was retried
  // while Stripe was still processing the original comes back 409
  // idempotency_key_in_use as an invalid-request error. The original may complete.
  it('a 409 idempotency_key_in_use arriving as an invalid-request error is AMBIGUOUS', () => {
    expect(
      isDefiniteStripeRefusal(
        error({ type: 'StripeInvalidRequestError', statusCode: 409, code: 'idempotency_key_in_use' }),
      ),
    ).toBe(false)
  })

  it.each([
    ['a 409 of any kind', { type: 'StripeInvalidRequestError', statusCode: 409 }],
    ['a 409 on the raw error', { type: 'StripeInvalidRequestError', raw: { statusCode: 409 } }],
    ['lock_timeout', { type: 'StripeInvalidRequestError', code: 'lock_timeout' }],
    ['idempotency_key_in_use with no status', { type: 'StripeInvalidRequestError', code: 'idempotency_key_in_use' }],
    ['an idempotency error type', { type: 'StripeIdempotencyError' }],
    ['Stripe-Should-Retry: true', { type: 'StripeInvalidRequestError', headers: { 'stripe-should-retry': 'true' } }],
    ['Stripe-Should-Retry on the raw error', { type: 'StripeAPIError', raw: { headers: { 'stripe-should-retry': 'true' } } }],
    ['a rate limit that says retry', { type: 'StripeRateLimitError', headers: { 'stripe-should-retry': 'true' } }],
  ])('%s is ambiguous', (_name, over) => {
    expect(isDefiniteStripeRefusal(error(over))).toBe(false)
  })

  it('a plain decline, an unknown payment method and a bad key are still definite', () => {
    expect(isDefiniteStripeRefusal(error({ type: 'StripeCardError', statusCode: 402, code: 'card_declined' }))).toBe(true)
    expect(isDefiniteStripeRefusal(error({ type: 'StripeInvalidRequestError', statusCode: 400, code: 'resource_missing' }))).toBe(true)
    expect(isDefiniteStripeRefusal(error({ type: 'StripeAuthenticationError', statusCode: 401 }))).toBe(true)
    expect(
      isDefiniteStripeRefusal(error({ type: 'StripeInvalidRequestError', headers: { 'stripe-should-retry': 'false' } })),
    ).toBe(true)
  })

  it('chargeAutopayInvoice reports that 409 as not definite', async () => {
    const stripe = {
      paymentIntents: {
        create: async () => {
          throw Object.assign(new Error('Keys for idempotent requests can only be used for one request at a time.'), {
            type: 'StripeInvalidRequestError',
            statusCode: 409,
            code: 'idempotency_key_in_use',
          })
        },
      },
    }
    const result = await chargeAutopayInvoice({
      stripe,
      invoice: sentInvoice,
      client: chargeClient,
      enrollment: enrolledBank,
      customerId: 'cus_1',
      attemptNo: 1,
      channel: 'ach',
    })
    expect(result).toMatchObject({ ok: false, definite: false, code: 'idempotency_key_in_use' })
  })
})

describe('findInvoiceIntents', () => {
  const intent = (id, invoiceId, status, attempt = '1') => ({ id, status, metadata: { invoiceId, attempt } })

  it('lists by CUSTOMER (read-after-write), never by search, and keeps only this invoice', async () => {
    const list = vi.fn(async () => ({
      data: [intent('pi_a', 'inv-1', 'succeeded'), intent('pi_b', 'inv-2', 'succeeded'), { id: 'pi_c', status: 'succeeded' }],
      has_more: false,
    }))
    const search = vi.fn()
    const found = await findInvoiceIntents({ stripe: { paymentIntents: { list, search } }, customerId: 'cus_1', invoiceId: 'inv-1' })
    expect(found).toEqual([
      { id: 'pi_a', status: 'succeeded', attempt: '1', errorCode: null, errorMessage: null },
    ])
    expect(list).toHaveBeenCalledWith({ customer: 'cus_1', limit: 100 })
    expect(search).not.toHaveBeenCalled()
  })

  it('follows the pages', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ data: [intent('pi_1', 'inv-9', 'canceled')], has_more: true })
      .mockResolvedValueOnce({ data: [intent('pi_2', 'inv-1', 'processing', '2')], has_more: false })
    const found = await findInvoiceIntents({ stripe: { paymentIntents: { list } }, customerId: 'cus_1', invoiceId: 'inv-1' })
    expect(found.map((entry) => entry.id)).toEqual(['pi_2'])
    expect(list.mock.calls[1][0]).toMatchObject({ starting_after: 'pi_1' })
  })

  it('finds nothing without a customer, and throws when Stripe cannot be read', async () => {
    expect(await findInvoiceIntents({ stripe: {}, customerId: null, invoiceId: 'inv-1' })).toEqual([])
    await expect(
      findInvoiceIntents({
        stripe: { paymentIntents: { list: async () => { throw new Error('down') } } },
        customerId: 'cus_1',
        invoiceId: 'inv-1',
      }),
    ).rejects.toThrow('down')
  })

  it('moneyMovedIntent is succeeded or processing, not a decline or a cancellation', () => {
    expect(moneyMovedIntent([{ status: 'canceled' }, { status: 'requires_payment_method' }])).toBeNull()
    expect(moneyMovedIntent([{ status: 'canceled' }, { id: 'pi_x', status: 'processing' }]).id).toBe('pi_x')
    expect(moneyMovedIntent([{ id: 'pi_y', status: 'succeeded' }]).id).toBe('pi_y')
  })
})

describe('retireCheckoutSessions', () => {
  const stripeWith = (statuses, { failExpire = false } = {}) => {
    const state = { ...statuses }
    return {
      state,
      checkout: {
        sessions: {
          retrieve: vi.fn(async (id) => ({ id, status: state[id] })),
          expire: vi.fn(async (id) => {
            if (failExpire) throw new Error('cannot expire')
            state[id] = 'expired'
            return { id }
          }),
        },
      },
    }
  }

  it('expires every open session and is ok', async () => {
    const stripe = stripeWith({ cs_a: 'open', cs_b: 'open', cs_c: 'expired' })
    expect(await retireCheckoutSessions({ stripe, sessionIds: ['cs_a', 'cs_b', 'cs_c', null, 'cs_a'] })).toEqual({ ok: true })
    expect(stripe.checkout.sessions.expire.mock.calls.map((call) => call[0])).toEqual(['cs_a', 'cs_b'])
  })

  it('a COMPLETE session means the client has paid by link: do not charge', async () => {
    const stripe = stripeWith({ cs_a: 'complete' })
    expect(await retireCheckoutSessions({ stripe, sessionIds: ['cs_a'] })).toMatchObject({ ok: false, reason: 'session_complete' })
    expect(stripe.checkout.sessions.expire).not.toHaveBeenCalled()
  })

  it('a session that completes between the read and the expire is also a refusal', async () => {
    const stripe = stripeWith({ cs_a: 'open' }, { failExpire: true })
    stripe.checkout.sessions.retrieve
      .mockResolvedValueOnce({ id: 'cs_a', status: 'open' })
      .mockResolvedValueOnce({ id: 'cs_a', status: 'complete' })
    expect(await retireCheckoutSessions({ stripe, sessionIds: ['cs_a'] })).toMatchObject({ reason: 'session_complete' })
  })

  it('a session that will not close, or a Stripe that cannot be read, is a refusal too', async () => {
    expect(
      await retireCheckoutSessions({ stripe: stripeWith({ cs_a: 'open' }, { failExpire: true }), sessionIds: ['cs_a'] }),
    ).toMatchObject({ ok: false, reason: 'sessions_not_retired' })
    const down = { checkout: { sessions: { retrieve: async () => { throw new Error('down') } } } }
    expect(await retireCheckoutSessions({ stripe: down, sessionIds: ['cs_a'] })).toMatchObject({
      ok: false,
      reason: 'stripe_unreachable',
    })
  })

  it('has nothing to do for an invoice with no sessions', async () => {
    expect(await retireCheckoutSessions({ stripe: {}, sessionIds: [null, undefined, ''] })).toEqual({ ok: true })
  })
})
