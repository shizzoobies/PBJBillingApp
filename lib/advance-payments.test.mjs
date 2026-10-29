import { describe, expect, it } from 'vitest'
import { advanceRequest, advanceReceipt, advanceCredits, advanceSummary, stripeAdvanceReceipt } from './advance-payments.js'
import { planAccountCreditDraws } from './invoice-lines.js'
import { buildCreditStatement, creditStatementText } from './invoice-credit-statement.js'
import { buildInvoiceEmail } from './invoice-email.js'
import { advanceCheckout, advancePaymentPdf, handleAdvancePaymentRoute } from './advance-payment-routes.js'

const at = '2026-10-28T12:00:00.000Z'
const request = advanceRequest({ id: 'aaaaaaaa-bbbb-cccc-dddd', clientId: 'c1', amount: 1000 }, at)
const receipt = (amount = 400, ref = 'manual:aaaaaaaa-bbbb-cccc-dddd') => advanceReceipt({ requestId: request.id, sourceRef: ref, amount, receivedOn: '2026-10-28', method: 'manual' }, request, '2026-10-28', at)
const invoice = (amount = 150) => ({ id: 'i1', number: 'INV-SYNTHETIC', clientId: 'c1', period: '2026-11', kind: 'monthly', status: 'draft', total: 0, lineItems: [{ kind: 'plan', label: 'Current services', amount }, { kind: 'account_credit', label: 'Credit on account', amount: -amount, draws: [{ creditId: `advance:${receipt().sourceRef}`, amount }] }] })

describe('advance requests and actual receipts', () => {
  it('creates no credit until money arrives, credits only partial receipts, and retains credit on cancellation', () => {
    expect(advanceCredits([request], [], [])).toEqual([])
    expect(advanceSummary(request, [receipt()]).outstandingCents).toBe(60000)
    const canceled = { ...request, canceledAt: at }
    expect(advanceSummary(canceled, [receipt()]).outstandingCents).toBe(0)
    expect(advanceCredits([canceled], [receipt()], [])[0].amount).toBe(400)
  })
  it('records distinct overpayments in full, without capping or losing funds', () => {
    const paid = [receipt(800), receipt(800, 'stripe:pi_second')]
    expect(advanceSummary(request, paid).outstandingCents).toBe(0)
    expect(advanceCredits([request], paid, []).reduce((sum, credit) => sum + credit.amount, 0)).toBe(1600)
  })
  it('requires a verified settled USD received amount and ignores the requested total', () => {
    const intent = { id: 'pi_test', status: 'succeeded', currency: 'usd', amount: 100000, amount_received: 12345, metadata: { advancePaymentRequestId: request.id } }
    expect(stripeAdvanceReceipt(intent, request, '2026-10-28', at).cents).toBe(12345)
    for (const patch of [{ status: 'processing' }, { currency: 'eur' }, { amount_received: 0 }, { amount_received: 1.5 }, { metadata: {} }]) expect(() => stripeAdvanceReceipt({ ...intent, ...patch }, request, '2026-10-28', at)).toThrow()
  })
  it('rejects invalid money and future/noncalendar receipt dates', () => {
    for (const amount of [0, -1, NaN, Infinity, 1000001]) expect(() => receipt(amount)).toThrow()
    for (const day of ['2026-02-30', '2026-10-29', 'garbage']) expect(() => advanceReceipt({ requestId: request.id, sourceRef: receipt().sourceRef, amount: 10, receivedOn: day }, request, '2026-10-28', at)).toThrow()
  })
  it('holds refunds even when a later dispute is won and handles out-of-order delivery', () => {
    const sourceRef = receipt().sourceRef
    const opened = { id: 'a', sourceRef, kind: 'dispute', at, cents: 40000 }
    const won = { id: 'b', sourceRef, kind: 'dispute-closed', status: 'won', at: '2026-10-29T12:00:00Z' }
    const refund = { id: 'c', sourceRef, kind: 'refund', cents: 10000, at }
    expect(advanceCredits([request], [receipt()], [won, opened])[0].reversal.holds).toBe(false)
    const held = advanceCredits([request], [receipt()], [won, refund, opened])[0]
    expect(held.reversal.holds).toBe(true)
    expect(held.reversal.partial).toBe(true)
    expect(planAccountCreditDraws({ lines: invoice().lineItems, credits: [held], period: '2026-11' }).totalCents).toBe(0)
    expect(planAccountCreditDraws({ lines: invoice().lineItems, credits: [held], existing: [{ creditId: held.id, amount: 150 }] }).totalCents).toBe(0)
  })
  it('reserves draws on other drafts and preserves the remainder for future months', () => {
    const credit = { ...advanceCredits([request], [receipt()], [])[0], draws: [{ invoiceId: 'other', status: 'draft', amount: 300 }] }
    const plan = planAccountCreditDraws({ lines: [{ amount: 200, kind: 'plan' }], credits: [credit], invoiceId: 'new', period: '2026-11' })
    expect(plan.totalCents).toBe(10000)
  })
  it('presents a balanced customer statement and preserves month-specific/retainer accounting separately', () => {
    const inv = invoice()
    const credits = [{ ...advanceCredits([request], [receipt()], [])[0], draws: [{ invoiceId: 'draft2', status: 'draft', amount: 50 }] }]
    const statement = buildCreditStatement(inv, credits, at)
    expect(statement).toMatchObject({ openingCents: 40000, appliedCents: 15000, closingCents: 25000, reservedCents: 5000, currentChargesCents: 15000, amountDueCents: 0 })
    inv.lineItems[1].creditStatement = statement
    const email = buildInvoiceEmail({ invoice: inv, client: { name: 'Synthetic client' } })
    expect(email.text).toContain('Closing credit balance: $250.00')
    expect(email.html).toContain('Opening credit balance: $400.00')
    expect(creditStatementText({ ...inv, total: 999 })).toEqual([])
  })
  it('builds a request PDF using only synthetic data', async () => {
    const pdf = await advancePaymentPdf(advanceSummary(request, [receipt()]), { name: 'Synthetic test client' }, [receipt()])
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF')
  })
})

describe('advance collection boundaries', () => {
  it('reuses an open matching checkout, preventing duplicate link creation', async () => {
    const current = advanceSummary(request, [])
    const saved = { id: 'cs_synthetic', requestId: request.id, cents: 100000, receivedCents: 0 }
    const store = { advancePaymentLedger: () => ({ list: async () => ({ sessions: [saved], receipts: [] }) }), listAdvancePayments: async () => ({ requests: [current] }) }
    const stripe = { checkout: { sessions: { retrieve: async () => ({ id: saved.id, status: 'open', url: 'https://example.test/pay' }) } } }
    expect(await advanceCheckout({ store, request: current, client: { id: 'c1' }, appUrl: 'http://localhost', stripe })).toBe('https://example.test/pay')
  })
  it('refuses another link while ACH is processing', async () => {
    const store = { advancePaymentLedger: () => ({ list: async () => ({ sessions: [{ id: 'cs_1', requestId: request.id }] }) }) }
    const stripe = { checkout: { sessions: { retrieve: async () => ({ status: 'complete', payment_intent: 'pi_1' }) } }, paymentIntents: { retrieve: async () => ({ status: 'processing' }) } }
    await expect(advanceCheckout({ store, request: advanceSummary(request, []), client: { id: 'c1' }, stripe })).rejects.toThrow('in progress')
  })
  it('requires owner role and same-origin JSON before writing', async () => {
    const responses = []
    const context = { request: { method: 'POST', headers: {} }, response: {}, pathname: '/api/advance-payments', url: new URL('http://localhost/api/advance-payments'), store: {}, requireSession: async () => ({ user: { role: 'bookkeeper' } }), sendJson: (_response, status) => responses.push(status) }
    await handleAdvancePaymentRoute(context)
    expect(responses).toEqual([403])
    responses.length = 0
    await handleAdvancePaymentRoute({ ...context, requireSession: async () => ({ user: { role: 'owner' } }), isCrossSiteOrigin: () => true })
    expect(responses).toEqual([403])
  })
})
