import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * `/health` as a READINESS check (docs/plans/resilience-2026-09.md, Tier-1
 * step 2.4), and the specific shape that makes it one.
 *
 * Before this, `/health` returned 200 without ever touching the database — a
 * liveness check, not a readiness check. A load balancer or Railway's own
 * healthcheck keying on it could not tell "process alive" from "can actually
 * serve": a DB-down instance still answered 200 and kept receiving traffic.
 *
 * WHAT THIS IS AND IS NOT — same shape as api-404-fallthrough.test.ts, for the
 * same reason: `server.js` calls `server.listen()` at module scope and exports
 * nothing, so there is no HTTP harness here. These assertions read the route
 * source and pin the glue: that the endpoint pings the store (not the pool
 * directly — cardinal rule 1, backend-agnostic), that a failed/timed-out ping
 * answers 503 with `db: 'unreachable'`, that a successful one keeps the
 * existing 200 body plus `db: 'ok'`, and that the ping is bounded so a hung
 * pool can never hang this endpoint. The bound and the fake-pool behavior are
 * pinned directly against `db/store.js`'s `ping()` in
 * `db/store-staleness.test.mjs`; this file only pins that `/health` actually
 * calls it and reacts to its outcome correctly.
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
)

const storeSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db/store.js'),
  'utf8',
)

/** The `/health` route itself. */
const ROUTE_GUARD = "if (normalizedPath === '/health') {"

function healthRouteBlock(): string {
  const at = serverSource.indexOf(ROUTE_GUARD)
  expect(at, 'the /health route is gone').toBeGreaterThan(-1)
  // Generous slice — comfortably covers the handler body without running into
  // the next route.
  return serverSource.slice(at, at + 1600)
}

describe('/health pings the store instead of just answering', () => {
  it('calls appDataStore.ping(), not the pool directly', () => {
    const block = healthRouteBlock()
    expect(block).toContain('appDataStore.ping()')
    // Cardinal rule 1: the route must stay backend-agnostic. Reaching into
    // `.pool` here would break file mode (tests, dev) and duplicate the
    // Postgres-vs-file branch that `ping()` already owns.
    expect(block).not.toMatch(/appDataStore\.pool/)
  })

  it('a failed or timed-out ping answers 503 with db: unreachable, keeping stripe fields', () => {
    const block = healthRouteBlock()
    expect(block).toMatch(/catch\s*\(error\)\s*\{/)
    expect(block).toContain("db = 'unreachable'")
    expect(block).toContain('status = 503')
    // The failure path must still ship mode/stripe/stripeWebhook — monitoring
    // and the desktop shell may key on those fields regardless of outcome.
    expect(block).toContain('mode: appDataStore.mode')
    expect(block).toContain('stripeWebhook')
  })

  it('a successful ping keeps the existing 200 body exactly, plus db: ok', () => {
    const block = healthRouteBlock()
    expect(block).toContain("let db = 'ok'")
    expect(block).toContain('let status = 200')
    expect(block).toContain('ok: status === 200')
    expect(block).toContain('mode: appDataStore.mode')
    expect(block).toContain(
      "stripe: !isStripeConfigured() ? 'unconfigured' : isStripeTestMode() ? 'test' : 'live'",
    )
    expect(block).toContain("stripeWebhook: isStripeWebhookConfigured() ? 'configured' : 'missing'")
  })

  it('does not log a stack on a failed ping — one console.warn per failure only', () => {
    const block = healthRouteBlock()
    // A down DB would poll every few seconds (Railway/Cloudflare); logging a
    // full stack on each failure would flood the log.
    expect(block).not.toMatch(/console\.error/)
    const warnCalls = block.match(/console\.warn\(/g) ?? []
    expect(warnCalls).toHaveLength(1)
    expect(block).toContain("console.warn('[health] db unreachable:'")
  })
})

describe('appDataStore.ping() is bounded so a hung pool cannot hang /health', () => {
  const PING_GUARD = 'async ping() {'

  function pingBody(): string {
    const at = storeSource.indexOf(PING_GUARD)
    expect(at, 'AppDataStore.ping() is gone').toBeGreaterThan(-1)
    return storeSource.slice(at, at + 800)
  }

  it('races the query against a timer instead of awaiting it unbounded', () => {
    const body = pingBody()
    expect(body).toMatch(/Promise\.race/)
    expect(body).toMatch(/setTimeout/)
  })

  it('the timeout is short — at most a few seconds, not a default pg timeout', () => {
    const body = pingBody()
    const match = body.match(/timeoutMs\s*=\s*(\d+)/)
    expect(match, 'no explicit timeoutMs constant found').not.toBeNull()
    const timeoutMs = Number(match?.[1])
    expect(timeoutMs).toBeGreaterThan(0)
    expect(timeoutMs).toBeLessThanOrEqual(5000)
  })

  it('file mode short-circuits without touching a pool', () => {
    const body = pingBody()
    expect(body).toContain('if (!this.pool) return true')
  })
})
