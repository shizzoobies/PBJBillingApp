# Running PBJBillingApp on Cloudflare

Plan and decisions: `docs/plans/cloudflare-migration-2026-10.md`. This page is how the runtime is
wired and what to do on the first deploy. Railway keeps working unchanged; the same `Dockerfile` and
the same `server.js` run on both.

## How it is wired

```
browser / Stripe / Resend / SignWell / ElevenLabs
        |
   Cloudflare Worker  (cloudflare/worker.js, wrangler.jsonc)      <- Cron Trigger every 15 min
        |  getContainer(env.APP, 'app').fetch(request)
   Durable Object AppContainer  --  ONE container (standard-1, max_instances 1)
        |  port 8080
   node server.js  (the repo Dockerfile)  --  outbound 5432 straight to Postgres
```

- **Worker to one container.** Every request is forwarded to the same named container instance with
  the original `Request` object (not a copy), so the HMAC-signed webhook bodies reach `server.js`
  byte for byte.
- **Tick plus cron.** A container can sleep or be restarted at any time, so the app's hourly
  `setInterval`s cannot be trusted alone. The Worker's Cron Trigger (`*/15 * * * *`, UTC) POSTs
  `/internal/tick` with the `x-tick-token` header; the app runs every job in `lib/periodic-jobs.js`
  (weekly digest, past-due notices, automatic invoice reminders, SignWell left-finishing check,
  rate-limit sweep), one at a time, and answers `{ ran, failed }`. Every job is idempotent (per-week,
  per-invoice and per-day markers), so the interval and the tick overlapping is harmless. The route is
  404 when `TICK_TOKEN` is unset and 401 on a wrong token. The tick also wakes a restarted container,
  which re-arms its own timers. Cron changes take up to 15 minutes to propagate.
- **Keep-awake.** `AppContainer` sets `sleepAfter = '2h'` and overrides `onActivityExpired()` to call
  `renewActivityTimeout()` instead of stopping. The platform may still restart the container (SIGTERM,
  then SIGKILL after 15 minutes) and promises no minimum run time; disk is ephemeral. Nothing the app
  needs lives on its disk when `DATABASE_URL` is set.
- **Secrets by name.** All secrets are Worker secrets (`wrangler secret put` / `bulk`, write-only
  afterwards) and a few plain `vars` in `wrangler.jsonc`. `pickContainerEnv` in `cloudflare/worker.js`
  copies exactly these names into the container's environment, and nothing else (a test pins the list):
  `DATABASE_URL, PGSSLMODE, NODE_ENV, APP_PUBLIC_URL, FIRM_TIME_ZONE, JWT_SECRET, VOICE_TOOL_SECRET,
  OWNER_BOOTSTRAP_PASSWORD, OWNER_EMAIL, ADMIN_EMAIL, TOTP_ENC_KEY, STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET, RESEND_API_KEY, RESEND_WEBHOOK_SECRET, EMAIL_FROM, INVOICE_EMAIL_FROM,
  INVOICE_REPLY_TO, ANTHROPIC_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID,
  ELEVENLABS_WEBHOOK_SECRET, SIGNWELL_API_KEY, SIGNWELL_TEST_MODE, SIGNWELL_WEBHOOK_ID,
  INVOICE_AUTO_REMINDERS, INVOICE_PAST_DUE_NOTICES, ASSISTANT_DIGEST, TICK_TOKEN, MAINTENANCE_MODE`.
  A new variable the app reads has to be added to that list AND uploaded, or the container never sees it.
- **Maintenance mode.** `MAINTENANCE_MODE=1` is the cutover switch. Nothing writes: every non-GET request
  answers 503 `maintenance` (the Stripe, Resend and SignWell webhooks too; they retry, and the log shows
  `[maintenance] webhook deferred <path>`), the tick answers `{ ran: [], skipped: 'maintenance' }`, the
  in-process timers do nothing. GETs, `/health` (which reports `maintenance: true`) and the login page
  still work.
- **Commit on `/health`.** `APP_COMMIT`, else `RAILWAY_GIT_COMMIT_SHA`, else `WORKERS_CI_COMMIT_SHA`, else
  the `.app-commit` file in the image, else `unknown`. The deploy workflow writes the 7-character SHA to
  `.app-commit` before the image build (wrangler's `image_vars` could pass a build arg, but
  `wrangler.jsonc` is static and the SHA is not).
- **Port.** The Dockerfile sets `PORT=8080`; `server.js` still falls back to 4173 outside the image so the
  Vite dev proxy keeps working.

## Deploying

`.github/workflows/cf-deploy.yml` runs on every push to `main` and on **Run workflow**: `npm ci`,
`npm run verify`, stamp `.app-commit`, `npx wrangler deploy` (it builds the Dockerfile image with Docker on
the runner and pushes it), then polls `https://app.pbjsatime.com/health` (40 x 15 s) for the new
7-character commit. Runs queue (`concurrency: cf-deploy`, no cancelling). Needs the repo secrets
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; the app's own secrets are never in the workflow.

- **Logs:** `npx wrangler tail pbjbillingapp` (needs the API token in the environment), or the Worker's
  Observability tab (enabled).
- **Rollback:** re-run the workflow on the previous commit (check out or revert to it on `main`, or
  **Run workflow** from a branch at that commit). The container image rolls out the same way as a deploy.
- **Config check without Docker:** `npx wrangler deploy --dry-run --containers-rollout=none --outdir <dir>`
  validates `wrangler.jsonc` and bundles the Worker. Without `--containers-rollout=none`, wrangler insists
  on a Docker CLI even for a dry run.
- **After the custom domain works:** delete the `continue-on-error: true` line on the "Wait for the new
  commit on /health" step so a deploy that never appears fails the run.

## First-deploy checklist

1. The account is on the **Workers Paid** plan (Containers are not available on Free).
2. Upload the Worker secrets with `scripts/cf/secrets-upload.mjs` (lane C; values come from the operator's
   environment, never from chat or a file in git). Include `TICK_TOKEN` (a long random value) and, for the
   first deploy, consider `MAINTENANCE_MODE=1` until the database is cut over.
3. Run the **cf-deploy** workflow once by hand. Expect the health poll to warn until the domain exists.
4. Attach the custom domain `app.pbjsatime.com` to the Worker (Workers & Pages > pbjsatime > Settings >
   Domains & Routes), then re-check `/health`.
5. Update every URL that points at the app (all become `https://app.pbjsatime.com/...`):
   - Stripe webhook endpoint: `/api/stripe/webhook` (and `STRIPE_WEBHOOK_SECRET` if the endpoint is new)
   - Resend webhook: `/api/resend/webhook`
   - SignWell callback: `/api/signwell/webhook` (re-register with `scripts/prod/signwell-webhook-register.mjs`,
     see `docs/signwell.md`; `SIGNWELL_WEBHOOK_ID` changes with it)
   - ElevenLabs tools and post-call webhook: re-run `node scripts/provision-voice-agent.mjs` with the new
     `APP_PUBLIC_URL`
   - The desktop shell's app URL: `APP_ORIGIN` in `desktop/src-tauri/src/main.rs` (currently
     `https://app.pbjsa.com`) needs a new `desktop-v*` release
6. Turn `MAINTENANCE_MODE` off (delete the secret or set it to `0`) only after the data cutover is checked.

## Unverified until the first real deploy

Nothing here has run against Cloudflare yet; the first deploy should check each of these:

- The Dockerfile builds inside `wrangler deploy` on the GitHub runner (the dry run on the laptop stops at
  the Docker requirement) and the `.app-commit` copy lands in the image (`/health` shows the SHA).
- The cron tick reaches the container: `wrangler tail` shows `[tick] ran ...` within 15 minutes, with the
  right token.
- Raw-body fidelity: a Stripe test-mode webhook, a Resend event and a SignWell event all pass their HMAC
  check through the Worker (watch for `rejected a webhook with an invalid signature`).
- `max_instances: 1` holds under a rollout (an old and a new container may overlap briefly; the app's
  markers make the jobs safe, but check for double sends).
- `standard-1` (4 GiB) is enough for PDF generation and the bulk save under real load.
- Outbound Postgres on 5432 from the container works (`/health` shows `db: ok`).
- `package-lock.json` as edited on Windows installs cleanly with `npm ci` on Linux; if it does not, run
  the lockfile-refresh workflow.
