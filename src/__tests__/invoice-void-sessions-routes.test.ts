import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

/**
 * Voiding an invoice closes the client's open payment pages, as Mark paid does
 * (featreq-61347136), and a save that races a payment answers 409.
 *
 * SAME CAVEAT as invoice-coverage-routes.test.ts: `server.js` is not booted by
 * tests, so this reads its source. The store halves (the guarded write, the
 * sessions the regenerate pass hands back) are exercised on both backends in
 * db/store-staleness.test.mjs. What can rot HERE is the wiring: a void path that
 * stops expiring, an expire that moves BEFORE the commit it follows, or a throw
 * from Stripe that turns a committed void into a 500.
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
)

/** From a route's own anchor to the next anchor — bounded exactly, not by length. */
function sliceBetween(from: string, to: string) {
  const start = serverSource.indexOf(from)
  expect(start, `${from} is gone from server.js`).toBeGreaterThan(-1)
  const end = serverSource.indexOf(to, start + from.length)
  expect(end, `${to} no longer follows ${from}`).toBeGreaterThan(start)
  return serverSource.slice(start, end)
}

const helperRegion = sliceBetween(
  'async function expireInvoiceSessions(',
  'async function loadRateVersions(',
)
// Just the function: its closing brace is the first one at column 0.
const helperEnd = /\r?\n\}/.exec(helperRegion)!
const helperSource = helperRegion.slice(0, helperEnd.index + helperEnd[0].length)
const markPaidBlock = sliceBetween(
  'const markPaidMatch = normalizedPath.match(',
  '// POST /api/invoices/verify-all-payments',
)
const patchBlock = sliceBetween(
  'const invoicePatchMatch = normalizedPath.match(',
  '// POST /api/invoices/:id/confirm-coverage',
)
const regenerateBlock = sliceBetween(
  "if (normalizedPath === '/api/invoices/regenerate' && request.method === 'POST') {",
  "if (normalizedPath === '/api/clients' && request.method === 'POST') {",
)

describe('the one helper that closes an invoice\'s payment pages', () => {
  it('expires each id in its own try/catch and never throws', () => {
    expect(helperSource).toContain('for (const sessionId of sessionIds)')
    expect(helperSource).toContain('await expireCheckoutSession(sessionId)')
    expect(helperSource).toContain('catch (error)')
    expect(helperSource).not.toContain('throw')
  })

  // Run the real source with a stub for Stripe: a thrown expire is logged, the
  // next session is still expired, and nothing comes back out as a rejection.
  async function runHelper(expire: (id: string) => Promise<unknown>) {
    const errors: unknown[][] = []
    const make = new Function(
      'expireCheckoutSession',
      'console',
      `${helperSource}\nreturn expireInvoiceSessions`,
    )
    const helper = make(expire, { error: (...args: unknown[]) => errors.push(args) })
    return { helper, errors }
  }

  it('keeps going after a failed expire and logs the label, the session and the invoice', async () => {
    const expire = vi.fn(async (id: string) => {
      if (id === 'cs_ach') throw new Error('stripe is down')
      return true
    })
    const { helper, errors } = await runHelper(expire)

    await expect(helper(['cs_ach', null, 'cs_card'], 'inv-1', 'void')).resolves.toBeUndefined()

    expect(expire.mock.calls.map(([id]) => id)).toEqual(['cs_ach', 'cs_card'])
    expect(errors).toHaveLength(1)
    expect(errors[0][0]).toBe(
      '[invoices] void: could not expire checkout session cs_ach for inv-1 — a live pay link may remain:',
    )
  })

  // `expireCheckoutSession` does not throw when Stripe refuses: it answers `false`.
  // The labeled log line used to be reachable only through a throw, so a refused
  // expiry was silent.
  it('logs the label, the session and the invoice when Stripe answers false, and keeps going', async () => {
    const expire = vi.fn(async (id: string) => id !== 'cs_ach')
    const { helper, errors } = await runHelper(expire)

    await expect(helper(['cs_ach', 'cs_card'], 'inv-1', 'edit (total changed)')).resolves.toBeUndefined()

    expect(expire.mock.calls.map(([id]) => id)).toEqual(['cs_ach', 'cs_card'])
    expect(errors).toHaveLength(1)
    expect(errors[0][0]).toContain('[invoices] edit (total changed): could not expire checkout session cs_ach for inv-1')
    expect(errors[0][0]).toContain('a live pay link may remain')
  })

  it('logs nothing when every expiry is confirmed', async () => {
    const { helper, errors } = await runHelper(vi.fn(async () => true))

    await helper(['cs_ach', 'cs_card'], 'inv-1', 'void')

    expect(errors).toEqual([])
  })

  it('skips ids that are not there', async () => {
    const expire = vi.fn(async () => true)
    const { helper } = await runHelper(expire)
    await helper([null, undefined, ''], 'inv-1', 'void')
    expect(expire).not.toHaveBeenCalled()
  })
})

describe('mark-paid keeps its behavior through the shared helper', () => {
  it('expires both sessions through the helper, after the store call, before answering', () => {
    const store = markPaidBlock.indexOf('markInvoicePaidManually(')
    const expire = markPaidBlock.indexOf('await expireInvoiceSessions(')
    const answer = markPaidBlock.indexOf('sendJson(response, 200, { invoice: updated })')
    expect(store).toBeGreaterThan(-1)
    expect(expire).toBeGreaterThan(store)
    expect(answer).toBeGreaterThan(expire)
    const call = markPaidBlock.slice(expire, answer)
    expect(call).toContain('updated.stripeCheckoutSessionId')
    expect(call).toContain('updated.stripeCardSessionId')
    expect(call).toContain("'mark-paid'")
    // No second copy of the loop.
    expect(markPaidBlock).not.toContain('expireCheckoutSession(')
  })
})

describe('the invoice PATCH route closes the payment pages of a void', () => {
  it('expires after the store call and after the 404 guard, only when the save came back void and asked for void', () => {
    const store = patchBlock.indexOf('appDataStore.updateInvoice(')
    const notFound = patchBlock.indexOf("sendJson(response, 404, { error: 'Invoice not found' })")
    const gate = patchBlock.indexOf("updated.status === 'void' && payload?.status === 'void'")
    const expire = patchBlock.indexOf('await expireInvoiceSessions(')
    const answer = patchBlock.indexOf('sendJson(response, 200, { invoice: await withCoverageChangeable(updated) })')
    expect(store).toBeGreaterThan(-1)
    expect(notFound).toBeGreaterThan(store)
    expect(gate).toBeGreaterThan(notFound)
    expect(expire).toBeGreaterThan(gate)
    expect(answer).toBeGreaterThan(expire)
    const call = patchBlock.slice(expire, answer)
    expect(call).toContain('updated.stripeCheckoutSessionId')
    expect(call).toContain('updated.stripeCardSessionId')
    expect(call).toContain("'void'")
    expect(patchBlock).not.toContain('expireCheckoutSession(')
  })

  it('answers a save that raced a payment with 409 invoice_changed, before the catch-all 500', () => {
    const at = patchBlock.indexOf('error instanceof InvoiceChangedError')
    expect(at).toBeGreaterThan(-1)
    const branch = patchBlock.slice(at, at + 260)
    expect(branch).toContain('409')
    expect(branch).toContain("error: 'invoice_changed'")
    expect(branch).toContain('message: error.message')
    expect(at).toBeLessThan(patchBlock.indexOf("error: 'invoice_update_failed'"))
  })

  it('imports the error class it branches on', () => {
    expect(serverSource).toMatch(
      /import \{[\s\S]*?InvoiceChangedError,[\s\S]*?\} from '\.\/db\/store\.js'/,
    )
  })
})

describe('Void & regenerate closes the payment pages of the drafts it voided', () => {
  it('expires what the store hands back, right after the void commits and before the rebuild', () => {
    const voided = regenerateBlock.indexOf('appDataStore.voidUnsentInvoicesForPeriod(')
    const expire = regenerateBlock.indexOf('for (const { invoiceId, sessionId } of voided.sessions')
    const rebuild = regenerateBlock.indexOf('appDataStore.generateInvoicesForPeriod(')
    expect(voided).toBeGreaterThan(-1)
    expect(expire).toBeGreaterThan(voided)
    expect(rebuild).toBeGreaterThan(expire)
    // Sequential, one session at a time, each named by its own invoice.
    const call = regenerateBlock.slice(expire, rebuild)
    expect(call).toContain('await expireInvoiceSessions([sessionId], invoiceId, \'regenerate\')')
    expect(regenerateBlock).not.toContain('expireCheckoutSession(')
  })
})

/**
 * THE LIST OF VOID PATHS. An invoice becomes `void` only through
 * `updateInvoice` (the PATCH route) and `voidUnsentInvoicesForPeriod` (Void &
 * regenerate). Each is called from exactly one route, and both routes expire.
 * A third caller is a new void path: it fails here until it expires too.
 */
describe('every route that can void an invoice expires its sessions', () => {
  it('has exactly one caller of each store method that voids', () => {
    expect(serverSource.match(/appDataStore\.updateInvoice\(/g)).toHaveLength(1)
    expect(serverSource.match(/appDataStore\.voidUnsentInvoicesForPeriod\(/g)).toHaveLength(1)
  })

  it('has no other writer of the void status in the server', () => {
    expect(serverSource).not.toMatch(/status:\s*'void'/)
    expect(serverSource).not.toMatch(/status\s*=\s*'void'/)
  })
})
