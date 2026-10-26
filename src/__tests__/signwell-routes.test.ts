import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The SignWell glue in server.js (featreq-56d39567; docs/signwell.md): the webhook route and
 * the two helpers it is handed. server.js is not booted by tests, so what is pinned here is
 * the wiring - the webhook sitting OUTSIDE session auth and the origin check (SignWell
 * has neither), its signature check living in the handler, the slow part running after the
 * 200, and the rule that a signed letter never reaches an owner's mailbox (Alex, 2026-10-08).
 * The behavior is tested by running it: lib/signwell.test.mjs, lib/signwell-webhook.test.mjs.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const serverSource = readFileSync(path.join(root, 'server.js'), 'utf8')
const clientSource = readFileSync(path.join(root, 'lib/signwell.js'), 'utf8')
const handlerSource = readFileSync(path.join(root, 'lib/signwell-webhook.js'), 'utf8')

function between(startAnchor: string, endAnchor: string, source = serverSource): string {
  const start = source.indexOf(startAnchor)
  expect(start, `${startAnchor} is gone`).toBeGreaterThan(-1)
  const end = source.indexOf(endAnchor, start + startAnchor.length)
  expect(end, `${endAnchor} is gone`).toBeGreaterThan(start)
  return source.slice(start, end)
}

const webhookRoute = () =>
  between("if (normalizedPath === '/api/signwell/webhook' && request.method === 'POST') {", '// POST /api/invoices/:id/payment-link')
const glue = () => between('// ---- SignWell e-signature (featreq-56d39567; docs/signwell.md)', '// ---- end of the SignWell glue')

describe('POST /api/signwell/webhook', () => {
  it('sits above the /api/ catch-all, beside the other webhooks', () => {
    const guardAt = serverSource.indexOf("if (normalizedPath.startsWith('/api/')) {")
    expect(guardAt).toBeGreaterThan(-1)
    const at = serverSource.indexOf("normalizedPath === '/api/signwell/webhook'")
    expect(at).toBeGreaterThan(serverSource.indexOf("normalizedPath === '/api/resend/webhook'"))
    expect(at).toBeLessThan(guardAt)
  })

  it('is outside session auth and the origin check: SignWell holds neither', () => {
    const route = webhookRoute()
    expect(route).not.toContain('requireSession')
    expect(route).not.toContain('isCrossSiteOrigin')
    expect(route).not.toContain('isJsonContentType')
  })

  it('reads the RAW body (at most 1 MB), hands the handler the webhook id from the environment, 413s a big body and 400s an unreadable one', () => {
    const route = webhookRoute()
    expect(route).toContain('rawBody = await readRawBody(request, SIGNWELL_WEBHOOK_MAX_BYTES)')
    expect(serverSource).toContain('const SIGNWELL_WEBHOOK_MAX_BYTES = 1024 * 1024')
    expect(route).toContain('webhookId: process.env.SIGNWELL_WEBHOOK_ID')
    expect(route).toContain("if (error?.statusCode === 413) sendJson(response, 413, { error: 'Request body too large' })")
    expect(route).toContain("else sendJson(response, 400, { error: 'Could not read body' })")
  })

  it('records the activity of a signing "via SignWell", as the owner the handler resolved', () => {
    const helper = between('async function recordSignwellSigning(', '// ---- end of the SignWell glue')
    expect(helper).toContain('async function recordSignwellSigning(result, signatureRequest, signedBy)')
    expect(helper).toContain('const userId = signedBy || signatureRequest.createdBy')
    expect(helper).toContain('`${engagementActivityTarget(result.engagement)} via SignWell`')
  })

  it('answers first, THEN runs the slow part (setImmediate) and never lets it throw', () => {
    const route = webhookRoute()
    expect(route.indexOf('sendJson(response, handled.status, handled.body)')).toBeGreaterThan(-1)
    expect(route.indexOf('sendJson(response, handled.status, handled.body)')).toBeLessThan(route.indexOf('setImmediate('))
    expect(route).toContain('handled.after().catch(')
  })

  it('verifies the hash in the handler, before any lookup, and checks the metadata after re-fetching', () => {
    expect(handlerSource.indexOf('verifyEventHash(event, webhookId)')).toBeGreaterThan(-1)
    expect(handlerSource.indexOf('verifyEventHash(event, webhookId)')).toBeLessThan(
      handlerSource.indexOf('store.getSignatureRequestByDocumentId('),
    )
    expect(handlerSource.indexOf('signwell.getDocument(documentId)')).toBeLessThan(handlerSource.indexOf('metadata.app !== SIGNWELL_METADATA_APP'))
    expect(handlerSource.indexOf('recordSignwellEventOnce(')).toBeLessThan(handlerSource.indexOf('signwell.getDocument(documentId)'))
  })
})

describe('a signed letter never reaches an owner\'s mailbox (Alex, 2026-10-08)', () => {
  const FORBIDDEN = [
    'attachments',
    'sendInvoiceEmail',
    'sendDigestEmail',
    'sendReportEmail',
    'sendFeatureRequestEmail',
    'sendLoginLinkEmail',
    'getSignedDocument',
    'bcc',
    'Bcc',
    'BCC',
    'cc:',
    'OWNER_EMAIL_COPY',
  ]

  it('the glue and the handler carry no mail sender, attachment or signed document', () => {
    for (const [name, text] of [
      ['the server glue', glue()],
      ['the webhook route', webhookRoute()],
      ['lib/signwell-webhook.js', handlerSource],
    ] as const) {
      for (const forbidden of FORBIDDEN) {
        expect(text, `${forbidden} must not appear in ${name}`).not.toContain(forbidden)
      }
    }
    expect(handlerSource).not.toMatch(/from '\.\/notify\.js'/)
    expect(handlerSource).not.toMatch(/from '\.\/.*email/)
  })

  it('tells the owners through the ordinary notice - once per owner, the message only, with a link to the engagement page', () => {
    const helper = between('async function notifySignwellOwners(', '/** What the sign route records')
    expect(helper).toContain("member.role === 'owner'")
    expect(helper.match(/await notify\(/g)).toHaveLength(1)
    expect(helper).toContain("'engagement_esigned'")
    expect(helper).toMatch(/\bmessage,\s*subject: message,\s*link,/)
    // Only the glue calls notify(): the handler is given `notifyOwners`, never the notifier.
    expect(glue().match(/\bnotify\(/g)).toHaveLength(1)
    expect(handlerSource).not.toMatch(/\bnotify\(/)
  })

  it('the notice message is built from the party name and wording only: no address, amount or document', () => {
    for (const line of handlerSource.split('\n').filter((entry) => /signed their engagement letter/.test(entry))) {
      expect(line).not.toMatch(/email|\.pdf|bytes|amount|total|retainer/i)
    }
  })
})

describe('SignWell knowledge lives in two files', () => {
  it('only lib/signwell.js names SignWell\'s host or the key header', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        // Dot-folders hold tooling state and sibling worktrees (.claude/worktrees has a whole checkout).
        if (entry.name.startsWith('.') || ['node_modules', 'dist', 'tmp', 'output', 'docs'].includes(entry.name)) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.(js|mjs|ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) files.push(full)
      }
    }
    walk(root)
    const offenders = files
      .filter((file) => /signwell\.com|X-Api-Key/i.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(root, file).replace(/\\/g, '/'))
    expect(offenders).toEqual(['lib/signwell.js'])
  })

  it('logs nothing in the client module, and the handler logs ids and event types only', () => {
    expect(clientSource).not.toMatch(/console\.(log|info|warn|error)/)
    for (const line of handlerSource.split('\n').filter((entry) => /log\.(info|warn|error)\(/.test(entry))) {
      expect(line).not.toMatch(/email|payload|rawBody|related_signer|\$\{bytes\b/i)
    }
  })

  it('reads the key and test mode only through the module\'s own helpers', () => {
    expect(clientSource).toContain('SIGNWELL_API_KEY')
    expect(clientSource).toContain('SIGNWELL_TEST_MODE')
    expect(handlerSource).not.toContain('SIGNWELL_API_KEY')
    expect(handlerSource).not.toContain('SIGNWELL_TEST_MODE')
    expect(glue()).not.toContain('SIGNWELL_API_KEY')
  })
})

describe('the boot says when an e-signature was left half-finished', () => {
  it('lists requests left finishing right after the store is initialized (no grace at boot), logs their ids, and never stops the boot', () => {
    const boot = between('await appDataStore.initialize()', '// Bulletproof owner recovery')
    expect(boot).toContain('await warnSignwellLeftFinishing(0)')
    expect(boot).toContain('await appDataStore.listStuckSignatureRequestIds(olderThanMs)')
    expect(boot).toContain("ids.join(', ')")
    // The log line sends a person to the letter, not to a button's name.
    expect(boot).toContain('open the letter in the app')
    expect(boot).not.toContain('Finish e-signature"')
    expect(boot).not.toMatch(/press Finish/)
    expect(boot).toContain('} catch (error) {')
  })

  it('re-checks hourly, leaving a 10 minute grace for work that is under way', () => {
    const boot = between('await appDataStore.initialize()', '// Bulletproof owner recovery')
    expect(boot).toContain('warnSignwellLeftFinishing(10 * 60 * 1000)')
    expect(boot).toContain('setInterval(() => void runPeriodicJob(signwellFinishingJob), 60 * 60 * 1000)')
  })
})

describe('the open pages hear about a webhook that changed something', () => {
  it('broadcasts after the answer, only when the event was new and was ours', () => {
    const route = webhookRoute()
    expect(route).toContain('if (handled.body.received && !handled.body.duplicate && !handled.body.ignored && !handled.body.refetch) {')
    expect(route.indexOf('sendJson(response, handled.status, handled.body)')).toBeLessThan(route.indexOf('broadcastDataChanged()'))
    expect(route.indexOf('broadcastDataChanged()')).toBeLessThan(route.indexOf('setImmediate('))
  })
})
