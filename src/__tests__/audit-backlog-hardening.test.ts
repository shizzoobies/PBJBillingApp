import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The 2026-06-18 audit's deferred backlog, pinned where this repo can reach it.
 *
 * WHAT THIS IS AND IS NOT. `server.js` calls `server.listen()` at module scope and
 * exports nothing, so there is no HTTP harness here — the same constraint, and
 * the same answer, as `invoice-coverage-routes.test.ts` and
 * `waiting-lock-routes.test.ts`: these assertions read the route source and pin
 * the GLUE. The decisions themselves live in the store and in
 * `lib/checklist-write-permission.js`, and are tested there. Treat a failure here
 * as "the route changed, go look", not as a behavioral regression.
 *
 * Three of the four items in this batch are a REFUSAL, and a refusal is exactly
 * the kind of code no unit test misses when it disappears — because nothing
 * calls it. That is why they are pinned by position and by status code rather
 * than by outcome.
 *
 * The fourth (Store-7 / Store-8, file-backend parity) is real behavior on a
 * real backend and lives in `db/store-staleness.test.mjs`.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const serverSource = readFileSync(path.join(repoRoot, 'server.js'), 'utf8')
const storeSource = readFileSync(path.join(repoRoot, 'db/store.js'), 'utf8')

/** The body of a route block, from its opening match to `length` chars later. */
function routeBlock(startPattern: RegExp, length = 4000): string {
  const at = serverSource.search(startPattern)
  expect(at, `route not found: ${startPattern}`).toBeGreaterThan(-1)
  return serverSource.slice(at, at + length)
}

/** The source of a top-level function, from its declaration onward. */
function functionSource(declaration: string, length = 400): string {
  const at = serverSource.indexOf(declaration)
  expect(at, `not found: ${declaration}`).toBeGreaterThan(-1)
  return serverSource.slice(at, at + length)
}

/**
 * M2 — a non-JSON body used to reach `JSON.parse` and come back as a generic 500.
 * The house answer is 415 with one sentence, and every other mutating route
 * gives it. These three were the stragglers.
 */
describe('the three routes the audit found without a content-type guard (M2)', () => {
  const cases: Array<[string, RegExp]> = [
    ['PUT /api/firm-settings', /sendJson\(response, 403, \{ error: 'Only owners can update firm settings' \}\)/],
    ['POST /api/service-categories', /if \(normalizedPath === '\/api\/service-categories' && request\.method === 'POST'\)/],
    ['PUT /api/service-categories/:id', /const serviceCategoryMatch = normalizedPath\.match\(/],
  ]

  for (const [name, anchor] of cases) {
    it(`${name} answers 415 rather than letting JSON.parse throw`, () => {
      const block = routeBlock(anchor, 2500)
      const guardAt = block.indexOf('if (!isJsonContentType(request))')
      expect(guardAt, 'no content-type guard in this route').toBeGreaterThan(-1)
      expect(block.slice(guardAt, guardAt + 200)).toMatch(
        /sendJson\(response, 415, \{ error: 'application\/json required' \}\)/,
      )
      // A guard that runs after the body has been read is not a guard.
      expect(guardAt).toBeLessThan(block.indexOf('await readJsonBody(request)'))
    })
  }
})

/**
 * L2 — the handler whitelists too.
 *
 * The store already accepts only the fields it knows (`FIRM_SETTINGS_FIELDS` plus
 * `clientDefaults`), so this changes nothing today. It is here so the handler does
 * not DEPEND on that: the route used to hand the raw request body straight to a
 * store method, which leaves the only whitelist one refactor away from gone.
 */
describe('PUT /api/firm-settings whitelists in the handler (L2)', () => {
  const block = () => routeBlock(/Only owners can update firm settings/, 1500)

  it('never passes the raw body to the store', () => {
    const text = block()
    expect(text).toContain('appDataStore.updateFirmSettings(pickFirmSettingsPatch(payload))')
    expect(text).not.toContain('updateFirmSettings(payload')
  })

  it('drops an unknown field rather than refusing the save', () => {
    // The Settings page sends the whole settings object back, and an older tab
    // can carry a field this build no longer knows. Refusing those would break
    // a save over a cosmetic mismatch — so the picker copies what it knows and
    // says nothing at all about the rest.
    const picker = functionSource('function pickFirmSettingsPatch(', 500)
    expect(picker).toContain('for (const field of FIRM_SETTINGS_PATCH_FIELDS)')
    expect(picker).toContain('Object.prototype.hasOwnProperty.call(payload, field)')
    expect(picker).not.toMatch(/throw|sendJson|400/)
  })

  // Two lists in two files is a drift risk, and the drift would be SILENT: a
  // field added to the store but not here would simply stop being savable.
  it('accepts exactly the fields the store persists', () => {
    const handlerStart = serverSource.indexOf('const FIRM_SETTINGS_PATCH_FIELDS = [')
    const handlerList = serverSource
      .slice(handlerStart, serverSource.indexOf(']', handlerStart))
      .match(/'([^']+)'/g)
      ?.map((quoted) => quoted.slice(1, -1))

    const storeStart = storeSource.indexOf('const FIRM_SETTINGS_FIELDS = [')
    const storeList = storeSource
      .slice(storeStart, storeSource.indexOf('\n]', storeStart))
      .match(/\['([^']+)', '[^']+'\]/g)
      ?.map((pair) => (pair.match(/\['([^']+)'/) as RegExpMatchArray)[1])

    expect(storeList?.length).toBeGreaterThan(0)
    // Plus `clientDefaults`, which the store merges separately rather than listing
    // beside the flat columns.
    expect(handlerList?.slice().sort()).toEqual([...(storeList ?? []), 'clientDefaults'].sort())
  })
})

/**
 * L3 — item and sub-item mutations answer 404 for a client you cannot see.
 *
 * The visibility CHECK itself landed with the shared write gate
 * (`lib/checklist-write-permission.js`) — client visibility is an AND inside it.
 * What was left was the STATUS. A 403 confirms the id names a real checklist,
 * which is enumeration, and it is precisely what `GET /api/cases/:id` was fixed
 * not to do (the audit's H3 item). These routes now answer the same way, with
 * the same wording, so the two refusals cannot be told apart.
 */
describe('an invisible checklist is not found, not forbidden (L3)', () => {
  const routes: Array<[string, RegExp]> = [
    ['toggle an item', /const checklistToggleMatch = normalizedPath\.match\(/],
    ['add / delete a sub-sub-item', /const checklistSubSubItemMatch = normalizedPath\.match\(/],
    ['add / delete a sub-item', /const checklistSubItemMatch = normalizedPath\.match\(/],
    ['reorder items', /const checklistItemsReorderMatch = normalizedPath\.match\(/],
    ['add / patch / delete an item', /const checklistItemMatch = normalizedPath\.match\(/],
  ]

  for (const [name, anchor] of routes) {
    it(`${name}: answers 404, in the not-found wording`, () => {
      const block = routeBlock(anchor, 3000)
      const guardAt = block.indexOf('checklistOutOfScope(')
      expect(guardAt, 'no visibility guard in this route').toBeGreaterThan(-1)
      expect(block.slice(guardAt, guardAt + 200)).toMatch(
        /sendJson\(response, 404, \{ error: 'Checklist not found' \}\)/,
      )
    })
  }

  // The toggle route authorizes on the step's responsible person rather than
  // the shared write gate, so its 403 was reachable for a client the caller is
  // not on at all. The scope check has to come FIRST, or the stricter refusal
  // leaks the id anyway.
  it('runs before the toggle route decides whose step it is', () => {
    const block = routeBlock(/const checklistToggleMatch = normalizedPath\.match\(/, 3000)
    expect(block.indexOf('checklistOutOfScope(')).toBeGreaterThan(-1)
    expect(block.indexOf('checklistOutOfScope(')).toBeLessThan(
      block.indexOf('Only the person this step is assigned to can check it off.'),
    )
  })

  // Every one of these reads before it writes, so the guard must sit above the
  // store call or it is refusing something already done.
  it('runs before anything is written', () => {
    for (const [name, anchor] of routes) {
      const block = routeBlock(anchor, 6000)
      const firstWrite = block.search(
        /appDataStore\.(toggleChecklistItem|appendChecklistItems|updateChecklistItem|deleteChecklistItem|reorderChecklistItems|addChecklistSubItem|addChecklistSubSubItem|deleteChecklistSubItem|deleteChecklistSubSubItem)\(/,
      )
      expect(firstWrite, `no store write found in: ${name}`).toBeGreaterThan(-1)
      expect(block.indexOf('checklistOutOfScope('), `no guard in: ${name}`).toBeGreaterThan(-1)
      expect(block.indexOf('checklistOutOfScope(')).toBeLessThan(firstWrite)
    }
  })

  // OWNERS MUST BE UNAFFECTED. The guard is a plain set-membership test with no
  // role branch of its own — it relies entirely on `visibleClientIdSet` handing an
  // owner every client id. If that ever grows a filter, this stops being true
  // and owners start 404-ing on their own firm.
  it('leans on visibleClientIdSet giving an owner every client', () => {
    const helper = functionSource('function checklistOutOfScope(', 120)
    expect(helper).toContain('!visibleClientIds.has(checklist?.clientId)')
    expect(helper).not.toMatch(/role|owner/)

    expect(functionSource('function visibleClientIdSet(', 400)).toMatch(
      /if \(session\.user\.role === 'owner'\) \{\s*\n\s*return new Set\(clients\.map\(\(client\) => client\.id\)\)/,
    )
  })
})
