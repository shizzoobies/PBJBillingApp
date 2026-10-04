import { describe, expect, it, vi } from 'vitest'

import { ensureStripeCustomer } from './stripe-rail.js'

/**
 * `ensureStripeCustomer` - the ONE place a client's Stripe customer is made.
 * Autopay stores a saved bank account on that customer, so a duplicate is not
 * cosmetic: the details would sit on the copy nobody charges.
 */

const fakeStripe = (id = 'cus_new') => ({
  customers: { create: vi.fn(async () => ({ id })) },
})
const fakeStore = () => ({ setClientStripeCustomerId: vi.fn(async () => undefined) })

describe('ensureStripeCustomer', () => {
  it('returns the stored customer without calling Stripe', async () => {
    const stripe = fakeStripe()
    const store = fakeStore()
    const id = await ensureStripeCustomer({
      client: { id: 'c1', name: 'Acme', stripeCustomerId: 'cus_old' },
      store,
      stripe,
    })
    expect(id).toBe('cus_old')
    expect(stripe.customers.create).not.toHaveBeenCalled()
    expect(store.setClientStripeCustomerId).not.toHaveBeenCalled()
  })

  it('creates one, with the client id in metadata and a per-client idempotency key, then stores it', async () => {
    const stripe = fakeStripe('cus_made')
    const store = fakeStore()
    const id = await ensureStripeCustomer({
      client: { id: 'c1', name: 'Acme', email: 'ap@acme.test' },
      store,
      stripe,
    })
    expect(id).toBe('cus_made')
    expect(stripe.customers.create).toHaveBeenCalledWith(
      { name: 'Acme', email: 'ap@acme.test', metadata: { clientId: 'c1' } },
      { idempotencyKey: 'pbj-customer-c1' },
    )
    expect(store.setClientStripeCustomerId).toHaveBeenCalledWith('c1', 'cus_made')
  })

  it('leaves the email off when the client has none', async () => {
    const stripe = fakeStripe()
    await ensureStripeCustomer({ client: { id: 'c1', name: 'Acme' }, store: fakeStore(), stripe })
    expect(stripe.customers.create.mock.calls[0][0]).not.toHaveProperty('email')
  })

  it('throws when Stripe is not configured, and when Stripe refuses', async () => {
    await expect(
      ensureStripeCustomer({ client: { id: 'c1' }, store: fakeStore(), stripe: null }),
    ).rejects.toThrow(/not configured/i)

    const refusing = { customers: { create: vi.fn(async () => { throw new Error('boom') }) } }
    const store = fakeStore()
    await expect(
      ensureStripeCustomer({ client: { id: 'c1' }, store, stripe: refusing }),
    ).rejects.toThrow('boom')
    expect(store.setClientStripeCustomerId).not.toHaveBeenCalled()
  })
})
