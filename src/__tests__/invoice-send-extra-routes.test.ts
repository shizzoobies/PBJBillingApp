import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { latestInvoiceDelivery } from '../lib/utils'
import type { InvoiceEmailLogEntry } from '../lib/types'

/**
 * A one-time extra address on a send (owner's answer 3, featreq-21d0bba8) - the
 * glue in `server.js`.
 *
 * SAME CAVEAT as invoice-coverage-routes.test.ts: `server.js` is not booted by
 * tests, so this reads its source. The decision itself (valid, at most three,
 * de-duplicated, at least one on-file address unless the client has none) is
 * `resolveSendRecipients`, proved in lib/invoice-recipient-extra.test.mjs; the
 * log entry's `oneTime` in db/store-staleness.test.mjs. What can rot HERE: the
 * route stops asking that function, asks it after a Stripe call or an email, or
 * starts saving what she typed to the client.
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
)

/** From a route's own anchor to the next anchor - bounded exactly, not by length. */
function sliceBetween(from: string, to: string) {
  const start = serverSource.indexOf(from)
  expect(start, `${from} is gone from server.js`).toBeGreaterThan(-1)
  const end = serverSource.indexOf(to, start + from.length)
  expect(end, `${to} no longer follows ${from}`).toBeGreaterThan(start)
  return serverSource.slice(start, end)
}

const sendBlock = sliceBetween(
  'const invoiceSendMatch = normalizedPath.match(',
  '// GET /api/invoices/export.csv',
)
const webhookBlock = sliceBetween(
  "if (normalizedPath === '/api/resend/webhook' && request.method === 'POST') {",
  '// POST /api/invoices/:id/payment-link',
)

describe('the send route validates `extra` before anything leaves', () => {
  const resolve = sendBlock.indexOf('resolveSendRecipients({')
  const refuse = sendBlock.indexOf('if (!sendRecipients.ok) {')

  it('decides the recipients in one call, from the on-file addresses, `to` and `extra`', () => {
    expect(resolve).toBeGreaterThan(-1)
    const call = sendBlock.slice(resolve, resolve + 220)
    expect(call).toContain('allowed: recipients.to')
    expect(call).toContain('to: sendPayload?.to')
    expect(call).toContain('extra: sendPayload?.extra')
    // The old inline decision is gone: there is one place that makes it.
    expect(sendBlock).not.toContain('chooseInvoiceRecipients(')
    expect(serverSource).toMatch(
      /import \{ resolveSendRecipients \} from '\.\/lib\/invoice-recipients\.js'/,
    )
  })

  it('answers a refusal with the status, code and sentence the helper chose, and returns', () => {
    expect(refuse).toBeGreaterThan(resolve)
    const branch = sendBlock.slice(refuse, refuse + 300)
    expect(branch).toContain('sendJson(response, sendRecipients.status, {')
    expect(branch).toContain('error: sendRecipients.error')
    expect(branch).toContain('message: sendRecipients.message')
    expect(branch).toContain('return')
  })

  it('does all of it BEFORE a Stripe call, a pay link or the email', () => {
    for (const later of [
      'isStripeConfigured()',
      'createInvoiceCheckoutSession(',
      'swapInvoiceCheckoutSession(',
      'buildInvoiceDocuments(',
      'sendInvoiceEmail(',
      'recordInvoiceSent(',
    ]) {
      const at = sendBlock.indexOf(later)
      expect(at, `${later} is gone from the send route`).toBeGreaterThan(-1)
      expect(at, `${later} runs before the recipients are settled`).toBeGreaterThan(refuse)
    }
  })

  it('emails exactly the addresses it resolved: the on-file ones plus the extras', () => {
    expect(sendBlock).toContain('const sendTo = sendRecipients.to')
    expect(sendBlock).toMatch(/sendInvoiceEmail\(\{\s*to: sendTo,/)
  })
})

describe('the log says which addresses were one-time', () => {
  it('passes the one-time list on the failed attempt and on the successful send', () => {
    expect(sendBlock).toContain('const sendOneTime = sendRecipients.oneTime')
    expect(sendBlock.match(/oneTime: sendOneTime,/g)).toHaveLength(2)
    expect(sendBlock.match(/recordInvoiceSent\(/g)).toHaveLength(2)
  })
})

describe('what she types for one send is saved nowhere', () => {
  it('the send route writes no client, contact or workspace', () => {
    expect(sendBlock).not.toMatch(
      /appDataStore\.(write|updateClient|createClient|saveClient|upsertContact|createContact|saveContact|updateContact|addContact)\b/,
    )
    // The Stripe customer id is written by ensureStripeCustomer (the client's
    // Stripe id and nothing else), so the route itself makes no set* write.
    expect(sendBlock.match(/appDataStore\.set\w+\(/g)).toBeNull()
    expect(sendBlock).not.toContain('contacts.push')
    expect(sendBlock).not.toContain('companyEmails')
  })
})

describe('the delivery webhook is indifferent to whose address a send went to', () => {
  it('places an event by the invoice tag, then the provider id - never by recipient', () => {
    expect(webhookBlock).toContain('tagBag.invoice_id')
    expect(webhookBlock).toContain('findInvoiceByEmailProviderId(providerId)')
    const place = webhookBlock.slice(
      webhookBlock.indexOf('const deliveryInvoice ='),
      webhookBlock.indexOf('if (!deliveryInvoice) {'),
    )
    expect(place).not.toMatch(/\.to\b|eventData\.to|recipients|extra/)
  })

  it('the badge follows the send by provider id: an address nobody has on file changes nothing', () => {
    const log: InvoiceEmailLogEntry[] = [
      {
        at: '2026-10-01T12:00:00.000Z',
        to: ['ann@acme.test', 'ap@other.test'],
        subject: 'Invoice',
        ok: true,
        providerId: 'prov-1',
        oneTime: ['ap@other.test'],
      },
      {
        kind: 'delivery',
        event: 'bounced',
        at: '2026-10-01T12:01:00.000Z',
        providerId: 'prov-1',
        to: ['ap@other.test'],
        detail: 'mailbox full',
      },
    ]

    expect(latestInvoiceDelivery(log)).toMatchObject({ event: 'bounced', providerId: 'prov-1' })
  })
})
