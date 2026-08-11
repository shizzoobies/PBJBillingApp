import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildCardCheckoutLineItems,
  buildCheckoutLineItems,
  createInvoiceCardCheckoutSession,
  createInvoiceCheckoutSession,
  isStripeConfigured,
  isStripeTestMode,
  isStripeWebhookConfigured,
  resolveWebhookChannel,
  stripeClient,
  toStripeAmount,
  verifyStripeEvent,
} from './stripe-rail.js'
import { CARD_PROCESSING_FEE_LABEL, cardProcessingFee } from './invoice-lines.js'

/**
 * The Stripe rail's offline behavior (I3).
 *
 * Two things this exists to protect. First, an UNCONFIGURED app must keep
 * working: production runs without Stripe keys until the sandbox work is done,
 * and generating / reviewing / printing invoices cannot start throwing because
 * a payment key is absent. Second, what gets sent to Stripe has to match what
 * the client was invoiced — a wrong amount here is a wrong debit from a real
 * bank account.
 */

const savedKey = process.env.STRIPE_SECRET_KEY
const savedHook = process.env.STRIPE_WEBHOOK_SECRET

beforeEach(() => {
  delete process.env.STRIPE_SECRET_KEY
  delete process.env.STRIPE_WEBHOOK_SECRET
})

afterEach(() => {
  if (savedKey === undefined) delete process.env.STRIPE_SECRET_KEY
  else process.env.STRIPE_SECRET_KEY = savedKey
  if (savedHook === undefined) delete process.env.STRIPE_WEBHOOK_SECRET
  else process.env.STRIPE_WEBHOOK_SECRET = savedHook
})

const invoice = (over = {}) => ({
  id: 'inv-1',
  number: 'INV-2026-08-001',
  period: '2026-08',
  total: 500,
  lineItems: [{ kind: 'plan', label: 'Monthly service', detail: 'August', amount: 500 }],
  ...over,
})
const client = { id: 'c1', name: 'Acme LLC' }

describe('configuration probes', () => {
  it('reports unconfigured when the key is absent', () => {
    expect(isStripeConfigured()).toBe(false)
    expect(isStripeWebhookConfigured()).toBe(false)
    expect(stripeClient()).toBeNull()
  })

  it('reports configured once a key is present', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc123'
    expect(isStripeConfigured()).toBe(true)
    expect(isStripeTestMode()).toBe(true)
  })

  it('distinguishes a live key from a test one', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_abc123'
    expect(isStripeTestMode()).toBe(false)
  })
})

describe('toStripeAmount', () => {
  it('converts dollars to whole cents', () => {
    expect(toStripeAmount(500)).toBe(50000)
    expect(toStripeAmount(1234.56)).toBe(123456)
  })

  // Float math leaks: 19.99 * 100 is 1998.9999... Rounding once here is what
  // keeps a cent from going missing off a real bank debit.
  it('rounds rather than truncating', () => {
    expect(toStripeAmount(19.99)).toBe(1999)
    expect(toStripeAmount(0.1 + 0.2)).toBe(30)
    expect(toStripeAmount(5.005)).toBe(501)
  })

  it('treats junk as zero instead of NaN', () => {
    expect(toStripeAmount('abc')).toBe(0)
    expect(toStripeAmount(null)).toBe(0)
    expect(toStripeAmount(undefined)).toBe(0)
  })
})

describe('buildCheckoutLineItems', () => {
  it('mirrors the invoice lines so the payer sees the same breakdown', () => {
    const items = buildCheckoutLineItems(
      invoice({
        total: 540,
        lineItems: [
          { kind: 'plan', label: 'Monthly service', detail: 'August', amount: 500 },
          { kind: 'recurring', label: 'Recurring: Software', detail: 'monthly', amount: 40 },
        ],
      }),
      client,
    )
    expect(items).toHaveLength(2)
    expect(items[0].price_data.unit_amount).toBe(50000)
    expect(items[0].price_data.product_data.name).toBe('Monthly service')
    expect(items[0].price_data.product_data.description).toBe('August')
    expect(items[1].price_data.unit_amount).toBe(4000)
  })

  it('omits the description when a line has no detail', () => {
    const items = buildCheckoutLineItems(
      invoice({ lineItems: [{ label: 'Services', detail: '', amount: 500 }] }),
      client,
    )
    expect(items[0].price_data.product_data.description).toBeUndefined()
  })

  it('falls back to a generic name for an unlabelled line', () => {
    const items = buildCheckoutLineItems(
      invoice({ lineItems: [{ label: '', detail: '', amount: 500 }] }),
      client,
    )
    expect(items[0].price_data.product_data.name).toBe('Services')
  })

  /**
   * The important one. Stripe rejects a negative line item, so an invoice
   * carrying a credit from last month cannot be itemized — it collapses to the
   * single amount actually owed. Sending the positive lines only would debit
   * the client MORE than the invoice says.
   */
  it('collapses to one total line when any line is a credit', () => {
    const items = buildCheckoutLineItems(
      invoice({
        total: 425,
        lineItems: [
          { kind: 'plan', label: 'Monthly service', detail: '', amount: 500 },
          { kind: 'adjustment', label: 'Adjustment — 2026-07', detail: '', amount: -75 },
        ],
      }),
      client,
    )
    expect(items).toHaveLength(1)
    expect(items[0].price_data.unit_amount).toBe(42500)
    expect(items[0].price_data.product_data.name).toBe('Invoice INV-2026-08-001')
    expect(items[0].price_data.product_data.description).toBe('Acme LLC · 2026-08')
  })

  it('charges nothing when a credit cancels the invoice out', () => {
    expect(
      buildCheckoutLineItems(
        invoice({
          total: 0,
          lineItems: [
            { label: 'Monthly service', detail: '', amount: 500 },
            { label: 'Credit', detail: '', amount: -500 },
          ],
        }),
        client,
      ),
    ).toEqual([])
  })

  it('drops zero-amount lines rather than sending them to Stripe', () => {
    const items = buildCheckoutLineItems(
      invoice({
        total: 500,
        lineItems: [
          { label: 'Monthly service', detail: '', amount: 500 },
          { label: 'Included at no charge', detail: '', amount: 0 },
        ],
      }),
      client,
    )
    expect(items).toHaveLength(1)
  })

  it('survives an invoice with no lines at all', () => {
    expect(buildCheckoutLineItems(invoice({ lineItems: [] }), client)).toEqual([])
    expect(buildCheckoutLineItems({}, client)).toEqual([])
  })
})

/**
 * The card channel's line items. Same lines the client was invoiced, plus the
 * fee — so the payment page adds up to what the email said they would pay.
 */
describe('buildCardCheckoutLineItems', () => {
  it('is the ACH lines plus a final processing-fee line', () => {
    const subject = invoice({
      total: 100,
      lineItems: [{ kind: 'plan', label: 'Monthly service', detail: 'August', amount: 100 }],
    })
    const ach = buildCheckoutLineItems(subject, client)
    const card = buildCardCheckoutLineItems(subject, client)

    expect(card).toHaveLength(ach.length + 1)
    expect(card.slice(0, ach.length)).toEqual(ach)
    const fee = card[card.length - 1]
    expect(fee.price_data.product_data.name).toBe(CARD_PROCESSING_FEE_LABEL)
    expect(fee.price_data.unit_amount).toBe(toStripeAmount(cardProcessingFee(100)))
  })

  it('charges the client the invoice plus the fee, to the cent', () => {
    const subject = invoice({
      total: 100,
      lineItems: [{ kind: 'plan', label: 'Monthly service', detail: 'August', amount: 100 }],
    })
    const charged = buildCardCheckoutLineItems(subject, client).reduce(
      (sum, item) => sum + item.price_data.unit_amount,
      0,
    )
    expect(charged).toBe(10330)
  })

  // The credit-line collapse still applies: the fee lands after whatever the
  // ACH builder produced, so a collapsed invoice is one total line + the fee.
  it('adds the fee after a collapsed credit invoice, not instead of it', () => {
    const items = buildCardCheckoutLineItems(
      invoice({
        total: 425,
        lineItems: [
          { kind: 'plan', label: 'Monthly service', detail: '', amount: 500 },
          { kind: 'adjustment', label: 'Adjustment — 2026-07', detail: '', amount: -75 },
        ],
      }),
      client,
    )
    expect(items).toHaveLength(2)
    expect(items[0].price_data.unit_amount).toBe(42500)
    expect(items[1].price_data.product_data.name).toBe(CARD_PROCESSING_FEE_LABEL)
  })

  it('charges nothing at all when there is nothing to charge', () => {
    expect(buildCardCheckoutLineItems(invoice({ total: 0, lineItems: [] }), client)).toEqual([])
  })
})

/**
 * Which channel a webhook belongs to. Getting this wrong either loses the fee
 * on a card payment or bills a fee to someone who paid by bank transfer.
 */
describe('resolveWebhookChannel', () => {
  const bothLive = {
    id: 'inv-1',
    stripeCheckoutSessionId: 'cs_ach',
    stripeCardSessionId: 'cs_card',
  }

  it('reads the card channel off the metadata we set', () => {
    expect(
      resolveWebhookChannel({
        eventType: 'payment_intent.succeeded',
        object: { id: 'pi_1', metadata: { channel: 'card' } },
        invoice: bothLive,
      }),
    ).toEqual({ isCard: true, siblingSessionId: 'cs_ach' })
  })

  it('recognizes the card session by id even without metadata', () => {
    expect(
      resolveWebhookChannel({
        eventType: 'checkout.session.completed',
        object: { id: 'cs_card' },
        invoice: bothLive,
      }),
    ).toEqual({ isCard: true, siblingSessionId: 'cs_ach' })
  })

  // The ACH session carries no `channel` key at all, and neither does any
  // session minted before card existed. Absent must mean bank transfer.
  it('treats an absent channel as ACH and names the card session as stale', () => {
    expect(
      resolveWebhookChannel({
        eventType: 'checkout.session.completed',
        object: { id: 'cs_ach' },
        invoice: bothLive,
      }),
    ).toEqual({ isCard: false, siblingSessionId: 'cs_card' })
  })

  it('has no sibling to retire for an ACH-only client', () => {
    expect(
      resolveWebhookChannel({
        eventType: 'checkout.session.completed',
        object: { id: 'cs_ach' },
        invoice: { id: 'inv-1', stripeCheckoutSessionId: 'cs_ach', stripeCardSessionId: null },
      }),
    ).toEqual({ isCard: false, siblingSessionId: null })
  })

  it('never asks to expire the session that was just paid', () => {
    const result = resolveWebhookChannel({
      eventType: 'checkout.session.completed',
      object: { id: 'cs_ach' },
      invoice: { id: 'inv-1', stripeCheckoutSessionId: 'cs_ach', stripeCardSessionId: 'cs_ach' },
    })
    expect(result.siblingSessionId).toBeNull()
  })
})

describe('createInvoiceCheckoutSession without Stripe configured', () => {
  it('refuses with a readable reason instead of throwing', async () => {
    const result = await createInvoiceCheckoutSession({
      invoice: invoice(),
      client,
      appUrl: 'https://app.example.com',
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/not configured/i)
  })

  it('refuses a zero or negative invoice before reaching Stripe', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc123'
    for (const total of [0, -25]) {
      const result = await createInvoiceCheckoutSession({
        invoice: invoice({ total }),
        client,
        appUrl: 'https://app.example.com',
      })
      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/positive amount/i)
    }
  })

  // The card session is held to the same rules: an unconfigured or unpayable
  // invoice refuses with a sentence rather than throwing mid-send.
  it('refuses the card session on the same terms', async () => {
    const unconfigured = await createInvoiceCardCheckoutSession({
      invoice: invoice(),
      client,
      appUrl: 'https://app.example.com',
    })
    expect(unconfigured.ok).toBe(false)
    expect(unconfigured.reason).toMatch(/not configured/i)

    process.env.STRIPE_SECRET_KEY = 'sk_test_abc123'
    const zero = await createInvoiceCardCheckoutSession({
      invoice: invoice({ total: 0 }),
      client,
      appUrl: 'https://app.example.com',
    })
    expect(zero.ok).toBe(false)
    expect(zero.reason).toMatch(/positive amount/i)
  })
})

describe('verifyStripeEvent', () => {
  // The signature check is the ONLY thing between this endpoint and anyone on
  // the internet marking invoices paid, so every failure path returns null.
  it('returns null when Stripe is unconfigured', () => {
    expect(verifyStripeEvent('{}', 'sig')).toBeNull()
  })

  it('returns null when the webhook secret is missing', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc123'
    expect(verifyStripeEvent('{}', 'sig')).toBeNull()
  })

  it('returns null when there is no signature header', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc123'
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_abc'
    expect(verifyStripeEvent('{}', '')).toBeNull()
  })

  it('returns null for a forged signature rather than trusting the body', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc123'
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_abc'
    const forged = JSON.stringify({ type: 'payment_intent.succeeded', id: 'evt_forged' })
    expect(verifyStripeEvent(forged, 't=1,v1=deadbeef')).toBeNull()
  })
})
