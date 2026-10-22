#!/usr/bin/env bash
# Run only after review and a green verify, from the primary checkout on main:
# npm run verify && bash scripts/prod/ship.sh <hash> [<hash> ...]
# Each commit waits for its own cf-deploy.yml run and healthy deployed image.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
[ "$#" -gt 0 ] || { echo "usage: ship.sh <hash> [<hash> ...]"; exit 2; }
[ "$(git branch --show-current)" = "main" ] || { echo "not on main"; exit 2; }
status=$(git status --porcelain --untracked-files=no)
[ -z "$status" ] || { echo "working tree not clean"; exit 2; }
for tool in node gh curl; do
  command -v "$tool" >/dev/null || { echo "missing command: $tool"; exit 2; }
done
for h in "$@"; do
  sha=$(git rev-parse --verify "$h^{commit}")
  echo "=== shipping $sha"
  git fetch -q origin || { echo "fetch failed"; exit 1; }
  local_main=$(git rev-parse refs/heads/main)
  remote_main=$(git rev-parse refs/remotes/origin/main)
  if [ "$local_main" = "$remote_main" ]; then
    git merge-base --is-ancestor "$local_main" "$sha" || { echo "$h does not descend from main - stopping"; exit 1; }
  elif [ "$sha" = "$local_main" ] && git merge-base --is-ancestor "$remote_main" "$local_main"; then
    echo "shipping local main (ahead of origin by $(git rev-list --count "$remote_main..$local_main") commit(s))"
  else
    echo "main and origin/main differ and $h is not local main - stopping"; exit 1
  fi
  node scripts/prod/quiet-check.mjs || { echo "production not quiet - stopping"; exit 1; }
  if [ "$sha" != "$local_main" ]; then
    git merge --ff-only "$sha" || { echo "fast-forward failed"; exit 1; }
  fi
  git push origin main || { echo "push failed - stopping"; exit 1; }

  # GitHub may take a few seconds to register the push event.
  run_id=""
  for ((i=1; i<=40; i++)); do
    runs=$(gh run list --workflow cf-deploy.yml --commit "$sha" --branch main --event push --limit 1 --json databaseId) ||
      { echo "could not read cf-deploy.yml runs - stopping"; exit 1; }
    run_id=$(printf '%s' "$runs" | node -e 'let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{try{const runs=JSON.parse(s);if(!Array.isArray(runs))throw Error();const id=runs[0]?.databaseId;if(id!==undefined){if(!Number.isSafeInteger(id)||id<=0)throw Error();process.stdout.write(String(id))}}catch{process.exitCode=1}})') ||
      { echo "invalid GitHub Actions response - stopping"; exit 1; }
    [ -z "$run_id" ] || break
    sleep 15
  done
  [ -n "$run_id" ] || { echo "no cf-deploy.yml push run appeared for $sha - stopping"; exit 1; }
  gh run watch "$run_id" --exit-status || { echo "Cloudflare deploy workflow failed - stopping"; exit 1; }

  # git --short=7 is a MINIMUM length, so slice the full SHA explicitly.
  short=${sha:0:7}
  ok=0
  for ((i=1; i<=40; i++)); do
    if body=$(curl --fail --silent --show-error --connect-timeout 10 --max-time 30 https://app.pbjsatime.com/health) &&
       printf '%s' "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.exitCode=j.commit===process.argv[1]&&j.ok===true?0:1}catch{process.exitCode=1}})' "$short"; then
      echo "live: $short ok=true"
      ok=1
      break
    fi
    sleep 15
  done
  [ "$ok" = 1 ] || { echo "health never showed healthy $short - stopping; inspect the Cloudflare deployment"; exit 1; }
  node scripts/cf/tail.mjs
done
echo "ALL SHIPPED"
