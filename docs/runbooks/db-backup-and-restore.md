# Database backup and restore

Tier 1, step 2.3 of [`docs/plans/resilience-2026-09.md`](../plans/resilience-2026-09.md):
"a backup that has never been restored is a hope, not a backup." This is the
nightly `pg_dump` -> Cloudflare R2 pipeline, how to pull a dump back out, and
(last section) how the database moves from Railway to Neon.

## What runs when

`.github/workflows/db-backup.yml`:

- **Every run starts by checking its five secrets** and fails, with one red
  annotation per missing secret and a note in the run summary, before anything
  is installed or dumped. A red night therefore always says why.
- **Nightly at 08:15 UTC** (quiet hours, US-Eastern) - dumps the database named
  by `BACKUP_DATABASE_URL`, uploads to R2, confirms the object is there
  (`head-object`, size must match), prunes old dumps.
- **On the 1st of the month** - the nightly run also copies the dump into
  `monthly/`, and additionally runs the **restore drill**: it downloads that
  night's dump back out of R2 (never as a GitHub artifact - this repository is
  public), restores it into a throwaway Postgres and checks it's actually
  usable.
- **`workflow_dispatch`** (Actions tab -> "db-backup" -> "Run workflow") - runs
  a backup on demand. Check "Also run the restore drill" to force the drill
  outside its monthly schedule (e.g. right after setting the secrets up, to
  prove the whole pipeline works before trusting it).

### Why it was red every night until now

Every scheduled run since the workflow was added (48 of 48, 2026-09-04 onward)
failed in about 14 seconds on `R2_ACCOUNT_ID is required`: the four `R2_*`
secrets were never created. The old `DATABASE_PUBLIC_URL` secret did exist, but
it names Railway's public proxy, which was removed on 2026-10-21. The workflow
now reads `BACKUP_DATABASE_URL` instead; until that secret and the four R2
secrets exist the job is **supposed** to be red, and says which secret is
missing.

## Where the dumps live

R2 bucket `${R2_BUCKET}` (name is a secret; ask Alex or check the repo's
Actions secrets for the value):

- `daily/pbj-<YYYY-MM-DD>T<HHMM>Z.dump` - every night, pruned after **30 days**.
- `monthly/pbj-<YYYY-MM-DD>T<HHMM>Z.dump` - the 1st-of-month dump only, pruned
  after **12 months**.

The date is in every key. Format is `pg_dump --format=custom --no-owner
--no-privileges` - restore with `pg_restore`, not `psql`. A dump under 100 KB
is treated as a truncated backup and the workflow fails the job instead of
uploading it.

## Repo secrets (values only in GitHub Actions, never in the repo)

Set at **repo Settings -> Secrets and variables -> Actions -> New repository
secret**:

| Secret | What it is |
| --- | --- |
| `BACKUP_DATABASE_URL` | Connection string of the database to back up. After the move: the Neon **direct** (non-pooled) URL. End it with `?sslmode=verify-full&sslrootcert=system` so the runner checks the certificate (needs the PG 16+ client the workflow installs; plain `sslmode=require` also works but only encrypts). Until the move this may stay unset - the job will say so. |
| `R2_ACCOUNT_ID` | Cloudflare account id (dashboard -> R2 -> Overview, right-hand side). Builds the endpoint `https://<id>.r2.cloudflarestorage.com`. |
| `R2_ACCESS_KEY_ID` | R2 API token access key id (R2 -> Manage API Tokens -> Create API Token; scope it to Object Read & Write on the one bucket, not account-wide). |
| `R2_SECRET_ACCESS_KEY` | The matching secret for that token. Shown once at creation - save it then. |
| `R2_BUCKET` | Name of the R2 bucket the dumps go in. Create it first (R2 -> Create bucket) if it doesn't exist. |

The old `DATABASE_PUBLIC_URL` secret is no longer read by this workflow; delete
it once the Railway database is gone.

### The bucket lock (set once, in the Cloudflare dashboard)

A backup that a stolen token or a bad script can delete is a weaker backup.
After creating the bucket: **R2 -> the bucket -> Settings -> Bucket lock rules
-> Add rule**, prefix empty (the whole bucket), condition **Age**, **30 days**.
Locked objects cannot be deleted or overwritten by anyone, the API token
included, until they are 30 days old. The nightly prune only deletes dumps
older than 30 days, so it never fights the lock (a delete it does attempt on a
locked object becomes a warning, not a failed night). Optionally add a second
rule for prefix `monthly/` with 365 days. Dashboard wording shifts over time;
Cloudflare's page is
<https://developers.cloudflare.com/r2/buckets/bucket-locks/>. This cannot be
done from the repo - it is the one step only the account owner can take.

### `PG_MAJOR`

`.github/workflows/db-backup.yml` pins `env.PG_MAJOR` at the top (currently
`18`: Railway was **PostgreSQL 18.6** on 2026-09-03 and Neon is created as 18).
`pg_dump` must be the same major or newer than the server, so if the provider
upgrades Postgres, bump this one line. Both the client-install step and the
restore drill's throwaway `services:` container read the same variable.

## How to know it's working

1. **Actions tab -> db-backup** - the `backup` job should be green nightly.
   On the 1st of the month, `restore-drill` should also run and be green;
   its log prints a row-count table for `clients, users, time_entries,
   checklists, invoices, feature_requests` - that table IS the evidence the
   backup is restorable, not just that a file exists. The backup step's log
   ends with `Confirmed in R2: daily/pbj-<date>.dump (<n> bytes)`.
2. **That a given night's object exists** - in the Cloudflare dashboard (R2 ->
   bucket -> `daily/`) or with the AWS CLI (any machine with the R2 token):
   ```bash
   export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_DEFAULT_REGION=auto
   EP="https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"
   aws s3 ls "s3://$R2_BUCKET/daily/" --endpoint-url "$EP" | tail -3
   # one specific night (the date is in the key):
   aws s3api head-object --bucket "$R2_BUCKET" --key "daily/pbj-2026-10-23T0815Z.dump" --endpoint-url "$EP"
   ```
   There should be a dump from within the last day, growing roughly in step
   with the database (a dump that stops growing while the app keeps getting
   used is worth investigating before it's needed).
3. **A red run** - open the run; the first annotations name any missing
   secret. Otherwise the job's log says: dump-too-small, size mismatch in R2
   and restore row-count failures all print `::error::` with the reason.

## Restoring (manual - this is deliberately NOT automated)

**STOP THE APP FIRST.** A restore replaces data underneath a running app,
which will read half-restored tables and can write over rows the restore is
still placing. Stop (or scale to zero) the app before touching the database.
Don't skip this for a "quick" restore - the app has in-memory state (SSE, rate
limiter) that will happily keep serving requests against a database that's
changing out from under it.

Prefer restoring into a **new, empty database** (a fresh Neon branch or
database) and repointing the app, over overwriting the live one:

1. Get the dump (from R2, or a local copy):
   ```bash
   aws s3 cp "s3://$R2_BUCKET/daily/<dump-name>.dump" ./restore.dump \
     --endpoint-url "https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"
   ```
2. Restore with the migration tool, which refuses a database that already has
   tables (see "Moving from Railway to Neon" below for the variables):
   ```powershell
   $env:TARGET_DATABASE_URL = (Get-Content 'D:\PBJ Accounting Work\secrets\new-db.url' -Raw).Trim()
   node scripts/migrate/restore.mjs --file .\restore.dump
   ```
3. Spot-check before restarting the app: `node scripts/migrate/boot-check.mjs`,
   then row counts on the six tables the restore drill checks, plus whatever
   prompted the restore specifically.
4. Point the app's `DATABASE_URL` at it, restart, health-check
   (`docs/HANDOFF.md` section 3) before calling it done.

To overwrite a database in place instead, the older shape still works (this
**overwrites the target** - double-check which database the URL names):
```bash
pg_restore --clean --if-exists --no-owner --no-privileges \
  --dbname="$DATABASE_URL" ./restore.dump
```
The automated drill uses the same `pg_restore` flags without `--clean`
(`scripts/db-restore-drill.sh`), because it restores into an empty throwaway.

## Moving from Railway to Neon

Tooling: `scripts/migrate/` (`dump.mjs`, `restore.mjs`, `verify.mjs`,
`boot-check.mjs`). Each reads database URLs from **environment variables**
(never argv, never printed; error text is scrubbed of them), uses the local
PostgreSQL 18 tools (`PG_BIN` overrides the folder; default
`C:\Program Files\PostgreSQL\18\bin` on Windows, PATH elsewhere), and exits
non-zero on any failure.

**Design decisions, so they aren't re-argued:**

- *What is dumped:* schema **and** data (`pg_dump -Fc --no-owner --no-privileges
  --no-comments`). The app's boot DDL (`initialize()` in `db/store.js`) then
  finds everything already there and is a no-op for data; it only adds objects
  newer than the dump (e.g. the `signature_*` tables if the dump predates them).
  `initialize()` cannot build the schema from an empty database (it assumes the
  base tables exist), so restore always comes first.
- *Extensions:* the app uses none (no `create extension` anywhere in
  `db/store.js` or `db/schema.sql`), so there is nothing to enable on Neon.
- *Connection secrecy:* pg_dump / pg_restore receive the connection through
  libpq environment variables (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`,
  `PGDATABASE`, `PGSSLMODE`, `PGCHANNELBINDING`); the only database-ish thing in
  argv is the bare database name after `-d`. Neon's URL carries
  `channel_binding=require`: leave it in the URL, the tools forward it.
- *URLs live in files, not in your hands:* put each URL in a one-line file in
  the secrets folder and load it into the session, so it is never typed (a typed
  literal lands in PSReadLine history):
  ```powershell
  $env:SOURCE_DATABASE_URL = (Get-Content 'D:\PBJ Accounting Work\secrets\railway-source.url' -Raw).Trim()
  $env:TARGET_DATABASE_URL = (Get-Content 'D:\PBJ Accounting Work\secrets\neon-target.url' -Raw).Trim()
  ```
- *Direct connections only:* the Neon URL must be the **direct** string, not the
  `-pooler` one. `restore`, `boot-check` and `verify` refuse a `-pooler` host.
- *TLS:* the app's pool (`db/pool-options.js`) turns on certificate-verified
  TLS for `sslmode=require|verify-ca|verify-full` in `DATABASE_URL` (or
  `PGSSLMODE`); Railway's internal URL has no `sslmode` and stays plain. The
  app's `DATABASE_URL` is **the plain Neon URL, exactly as Neon shows it**
  (`sslmode=require` is fine: the pool verifies anyway). Only
  `BACKUP_DATABASE_URL` (the GitHub secret, read by libpq on the runner) carries
  `&sslrootcert=system`; the pool also ignores that parameter if it ever sees
  it. The command-line tools use libpq: on Windows leave Neon's default
  `sslmode=require` for them (libpq there has no root-certificate file for
  `verify-full`).
- *Where the dump lives:* `D:\PBJ Accounting Work\secrets\dumps\backups\`. It is
  a full copy of production data: the folder must **not** be inside a
  cloud-synced folder (OneDrive, Dropbox, Google Drive, iCloud: `dump.mjs`
  refuses those paths) and must not be in the git repository (also refused).
  **Delete the dump** once the Railway database is retired and two nightly
  backups exist in R2.
- *A dump is only named `.dump` when whole:* `pg_dump` writes
  `railway-<stamp>.dump.partial`; the file is renamed only after `pg_dump`
  exited 0 and `pg_restore --list` read it back.

**The operator's steps.** Nothing here is automated; each script stops on the
first problem. Order matters: dump, restore, verify, boot-check, verify again,
cut over.

1. **Neon:** create the project (Postgres 18, AWS us-east-1) and copy the
   **direct** connection string (pooling off) into
   `secrets\neon-target.url`. Write the Railway Postgres connection string
   (host `localhost`, the tunnel's port, step 3) into `secrets\railway-source.url`.
2. **Freeze writes - hard-stop the app.** The running production build
   (`dba630af`) has no maintenance mode, and Railway cannot currently build a
   new one, so the freeze is a stop, not a flag: in the Railway dashboard open
   the **app** service (not Postgres) -> Deployments -> the active deployment ->
   **Remove** (or set the replica count to 0). Then **confirm** it is down:
   `/health` must fail (connection error or non-200). Leave the **Postgres**
   service running; it is the dump source. While the app is down, Stripe,
   Resend and SignWell keep retrying their webhooks and will deliver after the
   app is back; check each dashboard's failed-deliveries list afterwards. Once
   a build that has maintenance mode is live, setting `MAINTENANCE_MODE=1` is
   the gentler freeze and can replace this step.
3. **Tunnel** (second terminal): `railway connect Postgres --tunnel-only`; note
   the `localhost:<port>` it prints and put it in `railway-source.url`.
4. **Dump** (first terminal, PowerShell):
   ```powershell
   $env:SOURCE_DATABASE_URL = (Get-Content 'D:\PBJ Accounting Work\secrets\railway-source.url' -Raw).Trim()
   node scripts/migrate/dump.mjs
   ```
   Writes `D:\PBJ Accounting Work\secrets\dumps\backups\railway-<stamp>.dump`
   (`--out` changes the folder), prints size, duration and the pg_dump exit
   code, and re-reads the archive's table of contents. Exit 0 means a readable
   dump.
5. **Restore:**
   ```powershell
   $env:TARGET_DATABASE_URL = (Get-Content 'D:\PBJ Accounting Work\secrets\neon-target.url' -Raw).Trim()
   node scripts/migrate/restore.mjs --file 'D:\PBJ Accounting Work\secrets\dumps\backups\railway-<stamp>.dump'
   ```
   Refuses unless the target has **no user relations** (tables, partitioned
   tables, sequences, views, materialized views outside the system and Neon
   schemas); `--force` skips only that check, never the "target is not the
   source" check. On failure, drop and recreate the Neon database before
   retrying - `--exit-on-error` stops half way.
6. **Verify, first pass - no allowances:**
   ```powershell
   node scripts/migrate/verify.mjs
   ```
   Compares every `public` table: row count, newest `updated_at` /
   `created_at`, and a **full-row hash of every table** (md5 over each row's
   text form, ordered by primary key as text in the `"C"` collation; a table
   with no primary key is ordered by its row hashes, so it is still compared
   by full rows), with `timezone=UTC`, `datestyle=ISO`, `extra_float_digits=3`
   and `bytea_output=hex` pinned in both sessions. The 12 largest tables also
   get a sha256 over their primary keys. Exit 0 required: this is the
   authoritative "the data is the same" check, so run it before anything has
   touched the new database.
7. **Boot check:** `node scripts/migrate/boot-check.mjs`. Runs the app's own
   `initialize()` against Neon so the DDL (and any new tables) lands before the
   first deploy. Exit 0 = clean; 1 = a DDL error (printed); 3 = it changed rows
   in an existing table (printed - read it before going on); warnings that
   `initialize()` logged are printed too. It never calls
   `applyOwnerBootstrapPassword()` (that is a `server.js` startup step, not part
   of `initialize()`), and it refuses an empty database, a `-pooler` host and
   anything that looks like Railway.
8. **Verify, second pass - allow the new tables:**
   ```powershell
   node scripts/migrate/verify.mjs --allow-missing signature_documents,signature_requests,signwell_events
   ```
   A table in `--allow-missing` may be absent on one side (a dump that predates
   the e-signature feature shows up as: absent on the source, present and empty
   on the target after step 7) but must hold 0 rows there. If the boot DDL
   added columns to a table, that table's full-row hash is skipped with a note
   (a column the target *lacks* is a mismatch).
9. **Cut over:** set the app's `DATABASE_URL` to the plain Neon URL, deploy (or
   redeploy the removed deployment with the new variable), check `/health`, set
   the `BACKUP_DATABASE_URL` repo secret to the same URL **plus
   `&sslrootcert=system`**, and run the db-backup workflow once with "Also run
   the restore drill" ticked. Note the moment of the first write on Neon (the
   first login or save): it is the decision point for the rollback below.
10. **Keep the Railway database, untouched,** until two nightly backups have
    landed in R2 and been listed (see "How to know it's working"). Then retire
    Railway, and delete the local dump.

## Rollback

Railway's public proxy is gone, so a rolled-back app must run **on Railway
itself** (its internal `DATABASE_URL`), not from a laptop.

- **Before the first write on Neon** (nobody has logged in or saved since
  cut-over): point the app's `DATABASE_URL` back at Railway's internal Postgres
  URL and restart the app. Nothing is lost: the Railway database was only ever
  read from, and it is untouched.
- **After writes on Neon:** switching back to Railway would silently drop every
  write made on Neon since cut-over (time entries, invoices, payments - Stripe
  would still hold the charges). Do not just flip the variable. Instead:
  1. stop the app (same hard stop as step 2);
  2. dump Neon (`SOURCE_DATABASE_URL` = the Neon URL);
  3. restore that dump into a **fresh, empty** Railway database (a new Postgres
     service or a recreated database; `TARGET_DATABASE_URL` = that URL - run
     the tools from inside Railway or over a new tunnel), i.e. the same scripts
     with source and target swapped;
  4. `verify.mjs`, then `boot-check.mjs` on it;
  5. point the app's `DATABASE_URL` at it and restart.
  Never restore over the original Railway database: until the decision point it
  is the only untouched copy of the pre-migration data.
- Keep the original Railway database exactly as it was (no restores into it, no
  schema changes, no deletion) until the point in step 10, however the
  migration goes.

## What is verified vs. what still needs the secrets to exist

Verified without secrets or production access: the migration scripts and the
pool's TLS options (unit tests, plus a full dump -> restore -> verify run
against a throwaway local PostgreSQL 18.6 cluster, including a full-row
mismatch on a table with no primary key); `bash -n` on
both backup scripts; `scripts/db-backup.sh` end to end against stub `pg_dump`
and `aws` programs (missing-secret failure, happy path, upload confirmation).

**Not verified - cannot be, until the owner adds the five secrets above**:

- That `BACKUP_DATABASE_URL` actually connects from a GitHub-hosted runner
  (network reachability, and that `sslmode=verify-full&sslrootcert=system`
  works against Neon from the runner's CA store).
- That the R2 credentials and bucket are scoped correctly and the
  `--endpoint-url` construction (`https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`)
  matches the account's actual endpoint, and that `head-object` is permitted
  for the token.
- The retention pruning against a real bucket with objects in it and the
  bucket lock in force.
- The full restore drill end to end, including its download of the dump from R2
  (GitHub's `services:` containers, the `postgresql-client` apt-repo install
  and R2 can't be exercised locally).

**First run after adding secrets**: trigger `workflow_dispatch` with "Also
run the restore drill" checked, and read the log all the way through rather
than trusting the green checkmark alone.
