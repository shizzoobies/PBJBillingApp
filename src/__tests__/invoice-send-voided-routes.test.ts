import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

/**
 * A void that lands before an invoice's email leaves stops the send
 * (featreq-051122e4).
 *
 * `swapInvoiceCheckoutSession` answers null when it finds no live row to swap
 * into. The send route used to carry on: it emailed a voided invoice, and the
 * Stripe session it had just minted was never stored, so nothing could ever
 * expire it. Now:
 *
 *   - a null swap re-reads the invoice. Null does NOT always mean void (the
 *     whole-workspace save deletes and re-inserts every invoice in one
 *     transaction, and a swap waiting on it finds no row for a good invoice):
 *     gone or void answers 409 `invoice_voided`, a still-live invoice answers
 *     409 `invoice_changed`. Nothing is emailed either way, and only the
 *     sessions that are safe to retire are expired.
 *   - immediately before the provider call the status is read once more, which
 *     also covers an invoice that had no swap at all (zero total, settled,
 *     Stripe not connected). The instant between that read and the provider
 *     call is not covered.
 *
 * SAME CAVEAT as invoice-send-stamp-routes.test.ts: `server.js` is not booted by
 * tests, so the answers are exercised by running the real helpers' source with
 * stubs, and the wiring (both swap sites, the last look, before anything is
 * built or emailed) by reading the route. A failure means "the routing moved".
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
)

function sliceBetween(from: string, to: string) {
  const start = serverSource.indexOf(from)
  expect(start, `${from} is gone from server.js`).toBeGreaterThan(-1)
  const end = serverSource.indexOf(to, start + from.length)
  expect(end, `${to} no longer follows ${from}`).toBeGreaterThan(start)
  return serverSource.slice(start, end)
}

// The three helpers sit together, ahead of `loadRateVersions`.
const helperSource = sliceBetween('async function readInvoiceNow(', 'async function loadRateVersions(')

const route = sliceBetween(
  'const invoiceSendMatch = normalizedPath.match(',
  '// GET /api/invoices/export.csv',
)

const squash = (text: string) => text.replace(/\s+/g, ' ')

const VOIDED_BODY = {
  error: 'invoice_voided',
  message: 'This invoice was voided while it was being sent. Nothing was emailed.',
}
const CHANGED_BODY = {
  error: 'invoice_changed',
  message: 'This invoice changed while it was being sent. Nothing was emailed. Try sending again.',
}

const invoice = { id: 'inv-1', period: '2026-09', status: 'reviewed' }

function harness(listInvoices: () => Promise<unknown[]>) {
  const expireInvoiceSessions = vi.fn(async () => undefined)
  const sendJson = vi.fn()
  const errors: unknown[][] = []
  const listInvoicesStub = vi.fn(listInvoices)
  const make = new Function(
    'expireInvoiceSessions',
    'sendJson',
    'appDataStore',
    'console',
    `${helperSource}\nreturn { refuseSendVoidedMidSend, refuseSendOnNullSwap }`,
  )
  const helpers = make(
    expireInvoiceSessions,
    sendJson,
    { listInvoices: listInvoicesStub },
    { error: (...args: unknown[]) => errors.push(args) },
  )
  const response = {}
  return { helpers, expireInvoiceSessions, sendJson, response, errors, listInvoicesStub }
}

describe('the refusal a void mid-send gets', () => {
  it('expires what this request minted, labeled as a send, and answers 409 invoice_voided', async () => {
    const { helpers, expireInvoiceSessions, sendJson, response } = harness(async () => [])

    await helpers.refuseSendVoidedMidSend(response, 'inv-1', ['cs_ach', 'cs_card'])

    expect(expireInvoiceSessions).toHaveBeenCalledOnce()
    expect(expireInvoiceSessions).toHaveBeenCalledWith(
      ['cs_ach', 'cs_card'],
      'inv-1',
      expect.stringContaining('send'),
    )
    expect(sendJson).toHaveBeenCalledOnce()
    expect(sendJson).toHaveBeenCalledWith(response, 409, VOIDED_BODY)
  })
})

describe('a refused swap re-reads the invoice before deciding what it was', () => {
  it('reads that invoice\'s own month', async () => {
    const { helpers, response, listInvoicesStub } = harness(async () => [invoice])

    await helpers.refuseSendOnNullSwap(response, invoice, { unstored: ['cs_ach'] })

    expect(listInvoicesStub).toHaveBeenCalledWith({ period: '2026-09' })
  })

  it('void: invoice_voided, and everything minted is expired, the stored session too', async () => {
    const { helpers, expireInvoiceSessions, sendJson, response } = harness(async () => [
      { ...invoice, status: 'void' },
    ])

    await helpers.refuseSendOnNullSwap(response, invoice, {
      unstored: ['cs_card'],
      stored: ['cs_ach'],
    })

    expect(expireInvoiceSessions).toHaveBeenCalledOnce()
    expect(expireInvoiceSessions).toHaveBeenCalledWith(
      ['cs_ach', 'cs_card'],
      'inv-1',
      expect.stringContaining('send'),
    )
    expect(sendJson).toHaveBeenCalledWith(response, 409, VOIDED_BODY)
  })

  it('gone: treated as void', async () => {
    const { helpers, expireInvoiceSessions, sendJson, response } = harness(async () => [
      { id: 'some-other-invoice', period: '2026-09', status: 'sent' },
    ])

    await helpers.refuseSendOnNullSwap(response, invoice, { unstored: ['cs_ach'] })

    expect(expireInvoiceSessions).toHaveBeenCalledWith(['cs_ach'], 'inv-1', expect.any(String))
    expect(sendJson).toHaveBeenCalledWith(response, 409, VOIDED_BODY)
  })

  it('still live (a workspace save hid the row): invoice_changed, and ONLY the never-stored session is expired', async () => {
    const { helpers, expireInvoiceSessions, sendJson, response } = harness(async () => [invoice])

    // The card swap came back null after the bank swap succeeded: the bank
    // session is stored on a valid invoice and must stay live.
    await helpers.refuseSendOnNullSwap(response, invoice, {
      unstored: ['cs_card'],
      stored: ['cs_ach'],
    })

    expect(expireInvoiceSessions).toHaveBeenCalledOnce()
    expect(expireInvoiceSessions).toHaveBeenCalledWith(['cs_card'], 'inv-1', expect.any(String))
    expect(sendJson).toHaveBeenCalledOnce()
    expect(sendJson).toHaveBeenCalledWith(response, 409, CHANGED_BODY)
  })

  it('a failed re-read sends nothing, expires only the never-stored session, and says it could not confirm', async () => {
    const { helpers, expireInvoiceSessions, sendJson, response, errors } = harness(async () => {
      throw new Error('db is down')
    })

    await expect(
      helpers.refuseSendOnNullSwap(response, invoice, { unstored: ['cs_card'], stored: ['cs_ach'] }),
    ).resolves.toBeUndefined()

    expect(expireInvoiceSessions).toHaveBeenCalledOnce()
    expect(expireInvoiceSessions).toHaveBeenCalledWith(['cs_card'], 'inv-1', expect.any(String))
    expect(sendJson).toHaveBeenCalledWith(response, 502, {
      error: 'invoice_send_failed',
      message: 'Could not confirm the invoice before sending, so nothing was emailed. Try again.',
    })
    expect(errors).toHaveLength(1)
  })
})

describe('the send route stops at a null swap, at both call sites', () => {
  it('the bank swap: a null answer hands its never-stored session to the re-read and returns', () => {
    const swapAt = route.indexOf("channel: 'ach',")
    expect(swapAt).toBeGreaterThan(-1)
    const after = squash(route.slice(swapAt, swapAt + 1800))
    expect(after).toContain(
      'if (!sendSwap) { await refuseSendOnNullSwap(response, invoice, { unstored: [linkResult.session.id], }) return }',
    )
  })

  it('the card swap: its session is the unstored one, the bank session is the stored one', () => {
    const swapAt = route.indexOf("channel: 'card',")
    expect(swapAt).toBeGreaterThan(-1)
    const after = squash(route.slice(swapAt, swapAt + 1800))
    expect(after).toContain(
      'if (!cardSwap) { await refuseSendOnNullSwap(response, invoice, { unstored: [cardResult.session.id], stored: [linkResult.session.id], }) return }',
    )
  })

  it('records the sessions this request minted, for the last look below', () => {
    expect(route).toContain('const mintedSessionIds = []')
    expect(route).toContain('mintedSessionIds.push(linkResult.session.id)')
    expect(route).toContain('mintedSessionIds.push(cardResult.session.id)')
  })

  it('the old optional chaining, which let a null swap fall through, is gone', () => {
    expect(route).not.toContain('sendSwap?.previous')
    expect(route).not.toContain('cardSwap?.previous')
  })
})

describe('the send route looks once more immediately before the email leaves', () => {
  const lastLookAt = route.indexOf('lastLook = await readInvoiceNow(invoice)')
  const providerAt = route.indexOf('const sendResult = await sendInvoiceEmail({')

  it('reads the invoice after the documents are built and before the provider call', () => {
    expect(lastLookAt).toBeGreaterThan(-1)
    expect(providerAt).toBeGreaterThan(lastLookAt)
    expect(route.indexOf('buildInvoicePdf({')).toBeLessThan(lastLookAt)
    expect(route.indexOf('buildInvoiceEmail({')).toBeLessThan(lastLookAt)
  })

  it('a void (or a vanished invoice) retires this request\'s sessions and returns before the provider call', () => {
    const between = squash(route.slice(lastLookAt, providerAt))
    expect(between).toContain(
      "if (!lastLook || lastLook.status === 'void') { await refuseSendVoidedMidSend(response, invoice.id, mintedSessionIds) return }",
    )
  })

  it('a failed read sends nothing and answers the route\'s existing could-not-send failure', () => {
    const between = squash(route.slice(lastLookAt, providerAt))
    expect(between).toContain('} catch (error) {')
    expect(between).toMatch(/sendJson\(response, 502, \{ error: 'invoice_send_failed',/)
    // The read is inside the try, so a rejection cannot escape unhandled.
    expect(route.slice(lastLookAt - 40, lastLookAt)).toContain('try {')
  })

  it('no email, PDF or send record is reachable after either swap refusal', () => {
    const bankGuard = route.indexOf('if (!sendSwap)')
    const cardGuard = route.indexOf('if (!cardSwap)')
    expect(bankGuard).toBeGreaterThan(-1)
    expect(cardGuard).toBeGreaterThan(bankGuard)
    for (const later of [
      'buildInvoiceDocuments({',
      'await sendInvoiceEmail({',
      'recordInvoiceSent(',
    ]) {
      expect(route.indexOf(later), `${later} moved above a guard`).toBeGreaterThan(cardGuard)
    }
  })

  it('records nothing before the provider call, and the last look sits above every record', () => {
    expect(route.indexOf('recordInvoiceSent(')).toBeGreaterThan(providerAt)
  })
})

describe('the top-of-route refusal for an already voided invoice carries the code too', () => {
  it('answers invoice_voided with the sentence as the message, so the month run reloads on it', () => {
    expect(squash(route)).toContain(
      "if (invoice.status === 'void') { sendJson(response, 409, { error: 'invoice_voided', message: 'This invoice is voided, so it cannot be sent.', }) return }",
    )
  })
})
