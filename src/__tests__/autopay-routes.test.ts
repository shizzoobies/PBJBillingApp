import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * The autopay routes (featreq-bef42b72), pinned the way the pay-link routes are:
 * server.js listens at module scope and exports nothing, so this reads the
 * source. The store halves have real tests in db/store-staleness.test.mjs and
 * the payloads in lib/stripe-autopay.test.mjs; what is pinned HERE is the
 * ORDER and the gates of the routes that move or expose money.
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
)

function sliceBetween(from: string, to: string) {
  const start = serverSource.indexOf(from)
  expect(start, `${from} is gone from server.js`).toBeGreaterThan(-1)
  const end = serverSource.indexOf(to, start + from.length)
  expect(end, `${to} no longer follows ${from}`).toBeGreaterThan(start)
  return serverSource.slice(start, end)
}

const squash = (text: string) => text.replace(/\s+/g, ' ')

describe('GET /api/autopay (the owner’s panel)', () => {
  const block = sliceBetween(
    "normalizedPath === '/api/autopay' && request.method === 'GET'",
    '// POST /api/clients/:id/autopay/invite',
  )

  it('is owner-only', () => {
    expect(block).toContain("session.user.role !== 'owner'")
    expect(block).toContain('sendJson(response, 403')
    expect(block.indexOf('403')).toBeLessThan(block.indexOf('listClientAutopay'))
  })

  it('answers summaries only, never the stored rows', () => {
    expect(squash(block)).toContain('.map(autopaySummary)')
    expect(block).not.toContain('setupToken')
  })
})

describe('what a team member is sent', () => {
  it('the file backend’s whole-file read is stripped of both autopay tables for staff', () => {
    const scope = sliceBetween('function scopeAppDataForSession(', 'Soft-deleted team members are owner-only')
    expect(scope).toContain('clientAutopay: undefined')
    expect(scope).toContain('autopayAttempts: undefined')
  })
})

/**
 * COMMIT 2 OF 3 CHARGES NOTHING. Enrollment (invite, the client's setup page,
 * the setup webhooks, withdrawal) is the part that can ship on its own; every
 * route and branch below is checked for the absence of anything that moves
 * money, so a later edit cannot quietly smuggle a charge in through the door
 * that only ever saved a bank account.
 */
describe('enrollment routes move no money', () => {
  const ownerRoutes = sliceBetween(
    'const autopayActionMatch = normalizedPath.match(',
    '// GET /api/autopay/attempts',
  )
  const publicRoutes = sliceBetween(
    'const autopayLinkMatch = normalizedPath.match(',
    '// ---- GET /pay/:token',
  )
  const setupBranch = sliceBetween(
    'if (classifySetupEvent(event)) {',
    'const object = event.data?.object ?? {}',
  )

  it.each([
    ['the owner routes', ownerRoutes],
    ['the client page', publicRoutes],
    ['the setup webhook branch', setupBranch],
  ])('%s never touch an invoice, a PaymentIntent or an attempt', (_name, block) => {
    for (const forbidden of [
      'applyInvoicePayment',
      'applyPayment(',
      'paymentIntents',
      'claimAutopayAttempt',
      'updateAutopayAttempt',
      'recordInvoiceSent',
      'swapInvoiceCheckoutSession',
    ]) {
      expect(block, `${forbidden} has no business in enrollment`).not.toContain(forbidden)
    }
  })
})

describe('POST /api/clients/:id/autopay/(invite|turn-off)', () => {
  const block = sliceBetween(
    'const autopayActionMatch = normalizedPath.match(',
    '// GET /api/autopay/attempts',
  )

  it('is owner-only, same-origin and JSON, in that order, before anything is read', () => {
    const owner = block.indexOf("session.user.role !== 'owner'")
    const origin = block.indexOf('isCrossSiteOrigin(request)')
    const json = block.indexOf("'application/json required'")
    expect(owner).toBeGreaterThan(-1)
    expect(owner).toBeLessThan(origin)
    expect(origin).toBeLessThan(json)
    expect(json).toBeLessThan(block.indexOf('getClientById('))
  })

  it('refuses an opted-out client, a sub on a combined invoice, and an enrolled client before any Stripe call or email', () => {
    const customerAt = block.indexOf('ensureStripeCustomer(')
    const emailAt = block.indexOf('sendInvoiceEmail(')
    for (const refusal of [
      "error: 'client_opted_out'",
      "error: 'autopay_on_master'",
      "error: 'already_enrolled'",
      "error: 'invoice_no_recipient'",
    ]) {
      const at = block.indexOf(refusal)
      expect(at, `${refusal} is gone`).toBeGreaterThan(-1)
      expect(at).toBeLessThan(customerAt)
      expect(at).toBeLessThan(emailAt)
    }
    expect(block).toContain('inviteAddressee.refusal')
  })

  it('writes the invited row before the email, and puts the old row back if the email fails', () => {
    const wroteAt = block.indexOf("status: 'invited'")
    const emailAt = block.indexOf('sendInvoiceEmail(')
    expect(wroteAt).toBeLessThan(emailAt)
    const failure = block.slice(block.indexOf('if (!inviteResult.ok) {'))
    expect(failure).toContain('priorAutopay?.status ?? ')
    expect(failure.indexOf('updateClientAutopay')).toBeLessThan(failure.indexOf('502'))
  })

  it('the owner turning it off goes through turnOffAutopay', () => {
    expect(squash(block)).toContain("by: 'owner'")
    expect(block).toContain('turnOffAutopay({')
  })
})

describe('/autopay/:token (the client page)', () => {
  const block = sliceBetween(
    'const autopayLinkMatch = normalizedPath.match(',
    '// ---- GET /pay/:token',
  )

  it('allows only GET and HEAD, and POST on the withdraw path alone', () => {
    expect(block).toContain("isWithdrawPath ? ['GET', 'HEAD', 'POST'] : ['GET', 'HEAD']")
    expect(block).toContain('405')
  })

  it('a HEAD mints nothing and changes nothing', () => {
    const head = block.indexOf("request.method === 'HEAD'")
    expect(head).toBeGreaterThan(-1)
    for (const later of ['ensureStripeCustomer(', 'createAutopaySetupSession(', 'turnOffAutopay(']) {
      expect(head).toBeLessThan(block.indexOf(later))
    }
  })

  it('looks the token up only after the shape check and the IP rate limit', () => {
    const shape = block.indexOf('[A-Za-z0-9_-]{20,64}')
    const limit = block.indexOf('apip:')
    const lookup = block.indexOf('findClientAutopayByToken(')
    expect(shape).toBeLessThan(limit)
    expect(limit).toBeLessThan(lookup)
  })

  // A mail scanner opens every link in a message. Only the POST may withdraw.
  it('a GET on the withdraw path only shows the confirm page; only the POST turns it off', () => {
    const withdrawBranch = block.slice(block.indexOf('if (isWithdrawPath) {'))
    const showAt = withdrawBranch.indexOf("request.method === 'GET'")
    const showReturn = withdrawBranch.indexOf('return', showAt)
    const actAt = withdrawBranch.indexOf('turnOffAutopay(')
    expect(showAt).toBeGreaterThan(-1)
    expect(showReturn).toBeLessThan(actAt)
    expect(withdrawBranch.slice(showAt, showReturn)).toContain('renderAutopayWithdrawPage')
  })

  it('the confirm page posts to the withdraw path', () => {
    const page = sliceBetween('function renderAutopayWithdrawPage(', '// ---- Invoice confidence ratings')
    expect(page).toContain('<form method="POST" action="/autopay/${safeToken}/withdraw">')
  })

  it('the owners are told when a client withdraws, and only if something changed', () => {
    const withdrawn = block.slice(block.indexOf('turnOffAutopay('))
    expect(withdrawn.indexOf('withdrawn.changed')).toBeLessThan(
      withdrawn.indexOf("'autopay_withdrawn'"),
    )
  })

  it('every page sets the pay-page headers (never cached, never framed)', () => {
    expect(block).not.toContain('response.writeHead(200')
    expect(block).toContain('...PAY_RESPONSE_HEADERS')
  })
})

describe('the Stripe webhook and setup events', () => {
  const webhook = sliceBetween(
    "normalizedPath === '/api/stripe/webhook' && request.method === 'POST'",
    "normalizedPath === '/api/resend/webhook'",
  )

  it('recognizes a setup event after the ledger and BEFORE the invoice lookup', () => {
    const ledgered = webhook.indexOf('recordStripeEventOnce(')
    const classified = webhook.indexOf('classifySetupEvent(event)')
    const lookup = webhook.indexOf('findInvoiceByStripeRef(')
    expect(ledgered).toBeGreaterThan(-1)
    expect(ledgered).toBeLessThan(classified)
    expect(classified).toBeLessThan(lookup)
  })

  // The catch below forgets the event when nothing was applied, so a failed
  // enrollment write is retried by Stripe rather than answered "duplicate".
  it('the setup branch sits inside the try whose catch takes the event back out of the ledger', () => {
    const tryAt = webhook.lastIndexOf('try {', webhook.indexOf('classifySetupEvent(event)'))
    const catchAt = webhook.indexOf('} catch (error) {', tryAt)
    expect(catchAt).toBeGreaterThan(webhook.indexOf('classifySetupEvent(event)'))
    expect(webhook.slice(catchAt)).toContain('forgetStripeEvent(event.id)')
    expect(webhook.slice(catchAt)).toContain('if (!paymentApplied)')
  })

  it('acknowledges every event it has no use for with a 200', () => {
    expect(squash(webhook)).toContain('sendJson(response, 200, { received: true, matched: false })')
    expect(webhook).toContain('sendJson(response, 200, { received: true })')
  })
})

/* -------------------------------------------------------------------------- */
/* Commit 3: charge on send                                                    */
/* -------------------------------------------------------------------------- */

describe('the send route and autopay', () => {
  const send = sliceBetween(
    'const invoiceSendMatch = normalizedPath.match(',
    '// GET /api/invoices/export.csv',
  )

  // The decision about WHETHER this send is an autopay send is taken before
  // anything is minted or emailed: the email must not carry a pay link for an
  // invoice that is about to be charged, and must not promise a charge that will
  // not happen.
  it('plans the autopay send before it mints a link or builds the email', () => {
    const planAt = send.indexOf('await planAutopaySend(invoice, sendClient)')
    expect(planAt).toBeGreaterThan(-1)
    expect(planAt).toBeLessThan(send.indexOf('createInvoiceCheckoutSession('))
    expect(planAt).toBeLessThan(send.indexOf('getOrCreateInvoicePayToken('))
    expect(planAt).toBeLessThan(send.indexOf('buildInvoiceEmail('))
  })

  it('mints no pay token or session for an autopay send, or for one with a charge in flight', () => {
    const mint = squash(send.slice(send.indexOf('const autopaySend'), send.indexOf('createInvoiceCheckoutSession(')))
    expect(mint).toContain('!autopaySend.plan')
    expect(mint).toContain('!autopaySend.active')
    expect(mint).toContain('!settled')
  })

  it('hands the email the charge it announces, and nothing else changes for other sends', () => {
    const email = send.slice(send.indexOf('buildInvoiceEmail('), send.indexOf('buildInvoicePdf('))
    expect(email).toContain('autopay: autopaySend.plan')
    expect(email).toContain('autopayChargeCents(invoice, autopaySend.plan.channel) / 100')
    expect(email).toContain('/autopay/${autopaySend.plan.enrollment.setupToken}/withdraw')
    expect(email).toContain(': null,')
  })

  // THE CHARGE. After the email is out AND recorded, never in the failed-send
  // branch, and only for a send that was planned.
  it('charges only after the email left and was recorded, and only for a planned send', () => {
    const sendOk = send.indexOf('if (!sendResult.ok) {')
    const failedBranchEnd = send.indexOf('return', send.indexOf('invoice_send_failed', sendOk))
    const recordedAt = send.indexOf('ok: true,')
    const chargeAt = send.indexOf('chargeAfterSend(')
    expect(chargeAt).toBeGreaterThan(failedBranchEnd)
    expect(chargeAt).toBeGreaterThan(send.indexOf('recordInvoiceSent(', recordedAt - 200))
    expect(squash(send)).toContain('if (autopaySend.plan && sendWasRecorded) {')
    expect(send).toContain('const sendWasRecorded = sentInvoice !== invoice')
  })

  it('a failed send charges nothing: the charge call is not in the failed branch', () => {
    const failedBranch = send.slice(
      send.indexOf('if (!sendResult.ok) {'),
      send.indexOf('Past this point the email HAS been delivered'),
    )
    expect(failedBranch).not.toContain('chargeAfterSend')
    expect(failedBranch).not.toContain('runAutopayCharge')
  })

  it('the response is answered after the charge, and never fails because of it', () => {
    const helper = sliceBetween('async function chargeAfterSend(', 'async function planAutopaySend(')
    expect(helper).toContain('try {')
    expect(helper).toContain('catch (error)')
    expect(helper).toContain('attemptNo: 1,')
    expect(helper).toContain('return fallback')
    expect(send.indexOf('chargeAfterSend(')).toBeLessThan(send.indexOf('sendJson(response, 200, { invoice: sentInvoice })'))
  })

  // Nothing in the send route itself may touch Stripe's PaymentIntents or the
  // attempt table: it can only ASK runAutopayCharge.
  it('the route itself creates no PaymentIntent and writes no attempt', () => {
    for (const forbidden of ['paymentIntents', 'claimAutopayAttempt', 'updateAutopayAttempt']) {
      expect(send).not.toContain(forbidden)
    }
  })
})

describe('planAutopaySend (the pre-send decision), run for real with a stubbed store', () => {
  const lf = serverSource.replace(/\r\n/g, '\n')
  const planStart = lf.indexOf('async function planAutopaySend(')
  const body = lf.slice(planStart, lf.indexOf('\n}\n', planStart) + 3)
  // A plain-JS server lib with no declaration file: tsc cannot see into it.
  // @ts-expect-error TS7016
  const dependencies = import('../../lib/stripe-autopay.js')

  async function planner(store: object, stripeConfigured = true) {
    const lib = await dependencies
    const make = new Function(
      'appDataStore',
      'autopayChargeDecision',
      'hasActiveAutopayAttempt',
      'isStripeConfigured',
      'console',
      `${body}\nreturn planAutopaySend`,
    )
    return make(
      store,
      lib.autopayChargeDecision,
      lib.hasActiveAutopayAttempt,
      () => stripeConfigured,
      { error() {} },
    ) as (
      invoice: unknown,
      client: unknown,
    ) => Promise<{ plan: { channel: string } | null; active: boolean }>
  }

  const enrollment = {
    clientId: 'c1',
    status: 'enrolled',
    paymentMethodId: 'pm_1',
    methodType: 'us_bank_account',
    setupToken: 'tok',
  }
  const invoice = { id: 'inv-1', status: 'reviewed', total: 100, emailLog: [] as unknown[] }
  const client = { id: 'c1', name: 'Acme' }
  const storeOf = (over: Record<string, unknown> = {}) => ({
    getClientAutopay: async () => enrollment,
    listAutopayAttempts: async () => [],
    ...over,
  })

  const saved = process.env.AUTOPAY_CHARGING
  afterEach(() => {
    if (saved === undefined) delete process.env.AUTOPAY_CHARGING
    else process.env.AUTOPAY_CHARGING = saved
  })

  it('plans a charge for the first send of an enrolled client when the switch is on', async () => {
    process.env.AUTOPAY_CHARGING = 'on'
    const plan = await (await planner(storeOf()))(invoice, client)
    expect(plan.plan).toMatchObject({ channel: 'ach' })
  })

  // The email would promise a charge that could not be made.
  it('plans nothing when Stripe is not connected, even with the switch on and a client enrolled', async () => {
    process.env.AUTOPAY_CHARGING = 'on'
    expect((await (await planner(storeOf(), false))(invoice, client)).plan).toBeNull()
  })

  it('plans NOTHING while the kill switch is unset: the send is an ordinary one with its pay link', async () => {
    delete process.env.AUTOPAY_CHARGING
    expect(await (await planner(storeOf()))(invoice, client)).toEqual({ plan: null, active: false })
  })

  it.each([
    ['a re-send (the invoice already went out once)', { ...invoice, status: 'sent', emailLog: [{ ok: true }] }],
    ['a re-send of a changed-since-sent invoice', { ...invoice, status: 'sent', emailLog: [{ ok: true }, { kind: 'delivery' }] }],
    ['a voided invoice', { ...invoice, status: 'void' }],
    ['a $0 invoice', { ...invoice, total: 0 }],
    ['a paid invoice', { ...invoice, status: 'paid' }],
  ])('plans nothing for %s', async (_name, candidate) => {
    process.env.AUTOPAY_CHARGING = 'on'
    expect((await (await planner(storeOf()))(candidate, client)).plan).toBeNull()
  })

  it('plans nothing for a client who withdrew, and nothing when no enrollment exists', async () => {
    process.env.AUTOPAY_CHARGING = 'on'
    const withdrawn = storeOf({ getClientAutopay: async () => ({ ...enrollment, status: 'withdrawn' }) })
    expect((await (await planner(withdrawn))(invoice, client)).plan).toBeNull()
    const none = storeOf({ getClientAutopay: async () => null })
    expect(await (await planner(none))(invoice, client)).toEqual({ plan: null, active: false })
  })

  it('reports an attempt already in flight, so a re-send goes out as a statement', async () => {
    process.env.AUTOPAY_CHARGING = 'on'
    const busy = storeOf({ listAutopayAttempts: async () => [{ invoiceId: 'inv-1', attemptNo: 1, status: 'processing' }] })
    const result = await (await planner(busy))({ ...invoice, status: 'sent', emailLog: [{ ok: true }] }, client)
    expect(result).toEqual({ plan: null, active: true })
  })

  it('FAILS CLOSED when the store cannot be read: no plan, so no autopay email and no charge', async () => {
    process.env.AUTOPAY_CHARGING = 'on'
    const broken = storeOf({
      getClientAutopay: async () => {
        throw new Error('db down')
      },
    })
    expect(await (await planner(broken))(invoice, client)).toEqual({ plan: null, active: false })
  })

  it('only reads: it can claim nothing', () => {
    expect(body).not.toContain('claimAutopayAttempt')
    expect(body).not.toContain('paymentIntents')
  })
})

describe('POST /api/invoices/:id/autopay/charge-again', () => {
  const block = sliceBetween(
    'const autopayChargeAgainMatch = normalizedPath.match(',
    '// POST /api/stripe/webhook',
  )

  it('is owner-only, same-origin and JSON, before anything else', () => {
    const owner = block.indexOf("session.user.role !== 'owner'")
    const origin = block.indexOf('isCrossSiteOrigin(request)')
    const json = block.indexOf("'application/json required'")
    expect(owner).toBeLessThan(origin)
    expect(origin).toBeLessThan(json)
    expect(json).toBeLessThan(block.indexOf('autopayChargingEnabled()'))
  })

  it('is behind the kill switch, decided before Stripe or the store is touched', () => {
    const switchAt = block.indexOf('!autopayChargingEnabled()')
    expect(switchAt).toBeGreaterThan(-1)
    expect(switchAt).toBeLessThan(block.indexOf('listAutopayAttempts('))
    expect(switchAt).toBeLessThan(block.indexOf('runAutopayCharge('))
    expect(block).toContain("error: 'autopay_charging_off'")
  })

  it('only follows a FAILED attempt, and claims the NEXT attempt number', () => {
    expect(block).toContain("lastAttempt.status !== 'failed'")
    expect(block).toContain("error: 'autopay_not_failed'")
    expect(block).toContain('attemptNo: Number(lastAttempt.attemptNo) + 1')
    expect(block.indexOf("lastAttempt.status !== 'failed'")).toBeLessThan(block.indexOf('runAutopayCharge('))
  })

  it('answers a refusal as a 409 sentence, and the invoice on success', () => {
    expect(block).toContain("error: 'autopay_not_charged'")
    expect(block).toContain('sendJson(response, 200, { invoice:')
  })
})

describe('GET /api/autopay/attempts', () => {
  const block = sliceBetween(
    "normalizedPath === '/api/autopay/attempts' && request.method === 'GET'",
    '// POST /api/invoices/:id/autopay/charge-again',
  )
  it('is owner-only and never sends the intent id', () => {
    expect(block.indexOf("session.user.role !== 'owner'")).toBeLessThan(block.indexOf('listAutopayAttempts('))
    expect(block).not.toContain('paymentIntentId')
    expect(block).toContain('chargingEnabled: autopayChargingEnabled()')
  })
})

describe('the webhook and autopay attempts', () => {
  const webhook = sliceBetween(
    "normalizedPath === '/api/stripe/webhook' && request.method === 'POST'",
    "normalizedPath === '/api/resend/webhook'",
  )

  it('records a failed attempt FIRST, before the stale-failure guards can drop the event', () => {
    const failedBranch = webhook.slice(webhook.indexOf("event.type === 'payment_intent.payment_failed'"))
    const recordAt = failedBranch.indexOf("outcome: 'failed'")
    expect(recordAt).toBeGreaterThan(-1)
    expect(recordAt).toBeLessThan(failedBranch.indexOf("invoice.status === 'paid' ||"))
    expect(failedBranch.slice(0, recordAt)).toContain('if (settledByAutopay)')
  })

  it('records a succeeded attempt after the invoice is applied', () => {
    const succeeded = webhook.slice(webhook.indexOf("event.type === 'payment_intent.succeeded'"))
    expect(succeeded.indexOf("status: 'paid'")).toBeLessThan(succeeded.indexOf("outcome: 'succeeded'"))
  })

  it('an autopay payment is recognized by the metadata WE put on the intent', () => {
    expect(webhook).toContain("settledByAutopay = object.metadata?.autopay === '1'")
  })

  it('the receipt for an autopay payment carries the withdraw link', () => {
    expect(squash(webhook)).toContain("paidEnrollment?.status === 'enrolled' && paidEnrollment.setupToken")
    expect(webhook).toContain('/autopay/${paidEnrollment.setupToken}/withdraw')
  })

  it('never sends an acknowledgment for a bank autopay: the route moves it to processing, with no email', () => {
    const helper = sliceBetween('async function chargeAfterSend(', 'async function planAutopaySend(')
    expect(helper).not.toContain('sendInvoicePaymentEmail')
    expect(squash(webhook)).toContain('settledInvoice.statusChanged')
  })
})

describe('no second way to pay an invoice autopay is charging', () => {
  it('the pay page answers a status page, not a Checkout, while an attempt is active', () => {
    const pay = sliceBetween('const payLinkMatch = normalizedPath.match(', "if (normalizedPath === '/api/logout'")
    const at = pay.indexOf('hasActiveAutopayAttempt(')
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(pay.indexOf('createInvoiceCheckoutSession'))
    expect(at).toBeLessThan(pay.indexOf('ensureStripeCustomer('))
    expect(pay.slice(at, at + 700)).toContain('A payment is already on its way')
  })

  it('the owner payment-link route refuses while an attempt is active, before any Stripe call', () => {
    const link = sliceBetween('const invoicePaymentLinkMatch = normalizedPath.match(', '// POST /api/invoices/:id/mark-paid')
    const at = link.indexOf('hasActiveAutopayAttempt(')
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(link.indexOf('ensureStripeCustomer('))
    expect(link).toContain("error: 'autopay_in_flight'")
  })
})

/* -------------------------------------------------------------------------- */
/* Review fixes                                                                */
/* -------------------------------------------------------------------------- */

describe('the send route tells the charge what the email said (M2, M3)', () => {
  const send = sliceBetween(
    'const invoiceSendMatch = normalizedPath.match(',
    '// GET /api/invoices/export.csv',
  )
  const helper = sliceBetween('async function chargeAfterSend(', 'async function planAutopaySend(')

  it('passes the amount the email quoted, and says the client was already told', () => {
    expect(squash(send)).toContain(
      'sentInvoice = await chargeAfterSend( request, invoice.id, sentInvoice, autopayChargeCents(invoice, autopaySend.plan.channel), )',
    )
    expect(helper).toContain('emailedCents,')
    expect(helper).toContain('announced: true,')
  })

  it('a planned send that could not be recorded is REPORTED, not dropped', () => {
    expect(squash(send)).toContain(
      '} else if (autopaySend.plan) { await reportUnrecordedAutopaySend(request, invoice, autopaySend.plan.channel) }',
    )
    expect(helper).toContain("reason: 'send_not_recorded'")
    expect(helper).toContain('reportAutopayNotCharged({')
  })

  it('an unexpected failure in the charge step tells the owners and does not claim nothing was charged', () => {
    const catchAt = helper.indexOf('} catch (error) {')
    const caught = helper.slice(catchAt, helper.indexOf('async function reportUnrecordedAutopaySend'))
    expect(caught).toContain("notifyOwners('invoice_payment_failed'")
    expect(caught).toContain('Check Stripe to see whether the client was charged')
    expect(caught).not.toContain('nothing was charged')
  })

  it('a card email names its processing fee', () => {
    expect(send).toContain("autopaySend.plan.channel === 'card'")
    expect(send).toContain("autopayChargeCents(invoice, 'card') - autopayChargeCents(invoice, 'ach')")
    expect(send).toContain('cardFee:')
  })
})

describe('POST /api/invoices/:id/autopay/check (Check with Stripe)', () => {
  const block = sliceBetween(
    'const autopayCheckMatch = normalizedPath.match(',
    '// POST /api/stripe/webhook',
  )

  it('is owner-only, same-origin, JSON and needs Stripe, before anything is read', () => {
    const owner = block.indexOf("session.user.role !== 'owner'")
    const origin = block.indexOf('isCrossSiteOrigin(request)')
    const json = block.indexOf("'application/json required'")
    const stripe = block.indexOf('!isStripeConfigured()')
    expect(owner).toBeLessThan(origin)
    expect(origin).toBeLessThan(json)
    expect(json).toBeLessThan(stripe)
    expect(stripe).toBeLessThan(block.indexOf('reconcileAutopayAttempt('))
  })

  it('only reconciles: it creates no charge and claims no attempt', () => {
    for (const forbidden of ['runAutopayCharge', 'claimAutopayAttempt', 'paymentIntents', 'chargeAutopayInvoice']) {
      expect(block).not.toContain(forbidden)
    }
  })

  it('answers a sentence for a refusal and the invoice for an outcome', () => {
    expect(block).toContain("error: 'autopay_not_stuck'")
    expect(block).toContain("error: 'stripe_unreachable'")
    expect(block).toContain('outcome: checked.outcome')
  })
})

describe('planAutopaySend requires Stripe to be connected (L6)', () => {
  it('the plan is gated on isStripeConfigured()', () => {
    const lf = serverSource.replace(/\r\n/g, '\n')
    const start = lf.indexOf('async function planAutopaySend(')
    const body = lf.slice(start, lf.indexOf('\n}\n', start) + 3)
    expect(body).toContain('decision.ok && isStripeConfigured()')
  })
})

/* -------------------------------------------------------------------------- */
/* A pay link minted DURING a charge                                           */
/* -------------------------------------------------------------------------- */

/**
 * The check for an active attempt that sits BEFORE a session is minted can be
 * stale by the time the session is stored: a charge claimed in between retired
 * only the session ids it could see. So each of the three places that mint a
 * pay session asks again AFTER the swap that stores it, closes the session it
 * just minted, and refuses. Either the swap landed before the claim read the
 * invoice (the claim's retire closed the session) or the claim committed first
 * (this read sees it).
 */
describe('a session minted while a charge starts is closed, not handed over', () => {
  it('the pay page re-checks after storing the session, closes it, and never redirects to it', () => {
    const pay = sliceBetween('const payLinkMatch = normalizedPath.match(', "if (normalizedPath === '/api/logout'")
    const swapAt = pay.indexOf('const paySwap = await')
    const recheck = pay.indexOf('hasActiveAutopayAttempt(', swapAt)
    expect(recheck).toBeGreaterThan(swapAt)
    const closeAt = pay.indexOf('expireCheckoutSession(payResult.session.id)', recheck)
    expect(closeAt).toBeGreaterThan(recheck)
    expect(pay.slice(recheck, closeAt + 400)).toContain('A payment is already on its way')
    expect(closeAt).toBeLessThan(pay.indexOf('Location: payResult.session.url'))
  })

  it('the owner payment-link route re-checks after storing the session and refuses', () => {
    const link = sliceBetween('const invoicePaymentLinkMatch = normalizedPath.match(', '// POST /api/invoices/:id/mark-paid')
    const swapAt = link.indexOf('const linkSwap = await')
    const recheck = link.indexOf('hasActiveAutopayAttempt(', swapAt)
    expect(recheck).toBeGreaterThan(swapAt)
    const closeAt = link.indexOf('expireCheckoutSession(result.session.id)', recheck)
    expect(closeAt).toBeGreaterThan(recheck)
    expect(link.slice(closeAt, closeAt + 300)).toContain("error: 'autopay_in_flight'")
    expect(closeAt).toBeLessThan(link.indexOf('recordActivity(', swapAt))
  })

  it('the send route re-checks after BOTH sessions are stored, closes them, and emails nothing', () => {
    const send = sliceBetween('const invoiceSendMatch = normalizedPath.match(', '// GET /api/invoices/export.csv')
    const lastSwap = send.indexOf('const cardSwap = await')
    const recheck = send.indexOf('hasActiveAutopayAttempt(', lastSwap)
    expect(recheck).toBeGreaterThan(lastSwap)
    const closeAt = send.indexOf('expireInvoiceSessions(mintedSessionIds', recheck)
    expect(closeAt).toBeGreaterThan(recheck)
    expect(send.slice(closeAt, closeAt + 400)).toContain("error: 'autopay_in_flight'")
    // Before the email is built or sent.
    expect(closeAt).toBeLessThan(send.indexOf('buildInvoiceEmail('))
    expect(closeAt).toBeLessThan(send.indexOf('sendInvoiceEmail('))
  })

  it('the Charge again route answers the specific sentence, not a generic one', () => {
    const block = sliceBetween('const autopayChargeAgainMatch = normalizedPath.match(', '// POST /api/stripe/webhook')
    expect(squash(block)).toContain('chargeAgain.message ?? autopayRefusalWords(chargeAgain.reason)')
  })
})
