import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The PATCH route's glue for the hours panel's scope tags (featreq-8cec48db).
 *
 * WHAT THIS IS AND IS NOT — the same shape, and the same reason, as
 * `invoice-coverage-routes.test.ts`: `server.js` calls `server.listen()` at
 * module scope and exports nothing, so there is no HTTP harness here. The
 * DECISIONS all live in the store and are exercised properly, both backends, in
 * db/store-staleness.test.mjs. What is left over is the wiring, and one way it
 * rots silently: someone deletes the 409 branch, or moves it above the owner
 * gate, and every store-level test still passes.
 *
 * Treat a failure here as "the route changed, go look", not as a behavioral
 * regression.
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
)

const block = (() => {
  const at = serverSource.search(/const invoicePatchMatch = normalizedPath\.match\(/)
  expect(at, 'the invoice PATCH route was not found').toBeGreaterThan(-1)
  return serverSource.slice(at, at + 4500)
})()

describe('PATCH /api/invoices/:id and a refused scope re-tag', () => {
  it('answers 409 entry_tag_refused with the store’s own sentence', () => {
    expect(block).toContain('error instanceof EntryTagError')
    expect(block).toMatch(
      /sendJson\(response, 409, \{ error: 'entry_tag_refused', message: error\.message \}\)/,
    )
  })

  // The route takes the tags out of the same body as the lines, and hands the
  // WHOLE body to the store — which is what keeps them one write.
  it('passes the body straight through to updateInvoice', () => {
    expect(block).toContain('appDataStore.updateInvoice(invoiceId, payload ?? {}')
  })

  // Who may re-tag is not a question about the tags. The owner gate, the
  // same-origin check and the JSON check all stand in front of the store call,
  // so a staff session never reaches the branch above at all.
  it('gates on owner, origin and content type before anything is read', () => {
    const ownerAt = block.indexOf("sendJson(response, 403, { error: 'Only owners can edit invoices' })")
    const originAt = block.indexOf("sendJson(response, 403, { error: 'Origin not allowed' })")
    const jsonAt = block.indexOf("sendJson(response, 415, { error: 'application/json required' })")
    const storeAt = block.indexOf('appDataStore.updateInvoice')
    expect(ownerAt).toBeGreaterThan(-1)
    expect(ownerAt).toBeLessThan(storeAt)
    expect(originAt).toBeLessThan(storeAt)
    expect(jsonAt).toBeLessThan(storeAt)
  })

  // Four different 409s reach this catch now and only one is about a retainer;
  // the client keys on the CODE, so each has to keep its own.
  it('keeps the four refusals on four distinct codes', () => {
    for (const code of [
      'retainer_credit_refused',
      'coverage_unconfirmed',
      'invoice_locked',
      'entry_tag_refused',
    ]) {
      expect(block).toContain(`error: '${code}'`)
    }
  })

  it('imports the error class it branches on', () => {
    expect(serverSource).toMatch(/^\s*EntryTagError,$/m)
  })
})
