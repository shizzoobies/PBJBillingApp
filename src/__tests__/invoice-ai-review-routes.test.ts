import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The invoice-confidence API surface, pinned at the level this repo can reach.
 *
 * WHAT THIS IS AND IS NOT — the same shape and the same reason as
 * invoice-coverage-routes.test.ts: `server.js` calls `server.listen()` at module
 * scope and exports nothing, so importing it here would start a real listener
 * and reach for a database. The decisions themselves are tested where they
 * live — the store functions in db/store-staleness.test.mjs, the rating call in
 * lib/invoice-confidence.test.mjs.
 *
 * What is left over is the GLUE, and this feature has four pieces of it that
 * can rot silently while every unit test still passes:
 *   1. the owner-only guards on three new routes,
 *   2. the `actorUserId` the PATCH handler must hand `updateInvoice` — omit it
 *      and every review event records a null actor, forever, with no error,
 *   3. the refusals that must run BEFORE the model is paid for a verdict,
 *   4. the auto-rate hook staying fire-and-forget, and every route staying
 *      above the `/api/` catch-all that would otherwise 404 it.
 *
 * These assertions read the route source. They prove wiring, not behavior.
 * Treat a failure as "the routing moved, go look".
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
)

/** The body of a route block, from its opening guard to the next route match. */
function routeBlock(startPattern: RegExp, length = 4000): string {
  const at = serverSource.search(startPattern)
  expect(at, `route not found: ${startPattern}`).toBeGreaterThan(-1)
  return serverSource.slice(at, at + length)
}

/** One module-scope function, from its declaration to the next one. */
function functionSource(declaration: string, length: number): string {
  const at = serverSource.indexOf(declaration)
  expect(at, `function not found: ${declaration}`).toBeGreaterThan(-1)
  return serverSource.slice(at, at + length)
}

/** The background rating loop. */
const schedulerSource = () => functionSource('function scheduleInvoiceRatings(', 2000)
/** The one place the rating inputs are assembled. */
const helperSource = () => functionSource('async function rateInvoiceAndPersist(', 2000)

describe('the three AI-review routes exist and are owner-only', () => {
  it('lists a month’s ratings behind the owner check, validating the period', () => {
    const block = routeBlock(
      /if \(normalizedPath === '\/api\/invoices\/ai-reviews' && request\.method === 'GET'\)/,
      1400,
    )
    expect(block).toContain("session.user.role !== 'owner'")
    expect(block).toContain("sendJson(response, 403, { error: 'Only owners can see invoices' })")
    expect(block).toContain("sendJson(response, 400, { error: 'period must look like 2026-08' })")
    expect(block).toContain('appDataStore.listInvoiceAiReviews(')
  })

  it('rates one invoice behind owner + same-origin + JSON, like every invoice write', () => {
    const block = routeBlock(
      /const invoiceRateMatch = normalizedPath\.match\(/,
      4200,
    )
    expect(block).toContain("sendJson(response, 403, { error: 'Only owners can rate invoices' })")
    expect(block).toContain("sendJson(response, 403, { error: 'Origin not allowed' })")
    expect(block).toContain("sendJson(response, 415, { error: 'application/json required' })")
    expect(block).toContain('rateInvoiceAndPersist(invoiceToRate)')
    expect(block).toContain('sendJson(response, 200, { review })')
  })

  it('answers one question behind the same three guards', () => {
    const block = routeBlock(
      /const invoiceAnswerMatch = normalizedPath\.match\(/,
      4200,
    )
    expect(block).toContain(
      "sendJson(response, 403, { error: 'Only owners can answer AI review questions' })",
    )
    expect(block).toContain("sendJson(response, 403, { error: 'Origin not allowed' })")
    expect(block).toContain("sendJson(response, 415, { error: 'application/json required' })")
    expect(block).toContain("sendJson(response, 400, { error: 'questionId is required' })")
    expect(block).toContain('appDataStore.answerInvoiceAiReviewQuestion(')
  })

  // The answer is a free-text box on a public-facing owner page; 2000 is the
  // same ceiling the Updates tracker's description carries.
  it('trims and caps the answer at 2000 characters', () => {
    const block = routeBlock(/const invoiceAnswerMatch = normalizedPath\.match\(/, 4200)
    expect(block).toMatch(/String\(answerPayload\?\.answer \?\? ''\)\s*\.trim\(\)\s*\.slice\(0, 2000\)/)
  })

  // A re-rate landing under the page she is reading is a fact about the data,
  // not a crash — and the store says so in a sentence.
  it('maps the store’s stale-review error to its own status and message', () => {
    const block = routeBlock(/const invoiceAnswerMatch = normalizedPath\.match\(/, 4200)
    expect(block).toContain('error instanceof InvoiceAiReviewError')
    expect(block).toMatch(/error: 'ai_review_stale',\s*message: error\.message,/)
    expect(serverSource).toMatch(
      /import \{[\s\S]*?InvoiceAiReviewError,[\s\S]*?\} from '\.\/db\/store\.js'/,
    )
  })
})

describe('the PATCH handler names who edited the invoice', () => {
  // THE SILENT ONE. `updateInvoice` writes an `invoice_review_events` row from
  // `opts.actorUserId`; drop the argument and every row records null — no
  // error, no failing store test, and the trust corpus this whole feature
  // exists to build is anonymous forever.
  it('passes actorUserId from the session, not from the body', () => {
    const block = routeBlock(/const invoicePatchMatch = normalizedPath\.match\(/, 3000)
    expect(block).toMatch(
      /appDataStore\.updateInvoice\(invoiceId, payload \?\? \{\}, \{\s*actorUserId: session\.user\.id,\s*\}\)/,
    )
    // Never from the wire: a caller-supplied actor is a claim, not a fact.
    expect(block).not.toContain('payload?.actorUserId')
  })
})

describe('the re-rate route refuses before it pays for a verdict', () => {
  const block = () => routeBlock(/const invoiceRateMatch = normalizedPath\.match\(/, 4200)

  it('refuses a retainer with a sentence, not a rating', () => {
    const text = block()
    expect(text).toContain("invoiceToRate.kind === 'retainer'")
    expect(text).toMatch(/sendJson\(response, 409, \{\s*error: 'retainer_not_rated'/)
  })

  it('refuses anything that has left draft/reviewed', () => {
    const text = block()
    expect(text).toContain('RATEABLE_INVOICE_STATUSES.has(invoiceToRate.status)')
    expect(text).toMatch(/sendJson\(response, 409, \{\s*error: 'invoice_not_rateable'/)
    expect(serverSource).toMatch(
      /const RATEABLE_INVOICE_STATUSES = new Set\(\['draft', 'reviewed'\]\)/,
    )
  })

  it('answers 404 for an invoice that is not there', () => {
    expect(block()).toContain("sendJson(response, 404, { error: 'Invoice not found' })")
  })

  // Both refusals and the missing-key check have to sit ABOVE the model call.
  // Below it they still answer correctly and still cost thirty seconds of Opus.
  it('runs every refusal before the rating call', () => {
    const text = block()
    const modelAt = text.indexOf('rateInvoiceAndPersist(invoiceToRate)')
    expect(modelAt).toBeGreaterThan(-1)
    expect(text.indexOf('process.env.ANTHROPIC_API_KEY')).toBeLessThan(modelAt)
    expect(text.indexOf("invoiceToRate.kind === 'retainer'")).toBeLessThan(modelAt)
    expect(text.indexOf('RATEABLE_INVOICE_STATUSES')).toBeLessThan(modelAt)
  })
})

describe('the re-rate route’s error contract', () => {
  const block = () => routeBlock(/const invoiceRateMatch = normalizedPath\.match\(/, 4200)

  it('says the invoice is untouched rather than "your notes are safe"', () => {
    // The lib borrows the brainstorm feature's capacity message, which ends
    // "Your notes are safe." — meaningless next to an invoice. The substitute
    // is the point of this assertion.
    expect(serverSource).toMatch(
      /const INVOICE_RATING_CAPACITY_MESSAGE =\s*'The AI reviewer is at capacity right now — try again in a minute\. ' \+\s*'The invoice itself is untouched\.'/,
    )
    const text = block()
    expect(text).toContain('message: INVOICE_RATING_CAPACITY_MESSAGE')
    expect(text).not.toContain('Your notes are safe')
  })

  it('keeps 503 as 503 and everything else as a friendly 502', () => {
    const text = block()
    expect(text).toContain('const status = error?.statusCode ?? error?.status ?? 502')
    expect(text).toMatch(/if \(status === 503\) \{\s*sendJson\(response, 503, \{/)
    expect(text).toMatch(/sendJson\(response, 502, \{\s*error: 'ai_review_failed'/)
    expect(text).toContain("console.error('[invoices] ai review failed:'")
  })

  it('answers 503 with its own sentence when there is no API key at all', () => {
    const text = block()
    expect(text).toMatch(/sendJson\(response, 503, \{\s*error: 'ai_review_unconfigured'/)
  })
})

describe('generate and regenerate both rate the month without waiting for it', () => {
  const hookAt = (routePattern: RegExp) => {
    const text = routeBlock(routePattern, 6000)
    const callAt = text.indexOf('scheduleInvoiceRatings(')
    expect(callAt, 'the auto-rate hook is not wired into this route').toBeGreaterThan(-1)
    return { text, callAt }
  }

  it('generate schedules the ratings, unawaited, before it answers', () => {
    const { text, callAt } = hookAt(
      /if \(normalizedPath === '\/api\/invoices\/generate' && request\.method === 'POST'\)/,
    )
    expect(text.slice(callAt - 40, callAt)).not.toContain('await')
    expect(text.slice(callAt, callAt + 60)).toContain('result.created')
    // Fire-and-forget means the response is not behind it.
    expect(callAt).toBeLessThan(text.indexOf('sendJson(response, 200, result)'))
  })

  it('regenerate schedules the ratings for the rebuilt drafts, unawaited', () => {
    const { text, callAt } = hookAt(
      /if \(normalizedPath === '\/api\/invoices\/regenerate' && request\.method === 'POST'\)/,
    )
    expect(text.slice(callAt - 40, callAt)).not.toContain('await')
    expect(text.slice(callAt, callAt + 60)).toContain('rebuilt.created')
  })

  // The scheduler itself: no key means Generate must still work, retainers are
  // never rated, and one client's failure must not take the rest of the month
  // down with it.
  it('the scheduler skips silently without a key, skips retainers, and survives one failure', () => {
    const fn = schedulerSource()
    expect(fn).toContain('if (!process.env.ANTHROPIC_API_KEY) return')
    expect(fn).toContain("invoice.kind !== 'retainer'")
    expect(fn).toContain('await rateInvoiceAndPersist(invoice, preloaded)')
    expect(fn).toContain('broadcastDataChanged()')
    expect(fn).toContain('console.warn(')
    // Sequential, not Promise.all — forty invoices are forty Opus calls and
    // nobody is waiting on them.
    expect(fn).not.toContain('Promise.all')
    expect(fn).toContain('for (const invoice of queue)')
  })

  /**
   * THE EXPENSIVE MISTAKE. `appDataStore.read()` is not a pure read: it runs
   * the recurring-checklist materializer and can enter a guarded bulk-save
   * write-back. One per invoice turns a forty-client month into forty full
   * workspace reads and up to forty background write transactions, running
   * while Brittany works that same month run. The shared context must be
   * loaded ONCE, above the loop.
   */
  it('loads the shared context once, above the loop — never per invoice', () => {
    const fn = schedulerSource()
    const readAt = fn.indexOf('await appDataStore.read()')
    const loopAt = fn.indexOf('for (const invoice of queue)')
    expect(readAt, 'the batch no longer loads the workspace at all').toBeGreaterThan(-1)
    expect(loopAt).toBeGreaterThan(-1)
    expect(readAt, 'the workspace read moved into the per-invoice loop').toBeLessThan(loopAt)

    // Exactly one read in the whole scheduler, and none of it inside the loop.
    expect(fn.split('appDataStore.read()').length - 1).toBe(1)
    expect(fn.slice(loopAt)).not.toContain('appDataStore.read()')
    expect(fn.slice(loopAt)).not.toContain('appDataStore.listInvoices(')
  })

  it('the shared context carries the workspace and the prior period’s invoices', () => {
    const fn = schedulerSource()
    expect(fn).toContain('preloaded = { data, priorInvoicesByPeriod }')
    expect(fn).toContain('appDataStore.listInvoices({ period: prior })')
  })

  // The single re-rate has no batch to share, so it must still be able to load
  // its own — the pre-loaded context is an optimization, not a requirement.
  it('the helper falls back to its own reads when nothing is pre-loaded', () => {
    const fn = helperSource()
    expect(fn).toContain('preloaded?.data ?? (await appDataStore.read())')
    expect(fn).toContain('preloaded?.priorInvoicesByPeriod?.get(prior)')
  })

  // Per-client by definition, and its firm-wide slice EXCLUDES that client —
  // no two invoices in a batch want the same answer, so it is not hoistable.
  it('keeps the learning context per invoice', () => {
    expect(helperSource()).toContain(
      'appDataStore.listInvoiceLearningContext(invoice.clientId, {})',
    )
    expect(schedulerSource()).not.toContain('listInvoiceLearningContext')
  })

  // One assembly of the rating inputs, shared by the endpoint and the hook, so
  // the two can never drift into rating the same draft differently.
  it('both paths go through the one input-assembly helper', () => {
    const fn = helperSource()
    expect(fn).toContain('buildInvoiceHoursSummary(')
    expect(fn).toContain('appDataStore.listInvoiceLearningContext(')
    expect(fn).toContain('previousPeriod(invoice.period)')
    expect(fn).toContain('rateInvoiceDraft(')
    expect(fn).toContain('appDataStore.createInvoiceAiReview(')
  })
})

describe('every AI-review route sits above the /api/ catch-all', () => {
  // A route below the catch-all answers 404 forever while every other test
  // still passes — see api-404-fallthrough.test.ts for the guard itself.
  const GUARD = "if (normalizedPath.startsWith('/api/')) {"

  it('all three matchers appear before the guard', () => {
    const guardAt = serverSource.indexOf(GUARD)
    expect(guardAt, 'the /api/ catch-all guard is gone').toBeGreaterThan(-1)

    for (const marker of [
      "normalizedPath === '/api/invoices/ai-reviews'",
      'const invoiceRateMatch = normalizedPath.match(',
      'const invoiceAnswerMatch = normalizedPath.match(',
    ]) {
      const at = serverSource.indexOf(marker)
      expect(at, `route missing: ${marker}`).toBeGreaterThan(-1)
      expect(at, `route is below the /api/ catch-all: ${marker}`).toBeLessThan(guardAt)
    }
  })

  // `ai-reviews` is a literal segment that a /api/invoices/:id matcher would
  // happily swallow. The GET must be declared first.
  it('the ai-reviews list is declared before the /:id matchers', () => {
    expect(serverSource.indexOf("normalizedPath === '/api/invoices/ai-reviews'")).toBeLessThan(
      serverSource.indexOf('const invoicePatchMatch = normalizedPath.match('),
    )
  })
})
