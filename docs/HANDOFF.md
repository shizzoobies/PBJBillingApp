# Handoff — PBJBillingApp

Written 2026-07-21, last updated 2026-07-25. Everything below is live on `main`;
the working tree was clean at handoff. Read this top to bottom before your first
change — several rules here are non-obvious and breaking them has caused a
production outage before. **If you do only one extra thing, read §7's
"queue-run contract": the Updates tracker is now the primary way work arrives,
and it has rules.**

---

## 1. What this is

A time-tracking / recurring-checklist / billing app for **PB&J Strategic
Accounting**, a bookkeeping firm. Deployed at **app.pbjsa.com** (Railway).

**The people** (this matters — the ids are misleading):

| Who | User id | Role | Notes |
|---|---|---|---|
| Alex Anderson | `emp-alex-anderson` | owner | The developer/user you talk to |
| **Brittany Ferguson** | **`emp-patrice`** | owner | **The real end client.** Feature requests come from her via Alex |
| Lisa Mockabee | `emp-a41095f0` | bookkeeper | ~31 assigned clients |
| Allison Lehmann | `emp-41def8a0` | senior_bookkeeper | ~10 assigned clients |

Alex relays Brittany's feedback, often as tracker items pasted verbatim. **When an
item says "not approved" or "still not working", it has usually been shipped once
already and the problem is interpretation, not code.** See §7.

---

## 2. Architecture cardinal rules

**Stack:** React 19 + TypeScript + Vite (`src/`), plain-Node `http` server
(`server.js`, no framework), dual-backend `db/store.js`.

1. **`db/store.js` has TWO backends** — Postgres when `DATABASE_URL` is set,
   JSON-file otherwise. **Any persisted change must touch BOTH.** Tests run on the
   file backend; production is Postgres, so a Postgres-only bug passes CI silently.

2. **`docs/capability-manifest.md` is load-bearing.** It's the AI assistant's
   knowledge base. Update it with every user-visible feature change, and when you
   do, **re-provision the voice agent after deploying** (§3).

3. **`npm run verify`** = `eslint` + `tsc -b && vite build` + `vitest`. Green
   before every push. Currently **542 tests / 53 files**.

4. Prefer targeted endpoints over the bulk save. `PUT /api/app-data` (the bulk
   workspace save) is **owner-only (403 for staff)** — anything staff must do
   needs its own endpoint.

---

## 3. The ship ritual (follow exactly)

```bash
npm run verify                      # must be green
git add <files> && git commit       # trailer below
git push                            # Railway auto-deploys main
```

Then poll the deploy, health-check, and (only if the manifest changed)
re-provision the voice agent:

```bash
# deploy status — poll until SUCCESS
npx @railway/cli@latest deployment list --service PBJBillingApp --json

# health (expect 200)
APP=$(npx @railway/cli@latest variables --service PBJBillingApp --json \
  | node -e 'const v=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(v.APP_PUBLIC_URL)')
curl -s -o /dev/null -w "%{http_code}\n" "$APP/health"

# ONLY when docs/capability-manifest.md changed:
#   export ELEVENLABS_API_KEY / ELEVENLABS_AGENT_ID / APP_PUBLIC_URL / VOICE_TOOL_SECRET
#   from `npx @railway/cli@latest variables --service PBJBillingApp --json`, then:
node scripts/provision-voice-agent.mjs
```

Commit trailer:

```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## 4. Production diagnostics — the highest-value tool here

**This has caught more real bugs than any other technique.** Repeatedly, code that
passed lint + build + tests was still wrong against real data. Use it.

Get a connection (read-only work needs no permission; see the write rule below):

```bash
# Run from the repo root. NODE_PATH is needed because these are throwaway
# `node -e` scripts outside the package, so `require('pg')` won't resolve.
export NODE_PATH="$PWD/node_modules"
DBURL=$(npx @railway/cli@latest variables --service Postgres --json \
  | node -e 'const v=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(v.DATABASE_PUBLIC_URL)')
# then: new Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false } })
```

**Two patterns:**

- **Reproduce engine logic against prod data.** Re-implement the function you just
  wrote in plain JS over real rows and print what the user will actually see.
  This is how the "never generates" detector and the payroll by-day/by-job report
  were validated before shipping.
- **Rolled-back write QA.** `BEGIN` … do the exact UPDATE/INSERT your store method
  issues … `ROLLBACK`, then re-select to prove nothing changed. This caught a
  foreign-key violation (writing `client_id = ''` instead of `NULL`) that would
  have shipped.
- **Diff what different ROLES see.** When someone reports "my numbers don't match
  hers", re-implement `scopeAppDataForSession`'s filter over real rows and print
  owner-visible vs member-visible side by side. That is how the group-time bug
  (`a365270`) was found and how the fix was proven — the totals went from
  97 vs 102 to matching exactly. Any "X sees different data than Y" report should
  start here.

**Rule: any write that is NOT rolled back needs the user's explicit approval
first.** A past bulk write took production down (see `.omc/` notes / memory
"Plan-refs Outage"). One approved backfill was done this session (177 rows) —
snapshot first, single transaction, re-verify after.

**Schema surprises** (the app-shaped names differ from the columns):
- `time_entries`: `user_id` (not employee_id), `entry_date` (not date),
  `started_at` / `ended_at`, `sessions` jsonb NOT NULL, `client_id` **FK — must be
  `NULL`, never `''`** for administrative time.
- No `employees` table — team members live in **`users`**.
- Template stages/items are separate tables (`checklist_template_stages`,
  `checklist_template_items`), not a column on `checklist_templates`.
- `clients` has only `assigned_bookkeeper_ids` — the ONE source of truth for a
  client's assigned team, and the only thing `visibleClientIdSet` reads.
  `assignedEmployeeIds` is a derived alias of it with no DB column.
  `client_assignments` is nothing **read** — but not yet nothing written:
  `write()`'s `delete from clients` (`db/store.js:4369`) still cascades into it
  (`client_assignments.client_id references clients(id) on delete cascade`,
  `db/schema.sql:80`), and the orphan cleanup at `db/store.js:8430` still
  targets it directly. Both go away in batch 2, which is when the table
  actually becomes inert. See
  `docs/plans/client-assignment-single-source-2026-08.md`. Owners may appear on
  an assigned team — it grants nothing, they see everything.

### Printing — run the print check, `npm run verify` cannot see it

Printing (invoices, and the assistant's "Save as PDF") works by hiding the app
and showing a hidden sheet. **jsdom is structurally blind to both ways that
breaks**, so vitest passes while the printout is blank or doubled:

- A sheet rendered inside `#root` can never be shown while the print CSS hides
  `#root`. Both sheets are therefore `createPortal`ed to `<body>` — if you ever
  "tidy" one back inline, it prints blank.
- `#root { min-height: 100vh }`, and in **paged** media `vh` is the PAGE box —
  so hiding only `#root`'s contents still costs a full blank leading page. Only
  a page count catches this.

```
npm i -g playwright && npx playwright install chromium
PLAYWRIGHT_MODULE="$(npm root -g)/playwright/index.mjs" node scripts/check-print-pdf.mjs
```

It renders the real `src/App.css` in Chromium, takes a `page.pdf()` for each
mode, and asserts one page with only that mode's sheet on it. Playwright is
deliberately **not** a dependency and this is **not** wired into
`npm run verify` (which stays jsdom-fast); without Playwright the script skips
with instructions rather than failing. Run it by hand after any print change.

---

## 5. Where things stand (newest first)

**2026-08-22 — AI confidence ratings on invoice review, and the learning corpus
that makes them improvable.** Plan of record:
`docs/plans/invoice-confidence-2026-08.md` — read it before touching any of
this; the four product decisions at the top (advisory-only, skippable
at-approve questions, auto-rate + re-rate, shipped live) were made by Alex via
structured questions and are settled.

What it is: after Generate, `claude-opus-5` (env `INVOICE_AI_MODEL`) reviews
each monthly draft — arithmetic against the month's tracked hours,
plan-vs-hourly consistency, coverage windows, adhoc dispositions, month naming,
month-over-month anomalies — and stores a verdict: band + score, ≤4 concerns,
≤3 questions for Brittany. A badge sits beside the scope-flag chips; the
expanded editor shows the card; Mark reviewed surfaces unanswered questions
once, skippably (Answer & approve / Skip & approve — approval is NEVER
blockable). Her answers persist and feed future ratings; her edit diffs are
captured automatically. The trust-ladder framing matters: this is the
measurement that the plans' "bulk-send once trusted" gate was missing. No
automation of any kind ships here — the rating is a read-only annotation that
never touches `lib/invoice-lines.js`, statuses, or sends.

New persistence (both backends, endpoint-managed, NO FK to invoices, out of
the bulk save and the staleness fingerprint): `invoice_review_events` (her
edit/status diffs, captured inside `updateInvoice`'s transaction with
`opts.actorUserId` from the session) and `invoice_ai_reviews` (rating history,
supersede-on-insert under a per-invoice `pg_advisory_xact_lock`). Plus
`invoices.original_line_items` — write-once snapshot at insert, all six touch
points including the bulk-save round-trip. DDL was validated against
production with the rolled-back probe before ship.

Build shape worth knowing: four parallel agents (store / lib / server / UI) on
disjoint files against contracts pinned in the plan doc, then an adversarial
review pass — which found the feature's learning half silently inert (the
corrections corpus collapsed to bare month strings before reaching the model),
a supersede race, an unguarded answer write, and a non-monotonic poll merge.
All fixed and tripwire-tested. The residual accepted trade-offs are recorded
in the plan doc and the review: double `broadcastDataChanged` on the two POST
routes (house pattern), and "Rating…" showing ~3 min in a keyless local dev.

Where the pieces live: `lib/invoice-confidence.js` (the call + schema + prompt;
`modelFallback: false` deliberately), `server.js` `rateInvoiceAndPersist` /
`scheduleInvoiceRatings` (one workspace read per batch — `read()` is NOT pure,
it can enter the materializer's bulk-save write-back), the three
`/api/invoices/*ai-review*` routes (above the `/api/` catch-all, pinned by
tests), `src/components/InvoiceMonthRun.tsx` (badge, card, at-approve panel,
bounded 5s/3min poll). Suite 2139 → **2260 tests / 132 files**.

**2026-08-21 — an unmatched `/api/` path now 404s instead of returning the SPA.**
Salvaged out of the `festive-hermann` worktree during the housekeeping pass
below, where it had been sitting uncommitted and unshipped.

The bug it closes is a quiet one. Every `/api/` route is matched on path AND
method and returns; anything unmatched fell through to the static handler and
was answered with the SPA shell — **200 + HTML**. `response.ok` is `true` for
that, so a typo'd or renamed endpoint did not fail at the call site. It failed
later and somewhere else, when something tried to parse HTML as JSON. Nine
lines at the end of the router turn it into an honest 404.

The test that came with it (`src/__tests__/api-404-fallthrough.test.ts`) pins
the thing that will actually rot: **position**. A catch-all is only as correct
as its placement, and a route added below it would answer 404 forever while
every unit test still passed. The second assertion scans for any `/api/` route
matcher below the guard and names it. Verified as a real tripwire — both
assertions fail against the pre-fix source, not just pass against the new one.

Note the routing style here: `server.js` listens at module scope and exports
nothing, so there is no HTTP harness. These are source-reading tests, same
shape as `waiting-lock-routes.test.ts`. Don't delete one as "not a real test" —
it is the only thing guarding the glue.

**2026-08-21 — PICKING THIS UP NOW: state, and what's actually left.** Written
after a full re-read of the tree, the tracker, the deploy list and production.

**Where things are.** `main` is `3dc6ab9`, deployed SUCCESS, `/health` 200, tree
clean. Suite **2137 tests / 128 files**, all passing. **The build queue is
empty**: three items are open and every one of them is parked behind a gate
(below), and four items sit in Shipped waiting on Brittany. So the next session
is most likely *responding to her review*, not starting a build — check the
tracker first, because she reviews live and it moves while you work.

**THE BIGGEST CHANGE: this app now moves real money.** Stripe went live on
2026-08-18 (`dba2ff2`), and it has been exercised for real — Alex paid two live
invoices himself, one ACH and one card, and both settled correctly.
`INV-2026-08-002` ($10.00) and `INV-2026-08-003` ($10.61) are in `processing`;
`INV-2026-08-001` ($15.00) is void. What that changes for you:
- **A send is irreversible.** There is no sandbox left to practise in. Anything
  that generates, sends, voids or credits an invoice is a production money
  action — treat it like a prod write: Alex's explicit yes, and know the undo.
- **Test on the `Test` client**, never a real one, and say so in any instruction
  you give Brittany.
- The `/health` endpoint now names the Stripe mode (`6768b1b`) — use it rather
  than assuming.

**What's actually left (all three are gated, none is "just start it"):**
1. `featreq-79b6d974` **engagement-to-billing** (in_progress, low). Needs a
   PLANNING SESSION with Alex — it reshapes navigation for everyone. Plan of
   record: `docs/plans/billing-and-engagements-2026-08.md`, but note its Track B
   ("prep packet") was **superseded** by the real invoicing that shipped —
   read `docs/plans/invoicing-in-app-2026-08.md` and
   `docs/plans/invoicing-handoff.md` first so you don't re-plan a solved
   problem.
2. `featreq-15ff79f7` **Brittany pushes her own update** (planned_not_eom). Tier
   0 shipped (`3b0c154`); Tiers 1–5 remain in the decided order. Policy is
   locked — build only, do not re-open the questions.
3. `featreq-ef7f4e35` **TOTP encryption at rest** (planned_not_eom). Blocked on
   ALEX generating and durably storing `TOTP_ENC_KEY`, then BOTH owners
   re-enrolling. **Claude must never handle that key.** Setting the Railway var
   redeploys — treat it as a push, and not during a Railway incident.

**Waiting on Brittany (do not chase, but be ready):** the four Shipped items —
retainer invoicing (`951595c2`), reimbursed-expense auto-advance (`fe3f8b0f`),
the Recap rework (`926862e2`) and the payroll-rounding rework (`7c8f64d7`).
Alex has a what-to-check email for the first two at
`docs/client-emails/2026-08-brittany-what-to-check.md`. **Open questions she
owes an answer on:** whether a retainer credit should FREEZE at the amount paid
or keep re-sizing with the invoice total (raised in that email); the
recurring-pile picker question; the step-deletion wait warning; and the card
fee / surcharge decision.

**Known residuals — real, documented, none blocking:**
- **`time_entries` still takes `created_at` from the client payload** — the same
  stale-tab-rewrites-history hole that was closed for nine other tables in
  `420c823`. The one remaining payload-trusting timestamp in the bulk save.
- **Batch 2 of the client-assignment unification is not started** (archive +
  drop `client_assignments`, remove the cascade and the orphan cleanup in
  `db/store.js`). Batch 1 is live; `assigned_bookkeeper_ids` is the single
  source that gates visibility. See the client-assignment memory before touching
  it — the divergence evidence is probably already gone; ask Alex rather than
  re-running the report.
- **Preview mode still leaks endpoint-managed lists** — previewing a staff
  member shows the OWNER's "Waiting on you" card, because `/api/waiting-on-me`
  scopes to the session caller. `itemDeletionRequests` / `pendingTaskEdits`
  share the pattern.
- **Materializer write-back guard has two documented gaps** — file-backend
  slices outside the fingerprint, and the GET-side version/data ordering.
  Production is Postgres, so neither bites today.
- **A structural one worth a deliberate pass:** three separate data-loss bugs
  (minutes precision, invoice drafts, creation dates across nine tables) were
  all the same shape — the bulk save's wipe-and-reinsert dropping a column
  nobody checked. A test that asserts every wiped table round-trips EVERY column
  would end that family instead of discovering them one client complaint at a
  time.

**Housekeeping — DONE 2026-08-21, and it was not what this section predicted.**
Three of the four worktrees were removed (~291 MB; `intelligent-kowalevski`
alone was 273 MB). Two of the four turned out to be holding UNCOMMITTED work,
not stale build output, so read before you delete:

- `relaxed-jang-4dd8ba` — an earlier draft of the print fix. Genuinely
  superseded: main's shipped test asserts the identical thing
  (`assistant-report-print.test.tsx` → `parentElement).toBe(document.body)`).
  Removed.
- `festive-hermann-c3c7e5` — held a real, unshipped `/api/*` 404 guard. It has
  now been salvaged onto main (below); the worktree can go.

**Correction — do NOT delete `hold/july-security-p3`.** The claim above that it
was fully superseded is wrong, and acting on it would have destroyed work. Its
security half DID land (TOTP encryption-at-rest, `useDocumentTitle`, the
favicon, `totp-encryption.test.mjs` are all in main), but
**`src/components/Skeleton.tsx` and `src/hooks/useToast.tsx` are not** — main
has no general toast primitive, only two purpose-built ones
(`NewVersionToast`, `StaleWorkspaceNotice`). That branch is the only copy of
the skeleton loaders and the toast primitive. Alex's call (2026-08-21): leave
it. Note the polish is also UI Brittany never asked for and has not reviewed,
so adopting it is a product decision, not a cleanup.

The `railway-backlog-2026-08-18` memory's exit condition is met (SUCCESS on
`3dc6ab9` supersedes the whole stuck queue) — it has been deleted.

**2026-08-18/19 — the sent-back queue run + Brittany's review night.** Two days,
ten feature deploys, suite 1834 → **2130 tests / 126 files**. Brittany reviewed
LIVE through this run — moving items Shipped→Done, sending items back with
"sent you email" notes, answering clarification questions on the tracker
(that channel works: `clarification_question`/`clarification_answer` columns),
and filing new items. Assume the tracker moves while you work. Her review
emails go to alex@ka-performancefl.com (the Gmail connector's account); the
personal asoalexander@gmail.com is what the local Chrome is signed into —
forwarding between them (with Alex's OK) is the proven way to read attachments,
because some other Chrome extension holds the debugger and screenshots/JS
mostly fail (read_page always works). Railway had a
declared incident on the 18th (deploys stuck QUEUED 20–50 min, two FAILEDs with
empty build logs) — recovery that works: push the next ready commit to supersede
a stuck QUEUED entry; `redeploy` is refused while one is queued. Every tracker
flip stayed gated on deploy SUCCESS + `/health` 200.

| Commit | What |
|---|---|
| `326b48b` | **Timesheet submit button disables with a reason** (featreq-cbb7efe8): `submitTimesheetButtonState()` in `src/lib/timesheetSubmitPlan.ts` — one predicate for both submit surfaces (TimePage widget + TimesheetPage controls), disabled exactly when the plan has no target, reason quoted from the VIEWED week. Deliberately enabled: sent-back weeks (resubmit path) and settled-week-viewed-while-older-owed (tooltip names the week the click sends). Duplicate submits were already impossible — `unique (user_id, week_start)` confirmed present on prod (`weekly_submissions_user_id_week_start_key`); the upsert is now pinned on both backends. Investigation note: the old button never double-submitted — the modal shrugged; the defect was the button lying about clickability. |
| `55a9fe2` | **Waiting lifecycle** (featreq-8b7d06d7 + b05a2f3a, from Brittany's annotated "done button" email): draft with Save/Clear → one atomic create → EVERYTHING locked (who/message/task; `waitingLockRefusal` + `waitForTaskLinkDenial` in `lib/waiting-on-state.js`, shared server/UI); Question button (Delayed + step chip; `questions[]` append-only beside `sendBacks[]`; `waiting_on_question` event); A's awaiting-OK view is Approve/Send-back only; `planWaitingDone` deleted. Permanence made STRUCTURAL: `preservedNodeWaits()` in `write()` preserves waits from stored rows on the bulk save. |
| `9328f0c` | **Recap rework** (featreq-926862e2, from her marked-up PDF): the page IS the comparison — per-role ESTIMATE\|ACTUAL\|OVER/UNDER tables for hours and profit with exact Total rows, Yearly period (`lib/periods.js` `'year'`, `MONTHS_IN_PERIOD`), Tasks last, bolt-on panel deleted, staff payloads redacted of estimates (`estimatesVisible`). Multi-month Billing captions "today's rates" — NO rate history exists. |
| `fc7119f` | **Payroll rounding, third and final** (featreq-7c8f64d7, HER rule verbatim: 2dp hours × rate): `displayHours()` is both the printed and the costing hours; every Hours/Cost column sums its displayed rows; detail rows are a largest-remainder split of person-period pay; firm-analytics/assistant quote the same 2dp hours; Raw CSV stopped double-charging full-mode repeats. |
| `54ff1cc` | **Reimbursed-expense auto-advance** (featreq-fe3f8b0f): coverage verbiage set once, window advances per generation, `coverage_history` ledger is the one truth (gate derived server-side, send route enforces, void releases the period, anchor day follows a confirmed end). Skip/pause-resume/backfill ASK; consecutive is hands-off. Rebased over the chip commits (kept both protections + interaction suite). |
| `cf6a0d6` | **Wait-for-task picker** (featreq-5dd514b8): same-client filter existed since June — the real fix is offerable-vs-resolvable (`src/lib/waitForTaskOptions.ts`): offers only visible+unskipped, but a saved link to a recycled/skipped/cross-client task always renders (labeled with client name) and stays clearable. |
| `190333a` `26b0ef8` | **Board scoping** (active-on only + "Show my bookkeepers" toggle) and **waiting permanence** (no deletion path; Done agrees with the chip; no self-waits) — see the queue-ships memory for the full story. |
| `22c55ce` `1c3b61b` `aec01f9` `d3a386a` | The three chip sessions landed mid-run (firm-analytics labor cost; owner-preview scope leak — preview now sees what THEY see; materializer write-back guard). The rebase of `54ff1cc` over `d3a386a` is where the coverage-preserve and the write-back guard were reconciled. |

**Facts settled (do not re-derive):** Brittany pays 2dp hours × rate — "the
staple for all comparisons" (her words, on the tracker); a wait names another
employee or the client, never yourself; lock-at-save reverses the editable-note
scope on her explicit email. **Open with her:** the recurring-pile picker
question, step-deletion wait warning, card fee/surcharge. **Open with Alex:**
featreq-79b6d974 engagement-to-billing needs a planning session.

**If you are picking this up fresh:** the queue is EMPTY as of `326b48b` —
every tracker item is shipped/done/needs-input except the parked ones above.
The working pipeline that produced this run, in one line: flip item
in_progress → Opus executor (background) → Opus code-reviewer (they find real
blockers on most money/permanence diffs — do not skip) → fix pass → rolled-back
prod validation for any NEW SQL shape → `npm run verify` → commit (message
style: statement-of-behavior first line, no conventional-commit prefix) → push
→ background watcher polls the PUSHED hash to SUCCESS → `/health` 200 → flip
tracker to shipped with dev notes written TO Brittany in her language → voice
re-provision if the manifest changed. Tracker writes have standing approval;
real prod writes need Alex's explicit yes + an undo snapshot (see the
prod-write-log memory).

**2026-08-09/10 — the invoicing ship run.** One long session with Alex actively
testing as features landed: I4 finished, then five follow-on features, then a
queue item — eight deploys, all verified live (deploy SUCCESS on the pushed
hash → `/health` 200 → manifest + voice re-provision on every user-visible
change). Suite grew 975 → **1021 tests / 78 files**. Read
[`docs/plans/invoicing-handoff.md`](plans/invoicing-handoff.md) for the
invoicing state; the short version:

| Commit | What |
|---|---|
| `525673a` | **Weekly gate allows past-week backfill** (queue `featreq-cf658ebd`, shipped + stamped). `listBlockingWeeks` gains a REQUIRED `todayWeekStart` (throws if omitted); an entry in a week that already ended never gates. Current/future weeks gate as before; month locks untouched. |
| `a9461d8` | **Invoice History**: "This month / History" switch on the Invoices page; months collapsible newest-first with billed/paid/outstanding (voids excluded, **processing counts as outstanding** — pinned by tests); Year/Client/Status filters; read-only rows + "Open in month run". The month view HIDES (never unmounts) under History so unsaved editor work survives; the months-change confirm names the month holding edits. |
| `3362519` | **Month run tabbed**: To review / Reviewed / Sent / Paid / Voided on the shared `.task-area-tabs` underline bar (NOT a new copy), amber dot on tabs holding flagged invoices, dirty-editor confirm on tab switch, number order within tabs, no auto-follow when an invoice changes tab. |
| `07235b8` | **Void & regenerate** (voids ONLY draft+reviewed of the period — validated against prod in a rolled-back txn — then rebuilds; confirm re-fetches counts) + **single-client generate** offered by Email invoice when no live invoice exists. Hardening: `recordInvoiceSent`/`applyInvoicePayment` refuse voided invoices (send/payment landing after a bulk void was a unique-index 500 after the email left). |
| `517a620` | **Per-client "Email invoice" really sends** (mailto path deleted). Gates: month generated → not void → reviewed; confirm; sends via the I4 rail. Customize is PRINT-ONLY and Email is disabled while it is open. |
| `08b77d8` | **I4 part 2**: `POST /api/invoices/:id/send` + Send button in the month run. Fresh Checkout link per send but NEVER on a paid/processing invoice (double-pay guard); post-delivery bookkeeping failures still return 200; email log records the billed total; recordInvoiceSent got its first tests. |

**Facts settled this session (do not re-derive):** the full rail is PROVEN —
Alex sent his Test-client invoice, received the email (from
`billing@pbjsa.com`; `INVOICE_EMAIL_FROM` is set in Railway), paid via sandbox
ACH, and both webhooks passed signature verification (`INV-2026-08-001` sits
`paid` in prod — Brittany may want it voided before real August billing).
**Successful payments notify nobody by design** — only a failed debit notifies
owners. One client per send is the recipient rule and the code guarantees it.

**Open DECISIONS (Alex's/Brittany's — don't build unprompted, don't re-ask as
if new):** (1) card payments — ACH-only is deliberate (US debit-surcharge law);
options on the table: no-fee card / flat convenience fee once confirmed
compliant / stay ACH-only; (2) a "payment received" owner notification for when
real money lands; (3) whether emailed invoices should carry Customize's
intro/footer (print-only today).

**Small deferred items from reviews, none blocking:** the draft-send gate is
UI-only (the send endpoint will send a draft if called directly); `storedPrint`
stays sticky after a History print (pre-existing); `priorByClient` adjustments
are dormant until adjustment carry-forward is wired; the assistant's time
diagnostics answer "can they log time TODAY" only. Testing note: happy-dom has
no `window.confirm` — use `vi.stubGlobal('confirm', vi.fn())`
(see `src/__tests__/invoice-month-run-dirty-guard.test.tsx`).

**2026-08-04 — the time-accuracy run.** One session: released the parked
month-close branches, then a full audit of the time pipeline ("exact to the
minute, every entry individual") and fixes for everything it found. All
deployed and verified live; details in the tracker items' dev_notes.

| Commit | What |
|---|---|
| `b7ce60e` | Released the parked branches: **bulk-save staleness guard** (X-Workspace-Version echo, 409 on stale tabs — closes the June-import wipe vector, un-gates the re-import), **CI** (verify on every push/PR), **client-create endpoint** (featreq-decb29e3; unblocked featreq-89b71f05). |
| `ec4bcba` | **Seconds-exact minutes survive.** sanitizeAppData rounded minutes to integers and the owner-tab bulk save reinserts every entry through it — every autosave rounded the whole table (501/673 prod rows drifted). One shared `coerceEntryMinutes` (snap to the second) now serves sanitize + PATCH; fresh-install schema is numeric. |
| — | **Approved 537-row backfill**: restored every artifact row to its exact sessions-derived minutes (+84.6 min firm-wide). Undo snapshot COMMITTED at `docs/prod-snapshots/2026-08-04-minutes-backfill.json` (`e8b7c05`) — first durable one. |
| `492a09c` | **Atomic server-side splits** (`POST /api/time-entries/:id/split`, FOR UPDATE in PG, both backends): slices inherit the block's sessions/envelope verbatim (Raw report shows in/out for splits — featreq-98821327), splits hit activity_log, custom allocations must balance to the second (modal shows remainder + auto-balance), new `group_allocation` column. Killed the client-side create-loop-then-delete that could double entries on mid-sequence failure. |
| `db852e6` | **Reports exactness**: hours-report detail lists EVERY entry individually with clock-in/out (collapsed view survives only as the "summary" CSV); full-mode group blocks count once in tracked hours/cost (billable per-slice by design — `src/lib/payrollAggregation.ts`); Cost column added to the overview employee table (the featreq-55212377 answer — it was only ever missing THERE). |
| `4c8e9bd` | Time-task picker offers all standard blueprints + free typing via taskLabel (featreq-28170ae5); approvals page tabbed (featreq-ce7161e0). |
| `5a2ade7` | **Split ANY client entry across clients** (featreq-96afce66, urgent, same-day): "Split across clients" on the edit form + entry row, checkbox client picker, same seconds-exact atomic path; internal stays internal, administrative refused, one-client redirects to the edit dropdown. |

Key facts settled by the audit: the Jul-23 "duplicate" entries were TWO real
work rounds (Brittany confirmed — nothing deleted); `full` allocation mode
deliberately bills each client the whole block, and payroll now counts it once
(Alex's ruling). Historical split slices (23 groups) can never recover in/out —
that data died at split time. Machine-local memory: `time-accuracy-audit-2026-08.md`.


**2026-07-26 — the bulk-save staleness guard: BUILT, VERIFIED, NOT DEPLOYED.**
Lives on the branch **`guard/bulk-save-staleness`**, deliberately not merged —
Alex parked it because it is month close. Tracker item **`featreq-f7d50027`**
(EOM lane, high). It is the gate on the historical re-import
(`featreq-deef43f1`), which is cross-referenced to it.

`GET /api/app-data` returns an `X-Workspace-Version` fingerprint; the tab echoes
it on `PUT`; `store.write()` re-checks it **inside its own transaction** and
throws `StaleWorkspaceError` on mismatch → 409, nothing written. Client latches a
blocking "This tab is out of date" notice and **stops the 4s retry loop**.

Three findings that shaped it, worth keeping:

1. **`read()` writes.** The materializer write-back means fingerprinting through
   `read()` would be re-entrant during a PUT and nondeterministic. The digest
   reads persisted state directly instead (`lib/workspace-version.js`).
2. **`activity_log` is trimmed to 200 rows per user.** Logging every autosave —
   as originally planned — would evict a session's real activity and break
   ProductivityPage's `checklist_item_checked` stats. Accepted saves go to the
   server log; only refusals go to `activity_log`.
3. **15 concurrent digest queries cost ~1.3s** and grabbed most of the pool on
   every page load. Collapsed to one `union all` (~200ms warm over the public
   proxy from a laptop).

Verified: `npm run verify` green (**568 tests / 55 files**, up from 542/53).
Against prod in a rolled-back transaction the fingerprint was stable on repeat,
moved on a one-column edit and on a deleted time entry, restored on undo, and did
**not** move on a bare `updated_at` touch (718 entries intact after rollback).
End-to-end on the file backend the June wipe was reproduced: the stale tab's save
over a 50-row import was refused and all 54 entries survived; the same payload
with a current token wipes it back to 4.

Risk measured for EOM: bulk saves are **infrequent** — all 549 checklists carry
`created_at = 2026-07-24` (`write()` restamps it), so the last one was two days
before this was written. The materializer was probed read-only with `write`
stubbed: three consecutive `read()`s, zero write-backs. Next wave is Aug 1
(spawn gate is `nextDueDate <= today`).

⚠️ **On the day this merges:** version-less PUTs are refused by design (Alex's
explicit call), so **hard-refresh both owner tabs immediately after deploying** —
because bulk saves are rare, an un-refreshed tab could otherwise be ambushed days
later and lose an unsaved edit. The manifest changed, so re-provision the voice
agent. Optional easy follow-up: skip the fingerprint for non-owners (staff can
never PUT), removing its cost from most page loads.

**2026-07-25 (later) — Updates tracker: notifications + a tabbed layout.**
Four deploys, all verified live:

| Commit | What |
|---|---|
| `04d53cb` | **"Updates tracker activity" email preference** (Brittany asked to follow the tracker). Two new events — `update_created`, `update_status_changed` — grouped under an 8th `updatesTracker` toggle. The tracker had NO notifications before this. Each owner is notified about **the other's** activity, never their own, and only on a real status MOVE: the PATCH endpoint snapshots status before the write, so a retitle / re-rank / dev-note edit sends nothing. Messages use human labels ("Shipped → Planned") via `UPDATE_STATUS_LABELS` in server.js, and include the review note. Best-effort — a dispatch failure is logged, never breaks the write. The prefs UI renders the server catalog, so no frontend change was needed. |
| `a08c3ac` | **Status TABS replace the collapsible sections.** An accordion only shows the size of what you've opened; tabs show every count at once. `collapsedStatuses` → a single `activeStatus`. Empty statuses keep their tab (a `0` is real signal); "Hide Done / Won't do" removes those tabs, and the active tab is **derived** with a first-tab fallback so hiding the tab you're on can't strand you (derived, not an effect — no flash). "Expand all"/"Collapse all" removed. Drag-to-rank was already guarded to same-status reorders, so a one-status view fits it better than the accordion did. |
| `81c29a4` | Tabs restyled from pills to an **underline bar** (Alex: "not pills, more premium") — hairline rule, 2px active underline sitting *on* the rule, counts as quiet tabular-nums text. Empty tabs dim to 55%. Uses its own `.updates-tabs` rather than restyling the shared `.stage-segment`. |
| `847a329` | Active tab takes the brand **`--pink` (#ff43a4)** — label, underline and count — plus the Shipped panel caption, which was still on the old violet. Selection is still carried by the underline too, never hue alone. |

⚠️ **The Clients page stage filter (`.stage-segment`) is still pills** — Alex has
now twice said he dislikes pill styling, so bringing it in line with
`.updates-tabs` is a likely next ask. Deliberately left alone to avoid restyling
a page he didn't mention.

**Also this session (not code):** scoped the "let Brittany push an update
herself" idea → **[`docs/autonomous-updates-scoping.md`](autonomous-updates-scoping.md)**.
Nothing built; it's a decision doc with the tiers, costs, risks and open
questions. Read it before picking that thread up.

**2026-07-25 — per-user email notification preferences** (queue item
`featreq-9819cd2c`, filed after Lisa got emailed about another user's
completed task). Shipped in two deploys, both verified live:

| Commit | What |
|---|---|
| `b6ae293` | **Per-user EMAIL notification toggles.** `lib/notification-prefs.js` is the single source of truth: a catalog of 7 toggle types grouping the notify() events (task assigned, workflow progress, waiting-on updates, time entries needing approval, time sent back, deletion requests, edit requests). Prefs live as a **sparse jsonb map on `users.email_notification_prefs`** — missing key = ENABLED, so new types default on (both store backends; the prod column is created by `initialize()`). `GET/PUT /api/me/notification-prefs` for any signed-in user; `notify()` consults `isEmailEnabledForEvent` before the email side only — **bell notifications are never gated**. UI: `EmailNotificationPrefsSection` on the Notifications page (every user — staff have no Settings page) and on owner Settings. `invoice_ready` deliberately has NO toggle (event is wired but unused; unmapped events always send — add its toggle if the invoice cron ever ships). Validated with a rolled-back prod transaction (DDL + jsonb update + roster select) before pushing. |
| `487ac74` | **Discoverability follow-up (Alex-requested):** bell dropdown footer gains an "Email preferences" link → `/notifications#email-prefs`; the section moved to the TOP of the Notifications page, above the inbox; `CollapsibleSection` gains a `forceExpand` prop (transient — expands for the deep link without overwriting the user's stored collapse preference; implemented as a render-time state adjustment because `react-hooks/set-state-in-effect` rejects the effect version). |

Lisa's specific fix is unticking **"Workflow progress"** — nobody's prefs were
changed server-side; all types start ON. If someone says "I turned it off but
still see it in the app," that's by design (toggles gate emails only).

**2026-07-23/24 — the Updates tracker became the dev pipeline.** Over two
days the owner-only Updates page grew from a list into a full closed-loop
system: Brittany files and reviews, Alex triages, and a Claude session ships
the queue. ~15 deploys, all verified live. The loop:

```
spitball chat → Britt's Brain → (Alex promotes) → Planned → queue run ships
  → Shipped (with date·time pill) → Brittany approves to Done
     └ or "Not approved" → AI read-back confirms her meaning → back to
       Planned carrying a [Confirmed rework spec] in review_note
Ambiguous items → needs_input + clarification_question → pinned "Needs your
  answer" panel → her answer returns it to Planned (Q&A kept forever)
```

| Commit | What |
|---|---|
| `33acdfd` | **Clarification lane**: status `needs_input` + `clarification_question/answer` columns (tri-state set/clear via explicit flags — coalesce can't express clearing); amber "Needs your answer" panel pinned above all sections; answering returns the item to Planned; the Q&A renders on the card permanently. |
| `2849d15` | **AI read-back on "Not approved"**: `confirmOwnerFeedback` (lib/assistant.js) restates her reason for HER confirmation (or asks which of two readings she means); files verbatim reason + confirmed dev-ready spec; send-backs now land in **Planned**, not In Progress. Non-AI "send back without the read-back" fallback — feedback is never blocked on the model. |
| `53de2c9` | **"Planned (not near EOM)" lane** (`planned_not_eom`): parking for changes too far-reaching to ship near month close. Queue works these only ~the 6th–23rd. |
| `f3d0051` | **`shipped_at`** stamp (re-stamped on every transition INTO shipped; boot backfill for existing rows) + "Shipped Jul 24 · 9:12 PM" pill right of Shipped titles. **Direct-SQL ships must set it manually.** |
| `042828b` | **Britt's Brain / "Just spitballing…"**: status `brainstorm` + `spitballChat` thought-partner endpoint (asks 1-3 questions/turn, offers an organized draft, saves with transcript in dev_notes). Brain items are excluded from Copy-all and queue runs (`BACKLOG_EXCLUDED`) until Alex promotes them. Includes `escapeControlCharsInJsonStrings` — models emit literal newlines inside JSON strings on multi-line content; repair pass fixes control chars inside string literals only. |
| `039a2d2` | Priority set at creation (add-form dropdown → create endpoint → both backends); waiting **Done resolves-only** (her post-use refinement: keeps the "Was waiting on" record, never checks the step off); Board: upcoming ghosts default OFF + team-member filter (generalized `BoardFilter`). |
| `d2acc18` | **"New version — refresh" toast** (`lib/appVersion.ts` + `NewVersionToast`): tabs compare the served bundle fingerprint to their own every 5 min + on tab-focus. Built after TWO stale-tab incidents (the June import wipe, and two "still broken" reports of live features). |
| `f117751` | **Modal padding at the base**: `.modal-panel` pads by default, zeroed via `:has(> .modal-body)` for the twelve nested-body modals. Audit found only spitball + the To-100% quick-fix rendered flush; future direct-content modals are safe for free. (Live-CSS greps: the minifier strips the space — match `:has(>.modal-body)`.) |
| `6240cc0` | **To 100% rework (4th iteration, finally approved-track)**: problems ONLY, organized BY TAB with green "Nothing missing" rows; the active-checklist work section is gone (regression test pins it); new Board no-column check; Billing renamed Invoices. Built against her AI-confirmed spec. |
| `f45af16` | Board **wrap grid** (`repeat(auto-fill, minmax(320px,1fr))`) — round 3 of that item: real change → stale-tab false alarm → confirmed spec. |
| `cd96a80` | Board **due/overdue/pending chips** with the waiting reason (`boardChecklistStatus` in lib/activeBoard.ts; pending = any open step waiting, same rule as Delayed). |
| `5aea50b` | **Pure timer captures auto-approve at creation** — the daily queue is only for typed time: manual entries, group-split allocations (groupId set), and post-hoc edits (edit path re-queues). Weekly/month-lock review covers the rest. |
| `ee9380a` | Owner-only **"Template" button on every client row** — the apply-template capability existed since May on the Checklists page; the request was really discoverability. |
| `e4193a7` | Waiting editor **Done** button (first version; semantics later refined by `039a2d2`). |
| `26bb6c2` | Board vertical stack (superseded by the wrap grid). |

**The historical-hours mystery was solved** (tracker `featreq-deef43f1`): the
Jan–May 2026 import (1,368 entries / 961.8h) **ran successfully on Jun 23 and
was silently erased within hours** by a stale-tab bulk save (`PUT
/api/app-data` delete-and-reinserts `time_entries` + `clients` from the tab's
snapshot; window pinned to 02:16–13:27 UTC Jun 24). Re-run assets are intact in
`D:\PBJ Accounting\Old Time\` (machine-local!). Brittany confirmed "yes, that's
what I meant." **Parked in the EOM lane with an explicit plan: ship a
bulk-save staleness guard FIRST, then re-import with Alex's approval, ~Aug 6.**
The bulk save's only guards today are malformed-payload and zero-clients — a
stale-but-populated snapshot still wipes. The refresh toast shrinks that window
but does not close it.

Also: self-contained Updates-tracker handoffs for Alex's other sites (golf
studio + nail salon, same GitHub/Cloudflare stack) live in the PARENT folder
(`D:\PBJ Accounting Work\updates-tracker-*.md`) — machine-local until he copies
them into those repos.

**2026-07-22 — two approved production DATA writes (no code).** Railway's
builders also hiccuped this day (one build failed with an internal RPC error,
the next sat in "scheduling" ~25 min until aborted + redeployed) — neither was
a code problem. The data writes, both owner-requested (Brittany, relayed by
Alex), both done as snapshot + update in one transaction:

1. **Approved Lisa's 3 June sent-back entries** (`time-01630c79` 0.43h,
   `time-67d73edb` 0.27h, `time-b8a01ab7` 0.07h; June 9–10, all rejected
   "No client"). They'd been invisible to her until `a365270`; Brittany had
   already paid them out. *Undo:* status `rejected`, by `emp-patrice`,
   at `2026-06-10T22:02:46Z` / `:39Z` / `:11Z`, notes "No Client"/"No client".
2. **Approved all 25 remaining non-approved entries dated before 2026-07-19**
   (rule: "any time before last week, even if the rejection was yesterday"):
   Allison's 5 rejected Jul-14 entries (2.01h, `client_id` NULL — rejected by
   Brittany Jul 21 with notes like "who was this for?", now permanently
   unanswered) and Lisa's 20 pending Jul-15 split slices (~0.92h). *Undo:*
   Allison's five back to `rejected` (notes/timestamps in the 2026-07-22 chat
   and machine-local memory `prod-write-log.md`); Lisa's twenty back to
   `pending` with null approver fields.

Both writes set `approved_by='emp-patrice'`, cleared `approval_note`, mirroring
`approveTimeEntries`. After: only current-week (Jul 21–22) pending entries
remain. Note the approved no-client time (Allison's 5 + Lisa's June 3) shows in
payroll/raw exports but bills nowhere.

**Most recent code work was a run of time-approval bugs, all traced from one email
from Brittany** ("I rejected parts of last week's timesheet and Allison isn't
sure where it went"). That one report uncovered four separate defects — worth
reading as a case study in §4's method, because each was found in the data, not
the code:

| Commit | What |
|---|---|
| `a365270` | **The big one.** Non-owner data scope admitted an entry only if `isAdministrative \|\| allowedClientIds.has(clientId)`. An unsplit **group-time holding entry** is neither (its `client_id` is NULL; members live in `group_client_ids` until split), so the server stripped bookkeepers' **own** tracked time before it reached them — they couldn't see/edit/split it and their totals disagreed with the owner's (15 entries vs 10 for one day). Fixed via `isTimeEntryVisibleToScope` in `lib/data-scope.js`. Verified on prod: Allison 97→102, Lisa 98→101, both now matching the owner exactly. |
| `2d4ad5f` | Time page is a **two-column grid**; adding a third panel bumped Recent time to its own row. Sent back + Recent time now share one grid cell via `.time-side-stack`. |
| `64dea4a` | Visual: dropped a badge that wrapped into a cramped circle; `.status-pill` now has `white-space: nowrap` + `flex: none` (fixes that failure mode app-wide). |
| `64ee907` | Both Time lists collapse + scroll independently; **removed the 8-entry cap** on Recent time (`slice(0, 8)`) — that cap was why heavy loggers never saw older entries. |
| `b24ad79` | Dedicated **"Sent back"** panel on the Time page — unscoped, uncapped, oldest-first. |
| `139e196` | Rejecting a time entry **notified nobody** — no `notify()` call, and `time_entry_rejected` wasn't even a registered event. Now notifies (bell + email) and shows an "N sent back" week badge. Also sent the 7 missed notifications retroactively (approved prod write). |
| `4ddc487` | **To 100%**: new "Checklists" category flagging recurring recipes that will **silently never generate** (missing steps / months / due date / client / assignee, or switched off). Mirrors the materializer's gate. |
| `f358b2b` | Completing a step is **assignee-only**; clock in/out on **every** approval surface; **Clock in/out/Sessions** columns on both raw exports; **"Time"** button + track-time modal on each client row. |
| `006c54e` | **Approval is deletes-only.** Removed pending-edit routing for adds and edits. Staff can **append** to a recurring template via a new append-only endpoint. |
| `c2746d4` | Time entries: edit **every** field (client, task, date, admin toggle); saving resubmits for approval (approved → pending). |
| `d54a793` | Every notification email **names the client** (body line + subject), resolved centrally in `notify()`. |
| `85003a6` | Staff see their clients' **recurring checklists on the main Checklists page** (was buried per-client). |
| `880cb33` | Checklist cards lead with the **client name**; instance-vs-series prompt when adding a task. |
| `4516004` | **Bug fix:** stage 1 of specific-months recipes used the template's month-day instead of its own (`resolveSpecificMonthsStageDueDate`). Included an approved 177-row prod backfill. |
| `bc46a8c` | Payroll report: **time by day by job** + raw-hours export. |
| `c05c415`, `5ad9b84`, `11fccd9` | To-100% UX: collapse-all default, summary strip, checklist quick-preview modal. |

---

## 6. Open follow-ups

Nothing is half-built — every item above shipped and deployed.

**Tracker state at handoff (2026-07-25):** ~12 items in Shipped awaiting
Brittany's review (each with a shipped-at pill), newest being the email
notification preferences (`featreq-9819cd2c`); 3 in the EOM lane —
engagement-to-billing workflow (`featreq-79b6d974`, ALSO needs a planning
session with Alex first), client-tabs consolidation (`featreq-5c225d33`, her
option "(c)": fold into that same discussion), and historical hours
(`featreq-deef43f1`, guard-then-reimport plan above); nothing in Planned/New.
One interpretation flag left for Brittany inside a shipped item's dev_notes:
the Board "sort by team member box" was built as a FILTER — the note invites a
send-back if she meant ordering.

**The bulk-save staleness guard is now BUILT** and waiting on the branch
`guard/bulk-save-staleness` (§5, tracker `featreq-f7d50027`) — not merged,
because it is month close. It closes the app's last known data-loss vector and
gates the historical re-import. Merge after close, ~Aug 1–3, ahead of the
re-import ~Aug 6. Note the one deviation from the original sketch: bulk saves are
logged to the **server log, not `activity_log`** — see §5 finding 2 for why.

These are things **flagged to Alex that he hasn't ruled on**; don't do them
unprompted.

**Consequences of this session's changes, worth watching:**

1. **Brittany lost edit visibility.** Removing edit-approval means she's no longer
   notified when someone renames a step or changes a due date (the activity log
   still records it). Offered: send a *notification* on edit instead of an
   approval gate. Not built.
2. **Assignee-only completion may be too strict.** If a checklist is assigned to
   one person but the team expects anyone to close steps, they'll hit disabled
   boxes. Offered: a per-checklist "anyone assigned to this client may complete"
   flag. Not built.
3. **Time-entry edits flip approved → pending.** Deliberate ("submit for
   approval"), but may be noisy. Offered: scope it to material changes (client /
   time / date) and leave description-only edits approved.
4. **"This + all future"** adds to the template (future instances) — it does
   **not** retroactively add to other already-open instances. Confirm that's what
   she means if it comes up.
5. **To-100% shows switched-off recipes** as MEDIUM. If deliberate-off is noise,
   hiding them is a one-line change.

6. **`.entry-list--scroll` is capped at `58vh`** — a guess, never seen on a real
   screen. On a short laptop that's ~3–4 rows before scrolling. Easy to raise, or
   to make the two Time panels split the available height.
7. **The week-bar "N sent back" is still a pill**, kept for consistency with its
   siblings ("Pending review", "Approved", "Month locked"). Alex disliked pill
   styling elsewhere; offered to restyle that whole row to plain labels.
8. **Retroactive notifications were sent as ONE summary per person**, not one per
   entry (5 near-identical emails to Allison would have been noise). If per-entry
   is ever wanted for a future backfill, that's a choice, not a constraint.

**Real data worth a look (not code):**

- Two recurring recipes have generated **zero** checklists ever — *Annual
  Reconciliations with Review · Brentwood United Pentecostal Church* and *Annual
  Reports · N568RT, LLC*, both with an empty first stage. Real work that hasn't
  been happening. They now appear in To 100%.
- **10 unsplit group-time holding entries** sit in production (Allison, Lisa,
  Brittany). They were invisible to their owners until `a365270`; now that they
  are visible, they still need **splitting across their member clients** before
  that time can be billed. Worth telling Brittany to work through them.

**Config worth checking:** `EMAIL_FROM` is `signin@ka-testing.com` — a testing
domain sending to `@pbjsa.com` addresses. Mail is being accepted by Resend, but
deliverability/spam placement is unverified. If people report "never got the
email", start here, not in the notify code.

**Tech debt created deliberately:** the `pending_task_edits` queue is now
vestigial — nothing creates new entries, but the approve/reject machinery remains
so pre-existing edits can be resolved. Safe to remove once that queue is empty.

**Deferred by design:** cross-month due dates for specific-months recipes. Do
**not** just remove the within-month clamp in `resolveSpecificMonthsDueDate` — the
materializer's per-month idempotency key is derived from the due date's month, so
an out-of-month date makes the task **respawn on every read**. It needs a stored
scheduled-month marker first.

---

## 7. Working agreements with this user

### The queue-run contract (how work arrives now)

When Alex says "go" / "run the queue" / "fire it up", work the Updates tracker
autonomously (`feature_requests` table). This replaced ad-hoc requests as the
main work channel; the statuses are the protocol with Brittany.

1. **Queue** = `status='planned'`, ordered urgent→high→medium→low, then
   `priority_rank`, then `created_at`. Ignore `new` (untriaged) and
   `brainstorm` (Britt's Brain — hers until Alex promotes). Include
   `planned_not_eom` items ONLY when the day-of-month is ~6–23.
2. **Per item**: flip `in_progress` → **read `review_note` (the AI-confirmed
   rework spec on send-backs) and `clarification_answer` FIRST** — they outrank
   your reading of the title → build (BOTH store backends) → `npm run verify`
   → push → poll Railway → `/health` → manifest + voice re-provision if
   user-visible → flip `shipped` **with `dev_notes` (what + commit hash) and
   `shipped_at = now()`** (direct SQL doesn't stamp it; the endpoint does).
   Only Brittany/Alex flip items to `done`.
3. **Ambiguous? Don't guess.** Set `needs_input` + ONE owner-readable question
   in `clarification_question`; investigation detail goes in `dev_notes`; move
   on. Guessing wrong cost four cycles on one feature.
4. **"Still broken" reports: check the SERVED bundle before re-coding**
   (fetch `/`, follow the asset links, grep for the feature's marker; remember
   the CSS minifier strips spaces in selectors). Two such reports were stale
   tabs. The refresh toast now mostly prevents this, but verify-first stands.
5. **Before believing a request is unbuilt, check whether it already shipped**
   — several "add X" items were discoverability gaps; the fix was surfacing,
   not rebuilding. Duplicates: ship once, mark both, cross-reference.
6. **Standing approval (Alex, explicit):** single-row writes on
   `feature_requests` (status, dev_notes, clarification fields, shipped_at,
   and filing shipped records for features he ordered directly). Every OTHER
   prod write still needs his per-write approval with a durable undo snapshot.
7. Post a short digest here after each item lands.

### General agreements

- **Plan, then build.** For anything non-trivial outside the queue, propose
  first. "Push" is the go signal. Use structured questions when a decision is
  genuinely his (or Brittany's) — permissions changes and prod writes
  especially.
- **Ship end-to-end.** A task isn't done at "code written": verify → commit →
  deploy → health-check → re-provision voice if the manifest changed.
- **Re-reports mean re-interpret, not re-code.** The "To 100%" item was rejected
  **three times**; the first two failures were me building the wrong feature from
  a plausible reading. When something comes back, ask what they're looking at, or
  reproduce against prod data — don't just re-implement the same idea harder.
- **Report honestly.** Say what was verified and how, and flag the limits (below).

---

## 8. Known constraints

- **You cannot log into the live UI.** The owner account has TOTP 2FA. Do **not**
  attempt to bypass it (a safety classifier correctly blocks this, and it's
  someone else's account). Verification therefore rests on `npm run verify` plus
  production-data reproduction (§4) — say so plainly rather than implying a
  click-through happened.
- Local dev: `npm run dev` runs Vite + `node server.js`. The **server** (port
  5173) serves `dist/` + same-origin API; Vite's proxy target does not match, so
  use the server port, not Vite's.
- Windows + Git Bash on the current machine. Shell snippets here assume Git Bash
  (POSIX), not PowerShell.

### Where things live

Paths are recorded because chats reference them, but **only this repo is
durable** — treat everything else as machine-local.

| What | Where | Durable? |
|---|---|---|
| **This repo** (the only thing that matters) | `D:\PBJ Accounting Work\AP For Time Stuff` on the current machine; `github.com/shizzoobies/PBJBillingApp` | ✅ in git |
| Previous handoff (2026-06-19) | `docs/archive/HANDOFF-2026-06-19.md` — sat at the repo ROOT until 2026-07-26 and was a trap (a fresh session could read month-old "current state" as fact). Archived, not deleted: its **Env vars (Railway) inventory** and the 06-10→06-19 shipped logs were never carried forward and exist nowhere else. One caveat when reading it: it flags the `ELEVENLABS_API_KEY` as needing rotation after being pasted into a chat during setup — **that has since been done** (confirmed by Alex 2026-07-26), so ignore that line. | ✅ in git |
| Parent folder + its own `CLAUDE.md` | `D:\PBJ Accounting Work\` — a broader two-track project (QuickBooks training + AI bookkeeper). Loaded as context; **no work here happened there** | separate repo |
| Agent scratch state | `.omc/` inside this repo | mostly gitignored |
| Machine-local Claude memory | `~/.claude/projects/D--PBJ-Accounting-Work-AP-For-Time-Stuff/memory/` | ❌ per-machine, per-account |
| Session scratchpad (throwaway scripts, snapshots) | OS temp: `…\AppData\Local\Temp\claude\…\scratchpad\` | ❌ **ephemeral** |

Two consequences worth knowing:

1. **Absolute paths in this doc are for the current machine only.** Anything you
   copy should be run from the repo root instead (§4's snippet now uses `$PWD`).
2. **The scratchpad is not a backup.** The snapshot taken before the approved
   177-row due-date backfill was written there, so it is **gone** — that backfill
   is no longer reversible from a saved file. If you run another approved prod
   write and want a durable undo, write the snapshot somewhere that survives (or
   at minimum paste the before/after into the chat).
