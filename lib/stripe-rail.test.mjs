import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildCheckoutLineItems,
  createInvoiceCheckoutSession,
  isStripeConfigured,
  isStripeTestMode,
  isStripeWebhookConfigured,
  stripeClient,
  toStripeAmount,
  verifyStripeEvent,
} from './stripe-rail.js'

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
