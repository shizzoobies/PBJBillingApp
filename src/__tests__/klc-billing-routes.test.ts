import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The consolidated-billing API surface — one invoice to a BILLING MASTER, four
 * companies behind it (docs/plans/consolidated-billing-2026-08.md).
 *
 * WHAT THIS IS AND IS NOT — the same shape and the same reason as
 * invoice-ai-review-routes.test.ts: `server.js` calls `server.listen()` at
 * module scope and exports nothing, so importing it here would start a real
 * listener and reach for a database. The decisions themselves are tested where
 * they live — the store guards and `listBilledOnInvoices` in
 * db/store-staleness.test.mjs, the roll-up in lib/client-recap.test.mjs, the
 * combined rendering in lib/invoice-email.test.mjs.
 *
 * What is left over is the GLUE, and this feature's glue has five pieces that
 * can rot silently while every unit test still passes:
 *   1. WHO the master's invoice is emailed to. A master has no contacts of its
 *      own; the addressee is the ONE sub it names. A fallback to "everyone" here
 *      would send four companies each other's consolidated invoice, and an email
 *      cannot be unsent — so the refusal must run BEFORE anything is delivered.
 *   2. the sub's "Billed on INV-…" read, without which a sub's client page shows
 *      no invoice for the month and reads as "we forgot to bill them",
 *   3. the Recap branching to the roll-up for a master while every non-master
 *      answer stays exactly what it was,
 *   4. `BillingMasterError` reaching the wire as a 409 sentence rather than a
 *      500 — four store guards throw it and not one of those handlers has a
 *      catch of its own,
 *   5. the AI rating's hours summary looking at the SUBS' hours, since the
 *      master has none and would otherwise have every hourly line on the
 *      consolidated invoice reported as unsupported.
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

/** One module-scope function, from its declaration to roughly the next one. */
function functionSource(declaration: string, length: number): string {
  const at = serverSource.indexOf(declaration)
  expect(at, `function not found: ${declaration}`).toBeGreaterThan(-1)
  return serverSource.slice(at, at + length)
}

/** The catch-all guard every /api route has to sit above. */
const GUARD = "if (normalizedPath.startsWith('/api/')) {"

describe('the store’s billing-master types are imported at all', () => {
  it('server.js imports BillingMasterError and buildMasterRecap', () => {
    expect(serverSource).toMatch(
      /import \{[\s\S]*?BillingMasterError,[\s\S]*?\} from '\.\/db\/store\.js'/,
    )
    expect(serverSource).toContain(
      "import { buildClientRecap, buildMasterRecap } from './lib/client-recap.js'",
    )
  })
})

describe('who a billing master’s invoice is emailed to', () => {
  const helper = () => functionSource('function invoiceEmailAddressee(', 1200)

  it('an ordinary client answers itself, unchanged', () => {
    expect(helper()).toContain(
      "if (client?.isBillingMaster !== true) return { addressee: client ?? null, refusal: null }",
    )
  })

  it('a master resolves to the ONE sub it names, and only if it is still a sub', () => {
    const fn = helper()
    expect(fn).toContain('client.invoiceRecipientClientId')
    // Both halves matter: the right id, AND that client still billing to this
    // master. A company moved out from under the master must stop receiving.
    expect(fn).toMatch(/entry\?\.id === chosen && entry\?\.billToClientId === client\.id/)
  })

  it('refuses rather than falling back to every sub’s contacts', () => {
    const fn = helper()
    expect(fn).toContain('if (!sub) return { addressee: null, refusal: MASTER_RECIPIENT_UNSET }')
    // THE UNRECOVERABLE ONE. Past the non-master early return there is no path
    // that hands back the master, or a list, as the addressee.
    const afterEarlyReturn = fn.slice(fn.indexOf('const chosen ='))
    expect(afterEarlyReturn).not.toContain('addressee: client')
    expect(afterEarlyReturn).not.toContain('.filter(')
    expect(afterEarlyReturn).not.toContain('flatMap')
  })

  // The remedy has to be one that EXISTS. Nothing in src/ writes
  // `invoiceRecipientClientId` — the picker is a filed follow-up — so naming a
  // Settings control would send whoever read it hunting for something that is
  // not there. When the picker ships, this sentence changes with it.
  it('says the same sentence everywhere, and points at a remedy that exists', () => {
    expect(serverSource).toMatch(
      /const MASTER_RECIPIENT_UNSET = Object\.freeze\(\{\s*error: 'master_recipient_unset',\s*message:\s*'This master has no receiving company set for its invoices yet — ask Alex to set one\.',\s*\}\)/,
    )
    expect(serverSource).not.toContain('Settings on the master client')
  })
})

describe('the send route refuses before it sends anything', () => {
  const block = () => routeBlock(/const invoiceSendMatch = normalizedPath\.match\(/, 11000)

  it('answers 409 with the unset-recipient sentence', () => {
    const text = block()
    expect(text).toContain(
      'const sendAddressee = invoiceEmailAddressee(sendClient, sendAppData.clients ?? [])',
    )
    expect(text).toMatch(/if \(sendAddressee\.refusal\) \{\s*sendJson\(response, 409, sendAddressee\.refusal\)/)
  })

  it('resolves the addresses from the addressee, never from the master itself', () => {
    const text = block()
    expect(text).toMatch(
      /resolveInvoiceRecipients\(\{\s*client: sendAddressee\.addressee,\s*contacts: sendAppData\.contacts \?\? \[\],\s*\}\)/,
    )
    expect(text).not.toContain('resolveInvoiceRecipients({\n        client: sendClient,')
  })

  // An email cannot be unsent, so the refusal has to sit above BOTH the address
  // resolution and the delivery — not merely above the delivery.
  it('runs the refusal before the resolver and before the send', () => {
    const text = block()
    const refusalAt = text.indexOf('if (sendAddressee.refusal)')
    const resolveAt = text.indexOf('resolveInvoiceRecipients({')
    const sendAt = text.indexOf('await sendInvoiceEmail({')
    expect(refusalAt).toBeGreaterThan(-1)
    expect(resolveAt).toBeGreaterThan(-1)
    expect(sendAt, 'the send call moved out of this block').toBeGreaterThan(-1)
    expect(refusalAt).toBeLessThan(resolveAt)
    expect(resolveAt).toBeLessThan(sendAt)
  })

  // The document itself still renders as the MASTER's — combined mode, the
  // master's name. Only the envelope is the sub's.
  it('keeps the master as the client the document is built from', () => {
    expect(block()).toContain('client: sendClient')
  })
})

describe('the payment email follows the same addressing rule', () => {
  const block = () => routeBlock(/Tell the CLIENT their money arrived/, 3200)

  it('addresses the receipt through the one helper', () => {
    const text = block()
    expect(text).toContain(
      'const paidAddressee = invoiceEmailAddressee(paidClient, paidData.clients ?? [])',
    )
    expect(text).toContain('client: paidAddressee.addressee')
  })

  // A webhook has no one to answer to, so an unset recipient means NOBODY is
  // emailed — never everybody — and it says so in the log.
  it('skips and logs rather than falling back when the recipient is unset', () => {
    const text = block()
    expect(text).toContain('if (paidClient && paidAddressee.refusal)')
    expect(text).toContain("console.warn('[stripe] payment email skipped:'")
  })

  // The PDF is the master's document; only the envelope changed.
  it('still builds the attachment from the master', () => {
    expect(block()).toContain('client: paidClient,')
  })
})

describe('a sub can see the invoice its work was billed ON', () => {
  const block = () => routeBlock(/const billedOnMatch = normalizedPath\.match\(/, 1800)

  it('exists as an owner-only GET on the client', () => {
    const text = block()
    expect(text).toMatch(/\^\\\/api\\\/clients\\\/\(\[\^\/\]\+\)\\\/billed-on-invoices\$/)
    expect(text).toContain("request.method === 'GET'")
    expect(text).toContain("session.user.role !== 'owner'")
    expect(text).toContain("sendJson(response, 403, { error: 'Only owners can see invoices' })")
  })

  it('hands the store’s answer straight back, with the period as an optional filter', () => {
    const text = block()
    expect(text).toContain("sendJson(response, 400, { error: 'period must look like 2026-08' })")
    expect(text).toMatch(
      /appDataStore\.listBilledOnInvoices\(billedOnClientId, \{\s*period: billedOnPeriod \|\| null,\s*\}\)/,
    )
    expect(text).toContain('sendJson(response, 200, { invoices: billedOnInvoices })')
  })

  // Below the catch-all it would answer 404 forever while every other test
  // still passed — see api-404-fallthrough.test.ts for the guard itself.
  it('sits above the /api/ catch-all', () => {
    const guardAt = serverSource.indexOf(GUARD)
    expect(guardAt, 'the /api/ catch-all guard is gone').toBeGreaterThan(-1)
    const at = serverSource.indexOf('const billedOnMatch = normalizedPath.match(')
    expect(at).toBeGreaterThan(-1)
    expect(at, 'the billed-on route is below the /api/ catch-all').toBeLessThan(guardAt)
  })

  // `/api/clients/:id/billed-on-invoices` and `/api/clients/:id/start-onboarding`
  // are both `:id`-shaped; a matcher swallowing the other would be silent.
  it('does not shadow, and is not shadowed by, the other /api/clients/:id routes', () => {
    for (const sibling of [
      'const startOnboardingMatch = normalizedPath.match(',
      'const lifecycleStageMatch = normalizedPath.match(',
    ]) {
      expect(serverSource.indexOf(sibling), `sibling route missing: ${sibling}`).toBeGreaterThan(-1)
    }
  })
})

describe('the Recap branches to the roll-up for a master and to nothing else', () => {
  const block = () =>
    routeBlock(/if \(normalizedPath === '\/api\/client-recap' && request\.method === 'GET'\)/, 4600)

  it('builds every ACTIVE sub’s recap the ordinary way, then rolls them up', () => {
    const text = block()
    expect(text).toContain('if (recapClient?.isBillingMaster === true) {')
    expect(text).toContain('const masterSubs = activeSubsOfMaster(data.clients ?? [], clientId)')
    expect(text).toContain('buildClientRecap(data, {')
    expect(text).toContain('buildMasterRecap({ master: recapClient, subRecaps })')
    expect(text).toContain('sendJson(response, 200, masterRecap)')
  })

  // The subs' own recaps are what the roll-up SUMS. Re-deriving the firm's cost
  // arithmetic here would be a second money calculator, which is the one rule
  // this codebase does not bend.
  it('reuses the per-client recap for each sub rather than recomputing', () => {
    const text = block()
    const branchAt = text.indexOf('if (recapClient?.isBillingMaster === true) {')
    const branch = text.slice(branchAt, text.indexOf('const recap = buildClientRecap(data, {'))
    expect(branch).toContain('clientId: sub.id')
    expect(branch).toContain('appDataStore.getSalesTaxRecord(sub.id, period)')
  })

  /**
   * THE LEAK. Access in this app is per COMPANY, and the route authorizes the
   * MASTER only. A bookkeeper assigned to the master but not to Bright Tower
   * would otherwise receive Bright Tower's hours, its byStaff roster and its
   * task list — none of which the per-client route would ever have given her.
   *
   * All-or-nothing, not best-effort: a roll-up quietly built from three of four
   * companies still presents itself as the whole group, and a number that is
   * wrong and looks right is worse than a refusal.
   */
  it('holds every sub to the same visible-set check the master was held to', () => {
    const text = block()
    expect(text).toContain('masterSubs.every((sub) => allowed.has(sub.id))')
    expect(text).toMatch(
      /sendJson\(response, 403, \{\s*error: 'master_subs_not_visible',\s*message: 'The combined view needs access to every company in the group\.',\s*\}\)/,
    )
  })

  it('refuses before any sub recap is built, not after', () => {
    const text = block()
    const checkAt = text.indexOf('masterSubs.every((sub) => allowed.has(sub.id))')
    expect(checkAt).toBeGreaterThan(-1)
    expect(checkAt).toBeLessThan(text.indexOf('clientId: sub.id'))
    expect(checkAt).toBeLessThan(text.indexOf('buildMasterRecap({'))
  })

  // `visibleClientIdSet` hands an owner every client id, so the check above can
  // never fire for one — the combined view stays exactly what it was for Alex
  // and Brittany. Pinned because a future narrowing of that helper would make
  // this branch start refusing owners, silently.
  it('cannot fire for an owner, because owners see every client', () => {
    const fn = functionSource('function visibleClientIdSet(', 400)
    expect(fn).toMatch(
      /if \(session\.user\.role === 'owner'\) \{\s*return new Set\(clients\.map\(\(client\) => client\.id\)\)\s*\}/,
    )
  })

  // Zero subs is a MISCONFIGURATION someone has to fix, not a quiet month —
  // the same call the generator makes with its 'master-without-subs' reason.
  it('says a master with no subs is misconfigured instead of printing zeros', () => {
    const text = block()
    expect(text).toMatch(/sendJson\(response, 409, \{\s*error: 'master_without_subs'/)
  })

  // REGRESSION SAFETY. Everything a non-master sees must be byte-identical to
  // what it saw before the branch existed: the same call, the same 404, the
  // same 200 — and the branch strictly above it, so it never runs for them.
  it('leaves the ordinary answer exactly as it was', () => {
    const text = block()
    expect(text).toMatch(
      /const recap = buildClientRecap\(data, \{\s*clientId,\s*periodType,\s*period,\s*today: todayIso\(\),\s*includeFinancials,\s*costRates,\s*salesTaxRecord,\s*\}\)/,
    )
    expect(text).toContain("sendJson(response, 404, { error: 'Client not found' })")
    expect(text).toContain('sendJson(response, 200, recap)')
    expect(text.indexOf('if (recapClient?.isBillingMaster === true) {')).toBeLessThan(
      text.indexOf('const recap = buildClientRecap(data, {'),
    )
  })
})

describe('a refused billing-master write reaches the wire as a 409 sentence', () => {
  /**
   * The four store guards throw `BillingMasterError` from handlers that have no
   * catch of their own, so the mapping lives in the request handler's outer
   * catch. That is only correct while it stays true that they have no catch of
   * their own — hence this check, which walks back from each call site and
   * fails if a nearer `try {` has opened around it.
   */
  const fallsThroughToTheOuterCatch = (marker: string) => {
    const at = serverSource.indexOf(marker)
    expect(at, `store call not found: ${marker}`).toBeGreaterThan(-1)
    const before = serverSource.slice(0, at)
    return before.lastIndexOf('} catch') > before.lastIndexOf('try {')
  }

  it('maps it once, in the outer catch, above the generic 500', () => {
    const at = serverSource.lastIndexOf('if (error instanceof BillingMasterError) {')
    expect(at, 'the outer-catch mapping is gone').toBeGreaterThan(-1)
    const tail = serverSource.slice(at, at + 400)
    expect(tail).toMatch(
      /sendJson\(response, 409, \{ error: 'billing_master_refused', message: error\.message \}\)/,
    )
    expect(tail).toContain('return')
    expect(tail.indexOf('BillingMasterError')).toBeLessThan(
      tail.indexOf("sendJson(response, 500, { error: 'Server error' })"),
    )
  })

  it('all four guarded write paths still reach that catch', () => {
    for (const marker of [
      'await appDataStore.createTimeEntry(',
      'await appDataStore.createChecklist(',
      'await appDataStore.addRecurringReimbursement(',
      'await appDataStore.copyTemplateToClient(',
    ]) {
      expect(
        fallsThroughToTheOuterCatch(marker),
        `${marker} is now inside a nearer try/catch — the 409 will surface as that handler's error instead`,
      ).toBe(true)
    }
  })

  // The client create is the exception: it has a catch of its own that turns
  // everything into a 500, so the mapping has to be repeated there.
  it('the client create maps it itself, before its own 500', () => {
    const block = routeBlock(
      /if \(normalizedPath === '\/api\/clients' && request\.method === 'POST'\)/,
      1800,
    )
    expect(block).toContain('if (error instanceof BillingMasterError) {')
    expect(block).toMatch(
      /sendJson\(response, 409, \{ error: 'billing_master_refused', message: error\.message \}\)/,
    )
    expect(block.indexOf('BillingMasterError')).toBeLessThan(
      block.indexOf("console.error('[clients] createClient failed:'"),
    )
    // The three new fields ride the ordinary payload — no second endpoint.
    expect(block).toContain('appDataStore.createClient(payload ?? {})')
  })
})

describe('the AI rating checks a master’s invoice against its subs’ hours', () => {
  const helper = () => functionSource('function buildMasterInvoiceHoursSummary(', 2600)

  // ONE entry point for "this invoice's hours". The branch is inside the
  // per-client helper, so `rateInvoiceAndPersist` — and anything else that ever
  // asks — cannot get it wrong by forgetting to ask a different function.
  it('branches inside the one hours helper, not at the call site', () => {
    const fn = functionSource('function buildInvoiceHoursSummary(', 900)
    expect(fn).toMatch(
      /if \(client\.isBillingMaster === true\) \{\s*return buildMasterInvoiceHoursSummary\(data, client, period\)\s*\}/,
    )
    expect(functionSource('async function rateInvoiceAndPersist(', 2600)).toContain(
      'hoursSummary: buildInvoiceHoursSummary(data, client, invoice.period),',
    )
  })

  it('runs the SAME per-client helper once per active sub', () => {
    const fn = helper()
    expect(fn).toContain('activeSubsOfMaster(data.clients ?? [], master.id)')
    expect(fn).toContain('buildInvoiceHoursSummary(data, sub, period)?.employees')
  })

  it('merges rows by employee and adds the hours', () => {
    const fn = helper()
    expect(fn).toContain('byName')
    expect(fn).toContain('scopedHours: addHours(rows.map((row) => row.scopedHours))')
    expect(fn).toContain('adhocHours: addHours(rows.map((row) => row.adhocHours))')
  })

  // NO NEW MONEY MATH. One person billing two companies at two rates stays two
  // rows: merging them would invent a blended rate that priced nothing, and the
  // model would then "correct" a line that was right.
  it('keeps separate rows, labeled with the company, when the rates differ', () => {
    const fn = helper()
    expect(fn).toContain('new Set(rows.map((row) => row.billRate)).size <= 1')
    expect(fn).toContain('sourceClients: [row.subName]')
    expect(fn).toContain('billRate: row.billRate')
  })

  // Retainers are the only thing the scheduler skips. A master invoice is not
  // one, so it is auto-rated like any other draft.
  it('does not exempt masters from auto-rating', () => {
    const scheduler = functionSource('function scheduleInvoiceRatings(', 2000)
    expect(scheduler).toContain("invoice.kind !== 'retainer'")
    expect(scheduler).not.toContain('isBillingMaster')
  })
})

describe('which subs count, decided in one place', () => {
  const helper = () => functionSource('function activeSubsOfMaster(', 900)

  // The recap roll-up, the rating's hours and the invoice itself must agree
  // about which companies are on it. Three lists that could drift apart is the
  // kind of number nobody can find later.
  it('is the one answer both the recap and the rating ask', () => {
    expect(serverSource.split('activeSubsOfMaster(').length - 1).toBeGreaterThanOrEqual(3)
  })

  it('matches the generator: active only, in client-name order', () => {
    const fn = helper()
    expect(fn).toContain('entry?.billToClientId === masterId')
    expect(fn).toContain("(entry.lifecycleStage ?? 'active') === 'active'")
    expect(fn).toContain('localeCompare')
  })
})
