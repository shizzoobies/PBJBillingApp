# Zero-downtime deploys: findings and options (2026-11-12)

Status: **the hand-over style (section 12) is built, rehearsed on the staging Worker, and is what production runs from the cutover deploy of 2026-11-12 (night).** Alex chose option A, then (after section 10) the hand-over style over the overlap. Sections 9 to 11 are the first rehearsal (overlap) and why it was not shipped; section 12 is what shipped.

## 1. What happens today

Every `cf-deploy` run leaves the app unreachable for minutes. Measured from the workflow's own health polls (a 25-second gap between polls is a 10-second timeout plus the 15-second sleep):

| Deploy (UTC, 2026-11-12) | Old container gone | New process started | App unreachable |
|---|---|---|---|
| `5ebc8a32` (code) | about 15:57 | about 16:05:50 | about 9 min |
| `edaf369e` (docs only) | about 16:12:55 | 16:14:23 | about 2 min |
| `7620cbc2` (code) | about 21:05:45 | about 21:10:00 | about 4.5 min |

The last nine deploys all show a 1.5 to 11 minute wait in the same step.

## 2. Why

- The app is ONE container (`max_instances: 1`) owned by one Durable Object (`getContainer(env.APP, 'app')`), on Cloudflare's **`default` scheduling policy**.
- On that policy `wrangler deploy` starts a platform rollout. For each running instance the documented sequence is: send `SIGTERM`, wait for exit, **then** start a new instance on the new image. Stop first, start second. With one instance there is nothing serving in between.
- Our app exits within seconds of `SIGTERM` (server.js shutdown handler). The gap is the platform bringing the new image up, not our boot: the new process's `uptimeSeconds` shows it only started at the END of the gap, and then listened within about 10 seconds. The gap tracks how much of the image changed (2 minutes for a docs-only image, 4.5 to 9 for code).
- While it lasts, the Worker waits on the container helper (`@cloudflare/containers` `startAndWaitForPorts`) and requests hang or come back 503 "currently provisioning the Container".
- `rollout_active_grace_period` (default 0) only spares instances that connected to their Durable Object recently; it is not a "start the new one first" switch. `rollout_step_percentage` is forced to 100 with fewer than two instances.

So no setting on the current arrangement gives overlap. Zero downtime needs two instances alive at once for a minute: start the new one, check it, switch, stop the old one.

## 3. What changed at Cloudflare (matters for the choice)

- Since 2026-09-30 there is a second scheduling policy, **`durable_object`** (public beta). Images are named in `wrangler.jsonc` (`containers[].images`), uploaded with the Worker version, and **the Durable Object's own code picks the image when it calls `ctx.container.start({ image, instance, enableInternet })`**. Deploying never restarts a running instance: "Your code must stop and restart an instance to move it to a new image."
- The **`default` policy is now marked deprecated** in the docs ("Migrate to the `durable_object` scheduling policy"). No removal date is published.
- A policy cannot be changed in place. Migration means a NEW container application and a NEW Durable Object class and binding beside the old ones, a cutover, and later deleting the old application. The `Container` helper class we use does not support the new policy, so port readiness, request proxying and keep-awake have to be written against the Durable Object API directly.
- Our installed Wrangler (4.151.3) already has `scheduling_policy` and `images` in its config schema. `@cloudflare/containers` is at its latest (0.3.7).

## 4. Options

### A. App-controlled swap on the `durable_object` policy (recommended target)

Deploy uploads the new image and Worker and touches nothing that is running. Then the Worker itself does the swap: start a second instance (a Durable Object named for the commit) on the new image, poll its `/health` until it reports the new commit with `db: ok`, switch the "current" pointer, send `SIGTERM` to the old instance and let it drain.

- For: documented semantics for exactly this; it is where Cloudflare is going, so the migration is owed anyway and is done once; the current Durable Object holds no data we need (everything is in Postgres), so there is no state to move.
- Against: public beta; a rewrite of `cloudflare/worker.js` away from the helper class; a one-time production cutover (old application and binding kept for rollback, as Cloudflare's guide describes).

### B. Two-color swap on the current policy

Keep the helper class. Either two container applications ("blue" and "green") where each deploy changes only the idle one's image, or one application with `max_instances: 2` and a long `rollout_active_grace_period` so the running instance is spared while a second is started.

- For: stable API, smaller code change.
- Against: built on a deprecated policy, so it is thrown away at the migration; the single-application variant leans on rollout behavior the docs do not promise and would have to be proven; the two-application variant needs a generated per-deploy config that knows which color is live and which image digest it runs.

### C. Contain it, do not fix it

Ship outside Brittany's working hours, one commit per ship (already the rule since 2026-11-12), and have the Worker answer a short "Updating, back in a few minutes" page with `Retry-After` instead of hanging. No overlap, so still downtime; just planned and polite.

## 5. Whichever option: rehearse on a staging Worker first

Every experiment on production costs Brittany minutes, and none of this can be tested on a laptop (no Docker here; the behavior in question is Cloudflare's). So step one is a throwaway `pbjbillingapp-staging` Worker:

- same Dockerfile, its own container application, **no `DATABASE_URL`** so the app runs on its file backend with the seeded demo workspace (nothing real, no secrets beyond a tick token);
- deployed by a manually triggered workflow using the GitHub secrets that already exist;
- reachable on a `workers.dev` address. The repo is public and the seeded passwords are in it, so it holds demo data only and is deleted when the rehearsal ends.

The rehearsal has to show, with timestamps: a deploy that leaves `/health` answering throughout (a poll every second, zero failures), the swap, an in-flight request finishing across the switch, a live-update stream reconnecting, and a rollback.

## 6. What the app must keep true once two versions overlap

- **Database changes are additive.** Old and new code both run against the same database for about a minute. The boot-time "add column if not exists" idiom already fits; a change the old code cannot live with needs an explicit "stop first" deploy (keep that path as a flag).
- **Live-update streams** (SSE) drop at the switch and the browser reconnects to the new instance; `broadcastDataChanged` is per instance, so the switch must be quick and one-way.
- **In-flight requests** on the old instance finish on `SIGTERM` (the existing 20-second drain in server.js; a long AI or PDF request may need longer).
- **Periodic jobs** are already idempotent (per-week, per-invoice and per-day markers), and the cron tick must go to the current instance only.
- **In-memory rate-limit buckets** reset at the switch, as they do on every deploy today.

## 7. Order of work (after a go-ahead)

1. Staging Worker and its manual deploy workflow. Measure today's behavior there as the baseline.
2. Build the chosen option against staging until the every-second poll shows zero failures across repeated deploys.
3. Production cutover outside working hours, old path kept for rollback.
4. Remove the old path, update `docs/cloudflare.md`, drop the "ask about timing" rule.

## 8. Sources

- https://developers.cloudflare.com/containers/platform-details/rollouts/
- https://developers.cloudflare.com/containers/platform-details/architecture/
- https://developers.cloudflare.com/containers/configuration/scheduling-policy/
- https://developers.cloudflare.com/containers/guides/migrate-to-durable-object-scheduling-policy/
- https://developers.cloudflare.com/changelog/post/2026-09-30-durable-object-scheduling-policy/
- https://developers.cloudflare.com/workers/wrangler/configuration/ (Containers section)
- Local: `node_modules/wrangler/config-schema.json`, `node_modules/@cloudflare/containers/dist/lib/container.js`, the `cf-deploy` run logs for the three deploys above.

## 9. Rehearsal on staging (2026-11-12, evening; times UTC, 2026-11-13)

Staging is the Worker `pbjbillingapp-staging` (`cloudflare/staging/wrangler.jsonc`, workflow `cf-staging`, runs only for branches named `staging/**`). File backend, seeded demo data, no secrets; nobody can sign in (production mode has no demo passwords). Each test ran one `/health` request per second from a laptop, and the later ones also ran overlapping 8-second requests (a slow POST to the sign-in route), so some request was always in flight.

### 9.1 Baseline on the old arrangement, and a correction to section 2

| Deploy | Old stopped | New answered | Failed of total |
|---|---|---|---|
| `49ca994` | 00:08:55 | 00:09:00 | 1 of 197 (about 5 s) |
| `5729df4` | 00:16:34 | 00:16:46 | 5 of 259 (about 12 s) |

Staging stalls for **seconds**, where production stalls for **minutes**, with the same Dockerfile, the same Worker code and the same deploy. So "stop first, start second" is only part of it. What differs is how long Cloudflare takes to get the new image running on the machine: on production's last deploy the new instance record (location `ord10`) was created at 21:05:28 and its process started at 21:09:59, 4.5 minutes later; on staging the same step took 1 to 7 seconds, and before the second staging deploy Cloudflare held the application in "provisioning" for 86 seconds BEFORE stopping the old container. Why production's machine is slow is not known (it cannot be seen from outside). It does not need to be: the swap below keeps the old instance serving for however long the new one takes, and 9.3 proves that with a new instance made slow on purpose.

A side finding: every deploy pushes 15 of the image's 20 layers as new (a fresh build machine has no cache, so even an unchanged `npm ci` layer gets a new identity). Caching those layers would make every new image smaller to fetch. Not done; listed in section 11.

### 9.2 What was built (branch `staging/zero-downtime`)

- `cloudflare/rollout.js`: the swap rules, pure and unit-tested. One instance is live. A new image starts a second instance; the pointer moves only when that instance answers `/health`; the old one serves 5 more seconds, then gets SIGTERM. A new instance that is not healthy within 20 minutes is given up on and the live one keeps serving. A newer deploy arriving mid-swap replaces the half-started instance. A stop that fails is retried until it works.
- `cloudflare/worker.js`: `AppRouter` (one Durable Object: which instance is live, a heartbeat alarm that carries out the rules), `AppHost` (one instance on the `durable_object` policy: its own code picks the image, so a deploy never restarts it), and the old `AppContainer` kept as the instance named `legacy` (what serves until the first swap, and the way back through the `ROLLOUT_TARGET` var).
- The old container's image is PINNED in the Wrangler config to the digest it is running. Left as `./Dockerfile`, the cutover deploy itself would roll the old container and stall once more.
- A restart after a secret upload (`POST /internal/restart`) becomes a swap to a fresh instance started with the Worker's current environment, so it no longer interrupts anyone. `GET /internal/rollout` (token) shows where things stand.

### 9.3 Results on the new arrangement

| Test | What happened | Failed of total |
|---|---|---|
| Cutover from the old container (`387436f`) | Old container served until the first new instance answered, 18 s after it was started; then it was stopped | 0 of 213 |
| An ordinary deploy, instance to instance (`6999f07`) | Swap 45 s after the deploy finished; new instance answered 16 s after it was started | 0 of 292 |
| A new instance made to take 4 minutes to come up (`e31b682`) | Old instance served for the whole 253 s; swap at 00:40:01; old instance exited on SIGTERM at 00:40:08 | 0 of 491 health checks, 0 of 653 eight-second requests |
| The way back to the old container (`668b224`, `ROLLOUT_TARGET` = `legacy`) | Old container started on its pinned image and took over when it answered, 6 s after it was asked; the instance was then stopped | 0 of 515 |
| Forward again from the old container, on the final code (`355d9de`) | Old container served until the new instance answered 41 s after it was started; then it was stopped and has stayed stopped | 0 of 525 |

No request took longer than one second during any swap. In the slow-start test, requests that were in flight at the moment of the swap and at the moment the old instance got SIGTERM all finished normally.

### 9.4 The way back

The way back worked, but slowly at first: the swap to the old container began about 5 minutes after the deploy finished. The router is a long-lived Durable Object, and it went on running the PREVIOUS Worker version (code and vars) for those 5 minutes, so it had not seen the new `ROLLOUT_TARGET` yet. A new image is not affected (the router asks a brand-new object, which always runs the newest version, what image is wanted; those swaps began within 30 to 45 seconds). Fixed after this run: the stateless Worker, which is always the newest version, hands the target to the router with its version time, and the newest wins. Rule of thumb that stays true: anything the router or a long-lived instance reads from its own `env` can be minutes stale after a deploy.

## 10. What the two reviews found (2026-11-12)

### 10.1 The Worker code (fixed)

An independent review of `worker.js` and `rollout.js` found one real defect and several gaps, all fixed with tests before the last staging runs: a restart requested while the router was mid-look was overwritten and lost; the old container, once stopped, could be woken by a late request and would then run for ever (it now stores a "retired" mark and answers "gone"); an instance whose stop failed five times was forgotten while possibly still running (now retried until it stops); the heartbeat had no safety net (the cron and ordinary requests now re-arm it); the old instance was stopped even if the new one had just crashed (now kept until the new one answers). Known and left: a request with a body that lands on an instance in the second it stops serving gets a 503 with retry-after (it is never sent twice); a restart requested while the target is `legacy` waits until the target is `hosts` again.

### 10.2 The app under two processes (NOT fixed; the reason for 10.3)

A second review read `server.js`, `db/store.js` and `lib/` for what goes wrong when the old and the new process run against the same Postgres for 15 to 60 seconds. Its two serious findings, both checked against the code:

1. **A save on the old process can erase a column the new process just added.** The bulk save deletes and re-inserts whole tables (`clients`, `invoices`, `time_entries` and others) with the OLD code's column list. If a deploy adds a column and fills it at boot, and someone saves in the seconds before the swap, those rows go back to empty and the boot-time fill does not run again. Today this cannot happen because the old process is dead before the new one boots.
2. **Boot's schema statements can freeze the old process for the length of a save.** Boot runs about 200 `alter table ... if not exists` statements with no lock timeout. Each one asks for an exclusive lock even when it changes nothing. Behind a bulk save (10 to 13 seconds) it waits, and every other query on that table, reads included, waits behind it.

Smaller: shutdown does not wait for a periodic job or a webhook's after-work that is mid-run (true today as well); the weekly digest reads its "sent" mark, sends, then writes the mark, so two processes could both send it in a narrow window on digest day; a few double-click guards are in-process only. Found safe: Stripe, SignWell and eSignatures webhooks (event ledger first), past-due notices (one claiming update), automatic reminders (provider idempotency key per invoice and day), autopay (claim row plus Stripe idempotency key), money operations (database advisory locks), and the bulk save's staleness guard (checked in the database under the table locks).

### 10.3 The choice this leaves (Alex)

- **Overlap (what was rehearsed).** Zero downtime. Needs a standing rule: a deploy that adds or fills a column ships the schema first and the code that depends on it in a later deploy, or is marked to use the other style. Also worth doing first: a lock timeout and retry around boot's schema statements.
- **Hand-over (not built).** The new instance is brought up and HELD before the app starts (so Cloudflare's slow step is already done), the pointer moves, the old process is stopped, and only then is the new app started. Requests wait about 15 seconds instead of failing, and the two processes never overlap, so neither finding above applies and no deploy rule is needed. About a day of work plus its own rehearsal; it relies on running a command inside the container (`ctx.container.exec`), which is part of the same beta API.
- Either way production's stall goes from minutes to nothing or to seconds. Recommended: hand-over as the default, with overlap available for deploys known not to touch the schema, because the bulk save's delete-and-re-insert makes "the old code can live with it" a promise that has to be re-checked on every schema change.

## 11. Production cutover (after the choice above; outside working hours)

1. Merge the branch into `main` as ONE commit with the production config changes: the old container's image pinned to the digest it is running at that moment (`wrangler containers info` shows it; it was `sha256:2a4f3e2f...85b9` on 2026-11-12), a second `containers` entry (`AppHost`, `scheduling_policy: durable_object`, `images.app` built from `./Dockerfile`), the `HOST` and `ROUTER` bindings, migration `v2`, the version-metadata binding, and a longer health wait in `cf-deploy.yml` (the new commit answers only after the swap). Remove the rehearsal-only slow-start switch from `worker.js` first.
2. That deploy is itself a swap: the old container serves until the first new instance answers. Watch `/health` and `GET /internal/rollout`.
3. The way back for the first days: set `ROLLOUT_TARGET` to `legacy` and deploy. The old container starts on its pinned (old) image and takes over when it answers.
4. After a week: delete the old application and class, the `@cloudflare/containers` package, the legacy code paths, the staging Worker and its workflow; update `docs/cloudflare.md` and `scripts/cf/restart.mjs` (its 90-second wait assumes a stop-and-start); drop the "ask about timing" rule.
5. Separate, optional: cache the image layers in the deploy workflow (9.1).

## 12. The hand-over style (what shipped; built and rehearsed 2026-11-12 night)

Alex's answer to 10.3: hand-over, and cut production over the same night, after hours.

### 12.1 How a deploy goes now

1. `wrangler deploy` changes nothing that is running. The router (`AppRouter`) sees that the newest code wants another image and starts a new instance (`AppHost`) beside the live one, **held**: its container runs `lib/container-hold.js` instead of the app. The hold loads nothing of the app (no schema statements, no jobs, no writes). It listens on port 8079, checks that it can reach the database (`select 1`, repeated every 5 seconds), and waits. The live instance keeps serving for however long Cloudflare takes to bring the image up.
2. When the new instance is **parked** (its hold answers and the database check passes) and the live instance runs a version of the Worker code that can be handed over from (`protocol`, see 12.3), the router moves the pointer to the new instance. From that moment requests wait there (`AppHost.fetch`, up to 90 seconds each).
3. One second later (for requests already on their way) the old app gets SIGTERM and finishes what it has in flight, as it does for any restart. Its instance keeps its record: it is the way back.
4. Only when that stop is confirmed does the router tell the hold to become the app (`POST /go`; the hold imports `server.js` in the same process). The app boots: this is the first moment the new code touches the database, and the old process is gone.
5. When the new app answers `/health`, the waiting requests go through, and the old instance's record is deleted.

So the old and the new app never run against the database at once, which was the hazard of the overlap style (10.2). The cost is that requests wait while the old app stops and the new one boots.

If it goes wrong after step 2: a new app that does not answer `/health` within 3 minutes, or exits twice, is stopped for good and the OLD instance is started again on its own image. Requests get "try again" (503) until it is back. That image is never tried again by itself (every try would make people wait); the deploy run goes red; the next deploy is tried normally. The old app is never started while the new one might still be running. A new instance that never parks (image never comes up, database check failing) is given up on after 20 minutes without anyone noticing anything: the live instance just keeps serving.

Unchanged from section 9: the first start with nothing serving, the way back to the old container (`ROLLOUT_TARGET=legacy`, still by overlap because the old image has no hold), and a restart after a secret upload being a swap to a fresh instance (now a hand-over too, so it also makes requests wait a few seconds once).

### 12.2 Rehearsal on staging (times UTC, 2026-11-13; one `/health` request per second with a 60 second limit, plus a new 8-second request started every second)

| Run | What | Failed | Longest wait |
|---|---|---|---|
| `0aa62c9` | First deploy of the hand-over code. The router was still running the previous code (see 12.3), so this one swap was done the old way, by overlap | 0 of 219, 0 of the slow ones | under 1 s |
| `87bd79c` | Ordinary deploy, host to host, by hand-over. Paused 5.7 s (stop 1.5 s, boot 4.1 s) | 0 of 231, 0 of the slow ones | 4.8 s |
| `6e74e36` | A new app made to fail at start. Undone by itself: the old instance was answering again 9 s after the pause began | 5 health requests and 11 slow ones got 503 inside that window | 4.0 s |
| `d91b127` | The way back to the old container (overlap) | 0 | under 1 s |
| `6bc796a` | **Production's cutover, practiced:** from the old container to a host by hand-over, with the new instance made to take 90 s to come up. Paused 9.9 s (stop 1.5 s, boot 8.3 s) | 0 of 329, 0 of the slow ones | 8.2 s |
| `b4b45b0` | The final code (rehearsal switches removed): ordinary deploy by hand-over. Paused 5.1 s (stop 1.5 s, boot 3.5 s) | 0 of 194, 0 of the slow ones | 2.4 s |

Also seen: a held instance on the `durable_object` policy can reach the internet (the hold's check reported it), which the first rehearsal had not shown because staging has no database; an instance can be started again on its OLD image after a newer version was deployed (the way back depends on it); requests whose bodies were still arriving at the old app when it got SIGTERM finished normally.

Not rehearsable on staging, and so first seen on production: the app's boot against Postgres inside the pause (staging boots on the file backend in 4 to 8 seconds), and the old container's object still running code from before this arrangement (12.3).

### 12.3 The five-minute lag, and the `protocol` gate

Measured again: a long-lived Durable Object keeps running the PREVIOUS version of the Worker code for about 5 minutes after a deploy (the router did at 02:33 to 02:38), while a brand-new object runs the newest. Two consequences are built in:

- The router never calls "stop, but keep your record" on an instance whose object might not have that method yet. Every instance reports `protocol`; the hand-over begins only when the live one reports 2 or more. Until then the new instance stays parked and the old one serves. On production's cutover this covers the old `AppContainer` object, which runs the pre-router code until Cloudflare restarts it.
- For those 5 minutes after any deploy the router itself applies the previous version's rules. That is harmless from now on (the previous version is also a hand-over version); it only meant that the very first staging deploy of this code was still done by overlap.

### 12.4 What the two reviews of this style found

First round (before the staging hand-overs): the undo started the old app after 60 seconds even if the new one could not be confirmed stopped (now it never does while the new one may be running); the way back (`ROLLOUT_TARGET=legacy`) was ignored once a new instance was parked; waiting requests shared one 90-second limit; a stuck "start the old one again" blocked every later deploy; a restart requested after an undone hand-over silently did nothing (now refused with a 409 and a reason); a held instance with no `DATABASE_URL` at all would have parked and then booted on the demo file backend (now a database answer is required, except on staging). All fixed with tests. Second round, on the fixes and on a step-by-step walk through the production cutover: nothing blocking; two small hardening points taken (a retired instance is marked stopped before its signal; a stopped live instance keeps being started while a held one comes up).

Known and left as they are:

- **The app's shutdown gives in-flight requests 10 seconds** (`SHUTDOWN_BACKSTOP_MS` in `server.js`). A bulk save that is in flight at the instant of a hand-over and takes longer than that is cut off and rolled back (the user sees a failed save and saves again). Before this arrangement a deploy killed such a save too. Raising the limit toward 18 seconds would save it at the price of a longer wait for everyone else; a question for Alex.
- During an UNDO (the new app did not start) requests get 503 with retry-after until the old instance is back, and a request with a body is never sent twice, so it fails.
- `/health` reports `uptimeSeconds` of the process, which now includes the time spent held.
- After a completed hand-over nothing undoes it automatically (a new app that answers `/health` once and then misbehaves is a normal bug: fix forward, or `ROLLOUT_TARGET=legacy` while the old container is kept).
- A red `cf-deploy` run means the new code is not serving. One exception: if the new instance parked but the live one did not report `protocol` 2 within 20 minutes, the run goes red and the router tries again by itself 30 minutes later.

### 12.5 Operating it

- `GET /internal/rollout` (header `x-tick-token`) shows the live instance, a new one coming up (`held`, `parked`, `checks`), a hand-over in progress (`phase`: stop, release, boot, undo, resume), the last failure and why, and the last ten events with how long each pause was (`pausedMs`, `stopMs`, `bootMs`).
- Deploy: push to `main` as before. The run's last step waits up to 25 minutes for the new commit on `/health` and now FAILS if it never appears.
- The way back to the old container, while it is kept: set `"ROLLOUT_TARGET": "legacy"` in `wrangler.jsonc` vars and deploy; remove it and deploy to come forward again.
- Still to do (section 11, steps 4 and 5): after about a week delete the old application and class, the `@cloudflare/containers` package and the legacy code paths; delete the staging Worker and `cf-staging.yml`; cache the image layers.
