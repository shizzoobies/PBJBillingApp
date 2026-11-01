import PDFDocument from 'pdfkit'
import { AdvancePaymentError } from './advance-payments.js'
import { stripeClient } from './stripe-rail.js'
import { hasActiveAutopayAttempt } from './stripe-autopay.js'
import { advanceOfferCollection, invoiceAdvanceOffer } from './invoice-advance-offer.js'
import { combinedAdvanceCents } from './payment-amount-mismatch.js'

/** The invoices of this request's client whose advance section names it. */
async function invoicesCarrying(store, request) {
  return (await store.listInvoices()).filter((invoice) => invoice.clientId === request.clientId && invoiceAdvanceOffer(invoice)?.requestId === request.id)
}

/** The statuses `/pay/<token>` takes a payment on (it refuses everything else). */
const PAYABLE_STATUSES = new Set(['sent', 'overdue'])

/** Refusal that names an invoice: the owner may see it, the public page never. */
export class AdvanceCollectedElsewhereError extends AdvancePaymentError {}

/**
 * Would this invoice's `/pay/<token>` page serve the advance right now? The
 * offer asks for one payment (collection 'invoice'; a 'separate' offer never
 * counts), the pay page would take a payment at all (sent/overdue, a pay token,
 * a client it serves, no autopay charge in flight), and the live link answer
 * (`invoiceCheckoutAdvance`) carries it. A draft rewound from sent, a first
 * autopay send, Stripe off or unreachable: not serving, so the advance page
 * stays the one place to pay.
 */
export async function invoiceServesAdvance(store, invoice, { stripe } = {}) {
  if (advanceOfferCollection(invoiceAdvanceOffer(invoice)) !== 'invoice') return false
  if (!PAYABLE_STATUSES.has(invoice.status) || !invoice.payToken) return false
  const client = await store.getClientById(invoice.clientId)
  if (!client || client.platformInvoicingOptOut || client.invoiceNoEmail) return false
  if (hasActiveAutopayAttempt(await store.listAutopayAttempts({ invoiceId: invoice.id }))) return false
  return (await invoiceCheckoutAdvance(store, invoice, { stripe })) !== null
}

/**
 * THE one answer to "is an invoice collecting this advance?", shared by the
 * advance page (GET and POST), the owner's bank link and the pay link:
 *  - `{ state: 'in-flight', invoice }`: an invoice that asks for one payment is
 *    mid-payment (processing), and that payment may include the advance. No
 *    link collects it until that settles or fails (`invoiceCheckoutAdvance`
 *    answers null for every other invoice too).
 *  - `{ state: 'invoice', invoice }`: that invoice's pay link serves it
 *    (`invoiceServesAdvance`), so the advance page takes no payment.
 *  - null: the advance page is where it is paid.
 */
export async function advanceCollection(store, request, { stripe } = {}) {
  const carriers = (await invoicesCarrying(store, request)).filter((invoice) => advanceOfferCollection(invoiceAdvanceOffer(invoice)) === 'invoice')
  const busy = carriers.find((invoice) => invoice.status === 'processing')
  if (busy) return { state: 'in-flight', invoice: busy }
  for (const invoice of carriers) if (await invoiceServesAdvance(store, invoice, { stripe })) return { state: 'invoice', invoice }
  return null
}

// What each audience is told. The owner sees the invoice; the public page never.
const collectedWithInvoice = (found) => found.state === 'in-flight'
  ? `Invoice ${found.invoice.number ?? found.invoice.id} has a payment in progress that may include this advance. Wait for it to settle or fail before collecting the advance separately.`
  : `This advance is collected together with invoice ${found.invoice.number ?? found.invoice.id}. Pay it with that invoice's payment link.`
const PUBLIC_COLLECTED_GENERIC = "This advance is collected together with an invoice from the firm. Pay it with that invoice's payment link."
const publicCollected = (found) => found.state === 'in-flight'
  ? 'A payment that may include this advance is being processed. Bank payments take several business days to settle; check this page again afterward.'
  : PUBLIC_COLLECTED_GENERIC

/**
 * What a PAID (or processing) invoice's own Stripe payment brought toward its
 * advance, for documents built after payment (a re-send, a preview): the
 * receipt keyed on that payment's intent. Null when the invoice was not paid
 * through Stripe (by credit, by hand) or asks for no one-payment advance.
 */
export async function invoiceAdvanceSettlement(store, invoice) {
  const offer = invoiceAdvanceOffer(invoice)
  if (!offer || offer.collection !== 'invoice' || !invoice.stripePaymentIntentId) return null
  if (invoice.status === 'processing') return { advanceCents: null, pending: true }
  if (invoice.status !== 'paid') return null
  const { receipts } = await store.listAdvancePayments(invoice.clientId)
  return { advanceCents: receipts.find((row) => row.sourceRef === `stripe:${invoice.stripePaymentIntentId}`)?.cents ?? 0, pending: false }
}

/**
 * Is an advance-ONLY payment for this request open or in flight (an open
 * Checkout session, a bank payment processing, or one that settled before its
 * receipt was written)? The same facts `advanceCheckout` inspects. Stripe
 * unreachable answers true: not knowing is not a reason to collect twice.
 */
async function advanceOnlyInFlight({ sessions, receipts }, request, given) {
  const own = sessions.filter((row) => row.requestId === request.id)
  if (!own.length) return false
  // Resolved only when there is a link to ask about.
  const stripe = given === undefined ? stripeClient() : given
  if (!stripe) return false
  try {
    for (const saved of own) {
      const current = await stripe.checkout.sessions.retrieve(saved.id)
      if (current.status === 'open') return true
      if (current.status !== 'complete') continue
      const intentId = typeof current.payment_intent === 'string' ? current.payment_intent : current.payment_intent?.id
      const intent = intentId ? await stripe.paymentIntents.retrieve(intentId) : null
      if (!intent || ['processing', 'requires_action', 'requires_confirmation'].includes(intent.status)) return true
      if (intent.status === 'succeeded' && !receipts.some((receipt) => receipt.sourceRef === `stripe:${intent.id}`)) return true
    }
    return false
  } catch (error) {
    console.error('[advance payments] could not check advance-only links; leaving the advance off the invoice link:', error?.message || error)
    return true
  }
}

/**
 * The advance an invoice's payment link carries right now, or null: only an
 * offer attached with collection 'invoice' whose request is still active with
 * an amount outstanding, and only when nothing else is already collecting it -
 * another invoice carrying it is mid-payment (processing), or an advance-only
 * link for it is open or in flight. The amount is LIVE from the ledger, never
 * the snapshot frozen on the offer. Every document that describes the link
 * (pay page, email, PDF) is built from this same answer, so a null here never
 * promises the advance anywhere. An invoice with no such offer reads nothing.
 */
export async function invoiceCheckoutAdvance(store, invoice, { stripe } = {}) {
  const offer = invoiceAdvanceOffer(invoice)
  if (!offer || offer.collection !== 'invoice') return null
  const ledger = await store.listAdvancePayments(invoice.clientId)
  const request = ledger.requests.find((row) => row.id === offer.requestId)
  if (!request || request.clientId !== invoice.clientId || request.canceledAt || !(request.outstandingCents > 0)) return null
  if ((await invoicesCarrying(store, request)).some((other) => other.id !== invoice.id && other.status === 'processing')) return null
  if (await advanceOnlyInFlight({ sessions: ledger.sessions ?? [], receipts: ledger.receipts ?? [] }, request, stripe)) return null
  return { requestId: request.id, number: request.number, cents: request.outstandingCents, optional: offer.optional === true }
}

/**
 * After a manual receipt or a cancellation: close the stored bank and card
 * Checkout sessions of every not-paid invoice collecting this request on its
 * link (collection 'invoice'), so an old
 * invoice link cannot collect an advance that is fulfilled or canceled. The
 * next open of the durable `/pay/<token>` link mints a fresh session with the
 * advance as it now stands. Only OPEN sessions are expired; a completed one is
 * a payment and is left to the webhook. Throws when Stripe cannot confirm.
 */
export async function closeInvoiceAdvanceSessions(store, request, stripe = stripeClient()) {
  if (!stripe) return
  let failed = null
  for (const invoice of await invoicesCarrying(store, request)) {
    // Only links minted to carry the advance: a 'separate' offer's sessions
    // never did, and are never touched here.
    if (['paid', 'void'].includes(invoice.status) || advanceOfferCollection(invoiceAdvanceOffer(invoice)) !== 'invoice') continue
    for (const id of [invoice.stripeCheckoutSessionId, invoice.stripeCardSessionId].filter(Boolean)) {
      try {
        const session = await stripe.checkout.sessions.retrieve(id)
        if (session.status === 'open') await stripe.checkout.sessions.expire(id)
      } catch (error) { failed = error }
    }
  }
  if (failed) throw failed
}

/**
 * The webhook's step for ONE payment that paid an invoice AND the advance its
 * link carried: after the invoice payment applied, the advance portion
 * (`combinedAdvanceCents`) becomes a receipt keyed on the Stripe intent, so a
 * redelivery writes nothing new. A payer who removed an optional advance pays 0
 * for it and no receipt is written. Money that arrived is always recorded; when
 * the request had less outstanding than this portion (it was paid or canceled
 * meanwhile) the owners are told of the over-collection. Older advance-only
 * links are then closed, best effort. Returns the advance cents recorded (0
 * when none). `invoice` is the invoice as looked up before the payment applied.
 */
export async function settleCombinedAdvance({ store, event, invoice, isCard, receivedOn, close = closeAdvanceSessions, notifyOwners = async () => {} }) {
  const object = event?.data?.object ?? {}
  const requestId = object.metadata?.advancePaymentRequestId
  if (event?.type !== 'payment_intent.succeeded' || !requestId || !object.metadata?.invoiceId) return 0
  const cents = combinedAdvanceCents({ eventType: event.type, object, invoice, isCard })
  if (cents <= 0) return 0
  const before = await store.listAdvancePayments(invoice.clientId)
  const request = before.requests.find((row) => row.id === requestId)
  const alreadyRecorded = before.receipts.some((row) => row.sourceRef === `stripe:${object.id}`)
  const receipt = await store.recordAdvancePayment({ requestId, receivedOn }, null, object, cents)
  if (!alreadyRecorded && request && request.outstandingCents < cents) {
    await notifyOwners(`Invoice ${invoice.number ?? invoice.id}'s payment included ${money(cents)} toward advance ${request.number}, but only ${money(request.outstandingCents)} was still requested${request.canceledAt ? ' (the request was canceled)' : ''}. All ${money(cents)} was recorded as credit on account; refund or keep the extra ${money(cents - request.outstandingCents)} by hand.`)
      .catch((error) => console.error('[advance payments] over-collection notice failed:', error))
  }
  await close(store, requestId).catch((error) => console.error('[advance payments] stale link cleanup failed:', error))
  return receipt.cents
}

/**
 * `settleCombinedAdvance` for the webhook route, with what a failure needs:
 * the invoice has already been marked paid, so the event would otherwise stay
 * in the dedup ledger and the advance would never be recorded. On a throw the
 * event is taken back out (`forgetStripeEvent`) so Stripe's retry runs the
 * whole event again (the invoice apply replays harmlessly on the same intent),
 * the owners are told with the intent and amounts, and the error is rethrown.
 */
// Payment intents whose advance-write failure the owners were already told of
// (one notice per intent, not one per Stripe retry; per process).
const settleFailureNoticed = new Set()

export async function settleCombinedAdvanceOrRelease({ store, event, notifyOwners = async () => {}, ...args }) {
  try {
    return await settleCombinedAdvance({ store, event, notifyOwners, ...args })
  } catch (error) {
    try { await store.forgetStripeEvent(event.id) } catch (forgetError) { console.error(`[advance payments] could not release event ${event.id}; its retry will be answered duplicate:`, forgetError) }
    const object = event?.data?.object ?? {}
    if (settleFailureNoticed.has(object.id)) throw error
    settleFailureNoticed.add(object.id)
    await notifyOwners(`A payment for invoice ${object.metadata?.invoiceNumber || object.metadata?.invoiceId} (Stripe ${object.id}, ${money(Number(object.amount_received) || 0)} received, ${money(Number(object.metadata?.advanceCents) || 0)} toward the advance) was applied to the invoice, but its advance credit could not be recorded yet, and the client's payment receipt waits for the retry. Stripe will retry; if this repeats, record the advance by hand.`)
      .catch((notifyError) => console.error('[advance payments] settle-failure notice failed:', notifyError))
    throw error
  }
}

const money = (cents) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const html = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
export function advancePaymentPdf(request, client, receipts) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 54 })
    const chunks = []
    doc.on('data', (chunk) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
    doc.fontSize(20).text('Advance payment request')
    doc.moveDown().fontSize(12).text(request.number).text(client.name)
    doc.text(`Prepared ${request.createdAt.slice(0, 10)}`)
    doc.moveDown().text(`Requested advance: ${money(request.requestedCents)}`)
    doc.text(`Payments received: ${money(request.receivedCents)}`)
    doc.text(`Amount still requested: ${money(request.outstandingCents)}`)
    if (request.canceledAt) doc.text('Request canceled. Payments already received remain on the credit ledger.')
    if (request.note) doc.moveDown().text(request.note)
    doc.moveDown().text('This requests funds to hold as credit toward future invoices. It is not a charge for services. Credit is recorded only after payment is received; monthly invoices show the charges and credit applied.')
    for (const receipt of receipts.filter((row) => row.requestId === request.id)) doc.moveDown().text(`Received ${receipt.receivedOn}: ${money(receipt.cents)} (${receipt.method})`)
    doc.end()
  })
}

/** ACH-only collection deliberately excludes card fees and automatic charging.
 * Settled principal is the verified USD amount received, never the requested total.
 */
export async function advanceCheckout({ store, request, client, appUrl, stripe = stripeClient() }) {
  if (request.canceledAt || request.outstandingCents <= 0) throw new AdvancePaymentError('This request has no amount left to collect.')
  const collecting = await advanceCollection(store, request)
  if (collecting) throw new AdvanceCollectedElsewhereError(collectedWithInvoice(collecting))
  if (!stripe) throw new AdvancePaymentError('Stripe is not configured. Record an actual bank or check payment after it arrives.')
  const ledger = store.advancePaymentLedger()
  const { sessions, receipts } = await ledger.list(client.id)
  const own = sessions.filter((row) => row.requestId === request.id)
  let prior = ''
  for (const saved of own) {
    const current = await stripe.checkout.sessions.retrieve(saved.id)
    prior = saved.id
    if (current.status === 'complete') {
      const intentId = typeof current.payment_intent === 'string' ? current.payment_intent : current.payment_intent?.id
      const intent = intentId ? await stripe.paymentIntents.retrieve(intentId) : null
      if (intent?.status === 'succeeded') {
        if (receipts.some((receipt) => receipt.sourceRef === `stripe:${intent.id}`)) continue
        await store.recordAdvancePayment({ requestId: request.id }, null, intent)
        throw new AdvancePaymentError('A payment has settled. Refresh the request before collecting another payment.')
      }
      if (!intent || ['processing', 'requires_action', 'requires_confirmation'].includes(intent.status)) throw new AdvancePaymentError('A bank payment is still in progress. Wait for its result before collecting more.')
    }
    if (current.status === 'open') {
      if (saved.cents === request.outstandingCents && saved.receivedCents === request.receivedCents) {
        const fresh = (await store.listAdvancePayments(client.id)).requests.find((row) => row.id === request.id)
        if (fresh && !fresh.canceledAt && fresh.outstandingCents === request.outstandingCents) return current.url
      }
      await stripe.checkout.sessions.expire(current.id)
    }
  }
  const metadata = { advancePaymentRequestId: request.id, clientId: client.id }
  const session = await stripe.checkout.sessions.create({ mode: 'payment', payment_method_types: ['us_bank_account'],
    ...(client.email ? { customer_email: client.email } : {}), metadata, payment_intent_data: { metadata, description: request.number },
    line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: request.outstandingCents, product_data: { name: `Advance payment ${request.number}` } } }],
    success_url: `${appUrl}/advance-payment-return?paid=1`, cancel_url: `${appUrl}/advance-payment-return?canceled=1`,
  }, { idempotencyKey: `advance-${request.id}-${request.receivedCents}-${prior}` })
  await ledger.append('session', `session:${session.id}`, client.id, { id: session.id, requestId: request.id, cents: request.outstandingCents, receivedCents: request.receivedCents })
  const fresh = (await store.listAdvancePayments(client.id)).requests.find((row) => row.id === request.id)
  if (!fresh || fresh.canceledAt || fresh.outstandingCents !== request.outstandingCents) {
    await stripe.checkout.sessions.expire(session.id)
    throw new AdvancePaymentError('The request changed while the link was created. Refresh before continuing.')
  }
  return session.url
}

export async function closeAdvanceSessions(store, requestId, stripe = stripeClient()) {
  if (!stripe) return
  const { sessions } = await store.listAdvancePayments()
  for (const saved of sessions.filter((row) => row.requestId === requestId)) {
    const session = await stripe.checkout.sessions.retrieve(saved.id)
    if (session.status === 'open') await stripe.checkout.sessions.expire(session.id)
  }
}

/**
 * `rateLimited(key, max)`: the pay link's own limiter and bucket (server.js),
 * so the public advance page is limited exactly like `/pay/<token>`: 30 opens
 * per source address, and 10 payment starts per link.
 */
export async function handleAdvancePaymentRoute({ request, response, pathname, url, store, requireSession, isCrossSiteOrigin, readJsonBody, sendJson, appUrl, rateLimited = () => false, clientIp = '' }) {
  const publicMatch = pathname.match(/^\/advance-pay\/([a-f0-9]{48})$/)
  if (publicMatch && ['GET', 'POST'].includes(request.method)) {
    if (rateLimited(`ip:${clientIp}`, 30) || (request.method === 'POST' && rateLimited(`advance-token:${publicMatch[1]}`, 10))) {
      response.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" })
      response.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Too many attempts</title><main style="max-width:40rem;margin:3rem auto;font:18px system-ui;padding:1rem"><h1>Too many attempts</h1><p>Please wait a few minutes and try the link again.</p></main></html>')
      return true
    }
    const offer = (await store.listAdvancePayments()).requests.find((row) => row.publicToken === publicMatch[1])
    if (!offer) { sendJson(response, 404, { error: 'Request not found.' }); return true }
    if (request.method === 'POST') {
      if (isCrossSiteOrigin(request)) { sendJson(response, 403, { error: 'Open the request page first.' }); return true }
      const collecting = !offer.canceledAt && offer.outstandingCents > 0 ? await advanceCollection(store, offer) : null
      if (collecting) { sendJson(response, 409, { error: publicCollected(collecting) }); return true }
      if (offer.collectionMethod !== 'bank') { sendJson(response, 409, { error: 'This request is collected outside the app.' }); return true }
      try {
        const client = await store.getClientById(offer.clientId)
        if (!client) throw new AdvancePaymentError('Contact the firm about this request.')
        const location = await advanceCheckout({ store, request: offer, client, appUrl })
        response.writeHead(303, { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); response.end()
      } catch (error) {
        // A race that found an invoice collecting it after the check above: the
        // owner's sentence names the invoice, so the public answer is generic.
        const message = error instanceof AdvanceCollectedElsewhereError ? PUBLIC_COLLECTED_GENERIC : error instanceof AdvancePaymentError ? error.message : 'Could not open bank payment. No new credit was recorded. Return to this page to check the request.'
        sendJson(response, error instanceof AdvancePaymentError ? 409 : 502, { error: message })
      }
      return true
    }
    const active = !offer.canceledAt && offer.outstandingCents > 0
    const collecting = active ? await advanceCollection(store, offer) : null
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" })
    response.end(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Pay in advance amount</title><main style="max-width:40rem;margin:3rem auto;font:18px system-ui;padding:1rem"><h1>Pay in advance amount</h1><p>${html(offer.number)}</p><p>Requested: ${money(offer.requestedCents)}</p><p>Received: ${money(offer.receivedCents)}</p><p>Still requested: ${money(offer.outstandingCents)}</p>${collecting ? `<p>${html(publicCollected(collecting))}</p><p>Only an actual received payment becomes credit toward future invoices.</p>` : `<p>This is separate from your current service invoice. Only an actual received payment becomes credit toward future invoices.</p>`}${collecting ? '' : active ? offer.collectionMethod === 'bank' ? '<form method="post"><button style="font:inherit;padding:.75rem" type="submit">Pay advance by bank</button></form><p>Bank payments can take several business days to settle. A payment already in progress must finish before another can be started.</p>' : '<p>Contact the firm to arrange this advance outside the app. Identify this request separately from any service-invoice payment.</p>' : '<p>No further payment is requested. Received funds remain in the account history; any refund or reversal is reconciled separately.</p>'}</main></html>`)
    return true
  }
  if (pathname === '/advance-payment-return' && request.method === 'GET') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" })
    response.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Advance payment</title><main style="max-width:40rem;margin:4rem auto;font:18px system-ui;padding:1rem"><h1>Advance payment</h1><p>If you submitted a bank payment, it may take several business days to settle. Credit appears after the funds arrive. If you canceled, no new payment was submitted. You can close this page.</p></main></html>')
    return true
  }
  if (!pathname.startsWith('/api/advance-payments')) return false
  const match = pathname.match(/^\/api\/advance-payments(?:\/([a-zA-Z0-9-]+)(?:\/(receipt|cancel|payment-link|pdf|hold|attach))?)?$/)
  if (!match) { sendJson(response, 404, { error: 'Not found' }); return true }
  const session = await requireSession(request, response)
  if (!session) return true
  if (session.user.role !== 'owner') { sendJson(response, 403, { error: 'Only owners can manage advance payments.' }); return true }
  if (!['GET', 'POST'].includes(request.method)) { sendJson(response, 405, { error: 'Method not allowed' }); return true }
  if (request.method === 'POST' && (isCrossSiteOrigin(request) || !String(request.headers['content-type'] ?? '').includes('application/json'))) {
    sendJson(response, 403, { error: 'A same-origin JSON request is required.' }); return true
  }
  try {
    const id = match[1], action = match[2]
    if (request.method === 'GET' && !id) {
      const clientId = url.searchParams.get('clientId')
      if (!clientId) throw new AdvancePaymentError('Choose a client.')
      // Which invoice already carries each request on its payment link, so the
      // attach list can say "already on invoice N".
      const carriedBy = {}
      for (const invoice of (await store.listInvoices()).filter((row) => row.clientId === clientId && !['paid', 'void'].includes(row.status))) {
        const offer = invoiceAdvanceOffer(invoice)
        if (offer && advanceOfferCollection(offer) === 'invoice') carriedBy[offer.requestId] = { invoiceId: invoice.id, number: invoice.number ?? invoice.id }
      }
      sendJson(response, 200, { ...await store.listAdvancePayments(clientId), carriedBy }); return true
    }
    const input = request.method === 'POST' ? await readJsonBody(request) : {}
    if (request.method === 'POST' && (action === 'attach' || id === 'detach')) {
      sendJson(response, 200, { invoice: await store.setInvoiceAdvanceOffer(input.invoiceId, id === 'detach' ? null : id, input.optional, session.user.id, appUrl, input.collection) }); return true
    }
    if (id === 'settings' && !action && request.method === 'POST') {
      sendJson(response, 200, { settings: await store.saveClientBillingDefaults(input, session.user.id) }); return true
    }
    if (!id && request.method === 'POST') {
      sendJson(response, 200, { request: await store.createAdvancePayment(input, session.user.id) }); return true
    }
    const found = (await store.listAdvancePayments()).requests.find((row) => row.id === id)
    if (!found) { sendJson(response, 404, { error: 'Request not found' }); return true }
    if (action === 'receipt' && request.method === 'POST') {
      if (!/^[a-zA-Z0-9-]{16,80}$/.test(input.id ?? '')) throw new AdvancePaymentError('A receipt identifier is required.')
      const receipt = await store.recordAdvancePayment({ requestId: id, sourceRef: `manual:${input.id}`, amount: input.amount, receivedOn: input.receivedOn, method: 'manual' }, session.user.id)
      let linkWarning = null
      try { await closeAdvanceSessions(store, id) } catch { linkWarning = 'Payment saved, but an older bank link could not be closed. Do not share that link again.' }
      try { await closeInvoiceAdvanceSessions(store, found) } catch { linkWarning = (linkWarning ? `${linkWarning} ` : '') + 'An invoice payment link that carried this advance could not be closed; it may still ask for the old advance amount until it expires.' }
      sendJson(response, 200, { receipt, linkWarning }); return true
    }
    if (action === 'cancel' && request.method === 'POST') {
      const canceled = await store.cancelAdvancePayment(id, session.user.id)
      let linkWarning = null
      try { await closeAdvanceSessions(store, id) } catch { linkWarning = 'Request canceled, but closing older bank links is unconfirmed. Retry cancellation to close them; a payment that arrives will still be credited.' }
      try { await closeInvoiceAdvanceSessions(store, found) } catch { linkWarning = (linkWarning ? `${linkWarning} ` : '') + 'An invoice payment link that carried this advance could not be closed; retry cancellation to close it.' }
      sendJson(response, 200, { request: canceled, linkWarning }); return true
    }
    if (action === 'hold' && request.method === 'POST') {
      const receipt = (await store.listAdvancePayments(found.clientId)).receipts.find((row) => row.requestId === id && row.sourceRef === input.sourceRef)
      if (!receipt) throw new AdvancePaymentError('Receipt not found on this request.')
      sendJson(response, 200, { reversal: await store.holdManualAdvanceReceipt(receipt.sourceRef, input.note, session.user.id, input.id) }); return true
    }
    const client = await store.getClientById(found.clientId)
    if (action === 'payment-link' && request.method === 'POST') {
      if (found.collectionMethod === 'manual') throw new AdvancePaymentError('This request is set for payment outside the app. Record its actual receipt; create a new request to change collection method.')
      sendJson(response, 200, { url: await advanceCheckout({ store, request: found, client, appUrl }) }); return true
    }
    if (action === 'pdf' && request.method === 'GET') {
      const { receipts } = await store.listAdvancePayments(found.clientId)
      const pdf = await advancePaymentPdf(found, client, receipts)
      response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${found.number}.pdf"`, 'Cache-Control': 'no-store' })
      response.end(pdf); return true
    }
    sendJson(response, 405, { error: 'Method not allowed' })
  } catch (error) {
    if (error instanceof AdvancePaymentError || error?.name === 'AccountCreditError') sendJson(response, 409, { error: 'advance_payment_refused', message: error.message })
    else { console.error('[advance payments] request failed:', error); sendJson(response, 500, { error: 'advance_payment_failed', message: 'The action could not be confirmed. Refresh, then retry with the same entries.' }) }
  }
  return true
}
