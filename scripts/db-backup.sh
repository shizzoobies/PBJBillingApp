#!/usr/bin/env bash
# Dumps the production Postgres database and uploads it to Cloudflare R2.
#
# Run by .github/workflows/db-backup.yml (ubuntu-latest, pg_dump already on
# PATH matching the production major version — this script does not install
# anything). Not meant to be run outside that workflow: it assumes GNU date
# and a modern aws CLI (both preinstalled on GitHub-hosted runners).
#
# Required env:
#   DATABASE_PUBLIC_URL   Railway Postgres PUBLIC connection string.
#   R2_ACCOUNT_ID          Cloudflare account id (builds the R2 endpoint).
#   R2_ACCESS_KEY_ID       R2 API token access key id.
#   R2_SECRET_ACCESS_KEY   R2 API token secret.
#   R2_BUCKET              R2 bucket the dumps live in.
#
# Writes to $GITHUB_OUTPUT (when set): dump_name, dump_path.
#
# See docs/runbooks/db-backup-and-restore.md for what this feeds into.

set -euo pipefail

: "${DATABASE_PUBLIC_URL:?DATABASE_PUBLIC_URL is required}"
: "${R2_ACCOUNT_ID:?R2_ACCOUNT_ID is required}"
: "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID is required}"
: "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY is required}"
: "${R2_BUCKET:?R2_BUCKET is required}"

# Mask before anything can echo them — DATABASE_PUBLIC_URL carries a
# password, and the R2 endpoint/keys are secrets even though the endpoint
# looks like "just a URL".
echo "::add-mask::${DATABASE_PUBLIC_URL}"
echo "::add-mask::${R2_ACCESS_KEY_ID}"
echo "::add-mask::${R2_SECRET_ACCESS_KEY}"
R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
echo "::add-mask::${R2_ENDPOINT}"

# aws CLI reads these; R2's S3-compatible API ignores region but requires
# something be set, and Cloudflare's own docs say "auto".
export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="auto"

# require = encrypted, but does not verify the server certificate — same
# trust level docs/HANDOFF.md §4 uses for prod diagnostics from outside
# Railway's network (`ssl: { rejectUnauthorized: false }` in node-pg terms).
export PGSSLMODE="${PGSSLMODE:-require}"

STAMP="$(date -u +%Y-%m-%dT%H%MZ)"
DAY_OF_MONTH="$(date -u +%d)"
DUMP_NAME="pbj-${STAMP}.dump"
DUMP_DIR="${RUNNER_TEMP:-/tmp}/db-backup"
mkdir -p "$DUMP_DIR"
DUMP_PATH="${DUMP_DIR}/${DUMP_NAME}"

echo "Dumping production database -> ${DUMP_NAME}"
pg_dump --format=custom --no-owner --no-privileges \
  --dbname="$DATABASE_PUBLIC_URL" --file="$DUMP_PATH"

DUMP_BYTES="$(stat -c%s "$DUMP_PATH")"
MIN_BYTES=$((100 * 1024))
echo "Dump size: ${DUMP_BYTES} bytes (floor: ${MIN_BYTES})"
if [ "$DUMP_BYTES" -lt "$MIN_BYTES" ]; then
  echo "::error::Dump is only ${DUMP_BYTES} bytes — that is a truncated/failed dump, not a backup. Not uploading it." >&2
  exit 1
fi

echo "Uploading to daily/${DUMP_NAME}"
aws s3 cp "$DUMP_PATH" "s3://${R2_BUCKET}/daily/${DUMP_NAME}" \
  --endpoint-url "$R2_ENDPOINT" --only-show-errors

if [ "$DAY_OF_MONTH" = "01" ]; then
  echo "First of the month -> also copying to monthly/${DUMP_NAME}"
  aws s3 cp "$DUMP_PATH" "s3://${R2_BUCKET}/monthly/${DUMP_NAME}" \
    --endpoint-url "$R2_ENDPOINT" --only-show-errors
fi

# Deletes objects under $1 whose LastModified is older than $2 days.
prune_prefix() {
  local prefix="$1"
  local max_age_days="$2"
  local now_epoch cutoff_epoch key last_modified obj_epoch

  now_epoch="$(date -u +%s)"
  cutoff_epoch=$((now_epoch - max_age_days * 86400))

  echo "Pruning ${prefix} older than ${max_age_days} days"
  aws s3api list-objects-v2 --bucket "$R2_BUCKET" --prefix "$prefix" \
    --endpoint-url "$R2_ENDPOINT" \
    --query 'Contents[].[Key,LastModified]' --output text 2>/dev/null |
  while IFS="$(printf '\t')" read -r key last_modified; do
    [ -z "$key" ] && continue
    [ "$key" = "None" ] && continue
    obj_epoch="$(date -u -d "$last_modified" +%s)"
    if [ "$obj_epoch" -lt "$cutoff_epoch" ]; then
      echo "  deleting ${key} (${last_modified})"
      aws s3 rm "s3://${R2_BUCKET}/${key}" --endpoint-url "$R2_ENDPOINT" --only-show-errors
    fi
  done
}

prune_prefix "daily/" 30
prune_prefix "monthly/" 365

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "dump_name=${DUMP_NAME}"
    echo "dump_path=${DUMP_PATH}"
  } >> "$GITHUB_OUTPUT"
fi

echo "Backup complete: ${DUMP_NAME} (${DUMP_BYTES} bytes)"
