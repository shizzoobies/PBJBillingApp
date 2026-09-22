import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The package endpoints' GLUE (featreq-f890f05b).
 *
 * WHAT THIS IS AND IS NOT — the same shape as api-404-fallthrough and the
 * invoice route suites, for the same reason: `server.js` calls
 * `server.listen()` at module scope and exports nothing, so there is no HTTP
 * harness here. The behavior lives in the store methods, which are exercised
 * properly on both backends in db/store-staleness.test.mjs. What is left over
 * is the wiring, and the ways it rots silently: an owner gate deleted, an
 * origin guard dropped, a route that stops telling the other tabs anything, or
 * a route that slides below the `/api/` catch-all and answers 404 forever.
 *
 * Treat a failure here as "the routing moved, go look".
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
)

/** The body of a route block, from its opening guard onward. */
function routeBlock(startPattern: RegExp, length = 2200): string {
  const at = serverSource.search(startPattern)
  expect(at, `route not found: ${startPattern}`).toBeGreaterThan(-1)
  return serverSource.slice(at, at + length)
}

const ROUTES: Array<{ name: string; pattern: RegExp; write: boolean }> = [
  {
    name: 'GET /api/packages',
    pattern: /normalizedPath === '\/api\/packages' && request\.method === 'GET'/,
    write: false,
  },
  {
    name: 'POST /api/packages',
    pattern: /normalizedPath === '\/api\/packages' && request\.method === 'POST'/,
    write: true,
  },
  {
    name: 'PATCH /api/packages/:id',
    pattern: /packageIdMatch && request\.method === 'PATCH'/,
    write: true,
  },
  {
    name: 'DELETE /api/packages/:id',
    pattern: /packageIdMatch && request\.method === 'DELETE'/,
    write: true,
  },
  {
    name: 'POST /api/clients/:id/apply-package',
    pattern: /applyPackageMatch && request\.method === 'POST'/,
    write: true,
  },
  {
    name: 'POST /api/packages/:id/create-suggested',
    pattern: /createSuggestedMatch && request\.method === 'POST'/,
    write: true,
  },
]

describe('the package routes are owner-only and same-origin', () => {
  for (const route of ROUTES) {
    it(`${route.name} requires a session and refuses a non-owner`, () => {
      const block = routeBlock(route.pattern)
      expect(block).toContain('await requireSession(request, response)')
      expect(block).toMatch(/session\.user\.role !== 'owner'/)
      expect(block).toMatch(/sendJson\(response, 403,/)
    })

    if (route.write) {
      // A package is firm setup. Every write carries the CSRF guard; the read
      // deliberately does not, matching the rest of the app.
      it(`${route.name} blocks a cross-site POST`, () => {
        const block = routeBlock(route.pattern)
        expect(block).toContain('isCrossSiteOrigin(request)')
        expect(block).toContain("sendJson(response, 403, { error: 'Origin not allowed' })")
      })

      // Packages are endpoint-managed, so nothing else tells the other open
      // tabs that anything happened.
      it(`${route.name} tells the other sessions`, () => {
        expect(routeBlock(route.pattern)).toContain('broadcastDataChanged()')
      })
    }
  }
})

describe('applying a package', () => {
  const block = () => routeBlock(/applyPackageMatch && request\.method === 'POST'/, 2600)

  it('goes through the store method, not the bulk save', () => {
    expect(block()).toContain('appDataStore.applyPackageToClient(')
    expect(block()).not.toContain('appDataStore.write(')
  })

  /**
   * A retired client refusing new work is a fact about the data, said in a
   * sentence the confirm dialog can show as-is — the same contract the
   * billing-master refusal has (that one is still mapped by the outer handler).
   */
  it('answers 409 with a sentence when the client cannot take one', () => {
    const text = block()
    expect(text).toContain('error instanceof PackageApplyError')
    expect(text).toMatch(/sendJson\(response, 409, \{ error: 'package_refused', message: error\.message \}\)/)
  })

  it('re-throws anything else, so a real fault is not swallowed as a refusal', () => {
    expect(block()).toContain('throw error')
  })
})

/**
 * The AI half, and the one rule it has: suggesting and creating are SEPARATE
 * routes. "The AI can suggest checklists based on existing setup, always asks
 * for approval first, and only creates items after the user confirms"
 * (Brittany, featreq-f890f05b) — a single route that suggested and created in
 * one pass would break that however the copy was worded.
 */
describe('suggesting checklists for a package', () => {
  const block = () => routeBlock(/suggestChecklistsMatch && request\.method === 'POST'/, 3200)

  it('is owner-only and same-origin', () => {
    const text = block()
    expect(text).toContain('await requireSession(request, response)')
    expect(text).toMatch(/session\.user\.role !== 'owner'/)
    expect(text).toContain('isCrossSiteOrigin(request)')
  })

  it('creates NOTHING — it only asks the model and answers with proposals', () => {
    const text = block()
    expect(text).toContain('suggestPackageChecklists(')
    expect(text).toMatch(/sendJson\(response, 200, \{ proposals \}\)/)
    expect(text).not.toContain('createStandardTemplate')
    expect(text).not.toContain('createSuggestedPackageChecklists')
    expect(text).not.toContain('updatePackage')
  })

  it('turns a model failure into a sentence, never a crash', () => {
    const text = block()
    expect(text).toContain('} catch (error) {')
    expect(text).toMatch(/status === 503 \? 503 : 502/)
    expect(text).toContain("error: 'package_suggest_failed'")
  })

  it('the create half goes through the store, and needs proposals to act on', () => {
    const create = routeBlock(/createSuggestedMatch && request\.method === 'POST'/, 2200)
    expect(create).toContain('appDataStore.createSuggestedPackageChecklists(')
    expect(create).toMatch(/proposals\.length === 0/)
    expect(create).toMatch(/sendJson\(response, 400,/)
  })
})

describe('the package routes are reachable', () => {
  it('all sit above the /api/ catch-all', () => {
    const guardAt = serverSource.indexOf("if (normalizedPath.startsWith('/api/')) {")
    expect(guardAt, 'the /api/ catch-all guard is gone').toBeGreaterThan(-1)
    const all = [
      ...ROUTES,
      {
        name: 'POST /api/packages/:id/suggest-checklists',
        pattern: /suggestChecklistsMatch && request\.method === 'POST'/,
      },
    ]
    for (const route of all) {
      const at = serverSource.search(route.pattern)
      expect(at, `${route.name} is below the catch-all and can never be reached`).toBeLessThan(
        guardAt,
      )
    }
  })

  /**
   * `/^\/api\/packages\/([^/]+)$/` cannot match a path with a second segment,
   * so the sub-routes are safe wherever they sit — but only while that regex
   * excludes slashes. Pinned, because loosening it to `(.+)` would swallow
   * both AI routes and answer them with a package PATCH.
   */
  it('the :id matcher cannot swallow the sub-routes', () => {
    const matcher = serverSource.match(/const packageIdMatch = normalizedPath\.match\((.+)\)/)
    expect(matcher?.[1]).toBe('/^\\/api\\/packages\\/([^/]+)$/')
  })
})
