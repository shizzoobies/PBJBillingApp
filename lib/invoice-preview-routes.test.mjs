import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * "A preview of exactly what the client receives" (featreq-459bdfc2 item 3) -
 * the server's wiring.
 *
 * server.js listens at module scope and exports nothing, so there is no HTTP
 * harness; these pin the wiring, the same convention as the never-email route
 * tests. What matters: the send route and the preview routes build their
 * documents through the ONE shared function, the preview is owner-only, and
 * the preview mints, sends and records nothing.
 */

const source = readFileSync('server.js', 'utf8')

function between(startAnchor, endAnchor, from = 0) {
  const start = source.indexOf(startAnchor, from)
  expect(start, `${startAnchor} is gone`).toBeGreaterThan(-1)
  const end = source.indexOf(endAnchor, start + startAnchor.length)
  expect(end, `${endAnchor} is gone`).toBeGreaterThan(start)
  return source.slice(start, end)
}

const sendRoute = () =>
  between('const invoiceSendMatch = normalizedPath.match(', '// GET /api/invoices/:id/preview')
const previewRoutes = () =>
  between('// GET /api/invoices/:id/preview', "normalizedPath === '/api/invoices/export.csv'")
// The helper sits directly above planAutopaySend, which it calls.
const previewAssembly = () =>
  between('async function assembleInvoicePreview(', 'async function planAutopaySend(')

const NEVER_IN_A_PREVIEW = [
  'sendInvoiceEmail',
  'createInvoiceCheckoutSession',
  'createInvoiceCardCheckoutSession',
  'getOrCreateInvoicePayToken',
  'swapInvoiceCheckoutSession',
  'ensureStripeCustomer',
  'recordInvoiceSent',
  'recordActivity',
  'chargeAfterSend',
  'expireCheckoutSession',
  'runAutopayCharge',
  'notify(',
  'reportAutopayNotCharged',
]

describe('the send builds its documents through the shared function', () => {
  it('calls buildInvoiceDocuments and no longer calls the two builders itself', () => {
    const body = sendRoute()
    expect(body).toContain('buildInvoiceDocuments({')
    expect(body).not.toContain('buildInvoiceEmail({')
    expect(body).not.toContain('buildInvoicePdf({')
  })
})

describe('the preview routes', () => {
  it('exist for the email and for the PDF, owner-only', () => {
    const body = previewRoutes()
    expect(body).toContain(String.raw`/^\/api\/invoices\/([^/]+)\/preview$/`)
    expect(body).toContain(String.raw`/^\/api\/invoices\/([^/]+)\/preview\.pdf$/`)
    expect(body.match(/session\.user\.role !== 'owner'/g)).toHaveLength(2)
  })

  it('build exactly what the send builds: the as-sent invoice, the autopay plan, the shared function', () => {
    const body = previewAssembly()
    expect(body).toContain('invoiceAsSent(')
    expect(body).toContain('planAutopaySend(')
    expect(body).toContain('buildInvoiceDocuments({')
    expect(body).toContain('autopayEmailDetails(')
  })

  it('mint, send and record nothing', () => {
    for (const forbidden of NEVER_IN_A_PREVIEW) {
      expect(previewRoutes(), `${forbidden} must not run in a preview`).not.toContain(forbidden)
      expect(previewAssembly(), `${forbidden} must not run in a preview`).not.toContain(forbidden)
    }
  })

  it('stream the PDF inline and uncached', () => {
    const body = previewRoutes()
    expect(body).toContain("'Content-Type': 'application/pdf'")
    expect(body).toContain("'Cache-Control': 'no-store'")
  })
})
