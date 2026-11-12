# Zero-downtime deploys: findings and options (2026-11-12)

Status: **investigated, nothing built.** Alex asked for this after Brittany reported the app down during two deploys on 2026-11-12. Waiting on his choice between the options in section 4.

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
