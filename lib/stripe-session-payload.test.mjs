import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * What is actually SENT to Stripe when a session is minted.
 *
 * `stripe-rail.test.mjs` covers the offline behavior with the real SDK; this
 * file is the other half — a fake SDK that records the create call, so the
 * payload can be asserted without a network or an account. It lives in its own
 * file because mocking `stripe` module-wide would also stub out the signature
 * verification those tests depend on being real.
 *
 * The two things worth pinning: the ACH session is the DEFAULT and must not
 * have grown a fee or a card method, and the card session must carry both.
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

const { createInvoiceCardCheckoutSession, createInvoiceCheckoutSession } = await import(
  './stripe-rail.js'
)
const { CARD_PROCESSING_FEE_LABEL } = await import('./invoice-lines.js')

const savedKey = process.env.STRIPE_SECRET_KEY

beforeEach(() => {
  created.length = 0
  process.env.STRIPE_SECRET_KEY = 'sk_test_payload'
})

afterEach(() => {
  if (savedKey === undefined) delete process.env.STRIPE_SECRET_KEY
  else process.env.STRIPE_SECRET_KEY = savedKey
})

const invoice = {
  id: 'inv-1',
  number: 'INV-2026-08-001',
  period: '2026-08',
  total: 100,
  lineItems: [{ kind: 'plan', label: 'Monthly service', detail: 'August', amount: 100 }],
}
const client = { id: 'c1', name: 'Acme LLC' }
const args = { invoice, client, customerId: 'cus_1', appUrl: 'https://app.example.com' }

describe('the ACH session is unchanged by card existing', () => {
  it('is bank-transfer only, with no fee line and no channel marker', async () => {
    const result = await createInvoiceCheckoutSession(args)
    expect(result.ok).toBe(true)

    const params = created[0]
    expect(params.payment_method_types).toEqual(['us_bank_account'])
    expect(params.payment_method_options.us_bank_account.verification_method).toBe('automatic')
    expect(params.line_items).toHaveLength(1)
    expect(params.line_items[0].price_data.unit_amount).toBe(10000)
    // Absent, not 'ach': every session minted before card existed is also
    // absent, and the webhook reads absence as bank transfer.
    expect(params.metadata).toEqual({ invoiceId: 'inv-1', invoiceNumber: 'INV-2026-08-001' })
    expect(params.payment_intent_data.metadata.channel).toBeUndefined()
  })
})

describe('the card session', () => {
  it('is card-only and carries the fee as its final line', async () => {
    const result = await createInvoiceCardCheckoutSession(args)
    expect(result.ok).toBe(true)

    const params = created[0]
    expect(params.payment_method_types).toEqual(['card'])
    // No `us_bank_account` options on a session that cannot take one.
    expect(params.payment_method_options).toBeUndefined()
    expect(params.line_items).toHaveLength(2)
    expect(params.line_items[1].price_data.product_data.name).toBe(CARD_PROCESSING_FEE_LABEL)
    expect(params.line_items[1].price_data.unit_amount).toBe(330)
  })

  it('marks the channel on the session AND its payment intent', async () => {
    await createInvoiceCardCheckoutSession(args)
    const params = created[0]
    // Both, because the webhook sees the session on one event and only the
    // PaymentIntent on the next.
    expect(params.metadata).toEqual({
      invoiceId: 'inv-1',
      invoiceNumber: 'INV-2026-08-001',
      channel: 'card',
    })
    expect(params.payment_intent_data.metadata.channel).toBe('card')
  })

  it('names the same invoice and returns to the same pages as the ACH one', async () => {
    await createInvoiceCheckoutSession(args)
    await createInvoiceCardCheckoutSession(args)
    const [ach, card] = created
    expect(card.success_url).toBe(ach.success_url)
    expect(card.cancel_url).toBe(ach.cancel_url)
    expect(card.customer).toBe('cus_1')
    expect(card.payment_intent_data.description).toBe(ach.payment_intent_data.description)
  })
})
