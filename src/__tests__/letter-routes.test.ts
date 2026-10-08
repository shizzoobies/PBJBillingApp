import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The engagement-letter endpoints' GLUE (featreq-5e195707).
 *
 * Same shape as proposal-routes.test.ts and for the same reason: `server.js`
 * calls `server.listen()` at module scope and exports nothing, so there is no
 * HTTP harness. The behavior lives in lib/ (letter-template, letter-documents,
 * notify) and in the store (db/store-staleness.test.mjs, both backends); what
 * is pinned here is the wiring - an owner gate deleted, an origin guard dropped,
 * a claim moved after the provider call, a copy of the letter sent to someone
 * who is not the client.
 *
 * Treat a failure here as "the routing moved, go look".
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
)

/** The body of a route block, from its opening guard onward. */
function routeBlock(startPattern: RegExp, length = 2200): string {
  const at = serverSource.search(startPattern)
  expect(at, `route not found: ${startPattern}`).toBeGreaterThan(-1)
  return serverSource.slice(at, at + length)
}

const libSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../lib/letter-send.js'),
  'utf8',
)

/** The text from one anchor to the next one after it, in server.js or (with `source`) the lib. */
function between(startAnchor: string, endAnchor: string, source = serverSource): string {
  const start = source.indexOf(startAnchor)
  expect(start, `${startAnchor} is gone`).toBeGreaterThan(-1)
  const end = source.indexOf(endAnchor, start + startAnchor.length)
  expect(end, `${endAnchor} is gone`).toBeGreaterThan(start)
  return source.slice(start, end)
}

type Route = { name: string; pattern: RegExp; write: boolean; broadcastLength?: number }

/** Owner-only on every route; same-origin, JSON and a broadcast on every write. */
function pinOwnerRoutes(routes: Route[]) {
  for (const route of routes) {
    it(`${route.name} requires a session and refuses a non-owner`, () => {
      const block = routeBlock(route.pattern)
      expect(block).toContain('await requireSession(request, response)')
      expect(block).toMatch(/session\.user\.role !== 'owner'/)
      expect(block).toMatch(/sendJson\(response, 403,/)
    })

    if (route.write) {
      it(`${route.name} blocks a cross-site request and wants JSON`, () => {
        const block = routeBlock(route.pattern)
        expect(block).toContain('isCrossSiteOrigin(request)')
        expect(block).toContain("sendJson(response, 403, { error: 'Origin not allowed' })")
        expect(block).toContain('isJsonContentType(request)')
      })

      it(`${route.name} tells the other sessions`, () => {
        expect(routeBlock(route.pattern, route.broadcastLength ?? 3000)).toContain(
          'broadcastDataChanged()',
        )
      })
    }
  }

  it('every route sits above the /api/ catch-all', () => {
    const guardAt = serverSource.indexOf("if (normalizedPath.startsWith('/api/')) {")
    expect(guardAt, 'the /api/ catch-all guard is gone').toBeGreaterThan(-1)
    for (const route of routes) {
      expect(serverSource.search(route.pattern), `${route.name} is unreachable`).toBeLessThan(guardAt)
    }
  })
}

/** Every route of the feature, from the first to the last. */
const routesBlock = () =>
  between('// ---- Engagement letters (featreq-5e195707) ---', '// ---- Proposal questionnaires (owner)')
/** The preview half: the two routes and the builder they share with Send. */
const previewRoutes = () => between('// GET /api/letters/preview?clientId=', '// GET /api/letters/sends')
const previewAssembly = () =>
  between('export async function assembleLetterPreview(', 'export async function sendOneLetter(', libSource)
/** The send half: the route, and the one-client function it loops over. */
const sendRoute = () => between('// POST /api/letters/send', '// ---- Proposal questionnaires (owner)')
const sendOne = () =>
  between('export async function sendOneLetter(', 'export async function sendLetterBatch(', libSource)
const sendBatch = () => libSource.slice(libSource.indexOf('export async function sendLetterBatch('))
/** The server's half of the helpers, plus the whole lib file: every line of the letter code. */
const serverHelpers = () =>
  between('// ---- Engagement letters: helpers (featreq-5e195707)', '// ---- end of the engagement letter helpers')
const helpers = () => serverHelpers() + libSource

describe('the letter routes are owner-only, same-origin and above the catch-all', () => {
  pinOwnerRoutes([
    {
      name: 'GET /api/letters/template',
      pattern: /normalizedPath === '\/api\/letters\/template' && request\.method === 'GET'/,
      write: false,
    },
    {
      name: 'PUT /api/letters/template',
      pattern: /normalizedPath === '\/api\/letters\/template' && request\.method === 'PUT'/,
      write: true,
    },
    {
      name: 'GET /api/letters/preview',
      pattern: /normalizedPath === '\/api\/letters\/preview' && request\.method === 'GET'/,
      write: false,
    },
    {
      name: 'GET /api/letters/preview.pdf',
      pattern: /normalizedPath === '\/api\/letters\/preview\.pdf' && request\.method === 'GET'/,
      write: false,
    },
    {
      name: 'GET /api/letters/sends',
      pattern: /normalizedPath === '\/api\/letters\/sends' && request\.method === 'GET'/,
      write: false,
    },
    {
      name: 'POST /api/letters/send',
      pattern: /normalizedPath === '\/api\/letters\/send' && request\.method === 'POST'/,
      write: true,
      broadcastLength: 12000,
    },
  ])

  it('nothing here goes near the bulk save', () => {
    for (const text of [routesBlock(), helpers()]) {
      expect(text).not.toContain('appDataStore.write(')
    }
  })

  it('the template PUT saves through the store and records the save', () => {
    const block = routeBlock(/normalizedPath === '\/api\/letters\/template' && request\.method === 'PUT'/, 3200)
    expect(block).toContain('appDataStore.saveEngagementLetter({')
    expect(block).toContain("'engagement_letter_saved'")
    // A refused shape is a 400 with the sentence, before the store is touched.
    expect(block.indexOf('letter_invalid')).toBeLessThan(block.indexOf('saveEngagementLetter('))
  })
})

// What she previews is what is sent, so nothing in the preview may have a side effect.
const NEVER_IN_A_PREVIEW = [
  'sendInvoiceEmail',
  'claimEngagementLetterSend',
  'completeEngagementLetterSend',
  'nextEngagementLetterAttempt',
  'saveEngagementLetter',
  'recordActivity',
  'broadcastDataChanged',
  'recordInvoiceSent',
  'notify(',
  'letterPause',
]

describe('the preview routes', () => {
  it('build from the STORED template through the shared document builder', () => {
    expect(previewRoutes()).toContain('loadLetterContext(session)')
    expect(serverHelpers()).toContain('appDataStore.getEngagementLetter(LETTER_ID)')
    expect(previewAssembly()).toContain('buildLetterDocuments({')
    expect(previewAssembly()).toContain('invoiceEmailAddressee(client, clients)')
    expect(previewAssembly()).toContain('resolveInvoiceRecipients({')
    // The send loop uses the very same assembler.
    expect(sendOne()).toContain('await assembleLetterPreview(context, clientId)')
  })

  it('send, claim, save and record nothing', () => {
    for (const forbidden of NEVER_IN_A_PREVIEW) {
      expect(previewRoutes(), `${forbidden} must not run in a preview`).not.toContain(forbidden)
      expect(previewAssembly(), `${forbidden} must not run in a preview`).not.toContain(forbidden)
    }
  })

  it('stream the PDF inline and uncached, and answer 502 pdf_failed when it did not build', () => {
    const body = previewRoutes()
    expect(body).toContain("'Content-Type': 'application/pdf'")
    expect(body).toContain("'Cache-Control': 'no-store'")
    expect(body).toContain("error: 'pdf_failed'")
    expect(body).toContain("sendJson(response, 502,")
  })

  it('answer what the page needs to explain a refusal', () => {
    const body = previewRoutes()
    for (const field of [
      'recipientDetails: preview.details',
      'recipientNote: preview.recipientNote',
      'pdfAvailable: Boolean(preview.docs.pdf)',
      'missing: preview.missing',
      'missingNote: preview.missingNote',
      'unknown: preview.unknown',
      'flags: preview.flags',
      'refusal: preview.refusal',
    ]) {
      expect(body).toContain(field)
    }
  })

  it('show the invoice delivery switches as flags, never as a refusal', () => {
    const assembly = previewAssembly()
    expect(assembly).toContain('neverEmailed: Boolean(client.invoiceNoEmail)')
    expect(assembly).toContain('billedOutside: Boolean(client.platformInvoicingOptOut)')
    expect(sendOne()).not.toContain('invoiceNoEmail')
    expect(sendOne()).not.toContain('platformInvoicingOptOut')
  })
})

describe('the send refuses the whole batch before the first client', () => {
  const route = () => sendRoute()
  const at = (needle: string) => {
    const index = route().indexOf(needle)
    expect(index, `${needle} is missing from the send route`).toBeGreaterThan(-1)
    return index
  }

  it('checks the hash, then unknown placeholders, then an empty letter, then email configuration, in that order', () => {
    const order = [
      "error: 'letter_changed'",
      "error: 'unknown_placeholder'",
      "error: 'letter_empty'",
      "error: 'letter_send_failed'",
    ].map(at)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(order[3]).toBeLessThan(at('await sendLetterBatch('))
  })

  it('compares the page hash with the STORED template hash, and says nothing was sent', () => {
    const body = route()
    expect(body).toContain('const templateHash = letterTemplateHash(context.template)')
    expect(body).toContain('payload.templateHash !== templateHash')
    expect(body).toContain(
      'The letter changed since this page loaded. Nothing was sent. Reload and send again.',
    )
    expect(body).toContain('is not a placeholder the app fills in')
    expect(body).toContain('Nothing was sent.')
    expect(body).toContain('Write the email and the letter before sending.')
    expect(body).toContain('Email is not configured yet (no sending address set).')
  })

  // {{hourly_rate}} can never resolve; a letter that still names it must not go out with a hole in it.
  it('refuses an unknown OR retired placeholder the same way, before any client is claimed or mailed', () => {
    const body = route()
    expect(body).toContain('const { unknown: unknownPlaceholders, retired: retiredPlaceholderKeys } = templateWarnings(context.template)')
    expect(body).toContain('if (unknownPlaceholders.length > 0 || retiredPlaceholderKeys.length > 0) {')
    expect(body).toContain('if (retiredPlaceholderKeys.length > 0) sentences.push(retiredSentence(retiredPlaceholderKeys))')
    expect(body).toContain("error: 'unknown_placeholder',")
    expect(body).toContain('message: `${sentences.join(\'. \')}. Nothing was sent.`,')
    expect(at("error: 'unknown_placeholder'")).toBeLessThan(at('await sendLetterBatch('))
    expect(at('retired: retiredPlaceholderKeys,')).toBeLessThan(at('await sendLetterBatch('))
    // The preview carries it so the owner sees it before sending.
    expect(previewRoutes()).toContain('retired: preview.retired,')
  })

  it('takes 1 to 50 clients and refuses a body outside that with a 400 before anything else', () => {
    const body = route()
    expect(libSource).toContain('export const LETTER_MAX_CLIENTS_PER_SEND = 50')
    expect(body).toContain('payload.clientIds.length > LETTER_MAX_CLIENTS_PER_SEND')
    expect(at("error: 'letter_invalid'")).toBeLessThan(at("error: 'letter_changed'"))
  })

  it('always answers 200 once the loop started, and logs the run', () => {
    const body = route()
    const loopAt = at('await sendLetterBatch(')
    const after = body.slice(loopAt)
    expect(after).toContain('sendJson(response, 200, { results, sent, failed, skipped })')
    // No error status after the first client has been handled: some mail has left.
    expect(after).not.toMatch(/sendJson\(response, (4|5)\d\d,/)
    expect(after).toContain("'engagement_letters_sent'")
    expect(after).toContain('broadcastDataChanged()')
    expect(after.indexOf("'engagement_letters_sent'")).toBeLessThan(after.indexOf('sendJson(response, 200'))
  })

  it('spaces provider calls 600 ms apart', () => {
    expect(libSource).toContain('export const LETTER_SEND_GAP_MS = 600')
    expect(sendBatch()).toContain('await deps.pause(LETTER_SEND_GAP_MS)')
    expect(route()).toContain('pause: letterPause')
  })
})

describe('sending to one client', () => {
  it('decides every refusal, then builds on the claim BEFORE the provider is called', () => {
    const body = sendOne()
    const order = [
      "code: 'not_found'",
      "code: 'no_addressee'",
      "code: 'no_recipients'",
      "code: 'missing_placeholder'",
      "code: 'pdf_failed'",
      'deps.store.claimEngagementLetterSend({',
      "code: 'already_sent'",
      'await deps.sendMail(mail)',
      'deps.store.completeEngagementLetterSend(claim.send.id, {',
    ].map((needle) => {
      const index = body.indexOf(needle)
      expect(index, `${needle} is missing`).toBeGreaterThan(-1)
      return index
    })
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('sends only through sendInvoiceEmail, with the PDF, the send-log id and the letter kind', () => {
    const body = sendOne()
    expect(body.match(/deps\.sendMail\(/g)).toHaveLength(2) // the send and its one 429 retry
    expect(body).toContain('attachments: [{ filename: preview.docs.pdfFilename, content: preview.docs.pdf }]')
    expect(body).toContain('letterSendId: claim.send.id')
    expect(body).toContain("kind: 'letter'")
    expect(body).toContain('to: preview.to')
  })

  it('waits 1,500 ms and retries once on a 429', () => {
    const body = sendOne()
    expect(libSource).toContain('export const LETTER_RATE_LIMIT_WAIT_MS = 1500')
    expect(body).toContain('sendResult.status === 429')
    expect(body).toContain('await deps.pause(LETTER_RATE_LIMIT_WAIT_MS)')
  })

  it('claims attempt 1, or the next attempt for "Send again", for the firm day and the template hash', () => {
    const body = sendOne()
    expect(body).toContain('const attempt = resend')
    expect(body).toContain('deps.store.nextEngagementLetterAttempt({ letterId: LETTER_ID, clientId, templateHash, firmDay })')
    expect(sendRoute()).toContain('firmDay: firmToday(context.now),')
    expect(sendRoute()).toContain('resend: payload.resendToday === true')
  })

  it('closes the claim in a try/catch so bookkeeping can never turn a delivered email into a failure', () => {
    const body = sendOne()
    const completeAt = body.indexOf('await deps.store.completeEngagementLetterSend(claim.send.id, {')
    expect(body.slice(Math.max(0, completeAt - 40), completeAt)).toContain('try {')
    expect(body).toContain('could not close the send log row')
    // ...and a claim is never left open by an unexpected throw.
    expect(body).toContain('{ ok: false, error: \'The send did not finish.\' }')
  })
})

describe('a letter goes to the client and nowhere else (Alex, 2026-10-08)', () => {
  const FORBIDDEN = [
    'notify(',
    'notifyOwners',
    'notifyOwner',
    'sendDigestEmail',
    'sendReportEmail',
    'sendFeatureRequestEmail',
    'bcc',
    'Bcc',
    'BCC',
    'cc:',
    'OWNER_EMAIL_COPY',
    'recordInvoiceSent',
  ]

  it('has no owner notification and no copy anywhere in the routes or the helpers', () => {
    for (const text of [routesBlock(), helpers()]) {
      for (const forbidden of FORBIDDEN) {
        expect(text, `${forbidden} must not appear in the letter code`).not.toContain(forbidden)
      }
    }
  })

  it('addresses the mail to the resolved addressees only, and replies go to the invoice mailbox', () => {
    const body = sendOne()
    expect(body.match(/\bto: /g)).toBeTruthy()
    expect(serverHelpers()).toContain('process.env.INVOICE_REPLY_TO || process.env.OWNER_EMAIL')
    // The only call that sends mail in the whole letter code.
    // The server only HANDS the sender over (one reference, never called there); the lib calls it twice.
    const all = routesBlock() + serverHelpers()
    expect(all).not.toMatch(/sendInvoiceEmail\(/)
    expect(all.match(/sendMail: sendInvoiceEmail\b/g)).toHaveLength(1)
    expect(libSource.match(/deps\.sendMail\(/g)).toHaveLength(2)
    expect(all).not.toMatch(/\bsend[A-Z]\w*Email\((?!mail\))/)
  })

  it('reads the addresses of the team once, fails closed, and hands them to the builder with the reply-to', () => {
    const body = serverHelpers().slice(serverHelpers().indexOf('async function loadLetterContext('))
    expect(body).toContain('appDataStore.getTeamMembers()')
    expect(body).toContain('teamEmails: new Set(')
    expect(body).toContain('.toLowerCase()')
    expect(body).toContain('replyTo: letterSender(firmSettings).replyTo')
    // No catch on that read: if the team cannot be read nothing is previewed or sent.
    expect(body.slice(0, body.indexOf('teamEmails:'))).not.toContain('.catch(() => [])')
    // ...and the builder drops those addresses, the reply-to mailbox excepted.
    expect(previewAssembly()).toContain('withoutTeamAddresses(resolved.details, context.teamEmails, context.replyTo)')
  })

  it('hands the page the team addresses, reply-to excepted, so the list shows what Send will use', () => {
    const view = serverHelpers().slice(serverHelpers().indexOf('async function letterTemplateView('))
    expect(view).toContain('.getTeamMembers()')
    expect(view).toContain('.catch(() => [])')
    expect(view).toContain('teamAddresses: teamAddresses.filter((address) => address !== sender.replyTo.toLowerCase()),')
  })

  it('names the sender the way an invoice does', () => {
    expect(serverHelpers()).toContain("process.env.INVOICE_EMAIL_FROM || process.env.EMAIL_FROM || ''")
    expect(serverHelpers()).toContain('formatInvoiceSender(')
  })
})

describe('the shared pieces are the ones the lib tests cover', () => {
  it('imports the filler, the hash and the documents builder', () => {
    expect(serverSource).toMatch(/import \{[^}]*\bassembleLetterPreview\b[^}]*\bsendLetterBatch\b[^}]*\} from '\.\/lib\/letter-send\.js'/)
    expect(libSource).toContain("import { buildLetterDocuments } from './letter-documents.js'")
    expect(serverSource).toMatch(
      /import \{\s*letterPlaceholders,\s*letterTemplateHash,\s*retiredSentence,\s*templateWarnings,?\s*\} from '\.\/lib\/letter-template\.js'/,
    )
    expect(serverSource).toMatch(/import \{[^}]*\bformatInvoiceSender\b[^}]*\} from '\.\/lib\/notify\.js'/)
  })

  it('resolves recipients with the invoice rule', () => {
    expect(previewAssembly()).toContain('resolveInvoiceRecipients(')
    expect(previewAssembly()).toContain('invoiceEmailAddressee(')
  })
})
