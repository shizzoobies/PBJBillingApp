// Dependency-free so scripts/cf/secrets-upload.mjs and the tests can import it without
// the @cloudflare/containers package. cloudflare/worker.js re-exports it.
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
  'ASSISTANT_DIGEST_DOW',
  'ASSISTANT_MODEL',
  'ASSISTANT_FALLBACK_MODEL',
  'ASSISTANT_SUMMARY_MODEL',
  'ASSISTANT_CAPACITY_TARGET',
  'INVOICE_AI_MODEL',
  'INVOICE_AUTO_REMINDER_MIN_DAYS',
  'FEATURE_REQUEST_EMAIL',
  'AUTOPAY_CHARGING',
  'TICK_TOKEN',
  'MAINTENANCE_MODE',
  // Stamped by scripts/cf/secrets-upload.mjs on every upload; /health echoes it so
  // scripts/cf/restart.mjs can prove the container started with that upload's environment.
  'ENV_REVISION',
]
