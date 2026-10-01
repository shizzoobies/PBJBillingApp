import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Statement dates box (featreq-11ffb3a6) fix review — the ROUTE wiring for the
 * two Important items. `server.js` calls `listen()` at module scope and
 * exports nothing, so (same reasoning as pending-client-notes-routes.test.ts
 * and preview-scoped-routes.test.ts) this reads route source rather than
 * driving an HTTP harness. The store-level decisions (the version hash, the
 * stale check, id validation/dedupe) are tested properly in
 * db/store-staleness.test.mjs.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const serverSource = readFileSync(path.join(repoRoot, 'server.js'), 'utf8')

function routeBlock(startPattern: RegExp, length = 1600): string {
  const at = serverSource.search(startPattern)
  expect(at, `route not found: ${startPattern}`).toBeGreaterThan(-1)
  return serverSource.slice(at, at + length)
}

describe('GET /api/clients/:id/statement-accounts', () => {
  it('answers the version fingerprint alongside the list', () => {
    const block = routeBlock(/const clientStatementAccountsMatch = normalizedPath\.match/, 1200)
    expect(block).toContain(
      "sendJson(response, 200, { accounts, version: statementAccountsVersion(accounts) })",
    )
  })
})

describe('PUT /api/clients/:id/statement-accounts', () => {
  const block = () => routeBlock(/const clientStatementAccountsMatch = normalizedPath\.match/, 3100)

  it('400s on a non-array accounts payload instead of replacing with an empty list', () => {
    const text = block()
    const putAt = text.indexOf("request.method === 'PUT'")
    expect(putAt).toBeGreaterThan(-1)
    const putBlock = text.slice(putAt)
    const guardAt = putBlock.indexOf('if (!Array.isArray(payload?.accounts))')
    expect(guardAt).toBeGreaterThan(-1)
    const guardBlock = putBlock.slice(guardAt, guardAt + 200)
    expect(guardBlock).toContain("sendJson(response, 400,")
    // The guard must come BEFORE the store is ever called with this payload.
    const saveAt = putBlock.indexOf('saveClientStatementAccounts(')
    expect(saveAt).toBeGreaterThan(guardAt)
  })

  it('sends the version through to the store and answers 409 on a stale save', () => {
    const text = block()
    const callAt = text.indexOf('appDataStore.saveClientStatementAccounts(')
    expect(callAt).toBeGreaterThan(-1)
    const callBlock = text.slice(callAt, callAt + 200)
    expect(callBlock).toContain('clientId,')
    expect(callBlock).toContain('payload.accounts,')
    expect(callBlock).toContain('expectedVersion,')
    const catchAt = text.indexOf('} catch (error) {')
    expect(catchAt).toBeGreaterThan(-1)
    const catchBlock = text.slice(catchAt, catchAt + 300)
    expect(catchBlock).toContain('error instanceof StaleStatementAccountsError')
    expect(catchBlock).toContain(
      "sendJson(response, 409, { error: 'stale_statement_accounts', message: error.message })",
    )
  })

  it('skips the staleness check when the client sends no version', () => {
    const text = block()
    expect(text).toContain(
      "const expectedVersion = typeof payload?.version === 'string' ? payload.version : ''",
    )
  })

  it('answers the fresh version alongside the saved list', () => {
    const text = block()
    expect(text).toContain(
      'sendJson(response, 200, { accounts, version: statementAccountsVersion(accounts) })',
    )
  })
})
