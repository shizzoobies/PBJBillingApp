# Scoping: letting Brittany push an update herself

Written 2026-07-25. **Nothing here is built.** This is a decision document for
the "emergency — Alex isn't available, let me try to fix it myself" button:
Brittany describes what she wants from inside the app, and an AI does roughly
what the dev chat does — writes the code, verifies it, ships it.

Verdict up front: **the plumbing is ~60% there, and a genuinely useful version is
realistic. The version that pushes to production unsupervised is not — and the
reason is evidence from this repo, not caution in the abstract.**

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

### Tier 2 — narrow auto-deploy
Only an allowlist: copy, labels, colors, thresholds. Auto-rollback on a failed
`/health`. Worth revisiting once Tier 1 has a track record.

### Tier 3 — full autonomy
I'd argue against, and would say so again if asked to build it. See §4.

---

## 6. Open questions for Alex

1. Does "push an update" mean **merged and live**, or is **"a PR is waiting for
   you"** enough of a win? (This is the whole design fork.)
2. Spend ceiling per run / per month?
3. Should it hard-block near month-end close, mirroring `planned_not_eom`?
4. Who reviews when Alex is genuinely unreachable — does Brittany get a merge
   button, or does it just queue?

---

## 7. If you build it, build it in this order

1. **CI first** — `.github/workflows/verify.yml` running `npm run verify` on PRs.
   Independently valuable; everything else depends on it.
2. **Tier 0** — diagnose-and-explain in the existing assistant.
3. **Tier 1** — the agent workflow + PR creation, triggered from the Updates page.
4. Live with it before considering Tier 2.

Related reading: `docs/HANDOFF.md` §4 (production diagnostics — the technique the
agent would need to imitate and probably can't), §7 (why re-reports mean
re-interpret, not re-code).
