import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The eSignatures.io glue in server.js (task 18; docs/esignatures.md): its webhook route, the provider-neutral
 * status route, the finish route's choice of provider, the signing activity line and the hourly expiry.
 * server.js is not booted by tests, so what is pinned is the wiring; the behavior is tested by running it
 * (lib/esignatures.test.mjs, lib/esignatures-webhook.test.mjs, lib/engagement-esign.test.mjs).
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const serverSource = readFileSync(path.join(root, 'server.js'), 'utf8')
const handlerSource = readFileSync(path.join(root, 'lib/esignatures-webhook.js'), 'utf8')

function between(startAnchor: string, endAnchor: string, source = serverSource): string {
  const start = source.indexOf(startAnchor)
  expect(start, `${startAnchor} is gone`).toBeGreaterThan(-1)
  const end = source.indexOf(endAnchor, start + startAnchor.length)
  expect(end, `${endAnchor} is gone`).toBeGreaterThan(start)
  return source.slice(start, end)
}

const webhookRoute = () =>
  between("if (normalizedPath === '/api/esignatures/webhook' && request.method === 'POST') {", '// POST /api/invoices/:id/payment-link')

describe('POST /api/esignatures/webhook', () => {
  it('sits above the /api/ catch-all, after the SignWell webhook', () => {
    const at = serverSource.indexOf("normalizedPath === '/api/esignatures/webhook'")
    expect(at).toBeGreaterThan(serverSource.indexOf("normalizedPath === '/api/signwell/webhook'"))
    expect(at).toBeLessThan(serverSource.indexOf("if (normalizedPath.startsWith('/api/')) {"))
  })

  it('is outside session auth and the origin check: eSignatures.io holds neither', () => {
    const route = webhookRoute()
    expect(route).not.toContain('requireSession')
    expect(route).not.toContain('isCrossSiteOrigin')
    expect(route).not.toContain('isJsonContentType')
  })

  it('hands the handler the EXACT bytes (at most 1 MB), the X-Signature-SHA256 header and the token from the environment', () => {
    const route = webhookRoute()
    expect(route).toContain('rawBody = await readRawBytes(request, SIGNWELL_WEBHOOK_MAX_BYTES)')
    expect(serverSource).toContain('async function readRawBytes(request, maxBytes = MAX_JSON_BODY_BYTES)')
    expect(route).toContain("signature: request.headers['x-signature-sha256']")
    expect(route).toContain('token: process.env.ESIGNATURES_SECRET_TOKEN')
    expect(route).toContain('deps: esignaturesFinishDeps(request)')
    expect(route).toContain("if (error?.statusCode === 413) sendJson(response, 413, { error: 'Request body too large' })")
  })

  it('answers first, broadcasts only a new event of ours, THEN runs the slow part and never lets it throw', () => {
    const route = webhookRoute()
    const answer = route.indexOf('sendJson(response, handled.status, handled.body)')
    expect(answer).toBeGreaterThan(-1)
    expect(answer).toBeLessThan(route.indexOf('broadcastDataChanged()'))
    expect(route.indexOf('broadcastDataChanged()')).toBeLessThan(route.indexOf('setImmediate('))
    expect(route).toContain('if (handled.body.received && !handled.body.duplicate && !handled.body.ignored) {')
    expect(route).toContain('handled.after().catch(')
  })

  it('checks the signature in the handler before parsing the body or looking anything up', () => {
    const verify = handlerSource.indexOf('verifyWebhookSignature(rawBody, signature, token)')
    expect(verify).toBeGreaterThan(-1)
    expect(verify).toBeLessThan(handlerSource.indexOf('JSON.parse(text)'))
    expect(verify).toBeLessThan(handlerSource.indexOf('store.getSignatureRequestByDocumentId('))
    expect(handlerSource).toContain("store.getSignatureRequestByDocumentId(contractId, 'esignatures')")
    // The PDF comes from the RE-READ contract, never the webhook body.
    expect(handlerSource).toContain('deps.esignatures.downloadSignedPdf(contract?.contract_pdf_url)')
    expect(handlerSource.indexOf('contract = await esignatures.getContract(contractId)')).toBeGreaterThan(-1)
  })
})

describe('the glue', () => {
  it('eSignatures.io requests are handed the store, the eSignatures module, the owner notice and the signing bookkeeping', () => {
    const helper = between('function esignaturesFinishDeps(request) {', '/** What the sign route records')
    expect(helper).toContain('store: appDataStore')
    expect(helper).toContain('esignatures,')
    expect(helper).toContain('notifyOwners: (notice) => notifySignwellOwners(request, notice)')
    expect(helper).toContain('afterSigned: recordSignwellSigning')
  })

  it('records a signing "via eSignatures.io" for its requests', () => {
    const helper = between('async function recordSignwellSigning(', '// ---- end of the SignWell glue')
    expect(helper).toContain("signatureRequest.provider === 'esignatures'")
    expect(helper).toContain('`${engagementActivityTarget(result.engagement)} via eSignatures.io`')
  })

  it('the finish route follows the request\'s OWN provider', () => {
    const block = between('// POST /api/engagements/:id/esign/:requestId/finish', '// GET /api/engagements/:id/esign - this engagement')
    expect(block).toContain("signatureRequest.provider === 'esignatures'")
    expect(block).toContain('await finishEsignaturesRequest(signatureRequest.id, esignaturesFinishDeps(request))')
    expect(block).toContain('await finishSignatureRequest(signatureRequest.id, signwellFinishDeps(request))')
  })

  it('expires overdue eSignatures.io requests hourly and once after boot, through the periodic-job runner', () => {
    expect(serverSource).toContain("registerPeriodicJob('esignatures-expiry', async () => {")
    expect(serverSource).toContain('await expireEsignaturesRequests({ store: appDataStore })')
    expect(serverSource).toContain('setInterval(() => void runPeriodicJob(esignaturesExpiryJob), 60 * 60 * 1000)')
    expect(serverSource).toContain('setTimeout(() => void runPeriodicJob(esignaturesExpiryJob), 60 * 1000)')
    expect(serverSource).toMatch(/clearInterval[\s\S]*esignaturesExpiryTimer/)
  })
})

describe('GET /api/esign/status', () => {
  const statusRoute = () => between("if (normalizedPath === '/api/esign/status' && request.method === 'GET') {", '// ---- end of the engagement e-signature routes')

  it('is owner-only and same-origin, inside the e-signature block, above the /api/ catch-all', () => {
    const block = statusRoute()
    expect(block).toContain('await requireSession(request, response)')
    expect(block).toMatch(/session\.user\.role !== 'owner'/)
    expect(block).toContain('isCrossSiteOrigin(request)')
    expect(serverSource.indexOf("normalizedPath === '/api/esign/status'")).toBeLessThan(serverSource.indexOf("if (normalizedPath.startsWith('/api/')) {"))
  })

  it('answers configured, the provider and test mode - never a token or key', () => {
    const block = statusRoute()
    expect(block).toContain('{ configured: esignConfigured(process.env), provider: esignProvider(process.env), testMode: esignTestMode(process.env) }')
    expect(block).not.toMatch(/ESIGNATURES_SECRET_TOKEN|SIGNWELL_API_KEY|SIGNWELL_WEBHOOK_ID/)
    expect(block).toContain("'Cache-Control': 'no-store'")
  })
})

describe('eSignatures.io knowledge lives in two files', () => {
  it('only lib/esignatures.js names eSignatures.io\'s API host or builds its Basic auth', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', 'dist', '.git', 'tmp', 'output', 'docs', '.superpowers'].includes(entry.name)) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.(js|mjs|ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) files.push(full)
      }
    }
    walk(root)
    const offenders = files
      .filter((file) => /esignatures\.com\/api|Basic \$\{/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(root, file).replace(/\\/g, '/'))
    expect(offenders).toEqual(['lib/esignatures.js'])
  })

  it('the handler logs ids and event names only, and carries no mail sender or signed document', () => {
    for (const line of handlerSource.split('\n').filter((entry) => /log\.(info|warn|error)\(/.test(entry))) {
      expect(line).not.toMatch(/email|payload|rawBody|contract_pdf_url|\$\{bytes\b/i)
    }
    for (const forbidden of ['attachments', 'sendInvoiceEmail', 'getSignedDocument', 'bcc', 'OWNER_EMAIL_COPY']) {
      expect(handlerSource).not.toContain(forbidden)
    }
    expect(handlerSource).not.toMatch(/\bnotify\(/)
  })
})
