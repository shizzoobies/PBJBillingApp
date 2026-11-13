// The "hold" a new instance of the app waits in during a deploy on Cloudflare
// (cloudflare/worker.js, docs/plans/zero-downtime-deploy-2026-11.md section 12).
//
// A deploy starts the new instance with THIS file instead of server.js. Nothing of the app
// is loaded here: no schema statements, no jobs, no writes. The instance only proves it is
// up (the slow part of a deploy is Cloudflare bringing the image to the machine) and that it
// can reach the database, and then waits. When the old instance has been stopped, the Worker
// sends POST /go and this process becomes the app (it imports server.js). So the old app and
// the new app never run at the same time.
//
//   GET  /held  -> { held, ok, checks: { database, net }, commit }
//   POST /go    -> { released: true }, then the app starts in this same process
//
// The port is reachable only from the Durable Object that owns the container.
import { createServer } from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveAppCommit } from './host-runtime.js'

export const HOLD_PORT = 8079
const CHECK_EVERY_MS = 5_000
const CHECK_TIMEOUT_MS = 8_000
/** Longer than the Worker ever waits on a held instance (20 minutes): a hold nobody released leaves. */
const MAX_HOLD_MS = 45 * 60_000

/** 'ok', 'failed', or 'none' when there is no DATABASE_URL (the file backend). One `select 1`, nothing else. */
export async function checkDatabase(env = process.env) {
  if (!env.DATABASE_URL) return 'none'
  let client = null
  try {
    const [{ default: pg }, { poolOptions }] = await Promise.all([import('pg'), import('../db/pool-options.js')])
    client = new pg.Client({ ...poolOptions(env.DATABASE_URL, env), connectionTimeoutMillis: CHECK_TIMEOUT_MS, query_timeout: CHECK_TIMEOUT_MS })
    // A connection that drops later must not crash the hold.
    client.on('error', () => {})
    await client.connect()
    await client.query('select 1')
    return 'ok'
  } catch (error) {
    console.error('[hold] database check failed:', error?.code || error?.message || error)
    return 'failed'
  } finally {
    try {
      await client?.end()
    } catch {
      // Never connected, or already gone.
    }
  }
}

/**
 * Can this instance reach the internet at all? Only asked when there is no database to ask
 * (the staging copy), and only reported: it never blocks a hand-over.
 */
export async function checkNet(env = process.env) {
  if (env.DATABASE_URL) return 'skipped'
  try {
    const response = await fetch('https://www.cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) })
    await response.arrayBuffer()
    return response.ok ? 'ok' : 'failed'
  } catch {
    return 'failed'
  }
}

export async function runChecks(env = process.env) {
  const [database, net] = await Promise.all([checkDatabase(env), checkNet(env)])
  return { database, net }
}

/** The hand-over may begin: the checks have run and the database (when there is one) answered. */
export const checksPass = (checks) => checks?.database === 'ok' || checks?.database === 'none'

/**
 * Start holding. `app` is the URL of the module to become on POST /go.
 * Returns { server, state, listening } (for the tests).
 */
export function startHold({
  env = process.env,
  port = HOLD_PORT,
  app,
  check = runChecks,
  exit = (code) => process.exit(code),
  load = (url) => import(url),
  maxHoldMs = MAX_HOLD_MS,
  checkEveryMs = CHECK_EVERY_MS,
} = {}) {
  const state = { held: true, checks: { database: 'pending', net: 'pending' } }
  const commit = resolveAppCommit(env)
  let checkTimer = null

  const refresh = async () => {
    let checks
    try {
      checks = await check(env)
    } catch {
      checks = { database: 'failed', net: 'failed' }
    }
    if (!state.held) return
    state.checks = checks
    checkTimer = setTimeout(refresh, checkEveryMs)
  }

  // Nothing to finish while holding: leave at once when asked to stop.
  const onSignal = () => exit(0)
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)
  const giveUp = setTimeout(() => {
    console.log('[hold] never released, leaving')
    exit(0)
  }, maxHoldMs)

  const send = (response, status, body) => {
    response.writeHead(status, { 'content-type': 'application/json', connection: 'close' })
    response.end(JSON.stringify(body))
  }

  const server = createServer((request, response) => {
    request.resume()
    if (request.method === 'GET' && request.url === '/held') {
      return send(response, 200, { held: state.held, ok: state.held && checksPass(state.checks), checks: state.checks, commit })
    }
    if (request.method === 'POST' && request.url === '/go') {
      const first = state.held
      state.held = false
      send(response, 200, { released: true })
      if (first) setImmediate(release)
      return
    }
    return send(response, 404, { error: 'Not found' })
  })

  async function release() {
    clearTimeout(checkTimer)
    clearTimeout(giveUp)
    // From here the app's own shutdown handling (the end of server.js) takes over.
    process.off('SIGTERM', onSignal)
    process.off('SIGINT', onSignal)
    await new Promise((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
    console.log('[hold] released, starting the app')
    try {
      await load(app)
    } catch (error) {
      console.error('[hold] the app failed to start:', error)
      exit(1)
    }
  }

  const listening = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '0.0.0.0', () => resolve(server.address().port))
  })
  listening.then(
    (bound) => console.log('[hold] holding on port ' + bound + ' (commit ' + commit + ')'),
    (error) => {
      console.error('[hold] could not listen:', error?.message || error)
      exit(1)
    },
  )
  void refresh()
  return { server, state, listening }
}

// Run directly (`node lib/container-hold.js [app-module]`); importing it starts nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href : new URL('../server.js', import.meta.url).href
  startHold({ app })
}
