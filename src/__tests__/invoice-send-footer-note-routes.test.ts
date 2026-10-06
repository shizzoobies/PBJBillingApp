import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The invoice email carries the client's footer note (featreq-459bdfc2, item 8).
 *
 * The rendering is pinned in lib/invoice-email.test.mjs. This pins the glue the
 * email was missing: the send route handing `buildInvoiceDocuments` the
 * INVOICE's client (the one whose name and address the email uses - a billing
 * master's invoice carries the master's note), not the sub the envelope goes
 * to, and the builder reading the note off that client. `server.js` is not booted by tests, so this reads its
 * source: a failure means "the routing moved".
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
)

const at = serverSource.search(/const invoiceSendMatch = normalizedPath\.match\(/)
const route = serverSource.slice(at, serverSource.indexOf('// GET /api/invoices/export.csv', at))
const emailCall = route.slice(
  route.indexOf('buildInvoiceDocuments({'),
  route.indexOf('})', route.indexOf('buildInvoiceDocuments({')),
)
const builderSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../lib/invoice-documents.js'),
  'utf8',
)

describe('the send route gives the invoice email the client footer note', () => {
  it('passes the note of the invoice\'s own client to the email', () => {
    expect(at).toBeGreaterThan(-1)
    expect(emailCall).toContain('client: sendClient,')
    expect(builderSource).toContain("footerNote: client?.footerNote ?? '',")
  })

  it('takes that client from the invoice, never from the envelope\'s addressee', () => {
    expect(route).toContain(
      'const sendClient = (sendAppData.clients ?? []).find((entry) => entry.id === invoice.clientId)',
    )
    // The sub the envelope goes to (`sendAddressee`) supplies addresses only.
    expect(emailCall).not.toContain('sendAddressee')
  })
})
