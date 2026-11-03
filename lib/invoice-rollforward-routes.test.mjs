import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Push to next month (featreq-40697310) - the server's wiring.
 *
 * `server.js` listens at module scope and exports nothing, so there is no HTTP
 * harness: these pin the wiring by reading the source, the same convention as
 * the other invoice route tests. The RULES are exercised for real in
 * lib/invoice-rollforward.test.mjs and db/store-staleness.test.mjs (both backends).
 */

const source = readFileSync('server.js', 'utf8')

const rollRoute = () => {
  const start = source.indexOf('const rollForwardMatch = normalizedPath.match(')
  expect(start, 'the push route is gone').toBeGreaterThan(-1)
  const end = source.indexOf('const accountCreditLineMatch = normalizedPath.match(', start)
  expect(end, 'the next route moved').toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('POST /api/invoices/:id/roll-forward and /undo-roll-forward', () => {
  it('matches both paths, POST only', () => {
    const route = rollRoute()
    expect(route).toContain('(roll-forward|undo-roll-forward)')
    expect(route).toContain("request.method === 'POST'")
  })

  it('is owner only, refuses a cross-site origin and a non-JSON body', () => {
    const route = rollRoute()
    expect(route).toContain("session.user.role !== 'owner'")
    expect(route).toContain('isCrossSiteOrigin(request)')
    expect(route).toContain('sendJson(response, 415')
  })

  it('takes the actor from the session and calls the store method for each path', () => {
    const route = rollRoute()
    expect(route).toContain('actorId: session.user.id')
    expect(route).toContain('appDataStore.undoInvoiceRollForward(rollInvoiceId, rollOptions)')
    expect(route).toContain('appDataStore.rollInvoiceForward(rollInvoiceId, rollOptions)')
  })

  it('answers a refusal as 409 with its code and sentence, a moved invoice as invoice_changed, a missing one as 404', () => {
    const route = rollRoute()
    expect(route).toContain('error instanceof InvoiceRollForwardError')
    expect(route).toContain('sendJson(response, 409, { error: error.code, message: error.message })')
    expect(route).toContain("error: 'invoice_changed'")
    expect(route).toContain('sendJson(response, 404')
  })

  it('closes payment pages like a void, logs the activity, and broadcasts the change', () => {
    const route = rollRoute()
    expect(route).toContain('expireInvoiceSessions(')
    expect(route).toContain("'invoice_rolled_forward'")
    expect(route).toContain("'invoice_roll_forward_undone'")
    expect(route).toContain('broadcastDataChanged()')
  })

  it('imports the refusal class from the store', () => {
    expect(source.slice(0, 3000)).toContain('InvoiceRollForwardError,')
  })
})

describe('the month list and Generate', () => {
  it('marks the month list with what can be pushed and undone, failing soft', () => {
    const start = source.indexOf("if (normalizedPath === '/api/invoices' && request.method === 'GET')")
    expect(start).toBeGreaterThan(-1)
    const route = source.slice(start, start + 5000)
    const mark = route.indexOf('marked = await appDataStore.withRollForwardState(marked)')
    expect(mark).toBeGreaterThan(-1)
    expect(route.slice(mark - 40, mark + 300)).toContain('catch (error)')
  })

  it('Generate and Void & regenerate pass the actor and the public address (for a re-attached advance)', () => {
    const generate = source.slice(source.indexOf("normalizedPath === '/api/invoices/generate'"))
    expect(generate.slice(0, 2500)).toContain('actorUserId: session.user.id')
    expect(generate.slice(0, 2500)).toContain('appUrl: getPublicAppUrl(request)')
    const regenerate = source.slice(source.indexOf("normalizedPath === '/api/invoices/regenerate'"))
    const rebuild = regenerate.indexOf('rebuilt = await appDataStore.generateInvoicesForPeriod(regenPeriod, {')
    expect(rebuild).toBeGreaterThan(-1)
    expect(regenerate.slice(rebuild, rebuild + 200)).toContain('actorUserId: session.user.id')
    expect(regenerate).toContain('carried: rebuilt.carried ?? []')
  })
})
