import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The credit-on-account LINE routes (featreq-110efd15, stage 1b), pinned the way
 * the stage 1a routes are: server.js listens at module scope and exports
 * nothing, so this reads the source. The store halves (sizing, the lock, the
 * status and sub refusals) have real tests in db/store-staleness.test.mjs; what
 * is pinned HERE is the gates, the order they run in, how a refusal is answered
 * and that the PATCH shares the same answers.
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

const lineBlock = sliceBetween(
  'const accountCreditLineMatch = normalizedPath.match(',
  '// POST /api/invoices/:id/confirm-coverage',
)
const refusals = sliceBetween('function sendCreditLineRefusal(', 'async function withCoverageChangeable(')
const patchBlock = sliceBetween(
  "const invoicePatchMatch = normalizedPath.match(/^\\/api\\/invoices\\/([^/]+)$/)",
  '// POST /api/invoices/:id/apply-account-credit',
)

describe('POST /api/invoices/:id/apply-account-credit and /remove-account-credit', () => {
  it('are two routes on one match: apply and remove, POST only', () => {
    const text = squash(lineBlock)
    expect(text).toContain('/^\\/api\\/invoices\\/([^/]+)\\/(apply|remove)-account-credit$/')
    expect(text).toContain("request.method === 'POST'")
    expect(text).toContain("accountCreditLineMatch[2] === 'apply'")
  })

  it('are owner-only, same-origin and JSON, in that order, before the store is asked', () => {
    const owner = lineBlock.indexOf("session.user.role !== 'owner'")
    const origin = lineBlock.indexOf('isCrossSiteOrigin(request)')
    const type = lineBlock.indexOf('application/json')
    const store = lineBlock.indexOf('applyAccountCreditToInvoice')
    expect(owner).toBeGreaterThan(-1)
    expect(owner).toBeLessThan(origin)
    expect(origin).toBeLessThan(type)
    expect(type).toBeLessThan(store)
    expect(lineBlock).toContain('sendJson(response, 403')
    expect(lineBlock).toContain('sendJson(response, 415')
    // A teammate is sent the sentence, not a quiet empty answer.
    expect(squash(lineBlock)).toContain("'Only owners can change credit on account'")
  })

  it('applies and removes through the two store methods, with the actor from the SESSION', () => {
    const text = squash(lineBlock)
    expect(text).toContain('appDataStore.applyAccountCreditToInvoice(creditLineInvoiceId, { actorUserId: session.user.id')
    expect(text).toContain('appDataStore.removeAccountCreditFromInvoice(creditLineInvoiceId, { actorUserId: session.user.id')
    // Neither names a credit or an amount from the body: the server decides both.
    expect(lineBlock).not.toContain('readJsonBody')
    expect(lineBlock).not.toMatch(/payload|request\.body/)
  })

  it('answers a refusal as a 409 sentence through the shared helper, a missing invoice as 404, anything else as 500', () => {
    expect(lineBlock).toContain('if (sendCreditLineRefusal(response, error)) return')
    expect(lineBlock).toContain('sendJson(response, 404')
    expect(lineBlock).toContain('sendJson(response, 500')
    expect(lineBlock.indexOf('sendCreditLineRefusal')).toBeLessThan(lineBlock.indexOf('sendJson(response, 500'))
  })

  it('trails an activity entry for each, best-effort so a committed line is never reported as a failure', () => {
    const text = squash(lineBlock)
    expect(text).toContain("'invoice_account_credit_applied'")
    expect(text).toContain("'invoice_account_credit_removed'")
    const record = lineBlock.indexOf('recordActivity')
    expect(lineBlock.lastIndexOf('try {', record)).toBeGreaterThan(lineBlock.indexOf('applyAccountCreditToInvoice'))
    expect(lineBlock).toContain('saved but its activity entry failed')
  })

  it('closes the payment page of a SENT invoice whose total this moved, like any edit that does', () => {
    const text = squash(lineBlock)
    expect(text).toContain('creditLined.wasSent && creditLined.totalChanged')
    expect(text).toContain('expireInvoiceSessions')
  })

  it('answers the saved invoice, marked for the editor like a PATCH answer', () => {
    expect(squash(lineBlock)).toContain('sendJson(response, 200, { invoice: await withCoverageChangeable(creditLined) })')
  })

  it('is not on the preview allow-list: a preview is refused it', () => {
    const lists = sliceBetween('const PREVIEW_AWARE_API_PATHS = new Set([', 'function isPreviewAwareApiPath')
    expect(lists).not.toMatch(/account-credit/i)
  })

  it('touches no Stripe charge, no send and no bulk save', () => {
    expect(lineBlock).not.toMatch(/chargeAutopay|recordInvoiceSent|createCheckout|appDataStore\.write\(|stripe\./i)
  })
})

describe('the refusals a credit line change can answer', () => {
  it('answer the four an apply or a remove can raise, each as a 409 sentence with its own code', () => {
    const text = squash(refusals)
    for (const [klass, code] of [
      ['AccountCreditError', 'account_credit_refused'],
      ['RetainerCreditError', 'retainer_credit_refused'],
      ['InvoiceLockedError', 'invoice_locked'],
      ['InvoiceChangedError', 'invoice_changed'],
    ]) {
      expect(text).toContain(`error instanceof ${klass}`)
      expect(text).toContain(`error: '${code}'`)
    }
    expect(text.match(/sendJson\(response, 409/g)).toHaveLength(4)
  })

  it('are added to the invoice PATCH too, before the catch-all 500, so a save of a credit line says the same sentence', () => {
    const at = patchBlock.indexOf('error instanceof AccountCreditError')
    expect(at).toBeGreaterThan(-1)
    const branch = squash(patchBlock.slice(at, at + 260))
    expect(branch).toContain("error: 'account_credit_refused'")
    expect(branch).toContain('409')
    expect(at).toBeLessThan(patchBlock.indexOf("error: 'invoice_update_failed'"))
  })
})
