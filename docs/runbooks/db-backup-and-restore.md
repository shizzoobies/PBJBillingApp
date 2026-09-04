# Database backup and restore

Tier 1, step 2.3 of [`docs/plans/resilience-2026-09.md`](../plans/resilience-2026-09.md):
"a backup that has never been restored is a hope, not a backup." This is the
nightly `pg_dump` → Cloudflare R2 pipeline and how to pull a dump back out.

## What runs when

`.github/workflows/db-backup.yml`:

- **Nightly at 08:15 UTC** (quiet hours, US-Eastern) — dumps production
  Postgres, uploads to R2, prunes old dumps.
- **On the 1st of the month** — the nightly run above also copies the dump
  into `monthly/`, and additionally runs the **restore drill**: restores the
  dump into a throwaway Postgres and checks it's actually usable.
- **`workflow_dispatch`** (Actions tab → "db-backup" → "Run workflow") — runs
  a backup on demand. Check "Also run the restore drill" to force the drill
  outside its monthly schedule (e.g. right after setting the secrets up, to
  prove the whole pipeline works before trusting it).

## Where the dumps live

R2 bucket `${R2_BUCKET}` (name is a secret; ask Alex or check the repo's
Actions secrets for the value):

- `daily/pbj-<YYYY-MM-DD>T<HHMM>Z.dump` — every night, kept **30 days**.
- `monthly/pbj-<YYYY-MM-DD>T<HHMM>Z.dump` — the 1st-of-month dump only, kept
  **12 months**.

Format is `pg_dump --format=custom --no-owner --no-privileges` — restore
with `pg_restore`, not `psql`. A dump under 100 KB is treated as a truncated
backup and the workflow fails the job instead of uploading it.

## Owner-provided secrets (values only in GitHub Actions, never in the repo)

Set at **repo Settings → Secrets and variables → Actions → New repository
secret**:

| Secret | What it is |
| --- | --- |
| `DATABASE_PUBLIC_URL` | Railway Postgres **public** connection string (Railway dashboard → Postgres service → Connect → Public Network). Not the internal `DATABASE_URL` the app itself uses — that one isn't reachable from GitHub's runners. |
| `R2_ACCOUNT_ID` | Cloudflare account id (dashboard → R2 → Overview, right-hand side). Builds the endpoint `https://<id>.r2.cloudflarestorage.com`. |
| `R2_ACCESS_KEY_ID` | R2 API token access key id (R2 → Manage API Tokens → Create API Token; scope it to Object Read & Write on the one bucket, not account-wide). |
| `R2_SECRET_ACCESS_KEY` | The matching secret for that token. Shown once at creation — save it then. |
| `R2_BUCKET` | Name of the R2 bucket the dumps go in. Create it first (R2 → Create bucket) if it doesn't exist. |

Also confirm in the Railway dashboard whether **Postgres volume backups**
are enabled and note their retention — that's a paid Railway feature and is
a second line of defense, not a substitute for this pipeline (it can't be
restored anywhere but Railway, and doesn't get drilled).

### `PG_MAJOR`

`.github/workflows/db-backup.yml` pins `env.PG_MAJOR` at the top (currently
`18` — production was **PostgreSQL 18.6** on 2026-09-03, checked with a
read-only `select version()` via the diagnostics pattern in
`docs/HANDOFF.md` §4). `pg_dump` must be the same major or newer than the
server, so if Railway upgrades Postgres, bump this one line. Both the
client-install step and the restore drill's throwaway `services:`
container read the same variable, so fixing it in one place fixes both.

## How to know it's working

1. **Actions tab → db-backup** — the `backup` job should be green nightly.
   On the 1st of the month, `restore-drill` should also run and be green;
   its log prints a row-count table for `clients, users, time_entries,
   checklists, invoices, feature_requests` — that table IS the evidence the
   backup is restorable, not just that a file exists.
2. **Object listing** — in the Cloudflare dashboard (R2 → bucket →
   `daily/`/`monthly/`) or via the AWS CLI:
   ```bash
   aws s3 ls "s3://$R2_BUCKET/daily/" --endpoint-url "https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"
   ```
   should show a dump from within the last day, growing roughly in step
   with the database (a dump that stops growing while the app keeps getting
   used is worth investigating before it's needed).

A run that goes red: check the job's log first (dump-too-small and restore
row-count failures both print `::error::` with the reason) before assuming
it's a secrets problem.

## Restoring to Railway (manual — this is deliberately NOT automated)

**STOP THE APP FIRST.** A restore replaces data underneath a running app,
which will read half-restored tables and can write over rows the restore is
still placing. In the Railway dashboard, stop (or scale to zero) the
`PBJBillingApp` service before touching the database. Don't skip this for
a "quick" restore — the app has in-memory state (SSE, rate limiter) that
will happily keep serving requests against a database that's changing out
from under it.

1. Get the dump (from R2, or a local copy):
   ```bash
   aws s3 cp "s3://$R2_BUCKET/daily/<dump-name>.dump" ./restore.dump \
     --endpoint-url "https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"
   ```
2. Get `DATABASE_PUBLIC_URL` (Railway dashboard, or via `npx @railway/cli@latest
   variables --service Postgres --json`, per `docs/HANDOFF.md` §4).
3. Restore. `--clean --if-exists` drops existing objects before recreating
   them, so this **overwrites the target database** — double-check
   `DATABASE_PUBLIC_URL` points at the database you mean to replace:
   ```bash
   PGSSLMODE=require pg_restore --clean --if-exists --no-owner --no-privileges \
     --dbname="$DATABASE_PUBLIC_URL" ./restore.dump
   ```
4. Spot-check before restarting the app: row counts on the six tables the
   restore drill checks, plus whatever prompted the restore specifically.
5. Restart the `PBJBillingApp` service in Railway. Health-check
   (`docs/HANDOFF.md` §3) before calling it done.

This is the same `pg_restore` shape the automated drill uses
(`scripts/db-restore-drill.sh`), minus `--clean --if-exists` (the drill
restores into an empty throwaway database, so there's nothing to clean).

## What is verified vs. what still needs the secrets to exist

Verified without secrets: `bash -n` on both scripts, a YAML parse plus the
GitHub Actions JSON-schema check on the workflow file.

**Not verified — cannot be, until the owner adds the five secrets above**:

- That `DATABASE_PUBLIC_URL` actually connects from a GitHub-hosted runner
  (network/firewall reachability, `PGSSLMODE=require` being the right
  setting for Railway's public endpoint).
- That the R2 credentials and bucket are scoped correctly and the
  `--endpoint-url` construction (`https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`)
  matches the account's actual endpoint.
- The retention pruning logic (`aws s3api list-objects-v2` + date math) has
  never run against a real bucket with objects in it.
- The full restore drill end-to-end (throwaway Postgres, `pg_restore`, row
  counts) has only been read through, not executed — GitHub's `services:`
  containers and the `postgresql-client` apt-repo install can't be
  exercised locally.

**First run after adding secrets**: trigger `workflow_dispatch` with "Also
run the restore drill" checked, and read the log all the way through rather
than trusting the green checkmark alone.
