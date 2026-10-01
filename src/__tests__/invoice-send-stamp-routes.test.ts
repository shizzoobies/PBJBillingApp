import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * `POST /api/invoices/:id/send` decides ONE send moment (featreq-29c6dac1).
 *
 * `server.js` calls `server.listen()` at module scope, so a test cannot boot
 * it; the behavior is pinned where it lives (lib/invoice-draft.test.mjs for
 * `invoiceAsSent`, db/store-staleness.test.mjs for `recordInvoiceSent` and the
 * three-call flow on both backends). This pins the glue: that the route decides
 * the stamp before either document, builds BOTH from the same invoice, and
 * hands the stamp to the store only after the provider accepted the email.
 * It reads the route source, so a failure means "the routing moved".
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
)

const at = serverSource.search(/const invoiceSendMatch = normalizedPath\.match\(/)
// To the next route's marker, not a fixed length: the route keeps growing.
const route = serverSource.slice(at, serverSource.indexOf('// GET /api/invoices/export.csv', at))

describe('the send route builds both documents from one send moment', () => {
  it('decides the stamp once, before the email and the PDF', () => {
    expect(at).toBeGreaterThan(-1)
    expect(route.match(/const sendStamp = new Date\(\)\.toISOString\(\)/g)).toHaveLength(1)
    const stampAt = route.indexOf('const sendStamp')
    expect(stampAt).toBeLessThan(route.indexOf('buildInvoiceEmail({'))
    expect(stampAt).toBeLessThan(route.indexOf('buildInvoicePdf({'))
  })

  it('builds the email, the PDF and its filename from the invoice as it will be stored', () => {
    expect(route).toContain(
      'const sendInvoice = invoiceAsSent(invoice, { client: sendClient, stamp: sendStamp })',
    )
    expect(route).toMatch(/buildInvoiceEmail\(\{\s*invoice: sendInvoice,/)
    expect(route).toMatch(/buildInvoicePdf\(\{\s*invoice: sendInvoice,/)
    expect(route).toContain('invoicePdfFilename(sendInvoice)')
  })

  it('hands the same stamp to the store on a delivered send, and never on a failed one', () => {
    const failedAt = route.indexOf('ok: false,')
    const deliveredAt = route.indexOf('ok: true,', failedAt)
    expect(failedAt).toBeGreaterThan(-1)
    expect(deliveredAt).toBeGreaterThan(failedAt)
    expect(route.slice(failedAt, deliveredAt)).not.toContain('stamp:')
    expect(route.slice(deliveredAt, deliveredAt + 800)).toContain('stamp: sendStamp')
  })

  it('does not stamp anything before the provider answers', () => {
    const stampAt = route.indexOf('const sendStamp')
    const providerAt = route.indexOf('await sendInvoiceEmail({')
    const firstRecord = route.indexOf('recordInvoiceSent(')
    expect(providerAt).toBeGreaterThan(stampAt)
    expect(firstRecord).toBeGreaterThan(providerAt)
  })
})
