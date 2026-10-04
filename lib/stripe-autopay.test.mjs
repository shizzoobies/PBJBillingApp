import { describe, expect, it, vi } from 'vitest'

import {
  AUTOPAY_STATUSES,
  applyAutopaySetupEvent,
  autopayBadgeFor,
  autopaySummary,
  buildAutopaySetupSessionParams,
  classifySetupEvent,
  createAutopaySetupSession,
  describeSetupIntent,
  emptyAutopay,
  latestAttemptByInvoice,
  newSetupToken,
  turnOffAutopay,
} from './stripe-autopay.js'

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
