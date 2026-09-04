#!/usr/bin/env bash
# Restores a just-made dump into a throwaway Postgres and proves it is a
# real, usable backup — not just a file that pg_dump exited 0 on.
#
# "A backup that has never been restored is a hope, not a backup"
# (docs/plans/resilience-2026-09.md §2.3). Run by the `restore-drill` job in
# .github/workflows/db-backup.yml, against that job's `services:` Postgres
# container. Not meant to be run outside that workflow.
#
# Required env:
#   DUMP_PATH   Path to the .dump file (custom-format pg_dump output).
#   PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE
#               Connection info for the throwaway Postgres to restore into.
#               Standard libpq env vars — pg_restore/psql read them directly.
#
# Exits non-zero if `invoices` or `time_entries` restore to 0 rows (or are
# missing outright) — those two tables are never legitimately empty in
# production, so an empty restore means the dump or the restore is broken,
# not that the drill "technically passed".

set -euo pipefail

: "${DUMP_PATH:?DUMP_PATH is required (path to the .dump file to restore)}"
: "${PGHOST:?PGHOST is required}"
: "${PGPORT:?PGPORT is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
: "${PGDATABASE:?PGDATABASE is required}"

if [ ! -f "$DUMP_PATH" ]; then
  echo "::error::No dump file at ${DUMP_PATH} — did the backup job run and upload the db-dump artifact?" >&2
  exit 1
fi

echo "Waiting for the throwaway Postgres to accept connections..."
READY=0
for _ in $(seq 1 30); do
  if pg_isready -q; then
    READY=1
    break
  fi
  sleep 1
done
if [ "$READY" -ne 1 ]; then
  echo "::error::Throwaway Postgres never became ready." >&2
  exit 1
fi

echo "Restoring ${DUMP_PATH} into ${PGDATABASE}@${PGHOST}:${PGPORT}"
pg_restore --no-owner --no-privileges --dbname="$PGDATABASE" --jobs=2 "$DUMP_PATH"

# The tables the plan calls "important": docs/plans/resilience-2026-09.md
# names these six explicitly for the row-count check.
TABLES="clients users time_entries checklists invoices feature_requests"

echo ""
echo "Restored row counts:"
printf '%-20s %10s\n' "table" "rows"
declare -A COUNTS
for t in $TABLES; do
  EXISTS="$(psql -Atqc "select to_regclass('public.${t}') is not null")"
  if [ "$EXISTS" != "t" ]; then
    printf '%-20s %10s\n' "$t" "MISSING"
    COUNTS["$t"]=-1
    continue
  fi
  COUNT="$(psql -Atqc "select count(*) from ${t}")"
  printf '%-20s %10s\n' "$t" "$COUNT"
  COUNTS["$t"]="$COUNT"
done
echo ""

FAIL=0
if [ "${COUNTS[invoices]:--1}" -le 0 ]; then
  echo "::error::Restore drill failed: invoices restored to ${COUNTS[invoices]:-MISSING} rows." >&2
  FAIL=1
fi
if [ "${COUNTS[time_entries]:--1}" -le 0 ]; then
  echo "::error::Restore drill failed: time_entries restored to ${COUNTS[time_entries]:-MISSING} rows." >&2
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi

echo "Restore drill passed: dump is restorable and the critical tables are populated."
