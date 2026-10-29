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
const storeSource = readFileSync('db/store.js', 'utf8')
const protectedDelivery = storeSource.slice(storeSource.indexOf('async deliverInvoiceWithCreditLock('), storeSource.indexOf('async recordInvoiceSent('))

describe('the send route builds both documents from one send moment', () => {
  it('decides the stamp once, before the email and the PDF', () => {
    expect(at).toBeGreaterThan(-1)
    expect(route.match(/const sendStamp = new Date\(\)\.toISOString\(\)/g)).toHaveLength(1)
    const stampAt = route.indexOf('const sendStamp')
    // One call builds both documents (lib/invoice-documents.js), after the stamp.
    expect(stampAt).toBeLessThan(route.indexOf('buildInvoiceDocuments({'))
  })

  it('builds the email, the PDF and its filename from the invoice as it will be stored', () => {
    expect(route).toContain(
      'const sendInvoice = invoiceAsSent(invoice, { client: sendClient, stamp: sendStamp })',
    )
    expect(route).toMatch(/buildInvoiceDocuments\(\{\s*invoice: sendInvoice,/)
    // The attachment's filename is the one the builder derived from that same invoice
    // (lib/invoice-documents.test.mjs pins it as invoicePdfFilename(invoice)).
    expect(route).toContain('filename: sendDocuments.pdfFilename, content: sendDocuments.pdf')
  })

  it('hands the same stamp to the store on a delivered send, and never on a failed one', () => {
    expect(route).toMatch(/deliverInvoiceWithCreditLock\(invoice, \{[\s\S]*?stamp: sendStamp,/)
    // The protected helper records both outcomes. Only accepted delivery gets
    // the document stamp; failed attempts cannot move sent_at or due_date.
    expect(protectedDelivery).toContain('stamp: result.ok ? details.stamp : null')
    expect(protectedDelivery).toContain('ok: result.ok')
  })

  it('does not stamp anything before the provider answers', () => {
    const stampAt = route.indexOf('const sendStamp')
    const providerAt = route.indexOf('() => sendInvoiceEmail({')
    expect(providerAt).toBeGreaterThan(stampAt)
    const call = protectedDelivery.indexOf('const result = await deliver()')
    expect(call).toBeGreaterThan(-1)
    expect(protectedDelivery.indexOf('await this.recordInvoiceSent(')).toBeGreaterThan(call)
  })
})
