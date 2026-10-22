#!/usr/bin/env node
// Restart the Cloudflare container so it re-reads the Worker's secrets and vars.
//
//   node scripts/cf/restart.mjs [env-file] [--url=https://...] [--expect-revision=<value>]
//
// The container receives its environment only when it STARTS, and a new Worker version
// re-attaches to the running container, so a secret upload changes nothing until this
// runs (docs/cloudflare.md). It POSTs /internal/restart (the Worker, never the app,
// answers it; header x-tick-token = TICK_TOKEN), then waits for /health to answer 200
// and prints the commit and maintenance fields. The token is never printed.
//
// --expect-revision=<ENV_REVISION printed by secrets-upload.mjs>: a restart served by an
// older Worker version can bring the container back on the OLD environment, so after /health
// answers 200 its envRevision must equal the value; if not, restart again (up to
// MAX_EXTRA_RESTARTS more times, RESTART_GAP_MS apart) and fail with the last status if it never does.
import { pathToFileURL } from 'node:url'
import { readEnvFile } from '../prod/env.mjs'
import { DEFAULT_ROTATION_FILE } from './secrets-upload.mjs'

export const DEFAULT_APP_URL = 'https://app.pbjsatime.com'
const HEALTH_TIMEOUT_MS = 90_000
const HEALTH_INTERVAL_MS = 3_000
// The restart route itself waits up to 20 s for a graceful stop before it destroys the
// container (measured 20.9 s on 2026-10-22), so the request budget has to be well above that.
const REQUEST_TIMEOUT_MS = 60_000
export const MAX_EXTRA_RESTARTS = 3
export const RESTART_GAP_MS = 20_000
const USAGE = 'Usage: node scripts/cf/restart.mjs [env-file] [--url=https://...] [--expect-revision=<value>]'

/** The --expect-revision= value, or null when the flag is absent. A blank value is refused. */
export function expectedRevision(argv = []) {
  const flag = argv.find((arg) => arg.startsWith('--expect-revision='))
  if (flag === undefined) return null
  const value = flag.slice('--expect-revision='.length).trim()
  if (!value) throw new Error('--expect-revision needs a value (the ENV_REVISION that secrets-upload.mjs printed)')
  return value
}

/** The envRevision a /health answer reports, or null. */
export function reportedRevision(body) {
  return typeof body?.envRevision === 'string' && body.envRevision ? body.envRevision : null
}

/** What the last /health answer said, for a failure message; only fields that are safe to show. */
export function describeHealth(status, body) {
  if (status === null || status === undefined) return 'no response'
  return 'status=' + status + ' db=' + (typeof body?.db === 'string' ? body.db : 'unknown') +
    ' maintenance=' + Boolean(body?.maintenance) + ' envRevision=' + (reportedRevision(body) ?? 'none')
}

/** The base URL to talk to: --url=, else APP_PUBLIC_URL, else the production domain. HTTPS only. */
export function baseUrl(argv = [], env = process.env) {
  const flag = argv.find((arg) => arg.startsWith('--url='))
  const raw = (flag ? flag.slice('--url='.length) : String(env.APP_PUBLIC_URL || '')).trim() || DEFAULT_APP_URL
  let url
  try { url = new URL(raw) } catch { throw new Error('Invalid app URL') }
  if (url.protocol !== 'https:') throw new Error('The app URL must be https (the token travels in a header)')
  return url.origin
}

/** One printable line for a /health answer; only fields that are safe to show. */
export function healthLine(status, body) {
  const commit = typeof body?.commit === 'string' ? body.commit : 'unknown'
  const revision = reportedRevision(body)
  return 'health: ' + status + ' commit=' + commit + ' maintenance=' + Boolean(body?.maintenance) +
    (revision ? ' envRevision=' + revision : '')
}

async function timedFetch(fetchImpl, url, init) {
  return fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
}

export async function restartContainer(argv = [], {
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  print = console.log,
  env = process.env,
} = {}) {
  const positional = argv.filter((arg) => !arg.startsWith('--'))
  if (positional.length > 1 || argv.some((arg) => arg.startsWith('--') && !arg.startsWith('--url=') && !arg.startsWith('--expect-revision='))) {
    throw new Error(USAGE)
  }
  const base = baseUrl(argv, env)
  const expected = expectedRevision(argv)
  const token = String(readEnvFile(positional[0] || DEFAULT_ROTATION_FILE).values.TICK_TOKEN ?? '').trim()
  if (!token) throw new Error('TICK_TOKEN is blank in the env file; run secrets-upload.mjs --generate first')

  for (let restarts = 0; ; restarts++) {
    let restart
    try {
      restart = await timedFetch(fetchImpl, base + '/internal/restart', {
        method: 'POST',
        headers: { 'x-tick-token': token },
      })
    } catch { throw new Error('Restart request failed; no response from ' + base) }
    let restartBody = null
    if (restart.status === 200) {
      try { restartBody = await restart.json() } catch { /* the status is what matters */ }
    }
    print('restart: HTTP ' + restart.status + (typeof restartBody?.graceful === 'boolean' ? ' graceful=' + restartBody.graceful : ''))
    if (restart.status !== 200) {
      throw new Error(
        restart.status === 404 ? 'Restart refused (404): TICK_TOKEN is not uploaded to the Worker yet' :
        restart.status === 401 ? 'Restart refused (401): TICK_TOKEN does not match the Worker\'s' :
        'Restart failed with HTTP ' + restart.status,
      )
    }

    // The first request after the restart starts the container, which takes a while.
    const deadline = now() + HEALTH_TIMEOUT_MS
    let answered = null
    let last = { status: null, body: null }
    while (!answered) {
      try {
        const response = await timedFetch(fetchImpl, base + '/health', {})
        let body = null
        try { body = await response.json() } catch { /* an unreadable body is still an answer */ }
        last = { status: response.status, body }
        if (response.status === 200) answered = body ?? {}
      } catch { /* the container is still starting */ }
      if (answered) break
      if (now() >= deadline) {
        throw new Error('/health did not answer 200 within 90 seconds (last: ' + describeHealth(last.status, last.body) + ')')
      }
      await sleep(HEALTH_INTERVAL_MS)
    }

    const line = healthLine(200, answered)
    print(line)
    const revision = reportedRevision(answered)
    if (expected === null || revision === expected) {
      if (expected !== null) print('env revision: matches')
      return { status: 200, commit: answered.commit ?? 'unknown', maintenance: Boolean(answered.maintenance), envRevision: revision, restarts: restarts + 1, line }
    }
    if (restarts >= MAX_EXTRA_RESTARTS) {
      throw new Error(
        'The container is not running the new environment after ' + (restarts + 1) + ' restarts (expected envRevision=' + expected + '; last: ' +
        describeHealth(200, answered) + ')',
      )
    }
    print('env revision: expected ' + expected + ', got ' + (revision ?? 'none') + '; restarting again in ' + RESTART_GAP_MS / 1000 + ' s (' + (restarts + 1) + ' of ' + MAX_EXTRA_RESTARTS + ')')
    await sleep(RESTART_GAP_MS)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  restartContainer(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
