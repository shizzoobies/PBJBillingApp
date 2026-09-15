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

  it('the page sender is HTML, uncached and unframable', () => {
    const at = serverSource.indexOf('function sendPayPage(')
    expect(at).toBeGreaterThan(-1)
    const fn = serverSource.slice(at, at + 400)
    expect(fn).toContain("'Content-Type': 'text/html; charset=utf-8'")
    expect(fn).toContain("'Cache-Control': 'no-store'")
    expect(fn).toContain("'X-Frame-Options': 'DENY'")
  })

  // The answer changes the moment the invoice is paid, so a cached redirect is
  // a client sent to a stale Checkout session.
  it('the redirect is never cached and leaks no referrer', () => {
    const at = payBlock.lastIndexOf('response.writeHead(302')
    expect(at).toBeGreaterThan(-1)
    const redirect = payBlock.slice(at, at + 260)
    expect(redirect).toContain("'Cache-Control': 'no-store'")
    expect(redirect).toContain("'Referrer-Policy': 'no-referrer'")
    expect(redirect).toContain('Location: payResult.session.url')
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
  it('thanks a payer whose webhook has not landed yet, and mints nothing', () => {
    expect(payBlock).toContain("requestUrl.searchParams.get('paid') === '1'")
    expect(payBlock).toContain('Thank you — we have your payment')
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
    const persist = payBlock.indexOf('applyInvoicePayment(')
    const redirect = payBlock.lastIndexOf('response.writeHead(302')
    expect(persist).toBeGreaterThan(-1)
    expect(persist).toBeLessThan(redirect)
  })

  it('expires the superseded session only after the new id is safe', () => {
    const persist = payBlock.indexOf('applyInvoicePayment(')
    const expire = payBlock.indexOf('expireCheckoutSession(')
    expect(expire).toBeGreaterThan(-1)
    expect(expire).toBeGreaterThan(persist)
  })

  // Voided mid-flight: the store refuses, and the session is abandoned rather
  // than handed over.
  it('abandons the session when the store refuses the write', () => {
    expect(payBlock).toContain('if (!payUpdated)')
  })

  it('writes only the session id — no status, no sent date', () => {
    const at = payBlock.indexOf('applyInvoicePayment(')
    const call = payBlock.slice(at, at + 300)
    expect(call).toContain('cardCheckoutSessionId')
    expect(call).toContain('checkoutSessionId')
    expect(call).not.toContain('status:')
    expect(call).not.toContain('sentAt')
  })
})

describe('the send route emails the durable link, not a Stripe URL', () => {
  const sendBlock = (() => {
    const start = serverSource.indexOf('This invoice is voided, so it cannot be sent.')
    expect(start).toBeGreaterThan(-1)
    return serverSource.slice(start, start + 9000)
  })()

  it('mints the invoice token and builds /pay/<token> from it', () => {
    expect(sendBlock).toContain('appDataStore.getOrCreateInvoicePayToken(invoice.id)')
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
  // email carries what it always carried.
  it('falls back to the Stripe URL when no token could be minted', () => {
    expect(sendBlock).toContain(': linkResult.session.url')
    expect(sendBlock).toContain(': cardResult.session.url')
  })

  // Stripe sends the payer back to the PUBLIC page, not to the app they cannot
  // sign into.
  it('points Stripe back at the pay page', () => {
    expect(sendBlock).toContain('returnTo: payReturnTo')
    expect(payBlock).toContain('returnTo: `${payAppUrl}/pay/${payToken}`')
  })
})

describe('the Payment link button hands back the durable link too', () => {
  const block = (() => {
    const start = serverSource.indexOf('const invoicePaymentLinkMatch = normalizedPath.match(')
    expect(start).toBeGreaterThan(-1)
    return serverSource.slice(start, start + 5200)
  })()

  it('returns /pay/<token>, with the Stripe URL only as a fallback', () => {
    expect(block).toContain('getOrCreateInvoicePayToken(invoice.id)')
    expect(block).toContain('/pay/${linkPayToken}')
    expect(block).toContain(': result.session.url')
  })

  // The mint, the persist and the expiry are unchanged — a Stripe refusal is
  // still what stops the button.
  it('still mints, persists and expires exactly as before', () => {
    expect(block).toContain('createInvoiceCheckoutSession(')
    expect(block).toContain('applyInvoicePayment(')
    expect(block).toContain('expireCheckoutSession(')
  })
})
