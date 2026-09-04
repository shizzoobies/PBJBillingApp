# Runbook — knowing the app is down, and putting it back in two minutes

Part of `docs/plans/resilience-2026-09.md` (Tier 1, steps 2.5 and 2.6).
Written 2026-09-03, the day a deploy pipeline failed for two hours while
production kept serving — and nobody would have known had a session not
happened to be pushing.

## 1. What "down" means here, and what `/health` now says

`GET https://app.pbjsa.com/health` is a **readiness** check (since Tier 1
step 2.4): it pings Postgres with a 2-second bound.

| Response | Meaning | Action |
|---|---|---|
| `200 {"ok":true,"mode":"postgres","db":"ok","stripe":"live",…}` | serving, database reachable | none |
| `503 {"ok":false,"db":"unreachable",…}` | process up, **database down or unreachable** | §3 — this is a Railway Postgres problem, not an app one |
| connection refused / timeout | process or host down | §4 rollback, then §5 failover once Tier 2 exists |
| `200` with `"stripe":"unconfigured"` | env vars missing on this host | check the service variables (17 of them — plan §1) |

## 2. Alerts (owner dashboard steps — one-time setup)

**Cloudflare Health Checks** (the zone is already on Cloudflare):
1. Cloudflare dashboard → `pbjsa.com` → Traffic → **Health Checks** → Create.
2. Address `https://app.pbjsa.com/health`, HTTPS, path `/health`, **expected
   code 200**, interval 60s, 2 retries, regions: 2 nearest.
3. Notifications → add a Health Checks notification to Alex's email and
   phone (SMS/push via the Cloudflare app). Name it "PBJ app health".

**Second opinion outside Cloudflare** (a Cloudflare-side problem would blind
its own checks): a free Betterstack (or UptimeRobot) monitor on the same URL,
expecting 200, alerting the same phone. Two independent watchers is the point.

**Railway's own healthcheck** already gates deploys on `/health` — with the
readiness change, a deploy into a database-down state now correctly FAILS
instead of "succeeding" into a broken instance. That is intended.

## 3. Database unreachable (503)

1. Railway dashboard → the **Postgres** service → is it running? Restart it.
2. If Railway shows an incident, wait; the app returns to 200 by itself when
   the pool reconnects (no restart of the app needed).
3. If Postgres is genuinely lost: `docs/runbooks/db-backup-and-restore.md`
   (nightly dumps in R2; restore procedure there). **Stop the app first.**

## 4. Rollback — the two-minute fix for a bad deploy

Railway keeps every previous SUCCESS image. From the CLI:

```bash
npx @railway/cli@latest deployment list --service PBJBillingApp
# find the last SUCCESS row *before* the bad one, copy its id, then in the
# dashboard: PBJBillingApp → Deployments → that row → ⋯ → Redeploy
```

(The CLI's `redeploy` only redeploys the LATEST deployment; older ones are a
dashboard click.) Health-check `/health` afterwards. Then fix forward on
`main` — a rollback is a pause, not a solution, and the next push redeploys
whatever `main` says.

**When a deploy FAILS but the app is still up** (2026-09-03's shape): nothing
to roll back — production never changed. Read the failed build's log via
Railway's GraphQL `buildLogs(deploymentId)` (the CLI never shows a failed
build's log — `docs/HANDOFF.md` §5 2026-09-03 has the exact call), fix
forward, push again.

## 5. Failover (Tier 2 — not built yet)

Once the Fly.io standby and the Cloudflare load balancer exist (plan §3),
failover is automatic on a failed health monitor and needs no human. The
quarterly drill and the manual override live here when that ships.
