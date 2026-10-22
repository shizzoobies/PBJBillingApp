// The Cloudflare front door for PBJBillingApp: every request goes to ONE container
// that runs the same Dockerfile image as every other host. See docs/cloudflare.md.
//
// This file is bundled by wrangler (see wrangler.jsonc); it is not part of the
// container image. https://developers.cloudflare.com/containers/
import { Container, getContainer } from '@cloudflare/containers'

/**
 * The names copied from the Worker's env (vars + secrets) into the container's env,
 * and nothing else: a name not listed here never reaches the app. Secrets are Worker
 * secrets (write-only after upload); the container only sees them through here.
 * https://developers.cloudflare.com/containers/examples/env-vars-and-secrets/
 */
export const CONTAINER_ENV_NAMES = [
  'DATABASE_URL',
  'PGSSLMODE',
  'NODE_ENV',
  'APP_PUBLIC_URL',
  'FIRM_TIME_ZONE',
  'JWT_SECRET',
  'VOICE_TOOL_SECRET',
  'OWNER_BOOTSTRAP_PASSWORD',
  'OWNER_EMAIL',
  'ADMIN_EMAIL',
  'TOTP_ENC_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'RESEND_API_KEY',
  'RESEND_WEBHOOK_SECRET',
  'EMAIL_FROM',
  'INVOICE_EMAIL_FROM',
  'INVOICE_REPLY_TO',
  'ANTHROPIC_API_KEY',
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_AGENT_ID',
  'ELEVENLABS_WEBHOOK_SECRET',
  'SIGNWELL_API_KEY',
  'SIGNWELL_TEST_MODE',
  'SIGNWELL_WEBHOOK_ID',
  'INVOICE_AUTO_REMINDERS',
  'INVOICE_PAST_DUE_NOTICES',
  'ASSISTANT_DIGEST',
  'TICK_TOKEN',
  'MAINTENANCE_MODE',
]

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

export default {
  // Forward the Request object itself: the Stripe, Resend and SignWell webhooks verify an
  // HMAC over the exact bytes sent, so the body must not be re-read or re-encoded here.
  fetch: (request, env) => getContainer(env.APP, 'app').fetch(request),

  // Cron Trigger (wrangler.jsonc triggers.crons): run the app's periodic jobs. The fetch
  // also wakes the container if it was restarted, which is what re-arms its own timers.
  scheduled: (controller, env, ctx) =>
    ctx.waitUntil(
      getContainer(env.APP, 'app').fetch('http://app/internal/tick', {
        method: 'POST',
        headers: { 'x-tick-token': env.TICK_TOKEN ?? '' },
      }),
    ),
}
