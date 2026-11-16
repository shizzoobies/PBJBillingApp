#!/usr/bin/env bash
# Delete ONE Cloudflare container application by id, but only if it is the one meant.
# In CI `wrangler containers delete` does not ask, so this reads the application back first
# and refuses unless its name is exactly the expected one. It can never delete production's
# live application, whatever it is told.
#
# Run it from a GitHub Actions step, not from the laptop: the laptop's Cloudflare token cannot
# manage container applications, and only in CI does `wrangler containers info` print plain
# JSON on stdout. Take ids from `npx wrangler containers list` in the same run, never by hand.
# Used on 2026-11-15 to delete the old pbjbillingapp-appcontainer and the staging copy
# (docs/plans/zero-downtime-deploy-2026-11.md, 12.6).
#
#   guarded-container-delete.sh <application-id> <expected-name>            delete
#   DRY=1 guarded-container-delete.sh <application-id> <expected-name>      only say what would happen
set -euo pipefail

id="${1:?application id}"
want="${2:?expected application name}"

# Production's live application (pbjbillingapp-hosts), with or without dashes.
LIVE="b06da2ce47964e7db0cb5a1e057f30bb"
if [ "$(printf '%s' "$id" | tr -d '-' | tr 'A-F' 'a-f')" = "$LIVE" ] || [ "$want" = "pbjbillingapp-hosts" ]; then
  echo "REFUSED: that is production's live application."
  exit 1
fi

info="$(npx wrangler containers info "$id")"
# The application's OWN id and name: the top-level keys of the answer, nothing nested.
read -r got_id name < <(printf '%s' "$info" | node -e '
  const answer = JSON.parse(require("fs").readFileSync(0, "utf8"))
  const clean = (value) => (typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value) ? value : "?")
  console.log(clean(answer.id) + " " + clean(answer.name))
')

if [ "$got_id" != "$id" ]; then
  echo "REFUSED: asked about $id but the answer is about '$got_id'."
  exit 1
fi
if [ "$name" != "$want" ]; then
  echo "REFUSED: $id is named '$name', expected '$want'."
  exit 1
fi

if [ "${DRY:-0}" = "1" ]; then
  echo "DRY RUN: would delete $id ($name)."
  exit 0
fi

echo "Deleting $id ($name)."
npx wrangler containers delete "$id"
