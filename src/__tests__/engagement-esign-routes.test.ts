import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The e-signature routes' GLUE in server.js (featreq-56d39567): send for signature, remind,
 * list, download the signed PDF, and the public thank-you page. server.js is not booted by
 * tests, so what is pinned is the wiring - an owner gate dropped, an origin guard missing, the
 * signed document handed to anyone but an owner in the app. The behavior is tested by running
 * it: lib/engagement-esign.test.mjs and db/store-staleness.test.mjs.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const serverSource = readFileSync(path.join(root, 'server.js'), 'utf8')
const esignSource = readFileSync(path.join(root, 'lib/engagement-esign.js'), 'utf8')

function between(startAnchor: string, endAnchor: string, source = serverSource): string {
  const start = source.indexOf(startAnchor)
  expect(start, `${startAnchor} is gone`).toBeGreaterThan(-1)
  const end = source.indexOf(endAnchor, start + startAnchor.length)
  expect(end, `${endAnchor} is gone`).toBeGreaterThan(start)
  return source.slice(start, end)
}

const routes = () =>
  between('// ---- Engagement e-signature routes (featreq-56d39567; docs/signwell.md)', '// ---- end of the engagement e-signature routes')
const sendRoute = () => between('// POST /api/engagements/:id/esign - { templateHash, signer? }', '// POST /api/engagements/:id/esign/remind')
const remindRoute = () => between('// POST /api/engagements/:id/esign/remind', '// POST /api/engagements/:id/esign/:requestId/finish')
const finishRoute = () => between('// POST /api/engagements/:id/esign/:requestId/finish', '// GET /api/engagements/:id/esign - this engagement')
const listRoute = () => between('// GET /api/engagements/:id/esign - this engagement', '// GET /api/clients/:id/esign')
const clientListRoute = () => between('// GET /api/clients/:id/esign', '// GET /api/engagements/:id/esign/:requestId/pdf')
const pdfRoute = () => between('// GET /api/engagements/:id/esign/:requestId/pdf', '// ---- end of the engagement e-signature routes')

type Route = { name: string; block: () => string; write: boolean }
const ROUTES: Route[] = [
  { name: 'POST /api/engagements/:id/esign', block: sendRoute, write: true },
  { name: 'POST /api/engagements/:id/esign/remind', block: remindRoute, write: true },
  { name: 'POST /api/engagements/:id/esign/:requestId/finish', block: finishRoute, write: true },
  { name: 'GET /api/engagements/:id/esign', block: listRoute, write: false },
  { name: 'GET /api/clients/:id/esign', block: clientListRoute, write: false },
  { name: 'GET /api/engagements/:id/esign/:requestId/pdf', block: pdfRoute, write: false },
]

describe('the e-signature routes are owner-only and same-origin', () => {
  for (const route of ROUTES) {
    it(`${route.name} requires a session and refuses a non-owner before reading anything`, () => {
      const block = route.block()
      expect(block).toContain('await requireSession(request, response)')
      expect(block).toMatch(/session\.user\.role !== 'owner'/)
      expect(block).toMatch(/sendJson\(response, 403,/)
      expect(block.indexOf("session.user.role !== 'owner'")).toBeLessThan(block.indexOf('appDataStore.'))
      expect(block).toContain('isCrossSiteOrigin(request)')
      expect(block).toContain("sendJson(response, 403, { error: 'Origin not allowed' })")
    })

    if (route.write) {
      it(`${route.name} wants JSON, records activity and tells the other sessions`, () => {
        const block = route.block()
        expect(block).toContain('isJsonContentType(request)')
        expect(block).toContain("sendJson(response, 415, { error: 'application/json required' })")
        expect(block.indexOf('isJsonContentType(request)')).toBeLessThan(block.indexOf('appDataStore.'))
        expect(block).toContain('appDataStore.recordActivity(')
        expect(block).toContain('broadcastDataChanged()')
      })
    }
  }

  it('every route sits above the /api/ catch-all, after the engagement routes and outside their block', () => {
    const guardAt = serverSource.indexOf("if (normalizedPath.startsWith('/api/')) {")
    expect(guardAt).toBeGreaterThan(-1)
    const engagementEnd = serverSource.indexOf('// ---- end of the engagement routes')
    for (const route of ROUTES) {
      const at = serverSource.indexOf(route.block().slice(0, 60))
      expect(at, `${route.name} is unreachable`).toBeLessThan(guardAt)
      expect(at, `${route.name} sits inside the engagement routes block`).toBeGreaterThan(engagementEnd)
    }
  })
})

describe('sending for signature', () => {
  it('wants the page hash, reads the STORED engagement and hands the lib the environment and the public URL', () => {
    const block = sendRoute()
    expect(block).toContain("typeof payload.templateHash !== 'string'")
    expect(block).toContain('appDataStore.getEngagement(engagementEsignMatch[1])')
    expect(block).toContain('await sendEngagementForSignature(')
    expect(block).toContain('env: process.env')
    expect(block).toMatch(/signwell,\s*esignatures,\s*env: process\.env/)
    expect(block).toContain('publicUrl: getPublicAppUrl(request)')
    expect(block).toContain('AppDataStore._engagementIsPureRecord(candidate)')
    expect(block).toContain('const { status, ...body } = sent.refused')
    expect(block).toContain('sendJson(response, 200, { request: sent.request, engagement: sent.engagement })')
  })

  it('answers the lib\'s refusals as they are, and never answers with the signing link or the document', () => {
    const block = sendRoute()
    expect(block).toContain('sendJson(response, status, body)')
    expect(block).not.toMatch(/signing_url|file_base64|\.bytes/)
  })

  // Alex 2026-10-27: Send for signature confirms (or changes) the signer first.
  it('hands the confirmed signer to the lib as posted (it decides: party, contact or one-time) and never writes the party', () => {
    const block = sendRoute()
    expect(block).toContain('{ templateHash: payload.templateHash, userId: session.user.id, signer: payload.signer }')
    // The owner gate, the origin guard and the JSON check all come before the signer is read.
    for (const gate of ["session.user.role !== 'owner'", 'isCrossSiteOrigin(request)', 'isJsonContentType(request)']) {
      expect(block.indexOf(gate), gate).toBeLessThan(block.indexOf('payload.signer'))
    }
    // A refusal (recipients_changed with its list, signer_name_required, team_address) is answered as the lib gave it.
    expect(block.indexOf('const { status, ...body } = sent.refused')).toBeGreaterThan(block.indexOf('payload.signer'))
    // The route does not judge the address itself, and a one-time address never reaches the party record.
    expect(block).not.toMatch(/isOneEmailAddress|chooseEsignSigner|updateEngagement|party\.email\s*=/)
    // The activity names who it went to.
    expect(block).toContain('`, to ${sent.request.recipients[0].email}`')
    const lib = esignSource
    expect(lib).toContain("import { chooseEsignSigner, esignSignerChoiceOf } from './esign-signer.js'")
    expect(lib).toContain("refuse(400, 'signer_invalid'")
    expect(lib).toContain('details: engagementRecipientList(context, engagement).details')
  })

  it('reminds through the lib, and 404s an unknown engagement first', () => {
    const block = remindRoute()
    expect(block).toContain('await remindEngagementSignature(engagement.id,')
    // Both providers' modules: an eSignatures.io request is reminded by resending it to its signer.
    expect(block).toContain('{ store: appDataStore, signwell, esignatures, env: process.env, engagement }')
    expect(block.indexOf("sendJson(response, 404, { error: 'Engagement not found' })")).toBeLessThan(block.indexOf('await remindEngagementSignature('))
  })

  it('finishes through the lib, only for a request of THIS engagement, and answers its refusals as they are', () => {
    const block = finishRoute()
    expect(block).toContain('signatureRequest.engagementId !== engagement.id')
    expect(block).toContain("sendJson(response, 404, { error: 'Signature request not found' })")
    expect(block.indexOf("sendJson(response, 404, { error: 'Signature request not found' })")).toBeLessThan(
      block.indexOf('await finishSignatureRequest('),
    )
    expect(block).toContain('await finishSignatureRequest(signatureRequest.id, signwellFinishDeps(request))')
    expect(block).toContain('const { status, ...body } = finished.refused')
    // The activity line says what the press did: completed the request, or only checked it.
    expect(block).toContain("finished.request.status === 'completed' ? 'engagement_esign_finished' : 'engagement_esign_checked'")
    expect(block).not.toContain('Refuses unless SignWell still reads Completed')
  })

  it('the webhook and the finish route are handed the same deps (store, SignWell, owner notice, signing bookkeeping)', () => {
    const helper = between('function signwellFinishDeps(request) {', '/** What the sign route records')
    expect(helper).toContain('store: appDataStore')
    expect(helper).toContain('notifyOwners: (notice) => notifySignwellOwners(request, notice)')
    expect(helper).toContain('afterSigned: recordSignwellSigning')
    expect(serverSource).toContain('deps: signwellFinishDeps(request),')
  })

  it('lists requests newest-first without bytes', () => {
    const block = listRoute()
    expect(block).toContain('appDataStore.listSignatureRequestsForEngagement(engagement.id)')
    expect(block).toContain("'Cache-Control': 'no-store'")
    expect(block).not.toContain('getSignedDocument')
  })
})

describe('downloading the signed PDF', () => {
  it('serves it only for a COMPLETED request of THIS engagement whose PDF was kept, else 404', () => {
    const block = pdfRoute()
    expect(block).toContain('signatureRequest.engagementId === engagementEsignPdfMatch[1]')
    expect(block).toContain("signatureRequest.status === 'completed'")
    expect(block).toContain('signatureRequest.signedDocumentId')
    expect(block).toContain("sendJson(response, 404, { error: 'No signed letter for that request' })")
  })

  it('streams application/pdf as an attachment with a sanitized filename, uncached', () => {
    const block = pdfRoute()
    expect(block).toContain("'Content-Type': 'application/pdf'")
    expect(block).toContain('attachment; filename="${safeName}"')
    expect(block).toContain("replace(/[^A-Za-z0-9._-]+/g, '-')")
    expect(block).toContain("'Cache-Control': 'no-store'")
  })

  it('is the ONLY place the signed bytes are read', () => {
    expect(serverSource.match(/getSignedDocument\(/g)).toHaveLength(1)
    expect(esignSource).not.toContain('getSignedDocument')
  })
})

describe('a signed or sent letter never reaches an owner\'s mailbox (Alex, 2026-10-08)', () => {
  const FORBIDDEN = [
    'notify(',
    'notifyOwners',
    'notifyOwner',
    'sendInvoiceEmail',
    'sendDigestEmail',
    'sendReportEmail',
    'sendFeatureRequestEmail',
    'attachments',
    'bcc',
    'Bcc',
    'BCC',
    'cc:',
    'OWNER_EMAIL_COPY',
  ]

  it('the routes and lib/engagement-esign.js carry no notifier, mail sender, attachment or copy', () => {
    for (const [name, text] of [
      ['the e-signature routes', routes()],
      ['lib/engagement-esign.js', esignSource],
    ] as const) {
      for (const forbidden of FORBIDDEN) {
        expect(text, `${forbidden} must not appear in ${name}`).not.toContain(forbidden)
      }
    }
    expect(esignSource).not.toMatch(/from '\.\/notify\.js'/)
    expect(esignSource).not.toMatch(/from '\.\/.*email/)
  })

  it('refuses a team address before SignWell is called', () => {
    expect(esignSource.indexOf("'team_address'")).toBeGreaterThan(-1)
    expect(esignSource.indexOf("'team_address'")).toBeLessThan(esignSource.indexOf('signwell.createDocumentFromFile('))
    expect(esignSource).toContain('assembleEngagementPreview(')
  })

  it('refuses everything it can before the one SignWell call, and makes only one', () => {
    expect(esignSource.match(/signwell\.createDocumentFromFile\(/g)).toHaveLength(1)
    const call = esignSource.indexOf('signwell.createDocumentFromFile(')
    for (const refusal of ["'signwell_not_configured'", "'engagement_changed'", "'client_refused'", "'signature_active'", "'engagement_empty'", "'no_recipient'", "'pdf_failed'"]) {
      expect(esignSource.indexOf(refusal), refusal).toBeGreaterThan(-1)
      expect(esignSource.indexOf(refusal), refusal).toBeLessThan(call)
    }
  })
})

describe('the thank-you page SignWell sends a signer to', () => {
  it('is public (no session), read-only, above the SPA fallback and says only thank you', () => {
    const block = between("if (normalizedPath === '/signed-thank-you'", '// ---- /questionnaire/:token')
    expect(block).not.toContain('requireSession')
    expect(block).toContain("request.method === 'GET' || request.method === 'HEAD'")
    expect(block).toContain('Thank you - your engagement letter is signed')
    expect(block).not.toMatch(/appDataStore|searchParams|query/)
  })
})

describe('GET /api/signwell/status', () => {
  const statusRoute = () => between("if (normalizedPath === '/api/signwell/status' && request.method === 'GET') {", '// ---- end of the engagement e-signature routes')

  it('is owner-only and same-origin, inside the e-signature block, above the /api/ catch-all', () => {
    const block = statusRoute()
    expect(block).toContain('await requireSession(request, response)')
    expect(block).toMatch(/session\.user\.role !== 'owner'/)
    expect(block).toContain('isCrossSiteOrigin(request)')
    expect(block.indexOf("session.user.role !== 'owner'")).toBeLessThan(block.indexOf('signwell.'))
    expect(serverSource.indexOf("normalizedPath === '/api/signwell/status'")).toBeLessThan(
      serverSource.indexOf("if (normalizedPath.startsWith('/api/')) {"),
    )
    expect(routes()).toContain("normalizedPath === '/api/signwell/status'")
  })

  it('answers whether it is configured and whether it is in test mode - never the key or the webhook id', () => {
    const block = statusRoute()
    expect(block).toContain('{ configured: signwell.signwellConfigured(process.env), testMode: signwell.isTestMode(process.env) }')
    expect(block).not.toMatch(/SIGNWELL_API_KEY|SIGNWELL_WEBHOOK_ID/)
    expect(block).toContain("'Cache-Control': 'no-store'")
  })
})

/**
 * featreq-60118b28: the client card's ONE call, and a letter that no longer stands withdraws its open request.
 * The behavior runs in lib/engagement-esign.test.mjs (withdrawSignatureRequest) and db/store-staleness.test.mjs.
 */
describe('GET /api/clients/:id/esign (the client card, one call)', () => {
  it('reads this client\'s letters, then the newest request of each in ONE store call - never the signed bytes', () => {
    const block = clientListRoute()
    expect(block).toContain('normalizedPath.match(/^\\/api\\/clients\\/([^/]+)\\/esign$/)')
    expect(block).toContain("request.method === 'GET'")
    expect(block).toContain('appDataStore.listEngagements({ clientId })')
    // An unknown client is a 404 (like an unknown engagement); the path is decoded once, upstream.
    expect(block).toContain("sendJson(response, 404, { error: 'Client not found' })")
    expect(block.indexOf('appDataStore.getClientById(clientId)')).toBeLessThan(block.indexOf('appDataStore.listEngagements('))
    expect(block).not.toContain('decodeURIComponent')
    expect(block).toContain('appDataStore.latestSignatureRequestsForEngagements(engagements.map((row) => row.id))')
    expect(block).toContain("'Cache-Control': 'no-store'")
    expect(block).not.toContain('getSignedDocument')
    expect(block).not.toContain('listSignatureRequestsForEngagement(')
  })
})

describe('withdrawing an open request when its letter no longer stands', () => {
  const helper = () => between('async function withdrawSignatureRequestsFor(targets) {', '/** What the sign route records')
  const signing = () => between('async function recordSignwellSigning(', '// ---- end of the SignWell glue')
  const voidRoute = () => between('// POST /api/engagements/:id/void', '// POST /api/engagements/:id/restore')
  const signRoute = () => between('// POST /api/engagements/:id/sign - ', '// POST /api/engagements/:id/void')

  it('the helper hands the lib the store and the eSignatures module, tells the other sessions when something changed, and never throws', () => {
    const block = helper()
    expect(block).toContain('const results = await withdrawOpenSignatureRequests(targets, { store: appDataStore, esignatures })')
    expect(block).toContain('if (results.length > 0) broadcastDataChanged()')
    expect(block).toContain('} catch (error) {')
    // The routes' version runs AFTER the answer, never awaited, never throwing.
    const later = between('function withdrawSignatureRequestsLater(targets) {', '/** What the sign route records')
    expect(later).toContain('setImmediate(() => {')
    expect(later).toContain('withdrawSignatureRequestsFor(targets).catch(() => {})')
  })

  it('the void answers first, then withdraws the letter\'s open request (the provider calls never hold the answer)', () => {
    const block = voidRoute()
    const voided = block.indexOf('appDataStore.voidEngagement(')
    const withdraw = block.indexOf("withdrawSignatureRequestsLater([[voided.id, 'void']])")
    expect(voided).toBeGreaterThan(-1)
    expect(withdraw).toBeGreaterThan(voided)
    expect(withdraw).toBeGreaterThan(block.indexOf("sendJson(response, 404, { error: 'Engagement not found' })"))
    expect(withdraw).toBeGreaterThan(block.indexOf('sendJson(response, 200, { engagement: voided })'))
    expect(block).not.toContain('await withdrawSignatureRequests')
  })

  it('Mark as signed answers first, then withdraws the letter\'s own open request and those of the letters it superseded', () => {
    const block = signRoute()
    const signed = block.indexOf('appDataStore.signEngagement(')
    const withdraw = block.indexOf('withdrawSignatureRequestsLater([')
    expect(withdraw).toBeGreaterThan(signed)
    expect(block).toContain("[result.engagement.id, 'signed'],")
    expect(block).toContain("...(result.supersededId ? [[result.supersededId, 'superseded']] : []),")
    expect(block).toContain("...(result.supersededAmendmentIds ?? []).map((id) => [id, 'superseded']),")
    expect(withdraw).toBeGreaterThan(block.indexOf('sendJson(response, 200, result)'))
    expect(block).not.toContain('await withdrawSignatureRequests')
  })

  it('an e-signed superseding letter withdraws the open requests of the letters it superseded', () => {
    const block = signing()
    // After the webhook's answer already, and never awaited (it is the provider's round-trips).
    expect(block).toContain('withdrawSignatureRequestsLater([')
    expect(block).not.toContain('await withdrawSignatureRequests')
    expect(block).toContain("...(result.supersededAmendmentIds ?? []).map((id) => [id, 'superseded']),")
  })
})
