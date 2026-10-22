// The Cloudflare front door for PBJBillingApp: every request goes to ONE container
// that runs the same Dockerfile image as every other host. See docs/cloudflare.md.
//
// This file is bundled by wrangler (see wrangler.jsonc); it is not part of the
// container image. https://developers.cloudflare.com/containers/
import { Container, getContainer } from '@cloudflare/containers'
import { CONTAINER_ENV_NAMES } from './env-names.js'

export { CONTAINER_ENV_NAMES }

/** Copy exactly the listed names that are defined on `env`; never invent one. */
export function pickContainerEnv(env) {
  const picked = {}
  for (const name of CONTAINER_ENV_NAMES) {
    const value = env?.[name]
    if (value !== undefined && value !== null) picked[name] = String(value)
  }
  return picked
}

export class AppContainer extends Container {
  // server.js listens on PORT, which the Dockerfile sets to 8080.
  defaultPort = 8080
  // Idle time before the platform may put the container to sleep. Overridden below so
  // it never does, but a long value keeps the default sane if that override is removed.
  sleepAfter = '2h'

  constructor(ctx, env) {
    super(ctx, env)
    // Applied at every container start. https://developers.cloudflare.com/containers/container-package/
    this.envVars = pickContainerEnv(env)
  }

  // The default stops the container when sleepAfter passes with no requests. The app has
  // in-process state (rate-limit buckets, open SSE streams) and its own hourly jobs, so we
  // renew instead of stopping; the platform may still restart it at any time (SIGTERM,
  // then SIGKILL after 15 minutes), which the app already survives.
  // https://developers.cloudflare.com/containers/container-package/ (onActivityExpired:
  // "If you override it, you must call stop() or destroy() or the container won't sleep" -
  // not sleeping is the point here.)
  async onActivityExpired() {
    this.renewActivityTimeout()
  }
}

/** Length-independent, constant-time string compare (digests first, so lengths never leak). */
async function tokensMatch(presented, expected) {
  const digest = async (value) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  const [a, b] = await Promise.all([digest(presented), digest(expected)])
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

const json = (status, body) => Response.json(body, { status })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// How long a restart waits for the app to exit on SIGTERM before it is killed.
const GRACEFUL_STOP_MS = 20_000
const STOP_POLL_MS = 500
const STOPPED_STATES = new Set(['stopped', 'stopped_with_code'])

/**
 * Ask the container to exit (SIGTERM, so the app can finish its writes), wait up to
 * GRACEFUL_STOP_MS for it to report stopped, then destroy() it either way. Resolves to
 * whether it stopped by itself first.
 */
async function restartContainer(container) {
  let graceful = false
  try {
    await container.stop('SIGTERM')
    const deadline = Date.now() + GRACEFUL_STOP_MS
    for (;;) {
      const state = await container.getState()
      if (STOPPED_STATES.has(state?.status)) {
        graceful = true
        break
      }
      if (Date.now() >= deadline) break
      await sleep(STOP_POLL_MS)
    }
  } catch (error) {
    console.error('[restart] graceful stop failed', error?.message)
  }
  await container.destroy()
  return graceful
}

export default {
  async fetch(request, env) {
    // A client must never choose which container port the Worker talks to.
    if (request.headers.has('cf-container-target-port')) {
      return json(400, { error: 'Bad request' })
    }

    // The app decodes the path before routing, so decode it here before judging it.
    let pathname
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname).toLowerCase()
    } catch {
      return json(400, { error: 'Bad request' })
    }

    // /internal/* is for the Worker and its cron, never for the public internet. The cron
    // reaches /internal/tick through the container stub directly (see scheduled below).
    if (pathname === '/internal' || pathname.startsWith('/internal/')) {
      if (pathname !== '/internal/restart' || request.method !== 'POST' || !env.TICK_TOKEN) {
        return json(404, { error: 'Not found' })
      }
      if (!(await tokensMatch(request.headers.get('x-tick-token') ?? '', String(env.TICK_TOKEN)))) {
        return json(401, { error: 'Unauthorized' })
      }
      // envVars is read only when the container STARTS, so a secret change reaches the app
      // only after a restart. stop() sends SIGTERM and returns while the process may still be
      // running, so wait for it (briefly), then destroy() to end it for certain. The next
      // request or tick starts it with the current env.
      const graceful = await restartContainer(getContainer(env.APP, 'app'))
      return json(200, { restarted: true, graceful })
    }

    // The app trusts the LAST x-forwarded-for hop (server.js getClientIp), so a client-sent
    // header must never reach it: replace it with the address Cloudflare saw. Rebuilding only
    // the headers keeps the body stream untouched, which the Stripe, Resend and SignWell
    // webhooks need (they verify an HMAC over the exact bytes sent).
    const headers = new Headers(request.headers)
    headers.set('x-forwarded-for', request.headers.get('cf-connecting-ip') ?? '')
    headers.delete('x-real-ip')
    return getContainer(env.APP, 'app').fetch(new Request(request, { headers }))
  },

  // Cron Trigger (wrangler.jsonc triggers.crons): run the app's periodic jobs. The fetch
  // also wakes the container if it was restarted, which is what re-arms its own timers.
  scheduled: (controller, env, ctx) =>
    ctx.waitUntil(
      getContainer(env.APP, 'app')
        .fetch('http://app/internal/tick', {
          method: 'POST',
          headers: { 'x-tick-token': env.TICK_TOKEN ?? '' },
        })
        .then((response) => response.ok || console.error('[cron] tick', response.status))
        .catch((error) => console.error('[cron] tick failed', error?.message)),
    ),
}
