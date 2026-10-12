import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The engagement endpoints' GLUE (docs/plans/engagements-2026-10.md, stage 2B).
 *
 * Same shape as letter-routes.test.ts and for the same reason: `server.js` calls
 * `server.listen()` at module scope and exports nothing, so there is no HTTP
 * harness. The behavior lives in lib/engagement-send.js (lib/engagement-send.test.mjs)
 * and in the store (db/store-staleness.test.mjs, both backends); what is pinned here
 * is the wiring - an owner gate deleted, an origin guard dropped, a refusal moved
 * after the provider call, a copy of the letter sent to someone who is not the party.
 *
 * Treat a failure here as "the routing moved, go look".
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const serverSource = readFileSync(path.resolve(here, '../../server.js'), 'utf8')
const libSource = readFileSync(path.resolve(here, '../../lib/engagement-send.js'), 'utf8')
const hashSource = readFileSync(path.resolve(here, '../../lib/engagement-hash.js'), 'utf8')

/** The body of a route block, from its opening guard onward. */
function routeBlock(startPattern: RegExp, length = 2200): string {
  const at = serverSource.search(startPattern)
  expect(at, `route not found: ${startPattern}`).toBeGreaterThan(-1)
  return serverSource.slice(at, at + length)
}

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
      // The owner gate comes before anything is read.
      expect(block.indexOf("session.user.role !== 'owner'")).toBeLessThan(block.indexOf('appDataStore.'))
    })

    if (route.write) {
      it(`${route.name} blocks a cross-site request and wants JSON`, () => {
        const block = routeBlock(route.pattern)
        expect(block).toContain('isCrossSiteOrigin(request)')
        expect(block).toContain("sendJson(response, 403, { error: 'Origin not allowed' })")
        expect(block).toContain('isJsonContentType(request)')
        expect(block).toContain("sendJson(response, 415, { error: 'application/json required' })")
        expect(block.indexOf('isJsonContentType(request)')).toBeLessThan(block.indexOf('appDataStore.'))
      })

      it(`${route.name} tells the other sessions`, () => {
        expect(routeBlock(route.pattern, route.broadcastLength ?? 3000)).toContain('broadcastDataChanged()')
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
  between('// ---- Engagements (docs/plans/engagements-2026-10.md, stage 2B) ---', '// ---- end of the engagement routes')
/** The server's helpers. */
const serverHelpers = () =>
  between('// ---- Engagements: helpers (docs/plans/engagements-2026-10.md, stage 2B)', '// ---- end of the engagement helpers')
/** Every line of the engagement code that could send or copy anything. */
const allCode = () => routesBlock() + serverHelpers() + libSource
const previewRoute = () =>
  between('// GET /api/engagements/:id/preview[?to=]', '// POST /api/engagements/:id/send')
const sendRoute = () => between('// POST /api/engagements/:id/send', '// POST /api/engagements/:id/sign')
const previewAssembly = () =>
  between('export async function assembleEngagementPreview(', 'const refuse = ', libSource)
const sendLib = () => libSource.slice(libSource.indexOf('export async function sendEngagement('))

const ROUTES: Route[] = [
  { name: 'GET /api/engagement-sections', pattern: /normalizedPath === '\/api\/engagement-sections' && request\.method === 'GET'/, write: false },
  { name: 'PUT /api/engagement-sections', pattern: /normalizedPath === '\/api\/engagement-sections' && request\.method === 'PUT'/, write: true },
  { name: 'GET /api/engagements', pattern: /normalizedPath === '\/api\/engagements' && request\.method === 'GET'/, write: false },
  { name: 'GET /api/engagements/:id', pattern: /if \(engagementMatch && request\.method === 'GET'\)/, write: false },
  { name: 'PATCH /api/engagements/:id', pattern: /if \(engagementMatch && request\.method === 'PATCH'\)/, write: true },
  { name: 'POST /api/engagements/:id/reassemble', pattern: /if \(engagementReassembleMatch && request\.method === 'POST'\)/, write: true },
  { name: 'GET /api/engagements/:id/preview(.pdf)', pattern: /if \(engagementPreviewMatch && request\.method === 'GET'\)/, write: false },
  { name: 'POST /api/engagements/:id/send', pattern: /if \(engagementSendMatch && request\.method === 'POST'\)/, write: true, broadcastLength: 4000 },
  { name: 'POST /api/engagements/:id/sign', pattern: /if \(engagementSignMatch && request\.method === 'POST'\)/, write: true },
  { name: 'POST /api/engagements/:id/void', pattern: /if \(engagementVoidMatch && request\.method === 'POST'\)/, write: true },
]

describe('the engagement routes are owner-only, same-origin and above the catch-all', () => {
  pinOwnerRoutes(ROUTES)

  it('match the paths the plan names', () => {
    const block = routesBlock()
    expect(block).toContain("normalizedPath.match(/^\\/api\\/engagements\\/([^/]+)$/)")
    expect(block).toContain("normalizedPath.match(/^\\/api\\/engagements\\/([^/]+)\\/reassemble$/)")
    expect(block).toContain("normalizedPath.match(/^\\/api\\/engagements\\/([^/]+)\\/preview(\\.pdf)?$/)")
    expect(block).toContain("normalizedPath.match(/^\\/api\\/engagements\\/([^/]+)\\/send$/)")
    expect(block).toContain("normalizedPath.match(/^\\/api\\/engagements\\/([^/]+)\\/sign$/)")
    expect(block).toContain("normalizedPath.match(/^\\/api\\/engagements\\/([^/]+)\\/void$/)")
  })

  it('sit next to the letters, ahead of them, and outside their pinned block', () => {
    const engagementsAt = serverSource.indexOf('// ---- Engagements (docs/plans/engagements-2026-10.md, stage 2B) ---')
    const endAt = serverSource.indexOf('// ---- end of the engagement routes')
    const lettersAt = serverSource.indexOf('// ---- Engagement letters (featreq-5e195707) ---')
    expect(engagementsAt).toBeGreaterThan(-1)
    expect(endAt).toBeGreaterThan(engagementsAt)
    expect(lettersAt).toBeGreaterThan(endAt)
  })

  it('nothing here goes near the bulk save', () => {
    for (const text of [routesBlock(), serverHelpers(), libSource]) {
      expect(text).not.toContain('appDataStore.write(')
      expect(text).not.toContain('.write(data')
    }
  })

  it('maps a store refusal to 400 engagement_invalid or 409 engagement_refused, and rethrows anything else', () => {
    const helper = serverHelpers().slice(serverHelpers().indexOf('function sendEngagementRefusal('))
    expect(helper).toContain('if (!(error instanceof EngagementStateError)) throw error')
    expect(helper).toContain("sendJson(response, 400, { error: 'engagement_invalid', message: error.message })")
    expect(helper).toContain("sendJson(response, 409, { error: 'engagement_refused', reason: error.reason, message: error.message })")
    for (const route of ['PATCH', 'reassemble', 'sign', 'void']) {
      const pattern = ROUTES.find((entry) => entry.name.includes(route))!.pattern
      expect(routeBlock(pattern, 3000), route).toContain('sendEngagementRefusal(response, error)')
    }
  })

  it('the library PUT answers 400 sections_invalid before or from the store, and records the save', () => {
    const block = routeBlock(ROUTES[1].pattern, 2600)
    expect(block).toContain("error: 'sections_invalid'")
    expect(block.indexOf("error: 'sections_invalid'")).toBeLessThan(block.indexOf('saveEngagementSections('))
    expect(block).toContain('appDataStore.saveEngagementSections(payload.sections, { updatedBy: session.user.id })')
    expect(block).toContain("'engagement_sections_saved'")
  })

  it('PATCH passes only the editable fields to the store', () => {
    const block = routeBlock(ROUTES[4].pattern, 2600)
    expect(block).toContain("for (const key of ['subject', 'emailBody', 'letterBody', 'retainerAmount', 'packageId', 'planIds', 'party']) {")
    expect(block).toContain('appDataStore.updateEngagement(engagementMatch[1], patch)')
  })

  it('the editor read hands the engagement placeholders, the warnings, the hash and the sender', () => {
    const view = serverHelpers().slice(serverHelpers().indexOf('async function engagementView('))
    expect(view).toContain("placeholders: placeholdersFor('engagement'),")
    expect(view).toContain('warnings: engagementWarnings(engagement),')
    expect(view).toContain('hash: engagementHash(engagement),')
    expect(view).toContain('sender: letterSender(firmSettings),')
  })

  // Engagements stage 3: signing creates the client, so a refusal after that still
  // tells the other tabs (before any mapping), a client-side refusal is a 409, and the
  // route answers the store's whole result (client, checklists, retainer, skips).
  it('sign broadcasts a created client before any refusal, maps client refusals to 409, and answers the result whole', () => {
    const block = routeBlock(ROUTES[8].pattern, 3000)
    const broadcastAt = block.indexOf('if (error.createdClientId) broadcastDataChanged()')
    const masterAt = block.indexOf('error instanceof BillingMasterError || error instanceof PackageApplyError')
    const refusalAt = block.indexOf('sendEngagementRefusal(response, error)')
    expect(broadcastAt).toBeGreaterThan(-1)
    expect(masterAt).toBeGreaterThan(broadcastAt)
    expect(refusalAt).toBeGreaterThan(masterAt)
    expect(block).toContain("sendJson(response, 409, { error: 'engagement_refused', reason: 'client_refused', message: error.message })")
    expect(block).toContain('sendJson(response, 200, result)')
    expect(block).toContain('engagementActivityTarget(result.engagement)')
    expect(block).not.toContain('appDataStore.createClient(')
    expect(block).not.toContain('createRetainerInvoice(')
  })

  it('sign and void record what happened', () => {
    expect(routeBlock(ROUTES[8].pattern, 3000)).toContain("'engagement_signed'")
    expect(routeBlock(ROUTES[8].pattern, 3000)).toContain('allowUnsent: payload.allowUnsent === true')
    expect(routeBlock(ROUTES[9].pattern, 3000)).toContain("'engagement_voided'")
  })
})

// What she previews is what is sent, so nothing in the preview may have a side effect.
const NEVER_IN_A_PREVIEW = [
  'sendInvoiceEmail',
  'sendMail',
  'markEngagementSent',
  'appendEngagementEmailEvent',
  'updateEngagement',
  'signEngagement',
  'voidEngagement',
  'recordActivity',
  'broadcastDataChanged',
  'notify(',
  'engagementPause',
]

describe('the preview routes', () => {
  it('build from the STORED engagement through the shared builder Send uses', () => {
    expect(previewRoute()).toContain('appDataStore.getEngagement(engagementPreviewMatch[1])')
    expect(previewRoute()).toContain('await assembleEngagementPreview(await loadEngagementContext(session), engagement, {')
    expect(previewAssembly()).toContain('await buildEngagementDocuments({')
    expect(previewAssembly()).toContain('engagementValues({')
    expect(sendLib()).toContain('const preview = await assembleEngagementPreview(context, engagement, { to })')
  })

  it('send, save, record and notify nothing', () => {
    for (const forbidden of NEVER_IN_A_PREVIEW) {
      expect(previewRoute(), `${forbidden} must not run in a preview`).not.toContain(forbidden)
      expect(previewAssembly(), `${forbidden} must not run in a preview`).not.toContain(forbidden)
    }
  })

  it('stream the PDF inline and uncached, and answer 502 pdf_failed when it did not build', () => {
    const body = previewRoute()
    expect(body).toContain("'Content-Type': 'application/pdf'")
    expect(body).toContain("'Cache-Control': 'no-store'")
    expect(body).toContain("error: 'pdf_failed'")
    expect(body).toContain('sendJson(response, 502,')
  })

  it('answer what the page needs to explain a refusal', () => {
    const body = previewRoute()
    for (const field of [
      'subject: preview.docs.email.subject',
      'html: preview.docs.email.html',
      'text: preview.docs.email.text',
      'to: preview.to',
      'recipientNote: preview.recipientNote',
      'missing: preview.missing',
      'missingNote: preview.missingNote',
      'unknown: preview.unknown',
      'retired: preview.retired',
      'pdfAvailable: Boolean(preview.docs.pdf)',
      'pdfFilename: preview.docs.pdfFilename',
      'refusal: preview.refusal',
    ]) {
      expect(body).toContain(field)
    }
  })

  it('check a typed address before anything is read', () => {
    const body = previewRoute()
    expect(body.indexOf('isOneEmailAddress(typedTo)')).toBeLessThan(body.indexOf('appDataStore.getEngagement('))
  })
})

describe('the send refuses before the provider is called', () => {
  const at = (text: string, needle: string) => {
    const index = text.indexOf(needle)
    expect(index, `${needle} is missing`).toBeGreaterThan(-1)
    return index
  }

  it('checks the body first: 400 engagement_invalid before the engagement is read', () => {
    const body = sendRoute()
    expect(at(body, "error: 'engagement_invalid'")).toBeLessThan(at(body, 'appDataStore.getEngagement('))
    expect(body).toContain("typeof payload.templateHash !== 'string'")
    expect(body).toContain('!isOneEmailAddress(payload.to)')
  })

  it('decides every refusal in the plan order, then sends once, then logs', () => {
    const body = sendLib()
    const order = [
      "'engagement_changed'",
      "'unknown_placeholder'",
      "'missing_placeholder'",
      "'engagement_empty'",
      "'engagement_refused'",
      "'team_address'",
      "'no_recipient'",
      "'pdf_failed'",
      "'engagement_send_failed'",
      'sendResult = await deps.sendMail(mail)',
      'await deps.store.markEngagementSent(engagement.id, {',
    ].map((needle) => at(body, needle))
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('compares the page hash with the STORED engagement, and says nothing was sent', () => {
    const body = sendLib()
    expect(body).toContain('if (templateHash !== engagementHash(engagement)) {')
    expect(body).toContain('The engagement changed since this page loaded. Nothing was sent. Reload and send again.')
    expect(libSource).toContain("import { engagementHash } from './engagement-hash.js'")
    expect(libSource).toContain('export { engagementHash }')
  })

  // A second tab can change who it goes to (the party) or the retainer it prints, not only the text.
  it('the hash covers the three boxes, the retainer and the whole party', () => {
    for (const piece of [
      "String(engagement?.subject ?? '')",
      "String(engagement?.emailBody ?? '')",
      "String(engagement?.letterBody ?? '')",
      'retainerKey(engagement?.retainerAmount)',
      "ENGAGEMENT_HASH_PARTY_KEYS.map((key) => String(party[key] ?? ''))",
    ]) {
      expect(hashSource).toContain(piece)
    }
    for (const key of ['company', 'contactName', 'title', 'email', 'phone', 'addressLine1', 'addressLine2', 'city', 'state', 'postalCode']) {
      expect(hashSource).toContain(`'${key}'`)
    }
  })

  it('refuses a double click: a send that left under 15 seconds ago, as engagement_refused / just_sent', () => {
    const body = sendLib()
    expect(libSource).toContain('export const ENGAGEMENT_JUST_SENT_MS = 15000')
    expect(body).toContain("reason: 'just_sent'")
    expect(body.indexOf("reason: 'just_sent'")).toBeLessThan(body.indexOf("'team_address'"))
    expect(body.indexOf("reason: 'just_sent'")).toBeGreaterThan(body.indexOf("'engagement_refused'"))
  })

  it('refuses a letter that is signed, superseded or void', () => {
    expect(libSource).toContain("export const ENGAGEMENT_SENDABLE_STATUSES = Object.freeze(['draft', 'sent'])")
    expect(sendLib()).toContain('if (!ENGAGEMENT_SENDABLE_STATUSES.includes(engagement.status)) {')
  })

  it('hands the route the status and code of a refusal, and answers 200 with the engagement once mail was attempted', () => {
    const body = sendRoute()
    expect(body).toContain('if (result.refused) {')
    expect(body).toContain('const { status, ...body } = result.refused')
    expect(body).toContain('sendJson(response, status, body)')
    const after = body.slice(body.indexOf('if (result.ok) {'))
    expect(after).toContain("'engagement_sent'")
    expect(after).toContain('broadcastDataChanged()')
    expect(after).toContain('sendJson(response, 200, { engagement: result.engagement, ok: result.ok, error: result.error })')
    expect(after).not.toMatch(/sendJson\(response, (4|5)\d\d,/)
  })

  it('says email is not configured from the environment, decided in the lib as the last refusal', () => {
    expect(sendRoute()).toContain('process.env.RESEND_API_KEY && (process.env.INVOICE_EMAIL_FROM || process.env.EMAIL_FROM)')
    expect(sendLib()).toContain('if (!deps.configured) {')
  })

  it('sends with the PDF, the engagement tag and the engagement kind, and retries a 429 once', () => {
    const body = sendLib()
    expect(body.match(/deps\.sendMail\(/g)).toHaveLength(2)
    expect(body).toContain('attachments: [{ filename: preview.docs.pdfFilename, content: preview.docs.pdf }]')
    expect(body).toContain('engagementId: engagement.id')
    expect(body).toContain("kind: 'engagement'")
    expect(body).toContain('to: preview.to')
    expect(body).toContain('sendResult.status === 429')
    expect(body).toContain('await deps.pause(ENGAGEMENT_RATE_LIMIT_WAIT_MS)')
  })

  it('logs the send in a try/catch so bookkeeping can never turn a letter that left into a failure', () => {
    const body = sendLib()
    const logAt = body.indexOf('await deps.store.markEngagementSent(engagement.id, {')
    expect(body.slice(Math.max(0, logAt - 60), logAt)).toContain('try {')
    expect(body).toContain('could not log the send')
  })
})

describe('an engagement letter goes to the client and nowhere else (Alex, 2026-10-08)', () => {
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

  it('has no owner notification and no copy anywhere in the routes, the helpers or lib/engagement-send.js', () => {
    for (const [name, text] of [
      ['routes', routesBlock()],
      ['helpers', serverHelpers()],
      ['lib/engagement-send.js', libSource],
    ]) {
      for (const forbidden of FORBIDDEN) {
        expect(text, `${forbidden} must not appear in the engagement ${name}`).not.toContain(forbidden)
      }
    }
  })

  it('has exactly one mail sender: the route hands it over, the lib calls it (and its one retry)', () => {
    const server = routesBlock() + serverHelpers()
    expect(server).not.toMatch(/sendInvoiceEmail\(/)
    expect(server.match(/sendMail: sendInvoiceEmail\b/g)).toHaveLength(1)
    expect(libSource.match(/deps\.sendMail\(/g)).toHaveLength(2)
    expect(allCode()).not.toMatch(/\bsend[A-Z]\w*Email\((?!mail\))/)
    expect(libSource).not.toMatch(/from '\.\/notify\.js'/)
  })

  it('replies go to the invoice mailbox, through the same sender rule Letters uses', () => {
    expect(serverHelpers()).toContain('replyTo: letterSender(firmSettings).replyTo')
    const letterHelper = serverSource.slice(serverSource.indexOf('function letterSender('))
    expect(letterHelper.slice(0, 600)).toContain('process.env.INVOICE_REPLY_TO || process.env.OWNER_EMAIL')
  })

  it('reads the addresses of the team once, fails closed, and the builder drops them, reply-to excepted', () => {
    const body = serverHelpers().slice(serverHelpers().indexOf('async function loadEngagementContext('))
    expect(body).toContain('appDataStore.getTeamMembers()')
    expect(body).toContain('teamEmails: new Set(')
    expect(body).toContain('.toLowerCase()')
    // No catch on that read: if the team cannot be read nothing is previewed or sent.
    expect(body.slice(0, body.indexOf('teamEmails:'))).not.toContain('getTeamMembers().catch(')
    expect(previewAssembly()).toContain('withoutTeamAddresses(resolved, context.teamEmails, context.replyTo)')
    expect(sendLib().indexOf("'team_address'")).toBeLessThan(sendLib().indexOf('deps.sendMail('))
  })

  it('a typed address is ONE address, shape-checked, and still goes through the team guard', () => {
    const helper = serverHelpers().slice(serverHelpers().indexOf('function isOneEmailAddress('))
    expect(helper).toContain('value.trim().length <= 320')
    expect(helper).toMatch(/\[\^\\s@,;<>\]\+@/)
    expect(previewAssembly()).toContain("const raw = typed || String(engagement.party?.email ?? '').trim()")
  })
})

describe('the shared pieces are the ones the lib tests cover', () => {
  it('imports the preview, the send, the warnings and the hash from lib/engagement-send.js', () => {
    expect(serverSource).toMatch(
      /import \{\s*assembleEngagementPreview,\s*engagementHash,\s*engagementWarnings,\s*sendEngagement,?\s*\} from '\.\/lib\/engagement-send\.js'/,
    )
    expect(serverSource).toContain("import { placeholdersFor } from './lib/letter-template.js'")
    expect(libSource).toContain("import { buildEngagementDocuments } from './engagement-documents.js'")
    expect(libSource).toContain("import { engagementValues } from './engagement-values.js'")
    expect(libSource).toContain("import { addressesIn, withoutTeamAddresses } from './recipient-addresses.js'")
  })
})

describe('a Won proposal with no engagement can get one (POST /api/proposals/:id/engagement)', () => {
  const pattern = /if \(proposalEngagementMatch && request\.method === 'POST'\)/
  pinOwnerRoutes([{ name: 'POST /api/proposals/:id/engagement', pattern, write: true }])

  it('drafts through the store, which alone decides Won and not-yet-drafted', () => {
    const block = routeBlock(pattern, 2600)
    expect(serverSource).toContain("normalizedPath.match(/^\\/api\\/proposals\\/([^/]+)\\/engagement$/)")
    expect(block).toContain('appDataStore.draftEngagementForProposal(proposalEngagementMatch[1], {')
    expect(block).not.toContain('createEngagementFromProposal')
    expect(block).toContain("error: 'engagement_refused',")
    expect(block).toContain('reason: error.reason,')
    expect(block).toContain('engagementId: error.engagementId ?? null,')
    expect(block).toContain("sendJson(response, 404, { error: 'Proposal not found' })")
    expect(block).toContain("'engagement_created'")
    expect(block).toContain('sendJson(response, 200, { engagement })')
  })

  it('sits with the proposal routes, ahead of Accept', () => {
    expect(serverSource.search(pattern)).toBeLessThan(serverSource.indexOf('const proposalAcceptMatch ='))
  })
})
