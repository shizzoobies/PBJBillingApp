# Scoping: letting Brittany push an update herself

Written 2026-07-25. **Nothing here is built.** This is a decision document for
the "emergency — Alex isn't available, let me try to fix it myself" button:
Brittany describes what she wants from inside the app, and an AI does roughly
what the dev chat does — writes the code, verifies it, ships it.

Verdict up front: **the plumbing is ~60% there, and a genuinely useful version is
realistic. The version that pushes ANYTHING to production unsupervised is not —
and the reason is evidence from this repo, not caution in the abstract.**

> **Status 2026-07-26: the open questions in §6 are now DECIDED.** Alex settled
> the design fork — Brittany ships the low-blast-radius bucket herself with a
> revert button; everything that can touch data waits for him as a PR. §5 and §6
> below have been rewritten to the agreed design; §1–4 are unchanged analysis.
> Still not built, and still blocked on CI (§2).

---

## 1. What already exists

More than you'd guess. The gap is narrower than the idea sounds.

| Piece | Where | Status |
|---|---|---|
| AI layer | `lib/assistant.js` — `ANTHROPIC_API_KEY`, Opus 4.8, Haiku fallback | ✅ |
| A surface she already uses | in-app chat + the ElevenLabs voice agent | ✅ (so "call it in" is half-wired) |
| Filing a request | `send_feature_request` tool → Updates tracker | ✅ |
| Config-level writes by AI | `assign_client`, `make_template_recurring`, `generate_tasks_now` | ✅ |
| Reading the workspace | `get_workspace_snapshot`, `get_usage_patterns`, + 5 more | ✅ |
| **Repo checkout → edit → verify → git → deploy** | — | ❌ **the actual gap** |

So this isn't "teach an AI to talk to Brittany." It's specifically: give an agent
a checkout, a test run, and a git remote.

---

## 2. Where it would have to run

**Not in the Railway app process.** That's the production web server — no repo, no
git, no build toolchain, and you don't want it running `vite build` while serving
requests.

**GitHub Actions is the realistic host.** Repo-native, has secrets, gives you
runners and PR creation for free, and the Claude Agent SDK is built for exactly
this headless shape. The app just fires a `workflow_dispatch` with her request
text and polls for the result.

> ⚠️ **Prerequisite: this repo has no CI.** `.github/workflows/` does not exist —
> `npm run verify` has only ever run on Alex's machine. That has to exist first,
> and it's worth doing on its own merits regardless of this feature.

---

## 3. Cost

Real but not the blocker: roughly **$3–15** for a small fix, **$20–60** for
something the size of a full dev session. The sharper risk is **retries** — if
she doesn't like the result and re-runs three times, that's 3×. Worth a per-run
and per-month ceiling.

---

## 4. The actual risk

Not "can it write code" — it can. The failure mode is **confident wrongness
shipped to production**, and this repo has already produced three clean examples:

| Bug | Caught by | Would an autonomous agent have caught it? |
|---|---|---|
| Stage-1 due dates wrong on **177 rows** | reproducing the materializer against prod | ❌ every test passed |
| Bookkeepers couldn't see their own group time | diffing owner-visible vs staff-visible rows | ❌ all 506 tests passed |
| "Show incomplete checklist items" | Brittany rejecting it **three times** | ❌ wrong reading twice *with a human in the loop* |

**Green verify ≠ correct here, repeatedly.** And what caught each one was deciding
*what to go check* — precisely the judgment an unsupervised agent lacks. The third
row is the worst case for autonomy: an agent with no one to ask would have shipped
a confident, plausible, wrong feature and marked it done.

Three more, briefly:

- **`main` auto-deploys.** No staging gate between a bad commit and the firm's
  live billing app.
- **The DB is live.** `docs/HANDOFF.md` §4 forbids unapproved prod writes for a
  reason (there's a prior outage). A bot can't hold that judgment.
- **You've already made this call once.** The `planned_not_eom` status exists
  because you two decided some changes are too risky near month-end close. An
  autonomous deploy button contradicts a decision already in the product.

---

## 5. Recommended shape

### Tier 0 — "Diagnose and explain" (cheap, do it regardless)
No code changes. Extends the existing assistant with read tools + a few safe
config actions, so she can ask "why isn't X working?" and get a real answer.

Grounded in what actually happened: of the incidents this project has hit, the
locked-month payroll outage and the two never-generating recurring templates were
**config, not code** — fixable without touching the repo. Others (the scope bug,
the notification gap) were genuinely code. So Tier 0 resolves a real slice
outright, and makes the rest far better-specified for the tier below.
**~1–2 sessions.**

### Tier 1 — "Draft a fix" ⭐ the sweet spot
Button → agent branches, implements, runs `npm run verify`, opens a **PR**. Never
touches `main`. Alex gets a push notification and merges from his phone.

This still solves the stated problem — it compresses Alex from *do the work* to
*read it and tap merge* — while keeping a human at the only step that has ever
caught these bugs. **~3–5 sessions on top of CI.**

### Tier 2 — narrow auto-deploy + revert ✅ **THIS IS THE AGREED DESIGN**

Alex's call (2026-07-26): let her ship, but give her a **revert** so her options
when something is wrong are *put it back and wait for Alex* rather than *re-run
the agent until it works*. That last behavior is the expensive one, and it does
not converge — see the retry cap below.

**Routing is by BLAST RADIUS, not by whether the agent can write the code.**
The agent classifies by which files it touched, which is a mechanical check
rather than a judgement call:

| Bucket | What's in it | What happens |
|---|---|---|
| **Auto-deploy** | copy, labels, colors, thresholds, layout, sort order | ships, revert button available |
| **PR only** | `db/store.js`, any write path, migrations, anything that mutates existing rows | branches, opens a PR, waits for Alex |

The split exists because **revert restores CODE, not DATA.** A change that writes
bad rows or deletes them is not undone by redeploying the old bundle. The June
wipe, the 177-row due-date backfill and the `client_id = ''` FK violation are all
in that category. The staleness guard (`featreq-f7d50027`) is a good example of a
change that must never be in the auto bucket — it lives in the write path itself.

**Revert only fires on failures she can SEE.** That is its real limit, and it is
why the auto bucket is restricted to changes where "looks wrong" and "is wrong"
are the same thing. Re-read §4's table with that lens: not one of those three
bugs would have prompted anyone to hit revert. Silent wrongness is the dominant
failure mode in this repo, not visible breakage.

**Revert mechanics** — three properties that matter:

1. **It must not need the AI.** If the model is what broke things, the recovery
   path cannot route through it. Button → GitHub Action → `git revert <sha>` +
   push. No model in the loop. (Railway's CLI exposes only `redeploy`/`down`, no
   roll-back-to-deployment-N, so a revert commit is the mechanism anyway — and
   it is the better one: auditable, and `main` keeps matching production.
   Cost: a rebuild, ~2–3 min, not instant.)
2. **Scope it to AI commits, most recent first.** She must not be able to revert
   Alex's work — that would be a worse failure than the one being prevented.
3. **A revert IS the existing "Not approved" send-back.** Wire it into the
   tracker flow she already uses: flip the item back to Planned, capture her
   reason, notify Alex. He gets the reason, not just a rollback.

### Guardrails (all agreed 2026-07-26)

- **Month-close block.** Reuses the existing `planned_not_eom` window from
  HANDOFF §7.1: enabled the **6th–23rd**, blocked the **24th through the 5th**.
  Deliberately NOT "7 days before month end" — that would leave the 1st–5th open,
  which is exactly when the prior month's books are being closed. One constant,
  shared with the queue rule, so the two can't drift apart. Blocked state is
  automatic, and the button carries a tooltip:

  > **Updates are paused until the 6th.** Changes near month close can disturb
  > billing and timesheets while the books are being finalized. Your request has
  > been saved and will be waiting for Alex — nothing is lost.

  The precedent is concrete: on 2026-07-26 a change that was built, verified
  against production and reproduced end-to-end was still parked because it was
  the 26th. If a human-verified change doesn't ship during close, an unsupervised
  one shouldn't either.

- **Per-run ceiling: $15 auto-deploy, $50 PR.** A per-run cap is a **runaway
  detector, not a budget** — its job is to trip when the agent is looping or
  confused. $15 covers the entire realistic $3–15 small-fix range (§3), so it
  also catches **misclassification**: a "rename this button" run about to pass
  $15 is almost certainly not cosmetic and was routed to the wrong bucket. $50
  for the PR bucket, where a human gate means overspend costs money, not
  correctness. Must abort CLEANLY and file the item for Alex — an account-level
  cap alone kills the run mid-flight, possibly with a half-written branch.

- **Per-item attempt cap: 2 runs, then escalate to Alex.** This is what actually
  bounds the bill; the per-run ceilings don't. Three attempts at a $15 change is
  $45 and no per-run cap stops it. It also maps to the real failure mode: "To
  100%" was rejected three times and every retry was a *wrong reading*, not an
  under-resourced run. A third attempt would not have helped.

### Tier 3 — full autonomy
Still argued against, and superseded by the Tier 2 design above: the PR bucket
exists precisely so the data-touching changes never become autonomous. See §4.

---

## 6. Decisions (Alex, 2026-07-26) — all four resolved

1. **Merged and live, or a PR?** → **Both, split by blast radius.** She ships the
   cosmetic bucket herself with a revert button; anything that can touch data
   opens a PR and waits. The revert is what makes shipping acceptable: it gives
   her a real option other than re-running the agent, which is the expensive
   behavior and the one that doesn't converge.
2. **Spend ceiling?** → **$15 per run auto-deploy, $50 per run PR**, plus a
   **2-attempt cap per tracker item** before it escalates. Alex is also setting
   an account-level cap on the Anthropic side as the outer backstop. Rationale in
   §5's guardrails — the short version is that per-run caps detect runaways and
   the attempt cap is what actually bounds the monthly bill.
3. **Hard-block near month close?** → **Yes, automatic**, reusing the existing
   6th–23rd `planned_not_eom` window rather than a new "7 days before month end"
   rule, which would have left the 1st–5th open. Tooltip copy in §5.
4. **Who reviews when Alex is unreachable?** → Answered by the split. The
   cosmetic bucket needs nobody; the PR bucket queues for him. Brittany does not
   get a merge button — she gets a **revert** button, which is the safe half of
   the same power.

**Still open / not decided:** nothing on the policy side. The remaining unknowns
are all implementation: how the agent proves which bucket a change lands in
(diff-path classification is the plan, but it needs to fail CLOSED — an
unclassifiable change is a PR, never an auto-deploy), and whether the PR bucket
should also run against production data the way §4's diagnostics do.

---

## 7. If you build it, build it in this order

1. **CI first** — `.github/workflows/verify.yml` running `npm run verify` on PRs.
   **This still does not exist.** Everything below depends on it, and it is
   independently valuable — `npm run verify` has only ever run on Alex's machine.
2. **Tier 0** — diagnose-and-explain in the existing assistant.
3. **Tier 1** — the agent workflow + PR creation, triggered from the Updates page.
   Build the PR bucket FIRST even though Tier 2 is the agreed destination: it is
   the same pipeline minus the deploy step, and it earns the track record that
   makes auto-deploy defensible.
4. **The revert button + month-close block** — before the first auto-deploy ever
   fires, not after. Both are cheap, and shipping the auto bucket without them is
   shipping Tier 3 by accident.
5. **Tier 2** — turn on auto-deploy for the cosmetic bucket only, with the
   classifier failing closed.

Sequencing note: steps 4 and 5 are the only ones that can hurt production, and
step 4 is the one that makes step 5 recoverable. Do not reorder them.

Related reading: `docs/HANDOFF.md` §4 (production diagnostics — the technique the
agent would need to imitate and probably can't), §7 (why re-reports mean
re-interpret, not re-code).
