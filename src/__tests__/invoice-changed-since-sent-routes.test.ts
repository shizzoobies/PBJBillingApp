import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

/**
 * Changing an invoice that was already sent (owner's answer 6, featreq-21d0bba8):
 * the "changed since sent" mark rides every response the editor merges back, and
 * a save that moves a sent invoice's total closes its open payment pages.
 *
 * SAME CAVEAT as invoice-coverage-routes.test.ts: `server.js` is not booted by
 * tests, so this reads its source (and runs the two small wrappers from it with
 * stubs). The decisions themselves - the mark, the total tag - are exercised on
 * both backends in db/store-staleness.test.mjs. What can rot HERE is the
 * wiring: a response that stops carrying the mark, an expiry that moves before
 * the commit it follows or fires on a note-only edit, or a Stripe hiccup that
 * turns a committed save into a 500.
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

const wrappers = sliceBetween(
  'async function withChangedSinceSent(',
  'async function expireInvoiceSessions(',
)
const listBlock = sliceBetween(
  '// GET /api/invoices?period=YYYY-MM',
  '// GET /api/invoice-recap?period=YYYY-MM',
)
const patchBlock = sliceBetween(
  'const invoicePatchMatch = normalizedPath.match(',
  '// POST /api/invoices/:id/confirm-coverage',
)

describe('the list carries the mark, in one call', () => {
  it('asks the store once for the whole list, after the covered-dates mark, never per invoice', () => {
    const coverage = listBlock.indexOf('appDataStore.withCoverageChangeable(invoices)')
    const mark = listBlock.indexOf('appDataStore.withChangedSinceSent(marked)')
    const answer = listBlock.indexOf('sendJson(response, 200, { invoices: marked })')
    expect(coverage).toBeGreaterThan(-1)
    expect(mark).toBeGreaterThan(coverage)
    expect(answer).toBeGreaterThan(mark)
    expect(listBlock.match(/withChangedSinceSent\(/g)).toHaveLength(1)
  })

  it('answers the list unmarked, and logs, when the mark fails', () => {
    const at = listBlock.indexOf('appDataStore.withChangedSinceSent(marked)')
    expect(listBlock.slice(Math.max(0, at - 60), at)).toContain('marked = await')
    const after = listBlock.slice(at, at + 260)
    expect(after).toContain('catch (error)')
    expect(after).toContain("console.error('[invoices] changed-since-sent mark failed on the list")
    // The past-due dashboard variant returns before any of it: it is not an
    // editor and reads six fields.
    expect(listBlock.indexOf("searchParams.get('pastDue') === '1'")).toBeLessThan(at)
  })
})

describe('every response the editor merges back carries the mark', () => {
  // The five single-invoice responses already go through `withCoverageChangeable`
  // (pinned in invoice-coverage-routes.test.ts); the mark rides that wrapper so
  // none of them can forget it.
  it('applies the mark inside the shared wrapper, before the covered-dates step', () => {
    const wrapper = wrappers.slice(wrappers.indexOf('async function withCoverageChangeable('))
    const mark = wrapper.indexOf('await withChangedSinceSent(invoice)')
    const coverage = wrapper.indexOf('appDataStore.withCoverageChangeable([invoice])')
    expect(mark).toBeGreaterThan(-1)
    expect(coverage).toBeGreaterThan(mark)
  })

  it('answers the save and the send through that wrapper', () => {
    expect(patchBlock).toContain('invoice: await withCoverageChangeable(updated)')
    expect(serverSource).toContain('sentInvoice = await withCoverageChangeable(sentInvoice)')
  })

  function build(store: { withChangedSinceSent: (list: unknown[]) => Promise<unknown[]>; withCoverageChangeable?: (list: unknown[]) => Promise<unknown[]> }) {
    const errors: unknown[][] = []
    const make = new Function(
      'appDataStore',
      'console',
      `${wrappers}\nreturn withCoverageChangeable`,
    )
    const wrap = make(
      { withCoverageChangeable: async (list: unknown[]) => list, ...store },
      { error: (...args: unknown[]) => errors.push(args) },
    )
    return { wrap, errors }
  }

  it('hands the invoice back marked', async () => {
    const { wrap } = build({
      withChangedSinceSent: async ([invoice]) => [{ ...(invoice as object), changedSinceSent: true }],
    })

    expect(await wrap({ id: 'inv-1', status: 'sent' })).toEqual({
      id: 'inv-1',
      status: 'sent',
      changedSinceSent: true,
    })
  })

  it('answers unmarked, and logs, when the mark read fails - never a rejection', async () => {
    const invoice = { id: 'inv-1', status: 'sent' }
    const { wrap, errors } = build({
      withChangedSinceSent: vi.fn(async () => {
        throw new Error('db is down')
      }),
    })

    await expect(wrap(invoice)).resolves.toBe(invoice)

    expect(errors).toHaveLength(1)
    expect(errors[0][0]).toBe('[invoices] changed-since-sent mark failed, answering unmarked:')
  })

  it('keeps the mark when the covered-dates step then fails', async () => {
    const { wrap } = build({
      withChangedSinceSent: async ([invoice]) => [{ ...(invoice as object), changedSinceSent: true }],
      withCoverageChangeable: async () => {
        throw new Error('ledger read failed')
      },
    })

    expect(await wrap({ id: 'inv-1', status: 'sent' })).toMatchObject({ changedSinceSent: true })
  })
})

describe('a save that changes a sent invoice\'s total closes its old payment pages', () => {
  const store = patchBlock.indexOf('appDataStore.updateInvoice(')
  const notFound = patchBlock.indexOf("sendJson(response, 404, { error: 'Invoice not found' })")
  const gate = patchBlock.indexOf('updated.wasSent && updated.totalChanged')
  const answer = patchBlock.indexOf('sendJson(response, 200, { invoice: await withCoverageChangeable(updated) })')

  it('sits after the store call and the 404 guard, and before the answer', () => {
    expect(store).toBeGreaterThan(-1)
    expect(notFound).toBeGreaterThan(store)
    expect(gate).toBeGreaterThan(notFound)
    expect(answer).toBeGreaterThan(gate)
  })

  it('fires only for an invoice that WAS sent when the save read it and whose total moved, through the shared helper, labeled as an edit', () => {
    const call = patchBlock.slice(gate, answer)
    expect(call).toContain('await expireInvoiceSessions(')
    expect(call).toContain('updated.stripeCheckoutSessionId')
    expect(call).toContain('updated.stripeCardSessionId')
    expect(call).toMatch(/'edit \(total changed on a sent invoice\)'/)
    // The tags are read off the store's own answer, not recomputed from the body.
    // And the status the save READ, not the one it left: a save that moves the
    // total and rewinds the status still leaves a live page at the old amount.
    expect(patchBlock).not.toContain('payload?.total')
    expect(call).not.toContain("updated.status === 'sent'")
    // No second copy of the loop, and no raw Stripe call that could throw.
    expect(patchBlock).not.toContain('expireCheckoutSession(')
  })

  it('cannot fail the request: the helper it uses logs and never throws', () => {
    const helper = sliceBetween('async function expireInvoiceSessions(', 'async function readInvoiceNow(')
    expect(helper).toContain('catch (error)')
    expect(helper).not.toContain('throw')
  })

  it('leaves the void expiry as it was, ahead of it', () => {
    const voidGate = patchBlock.indexOf("updated.status === 'void' && payload?.status === 'void'")
    expect(voidGate).toBeGreaterThan(notFound)
    expect(gate).toBeGreaterThan(voidGate)
  })
})

describe('an edit that lands while a send is in flight stops the send', () => {
  const sendBlock = sliceBetween(
    'const invoiceSendMatch = normalizedPath.match(',
    '// GET /api/invoices/export.csv',
  )
  const lastLook = sendBlock.indexOf('lastLook = await readInvoiceNow(invoice)')
  const check = sendBlock.indexOf('if (invoiceContentChanged(invoice, lastLook)) {')
  const email = sendBlock.indexOf('await sendInvoiceEmail(')

  it('compares what the email was built from with the re-read, after the void check and before the email', () => {
    expect(lastLook).toBeGreaterThan(-1)
    const voidCheck = sendBlock.indexOf("lastLook.status === 'void'")
    expect(voidCheck).toBeGreaterThan(lastLook)
    expect(check).toBeGreaterThan(voidCheck)
    expect(email).toBeGreaterThan(check)
  })

  it('retires what this request minted, sends and records nothing, and answers 409 invoice_changed', () => {
    const branch = sendBlock.slice(check, email)
    expect(branch).toContain('await expireInvoiceSessions(mintedSessionIds, invoice.id,')
    expect(branch).toContain('sendJson(response, 409, {')
    expect(branch).toContain("error: 'invoice_changed'")
    expect(branch).toContain(
      "message: 'This invoice changed while it was being sent. Nothing was emailed. Try sending again.'",
    )
    expect(branch).toContain('return')
    // Nothing is recorded or sent on that branch.
    expect(branch).not.toContain('recordInvoiceSent(')
    expect(branch).not.toContain('sendInvoiceEmail(')
    // Same code and sentence the route already uses for a live invoice that moved.
    expect(sendBlock.match(/error: 'invoice_changed'/g)?.length ?? 0).toBeGreaterThanOrEqual(1)
  })
})

describe('the client pay page re-checks the total after it stores its session', () => {
  const payBlock = sliceBetween(
    'const payLinkMatch = normalizedPath.match(',
    "if (normalizedPath === '/api/logout'",
  )
  const swap = payBlock.indexOf('appDataStore.swapInvoiceCheckoutSession(payInvoice.id')
  const reread = payBlock.indexOf('appDataStore.findInvoiceByPayToken(payToken)', swap)
  const redirect = payBlock.indexOf('Location: payResult.session.url')

  it('re-reads the invoice after the swap and before the redirect to Stripe', () => {
    expect(swap).toBeGreaterThan(-1)
    expect(reread).toBeGreaterThan(swap)
    expect(redirect).toBeGreaterThan(reread)
  })

  it('closes the session it just minted when the total moved, and goes round once', () => {
    const branch = payBlock.slice(reread, redirect)
    expect(branch).toContain('totalsDiffer(payInvoice.total, freshPayInvoice.total)')
    expect(branch).toContain('expireInvoiceSessions(')
    expect(branch).toContain('[payResult.session.id]')
    // One retry, marked in the query string; never a loop.
    expect(branch).toContain("requestUrl.searchParams.get('retry') !== '1'")
    expect(branch).toContain('Location: `${payPath}?retry=1`')
  })

  it('on the retry, a total that STILL differs is a "try again in a moment" page, not another redirect', () => {
    const branch = payBlock.slice(reread, redirect)
    const second = branch.indexOf('sendPayPage(')
    expect(second).toBeGreaterThan(branch.indexOf("'1'"))
    expect(branch.slice(second, second + 400)).toContain('We could not open the payment page')
    expect(branch.slice(second, second + 400)).toContain('503')
    // Exactly one redirect of its own (the retry); the second `writeHead(302`
    // the slice reaches is the redirect to Stripe that follows the branch.
    expect(branch.match(/Location: `\$\{payPath\}\?retry=1`/g)).toHaveLength(1)
    expect(branch.match(/writeHead\(302/g)).toHaveLength(2)
  })
})

describe('a covered-dates confirm names who made it', () => {
  it('passes the session user to the store, which records the edit on a sent invoice', () => {
    const confirm = sliceBetween(
      'const coverageConfirmMatch = normalizedPath.match(',
      '// POST /api/invoices/:id/ai-review',
    )
    expect(confirm).toContain('{ actorUserId: session.user.id }')
  })
})
