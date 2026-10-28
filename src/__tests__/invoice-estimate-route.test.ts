import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * GET /api/invoice-recap/estimate (featreq-a5e14899): the owner's estimate of the
 * month's invoices, "not to be seen by others other than me".
 *
 * server.js is not booted by tests, so this reads the route source and pins the
 * wiring: owner-only 403, refused in preview, off the preview-aware allowlist,
 * and the estimate built from the shared builder.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const serverSource = readFileSync(path.join(repoRoot, 'server.js'), 'utf8')

function routeBlock(startPattern: RegExp, length = 1800): string {
  const at = serverSource.search(startPattern)
  expect(at, `route not found: ${startPattern}`).toBeGreaterThan(-1)
  return serverSource.slice(at, at + length)
}

describe('GET /api/invoice-recap/estimate', () => {
  const block = routeBlock(/normalizedPath === '\/api\/invoice-recap\/estimate'/)

  it('is a session route that answers a non-owner with a 403, before reading any money', () => {
    const session = block.indexOf('await requireSession(request, response)')
    const ownerCheck = block.indexOf("session.user.role !== 'owner'")
    const forbidden = block.indexOf('sendJson(response, 403')
    const read = block.indexOf('appDataStore.read()')
    expect(session).toBeGreaterThan(-1)
    expect(ownerCheck).toBeGreaterThan(session)
    expect(forbidden).toBeGreaterThan(ownerCheck)
    expect(read).toBeGreaterThan(forbidden)
  })

  it('refuses a preview identity itself, before reading any money', () => {
    const preview = block.indexOf("request.headers['x-preview-as']")
    expect(preview).toBeGreaterThan(-1)
    expect(block.indexOf('preview_unsupported')).toBeGreaterThan(preview)
    expect(block.indexOf('appDataStore.read()')).toBeGreaterThan(preview)
    // Never scoped as somebody else: it is the owner's own view or nothing.
    expect(block).not.toContain('previewScopedSession')
  })

  it('is NOT on the preview-aware allowlist, so the global guard refuses it in preview too', () => {
    const at = serverSource.search(/const PREVIEW_AWARE_API_PATHS = new Set\(\[/)
    const allowlist = serverSource.slice(at, at + 900)
    expect(allowlist).not.toContain('/api/invoice-recap/estimate')
    // ...and the staff recap beside it is untouched.
    expect(allowlist).toContain("'/api/invoice-recap'")
  })

  it('builds the answer from the shared estimate builder with the owner bill rates', () => {
    expect(block).toContain('buildInvoiceEstimate({')
    expect(block).toContain('loadRateVersions(session)')
    expect(block).toContain('appDataStore.listInvoices({ period })')
  })

  it('validates the period', () => {
    expect(block).toContain('period must look like')
  })
})
