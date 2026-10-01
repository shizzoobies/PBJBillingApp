import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The glue for "a client with time or invoices cannot be deleted"
 * (featreq-27836ea0). The decisions live where they are tested - the rule in
 * lib/client-delete-rule.test.mjs, the refusal in db/store-staleness.test.mjs.
 * `server.js` listens at module scope, so these read the route source: they
 * prove wiring, and a failure means "the routing moved, go look".
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
)
const GUARD = "if (normalizedPath.startsWith('/api/')) {"

describe('PUT /api/app-data answers a blocked client delete with its own 409', () => {
  const at = serverSource.indexOf('if (error instanceof ClientHasHistoryError) {')
  const branch = serverSource.slice(at, serverSource.indexOf('return', at) + 10)

  it('maps ClientHasHistoryError to 409 client_has_history with the store sentence', () => {
    expect(at).toBeGreaterThan(-1)
    expect(branch).toContain(
      "sendJson(response, 409, { error: 'client_has_history', message: error.message })",
    )
  })

  it('is a different code from the stale-tab refusal, and is not the generic 500', () => {
    expect(branch).not.toContain('stale_workspace')
    const generic = serverSource.indexOf("error: 'bulk_save_failed'", at)
    expect(generic).toBeGreaterThan(at)
  })

  it('sits inside the same catch as the stale branch, after it', () => {
    const stale = serverSource.indexOf('if (error instanceof StaleWorkspaceError) {')
    expect(stale).toBeGreaterThan(-1)
    expect(at).toBeGreaterThan(stale)
  })
})

describe('GET /api/clients/:id/invoice-count', () => {
  const at = serverSource.indexOf('const invoiceCountMatch = normalizedPath.match(')
  const block = serverSource.slice(at, at + 1100)

  it('is an owner-only GET that hands back the store count', () => {
    expect(at).toBeGreaterThan(-1)
    expect(block).toMatch(/\^\\\/api\\\/clients\\\/\(\[\^\/\]\+\)\\\/invoice-count\$/)
    expect(block).toContain("request.method === 'GET'")
    expect(block).toContain("session.user.role !== 'owner'")
    expect(block).toContain('appDataStore.countClientInvoices(')
    expect(block).toContain('sendJson(response, 200, { invoiceCount })')
  })

  it('sits above the /api/ catch-all', () => {
    const guardAt = serverSource.indexOf(GUARD)
    expect(guardAt, 'the /api/ catch-all guard is gone').toBeGreaterThan(-1)
    expect(at, 'the invoice-count route is below the /api/ catch-all').toBeLessThan(guardAt)
  })
})
