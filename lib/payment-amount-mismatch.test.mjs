import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  amountMismatchOwnerMessage,
  clearDuplicatePaymentOnFailure,
  duplicatePaymentOwnerMessage,
  flagDuplicatePayment,
  flagPaymentOnVoidedInvoice,
  invoicePeriodLink,
  duplicatePaymentLogged,
  planOverpaymentCredit,
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
      reason: 'amount',
      settling: false,
      count: 1,
    })
    expect(unhandledAmountMismatch({ emailLog: [] })).toBeNull()
    expect(unhandledAmountMismatch({})).toBeNull()
    expect(unhandledAmountMismatch(null)).toBeNull()
  })

  it('a later handled entry for the same payment clears it', () => {
    expect(unhandledAmountMismatch({ emailLog: [marker(), handled()] })).toBeNull()
  })

  // featreq-c8e5f169 item 4: the notice must say how many are waiting, not only
  // describe the newest.
  it('counts every unhandled payment and describes the newest', () => {
    const log = [
      marker({ paymentIntentId: 'pi_1', receivedCents: 35000 }),
      marker({ paymentIntentId: 'pi_2', receivedCents: 20000, at: '2026-09-12T14:00:00.000Z' }),
      marker({ paymentIntentId: 'pi_3', receivedCents: 10000, at: '2026-09-13T14:00:00.000Z' }),
      handled({ paymentIntentId: 'pi_2' }),
    ]
    expect(unhandledAmountMismatch({ emailLog: log })).toMatchObject({
      count: 2,
      receivedCents: 10000,
      paymentIntentId: 'pi_3',
    })
  })

  // A second payment on a paid invoice rides the same entry with a reason.
  it('a duplicate payment is an unhandled payment with reason duplicate, and handled the same way', () => {
    const duplicate = marker({ paymentIntentId: 'pi_9', reason: 'duplicate', receivedCents: 40000 })
    expect(unhandledAmountMismatch({ emailLog: [duplicate] })).toMatchObject({
      reason: 'duplicate',
      receivedCents: 40000,
      count: 1,
    })
    expect(
      unhandledAmountMismatch({ emailLog: [duplicate, handled({ paymentIntentId: 'pi_9' })] }),
    ).toBeNull()
  })

  it('a duplicate whose amount Stripe did not report reads as null, not as zero dollars', () => {
    const duplicate = marker({ reason: 'duplicate', receivedCents: null })
    expect(unhandledAmountMismatch({ emailLog: [duplicate] }).receivedCents).toBeNull()
  })

  it('money for a voided invoice (on-voided) is never an unhandled payment or a payment failure', () => {
    const onVoided = {
      kind: 'payment',
      event: 'on-voided',
      at: '2026-09-14T10:00:00.000Z',
      paymentIntentId: 'pi_v',
      amount: 400,
      detail: 'payment_intent.succeeded arrived after the invoice was voided',
    }
    expect(unhandledAmountMismatch({ emailLog: [onVoided] })).toBeNull()
    expect(unresolvedPaymentFailure({ status: 'sent', emailLog: [onVoided] })).toBeNull()
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

/**
 * featreq-c8e5f169 (smaller items): the link a payment notice opens, the count of
 * unhandled payments, a second payment on a paid invoice, and money for a voided
 * invoice. The store's own behavior is pinned in db/store-staleness.test.mjs.
 */
describe('invoicePeriodLink', () => {
  it('opens the Invoices page on the invoice month', () => {
    expect(invoicePeriodLink({ period: '2026-09' })).toBe('/invoices?period=2026-09')
  })
  it('falls back to the bare page for a missing or malformed period', () => {
    expect(invoicePeriodLink({})).toBe('/invoices')
    expect(invoicePeriodLink(null)).toBe('/invoices')
    expect(invoicePeriodLink({ period: '2026-13' })).toBe('/invoices')
    expect(invoicePeriodLink({ period: 'Sept' })).toBe('/invoices')
  })
})

/** A store that is idempotent on the intent, as the real writers are. */
function paymentStore({ failWrite = false, invoiceAfter = {} } = {}) {
  const markers = []
  const written = (entry) => ({ id: 'inv-1', emailLog: markers.map((m) => ({ kind: 'payment', ...m })) , ...invoiceAfter, entry })
  return {
    markers,
    recordInvoiceAmountMismatch: vi.fn(async (invoiceId, entry) => {
      if (failWrite) throw new Error('db down')
      if (markers.some((m) => m.paymentIntentId === entry.paymentIntentId)) return null
      markers.push({ event: 'amount-mismatch', ...entry })
      return written(entry)
    }),
    recordInvoicePaymentOnVoided: vi.fn(async (invoiceId, entry) => {
      if (failWrite) throw new Error('db down')
      if (markers.some((m) => m.paymentIntentId === entry.paymentIntentId)) return null
      markers.push({ event: 'on-voided', ...entry })
      return written(entry)
    }),
    getClientNameById: vi.fn(async () => 'Acme LLC'),
    getTeamMembers: vi.fn(async () => [
      { id: 'owner-1', role: 'owner' },
      { id: 'staff-1', role: 'bookkeeper' },
      { id: 'owner-2', role: 'owner' },
    ]),
  }
}

const settled = {
  id: 'inv-1',
  number: 'INV-2026-09-001',
  clientId: 'c1',
  period: '2026-09',
  total: 400,
  status: 'paid',
}
const secondSucceeded = (over = {}) => ({
  id: 'evt_dup_a',
  type: 'payment_intent.succeeded',
  created: 1_790_000_000,
  data: { object: { id: 'pi_2', amount: 40000, amount_received: 40000, ...over } },
})
const secondCompleted = () => ({
  id: 'evt_dup_b',
  type: 'checkout.session.completed',
  created: 1_790_000_001,
  data: { object: { id: 'cs_2', payment_intent: 'pi_2', amount_total: 40000 } },
})

describe('the amount-mismatch notice says how many are waiting and opens the invoice month', () => {
  afterEach(() => vi.restoreAllMocks())

  it('links to the invoice month', async () => {
    const store = paymentStore()
    const notify = vi.fn()
    await flagPaymentAmountMismatch({
      store,
      notify,
      event: { id: 'e', type: 'payment_intent.succeeded', created: 1_790_000_000, data: { object: { id: 'pi_1', amount_received: 35000 } } },
      invoice: settled,
    })
    expect(notify.mock.calls[0][3].link).toBe('/invoices?period=2026-09')
  })

  it('stays silent about a count when it is the only one, and says so when it is not', async () => {
    const store = paymentStore()
    store.markers.push({ event: 'amount-mismatch', paymentIntentId: 'pi_0', expectedCents: 40000, receivedCents: 30000 })
    const notify = vi.fn()
    await flagPaymentAmountMismatch({
      store,
      notify,
      event: { id: 'e', type: 'payment_intent.succeeded', created: 1_790_000_000, data: { object: { id: 'pi_1', amount_received: 35000 } } },
      invoice: settled,
    })
    expect(notify.mock.calls[0][3].message).toContain(
      ' 2 payments on this invoice are waiting to be marked handled (this is the newest).',
    )

    const lone = vi.fn()
    await flagPaymentAmountMismatch({
      store: paymentStore(),
      notify: lone,
      event: { id: 'e', type: 'payment_intent.succeeded', created: 1_790_000_000, data: { object: { id: 'pi_1', amount_received: 35000 } } },
      invoice: settled,
    })
    expect(lone.mock.calls[0][3].message).not.toContain('waiting to be marked handled')
  })
})

describe('flagDuplicatePayment (a second payment on a paid invoice)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('records an unhandled payment with reason duplicate and tells every owner once', async () => {
    const store = paymentStore()
    const notify = vi.fn()
    await flagDuplicatePayment({
      store,
      notify,
      event: secondSucceeded(),
      invoice: settled,
      appPublicUrl: 'https://app.example',
    })

    expect(store.recordInvoiceAmountMismatch).toHaveBeenCalledWith('inv-1', {
      at: new Date(1_790_000_000 * 1000).toISOString(),
      paymentIntentId: 'pi_2',
      expectedCents: 40000,
      receivedCents: 40000,
      reason: 'duplicate',
      settling: false,
    })
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify).toHaveBeenCalledWith(store, 'owner-1', 'invoice_payment_duplicate', {
      message:
        'Invoice INV-2026-09-001 to Acme LLC was already paid, and a payment of $400.00 arrived for it again. It was NOT applied to the invoice; refund it or apply it by hand, then mark it handled.',
      link: '/invoices?period=2026-09',
      clientId: 'c1',
      appPublicUrl: 'https://app.example',
    })
    expect(notify.mock.calls.map((call) => call[1])).toEqual(['owner-1', 'owner-2'])
  })

  it('the two events of one card payment write ONE entry and send ONE round of notices', async () => {
    const store = paymentStore()
    const notify = vi.fn()
    await flagDuplicatePayment({ store, notify, event: secondCompleted(), invoice: settled })
    await flagDuplicatePayment({ store, notify, event: secondSucceeded(), invoice: settled })

    expect(store.markers).toHaveLength(1)
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('says how many are waiting when this is not the only one', async () => {
    const store = paymentStore()
    store.markers.push({ event: 'amount-mismatch', paymentIntentId: 'pi_0', expectedCents: 40000, receivedCents: 40000, reason: 'duplicate' })
    const notify = vi.fn()
    await flagDuplicatePayment({ store, notify, event: secondSucceeded(), invoice: settled })

    expect(notify.mock.calls[0][3].message).toContain('2 payments on this invoice are waiting')
  })

  it('records a duplicate even when Stripe did not say the amount, and words it without one', async () => {
    const store = paymentStore()
    const notify = vi.fn()
    await flagDuplicatePayment({
      store,
      notify,
      event: { id: 'e', type: 'payment_intent.succeeded', created: 1_790_000_000, data: { object: { id: 'pi_2' } } },
      invoice: settled,
    })

    expect(store.recordInvoiceAmountMismatch.mock.calls[0][1].receivedCents).toBeNull()
    expect(notify.mock.calls[0][3].message).toContain('and a payment arrived for it again')
    expect(duplicatePaymentOwnerMessage({ number: 'I', clientName: 'C', receivedCents: null })).toContain(
      'a payment arrived',
    )
  })

  it('a marker write that fails is logged and the owners are told anyway; nothing throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const notify = vi.fn()
    await expect(
      flagDuplicatePayment({ store: paymentStore({ failWrite: true }), notify, event: secondSucceeded(), invoice: settled }),
    ).resolves.toBeUndefined()
    expect(error).toHaveBeenCalled()
    expect(notify).toHaveBeenCalledTimes(2)
    await expect(
      flagDuplicatePayment({ store: paymentStore(), notify, event: secondSucceeded(), invoice: null }),
    ).resolves.toBeUndefined()
  })
})

describe('flagPaymentOnVoidedInvoice (money for a voided invoice)', () => {
  afterEach(() => vi.restoreAllMocks())
  const voided = { ...settled, status: 'void' }
  const first = { id: 'inv-1' }

  it('logs it on the invoice and tells every owner, naming client, invoice and amount', async () => {
    const store = paymentStore()
    const notify = vi.fn()
    await flagPaymentOnVoidedInvoice({
      store,
      notify,
      event: secondSucceeded(),
      invoice: first,
      getInvoice: async () => voided,
      appPublicUrl: 'https://app.example',
    })

    expect(store.recordInvoicePaymentOnVoided).toHaveBeenCalledWith('inv-1', {
      at: new Date(1_790_000_000 * 1000).toISOString(),
      paymentIntentId: 'pi_2',
      amount: 400,
      detail: 'payment_intent.succeeded arrived after the invoice was voided',
    })
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify).toHaveBeenCalledWith(store, 'owner-1', 'invoice_payment_on_voided', {
      message:
        'Invoice INV-2026-09-001 to Acme LLC is voided, but a payment of $400.00 arrived for it. The money needs a refund or to be re-applied by hand.',
      link: '/invoices?period=2026-09',
      clientId: 'c1',
      appPublicUrl: 'https://app.example',
    })
  })

  it('is idempotent on the PaymentIntent: a card payment tells the owners once', async () => {
    const store = paymentStore()
    const notify = vi.fn()
    const args = { store, notify, invoice: first, getInvoice: async () => voided }
    await flagPaymentOnVoidedInvoice({ ...args, event: secondCompleted() })
    await flagPaymentOnVoidedInvoice({ ...args, event: secondSucceeded() })

    expect(store.markers).toHaveLength(1)
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('writes and says nothing when the invoice is gone, or is not void', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const getInvoice of [async () => null, async () => ({ ...settled, status: 'sent' })]) {
      const store = paymentStore()
      const notify = vi.fn()
      await flagPaymentOnVoidedInvoice({ store, notify, event: secondSucceeded(), invoice: first, getInvoice })
      expect(store.recordInvoicePaymentOnVoided).not.toHaveBeenCalled()
      expect(notify).not.toHaveBeenCalled()
    }
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('a failed write is logged and the owners are told anyway; nothing throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const notify = vi.fn()
    await expect(
      flagPaymentOnVoidedInvoice({
        store: paymentStore({ failWrite: true }),
        notify,
        event: secondSucceeded(),
        invoice: first,
        getInvoice: async () => voided,
      }),
    ).resolves.toBeUndefined()
    expect(error).toHaveBeenCalled()
    expect(notify).toHaveBeenCalledTimes(2)
    await expect(
      flagPaymentOnVoidedInvoice({
        store: paymentStore(),
        notify,
        event: secondSucceeded(),
        invoice: first,
        getInvoice: async () => {
          throw new Error('boom')
        },
      }),
    ).resolves.toBeUndefined()
  })
})

/**
 * featreq-c8e5f169 review round: a bank payment that has only been STARTED must
 * not be worded as money that arrived, and when a started duplicate then fails its
 * flag clears itself and the owners are told there is nothing to refund.
 */
describe('a second BANK payment that has only been started', () => {
  afterEach(() => vi.restoreAllMocks())

  const bankCompleted = () => ({
    id: 'evt_bank',
    type: 'checkout.session.completed',
    created: 1_790_000_000,
    data: { object: { id: 'cs_2', payment_intent: 'pi_2', amount_total: 40000 } },
  })

  it('a duplicate seen at Checkout-completed on the bank channel is recorded as settling and worded as started', async () => {
    const store = paymentStore()
    const notify = vi.fn()
    await flagDuplicatePayment({ store, notify, event: bankCompleted(), invoice: settled, isCard: false })

    expect(store.recordInvoiceAmountMismatch.mock.calls[0][1]).toMatchObject({
      reason: 'duplicate',
      settling: true,
    })
    expect(notify.mock.calls[0][3].message).toBe(
      'Invoice INV-2026-09-001 to Acme LLC was already paid, and a second bank payment of $400.00 was started for it. It was NOT applied to the invoice; once it settles, refund it or apply it by hand, then mark it handled. If it fails, this clears by itself.',
    )
  })

  it('a card at Checkout-completed, and anything at payment_intent.succeeded, is money that arrived', async () => {
    for (const [event, isCard] of [
      [bankCompleted(), true],
      [secondSucceeded(), false],
      [bankCompleted(), undefined],
    ]) {
      const store = paymentStore()
      const notify = vi.fn()
      await flagDuplicatePayment({ store, notify, event, invoice: settled, isCard })
      expect(store.recordInvoiceAmountMismatch.mock.calls[0][1].settling).toBe(false)
      expect(notify.mock.calls[0][3].message).toContain('arrived for it again')
    }
  })

  it('an on-voided bank payment is worded as started, and settling in a few days', async () => {
    const store = paymentStore()
    const notify = vi.fn()
    await flagPaymentOnVoidedInvoice({
      store,
      notify,
      event: bankCompleted(),
      invoice: { id: 'inv-1' },
      getInvoice: async () => ({ ...settled, status: 'void' }),
      isCard: false,
    })
    expect(notify.mock.calls[0][3].message).toBe(
      'Invoice INV-2026-09-001 to Acme LLC is voided, but a bank payment of $400.00 was started for it; it settles in a few days. Once it does, it needs a refund or to be re-applied by hand.',
    )
    // A card (or the settled event) says it arrived.
    const notifyCard = vi.fn()
    await flagPaymentOnVoidedInvoice({
      store: paymentStore(),
      notify: notifyCard,
      event: secondSucceeded(),
      invoice: { id: 'inv-1' },
      getInvoice: async () => ({ ...settled, status: 'void' }),
      isCard: false,
    })
    expect(notifyCard.mock.calls[0][3].message).toContain('arrived for it')
  })

  it('reads settling off the marker, and only for a duplicate', () => {
    const base = {
      kind: 'payment',
      event: 'amount-mismatch',
      at: '2026-09-12T14:00:00.000Z',
      paymentIntentId: 'pi_2',
      expectedCents: 40000,
      receivedCents: 40000,
    }
    expect(
      unhandledAmountMismatch({ emailLog: [{ ...base, reason: 'duplicate', settling: true }] }).settling,
    ).toBe(true)
    expect(unhandledAmountMismatch({ emailLog: [{ ...base, reason: 'duplicate' }] }).settling).toBe(false)
    expect(unhandledAmountMismatch({ emailLog: [{ ...base, settling: true }] }).settling).toBe(false)
  })
})

describe('clearDuplicatePaymentOnFailure (a started second payment that then failed)', () => {
  afterEach(() => vi.restoreAllMocks())

  const dupMarker = {
    kind: 'payment',
    event: 'amount-mismatch',
    at: '2026-09-12T14:00:00.000Z',
    paymentIntentId: 'pi_2',
    expectedCents: 40000,
    receivedCents: 40000,
    reason: 'duplicate',
    settling: true,
  }
  const paid = { ...settled, emailLog: [dupMarker] }
  const failed = (id = 'pi_2') => ({
    id: 'evt_f',
    type: 'payment_intent.payment_failed',
    created: 1_790_000_100,
    data: { object: { id, last_payment_error: { message: 'Account closed' } } },
  })
  const withFailureStore = () => {
    const store = paymentStore()
    store.recordInvoicePaymentFailure = vi.fn(async () => ({ id: 'inv-1' }))
    return store
  }

  it('appends a status-free failed entry for that intent and tells the owners nothing is owed', async () => {
    const store = withFailureStore()
    const notify = vi.fn()
    await clearDuplicatePaymentOnFailure({
      store,
      notify,
      event: failed(),
      invoice: paid,
      appPublicUrl: 'https://app.example',
    })

    expect(store.recordInvoicePaymentFailure).toHaveBeenCalledWith('inv-1', {
      at: new Date(1_790_000_100 * 1000).toISOString(),
      paymentIntentId: 'pi_2',
      detail: 'Account closed',
    })
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify).toHaveBeenCalledWith(store, 'owner-1', 'invoice_payment_failed', {
      message:
        'The second bank payment on invoice INV-2026-09-001 to Acme LLC failed - Account closed. The invoice is still paid, nothing arrived, and there is nothing to refund.',
      link: '/invoices?period=2026-09',
      clientId: 'c1',
      appPublicUrl: 'https://app.example',
    })
  })

  it('the entry it asks for is what clears the flag on the log', () => {
    const entry = { kind: 'payment', event: 'failed', at: '2026-09-12T15:00:00.000Z', paymentIntentId: 'pi_2' }
    expect(unhandledAmountMismatch({ emailLog: [dupMarker] })).not.toBeNull()
    expect(unhandledAmountMismatch({ emailLog: [dupMarker, entry] })).toBeNull()
  })

  it('does nothing for another intent, a handled marker, an ordinary mismatch, or an invoice that is not paid', async () => {
    const handledLog = [
      dupMarker,
      { kind: 'payment', event: 'amount-mismatch-handled', at: '2026-09-13T00:00:00.000Z', paymentIntentId: 'pi_2' },
    ]
    const { reason: _reason, ...ordinary } = dupMarker
    const cases = [
      [failed('pi_other'), paid],
      [failed(), { ...paid, emailLog: handledLog }],
      [failed(), { ...paid, emailLog: [ordinary] }],
      [failed(), { ...paid, status: 'sent' }],
      [failed(), { ...paid, emailLog: [] }],
    ]
    for (const [event, invoice] of cases) {
      const store = withFailureStore()
      const notify = vi.fn()
      await clearDuplicatePaymentOnFailure({ store, notify, event, invoice })
      expect(store.recordInvoicePaymentFailure).not.toHaveBeenCalled()
      expect(notify).not.toHaveBeenCalled()
    }
  })

  it('never throws, and does nothing without an invoice', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = withFailureStore()
    store.recordInvoicePaymentFailure = vi.fn(async () => {
      throw new Error('db down')
    })
    await expect(
      clearDuplicatePaymentOnFailure({ store, notify: vi.fn(), event: failed(), invoice: paid }),
    ).resolves.toBeUndefined()
    await expect(
      clearDuplicatePaymentOnFailure({ store, notify: vi.fn(), event: failed(), invoice: null }),
    ).resolves.toBeUndefined()
  })
})

/**
 * Stage 1e (credit on account): the settled-bank-duplicate trap, and the rule
 * that decides whether a double payment may become a credit.
 */
describe('a settled bank duplicate flips its marker from settling to settled', () => {
  afterEach(() => vi.restoreAllMocks())

  /** The store of `paymentStore`, plus the flip. */
  function settlingStore() {
    const store = paymentStore()
    store.settleDuplicatePaymentMarker = vi.fn(async () => ({ id: 'inv-1' }))
    return store
  }
  const bankCompleted = () => ({
    id: 'evt_bank_c',
    type: 'checkout.session.completed',
    created: 1_790_000_001,
    data: { object: { id: 'cs_2', payment_intent: 'pi_2', amount_total: 40000 } },
  })

  it('the succeeded event that the store drops as a repeat updates the settling marker instead', async () => {
    const store = settlingStore()
    const notify = vi.fn()
    await flagDuplicatePayment({ store, notify, event: bankCompleted(), invoice: settled, isCard: false })
    expect(store.markers[0].settling).toBe(true)
    expect(store.settleDuplicatePaymentMarker).not.toHaveBeenCalled()

    await flagDuplicatePayment({ store, notify, event: secondSucceeded(), invoice: settled, isCard: false })

    expect(store.settleDuplicatePaymentMarker).toHaveBeenCalledTimes(1)
    expect(store.settleDuplicatePaymentMarker).toHaveBeenCalledWith('inv-1', 'pi_2')
    // Still one marker and one round of notices: only the flip is new.
    expect(store.markers).toHaveLength(1)
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('a repeat that is not the settle (a second checkout event) changes nothing', async () => {
    const store = settlingStore()
    const notify = vi.fn()
    await flagDuplicatePayment({ store, notify, event: bankCompleted(), invoice: settled, isCard: false })
    await flagDuplicatePayment({ store, notify, event: bankCompleted(), invoice: settled, isCard: false })
    expect(store.settleDuplicatePaymentMarker).not.toHaveBeenCalled()
  })

  it('a first-time succeeded (the marker is new) does not flip anything', async () => {
    const store = settlingStore()
    await flagDuplicatePayment({ store, notify: vi.fn(), event: secondSucceeded(), invoice: settled })
    expect(store.settleDuplicatePaymentMarker).not.toHaveBeenCalled()
  })

  it('a flip that throws is logged and swallowed; a store without the method is fine', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = settlingStore()
    await flagDuplicatePayment({ store, notify: vi.fn(), event: bankCompleted(), invoice: settled, isCard: false })
    store.settleDuplicatePaymentMarker.mockRejectedValue(new Error('db down'))
    await expect(
      flagDuplicatePayment({ store, notify: vi.fn(), event: secondSucceeded(), invoice: settled, isCard: false }),
    ).resolves.toBeUndefined()
    expect(error).toHaveBeenCalled()

    const bare = paymentStore()
    await flagDuplicatePayment({ store: bare, notify: vi.fn(), event: bankCompleted(), invoice: settled, isCard: false })
    await expect(
      flagDuplicatePayment({ store: bare, notify: vi.fn(), event: secondSucceeded(), invoice: settled, isCard: false }),
    ).resolves.toBeUndefined()
  })
})

describe('planOverpaymentCredit (may this double payment become a credit, and for how much)', () => {
  const marker = (over = {}) => ({
    kind: 'payment',
    event: 'amount-mismatch',
    at: '2026-09-10T14:00:00.000Z',
    paymentIntentId: 'pi_2',
    expectedCents: 40000,
    receivedCents: 41250,
    reason: 'duplicate',
    ...over,
  })
  const invoice = (log = [marker()]) => ({ id: 'inv-1', emailLog: log })
  const succeeded = (over = {}) => ({
    status: 'succeeded',
    amountReceived: 41250,
    currency: 'usd',
    invoiceId: 'inv-1',
    ...over,
  })
  const plan = (over = {}) =>
    planOverpaymentCredit({
      invoice: invoice(),
      paymentIntentId: 'pi_2',
      intent: succeeded(),
      requestedAmount: undefined,
      ...over,
    })

  it('defaults to everything the client was charged, card fee included, in cents', () => {
    expect(plan()).toEqual({ ok: true, cents: 41250 })
  })

  it('allows a lower amount in dollars, never a higher one', () => {
    expect(plan({ requestedAmount: 400 })).toEqual({ ok: true, cents: 40000 })
    expect(plan({ requestedAmount: '400.00' })).toEqual({ ok: true, cents: 40000 })
    expect(plan({ requestedAmount: 412.5 })).toEqual({ ok: true, cents: 41250 })
    const over = plan({ requestedAmount: 412.51 })
    expect(over).toMatchObject({ ok: false, status: 400, code: 'amount_too_high' })
    expect(over.message).toContain('$412.50')
  })

  it.each([0, -5, 0.004, Number.NaN, 'lots', true])('refuses an amount that is not a positive number: %s', (amount) => {
    expect(plan({ requestedAmount: amount })).toMatchObject({ ok: false, status: 400, code: 'invalid_amount' })
  })

  it('refuses a payment still settling, in words that say to try once it clears', () => {
    const refused = plan({ intent: succeeded({ status: 'processing' }) })
    expect(refused).toMatchObject({ ok: false, status: 409, code: 'still_settling' })
    expect(refused.message).toMatch(/still settling/i)
    expect(refused.message).toMatch(/once it clears/i)
  })

  it('refuses any other status than succeeded, saying what Stripe shows', () => {
    const refused = plan({ intent: succeeded({ status: 'requires_payment_method' }) })
    expect(refused).toMatchObject({ ok: false, status: 409, code: 'not_succeeded' })
    expect(refused.message).toContain('requires_payment_method')
  })

  it('refuses when Stripe could not be asked (nothing is guessed)', () => {
    expect(plan({ intent: null })).toMatchObject({ ok: false, status: 502, code: 'stripe_unreachable' })
  })

  it('refuses a payment that names a different invoice, or none', () => {
    expect(plan({ intent: succeeded({ invoiceId: 'inv-9' }) })).toMatchObject({
      ok: false,
      status: 409,
      code: 'wrong_invoice',
    })
    expect(plan({ intent: succeeded({ invoiceId: null }) })).toMatchObject({ ok: false, code: 'wrong_invoice' })
  })

  it('refuses a payment that is not waiting on this invoice, or already handled', () => {
    expect(plan({ paymentIntentId: 'pi_other' })).toMatchObject({ ok: false, status: 409, code: 'not_waiting' })
    const handled = [
      marker(),
      { kind: 'payment', event: 'amount-mismatch-handled', at: '2026-09-11T00:00:00.000Z', paymentIntentId: 'pi_2' },
    ]
    expect(plan({ invoice: invoice(handled) })).toMatchObject({ ok: false, status: 409, code: 'not_waiting' })
    // A different-amount marker is not a double payment.
    expect(plan({ invoice: invoice([marker({ reason: undefined })]) })).toMatchObject({ ok: false, code: 'not_waiting' })
  })

  it('refuses a missing id, a non-dollar currency and a payment with no amount', () => {
    expect(plan({ paymentIntentId: '' })).toMatchObject({ ok: false, status: 400, code: 'invalid_payment_intent' })
    expect(plan({ paymentIntentId: undefined })).toMatchObject({ ok: false, status: 400 })
    expect(plan({ intent: succeeded({ currency: 'eur' }) })).toMatchObject({ ok: false, status: 409, code: 'not_usd' })
    expect(plan({ intent: succeeded({ amountReceived: 0 }) })).toMatchObject({ ok: false, status: 409, code: 'no_amount' })
  })

  it('duplicatePaymentLogged sees a double payment handled or not, and nothing else', () => {
    const handled = {
      kind: 'payment',
      event: 'amount-mismatch-handled',
      at: '2026-09-11T00:00:00.000Z',
      paymentIntentId: 'pi_2',
    }
    expect(duplicatePaymentLogged([marker()], 'pi_2')).toBe(true)
    expect(duplicatePaymentLogged([marker(), handled], 'pi_2')).toBe(true)
    expect(duplicatePaymentLogged([marker()], 'pi_3')).toBe(false)
    expect(duplicatePaymentLogged([marker({ reason: undefined })], 'pi_2')).toBe(false)
    expect(duplicatePaymentLogged(undefined, 'pi_2')).toBe(false)
    expect(duplicatePaymentLogged([marker()], '')).toBe(false)
  })
})
