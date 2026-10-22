#!/usr/bin/env node
// Restart the Cloudflare container so it re-reads the Worker's secrets and vars.
//
//   node scripts/cf/restart.mjs [env-file] [--url=https://...]
//
// The container receives its environment only when it STARTS, and a new Worker version
// re-attaches to the running container, so a secret upload changes nothing until this
// runs (docs/cloudflare.md). It POSTs /internal/restart (the Worker, never the app,
// answers it; header x-tick-token = TICK_TOKEN), then waits for /health to answer 200
// and prints the commit and maintenance fields. The token is never printed.
import { pathToFileURL } from 'node:url'
import { readEnvFile } from '../prod/env.mjs'
import { DEFAULT_ROTATION_FILE } from './secrets-upload.mjs'

export const DEFAULT_APP_URL = 'https://app.pbjsatime.com'
const HEALTH_TIMEOUT_MS = 90_000
const HEALTH_INTERVAL_MS = 3_000
const REQUEST_TIMEOUT_MS = 20_000

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
  return 'health: ' + status + ' commit=' + commit + ' maintenance=' + Boolean(body?.maintenance)
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
  if (positional.length > 1 || argv.some((arg) => arg.startsWith('--') && !arg.startsWith('--url='))) {
    throw new Error('Usage: node scripts/cf/restart.mjs [env-file] [--url=https://...]')
  }
  const base = baseUrl(argv, env)
  const token = String(readEnvFile(positional[0] || DEFAULT_ROTATION_FILE).values.TICK_TOKEN ?? '').trim()
  if (!token) throw new Error('TICK_TOKEN is blank in the env file; run secrets-upload.mjs --generate first')

  let restart
  try {
    restart = await timedFetch(fetchImpl, base + '/internal/restart', {
      method: 'POST',
      headers: { 'x-tick-token': token },
    })
  } catch { throw new Error('Restart request failed; no response from ' + base) }
  print('restart: HTTP ' + restart.status)
  if (restart.status !== 200) {
    throw new Error(
      restart.status === 404 ? 'Restart refused (404): TICK_TOKEN is not uploaded to the Worker yet' :
      restart.status === 401 ? 'Restart refused (401): TICK_TOKEN does not match the Worker\'s' :
      'Restart failed with HTTP ' + restart.status,
    )
  }

  // The first request after the restart starts the container, which takes a while.
  const deadline = now() + HEALTH_TIMEOUT_MS
  for (;;) {
    try {
      const response = await timedFetch(fetchImpl, base + '/health', {})
      if (response.status === 200) {
        let body = null
        try { body = await response.json() } catch { /* an unreadable body is still a 200 */ }
        const line = healthLine(200, body)
        print(line)
        return { status: 200, commit: body?.commit ?? 'unknown', maintenance: Boolean(body?.maintenance), line }
      }
    } catch { /* the container is still starting */ }
    if (now() >= deadline) throw new Error('/health did not answer 200 within 90 seconds')
    await sleep(HEALTH_INTERVAL_MS)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  restartContainer(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
