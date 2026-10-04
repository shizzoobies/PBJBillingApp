import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// vitest runs from the repo root; a cwd-relative path sidesteps the
// import.meta.url scheme differences between node and the vite runner.
const source = readFileSync('server.js', 'utf8')

/** The route's handler body: from its matcher to the response it sends. */
function routeBody() {
  const start = source.indexOf('const clientInvoiceNoteMatch = normalizedPath.match(')
  expect(start, 'the invoice-note route is gone').toBeGreaterThan(-1)
  const end = source.indexOf('const clientActivityMatch', start)
  return source.slice(start, end)
}

describe('PUT /api/clients/:id/invoice-note', () => {
  it('is routed on the client path and answers only PUT', () => {
    const body = routeBody()
    expect(body).toMatch(/\\\/api\\\/clients\\\/\(\[\^\/\]\+\)\\\/invoice-note\$/)
    expect(body).toContain("request.method !== 'PUT'")
    expect(body).toContain('405')
  })

  it('is owner-only, JSON-only and refuses a cross-site origin', () => {
    const body = routeBody()
    expect(body).toContain("session.user.role !== 'owner'")
    expect(body).toContain('Only owners can keep a note for future invoices')
    expect(body).toContain('application/json required')
    expect(body).toContain('isCrossSiteOrigin(request)')
  })

  it('refuses a body whose note is neither text nor null, and 404s an unknown client', () => {
    const body = routeBody()
    expect(body).toContain("typeof payload?.note !== 'string' && payload?.note !== null")
    expect(body).toContain('400')
    expect(body).toContain("'Client not found'")
  })

  it('writes through the targeted store method and nothing else', () => {
    const body = routeBody()
    expect(body).toContain('appDataStore.setClientInvoiceNote(clientId, payload.note)')
    expect(body).not.toContain('appDataStore.write(')
  })
})

describe('staff never receive the kept note', () => {
  it('scopeAppDataForSession blanks invoiceNote beside the rates', () => {
    const start = source.indexOf('function scopeAppDataForSession(')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('const checklists = ', start))
    expect(body).toContain('invoiceNote: undefined')
  })
})
