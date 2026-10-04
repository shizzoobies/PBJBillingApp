import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The proposal questionnaire's glue (featreq-8f139178) - the owner routes under
 * `/api/proposal-questionnaires` and what runs after an answer lands.
 *
 * SAME CAVEAT as invoice-pay-link-routes.test.ts: `server.js` calls
 * `server.listen()` at module scope and exports nothing, so there is no HTTP
 * harness here. The store half (submit once, expiry, withdrawal, the single
 * draft) is exercised on both backends in db/store-staleness.test.mjs. What can
 * rot HERE is the wiring, and each assertion pins something whose failure is
 * silent and expensive:
 *
 *  - a route loses its owner check and a prospect, or a stale tab of a former
 *    team member, reads every prospect's answers;
 *  - a response carries the token, and the public link leaks to anyone who can
 *    open the inbox;
 *  - the draft is started BEFORE the answers are taken, so a refused submission
 *    still leaves a draft behind;
 *  - a notification or draft failure throws after the answer was stored, and the
 *    prospect is told their submission failed when it did not.
 *
 * These prove wiring, not behavior. Read a failure as "the route changed, go
 * look".
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const serverSource = readFileSync(path.join(root, 'server.js'), 'utf8')
const storeSource = readFileSync(path.join(root, 'db/store.js'), 'utf8')

/** The text from `start` up to (not including) the next `end`, both required. */
function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  expect(from, `${start} is gone`).toBeGreaterThan(-1)
  const to = source.indexOf(end, from + start.length)
  expect(to, `${end} is gone - re-anchor this`).toBeGreaterThan(from)
  return source.slice(from, to)
}

const ownerBlock = between(
  serverSource,
  '// ---- Proposal questionnaires (owner) ----',
  '// ---- Proposals (featreq-311473e2 / featreq-ef18a38e)',
)
const gate = between(
  serverSource,
  'async function requireQuestionnaireOwner(',
  'async function finishQuestionnaireSubmission(',
)
const finish = between(
  serverSource,
  'async function finishQuestionnaireSubmission(',
  '// ---- Consolidated billing',
)

describe('the owner routes', () => {
  it('every one goes through the owner gate before anything else', () => {
    const calls = ownerBlock.match(/requireQuestionnaireOwner\(/g) ?? []
    // list, create, and the one id route (read / save / actions share a check).
    expect(calls.length).toBeGreaterThanOrEqual(3)
    // The gate itself: a session, an owner, and for a write the same-origin JSON check.
    expect(gate).toContain('requireSession(request, response)')
    expect(gate).toContain("session.user.role !== 'owner'")
    expect(gate).toContain('isCrossSiteOrigin(request)')
    expect(gate).toContain('isJsonContentType(request)')
  })

  it('has no route that skips the gate by calling the store first', () => {
    // Every store call in the block sits after a gate call in its own route; the
    // simplest thing that can rot is a new route pasted in without one.
    const storeCalls = ownerBlock.match(/appDataStore\.\w+Questionnaire\w*\(/g) ?? []
    expect(storeCalls.length).toBeGreaterThan(0)
    const firstStore = ownerBlock.search(/appDataStore\.\w+Questionnaire\w*\(/)
    const firstGate = ownerBlock.indexOf('requireQuestionnaireOwner(')
    expect(firstGate).toBeGreaterThan(-1)
    expect(firstGate).toBeLessThan(firstStore)
  })

  it('never puts a token in an answer', () => {
    expect(ownerBlock).not.toMatch(/\.token\b/)
    // Every response body in the block is a view or a plain object, not a raw record.
    for (const sent of ownerBlock.match(/sendJson\(response, 20[01], [^)]*\)/g) ?? []) {
      expect(sent, sent).toMatch(/questionnaireView|questionnaires:|proposal|\{ error/)
    }
  })

  it('answers a store refusal with its sentence and reason', () => {
    expect(ownerBlock).toContain('instanceof ProposalQuestionnaireError')
    expect(serverSource).toContain("error: 'questionnaire_refused'")
  })

  it('takes the answers BEFORE it starts the draft', () => {
    const submit = ownerBlock.indexOf('appDataStore.submitProposalQuestionnaire(')
    const draft = ownerBlock.indexOf('finishQuestionnaireSubmission(')
    expect(submit).toBeGreaterThan(-1)
    expect(draft).toBeGreaterThan(submit)
  })
})

describe('what follows a submission', () => {
  it('starts the draft, then notifies the owners - each failure logged, neither thrown', () => {
    const draft = finish.indexOf('startProposalQuestionnaireDraft(')
    const notice = finish.indexOf("notify(appDataStore, owner.id, 'proposal_questionnaire_answered'")
    expect(draft).toBeGreaterThan(-1)
    expect(notice).toBeGreaterThan(draft)
    expect((finish.match(/try \{/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect((finish.match(/console\.error\('\[questionnaire\]/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  it('tells the owners about a link, not about a call sheet one of them is typing', () => {
    expect(finish).toContain("submitted.mode === 'link'")
  })
})

describe('the table', () => {
  const table = between(
    storeSource,
    'create table if not exists proposal_questionnaires (',
    'proposal_questionnaires_token_key',
  )

  it('checks the mode and the status, and holds no foreign key', () => {
    expect(table).toContain("check (mode in ('link', 'call'))")
    expect(table).toContain("check (status in ('open', 'submitted', 'withdrawn'))")
    expect(table).not.toMatch(/references/i)
  })

  it('makes the token unique, so a link names one questionnaire', () => {
    expect(storeSource).toContain(
      'create unique index if not exists proposal_questionnaires_token_key on proposal_questionnaires (token)',
    )
  })

  it('claims the single submission and the single draft in the WHERE, not in JavaScript', () => {
    expect(storeSource).toContain("and status = 'open' and (expires_at is null or expires_at > now())")
    expect(storeSource).toContain('where id = $1 and proposal_id is null')
  })
})

/* ------------------------------------------------------------------------ */
/* The public link, the email and the webhook (part 2)                       */
/* ------------------------------------------------------------------------ */

const publicBlock = between(
  serverSource,
  'const questionnaireMatch = normalizedPath.match(',
  '// ---- GET /pay/:token',
)
const notifySource = readFileSync(path.join(root, 'lib/notify.js'), 'utf8')

describe('the public questionnaire route', () => {
  it('is public, and answers only with pages - never JSON, never a cookie', () => {
    expect(publicBlock).not.toContain('requireSession')
    expect(publicBlock).not.toContain('sendJson(')
    expect(publicBlock).not.toMatch(/Set-Cookie|appendSetCookie/)
    expect(publicBlock).toContain("request.method === 'GET' || request.method === 'HEAD'")
    expect(publicBlock).toContain("request.method === 'POST'")
  })

  it('sits above the /api/ 404 and the SPA fallback, or a link answers with the app shell', () => {
    const at = serverSource.indexOf('const questionnaireMatch = normalizedPath.match(')
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(serverSource.indexOf("if (normalizedPath.startsWith('/api/')) {"))
    expect(at).toBeLessThan(serverSource.indexOf('indexFile', serverSource.indexOf('const indexFile') + 20))
  })

  it('checks the token SHAPE before it ever asks the database, and rate-limits before the lookup', () => {
    const shape = publicBlock.indexOf('/^[A-Za-z0-9_-]{20,64}$/.test(linkToken)')
    const ipLimit = publicBlock.indexOf('isRateLimited(`ip:${getClientIp(request)}`')
    const lookup = publicBlock.indexOf('findProposalQuestionnaireByToken(linkToken)')
    expect(shape).toBeGreaterThan(-1)
    expect(ipLimit).toBeGreaterThan(shape)
    expect(lookup).toBeGreaterThan(ipLimit)
    expect(publicBlock).toContain('{ max: 30, bucket: questionnaireAttempts }')
    expect(publicBlock).toContain('{ max: 5, bucket: questionnaireAttempts }')
  })

  it('answers an unknown and a malformed token with the same page and status', () => {
    const notFound = publicBlock.match(/renderQuestionnaireNotFoundPage\(\), 404/g) ?? []
    expect(notFound.length).toBeGreaterThanOrEqual(2)
  })

  it('makes a GET or HEAD change nothing: no store write between the lookup and the page', () => {
    const read = between(publicBlock, 'if (isRead) {', '// ---- POST ----')
    expect(read).not.toMatch(/appDataStore\.(submit|save|renew|withdraw|append|create|start)/)
  })

  it('refuses a cross-site post, a wrong content type and a big body BEFORE it submits', () => {
    const submit = publicBlock.indexOf('appDataStore.submitProposalQuestionnaire(')
    for (const guard of [
      'isCrossSiteOrigin(request)',
      "includes('application/x-www-form-urlencoded')",
      'readRawBody(request, MAX_FORM_BODY_BYTES)',
    ]) {
      const at = publicBlock.indexOf(guard)
      expect(at, guard).toBeGreaterThan(-1)
      expect(at, guard).toBeLessThan(submit)
    }
    expect(serverSource).toContain('const MAX_FORM_BODY_BYTES = 64 * 1024')
  })

  it('reads the form against the frozen questions and submits by token', () => {
    expect(publicBlock).toContain('readQuestionnaireForm(formBody, record.questions)')
    expect(publicBlock).toContain('{ token: linkToken }')
    expect(publicBlock).toContain('answersFromFormValues(values)')
  })

  it('303s to a fixed thank-you page after the submission, so a refresh cannot post twice', () => {
    const submit = publicBlock.indexOf('appDataStore.submitProposalQuestionnaire(')
    const finish = publicBlock.indexOf('finishQuestionnaireSubmission(request, submitted)')
    const redirect = publicBlock.indexOf('response.writeHead(303')
    expect(finish).toBeGreaterThan(submit)
    expect(redirect).toBeGreaterThan(finish)
    expect(publicBlock).toContain("Location: '/questionnaire/thanks'")
    // Nothing personal rides in the address.
    expect(publicBlock).not.toMatch(/Location: `/)
  })

  it('has its own catch that answers a page, never the JSON the global handler would', () => {
    expect(publicBlock).toContain("console.error('[questionnaire] public route failed:'")
    expect(publicBlock).toContain("heading: 'Something went wrong'")
  })

  it('every answer carries the questionnaire headers', () => {
    expect(serverSource).toMatch(
      /function sendQuestionnairePage\([^)]*\) \{[\s\S]{0,300}\.\.\.QUESTIONNAIRE_RESPONSE_HEADERS/,
    )
    expect(publicBlock).toContain('...QUESTIONNAIRE_RESPONSE_HEADERS')
  })

  it('sweeps its rate-limit bucket with the others', () => {
    expect(serverSource).toContain(
      'for (const bucket of [requestLinkAttempts, payLinkAttempts, questionnaireAttempts])',
    )
  })
})

describe('the owner routes, now with links', () => {
  it('never put the bare token in an answer; the view carries the link of an open link only', () => {
    const view = between(serverSource, 'function questionnaireView(', 'const QUESTIONNAIRE_EMAIL_PATTERN')
    expect(view).toContain('const { token, ...rest } = record')
    expect(view).not.toMatch(/\btoken,\s*$/m)
    expect(view).toContain("record.mode === 'link' && record.status === 'open' && !record.expired")
    expect(ownerBlock).not.toMatch(/\.token\b/)
  })

  it('every view in the owner block is built with the request, so the link is public-origin', () => {
    expect(ownerBlock).not.toMatch(/questionnaireView\([a-z]+\)/)
    expect(ownerBlock).not.toContain('.map(questionnaireView)')
  })

  it('checks the address before it makes anything, and only a link takes one', () => {
    const create = between(ownerBlock, "request.method === 'POST') {", 'const questionnaireIdMatch')
    const check = create.indexOf('QUESTIONNAIRE_EMAIL_PATTERN.test(to)')
    const make = create.indexOf('appDataStore.createProposalQuestionnaire(')
    expect(check).toBeGreaterThan(-1)
    expect(check).toBeLessThan(make)
    expect(create).toContain("payload.mode !== 'link'")
  })

  it('a new link goes through the same email path as the first one', () => {
    const renew = between(ownerBlock, "if (action === 'new-link') {", "if (action === 'withdraw')")
    expect(renew).toContain('renewProposalQuestionnaireLink(questionnaireId)')
    expect(renew).toContain('emailQuestionnaireLink(request, renewed, to)')
  })
})

describe('the email', () => {
  const emailer = between(
    serverSource,
    'async function emailQuestionnaireLink(',
    'async function recordQuestionnaireDelivery(',
  )

  it('goes through the invoice sender, tagged with the questionnaire', () => {
    expect(emailer).toContain('sendInvoiceEmail({')
    expect(emailer).toContain('questionnaireId: record.id')
    expect(emailer).toContain("kind: 'questionnaire'")
  })

  it('logs every attempt, failed ones too, and never throws', () => {
    expect(emailer).toContain('appendProposalQuestionnaireEmailEvent(record.id')
    expect(emailer).toContain('ok: sendResult.ok')
    expect(emailer).toMatch(/\} catch \(error\) \{[\s\S]*return \{ ok: false/)
  })

  it('puts the questionnaire tag on the Resend payload', () => {
    expect(notifySource).toContain("tags.push({ name: 'questionnaire_id', value: questionnaire })")
  })
})

describe('the Resend webhook', () => {
  const webhook = between(
    serverSource,
    "normalizedPath === '/api/resend/webhook'",
    'const taggedInvoiceId',
  )

  it('routes a questionnaire-tagged event to the questionnaire BEFORE the invoice lookup', () => {
    const branch = webhook.indexOf("typeof tagBag.questionnaire_id === 'string'")
    expect(branch).toBeGreaterThan(-1)
    expect(webhook.indexOf('recordQuestionnaireDelivery(')).toBeGreaterThan(branch)
    // ...and the invoice fall-through is still the last thing in the handler.
    expect(serverSource.indexOf('const taggedInvoiceId')).toBeGreaterThan(
      serverSource.indexOf("typeof tagBag.questionnaire_id === 'string'"),
    )
    // The proposal branch is untouched and still ahead of it.
    expect(webhook.indexOf("typeof tagBag.proposal_id === 'string'")).toBeLessThan(branch)
  })

  it('files the event on the questionnaire, never on its status, and tells owners once about a bounce', () => {
    const handler = between(
      serverSource,
      'async function recordQuestionnaireDelivery(',
      '// ---- Consolidated billing',
    )
    expect(handler).toContain('appendProposalQuestionnaireEmailEvent(found.id')
    expect(handler).not.toMatch(/status/i)
    expect(handler).toContain('!alreadyLogged')
    expect(handler).toContain("'invoice_email_bounced'")
  })
})
