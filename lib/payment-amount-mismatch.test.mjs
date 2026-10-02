import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  amountMismatchOwnerMessage,
  paymentInProgress,
  flagPaymentAmountMismatch,
  paymentAmountMismatch,
  paymentIntentIdOf,
  receivedPaymentCents,
  unhandledAmountMismatch,
} from './payment-amount-mismatch.js'
import { unresolvedPaymentFailure } from './invoice-overdue.js'

/**
 * A payment for a different amount than the invoice total (featreq-9cc3c370).
 *
 * The rule is pure and tested here; that a REAL ACH and card payment compare
 * equal (the Checkout session's own line items against the real store's apply)
 * is proven in db/store-staleness.test.mjs.
 */

const session = (amountTotal, over = {}) => ({
  id: 'cs_1',
  payment_intent: 'pi_1',
  amount_total: amountTotal,
  ...over,
})
const intent = (over = {}) => ({ id: 'pi_1', amount: 40000, amount_received: 40000, ...over })

describe('paymentAmountMismatch', () => {
  it('a normal bank payment compares equal', () => {
    expect(
      paymentAmountMismatch({
        eventType: 'checkout.session.completed',
        object: session(40000),
        invoice: { total: 400 },
      }),
    ).toBeNull()
    expect(
      paymentAmountMismatch({
        eventType: 'payment_intent.succeeded',
        object: intent(),
        invoice: { total: 400 },
      }),
    ).toBeNull()
  })

  it('a normal card payment compares equal against the total that already carries the fee line', () => {
    // $400 invoice + its $12.26 gross-up fee = $412.26, which is what the card session charged.
    expect(
      paymentAmountMismatch({
        eventType: 'checkout.session.completed',
        object: session(41226),
        invoice: { total: 412.26 },
      }),
    ).toBeNull()
    expect(
      paymentAmountMismatch({
        eventType: 'payment_intent.succeeded',
        object: intent({ amount: 41226, amount_received: 41226 }),
        invoice: { total: 412.26 },
      }),
    ).toBeNull()
  })

  it('rounds the invoice total to cents the way the session was minted (no float drift)', () => {
    // 1234.56 * 100 = 123455.99999999999 in floating point.
    expect(
      paymentAmountMismatch({
        eventType: 'payment_intent.succeeded',
        object: intent({ amount_received: 123456 }),
        invoice: { total: 1234.56 },
      }),
    ).toBeNull()
  })

  it('flags an underpaid bank payment, with both amounts in cents', () => {
    expect(
      paymentAmountMismatch({
        eventType: 'payment_intent.succeeded',
        object: intent({ amount_received: 35000 }),
        invoice: { total: 400 },
      }),
    ).toEqual({ expectedCents: 40000, receivedCents: 35000 })
  })

  it('flags a card paid on an old total: the invoice has since gone up', () => {
    // The page was opened at $400 + $12.26 fee; the invoice is now $450 + $13.75 fee.
    expect(
      paymentAmountMismatch({
        eventType: 'checkout.session.completed',
        object: session(41226),
        invoice: { total: 463.75 },
      }),
    ).toEqual({ expectedCents: 46375, receivedCents: 41226 })
  })

  it('reads amount_received, and falls back to amount only when it is not a number', () => {
    const invoice = { total: 400 }
    expect(
      paymentAmountMismatch({
        eventType: 'payment_intent.succeeded',
        object: { id: 'pi_1', amount: 40000, amount_received: 35000 },
        invoice,
      }),
    ).toEqual({ expectedCents: 40000, receivedCents: 35000 })
    // amount_received missing: the intent's own amount stands in.
    expect(
      paymentAmountMismatch({
        eventType: 'payment_intent.succeeded',
        object: { id: 'pi_1', amount: 40000 },
        invoice,
      }),
    ).toBeNull()
    expect(
      paymentAmountMismatch({
        eventType: 'payment_intent.succeeded',
        object: { id: 'pi_1', amount: 30000, amount_received: null },
        invoice,
      }),
    ).toEqual({ expectedCents: 40000, receivedCents: 30000 })
  })

  it('does nothing when the event does not say how much was collected', () => {
    const invoice = { total: 400 }
    for (const object of [
      {},
      { amount_total: null },
      { amount_total: '40000' },
      { amount_total: Number.NaN },
      { amount_total: Number.POSITIVE_INFINITY },
    ]) {
      expect(
        paymentAmountMismatch({ eventType: 'checkout.session.completed', object, invoice }),
      ).toBeNull()
    }
    for (const object of [{}, { amount: 'a lot', amount_received: 'x' }, { amount_received: Number.NaN }]) {
      expect(
        paymentAmountMismatch({ eventType: 'payment_intent.succeeded', object, invoice }),
      ).toBeNull()
    }
  })

  it('has no answer for other event types or an invoice with no usable total', () => {
    expect(
      paymentAmountMismatch({
        eventType: 'payment_intent.payment_failed',
        object: intent({ amount_received: 1 }),
        invoice: { total: 400 },
      }),
    ).toBeNull()
    for (const invoice of [null, {}, { total: null }, { total: 'abc' }]) {
      expect(
        paymentAmountMismatch({
          eventType: 'payment_intent.succeeded',
          object: intent({ amount_received: 1 }),
          invoice,
        }),
      ).toBeNull()
    }
  })
})

describe('receivedPaymentCents and paymentIntentIdOf', () => {
  it('reads the right field per event type', () => {
    expect(receivedPaymentCents('checkout.session.completed', { amount_total: 100, amount: 5 })).toBe(100)
    expect(receivedPaymentCents('payment_intent.succeeded', { amount_received: 90, amount: 5 })).toBe(90)
    expect(receivedPaymentCents('payment_intent.succeeded', { amount: 5 })).toBe(5)
    expect(receivedPaymentCents('charge.refunded', { amount_total: 1 })).toBeNull()
  })

  it('takes the intent from the session string, or the intent itself', () => {
    expect(paymentIntentIdOf('checkout.session.completed', { payment_intent: 'pi_9' })).toBe('pi_9')
    expect(paymentIntentIdOf('checkout.session.completed', { payment_intent: { id: 'pi_9' } })).toBeNull()
    expect(paymentIntentIdOf('checkout.session.completed', {})).toBeNull()
    expect(paymentIntentIdOf('payment_intent.succeeded', { id: 'pi_7' })).toBe('pi_7')
  })
})

describe('unhandledAmountMismatch (derived from the log)', () => {
  const marker = (over = {}) => ({
    kind: 'payment',
    event: 'amount-mismatch',
    at: '2026-09-10T14:00:00.000Z',
    paymentIntentId: 'pi_1',
    expectedCents: 40000,
    receivedCents: 35000,
    ...over,
  })
  const handled = (over = {}) => ({
    kind: 'payment',
    event: 'amount-mismatch-handled',
    at: '2026-09-11T10:00:00.000Z',
    by: 'owner-1',
    paymentIntentId: 'pi_1',
    ...over,
  })

  it('reads an unacknowledged marker, and nothing from an invoice without one', () => {
    expect(unhandledAmountMismatch({ emailLog: [marker()] })).toEqual({
      expectedCents: 40000,
      receivedCents: 35000,
      at: '2026-09-10T14:00:00.000Z',
      paymentIntentId: 'pi_1',
    })
    expect(unhandledAmountMismatch({ emailLog: [] })).toBeNull()
    expect(unhandledAmountMismatch({})).toBeNull()
    expect(unhandledAmountMismatch(null)).toBeNull()
  })

  it('a later handled entry for the same payment clears it', () => {
    expect(unhandledAmountMismatch({ emailLog: [marker(), handled()] })).toBeNull()
  })

  it('a handled entry before the marker, or for another payment, does not', () => {
    expect(unhandledAmountMismatch({ emailLog: [handled(), marker()] })).not.toBeNull()
    expect(
      unhandledAmountMismatch({ emailLog: [marker(), handled({ paymentIntentId: 'pi_other' })] }),
    ).not.toBeNull()
  })

  it('a second payment that mismatches after the first was handled shows the second', () => {
    expect(
      unhandledAmountMismatch({
        emailLog: [marker(), handled(), marker({ paymentIntentId: 'pi_2', receivedCents: 100 })],
      }),
    ).toMatchObject({ paymentIntentId: 'pi_2', receivedCents: 100 })
  })

  it('matches a marker with no intent id to a handled entry with none', () => {
    const bare = marker({ paymentIntentId: null })
    expect(unhandledAmountMismatch({ emailLog: [bare, handled({ paymentIntentId: null })] })).toBeNull()
  })

  const failed = (over = {}) => ({
    kind: 'payment',
    event: 'failed',
    at: '2026-09-20T00:00:00.000Z',
    paymentIntentId: 'pi_1',
    detail: 'returned by the bank',
    ...over,
  })

  // The debit that mismatched never settled, so there is nothing to bill or refund.
  it('a LATER failed attempt on the same intent resolves it', () => {
    expect(unhandledAmountMismatch({ emailLog: [marker(), failed()] })).toBeNull()
  })

  it('a failed attempt on a DIFFERENT intent, or an EARLIER one, does not', () => {
    expect(
      unhandledAmountMismatch({ emailLog: [marker(), failed({ paymentIntentId: 'pi_other' })] }),
    ).not.toBeNull()
    expect(unhandledAmountMismatch({ emailLog: [failed(), marker()] })).not.toBeNull()
  })

  it('null intents never match each other for a failure', () => {
    const bare = marker({ paymentIntentId: null })
    expect(
      unhandledAmountMismatch({ emailLog: [bare, failed({ paymentIntentId: null })] }),
    ).not.toBeNull()
  })

  // Reader audit: neither new entry is a failed payment.
  it('never puts an invoice in the Payment failed tab', () => {
    expect(unresolvedPaymentFailure({ status: 'sent', emailLog: [marker(), handled()] })).toBeNull()
    const failure = {
      kind: 'payment',
      event: 'failed',
      at: '2026-09-09T00:00:00.000Z',
      paymentIntentId: 'pi_x',
      detail: 'declined',
    }
    // A real failure that is OLDER than the marker still wins over it.
    expect(unresolvedPaymentFailure({ status: 'sent', emailLog: [failure, marker()] })).toBe(failure)
  })
})

describe('a payment collected in another currency', () => {
  afterEach(() => vi.restoreAllMocks())

  it('is not compared: one warning naming the event and the currency, no flag', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(
      paymentAmountMismatch({
        eventType: 'checkout.session.completed',
        object: session(35000, { currency: 'EUR' }),
        invoice: { total: 400 },
      }),
    ).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('checkout.session.completed')
    expect(String(warn.mock.calls[0][0])).toContain('EUR')
  })

  it('still compares usd, in any case, and an event that names no currency', () => {
    for (const currency of ['usd', 'USD', undefined]) {
      expect(
        paymentAmountMismatch({
          eventType: 'payment_intent.succeeded',
          object: intent({ amount_received: 35000, currency }),
          invoice: { total: 400 },
        }),
      ).toEqual({ expectedCents: 40000, receivedCents: 35000 })
    }
  })
})

describe('flagPaymentAmountMismatch (the webhook step)', () => {
  afterEach(() => vi.restoreAllMocks())

  /** A store that is idempotent on the intent the way the real one is. */
  function fakeStore({ failMarker = false, members } = {}) {
    const markers = []
    return {
      markers,
      recordInvoiceAmountMismatch: vi.fn(async (invoiceId, entry) => {
        if (failMarker) throw new Error('db down')
        if (markers.some((m) => m.invoiceId === invoiceId && m.paymentIntentId === entry.paymentIntentId)) {
          return null
        }
        markers.push({ invoiceId, ...entry })
        return { id: invoiceId }
      }),
      getClientNameById: vi.fn(async () => 'Acme LLC'),
      getTeamMembers: vi.fn(async () =>
        members ?? [
          { id: 'owner-1', role: 'owner' },
          { id: 'staff-1', role: 'bookkeeper' },
          { id: 'owner-2', role: 'owner' },
        ],
      ),
    }
  }

  const invoice = { id: 'inv-1', number: 'INV-2026-09-001', clientId: 'c1', total: 400 }
  const succeeded = (received = 35000, over = {}) => ({
    id: 'evt_a',
    type: 'payment_intent.succeeded',
    created: 1_790_000_000,
    data: { object: { id: 'pi_1', amount: 35000, amount_received: received, ...over } },
  })
  const completed = (amountTotal = 35000) => ({
    id: 'evt_b',
    type: 'checkout.session.completed',
    created: 1_790_000_001,
    data: { object: { id: 'cs_1', payment_intent: 'pi_1', amount_total: amountTotal } },
  })

  it('a normal payment writes nothing and tells nobody', async () => {
    const store = fakeStore()
    const notify = vi.fn()
    await flagPaymentAmountMismatch({ store, notify, event: succeeded(40000), invoice })

    expect(store.recordInvoiceAmountMismatch).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('a mismatch records ONE marker and notifies each owner with both amounts', async () => {
    const store = fakeStore()
    const notify = vi.fn()
    await flagPaymentAmountMismatch({
      store,
      notify,
      event: succeeded(35000),
      invoice,
      appPublicUrl: 'https://app.example',
    })

    expect(store.recordInvoiceAmountMismatch).toHaveBeenCalledWith('inv-1', {
      at: new Date(1_790_000_000 * 1000).toISOString(),
      paymentIntentId: 'pi_1',
      expectedCents: 40000,
      receivedCents: 35000,
    })
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify).toHaveBeenCalledWith(store, 'owner-1', 'invoice_amount_mismatch', {
      message:
        'Invoice INV-2026-09-001 to Acme LLC: the client paid $350.00 but the invoice total is $400.00. It is recorded as paid; bill or refund the difference.',
      link: '/invoices',
      clientId: 'c1',
      appPublicUrl: 'https://app.example',
    })
    expect(notify.mock.calls.map((call) => call[1])).toEqual(['owner-1', 'owner-2'])
  })

  it('says the payment is still in progress while a bank payment has not settled', async () => {
    const store = fakeStore()
    const notify = vi.fn()
    await flagPaymentAmountMismatch({
      store,
      notify,
      event: completed(35000),
      invoice: { ...invoice, status: 'processing' },
    })

    expect(notify.mock.calls[0][3].message).toBe(
      "Invoice INV-2026-09-001 to Acme LLC: the client's bank payment is for $350.00 but the invoice total is $400.00. The payment is still in progress; once it settles, bill or refund the difference.",
    )
  })

  it('keeps the paid wording once it is paid, and for a card (its money is in at once)', async () => {
    const paidWording =
      'Invoice INV-2026-09-001 to Acme LLC: the client paid $350.00 but the invoice total is $400.00. It is recorded as paid; bill or refund the difference.'
    for (const settled of [
      { ...invoice, status: 'paid' },
      { ...invoice, status: 'processing', lineItems: [{ kind: 'card-fee' }] },
    ]) {
      const notify = vi.fn()
      await flagPaymentAmountMismatch({
        store: fakeStore(),
        notify,
        event: completed(35000),
        invoice: settled,
      })
      expect(notify.mock.calls[0][3].message).toBe(paidWording)
    }
    expect(paymentInProgress({ status: 'processing', lineItems: [] })).toBe(true)
    expect(paymentInProgress({ status: 'paid' })).toBe(false)
    expect(paymentInProgress({ status: 'sent' })).toBe(false)
  })

  it('a marker write that matched no row and is not on the log still notifies the owners', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = fakeStore()
    // What the store now throws for a lost write (see db/store-staleness.test.mjs).
    store.recordInvoiceAmountMismatch = vi.fn(async () => {
      throw new Error('amount-mismatch marker matched no row')
    })
    const notify = vi.fn()
    await flagPaymentAmountMismatch({ store, notify, event: succeeded(35000), invoice })

    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('the two events of one card payment produce ONE marker and ONE round of notifications', async () => {
    const store = fakeStore()
    const notify = vi.fn()
    await flagPaymentAmountMismatch({ store, notify, event: completed(35000), invoice })
    await flagPaymentAmountMismatch({ store, notify, event: succeeded(35000), invoice })

    expect(store.markers).toHaveLength(1)
    expect(notify).toHaveBeenCalledTimes(2) // two owners, once
  })

  it('a marker write that fails is logged and the owners are told anyway', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = fakeStore({ failMarker: true })
    const notify = vi.fn()
    await expect(
      flagPaymentAmountMismatch({ store, notify, event: succeeded(35000), invoice }),
    ).resolves.toBeUndefined()

    expect(error).toHaveBeenCalled()
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('one owner whose notice fails does not cost the other theirs, and nothing throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = fakeStore()
    const notify = vi.fn(async (_store, userId) => {
      if (userId === 'owner-1') throw new Error('mail down')
    })
    await expect(
      flagPaymentAmountMismatch({ store, notify, event: succeeded(35000), invoice }),
    ).resolves.toBeUndefined()

    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('an event with no usable amount flags nothing and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = fakeStore()
    const notify = vi.fn()
    const event = { id: 'evt_c', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1' } } }
    await flagPaymentAmountMismatch({ store, notify, event, invoice })

    expect(warn).toHaveBeenCalledTimes(1)
    expect(store.recordInvoiceAmountMismatch).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('never throws, whatever the store does, and does nothing without an invoice', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = fakeStore()
    store.getTeamMembers = vi.fn(async () => {
      throw new Error('boom')
    })
    await expect(
      flagPaymentAmountMismatch({ store, notify: vi.fn(), event: succeeded(35000), invoice }),
    ).resolves.toBeUndefined()
    await expect(
      flagPaymentAmountMismatch({ store, notify: vi.fn(), event: succeeded(35000), invoice: null }),
    ).resolves.toBeUndefined()
  })

  it('says the amounts the way the rest of the notification text does', () => {
    expect(
      amountMismatchOwnerMessage({
        number: 'INV-1',
        clientName: 'Acme',
        expectedCents: 123456,
        receivedCents: 5,
      }),
    ).toBe(
      'Invoice INV-1 to Acme: the client paid $0.05 but the invoice total is $1234.56. It is recorded as paid; bill or refund the difference.',
    )
  })
})
