import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The `/api/*` catch-all 404, and the ordering that makes it correct.
 *
 * Before this guard existed, an unmatched `/api/` path fell through to the SPA
 * shell and came back as **200 + HTML**. Every `response.ok` caller reads that
 * as success, so a typo'd or renamed endpoint did not fail where it was called
 * — it failed later and elsewhere, when something tried to parse the HTML as
 * JSON. The guard turns that into an honest 404.
 *
 * WHAT THIS IS AND IS NOT — same shape as waiting-lock-routes.test.ts, for the
 * same reason: `server.js` calls `server.listen()` at module scope and exports
 * nothing, so there is no HTTP harness here. These assertions read the route
 * source and pin the glue.
 *
 * The second test is the one that matters. A catch-all is only ever as correct
 * as its POSITION: it must sit after every real API route and before the static
 * fallthrough. Add a route below it and that route answers 404 forever, while
 * every unit test still passes. Treat a failure here as "the routing moved, go
 * look" — not as a test to delete.
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
)

/** The catch-all guard itself. */
const GUARD = "if (normalizedPath.startsWith('/api/')) {"
/** First line of the static-file / SPA fallthrough that the guard protects. */
const SPA_FALLTHROUGH = 'const requestedFile = path.join(distDir, normalizedPath)'

describe('an unmatched /api/ path fails loudly instead of returning the SPA', () => {
  it('answers 404 with a JSON body, and stops', () => {
    const at = serverSource.indexOf(GUARD)
    expect(at, 'the /api/ catch-all guard is gone').toBeGreaterThan(-1)

    const block = serverSource.slice(at, at + 200)
    expect(block).toContain("sendJson(response, 404, { error: 'Not found' })")
    // Without the return it would fall straight into the SPA handler anyway.
    expect(block).toContain('return')
  })

  it('sits after every real API route and before the static fallthrough', () => {
    const guardAt = serverSource.indexOf(GUARD)
    const spaAt = serverSource.indexOf(SPA_FALLTHROUGH)
    expect(spaAt, 'the static fallthrough is gone').toBeGreaterThan(-1)

    // Before the SPA handler — otherwise the HTML shell answers first and the
    // guard is dead code.
    expect(guardAt).toBeLessThan(spaAt)

    // After every route that matches on an /api/ path. Anything matching below
    // the guard is unreachable: the guard would 404 it first.
    const routeMatchers = /normalizedPath (?:===|\.startsWith\()\s*'\/api\//g
    const below: string[] = []
    for (const match of serverSource.matchAll(routeMatchers)) {
      // The guard's own `startsWith('/api/')` is the catch-all, not a route.
      if (match.index === guardAt + GUARD.indexOf('normalizedPath')) continue
      if (match.index > guardAt) {
        below.push(serverSource.slice(match.index, match.index + 80).split('\n')[0])
      }
    }
    expect(
      below,
      `these /api/ routes are below the catch-all and can never be reached:\n${below.join('\n')}`,
    ).toEqual([])
  })
})
