import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The autopay routes (featreq-bef42b72), pinned the way the pay-link routes are:
 * server.js listens at module scope and exports nothing, so this reads the
 * source. The store halves have real tests in db/store-staleness.test.mjs and
 * the payloads in lib/stripe-autopay.test.mjs; what is pinned HERE is the
 * ORDER and the gates of the routes that move or expose money.
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

const squash = (text: string) => text.replace(/\s+/g, ' ')

describe('GET /api/autopay (the owner’s panel)', () => {
  const block = sliceBetween(
    "normalizedPath === '/api/autopay' && request.method === 'GET'",
    '// POST /api/clients/:id/autopay/invite',
  )

  it('is owner-only', () => {
    expect(block).toContain("session.user.role !== 'owner'")
    expect(block).toContain('sendJson(response, 403')
    expect(block.indexOf('403')).toBeLessThan(block.indexOf('listClientAutopay'))
  })

  it('answers summaries only, never the stored rows', () => {
    expect(squash(block)).toContain('.map(autopaySummary)')
    expect(block).not.toContain('setupToken')
  })
})

describe('what a team member is sent', () => {
  it('the file backend’s whole-file read is stripped of both autopay tables for staff', () => {
    const scope = sliceBetween('function scopeAppDataForSession(', 'Soft-deleted team members are owner-only')
    expect(scope).toContain('clientAutopay: undefined')
    expect(scope).toContain('autopayAttempts: undefined')
  })
})

/**
 * COMMIT 2 OF 3 CHARGES NOTHING. Enrollment (invite, the client's setup page,
 * the setup webhooks, withdrawal) is the part that can ship on its own; every
 * route and branch below is checked for the absence of anything that moves
 * money, so a later edit cannot quietly smuggle a charge in through the door
 * that only ever saved a bank account.
 */
describe('enrollment routes move no money', () => {
  const ownerRoutes = sliceBetween(
    'const autopayActionMatch = normalizedPath.match(',
    '// POST /api/stripe/webhook',
  )
  const publicRoutes = sliceBetween(
    'const autopayLinkMatch = normalizedPath.match(',
    '// ---- GET /pay/:token',
  )
  const setupBranch = sliceBetween(
    'if (classifySetupEvent(event)) {',
    'const object = event.data?.object ?? {}',
  )

  it.each([
    ['the owner routes', ownerRoutes],
    ['the client page', publicRoutes],
    ['the setup webhook branch', setupBranch],
  ])('%s never touch an invoice, a PaymentIntent or an attempt', (_name, block) => {
    for (const forbidden of [
      'applyInvoicePayment',
      'applyPayment(',
      'paymentIntents',
      'claimAutopayAttempt',
      'updateAutopayAttempt',
      'recordInvoiceSent',
      'swapInvoiceCheckoutSession',
    ]) {
      expect(block, `${forbidden} has no business in enrollment`).not.toContain(forbidden)
    }
  })
})

describe('POST /api/clients/:id/autopay/(invite|turn-off)', () => {
  const block = sliceBetween(
    'const autopayActionMatch = normalizedPath.match(',
    '// POST /api/stripe/webhook',
  )

  it('is owner-only, same-origin and JSON, in that order, before anything is read', () => {
    const owner = block.indexOf("session.user.role !== 'owner'")
    const origin = block.indexOf('isCrossSiteOrigin(request)')
    const json = block.indexOf("'application/json required'")
    expect(owner).toBeGreaterThan(-1)
    expect(owner).toBeLessThan(origin)
    expect(origin).toBeLessThan(json)
    expect(json).toBeLessThan(block.indexOf('getClientById('))
  })

  it('refuses an opted-out client, a sub on a combined invoice, and an enrolled client before any Stripe call or email', () => {
    const customerAt = block.indexOf('ensureStripeCustomer(')
    const emailAt = block.indexOf('sendInvoiceEmail(')
    for (const refusal of [
      "error: 'client_opted_out'",
      "error: 'autopay_on_master'",
      "error: 'already_enrolled'",
      "error: 'invoice_no_recipient'",
    ]) {
      const at = block.indexOf(refusal)
      expect(at, `${refusal} is gone`).toBeGreaterThan(-1)
      expect(at).toBeLessThan(customerAt)
      expect(at).toBeLessThan(emailAt)
    }
    expect(block).toContain('inviteAddressee.refusal')
  })

  it('writes the invited row before the email, and puts the old row back if the email fails', () => {
    const wroteAt = block.indexOf("status: 'invited'")
    const emailAt = block.indexOf('sendInvoiceEmail(')
    expect(wroteAt).toBeLessThan(emailAt)
    const failure = block.slice(block.indexOf('if (!inviteResult.ok) {'))
    expect(failure).toContain('priorAutopay?.status ?? ')
    expect(failure.indexOf('updateClientAutopay')).toBeLessThan(failure.indexOf('502'))
  })

  it('the owner turning it off goes through turnOffAutopay', () => {
    expect(squash(block)).toContain("by: 'owner'")
    expect(block).toContain('turnOffAutopay({')
  })
})

describe('/autopay/:token (the client page)', () => {
  const block = sliceBetween(
    'const autopayLinkMatch = normalizedPath.match(',
    '// ---- GET /pay/:token',
  )

  it('allows only GET and HEAD, and POST on the withdraw path alone', () => {
    expect(block).toContain("isWithdrawPath ? ['GET', 'HEAD', 'POST'] : ['GET', 'HEAD']")
    expect(block).toContain('405')
  })

  it('a HEAD mints nothing and changes nothing', () => {
    const head = block.indexOf("request.method === 'HEAD'")
    expect(head).toBeGreaterThan(-1)
    for (const later of ['ensureStripeCustomer(', 'createAutopaySetupSession(', 'turnOffAutopay(']) {
      expect(head).toBeLessThan(block.indexOf(later))
    }
  })

  it('looks the token up only after the shape check and the IP rate limit', () => {
    const shape = block.indexOf('[A-Za-z0-9_-]{20,64}')
    const limit = block.indexOf('apip:')
    const lookup = block.indexOf('findClientAutopayByToken(')
    expect(shape).toBeLessThan(limit)
    expect(limit).toBeLessThan(lookup)
  })

  // A mail scanner opens every link in a message. Only the POST may withdraw.
  it('a GET on the withdraw path only shows the confirm page; only the POST turns it off', () => {
    const withdrawBranch = block.slice(block.indexOf('if (isWithdrawPath) {'))
    const showAt = withdrawBranch.indexOf("request.method === 'GET'")
    const showReturn = withdrawBranch.indexOf('return', showAt)
    const actAt = withdrawBranch.indexOf('turnOffAutopay(')
    expect(showAt).toBeGreaterThan(-1)
    expect(showReturn).toBeLessThan(actAt)
    expect(withdrawBranch.slice(showAt, showReturn)).toContain('renderAutopayWithdrawPage')
  })

  it('the confirm page posts to the withdraw path', () => {
    const page = sliceBetween('function renderAutopayWithdrawPage(', '// ---- Invoice confidence ratings')
    expect(page).toContain('<form method="POST" action="/autopay/${safeToken}/withdraw">')
  })

  it('the owners are told when a client withdraws, and only if something changed', () => {
    const withdrawn = block.slice(block.indexOf('turnOffAutopay('))
    expect(withdrawn.indexOf('withdrawn.changed')).toBeLessThan(
      withdrawn.indexOf("'autopay_withdrawn'"),
    )
  })

  it('every page sets the pay-page headers (never cached, never framed)', () => {
    expect(block).not.toContain('response.writeHead(200')
    expect(block).toContain('...PAY_RESPONSE_HEADERS')
  })
})

describe('the Stripe webhook and setup events', () => {
  const webhook = sliceBetween(
    "normalizedPath === '/api/stripe/webhook' && request.method === 'POST'",
    "normalizedPath === '/api/resend/webhook'",
  )

  it('recognizes a setup event after the ledger and BEFORE the invoice lookup', () => {
    const ledgered = webhook.indexOf('recordStripeEventOnce(')
    const classified = webhook.indexOf('classifySetupEvent(event)')
    const lookup = webhook.indexOf('findInvoiceByStripeRef(')
    expect(ledgered).toBeGreaterThan(-1)
    expect(ledgered).toBeLessThan(classified)
    expect(classified).toBeLessThan(lookup)
  })

  // The catch below forgets the event when nothing was applied, so a failed
  // enrollment write is retried by Stripe rather than answered "duplicate".
  it('the setup branch sits inside the try whose catch takes the event back out of the ledger', () => {
    const tryAt = webhook.lastIndexOf('try {', webhook.indexOf('classifySetupEvent(event)'))
    const catchAt = webhook.indexOf('} catch (error) {', tryAt)
    expect(catchAt).toBeGreaterThan(webhook.indexOf('classifySetupEvent(event)'))
    expect(webhook.slice(catchAt)).toContain('forgetStripeEvent(event.id)')
    expect(webhook.slice(catchAt)).toContain('if (!paymentApplied)')
  })

  it('acknowledges every event it has no use for with a 200', () => {
    expect(squash(webhook)).toContain('sendJson(response, 200, { received: true, matched: false })')
    expect(webhook).toContain('sendJson(response, 200, { received: true })')
  })
})
