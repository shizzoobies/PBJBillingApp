import { isMaintenanceMode } from './host-runtime.js'
import { safeEqual } from './voice.js'

/**
 * The app's periodic jobs, in one place.
 *
 * Until now every job (weekly digest, past-due notices, automatic invoice
 * reminders, the SignWell left-finishing check, the rate-limit sweep) lived on its
 * own `setInterval` inside server.js, which only works on a host that keeps the
 * process running. On Cloudflare the container can sleep or restart at any time, so
 * the Worker's Cron Trigger calls `POST /internal/tick` and the tick runs every job
 * here. server.js still starts its own intervals (Railway and local dev behave
 * exactly as before) but each one calls the SAME entry below, so there is one
 * implementation per job. Every job is idempotent (per-week, per-invoice and
 * per-day markers), so an interval and a tick landing in the same hour is safe.
 *
 * This is runtime glue, not a script: server.js populates the registry at boot.
 */

/** @type {{ name: string, run: () => unknown }[]} */
export const PERIODIC_JOBS = []

/**
 * Add a job (or replace the one with this name, so a reload never doubles it).
 * Returns the registered entry so server.js can hand it to its interval.
 */
export function registerPeriodicJob(name, run, registry = PERIODIC_JOBS) {
  const job = { name, run }
  const existing = registry.findIndex((entry) => entry.name === name)
  if (existing >= 0) registry[existing] = job
  else registry.push(job)
  return job
}

/**
 * Run one job and never let it throw (an interval's rejection would otherwise take the process down).
 * While MAINTENANCE_MODE=1 nothing runs: the jobs write (digest markers, reminder log
 * entries), and nothing may write to the old database during the cutover.
 */
export async function runPeriodicJob(job, env = process.env) {
  if (isMaintenanceMode(env)) return null
  try {
    await job.run()
    return null
  } catch (error) {
    const message = String(error?.message || error)
    console.error(`[periodic] ${job.name} failed:`, message)
    return message
  }
}

/**
 * Run every job, one at a time and in registration order, each in its own try/catch.
 * A failing job is reported and the rest still run. `ran` names the jobs that
 * completed; `failed` carries the ones that threw. In maintenance mode it runs none and
 * answers `{ ran: [], skipped: 'maintenance' }`.
 */
export async function runAllPeriodicJobs(registry = PERIODIC_JOBS, env = process.env) {
  if (isMaintenanceMode(env)) return { ran: [], skipped: 'maintenance' }
  const ran = []
  const failed = []
  for (const job of [...registry]) {
    const message = await runPeriodicJob(job, env)
    if (message === null) ran.push(job.name)
    else failed.push({ name: job.name, message })
  }
  return { ran, failed }
}

/**
 * Who may call the tick: 404 when no TICK_TOKEN is configured (the route does not
 * exist), 401 unless `x-tick-token` equals it (length-checked, timing-safe via
 * safeEqual), otherwise `null` meaning "allowed".
 * @returns {{ status: number, body: { error: string } } | null}
 */
export function tickRefusal(env, presentedToken) {
  const expected = String(env?.TICK_TOKEN || '')
  if (!expected) return { status: 404, body: { error: 'Not found' } }
  if (!safeEqual(String(presentedToken || ''), expected)) {
    return { status: 401, body: { error: 'Unauthorized' } }
  }
  return null
}
