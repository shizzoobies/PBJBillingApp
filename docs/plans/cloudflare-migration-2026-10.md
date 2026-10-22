# Cloudflare migration (2026-10-21) - plan, lanes, and the Astra brief

**Why:** Railway's 2026-10-21 security disclosure (customer environment variables read by an attacker, all
builds paused for the day). Alex's decision: move PBJBillingApp off Railway to Cloudflare, starting tonight.
Every secret that lived on Railway is being rotated from a file that stays outside this repository.

**Target shape (facts checked against Cloudflare's docs on 2026-10-21):**
- Compute: a Cloudflare Container (GA, Workers Paid plan) running the SAME Docker image this repo already
  builds, behind a tiny Worker that forwards every request to one container instance (`standard-1`, 1/2 vCPU,
  4 GiB). Containers are not guaranteed always-on, so the app's periodic jobs also run from a Cron Trigger
  that calls `POST /internal/tick` every 15 minutes (which also keeps the container awake).
- Database: Cloudflare has no Postgres of its own (D1 is SQLite). The database moves to a managed Postgres 18
  host with point-in-time recovery (Neon, AWS us-east-1), reached over TLS from the container. The schema is
  created by the app's own boot DDL (idempotent `create ... if not exists`); the data moves with `pg_dump -Fc`
  from Railway and `pg_restore` into the new host, verified by per-table row counts before cutover.
- Domain: the firm's `pbjsa.com` zone is on a different Cloudflare account, so the app's new address is
  `https://app.pbjsatime.com` (zone `pbjsatime.com`, Alex's account). `app.pbjsa.com` keeps serving from
  Railway until cutover; afterwards the `pbjsa.com` zone owner adds a redirect.
- Secrets: Worker secrets (write-only after they are set), passed into the container's environment at start.
  Nothing secret is ever committed, printed, or pasted into chat or tickets.
- Deploy: GitHub Actions builds the image and runs `wrangler deploy` on every push to `main` (this laptop has
  no Docker). The gate stays `npm run verify`.
- Backups: a nightly `pg_dump` of the new database to Cloudflare R2 with a bucket lock (the existing
  `db-backup.yml` has been failing since at least 2026-10-19 and is being fixed as part of this).

**Address changes at cutover (`APP_PUBLIC_URL` -> `https://app.pbjsatime.com`):** the Stripe webhook endpoint
(Stripe dashboard), the Resend delivery webhook (Resend dashboard), the SignWell webhook (the registration
script), the ElevenLabs voice tools (re-run `voice-provision`), the desktop shell's app URL, staff bookmarks.

---

## Lanes

| Lane | Branch | Owner | Owns these files | Must not touch |
|---|---|---|---|---|
| A - runtime | `cf/runtime` | Claude (Opus builder) | `server.js` (tick endpoint, health commit, maintenance mode, job registry), `Dockerfile`, `wrangler.jsonc`, `cloudflare/`, `.github/workflows/cf-deploy.yml`, `package.json` + lockfile, `docs/cloudflare.md` | `scripts/`, `db/`, other docs |
| B - database | `cf/db-migration` | Claude (Opus builder) | `scripts/migrate/`, `db/store.js` (TLS to the new host only), `.github/workflows/db-backup.yml`, `docs/runbooks/db-backup-and-restore.md` | `server.js`, `scripts/prod/`, `cloudflare/` |
| C - ops and docs | `cf/ops-and-docs` | **Astra** | `scripts/prod/` (every file), new `scripts/cf/`, `docs/runbooks/cloudflare-cutover.md`, `docs/HANDOFF.md` (sections 1 and 4 only), `AGENTS.md`, `docs/signwell.md` (variable wording only), `.railway/` (delete) | `server.js`, `Dockerfile`, `db/`, `cloudflare/`, `scripts/migrate/`, `.github/workflows/`, `docs/capability-manifest.md`, `src/` |

Each lane: `npm run verify` green before every push; line-level edits only; CRLF line endings; no `sed -i`;
American spelling; commit trailer as your tooling specifies. Lanes merge to `main` one at a time through
pull requests; Claude merges A and B; Astra opens the PR for C and Alex or Claude merges it.

---

## Astra: your brief (lane C, branch `cf/ops-and-docs`)

Start from `main` (at or after commit `1b5328fe`). Read `CLAUDE.md`, `AGENTS.md`, `docs/HANDOFF.md`
sections 0-4 first. Work ONLY in the files the table above gives lane C. Open a pull request against `main`
titled "Ops off Railway: env-file driven prod scripts, Cloudflare secrets upload, cutover runbook"; put your
report in the PR body (what changed per file, how you tested, anything left). Do not push to `main`. Do not
run anything against production. Never read, print, or commit a secret value; the scripts you write read
values only inside their own process.

### C1. Production scripts stop depending on the Railway CLI
Today every `scripts/prod/*.mjs` (and `scripts/prod/ship.sh`) fetches variables with
`execSync('npx @railway/cli@latest variables --service ... --json')` and reads `DATABASE_PUBLIC_URL` or the
provider keys from that JSON. The Railway public database URL no longer exists (the public proxy was removed
on 2026-10-21) and the Railway API is not a dependency we keep. Replace that with ONE shared helper
`scripts/prod/env.mjs` exporting `prodEnv(names)`:
- values come from `process.env` first;
- otherwise from a local env file whose PATH is given by `PBJ_PROD_ENV_FILE` (default
  `D:\PBJ Accounting Work\secrets\prod.env` on Alex's machine; the file is `KEY=value` lines, `#` comments,
  never inside a git repository);
- a missing name throws a plain error naming the variable and the file path (never the value);
- nothing is ever logged.
Every script then asks for exactly the names it needs: `PROD_DATABASE_URL` for anything that reads the
database (`tracker-list`, `tracker-read`, `tracker-update`, `quiet-check`, `merge-client`, the one-off
data scripts), `ELEVENLABS_API_KEY` + `ELEVENLABS_AGENT_ID` + `VOICE_TOOL_SECRET` + `APP_PUBLIC_URL` for
`voice-provision.mjs`, `SIGNWELL_API_KEY` + `APP_PUBLIC_URL` for `signwell-webhook-register.mjs`.
The database connection must use TLS (`sslmode=verify-full` in the URL is fine; do not disable certificate
checks). Keep every script's behavior and output otherwise identical; the read-only ones stay read-only.

### C2. `scripts/prod/ship.sh` for the Cloudflare deploy
Keep its guards (clean tree on `main`, main == origin/main or local main ahead of origin by the shipped
commit, the quiet check, fast-forward, push). Replace the Railway poll with: wait for the GitHub Actions run
of `cf-deploy.yml` for that commit (`gh run list --workflow cf-deploy.yml --commit <sha>` / `gh run watch`),
then poll `https://app.pbjsatime.com/health` until its 7-character `commit` matches (40 x 15 s), then print
the last lines of `npx wrangler tail --format json` for 10 seconds (or skip tail if it cannot run without a
browser login - say so). The script must gate on exit codes, never on grepped output. Fix: `ok=0` must be a
statement, not a comment (a bug from 2026-10-17 made the old poll crash under `set -u`).

### C3. `scripts/cf/secrets-upload.mjs`
Reads an env file (path argument, default `D:\PBJ Accounting Work\secrets\rotation-2026-10-21.env`), keeps
only the names in an explicit allow-list (the app's secret names: `DATABASE_URL`, `JWT_SECRET`,
`VOICE_TOOL_SECRET`, `OWNER_BOOTSTRAP_PASSWORD`, `TOTP_ENC_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_WEBHOOK_SECRET`,
`SIGNWELL_API_KEY`, `SIGNWELL_TEST_MODE`, `SIGNWELL_WEBHOOK_ID`, `TICK_TOKEN`, `INVOICE_AUTO_REMINDERS`,
`PGSSLMODE`), skips blank values, and pipes `{ "NAME": "value", ... }` to `npx wrangler secret bulk` on
stdin for the Worker named `pbjbillingapp` - printing ONLY the names it set and the names it skipped. Add
`--dry-run` (names only, no upload) and `--generate` (fills `JWT_SECRET`, `VOICE_TOOL_SECRET`, `TICK_TOKEN`
with fresh 64-hex values when blank, writing them back to the file). Document the exact `wrangler secret bulk`
syntax you relied on with the docs URL.

### C4. `docs/runbooks/cloudflare-cutover.md`
The step-by-step cutover, written for Alex to follow with Claude: prerequisites (Workers Paid plan, the
Neon project and its URL in the secrets file, the Worker deployed and answering on its temporary
`workers.dev` URL, secrets uploaded, `app.pbjsatime.com` custom domain attached, the Stripe/Resend/SignWell
endpoints registered for the new URL in TEST mode first where possible); the data move (announce to staff,
set `MAINTENANCE_MODE=1` on the Railway service, take the dump, restore, run the verification, point the
Worker's `DATABASE_URL` at the new host, flip maintenance off, smoke test: login, a client page, an invoice
PDF, a reminder dry run); DNS (the custom domain on the Worker; the old `app.pbjsa.com` redirect for the
other zone's owner); rollback (point `DATABASE_URL` back / keep Railway up 48 h; which writes would be lost);
after (delete Railway variables, revoke the old provider keys, re-provision the voice agent, update the
desktop shell's URL, close the Railway project only after the backups have run twice).

### C5. Docs and cleanup
- `docs/HANDOFF.md`: section 1 (what this is / where it runs) and section 4 (production diagnostics) describe
  Cloudflare + the new Postgres host instead of Railway; everything else untouched.
- `AGENTS.md`: the ship ritual and production access paragraphs updated the same way.
- `docs/signwell.md`: "Railway service variables" -> "Worker secrets (scripts/cf/secrets-upload.mjs)".
- Delete `.railway/railway.ts` and the `.railway/` folder; delete any Railway-only workflow (keep
  `verify.yml`, `lockfile-refresh.yml`, `desktop-release.yml`, and leave `db-backup.yml` to lane B).
- Tests: unit tests for `scripts/prod/env.mjs` (env wins over file, missing name error names the variable
  and path, values never appear in error text) and for the allow-list / dry-run of `secrets-upload.mjs`
  (with a temp file; no network). The repo's `npm run verify` must stay green.

### What you will not have
No Railway access, no production database, no Cloudflare token. Everything above is testable locally with
temp files and fakes. If something in the lane's scope needs a decision, put the question in the PR body and
proceed with the safer reading.
