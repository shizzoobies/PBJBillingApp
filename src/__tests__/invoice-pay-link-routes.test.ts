import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The DURABLE pay link's glue — `GET /pay/:token`.
 *
 * SAME CAVEAT as invoice-coverage-routes.test.ts: `server.js` calls
 * `server.listen()` at module scope and exports nothing, so there is no HTTP
 * harness here. The store half (minting, lookup, the bulk-save guard) is
 * exercised properly on both backends in db/store-staleness.test.mjs. What can
 * rot HERE is the wiring, and every one of these assertions pins something whose
 * failure is silent and expensive:
 *
 *  - the route sits below the SPA fallback and every pay link answers 200 with
 *    the app shell — a client sees a sign-in screen and no explanation;
 *  - a `requireSession` creeps in and every client is locked out of paying;
 *  - a branch answers JSON and a client reads a raw error object;
 *  - the Checkout session is handed over BEFORE it is persisted, and the
 *    sibling-session expiry can never retire it — the invoice becomes payable
 *    twice;
 *  - the send route goes back to emailing a raw Stripe URL, which is dead in a
 *    day, which is the entire bug this feature exists to fix.
 *
 * These prove wiring, not behavior. Read a failure as "the route changed, go
 * look".
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
)

/**
 * The pay route's body, from its own match down to the route that follows it.
 * Bounded exactly rather than by a character count: half these assertions are
 * NEGATIVE ("no sendJson in here"), and a window that overshot into the next
 * route would quietly stop meaning anything.
 */
const payBlock = (() => {
  const start = serverSource.indexOf('const payLinkMatch = normalizedPath.match(')
  expect(start, 'the /pay/:token route is gone').toBeGreaterThan(-1)
  const end = serverSource.indexOf("if (normalizedPath === '/api/logout'", start)
  expect(end, 'the route that used to follow /pay/ is gone — re-anchor this').toBeGreaterThan(start)
  return serverSource.slice(start, end)
})()

describe('the pay link route is reachable at all', () => {
  it('matches /pay/<token> and /pay/<token>/card, on GET or HEAD only', () => {
    expect(payBlock).toContain('/^\\/pay\\/([^/]+)(\\/card)?$/')
    expect(payBlock).toContain("request.method === 'GET'")
    expect(payBlock).toContain("request.method === 'HEAD'")
  })

  // A matched pay path that is not a read answers 405 rather than falling
  // through to the SPA shell.
  it('answers 405 for anything but GET or HEAD', () => {
    expect(payBlock).toContain("request.method !== 'GET' && request.method !== 'HEAD'")
    expect(payBlock).toContain("Allow: 'GET, HEAD'")
    expect(payBlock).toContain('405')
  })

  /**
   * A HEAD IS NOT AN OPEN. Link checkers, mail scanners and preview fetches all
   * HEAD a URL in an email. Letting one through the mint would create a live
   * Checkout session, retire the one the client is holding, and file a
   * "Payment link opened" line claiming somebody read the invoice.
   */
  it('short-circuits HEAD before anything is minted or logged', () => {
    const head = payBlock.indexOf("if (request.method === 'HEAD')")
    expect(head).toBeGreaterThan(-1)
    expect(head).toBeLessThan(payBlock.indexOf('createInvoiceCardCheckoutSession'))
    expect(head).toBeLessThan(payBlock.indexOf('recordInvoicePayLinkOpened'))
    expect(head).toBeLessThan(payBlock.indexOf('customers.create'))
  })

  // A scanner that does GET without asking for HTML is not a client reading
  // their invoice, and the log line is evidence about a person.
  it('logs the open only for a request that asked for a page', () => {
    expect(payBlock).toContain("String(request.headers.accept || '').includes('text/html')")
    expect(payBlock).toContain('if (payWantsHtml) {')
  })

  /**
   * POSITION, twice over. `/api/*` 404s loudly and everything else falls
   * through to `sendFile(response, indexFile)` — a pay link answered by either
   * one is a client who cannot pay and cannot say why.
   */
  it('sits above the /api/ 404 and above the SPA fallback', () => {
    const at = serverSource.indexOf('const payLinkMatch = normalizedPath.match(')
    expect(at).toBeLessThan(serverSource.indexOf("if (normalizedPath.startsWith('/api/')) {"))
    expect(at).toBeLessThan(serverSource.indexOf('sendFile(response, indexFile)'))
  })

  // The payer is the client. They have no account here and never will.
  it('never asks for a session', () => {
    expect(payBlock).not.toContain('requireSession')
  })

  // Nobody is being signed in, and a cookie on a bearer-token URL is a way to
  // hand one client's session to whoever the link gets forwarded to.
  it('sets no cookie', () => {
    expect(payBlock).not.toContain('Set-Cookie')
  })
})

describe('every answer is a page, never JSON', () => {
  it('uses the page sender for all of them', () => {
    expect(payBlock).not.toContain('sendJson(')
    expect(payBlock).toContain('sendPayPage(')
  })

  it('the page sender is HTML, and carries the shared headers', () => {
    const at = serverSource.indexOf('function sendPayPage(')
    expect(at).toBeGreaterThan(-1)
    const fn = serverSource.slice(at, at + 400)
    expect(fn).toContain("'Content-Type': 'text/html; charset=utf-8'")
    expect(fn).toContain('...PAY_RESPONSE_HEADERS')
  })

  /**
   * ONE header object for every answer this route gives — the pages and both
   * redirects. The URL is bearer authorization, so `Referrer-Policy` is not a
   * nicety: without it the token travels to Stripe in a `Referer` header.
   */
  it('the shared headers say no-store, no frame, no sniff, no referrer', () => {
    const at = serverSource.indexOf('const PAY_RESPONSE_HEADERS = {')
    expect(at).toBeGreaterThan(-1)
    const headers = serverSource.slice(at, at + 260)
    expect(headers).toContain("'Cache-Control': 'no-store'")
    expect(headers).toContain("'X-Frame-Options': 'DENY'")
    expect(headers).toContain("'X-Content-Type-Options': 'nosniff'")
    expect(headers).toContain("'Referrer-Policy': 'no-referrer'")
  })

  // The answer changes the moment the invoice is paid, so a cached redirect is
  // a client sent to a stale Checkout session.
  it('both redirects carry those same headers', () => {
    const at = payBlock.lastIndexOf('response.writeHead(302')
    expect(at).toBeGreaterThan(-1)
    const redirect = payBlock.slice(at, at + 200)
    expect(redirect).toContain('...PAY_RESPONSE_HEADERS')
    expect(redirect).toContain('Location: payResult.session.url')
    // The stale-card-link bounce, higher up.
    expect(payBlock).toContain('Location: `/pay/${payToken}`, ...PAY_RESPONSE_HEADERS')
  })

  /**
   * ONE ROW, not the whole workspace. This route is public and reloadable by
   * anyone holding the link; it used to assemble every table in the app to find
   * a single client.
   */
  it('reads the one client it needs, not the whole workspace', () => {
    expect(payBlock).toContain('appDataStore.getClientById(payInvoice.clientId)')
    expect(payBlock).not.toContain('appDataStore.read()')
  })

  // The global handler answers JSON, which is the one thing a client must never
  // see here — so the route carries its own catch.
  it('has its own catch, and it renders a page', () => {
    expect(payBlock).toContain("console.error('[pay] pay link failed:'")
    const at = payBlock.indexOf("console.error('[pay] pay link failed:'")
    expect(payBlock.slice(at, at + 400)).toContain('sendPayPage(')
  })

  it('says nothing about the invoice but its number', () => {
    expect(payBlock).not.toContain('lineItems')
    expect(payBlock).not.toContain('payInvoice.total}')
  })
})

describe('each state the client can arrive in has its own sentence', () => {
  it('a draft or reviewed invoice reads as not sent yet', () => {
    expect(payBlock).toContain('This invoice has not been sent yet')
    // Fail closed: only these two statuses continue to a payment page.
    expect(payBlock).toContain("payInvoice.status !== 'sent' && payInvoice.status !== 'overdue'")
  })

  it('a voided invoice says it was withdrawn', () => {
    expect(payBlock).toContain("payInvoice.status === 'void'")
    expect(payBlock).toContain('This invoice was canceled')
  })

  it('a processing invoice explains the four business days', () => {
    expect(payBlock).toContain("payInvoice.status === 'processing'")
    expect(payBlock).toContain('A payment is already in progress')
  })

  it('a paid invoice thanks them rather than charging again', () => {
    expect(payBlock).toContain("payInvoice.status === 'paid'")
    expect(payBlock).toContain('Paid, thank you')
  })

  it('an invoice with nothing owed, and a Stripe that is not configured', () => {
    expect(payBlock).toContain('Nothing is owed')
    expect(payBlock).toContain('!isStripeConfigured()')
    expect(payBlock).toContain('Online payment is unavailable right now')
  })

  // A bad token and an unknown token are the SAME answer. Anything else tells
  // a stranger walking the token space which guesses were warm.
  it('a malformed token and an unknown one answer identically', () => {
    expect(payBlock.split('renderPayNotFoundPage()').length - 1).toBeGreaterThanOrEqual(2)
    expect(payBlock).toContain('/^[A-Za-z0-9_-]{20,64}$/')
  })
})

/**
 * THE RETURN TRIP. Stripe's success and cancel URLs both point back at this
 * same route, so without an explicit branch the return walks straight into a
 * fresh Checkout session — the payer who just paid is asked to pay again, and
 * the one who pressed "back to merchant" is bounced into the page they left.
 * The status branches cover it once the webhook has landed; these cover the
 * seconds before it does.
 */
describe('the page Stripe returns the payer to', () => {
  /**
   * It thanks them CONDITIONALLY. `?paid=1` is a marker on Stripe's success
   * URL, not proof money moved — anyone can arrive carrying it, and the invoice
   * is still `sent` here because the webhook has not landed. The old copy said
   * flatly "we have your payment", which is a receipt this page cannot back up.
   */
  it('thanks a payer whose webhook has not landed yet, without asserting payment', () => {
    expect(payBlock).toContain("requestUrl.searchParams.get('paid') === '1'")
    expect(payBlock).toContain('If you just finished checkout')
    expect(payBlock).toContain('will show Paid once it clears')
    expect(payBlock).not.toContain('Thank you — we have your payment')
    const at = payBlock.indexOf("requestUrl.searchParams.get('paid') === '1'")
    const mint = payBlock.indexOf('createInvoiceCardCheckoutSession')
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(mint)
  })

  it('tells a payer who backed out that nothing was charged, with a way back', () => {
    expect(payBlock).toContain("requestUrl.searchParams.get('cancelled') === '1'")
    expect(payBlock).toContain('Nothing was charged')
    expect(payBlock).toContain("label: 'Pay invoice'")
  })

  // A settled or withdrawn invoice gets its own sentence whatever the query
  // says — those branches sit above these two.
  it('lets the invoice status win over the query marker', () => {
    expect(payBlock.indexOf("payInvoice.status === 'paid'")).toBeLessThan(
      payBlock.indexOf("requestUrl.searchParams.get('paid')"),
    )
    expect(payBlock.indexOf("payInvoice.status === 'void'")).toBeLessThan(
      payBlock.indexOf("requestUrl.searchParams.get('cancelled')"),
    )
  })
})

describe('the limits', () => {
  it('counts by source address and, separately, by token', () => {
    expect(payBlock).toContain('isRateLimited(`ip:${getClientIp(request)}`')
    expect(payBlock).toContain('isRateLimited(`token:${payToken}`')
    expect(payBlock).toContain('bucket: payLinkAttempts')
  })

  // Sharing the sign-in bucket would let a client reloading a payment page
  // lock an owner out of requesting a sign-in link.
  it('keeps its own bucket, apart from the sign-in limiter', () => {
    expect(serverSource).toContain('const payLinkAttempts = new Map()')
    expect(serverSource).toMatch(/bucket = requestLinkAttempts/)
  })
})

/**
 * THE ORDER OF OPERATIONS, which is the one thing here that costs real money if
 * it rots. `resolveWebhookChannel` retires the sibling channel's session by
 * reading the ids STORED on the invoice: a session handed to a client before it
 * was written down survives the payment that made it redundant, and the invoice
 * can be paid a second time.
 */
describe('the session is persisted before anyone is sent to it', () => {
  it('writes the session id, then redirects', () => {
    const persist = payBlock.indexOf('swapInvoiceCheckoutSession(')
    const redirect = payBlock.lastIndexOf('response.writeHead(302')
    expect(persist).toBeGreaterThan(-1)
    expect(persist).toBeLessThan(redirect)
  })

  it('expires the superseded session only after the new id is safe', () => {
    const persist = payBlock.indexOf('swapInvoiceCheckoutSession(')
    const expire = payBlock.indexOf('expireCheckoutSession(')
    expect(expire).toBeGreaterThan(-1)
    expect(expire).toBeGreaterThan(persist)
  })

  /**
   * THE ID IT EXPIRES IS THE ONE THE WRITE REPLACED. `payInvoice` was read
   * before the mint: two opens a second apart both see S0 there, mint SA and
   * SB, both persist (last wins) and both expire S0 — leaving SA live, and the
   * invoice payable twice by two different Stripe sessions.
   */
  it('expires the value the swap returned, never an id read before the write', () => {
    expect(payBlock).toContain('paySwap.previous')
    expect(payBlock).toContain('await expireCheckoutSession(paySwap.previous)')
    // The pre-read snapshot must not be the source of the expiry any more.
    expect(payBlock).not.toContain('payInvoice.stripeCardSessionId')
    expect(payBlock).not.toContain('payInvoice.stripeCheckoutSessionId')
  })

  // Voided mid-flight: the store refuses, and the session is abandoned rather
  // than handed over.
  it('abandons the session when the store refuses the write', () => {
    expect(payBlock).toContain('if (!paySwap)')
  })

  it('writes only the session id — no status, no sent date', () => {
    const at = payBlock.indexOf('swapInvoiceCheckoutSession(')
    const call = payBlock.slice(at, at + 260)
    expect(call).toContain("channel: wantsCard ? 'card' : 'ach'")
    expect(call).toContain('sessionId: payResult.session.id')
    expect(call).not.toContain('status:')
    expect(call).not.toContain('sentAt')
    // `applyInvoicePayment` can append lines and move the status. The pay link
    // has no business doing either.
    expect(payBlock).not.toContain('applyInvoicePayment(')
  })
})

/**
 * THE CARD RETURN TRIP. Stripe sends the payer back to `returnTo`, and for a
 * card session that has to be the CARD path. Returned to `/pay/<token>` a payer
 * who presses "back to merchant" is handed the bank-transfer page's Pay button
 * — the retry silently changes how they are charged, and the grossed-up fee
 * line they agreed to disappears.
 */
describe('a card payer comes back to the card page', () => {
  it('the pay route hands Stripe the path the request came in on', () => {
    expect(payBlock).toContain("const payPath = `/pay/${payToken}${wantsCard ? '/card' : ''}`")
    expect(payBlock).toContain('returnTo: `${payAppUrl}${payPath}`')
    expect(payBlock).not.toContain('returnTo: `${payAppUrl}/pay/${payToken}`')
  })

  it('the send route gives the card session the /card return too', () => {
    const start = serverSource.indexOf('createInvoiceCardCheckoutSession({')
    expect(start).toBeGreaterThan(-1)
    const cardMint = serverSource.slice(start, start + 700)
    expect(cardMint).toContain('returnTo: `${payReturnTo}/card`')
  })
})

describe('the send route emails the durable link, not a Stripe URL', () => {
  const sendBlock = (() => {
    const start = serverSource.indexOf('This invoice is voided, so it cannot be sent.')
    expect(start).toBeGreaterThan(-1)
    // Bounded at the send itself rather than by a character count: everything
    // asserted below happens while the email is still being assembled.
    const end = serverSource.indexOf('await sendInvoiceEmail({', start)
    expect(end, 'the send call moved — re-anchor this').toBeGreaterThan(start)
    return serverSource.slice(start, end)
  })()

  it('mints the invoice token and builds /pay/<token> from it', () => {
    expect(sendBlock.replace(/\s+/g, ' ')).toContain(
      'appDataStore .getOrCreateInvoicePayToken(invoice.id)',
    )
    expect(sendBlock).toContain('payUrl = payToken ? `${sendAppUrl}/pay/${payToken}`')
  })

  // The old line. A send must never go back to emailing a URL that dies in a
  // day — that is the whole bug.
  it('no longer assigns the raw Checkout URL unconditionally', () => {
    expect(sendBlock).not.toContain('payUrl = linkResult.session.url')
  })

  it('the card button gets the /card path, under the same card-enabled guard', () => {
    expect(sendBlock).toContain('sendClient.cardPaymentsEnabled')
    expect(sendBlock).toContain('`${sendAppUrl}/pay/${payToken}/card`')
  })

  // A durability upgrade must never be able to fail a send. Without a token the
  // email carries what it always carried — and a mint that THROWS has to land
  // in the same place, which an unguarded await does not.
  it('falls back to the Stripe URL when no token could be minted', () => {
    expect(sendBlock).toContain(': linkResult.session.url')
    expect(sendBlock).toContain(': cardResult.session.url')
    expect(sendBlock.replace(/\s+/g, ' ')).toContain(
      '.getOrCreateInvoicePayToken(invoice.id) .catch(() => null)',
    )
  })

  // The same race the pay route had: `invoice` was read before the mint, so the
  // session id on it can already be stale — a send racing a pay-link click
  // would expire an id that is no longer current and leave the other live.
  it('expires the id each write replaced, on both channels', () => {
    expect(sendBlock).toContain('swapInvoiceCheckoutSession(invoice.id, {')
    expect(sendBlock).toContain('expireCheckoutSession(sendSwap.previous)')
    expect(sendBlock).toContain('expireCheckoutSession(cardSwap.previous)')
    expect(sendBlock).not.toContain('expireCheckoutSession(invoice.stripeCheckoutSessionId)')
    expect(sendBlock).not.toContain('expireCheckoutSession(invoice.stripeCardSessionId)')
  })

  // Stripe sends the payer back to the PUBLIC page, not to the app they cannot
  // sign into.
  // The bank-transfer session returns to the plain path; the card session's
  // return trip is pinned in "a card payer comes back to the card page" below.
  it('points Stripe back at the pay page', () => {
    expect(sendBlock).toContain('returnTo: payReturnTo')
    expect(sendBlock).toContain('const payReturnTo = payToken ? `${sendAppUrl}/pay/${payToken}`')
    expect(payBlock).toContain('returnTo: `${payAppUrl}${payPath}`')
  })
})

describe('the Payment link button hands back the durable link too', () => {
  const block = (() => {
    const start = serverSource.indexOf('const invoicePaymentLinkMatch = normalizedPath.match(')
    expect(start).toBeGreaterThan(-1)
    // Bounded on the route that follows, not by a character count — a window
    // that fell short of the end would quietly stop asserting anything.
    const end = serverSource.indexOf('// POST /api/invoices/:id/mark-paid', start)
    expect(end, 'the route that used to follow the payment link is gone').toBeGreaterThan(start)
    return serverSource.slice(start, end)
  })()

  it('returns /pay/<token>, with the Stripe URL only as a fallback', () => {
    expect(block).toContain('getOrCreateInvoicePayToken(invoice.id)')
    expect(block).toContain('/pay/${linkPayToken}')
    expect(block).toContain(': result.session.url')
    // A token that cannot be minted is a missed upgrade, never a 500 on a
    // button whose Stripe session already exists.
    expect(block.replace(/\s+/g, ' ')).toContain(
      '.getOrCreateInvoicePayToken(invoice.id) .catch(() => null)',
    )
  })

  // The mint, the persist and the expiry are unchanged — a Stripe refusal is
  // still what stops the button — but the id it retires now comes from the
  // write, not from the snapshot it read before talking to Stripe.
  it('still mints, persists and expires, off the value the write replaced', () => {
    expect(block).toContain('createInvoiceCheckoutSession(')
    expect(block).toContain('applyInvoicePayment(')
    expect(block).toContain('swapInvoiceCheckoutSession(invoice.id, {')
    expect(block).toContain('expireCheckoutSession(linkSwap.previous)')
    expect(block).not.toContain('expireCheckoutSession(invoice.stripeCheckoutSessionId)')
  })
})
