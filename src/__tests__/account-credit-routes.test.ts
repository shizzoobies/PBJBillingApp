import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The credit-on-account routes (featreq-110efd15, stage 1a), pinned the way the
 * autopay routes are: server.js listens at module scope and exports nothing, so
 * this reads the source. The store halves have real tests in
 * db/store-staleness.test.mjs; what is pinned HERE is the gates, the validation
 * and the activity trail of the three routes, and that nothing else is touched.
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

const listBlock = sliceBetween(
  "creditsMatch && request.method === 'GET'",
  "creditsMatch && request.method === 'POST'",
)
const addBlock = sliceBetween(
  "creditsMatch && request.method === 'POST'",
  'const voidCreditMatch = normalizedPath.match(',
)
const voidBlock = sliceBetween(
  'const voidCreditMatch = normalizedPath.match(',
  '// POST /api/clients/:id/autopay/invite',
)

describe('GET /api/clients/:id/credits', () => {
  it('is owner-only, and refuses before it reads anything', () => {
    expect(listBlock).toContain("session.user.role !== 'owner'")
    expect(listBlock).toContain('sendJson(response, 403')
    expect(listBlock.indexOf('403')).toBeLessThan(listBlock.indexOf('listAccountCredits'))
  })

  it('answers the balance and the ledger, and writes nothing', () => {
    expect(squash(listBlock)).toContain('sendJson(response, 200, { balance, credits })')
    expect(listBlock).toContain('accountCreditBalance')
    expect(listBlock).toContain('listAccountCredits')
    expect(listBlock).not.toMatch(/addAccountCredit|voidAccountCredit|recordActivity|writeFile|\.write\(/)
  })

  it('answers 404 for a client that does not exist', () => {
    expect(listBlock).toContain('getClientById')
    expect(listBlock).toContain('sendJson(response, 404')
  })
})

describe('POST /api/clients/:id/credits', () => {
  it('is owner-only, same-origin and JSON, in that order, before the body is read', () => {
    const owner = addBlock.indexOf("session.user.role !== 'owner'")
    const origin = addBlock.indexOf('isCrossSiteOrigin(request)')
    const type = addBlock.indexOf('application/json')
    const body = addBlock.indexOf('readJsonBody(request)')
    expect(owner).toBeGreaterThan(-1)
    expect(owner).toBeLessThan(origin)
    expect(origin).toBeLessThan(type)
    expect(type).toBeLessThan(body)
    expect(addBlock).toContain('sendJson(response, 403')
    expect(addBlock).toContain('sendJson(response, 415')
  })

  it('validates the amount (positive, at most 1,000,000), the note (500 characters) and the month (YYYY-MM)', () => {
    const text = squash(addBlock)
    expect(serverSource).toContain('const MAX_CREDIT_AMOUNT = 1_000_000')
    expect(serverSource).toContain('const MAX_CREDIT_NOTE = 500')
    expect(serverSource).toContain('const CREDIT_PERIOD = /^\\d{4}-(0[1-9]|1[0-2])$/')
    expect(text).toMatch(/amount > MAX_CREDIT_AMOUNT/)
    expect(text).toMatch(/note\.length > MAX_CREDIT_NOTE/)
    expect(text).toContain('CREDIT_PERIOD.test(')
    expect(addBlock).toContain('sendJson(response, 400')
    // Every refusal above comes before the store is asked.
    expect(addBlock.lastIndexOf('sendJson(response, 400')).toBeLessThan(addBlock.indexOf('addAccountCredit'))
  })

  it('records who added it, trails an activity entry naming the client and the amount, and answers the row', () => {
    const text = squash(addBlock)
    expect(text).toContain('createdBy: session.user.id')
    expect(text).toContain("'account_credit_added'")
    expect(text).toContain('creditClient.name')
    expect(text).toContain('sendJson(response, 200, credit)')
  })

  it("answers the store's refusals as a 409 sentence, never a 500", () => {
    expect(addBlock).toContain('error instanceof AccountCreditError')
    expect(addBlock).toContain('sendJson(response, 409')
  })

  it('touches no invoice, no Stripe and no bulk save', () => {
    expect(addBlock + voidBlock + listBlock).not.toMatch(
      /invoice|stripe|expireInvoiceSessions|bulkSave|appDataStore\.write\(/i,
    )
  })
})

describe('POST /api/account-credits/:id/void', () => {
  it('is owner-only and same-origin', () => {
    const owner = voidBlock.indexOf("session.user.role !== 'owner'")
    const origin = voidBlock.indexOf('isCrossSiteOrigin(request)')
    expect(owner).toBeGreaterThan(-1)
    expect(owner).toBeLessThan(origin)
    expect(voidBlock.indexOf('voidAccountCredit')).toBeGreaterThan(origin)
    expect(voidBlock).toContain('sendJson(response, 403')
  })

  it('answers 404 for no such credit and 409 for an already-void one', () => {
    expect(voidBlock).toContain('sendJson(response, 404')
    expect(voidBlock).toContain('error instanceof AccountCreditError')
    expect(voidBlock).toContain('sendJson(response, 409')
  })

  it('trails an activity entry naming the client and the amount', () => {
    const text = squash(voidBlock)
    expect(text).toContain("'account_credit_voided'")
    expect(text).toContain('voided.amount')
  })
})

describe('what is reachable in preview, and what staff are sent', () => {
  it('neither credit route is on the preview allow-list (a preview is refused them)', () => {
    const lists = sliceBetween('const PREVIEW_AWARE_API_PATHS = new Set([', 'function isPreviewAwareApiPath')
    expect(lists).not.toMatch(/credits|account-credits/i)
  })

  it('the file backend’s whole-file read is stripped of the ledger for staff', () => {
    const scope = sliceBetween('function scopeAppDataForSession(', 'Soft-deleted team members are owner-only')
    expect(scope).toContain('accountCredits: undefined')
  })
})
