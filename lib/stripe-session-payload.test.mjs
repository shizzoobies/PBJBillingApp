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
/**
 * THE PAY LINK MINTS A SESSION ON EVERY CLICK, so "minting again" stopped being
 * an exceptional event and became the normal one. Two things follow.
 *
 * First, two mints for one invoice must produce the SAME charge — same lines,
 * same amount, same method. A client who opens the link twice and gets two
 * different bills is a support call at best.
 *
 * Second, the invoice id has to ride on the PaymentIntent as well as the
 * session, because the webhook sees the session on one event and only the
 * intent on the next — and with a session minted per click there are more of
 * both in flight than there used to be.
 */
describe('a session minted twice for one invoice charges the same thing twice', () => {
  it('repeats the lines, the methods and the metadata exactly', async () => {
    await createInvoiceCheckoutSession(args)
    await createInvoiceCheckoutSession(args)
    const [first, second] = created

    expect(second.line_items).toEqual(first.line_items)
    expect(second.metadata).toEqual(first.metadata)
    expect(second.payment_method_types).toEqual(first.payment_method_types)
    expect(second.payment_method_options).toEqual(first.payment_method_options)
  })

  it('names the invoice on the session AND on the payment intent', async () => {
    await createInvoiceCheckoutSession(args)
    const params = created[0]
    expect(params.metadata.invoiceId).toBe('inv-1')
    expect(params.payment_intent_data.metadata.invoiceId).toBe('inv-1')
  })
})

/**
 * `returnTo` — where Stripe sends the payer afterwards.
 *
 * Today's default points at `/invoices`, which is the AUTHENTICATED app: a
 * client who has just handed over their bank details lands on a sign-in screen
 * they can never get past. The public pay page fixes that, and the ABSENT case
 * has to stay byte-for-byte identical so nothing that calls these two functions
 * without it changes at all.
 */
describe('returnTo', () => {
  it('leaves the URLs exactly as they were when it is absent', async () => {
    await createInvoiceCheckoutSession(args)
    await createInvoiceCardCheckoutSession(args)
    const [ach, card] = created

    expect(ach.success_url).toBe('https://app.example.com/invoices?paid=inv-1')
    expect(ach.cancel_url).toBe('https://app.example.com/invoices?cancelled=inv-1')
    expect(card.success_url).toBe(ach.success_url)
    expect(card.cancel_url).toBe(ach.cancel_url)
  })

  it('sends the payer back to the public pay page on both channels', async () => {
    const returnTo = 'https://app.example.com/pay/Qk3z-vN9_pY2sLd4TgH1xWmC8rEbA6uJfKq0nZi5-Tw'
    await createInvoiceCheckoutSession({ ...args, returnTo })
    await createInvoiceCardCheckoutSession({ ...args, returnTo })

    for (const params of created) {
      expect(params.success_url).toBe(`${returnTo}?paid=1`)
      expect(params.cancel_url).toBe(`${returnTo}?cancelled=1`)
    }
  })

  // The link the client clicked is the link they come back to — including the
  // /card one, which must not quietly drop them onto the bank-transfer page.
  it('honors a card pay page without rewriting the path', async () => {
    const returnTo = 'https://app.example.com/pay/Qk3z-vN9_pY2sLd4TgH1xWmC8rEbA6uJfKq0nZi5-Tw/card'
    await createInvoiceCardCheckoutSession({ ...args, returnTo })
    expect(created[0].success_url).toContain('/pay/')
    expect(created[0].success_url).toContain('/card?paid=1')
  })
})
