#!/usr/bin/env bash
# The deploy half of the ship ritual (HANDOFF section 3), for commits that are ALREADY
# reviewed and verified. Ships the given commits to main ONE AT A TIME: production must be
# quiet (no invoice touched in 5 minutes), main must equal origin/main, the commit must
# descend from main; then fast-forward, push, poll /health until it serves the commit, and
# print the boot log tail. Stops at the first problem. Run from the primary checkout, on main.
#   bash scripts/prod/ship.sh <hash> [<hash> ...]
# Verify FIRST, separately, and gate on its exit code:  npm run verify && bash scripts/prod/ship.sh <hash>
set -u
cd "$(git rev-parse --show-toplevel)" || exit 2
[ "$(git branch --show-current)" = "main" ] || { echo "not on main"; exit 2; }
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "working tree not clean"; exit 2; }
for h in "$@"; do
  echo "=== shipping $h"
  git fetch -q origin || { echo "fetch failed"; exit 1; }
  # Either main equals origin/main and the commit descends from it (a worktree branch to fast-forward to),
  # or the commit IS local main, ahead of origin only by what is being shipped (a commit made on main).
  if [ "$(git rev-parse refs/heads/main)" = "$(git rev-parse refs/remotes/origin/main)" ]; then
    git merge-base --is-ancestor refs/heads/main "$h" || { echo "$h does not descend from main - stopping"; exit 1; }
  elif [ "$(git rev-parse "$h")" = "$(git rev-parse refs/heads/main)" ] && git merge-base --is-ancestor refs/remotes/origin/main refs/heads/main; then
    echo "shipping local main (ahead of origin by $(git rev-list --count refs/remotes/origin/main..refs/heads/main) commit(s))"
  else
    echo "main and origin/main differ and $h is not local main - stopping"; exit 1
  fi
  node scripts/prod/quiet-check.mjs || { echo "production not quiet - stopping"; exit 1; }
  [ "$(git rev-parse "$h")" = "$(git rev-parse refs/heads/main)" ] || git merge --ff-only "$h" >/dev/null || { echo "fast-forward failed"; exit 1; }
  git push origin main 2>&1 | tail -1
  short=$(git rev-parse --short "$h"); ok=0
  for i in $(seq 1 40); do
    c=$(curl -s https://app.pbjsa.com/health | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(j.commit+' ok='+j.ok+' db='+j.db)}catch(e){console.log('unparsed')}})")
    case "$c" in "$short"*) echo "live: $c"; ok=1; break;; esac
    sleep 15
  done
  [ "$ok" = 1 ] || { echo "health never showed $short - stopping (old image keeps serving; check the Railway deploy)"; exit 1; }
  npx @railway/cli@latest logs --service PBJBillingApp 2>/dev/null | tail -8 | grep -i "listening\|error" | head -3
done
echo "ALL SHIPPED"
