import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Every state-changing checklist route refuses a cross-site request. Same shape
 * as the reorder routes in `sub-step-reorder-route.test.ts`: `server.js` listens
 * at module scope and exports nothing, so these read the route source and pin
 * the wiring - `isCrossSiteOrigin(request)` answers 403 `Origin not allowed`
 * AFTER the session / role check and BEFORE the body is read or the store is
 * touched. The older routes (toggle, sub-steps, item PATCH, create, delete,
 * restore, bin, viewers) had no such check; the newer ones always did.
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
).replaceAll('\r\n', '\n')

const GUARD =
  /if \(isCrossSiteOrigin\(request\)\) \{\s+sendJson\(response, 403, \{ error: 'Origin not allowed' \}\)/

/** The routes this test knows about: [label, the line that opens the route's block]. */
const ROUTES: [string, string][] = [
  ['POST /api/checklists', "if (normalizedPath === '/api/checklists') {"],
  ['DELETE /api/checklists/recycle-bin', "if (normalizedPath === '/api/checklists/recycle-bin') {"],
  ['POST /api/checklists/:id/restore', 'if (checklistRestoreMatch) {'],
  ['POST /api/checklists/:id/deletion/(approve|reject)', 'if (checklistDeletionDecisionMatch) {'],
  ['POST /api/checklists/item-deletions/:id/(approve|reject)', 'if (itemDeletionDecisionMatch) {'],
  ['POST /api/checklists/pending-edits/:id/(approve|reject)', 'if (pendingEditDecisionMatch) {'],
  ['POST /api/checklists/skips/:id/review', 'if (skipReviewMatch) {'],
  ['POST /api/checklists/:id/skip', 'if (checklistSkipMatch) {'],
  ['POST /api/checklists/:id/push', 'if (checklistPushMatch) {'],
  ["PATCH /api/checklists/:id", "if (checklistMetaPatchMatch && request.method === 'PATCH') {"],
  ['DELETE /api/checklists/:id', 'if (checklistDeleteMatch) {'],
  ['POST /api/checklists/:id/items/:itemId/toggle', 'if (checklistToggleMatch) {'],
  ['POST|DELETE .../sub-items/:subItemId/sub-items[/:subSubItemId]', 'if (checklistSubSubItemMatch) {'],
  ['POST .../items/:itemId/sub-items/reorder', 'if (checklistSubItemsReorderMatch) {'],
  ['POST|DELETE|PATCH .../items/:itemId/sub-items[/:subItemId]', 'if (checklistSubItemMatch) {'],
  ['POST /api/checklists/:id/waiting-ons/:waitingOnId/(action)', 'if (waitingOnActionMatch) {'],
  ['POST /api/checklists/:id/waiting-ons', 'if (waitingOnCollectionMatch) {'],
  ['POST /api/checklists/:id/items/reorder', 'if (checklistItemsReorderMatch) {'],
  ['POST|PATCH|DELETE /api/checklists/:id/items[/:itemId]', 'if (checklistItemMatch) {'],
  ['PUT /api/checklists/:id/viewers', 'if (checklistViewersMatch) {'],
]

/**
 * The checklist TEMPLATE routes: the same wiring. None of them had the check
 * (the review of the checklist release found it on /api/checklists only), and
 * they write the recipes every future task is generated from.
 */
const TEMPLATE_ROUTES: [string, string][] = [
  ['PUT /api/checklist-templates/:id/viewers', 'if (checklistTemplateViewersMatch) {'],
  [
    'POST /api/checklist-templates/:id/stages/reorder',
    "if (templateStageReorderMatch && request.method === 'POST') {",
  ],
  [
    'POST /api/checklist-templates/:id/stages/:stageId/items',
    "if (templateStageAppendMatch && request.method === 'POST') {",
  ],
  ['POST|PATCH|DELETE /api/checklist-templates/:id/stages[/:stageId]', 'if (templateStageItemMatch) {'],
  [
    'POST /api/checklist-templates/standard',
    "if (normalizedPath === '/api/checklist-templates/standard' && request.method === 'POST') {",
  ],
  [
    'POST /api/checklist-templates/:id/apply-to-client',
    "if (applyToClientMatch && request.method === 'POST') {",
  ],
  [
    'POST /api/checklist-templates/:id/generate',
    "if (templateGenerateMatch && request.method === 'POST') {",
  ],
]

/** The block of one route, from its opening line to its closing brace at route level. */
function routeBlock(opening: string): string {
  const at = serverSource.indexOf(`    ${opening}\n`)
  expect(at, opening).toBeGreaterThan(-1)
  const end = serverSource.indexOf('\n    }\n', at)
  expect(end, opening).toBeGreaterThan(at)
  return serverSource.slice(at, end)
}

describe('every state-changing checklist route checks the request origin', () => {
  it.each([...ROUTES, ...TEMPLATE_ROUTES])('%s refuses a cross-site origin with 403, before the body or the store', (_label, opening) => {
    const block = routeBlock(opening)
    const guardAt = block.search(GUARD)
    expect(guardAt).toBeGreaterThan(-1)
    // After the session check (a signed-out caller still gets the 401 first)...
    const sessionAt = block.indexOf('await requireSession(request, response)')
    expect(sessionAt).toBeGreaterThan(-1)
    expect(guardAt).toBeGreaterThan(sessionAt)
    // ...and before anything is read: the body, or the store.
    for (const touch of ['await readJsonBody(request)', 'await appDataStore.']) {
      const touchAt = block.indexOf(touch)
      if (touchAt > -1) expect(guardAt, touch).toBeLessThan(touchAt)
    }
  })

  it('a method that is not the route\'s gets its 405 before the origin check (single-method routes)', () => {
    for (const opening of [
      "if (normalizedPath === '/api/checklists/recycle-bin') {",
      'if (checklistRestoreMatch) {',
      'if (checklistDeleteMatch) {',
      'if (checklistToggleMatch) {',
      'if (checklistViewersMatch) {',
      'if (checklistTemplateViewersMatch) {',
    ]) {
      const block = routeBlock(opening)
      expect(block.search(GUARD), opening).toBeGreaterThan(block.indexOf("sendJson(response, 405"))
    }
  })

  it('the owner-only routes check the role first, then the origin', () => {
    for (const [opening, denial] of [
      ["if (normalizedPath === '/api/checklists/recycle-bin') {", 'Only owners can empty the recycle bin'],
      ['if (checklistRestoreMatch) {', 'Only owners can restore a checklist'],
      ['if (checklistViewersMatch) {', 'Only owners can update checklist viewers'],
      ['if (checklistTemplateViewersMatch) {', 'Only owners can update template viewers'],
      ['if (templateStageReorderMatch && request.method === \'POST\') {', 'Only owners can reorder stages'],
      ['if (templateStageItemMatch) {', 'Only owners can update template stages'],
      [
        "if (normalizedPath === '/api/checklist-templates/standard' && request.method === 'POST') {",
        'Only owners can create standard templates',
      ],
      ['if (applyToClientMatch && request.method === \'POST\') {', 'templateApplyRoleDenial(session.user)'],
    ]) {
      const block = routeBlock(opening)
      expect(block.search(GUARD), opening).toBeGreaterThan(block.indexOf(denial))
    }
  })

  // A new /api/checklists route that is not in the table above fails here, so
  // it cannot be added without deciding whether it needs the check.
  it('lists every /api/checklists matcher in server.js (none can be added unchecked)', () => {
    const declared = [
      ...serverSource.matchAll(
        /const (\w+) = normalizedPath\.match\(\s*\/\^\\\/api\\\/checklists/g,
      ),
    ].map((match) => match[1])
    const known = new Set(ROUTES.map(([, opening]) => /if \((\w+)/.exec(opening)?.[1]))
    for (const name of declared) {
      // `checklistMetaPatchMatch` is in the table; the waiting-on action matcher is a named constant.
      expect(known.has(name), `${name} has no origin check listed`).toBe(true)
    }
    expect(declared.length).toBeGreaterThan(10)
  })

  // The same for /api/checklist-templates: a matcher constant or a literal path
  // comparison that is not in TEMPLATE_ROUTES fails here.
  it('lists every /api/checklist-templates route in server.js (none can be added unchecked)', () => {
    const declared = [
      ...serverSource.matchAll(
        /const (\w+) = normalizedPath\.match\(\s*\/\^\\\/api\\\/checklist-templates/g,
      ),
    ].map((match) => match[1])
    const literals = [
      ...serverSource.matchAll(/normalizedPath === '(\/api\/checklist-templates[^']*)'/g),
    ].map((match) => match[1])
    const knownMatchers = new Set(TEMPLATE_ROUTES.map(([, opening]) => /if \((\w+)/.exec(opening)?.[1]))
    for (const name of declared) {
      expect(knownMatchers.has(name), `${name} has no origin check listed`).toBe(true)
    }
    for (const literal of literals) {
      expect(
        TEMPLATE_ROUTES.some(([, opening]) => opening.includes(`'${literal}'`)),
        `${literal} has no origin check listed`,
      ).toBe(true)
    }
    expect(declared.length).toBe(6)
    expect(literals.length).toBe(1)
  })
})
