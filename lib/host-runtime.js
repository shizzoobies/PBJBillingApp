import { existsSync, readFileSync } from 'node:fs'

/**
 * Small host-neutral runtime rules for server.js: which commit is serving, and the
 * maintenance switch used while the app is moved between hosts.
 */

/**
 * The 7-character commit this process was built from, for /health. First one set
 * wins: APP_COMMIT (build arg / Worker env), then Railway's runtime variable, then
 * Cloudflare Workers Builds, then the `.app-commit` file the deploy workflow writes
 * into the image, else 'unknown'.
 */
export function resolveAppCommit(env = process.env, commitFile = '/app/.app-commit') {
  const fromEnv = [env.APP_COMMIT, env.RAILWAY_GIT_COMMIT_SHA, env.WORKERS_CI_COMMIT_SHA]
    .map((value) => String(value || '').trim())
    .find((value) => value && value !== 'unknown')
  if (fromEnv) return fromEnv.slice(0, 7)
  try {
    if (existsSync(commitFile)) {
      const fromFile = readFileSync(commitFile, 'utf8').trim()
      if (fromFile) return fromFile.slice(0, 7)
    }
  } catch {
    // An unreadable file is the same as no file.
  }
  return 'unknown'
}

/** True while the app is being moved between hosts (MAINTENANCE_MODE=1). */
export function isMaintenanceMode(env = process.env) {
  return String(env?.MAINTENANCE_MODE || '') === '1'
}

const PROVIDER_WEBHOOK_PATHS = new Set([
  '/api/stripe/webhook',
  '/api/resend/webhook',
  '/api/signwell/webhook',
])

/** The three provider webhooks (Stripe, Resend, SignWell). */
export function isProviderWebhookPath(pathname) {
  return PROVIDER_WEBHOOK_PATHS.has(pathname)
}

/**
 * MAINTENANCE_MODE=1: during the data cutover NOTHING may write to the old database, so
 * every request that is not a read (GET, HEAD, OPTIONS) answers 503 - the provider
 * webhooks included (Stripe, Resend and SignWell all retry on a non-2xx, so the events
 * arrive after the switch). Reads still work so staff can look. /health and the tick are
 * the two exceptions: /health is a GET, and the tick answers for itself (it runs no jobs
 * while this is on; see lib/periodic-jobs.js).
 * @returns {{ status: number, body: { error: string, message: string } } | null}
 */
export function maintenanceRefusal(env, method, pathname) {
  if (!isMaintenanceMode(env)) return null
  const verb = String(method || 'GET').toUpperCase()
  if (verb === 'GET' || verb === 'HEAD' || verb === 'OPTIONS') return null
  if (pathname === '/health' || pathname === '/internal/tick') return null
  return {
    status: 503,
    body: { error: 'maintenance', message: 'The app is being moved - try again in a few minutes.' },
  }
}
