#!/usr/bin/env bash
# Dumps the Postgres database and uploads it to Cloudflare R2, then proves the
# object landed.
#
# Run by .github/workflows/db-backup.yml (ubuntu-latest, pg_dump already on
# PATH matching the server's major version - this script does not install
# anything). Not meant to be run outside that workflow: it assumes GNU date
# and a modern aws CLI (both preinstalled on GitHub-hosted runners).
#
# Required env (the workflow's first step checks all five and names any
# that are missing; the checks below are a second line of defense for anyone
# running the script by hand):
#   BACKUP_DATABASE_URL   Connection string of the database to back up.
#   R2_ACCOUNT_ID          Cloudflare account id (builds the R2 endpoint).
#   R2_ACCESS_KEY_ID       R2 API token access key id.
#   R2_SECRET_ACCESS_KEY   R2 API token secret.
#   R2_BUCKET              R2 bucket the dumps live in.
#
# Writes to $GITHUB_OUTPUT (when set): dump_name, dump_path.
#
# See docs/runbooks/db-backup-and-restore.md for what this feeds into.

set -euo pipefail

missing=0
for name in BACKUP_DATABASE_URL R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET; do
  if [ -z "${!name:-}" ]; then
    echo "::error title=Backup secret missing::${name} is not set - no backup was taken. See docs/runbooks/db-backup-and-restore.md." >&2
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  exit 1
fi

# Mask before anything can echo them - the database URL carries a password,
# and the R2 endpoint/keys are secrets even though the endpoint looks like
# "just a URL".
echo "::add-mask::${BACKUP_DATABASE_URL}"
# The whole URL is masked above, but pg_dump and libpq print the HOST and the
# USER on their own, and a decoded password differs from the URL-encoded one in
# the secret. Mask each piece separately so no log line can leak them.
while IFS= read -r piece; do
  if [ -n "$piece" ]; then echo "::add-mask::${piece}"; fi
done < <(node -e '
  try {
    const u = new URL(process.env.BACKUP_DATABASE_URL)
    const out = [u.hostname, u.username, u.password]
    try { out.push(decodeURIComponent(u.password)) } catch (e) { /* keep the raw one */ }
    console.log(out.filter(Boolean).join("\n"))
  } catch (e) { /* not a parseable URL: the whole-URL mask above still applies */ }
')
echo "::add-mask::${R2_ACCESS_KEY_ID}"
echo "::add-mask::${R2_SECRET_ACCESS_KEY}"
R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
echo "::add-mask::${R2_ENDPOINT}"

# aws CLI reads these; R2's S3-compatible API ignores region but requires
# something be set, and Cloudflare's own docs say "auto".
export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="auto"

# An sslmode inside BACKUP_DATABASE_URL always wins over this default. `require`
# encrypts; put ?sslmode=verify-full&sslrootcert=system on the secret to also
# have the runner check the server certificate (the runbook says how).
export PGSSLMODE="${PGSSLMODE:-require}"
# A dead host should fail in half a minute, not sit until the job times out
# (the 2026-10-19 run hung for 24 minutes before failing).
export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-30}"

STAMP="$(date -u +%Y-%m-%dT%H%MZ)"
DAY_OF_MONTH="$(date -u +%d)"
DUMP_NAME="pbj-${STAMP}.dump"
DUMP_DIR="${RUNNER_TEMP:-/tmp}/db-backup"
mkdir -p "$DUMP_DIR"
DUMP_PATH="${DUMP_DIR}/${DUMP_NAME}"

echo "Dumping the database -> ${DUMP_NAME}"
pg_dump --format=custom --no-owner --no-privileges --no-comments \
  --dbname="$BACKUP_DATABASE_URL" --file="$DUMP_PATH"

DUMP_BYTES="$(stat -c%s "$DUMP_PATH")"
MIN_BYTES=$((100 * 1024))
echo "Dump size: ${DUMP_BYTES} bytes (floor: ${MIN_BYTES})"
if [ "$DUMP_BYTES" -lt "$MIN_BYTES" ]; then
  echo "::error::Dump is only ${DUMP_BYTES} bytes - that is a truncated/failed dump, not a backup. Not uploading it." >&2
  exit 1
fi

# The date is in every key (pbj-YYYY-MM-DDTHHMMZ.dump), so a night's object is
# findable by name and sorts chronologically.
upload_and_confirm() {
  local key="$1"
  local found_bytes
  echo "Uploading to ${key}"
  aws s3 cp "$DUMP_PATH" "s3://${R2_BUCKET}/${key}" \
    --endpoint-url "$R2_ENDPOINT" --only-show-errors
  # An upload that exited 0 but is not there (wrong bucket, eventual
  # consistency, a token that can write but not read) is not a backup.
  found_bytes="$(aws s3api head-object --bucket "$R2_BUCKET" --key "$key" \
    --endpoint-url "$R2_ENDPOINT" --query ContentLength --output text)"
  if [ "$found_bytes" != "$DUMP_BYTES" ]; then
    echo "::error::${key} is ${found_bytes} bytes in R2 but the dump is ${DUMP_BYTES} bytes - the upload is not trustworthy." >&2
    exit 1
  fi
  echo "Confirmed in R2: ${key} (${found_bytes} bytes)"
}

upload_and_confirm "daily/${DUMP_NAME}"

if [ "$DAY_OF_MONTH" = "01" ]; then
  echo "First of the month -> also copying to monthly/${DUMP_NAME}"
  upload_and_confirm "monthly/${DUMP_NAME}"
fi

# Deletes objects under $1 whose LastModified is older than $2 days. A failed
# delete (for example an object still inside the bucket lock) is a warning,
# never a reason to fail a night whose backup already succeeded.
prune_prefix() {
  local prefix="$1"
  local max_age_days="$2"
  local now_epoch cutoff_epoch key last_modified obj_epoch

  now_epoch="$(date -u +%s)"
  cutoff_epoch=$((now_epoch - max_age_days * 86400))

  echo "Pruning ${prefix} older than ${max_age_days} days"
  aws s3api list-objects-v2 --bucket "$R2_BUCKET" --prefix "$prefix" \
    --endpoint-url "$R2_ENDPOINT" \
    --query 'Contents[].[Key,LastModified]' --output text |
  while IFS="$(printf '\t')" read -r key last_modified; do
    [ -z "$key" ] && continue
    [ "$key" = "None" ] && continue
    obj_epoch="$(date -u -d "$last_modified" +%s)"
    if [ "$obj_epoch" -lt "$cutoff_epoch" ]; then
      echo "  deleting ${key} (${last_modified})"
      aws s3 rm "s3://${R2_BUCKET}/${key}" --endpoint-url "$R2_ENDPOINT" --only-show-errors \
        || echo "::warning::could not delete ${key} (still inside the bucket lock?)"
    fi
  done
}

# With the 30-day bucket lock the dashboard enforces, a 30-day prune only ever
# touches objects the lock has already released.
prune_prefix "daily/" 30 || echo "::warning::pruning daily/ failed - tonight's backup is safe in R2, but old dumps were not cleaned up"
prune_prefix "monthly/" 365 || echo "::warning::pruning monthly/ failed - tonight's backup is safe in R2"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "dump_name=${DUMP_NAME}"
    echo "dump_path=${DUMP_PATH}"
  } >> "$GITHUB_OUTPUT"
fi

echo "Backup complete: ${DUMP_NAME} (${DUMP_BYTES} bytes)"
