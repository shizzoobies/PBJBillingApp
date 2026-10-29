import PDFDocument from 'pdfkit'
import { AdvancePaymentError } from './advance-payments.js'
import { stripeClient } from './stripe-rail.js'

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
  if (!stripe) throw new AdvancePaymentError('Stripe is not configured. Record an actual bank or check payment after it arrives.')
  if (request.canceledAt || request.outstandingCents <= 0) throw new AdvancePaymentError('This request has no amount left to collect.')
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

export async function handleAdvancePaymentRoute({ request, response, pathname, url, store, requireSession, isCrossSiteOrigin, readJsonBody, sendJson, appUrl }) {
  const publicMatch = pathname.match(/^\/advance-pay\/([a-f0-9]{48})$/)
  if (publicMatch && ['GET', 'POST'].includes(request.method)) {
    const offer = (await store.listAdvancePayments()).requests.find((row) => row.publicToken === publicMatch[1])
    if (!offer) { sendJson(response, 404, { error: 'Request not found.' }); return true }
    if (request.method === 'POST') {
      if (isCrossSiteOrigin(request)) { sendJson(response, 403, { error: 'Open the request page first.' }); return true }
      if (offer.collectionMethod !== 'bank') { sendJson(response, 409, { error: 'This request is collected outside the app.' }); return true }
      try {
        const client = await store.getClientById(offer.clientId)
        if (!client) throw new AdvancePaymentError('Contact the firm about this request.')
        const location = await advanceCheckout({ store, request: offer, client, appUrl })
        response.writeHead(303, { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); response.end()
      } catch (error) { sendJson(response, error instanceof AdvancePaymentError ? 409 : 502, { error: error instanceof AdvancePaymentError ? error.message : 'Could not open bank payment. No new credit was recorded. Return to this page to check the request.' }) }
      return true
    }
    const active = !offer.canceledAt && offer.outstandingCents > 0
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" })
    response.end(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Pay in advance amount</title><main style="max-width:40rem;margin:3rem auto;font:18px system-ui;padding:1rem"><h1>Pay in advance amount</h1><p>${html(offer.number)}</p><p>Requested: ${money(offer.requestedCents)}</p><p>Received: ${money(offer.receivedCents)}</p><p>Still requested: ${money(offer.outstandingCents)}</p><p>This is separate from your current service invoice. Only an actual received payment becomes credit toward future invoices.</p>${active ? offer.collectionMethod === 'bank' ? '<form method="post"><button style="font:inherit;padding:.75rem" type="submit">Pay advance by bank</button></form><p>Bank payments can take several business days to settle. A payment already in progress must finish before another can be started.</p>' : '<p>Contact the firm to arrange this advance outside the app. Identify this request separately from any service-invoice payment.</p>' : '<p>No further payment is requested. Received funds remain in the account history; any refund or reversal is reconciled separately.</p>'}</main></html>`)
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
      sendJson(response, 200, await store.listAdvancePayments(clientId)); return true
    }
    const input = request.method === 'POST' ? await readJsonBody(request) : {}
    if (request.method === 'POST' && (action === 'attach' || id === 'detach')) {
      sendJson(response, 200, { invoice: await store.setInvoiceAdvanceOffer(input.invoiceId, id === 'detach' ? null : id, input.optional, session.user.id, appUrl) }); return true
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
      sendJson(response, 200, { receipt, linkWarning }); return true
    }
    if (action === 'cancel' && request.method === 'POST') {
      const canceled = await store.cancelAdvancePayment(id, session.user.id)
      let linkWarning = null
      try { await closeAdvanceSessions(store, id) } catch { linkWarning = 'Request canceled, but closing older bank links is unconfirmed. Retry cancellation to close them; a payment that arrives will still be credited.' }
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
