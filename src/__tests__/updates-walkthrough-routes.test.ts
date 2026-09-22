import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The "Walk me through it" route's glue — featreq-cb1c5f95.
 *
 * WHAT THIS IS AND IS NOT — the same shape as invoice-coverage-routes.test.ts,
 * for the same reason: `server.js` calls `server.listen()` at module scope and
 * exports nothing, so there is no HTTP harness here. The generator is exercised
 * properly in lib/assistant.test.mjs and the storage in
 * db/store-staleness.test.mjs; these assertions read the route source and pin
 * the wiring those two can't see.
 *
 * Three of them matter more than the rest:
 *   - the CACHE branch. Without it every open of a shipped card pays for a
 *     fresh generation, and — worse — she gets a slightly different explanation
 *     of the same change each time she looks.
 *   - the POSITION. `/api/feature-requests/:id` is a generic matcher a few
 *     lines below; a walkthrough route underneath it would be swallowed whole.
 *   - APPROVAL IS UNTOUCHED. Nothing in this route may write a status. A model
 *     outage has to leave "Mark approved" working exactly as it did before.
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
)

const ROUTE = 'const featureRequestWalkthroughMatch = normalizedPath.match('
const PATCH_MATCHER = 'const featureRequestMatch = normalizedPath.match('

function routeBlock(): string {
  const at = serverSource.indexOf(ROUTE)
  expect(at, 'the walkthrough route is gone').toBeGreaterThan(-1)
  return serverSource.slice(at, serverSource.indexOf(PATCH_MATCHER, at))
}

describe('the walkthrough route is guarded like every other Updates write', () => {
  it('is owner-only, same-origin and JSON-bodied', () => {
    const block = routeBlock()
    expect(block).toContain('requireSession(request, response)')
    expect(block).toContain("session.user.role !== 'owner'")
    expect(block).toContain("sendJson(response, 403, { error: 'The Updates tracker is owner-only' })")
    expect(block).toContain("sendJson(response, 403, { error: 'Origin not allowed' })")
    expect(block).toContain("sendJson(response, 415, { error: 'application/json required' })")
  })

  it('404s an id that is not there, rather than generating about nothing', () => {
    expect(routeBlock()).toContain("sendJson(response, 404, { error: 'Update not found' })")
  })

  it('imports the generator it calls', () => {
    expect(serverSource).toMatch(
      /import \{[\s\S]*?walkthroughFeatureRequest,[\s\S]*?\} from '\.\/lib\/assistant\.js'/,
    )
  })
})

describe('a stored walkthrough is returned as-is unless she asks for a new one', () => {
  it('short-circuits on the stored text before any model call', () => {
    const block = routeBlock()
    const cached = block.indexOf('if (!regenerate && item.walkthrough)')
    const generate = block.indexOf('await walkthroughFeatureRequest(item)')
    expect(cached).toBeGreaterThan(-1)
    expect(generate).toBeGreaterThan(-1)
    expect(cached).toBeLessThan(generate)
  })

  it('reads the flag off the body, and only `true` counts', () => {
    expect(routeBlock()).toContain('payload?.regenerate === true')
  })

  it('persists what it generates, so the next open is the cheap path', () => {
    const block = routeBlock()
    const generate = block.indexOf('await walkthroughFeatureRequest(item)')
    const save = block.indexOf('appDataStore.setFeatureRequestWalkthrough(id, walkthrough)')
    expect(save).toBeGreaterThan(-1)
    expect(generate).toBeLessThan(save)
  })

  it('answers with both fields the page renders', () => {
    const block = routeBlock()
    expect(block).toContain('walkthrough:')
    expect(block).toContain('walkthroughAt:')
  })
})

describe('the route can never interfere with the approval sitting next to it', () => {
  it('writes nothing but the walkthrough', () => {
    const block = routeBlock()
    expect(block).not.toContain('updateFeatureRequest')
    expect(block).not.toContain("status: 'done'")
  })

  it('turns a model failure into a sentence, mirroring /refine', () => {
    const block = routeBlock()
    expect(block).toContain('status === 503 ? 503 : 502')
    expect(block).toContain('The AI could not put a walkthrough together right now.')
  })
})

/**
 * POSITION. `/^\/api\/feature-requests\/([^/]+)$/` does not match the
 * `/walkthrough` suffix, so this is not the usual swallowing bug — but the two
 * blocks are read together, and the order is the thing a later edit is most
 * likely to get wrong. The catch-all check is in api-404-fallthrough.test.ts;
 * this pins the local ordering.
 */
describe('placement', () => {
  it('sits above the generic feature-request matcher', () => {
    expect(serverSource.indexOf(ROUTE)).toBeLessThan(serverSource.indexOf(PATCH_MATCHER))
  })

  it('sits above the /api/ catch-all 404', () => {
    expect(serverSource.indexOf(ROUTE)).toBeLessThan(
      serverSource.indexOf("if (normalizedPath.startsWith('/api/')) {"),
    )
  })
})
