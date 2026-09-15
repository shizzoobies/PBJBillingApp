import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listInvoicesRequest } from '../lib/api'

/**
 * The hourly past-due notice, pinned at the level this repo can reach.
 *
 * WHAT THIS IS AND IS NOT. `server.js` calls `server.listen()` at module scope
 * and exports nothing, so importing it in a test starts a real listener and
 * reaches for a database — the same reason `invoice-coverage-routes.test.ts`
 * reads the source instead. The DECISIONS are tested properly elsewhere:
 * `pastDueInvoice` in `invoice-past-due.test.tsx`, and
 * `recordInvoicePastDueNoticed` on both backends in `db/store-staleness.test.mjs`.
 *
 * What is left over is the GLUE, and it has four properties that are quiet when
 * they break and expensive when they do: a timer that holds the process open, a
 * missing env gate that makes the app try to email from a dev machine, a missing
 * idempotency check that emails the owners about the same invoice every hour
 * until it is paid, and marking AFTER notifying, which turns one failed send
 * into that same hourly loop. Treat a failure here as "the scheduler changed,
 * go look", not as a behavioral regression.
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
)

/** The whole scheduler, from its function down through the timers below it. */
const block = () => {
  const at = serverSource.indexOf('async function maybeNotifyPastDueInvoices')
  expect(at, 'the past-due scheduler is gone').toBeGreaterThan(-1)
  return serverSource.slice(at)
}

describe('the past-due scheduler', () => {
  // A referenced interval keeps Node alive forever; every other timer in this
  // file is unref'd for that reason.
  it('never holds the process open', () => {
    const text = block()
    expect(text).toContain('const pastDueTimer = setInterval(maybeNotifyPastDueInvoices')
    expect(text).toContain('pastDueTimer.unref?.()')
    expect(text).toMatch(/setTimeout\(\(\) => void maybeNotifyPastDueInvoices\(\), 30 \* 1000\)\.unref\?\.\(\)/)
  })

  it('runs hourly, like the digest beside it', () => {
    expect(block()).toContain('setInterval(maybeNotifyPastDueInvoices, 60 * 60 * 1000)')
  })

  // No mail configuration means no notices at all — a dev machine running this
  // must not start mailing the firm's owners.
  it('is gated on the mail environment before it reads anything', () => {
    const text = block()
    const gate = text.indexOf('!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM')
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(text.indexOf('appDataStore.listInvoices()'))
  })

  it('asks the shared rule what is late, with the server’s own day', () => {
    const text = block()
    expect(text).toContain('const today = todayIso()')
    expect(text).toContain('pastDueInvoice(invoice, today)')
  })

  it('imports that rule rather than re-deciding what past due means', () => {
    expect(serverSource).toContain("import { pastDueInvoice } from './lib/invoice-overdue.js'")
  })

  // ONE notice per invoice, ever.
  it('skips an invoice already marked, before anyone is notified', () => {
    const text = block()
    const check = text.indexOf("entry?.kind === 'past-due'")
    expect(check).toBeGreaterThan(-1)
    expect(check).toBeLessThan(text.indexOf('notify(appDataStore'))
  })

  // Marking AFTER notifying would mean a failing mail provider re-ran the whole
  // round an hour later, and again, and again.
  it('records the marker before it notifies anybody', () => {
    const text = block()
    const mark = text.indexOf('appDataStore.recordInvoicePastDueNoticed(')
    const told = text.indexOf('notify(appDataStore')
    expect(mark).toBeGreaterThan(-1)
    expect(told).toBeGreaterThan(-1)
    expect(mark).toBeLessThan(told)
  })

  it('tells every owner, and nobody else', () => {
    const text = block()
    expect(text).toContain("(member) => member.role === 'owner'")
    expect(text).toContain("notify(appDataStore, owner.id, 'invoice_past_due'")
    expect(text).toContain("link: '/invoices'")
  })

  // The whole point of deriving past due at read time: nothing here writes a
  // status, so there is nothing to un-write when the invoice is paid.
  it('writes no invoice status', () => {
    expect(block()).not.toMatch(/setInvoiceStatus|status:\s*'overdue'/)
  })

  // The bell is the source of truth; a mail failure must not take the tick down.
  it('swallows its own errors', () => {
    expect(block()).toContain("console.error('[invoices] past-due notice failed:'")
  })

  /**
   * ONE FAILURE COSTS ONE NOTICE. The marker is written before anybody is told,
   * so a throw out of `notify` is never retried — with a single try/catch
   * around the whole loop, one owner's bad address would silently swallow every
   * remaining invoice in that morning's batch, permanently.
   */
  it('gives each notice its own catch', () => {
    const text = block()
    const at = text.indexOf("notify(appDataStore, owner.id, 'invoice_past_due'")
    expect(at).toBeGreaterThan(-1)
    // The `try {` immediately above the call, and the catch immediately below.
    expect(text.slice(at - 400, at)).toContain('try {')
    expect(text.slice(at, at + 600)).toContain('past-due notice to ${owner.id} failed:')
  })
})

/**
 * `GET /api/invoices?pastDue=1` — what the dashboard's past-due section asks.
 *
 * Without the flag that section pulled EVERY invoice the firm has ever written
 * (no period), each one carrying its lines, its original lines and its whole
 * email log — all jsonb — to render a handful of list items. The filtering is
 * server-side and uses `pastDueInvoice`, the same rule the month run and the
 * scheduler use, so the three cannot name different invoices.
 */
describe('the dashboard’s past-due fetch', () => {
  const listBlock = (() => {
    const start = serverSource.indexOf("if (normalizedPath === '/api/invoices' && request.method === 'GET')")
    expect(start, 'the invoices list route is gone').toBeGreaterThan(-1)
    return serverSource.slice(start, start + 2200)
  })()

  it('filters with the shared rule and the server’s own day', () => {
    expect(listBlock).toContain("requestUrl.searchParams.get('pastDue') === '1'")
    expect(listBlock).toContain('pastDueInvoice(invoice, today)')
    expect(listBlock).toContain('const today = todayIso()')
  })

  // The six fields the section prints, and nothing else — no jsonb over the
  // wire for a list of client names and dates.
  it('answers with the trimmed row, not the document', () => {
    const at = listBlock.indexOf("requestUrl.searchParams.get('pastDue') === '1'")
    const branch = listBlock.slice(at, at + 900)
    for (const field of ['id:', 'number:', 'clientId:', 'status:', 'dueDate:', 'sentAt:', 'total:']) {
      expect(branch).toContain(field)
    }
    expect(branch).not.toContain('lineItems')
    expect(branch).not.toContain('emailLog')
  })

  // It is still owner-only, and the period branch is untouched.
  it('keeps the owner gate and the period answer', () => {
    expect(listBlock).toContain("session.user.role !== 'owner'")
    expect(listBlock).toContain('period must look like 2026-08')
  })
})

/** The other half: the URL the client actually asks for. */
describe('listInvoicesRequest builds the query', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const requestedUrl = () => String(fetchMock.mock.calls[0][0])

  beforeEach(() => {
    fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ invoices: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('asks for nothing extra by default', async () => {
    await listInvoicesRequest()
    expect(requestedUrl()).toContain('/api/invoices')
    expect(requestedUrl()).not.toContain('pastDue')
  })

  it('carries the period on its own', async () => {
    await listInvoicesRequest('2026-08')
    expect(requestedUrl()).toContain('period=2026-08')
  })

  it('carries pastDue=1, and both together', async () => {
    await listInvoicesRequest(undefined, { pastDue: true })
    expect(requestedUrl()).toContain('pastDue=1')
    expect(requestedUrl()).not.toContain('period=')
  })
})

describe('the notification catalog knows the event', () => {
  const notifySource = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../lib/notify.js'),
    'utf8',
  )
  const prefsSource = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../lib/notification-prefs.js'),
    'utf8',
  )

  it('is a known event with a subject of its own', () => {
    expect(notifySource).toContain("'invoice_past_due',")
    expect(notifySource).toContain('An invoice is past its 30-day line:')
  })

  it('sits under the invoice-alerts toggle', () => {
    expect(prefsSource).toContain("key: 'invoiceAlerts'")
    expect(prefsSource).toContain(
      "events: ['invoice_ready', 'invoice_email_bounced', 'invoice_past_due']",
    )
  })
})
