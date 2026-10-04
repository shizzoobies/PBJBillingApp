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
    expect(serverSource).toMatch(/const \{ token: _token, \.\.\.rest \} = record/)
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
