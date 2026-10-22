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
- **Secrets by name.** Every setting is a Worker secret (`wrangler secret bulk`, write-only afterwards)
  except three plain `vars` in `wrangler.jsonc` (`NODE_ENV`, `APP_PUBLIC_URL`, `FIRM_TIME_ZONE`). The repo is
  public, so addresses, ids and switches (`OWNER_EMAIL`, `ADMIN_EMAIL`, `EMAIL_FROM`, `ELEVENLABS_AGENT_ID`,
  `MAINTENANCE_MODE`, `AUTOPAY_CHARGING`, ...) travel as secrets too. `pickContainerEnv` in
  `cloudflare/worker.js` copies exactly the names in `cloudflare/env-names.js` into the container's environment,
  and nothing else; `scripts/cf/secrets-upload.mjs` uploads exactly that list minus the `vars`. A test
  (`cloudflare/env-names.test.mjs`) scans `server.js`, `lib/` and `db/` for every `process.env.NAME` the app
  reads and fails when one is neither in the list nor a known host-only name, so a new setting cannot be
  forgotten. The current list: `DATABASE_URL, PGSSLMODE, NODE_ENV, APP_PUBLIC_URL, FIRM_TIME_ZONE, JWT_SECRET,
  VOICE_TOOL_SECRET, OWNER_BOOTSTRAP_PASSWORD, OWNER_EMAIL, ADMIN_EMAIL, TOTP_ENC_KEY, STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET, RESEND_API_KEY, RESEND_WEBHOOK_SECRET, EMAIL_FROM, INVOICE_EMAIL_FROM,
  INVOICE_REPLY_TO, ANTHROPIC_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, ELEVENLABS_WEBHOOK_SECRET,
  SIGNWELL_API_KEY, SIGNWELL_TEST_MODE, SIGNWELL_WEBHOOK_ID, INVOICE_AUTO_REMINDERS, INVOICE_PAST_DUE_NOTICES,
  ASSISTANT_DIGEST, ASSISTANT_DIGEST_DOW, ASSISTANT_MODEL, ASSISTANT_FALLBACK_MODEL, ASSISTANT_SUMMARY_MODEL,
  ASSISTANT_CAPACITY_TARGET, INVOICE_AI_MODEL, INVOICE_AUTO_REMINDER_MIN_DAYS, FEATURE_REQUEST_EMAIL,
  AUTOPAY_CHARGING, TICK_TOKEN, MAINTENANCE_MODE`. `AUTOPAY_CHARGING` is left blank (autopay stays off).
- **The container reads its environment only when it starts.** A new Worker version re-attaches to the
  running container, and `onActivityExpired` never stops it, so a secret upload changes nothing until the
  container is restarted. `POST /internal/restart` (header `x-tick-token` = `TICK_TOKEN`) is answered by
  the Worker itself and destroys the container; the next request starts it with the current environment.
  `node scripts/cf/restart.mjs` does the call and waits for `/health`. Every other `/internal/*` path is 404
  from outside (the cron reaches `/internal/tick` through the Durable Object stub), and a request that
  carries a `cf-container-target-port` header is refused with 400 so a client cannot choose the port.
- **Maintenance mode.** `MAINTENANCE_MODE=1` is the cutover switch. Nothing writes: every non-GET request
  answers 503 `maintenance` (the Stripe, Resend and SignWell webhooks too; they retry, and the log shows
  `[maintenance] webhook deferred <path>`), the tick answers `{ ran: [], skipped: 'maintenance' }`, the
  in-process timers do nothing. GETs and `/health` (which reports `maintenance: true`) still work, and so do
  the sign-in POSTs (password sign-in, magic-link request and redemption, the TOTP step, sign-out), so an owner
  can sign in and look around on the new address. Those only create session or login-token rows. Everything
  else stays 503.
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
7-character commit. Runs queue (`concurrency: cf-deploy`, no canceling). Needs the repo secrets
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

## After every secret upload: restart, then check /health

The container takes its environment at start. After any `node scripts/cf/secrets-upload.mjs` that changes a
value, run:

```powershell
node scripts/cf/restart.mjs
```

It reads `TICK_TOKEN` from the rotation file (or the env file you pass), POSTs
`https://app.pbjsatime.com/internal/restart` (`--url=https://...` for the workers.dev address before the
domain is attached), prints the HTTP status only, then polls `/health` for up to 90 seconds and prints the
`commit` and `maintenance` fields. The token is never printed. A 404 means `TICK_TOKEN` has not been uploaded
yet; a 401 means the file and the Worker disagree. Check that `commit` is the one you expect and
`maintenance` is what you intended before going on.

## First-deploy checklist

The order matters: nothing real may be reachable until the maintenance switch is on.

1. The account is on the **Workers Paid** plan (Containers are not available on Free).
2. Merge to `main`. The first Actions run deploys a container with **no secrets**: it boots on the file
   backend with seeded demo data, and nothing real can be emailed or charged. Check `/health` on the
   `workers.dev` URL (the health poll in the workflow warns until the custom domain exists).
3. Upload the secrets: `node scripts/cf/secrets-upload.mjs --generate` (values come from the rotation
   file outside git, never from chat). Whenever the uploaded `DATABASE_URL` points at a database holding
   real data, the same upload **must** carry `MAINTENANCE_MODE=1`: the uploader refuses (exit 1, names only
   in the message) when `DATABASE_URL` is present and `MAINTENANCE_MODE` is blank, unless `--allow-live` is
   passed.
4. `node scripts/cf/restart.mjs` and confirm `/health` shows the expected commit and `maintenance: true`.
5. Attach the custom domain `app.pbjsatime.com` to the Worker (Workers & Pages > pbjbillingapp > Settings >
   Domains & Routes), then re-check `/health` on it. Once it works, set `workers_dev` to `false` in
   `wrangler.jsonc` (do not flip it before) and, if you want the domain in code, declare it under `routes`
   with `custom_domain: true`.
6. Update every URL that points at the app (all become `https://app.pbjsatime.com/...`):
   - Stripe webhook endpoint: `/api/stripe/webhook` (and `STRIPE_WEBHOOK_SECRET` if the endpoint is new)
   - Resend webhook: `/api/resend/webhook`
   - SignWell callback: `/api/signwell/webhook` (re-register with `scripts/prod/signwell-webhook-register.mjs`,
     see `docs/signwell.md`; `SIGNWELL_WEBHOOK_ID` changes with it)
   - ElevenLabs tools and post-call webhook: re-run `node scripts/provision-voice-agent.mjs` with the new
     `APP_PUBLIC_URL`
   - The desktop shell's app URL: `APP_ORIGIN` in `desktop/src-tauri/src/main.rs` (currently
     `https://app.pbjsa.com`) needs a new `desktop-v*` release
   - Cutover follow-up: links in emails already sent point at `app.pbjsa.com`; have that host redirect
     browser GET/HEAD navigation to `https://app.pbjsatime.com` (see the cutover runbook).
7. Turn `MAINTENANCE_MODE` off (upload `MAINTENANCE_MODE=0` with `--allow-live`, then restart) only after
   the data cutover is checked.

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
- `POST /internal/restart` really ends the container on Cloudflare (the code calls `destroy()` on the stub, checked against the package source and a mock, not against a live Durable Object) and the next request starts it with the new environment.
- Outbound Postgres on 5432 from the container works (`/health` shows `db: ok`).
- `package-lock.json` as edited on Windows installs cleanly with `npm ci` on Linux; if it does not, run
  the lockfile-refresh workflow.
