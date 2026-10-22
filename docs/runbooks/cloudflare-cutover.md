# Cloudflare cutover

Operator: Alex with Claude. This is an execution checklist, not evidence that cutover has happened. Lane C has no production access. Merge lanes A and B first, review this PR, then authorize each production phase. The target is Worker `pbjbillingapp`, a single Container, Neon Postgres 18 in AWS us-east-1, and `https://app.pbjsatime.com`.

## 1. Prepare without touching the live database

1. Confirm Workers Paid on the account that owns `pbjsatime.com`, the Neon project with point-in-time recovery, and an unpooled connection URL with `sslmode=verify-full`. `setx NEON_DATABASE_URL` affects future shells only. Do not paste a URL into chat, a ticket, a command transcript, or Git.
2. Install the locked dependencies, GitHub CLI, and PostgreSQL 18 client tools. Authenticate GitHub for this repository. Lane A owns the Wrangler dependency, configuration, `cf-deploy.yml`, Worker environment forwarding, and runtime controls; lane B owns the migration commands and backup workflow. Review their merged docs before executing these steps.
3. Keep the production env file outside every Git repository, normally `D:\PBJ Accounting Work\secrets\prod.env`; set `PBJ_PROD_ENV_FILE` to use another path. Keep the rotation file outside Git too, normally `D:\PBJ Accounting Work\secrets\rotation-2026-10-21.env`. Restrict both files to the operator through Windows ACLs. They use `KEY=value`, whole-line comments, and optional single/double quotes. No interpolation or multiline values.
4. The ops file needs `PROD_DATABASE_URL` for direct verified-TLS database access, plus `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, `VOICE_TOOL_SECRET`, `SIGNWELL_API_KEY`, and `APP_PUBLIC_URL` for the corresponding tools. Process environment wins per variable. Stale process values can override a freshly edited file, so start a clean shell or clear those overrides. `NEON_DATABASE_URL` is a setup input, not an alias automatically read by ops scripts: privately copy it into the appropriate file entries. Never print values to check them.
5. Put rotated app values in the rotation file, with `DATABASE_URL` pointing at an isolated rehearsal database until the final restore is verified. Preserve the existing `TOTP_ENC_KEY` until an approved decrypt/re-encrypt migration exists; rotating it blindly can lock staff out of their existing TOTP secrets. Changing `JWT_SECRET` signs everyone out. Do not set `OWNER_BOOTSTRAP_PASSWORD` casually: review its boot behavior with lane A before first start.
6. Stage `SIGNWELL_TEST_MODE=true` and `INVOICE_AUTO_REMINDERS=off`. Keep live sends, payment actions, startup recovery jobs and scheduled jobs disabled or isolated throughout rehearsal. Stripe and Resend credentials/endpoints must match the intended test environment where available; do not send test events to the live database. Test-mode SignWell completion is only for the existing client named exactly `Test`.
7. Deploy the reviewed Worker/image through lane A workflow. Confirm the actual `workers.dev` URL, `/health`, image commit and database identity against the rehearsal database. Keep the final Neon restore target EMPTY: do not boot the app against it before restore because initialization may seed it.
8. Attach the `app.pbjsatime.com` custom domain to the Worker in the account owning the zone. Cloudflare provisions its DNS/certificate; check HTTPS and `/health`. `APP_PUBLIC_URL=https://app.pbjsatime.com` is a plain `vars` entry in `wrangler.jsonc` and already reaches the Container; it is not uploaded. Once the domain works, set `workers_dev` to `false` there (not before) and optionally declare the domain under `routes` with `custom_domain: true`.
9. Register the new Stripe `/api/stripe/webhook`, Resend `/api/resend/webhook` (confirm the actual route in the merged server), and SignWell `/api/signwell/webhook` endpoints in test mode where supported. Match each endpoint to its own signing secret. Leave live routing decisions for the frozen cutover window.
10. Confirm nightly R2 backups, bucket retention lock, credentials scoped to that bucket, and an isolated restore drill per [database backup and restore](db-backup-and-restore.md). Establish the old database access path with lane B: the removed Railway public proxy is unavailable; use the approved tunnel/private export route. Do not invent or reopen a public proxy as part of this lane.

## 2. Upload secrets

From the repository root, review names first:

```powershell
node scripts/cf/secrets-upload.mjs --dry-run
node scripts/cf/secrets-upload.mjs "D:\PBJ Accounting Work\secrets\rotation-2026-10-21.env" --dry-run --generate
```

The uploader sends exactly the container's environment names (`cloudflare/env-names.js`) minus the three plain `vars` in `wrangler.jsonc` (`NODE_ENV`, `APP_PUBLIC_URL`, `FIRM_TIME_ZONE`). That includes the addresses, the ElevenLabs agent id and the switches (`MAINTENANCE_MODE`, `AUTOPAY_CHARGING`, `INVOICE_AUTO_REMINDERS`, ...), because the repo is public. **When `DATABASE_URL` is present and `MAINTENANCE_MODE` is blank the uploader refuses** (exit 1, names only) unless `--allow-live` is passed: a database holding real data must be uploaded together with `MAINTENANCE_MODE=1`. `--dry-run` makes no network call and changes no file. With `--generate`, it reports the names that would be filled. An authorized real run with `--generate` saves fresh 64-hex values for blank `JWT_SECRET`, `VOICE_TOOL_SECRET`, and `TICK_TOKEN` before uploading. Existing nonblank values remain unchanged, including on a retry after failure. Existing files retain their Windows ACLs; Node file modes do not establish Windows ACL protection.

```powershell
node scripts/cf/secrets-upload.mjs "D:\PBJ Accounting Work\secrets\rotation-2026-10-21.env" --generate
```

The uploader uses `npx --no-install wrangler secret bulk --name pbjbillingapp`, sends a JSON object on stdin, and does not pass a FILE argument. [Wrangler secret bulk](https://developers.cloudflare.com/workers/wrangler/commands/workers/#secret-bulk) documents stdin when FILE is omitted and `--name` for the target Worker. Only allow-listed nonblank entries are uploaded; omitted/blank names are NOT deleted remotely. Output contains names only; child output is suppressed on failure. Authentication must already be provisioned for the correct account. A real secret upload changes the deployed Worker, so treat it as a production action after cutover.

A Worker secret update does not reach an already-running Container: it reads its environment only at start. After every upload run `node scripts/cf/restart.mjs` (it needs `TICK_TOKEN` uploaded first; it prints the HTTP status, waits for `/health`, and prints `commit` and `maintenance`), then verify the database identity privately. The first deploy has no secrets and runs on seeded demo data; see "First-deploy checklist" in `docs/cloudflare.md` for the order: merge, check `/health` on workers.dev, upload with `MAINTENANCE_MODE=1`, restart, confirm `maintenance: true`, attach the domain.

The SignWell registration script now reads the local ops environment. Its historical output still says "Railway service" and prints the app webhook ID, as required by the existing output contract/tests. Treat that ID as a secret: run only in a private, unrecorded terminal, put it in the rotation file as `SIGNWELL_WEBHOOK_ID`, and upload it to the Worker. Never copy that output into a PR or chat. Rewording that output and its tests is a follow-up outside this lane.

## 3. Freeze writes and move the final data

1. Announce the maintenance window and new URL to staff. Have everyone stop timers, save edits, and close old tabs. Record the source commit, intended target commit and cutover time without credentials.
2. Set `MAINTENANCE_MODE=1` on the Railway service through the authorized operator. VERIFY it actually blocks mutating requests, provider webhooks, and all background jobs. The old deployed image may predate the flag; merely setting it is not a freeze. If it cannot enforce maintenance, stop the old application service and its jobs while leaving Postgres accessible for the dump. Stop other writers too. Require lane A to confirm equivalent maintenance/job behavior on the new side before proceeding.
3. Keep the new app and cron jobs frozen as well. Account for in-flight Stripe/Resend/SignWell deliveries and retry queues. A maintenance gate must return a retryable failure rather than acknowledge and discard an event. Record provider delivery status for later replay checks. There must never be two active writers on independent database copies.
4. In the private operator process, load `SOURCE_DATABASE_URL` (approved old DB access path) and `TARGET_DATABASE_URL` (unpooled Neon URL). Lane B tools read these from process environment, not `prod.env`. Validate hosts privately. Use PostgreSQL 18 clients. Run the final dump only after the freeze is proven:

```powershell
node scripts/migrate/dump.mjs --out "D:\PBJ Accounting Work\secrets\dumps"
if ($LASTEXITCODE -ne 0) { throw "Dump failed; stop cutover" }
```

5. Record the dump path that the command reports. It uses `pg_dump -Fc` without owner/privilege restoration. Keep the artifact outside Git. Restore to the empty target; do not use `--force` to bypass unexpected contents:

```powershell
node scripts/migrate/restore.mjs --file "<absolute dump path>"
if ($LASTEXITCODE -ne 0) { throw "Restore failed; stop cutover" }
node scripts/migrate/verify.mjs
if ($LASTEXITCODE -ne 0) { throw "Database comparison failed; stop cutover" }
node scripts/migrate/boot-check.mjs
if ($LASTEXITCODE -ne 0) { throw "Boot check failed or changed data; stop cutover" }
node scripts/migrate/verify.mjs --allow-missing signature_requests,signature_documents,signwell_events
if ($LASTEXITCODE -ne 0) { throw "Post-boot comparison failed; stop cutover" }
```

The verifier compares per-table counts, timestamps and primary-key hashes for its largest tables. Allow those three absent SignWell tables only after confirming the source predates their approved DDL and target tables are empty. Do not expand exceptions to silence mismatches. Boot-check executes real initialization DDL and can perform guarded data changes; its nonzero result requires investigation, not a retry or acceptance. Stop on any failed exit code.

6. With both sides still frozen, privately update rotation-file `DATABASE_URL` and ops-file `PROD_DATABASE_URL` to the verified target. Clear old process overrides. Upload the secrets (with `MAINTENANCE_MODE=1` in the same upload), run `node scripts/cf/restart.mjs`, and privately verify that the running app uses the target. Keep automatic reminders off.
7. Move the LIVE provider endpoints to the new URL and install their matching signing secrets. Check Stripe events/subscriptions listed in the existing handoff, Resend delivery verification, and the SignWell webhook ID. Disable old endpoint deliveries once the new endpoint is ready, retaining their delivery logs. Replay pending events only through the approved provider recovery procedure; verify idempotency and resulting invoice/signature state. Never test a live payment.
8. Authorize enabling the new app only. Flip its maintenance control off (upload `MAINTENANCE_MODE=0` with `--allow-live`, then `node scripts/cf/restart.mjs`) and confirm the old app remains frozen/stopped. The first login or webhook can write; from this point the old database is stale and the simple rollback below no longer applies.

## 4. Smoke test and address changes

- Confirm HTTPS `/health` is 200, `ok` is true, and `commit` equals the released seven-character SHA. Inspect Cloudflare Container startup logs as well as Worker logs; a successful workflow alone proves neither.
- Sign in with an authorized staff account and existing TOTP. Open one known client and compare relevant data. Preview/download an existing invoice PDF without sending or changing it.
- Run the reminder preview with `INVOICE_AUTO_REMINDERS=preview` only through the reviewed lane A job control; verify no email or ledger mutation occurs and inspect the intended recipients. Restore `off` after preview. Enabling automatic sends is a separate explicit production decision.
- Verify login/logout and a second authorized staff role, the new origin/cookies, and previously issued client links. Test payment/signature flows only with test credentials/data. Track live delivery checks separately from local tests.
- Have the `pbjsa.com` zone owner configure `app.pbjsa.com` to redirect browser GET/HEAD navigation to `https://app.pbjsatime.com`, preserving path and query. Signed old client links depend on both. Do not rely on redirects for webhook POSTs: providers must be registered to the new URL directly. Block obsolete API writes instead of redirecting old tabs into a new backend.
- Update staff bookmarks and the desktop shell app URL through its own release lane. Re-provision ElevenLabs at the released commit using `node scripts/prod/voice-provision.mjs`; the local file must hold the new `APP_PUBLIC_URL`, matching `VOICE_TOOL_SECRET`, API key and agent ID. Confirm the resulting voice tools target the new host.

## 5. Rollback boundary

Before ANY new-side writes: freeze/stop the new app and jobs, retain its logs, and restore the old app as the sole writer with matching provider routes. If using the Worker against the old database, point `DATABASE_URL` back only if a secure verified-TLS route from the Container to that database exists. The old Railway private hostname and removed public proxy are not a usable rollback route. Otherwise reopen the retained old application, revert browser routing, and leave the new endpoint frozen.

After ANY new-side writes: stop both sides first. A bare URL switch loses every new Neon write since the dump, including time entries, edits, invoice/payment events, signatures, sessions and tracker changes. Provider payments and emails already made cannot be undone by restoring a database. Take protected backups of both, reconcile newer rows and external event state with Alex, and approve a reverse migration or recovery plan before reopening either side. No destructive overwrite or blind replay.

Retain Railway application/project and the source snapshot for at least 48 hours, frozen after cutover. Retention is not permission to leave compromised provider credentials active or to run both schedulers.

## 6. Finish and normal shipping

Privately verify each rotated provider key is in use, then revoke the old keys, delete obsolete Railway variables, and rotate database access as authorized. Coordinate any retained rollback credentials explicitly. Do not remove the only working TOTP decryption key without a tested re-encryption recovery plan.

Confirm two successful nightly backups and an isolated restore drill with the R2 retention lock before closing the Railway project. Keep cutover evidence: hashes, times, counts, boot results, provider event/replay checks, smoke checks and backup/restore results. Do not include credentials or customer records in the PR.

For subsequent authorized releases from clean primary `main`:

```bash
npm run verify && bash scripts/prod/ship.sh <commit>
```

The ship script checks clean tracked files, ancestry, the production quiet check, fast-forward and push exit codes; waits for that commit's `cf-deploy.yml` push run with `gh run watch --exit-status`; then polls the new `/health` up to 40 times at 15-second intervals. Each HTTP request is bounded. A matching SHA with `ok=false` is not success. It samples Wrangler JSON tail for 10 seconds only with token authentication, otherwise reports why tail was skipped. The tail is a live Worker stream, not a retrospective Container boot log; inspect Container logs separately.

JavaScript and Markdown retain CRLF. ship.sh uses LF because Bash treats CRLF carriage returns as command/variable characters; its execution tests run the actual file.

The Node ops tests under `scripts/` run with `node --test` (`npm run test:scripts`), which `npm run test` and therefore `npm run verify` now include. `.railway/` is removed. No Railway-only workflow existed at this lane's base; workflows remain owned by A/B. Historical HANDOFF sections 0, 2, 3, 5 and later, plus `CLAUDE.md`, retain their prior Railway text because they are outside lane C ownership; this runbook and updated AGENTS instructions govern the new shipping path.
