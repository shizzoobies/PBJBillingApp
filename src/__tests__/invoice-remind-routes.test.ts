import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * `POST /api/invoices/:id/remind` - "Send reminder" (featreq-3f1d63b6).
 *
 * `server.js` listens at module scope and exports nothing, so the route's
 * WIRING is pinned by reading it (the convention of the send-route tests). The
 * behavior - every refusal, the same token, the log entry, the last look, the
 * failed provider send - is exercised for real in lib/invoice-reminder.test.mjs
 * (Stripe mocked to fail on any call) and end to end on the file backend in
 * db/store-staleness.test.mjs.
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
)

function between(from: string, to: string) {
  const start = serverSource.indexOf(from)
  expect(start, `${from} is gone from server.js`).toBeGreaterThan(-1)
  const end = serverSource.indexOf(to, start + from.length)
  expect(end, `${to} no longer follows ${from}`).toBeGreaterThan(start)
  return serverSource.slice(start, end)
}

const route = () =>
  between('const invoiceRemindMatch = normalizedPath.match(', '// POST /api/invoices/retainer')

describe('POST /api/invoices/:id/remind', () => {
  it('matches only the remind path, on POST', () => {
    expect(route()).toContain("normalizedPath.match(/^\\/api\\/invoices\\/([^/]+)\\/remind$/)")
    expect(route()).toContain("if (invoiceRemindMatch && request.method === 'POST')")
  })

  it('is owner-only, same-origin and JSON, in that order, before anything is read', () => {
    const body = route()
    const owner = body.indexOf("session.user.role !== 'owner'")
    const forbidden = body.indexOf("sendJson(response, 403, { error: 'Only owners can send a reminder' })")
    const origin = body.indexOf('isCrossSiteOrigin(request)')
    const json = body.indexOf("sendJson(response, 415, { error: 'application/json required' })")
    const work = body.indexOf('remindInvoice(')
    expect(owner).toBeGreaterThan(-1)
    expect(forbidden).toBeGreaterThan(owner)
    expect(origin).toBeGreaterThan(forbidden)
    expect(json).toBeGreaterThan(origin)
    expect(work).toBeGreaterThan(json)
  })

  it('hands the shared function the store and the SAME provider call Send uses', () => {
    const body = route()
    expect(body).toContain('{ store: appDataStore, sendEmail: sendInvoiceEmail }')
    expect(body).toContain('appUrl: getPublicAppUrl(request)')
    expect(body).toContain('stripeConfigured: isStripeConfigured()')
    expect(body).toContain('userId: session.user.id')
  })

  it('never touches Stripe, a checkout session or the send stamp itself', () => {
    const body = route()
    for (const forbidden of [
      'createInvoiceCheckoutSession',
      'createInvoiceCardCheckoutSession',
      'ensureStripeCustomer',
      'swapInvoiceCheckoutSession',
      'expireCheckoutSession',
      'expireInvoiceSessions',
      'stripeClient',
      'recordInvoiceSent',
      'planAutopaySend',
      'chargeAfterSend',
    ]) {
      expect(body, `${forbidden} must not be in the remind route`).not.toContain(forbidden)
    }
  })

  it('answers a refusal as the function said it, and the reminded invoice with the editor marks', () => {
    const body = route()
    expect(body).toContain('sendJson(response, reminded.status, reminded.body)')
    const ok = body.indexOf('sendJson(response, 200, {')
    expect(ok).toBeGreaterThan(-1)
    const answer = body.slice(ok, ok + 160)
    // `logged: false` (emailed, but the log write failed twice) rides through.
    expect(answer).toContain('...reminded.body,')
    expect(answer).toContain('invoice: await withCoverageChangeable(reminded.body.invoice),')
  })

  it('answers a failed read with a sentence that says nothing was emailed', () => {
    const body = route()
    expect(body).toContain("error: 'reminder_failed'")
    expect(body).toContain('Nothing was emailed.')
  })

  it('sits above the /api/ catch-all', () => {
    const guard = serverSource.indexOf("if (normalizedPath.startsWith('/api/')) {")
    expect(guard).toBeGreaterThan(-1)
    expect(serverSource.indexOf('const invoiceRemindMatch')).toBeLessThan(guard)
  })

  it('is imported from the shared module', () => {
    expect(serverSource).toContain("import { remindInvoice } from './lib/invoice-reminder.js'")
  })
})
