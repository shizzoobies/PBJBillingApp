# Handoff — PBJBillingApp

Written 2026-07-21, last updated 2026-09-03. Everything below is live on `main`;
the working tree was clean at handoff. Read this top to bottom before your first
change — several rules here are non-obvious and breaking them has caused a
production outage before. **If you do only one extra thing, read §7's
"queue-run contract": the Updates tracker is now the primary way work arrives,
and it has rules.**

---

## 0. Quick start for a brand-new session

This section exists so a Claude with NO machine-local memory (a different
machine, a fresh account, claude.ai) can pick up cold. It is a summary — every
claim here is expanded in the numbered sections, which still win on detail.

**What this is:** the time-tracking / checklist / billing app for PB&J
Strategic Accounting, live at app.pbjsa.com, deployed by pushing `main` to
`github.com/shizzoobies/PBJBillingApp` (Railway auto-deploys). Alex is the
developer you talk to; Brittany (user id `emp-patrice`!) is the client whose
requests arrive through the Updates tracker. **This app moves real money**
(live Stripe since 2026-08-18): sends, voids and payments are production
actions — Alex's explicit yes, know the undo, test only on the `Test` client.

**State right now (2026-09-03, evening):** `main` = the redesign commit, deployed SUCCESS,
`/health` 200, tree clean, suite **2691 tests / 160 files**. The 2026-09-02
evening entry in §5 is the latest digest. The queue:

1. `featreq-97ae3214` — **invoice redesign** — SHIPPED 2026-09-03 (awaiting
   her review; §5 entry).
2. `featreq-68638ed2` — **Skip vs Push** (planned; ONE open question for
   Brittany, see §5).
3. `featreq-8cec48db` — hours-per-client tagging panel sits in `needs_input`
   awaiting Brittany; do not build past her answer.
4. Two parked `planned_not_eom` items (§5), thirteen Shipped items awaiting
   her live review — re-read the board at session start, it moves.
5. **Watch:** September's KLC generate is the first combined invoice
   (~$720, master `client-lamjjjc`); the first send is irreversible.

**The five rules that break things** (details §2–§4): (1) `db/store.js` has
TWO backends — any persisted change touches both, tests only exercise the file
backend; (2) `npm run verify` green before every push; (3) user-visible change
⇒ update `docs/capability-manifest.md` AND re-provision the voice agent after
deploy; (4) deploy is part of done — push, poll Railway, `/health` 200;
(5) never write to prod without explicit approval + a durable undo snapshot
(single-row `feature_requests` writes have standing approval, §7). Production
read-only reproduction (§4) is the highest-value verification tool here — you
cannot log into the live UI (TOTP, §8).

**House norms:** American spellings everywhere (labor/color/labeled) — don't
copy British ones out of old comments; the repo is CRLF (LF edits make
whole-file diffs); there is NO prettier — eslint is the only style authority;
commit messages open with a statement of behavior (no conventional-commit
prefix) and end with the Co-Authored-By trailer your session specifies
(history shows several Claude models); `package-lock.json` is deliberately
gitignored — do not commit one; `tmp/` is NOT eslint-ignored, so scratch
scripts go in the OS-temp scratchpad, never the repo.

**Machine-local paths (this machine only — gone elsewhere):** the repo at
`D:\PBJ Accounting Work\AP For Time Stuff`; the Jan–May re-import assets at
`D:\PBJ Accounting\Old Time\`; the desktop updater signing key at
`D:\PBJ Accounting Work\desktop-updater-key\` (if it AND the GitHub Actions
secret are lost, installed desktop shells can never update again); Brittany's
annotated contact list at `D:\PBJ Accounting\PB&J Strategic Accounting_Customer
Contact List.xlsx` (11 of its rows are column-shifted — §5, 2026-08-26). One
git quirk: pushes can suddenly 403 as the wrong account ("pmuf-code") — fix is
`gh auth switch --user shizzoobies`, then re-push and match the polled deploy
hash to the commit you pushed.

**Tracker oddity that is NOT a bug:** rows filed through the assistant carry
raw status `'sent'` in the database; `mapFeatureRequest` (db/store.js)
read-maps it to `'new'`, so the app never shows it. Only raw SQL sees `sent`.

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
   before every push. Currently **2646 tests / 154 files** (2026-09-02).

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

Commit trailer: end every commit with the `Co-Authored-By` trailer your own
session specifies (the history holds several — e.g. `Claude Opus 4.8 (1M
context)`, `Claude Fable 5` — and that is fine; what matters is that the
trailer is present and truthful):

```
Co-Authored-By: <your session's Claude attribution> <noreply@anthropic.com>
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

**2026-09-03 — the invoice redesign (featreq-97ae3214) is BUILT and shipped.
It is a RENDERING change, not a money-calculator change — read that sentence
twice before touching `lib/invoice-lines.js`.**

Plan of record: `docs/plans/invoice-redesign-2026-09.md` (§0 is the decision,
§2a is what the build and review found). Her marked-up sample became: three
titled sections with their own totals (Subscription Plan / Ad-Hoc & Billable
Hours grouped by role / Client Reimbursed Expenses), `Invoice no.` +
`Invoice Date` + `Billing Period: Month Year` in the header, tagline gone,
her closing line as the footer default, and the client's time breakdown (when
on) as a titled page 2. Same layout on the PDF, both email parts, and the
in-app print sheet; Stripe's checkout is untouched (it never sees sections).

**Why it is a rendering change.** Her columns are Description | Hours | Rate |
Amount — one rate per row — so merging people into one role row is
unrepresentable when rates differ, and `sanitizeInvoiceLines` would silently
re-derive `amount = hours × rate` on the next save. Stored lines stay
per-person; `roleTier` (presentational, allowlisted in the sanitizer) says
which heading a row prints under; `invoiceSections()` groups the RESOLVED
client-facing lines — strictly downstream of `clientFacingInvoiceLines`, so a
billing master's combined document still shows one line and no headings.
Alex's constraint — section totals must sum to what per-person lines bill —
holds by construction and was proven over all 59 real invoices, twice.

**Things this build found that tests could not (all fixed, all pinned):**
- `INV-2026-08-044` (Dobco, SENT) carries its whole $256.25 on three
  hand-built `time_detail` rows — the $0.00 invariant is the generator's, not
  the store's. A money-carrying `time_detail` row stays in the body.
- Kind-less display rows (live preview, Customize's seed/draft mapping, and
  Customize's "Add line" — the review's blocker) would vanish from the sheet
  with their money still in Total due. All stamped, AND `invoiceSections`
  now has a residual bucket so the class cannot recur; a test iterates every
  `INVOICE_LINE_KINDS` entry plus a kind-less row.
- The sheet's new Invoice Date used the LOCAL day while the PDF used the UTC
  day — two client copies could disagree after a 9pm ET generate. Both UTC now.
- The live preview's June-cutover double-listing (filter by label) would have
  printed a doubled section total; filters by kind now.

**Traps for the next session:** `scripts/check-print-pdf.mjs` now has THREE
modes (invoice+appendix = 2 pages, invoice alone = 1, report = 1) and its
fixture mirrors the shipped markup with staleness needles for the section
class names — rename a class in `InvoicesPage.tsx` and the check fails on
purpose. Run it via the cached-Chromium `PLAYWRIGHT_MODULE` wrapper; playwright
is not installed here and the script SKIPS (exit 0) without it. Charge rows
(card fee, adjustment, credits, hand-typed customs) now always print after the
three sections regardless of stored order — deliberate. The owner's on-screen
`InvoicePreview` is intentionally flat (her review copy); the sectioned
`InvoiceDocument` is the client's view. Payment terms still print from each
client's record ("Due on receipt") — her markup said "Due on Demand"; Alex
chose to leave the data alone and let her raise it if she means it.

Suite 2691 → **2759 tests / 162 files**. Manifest updated — re-provision voice.


**2026-09-02 (evening) — PICK UP HERE. The stuck payment is CLEARED, six ships
in one session, and the queue is back to the two big planned items.**

`main` is `cf71d4a`, deployed SUCCESS, `/health` 200, tree clean. Suite **2691
tests / 160 files**. Voice agent re-provisioned after each manifest change
(three times).

**INV-2026-08-003 is settled.** Alex pressed Verify with Stripe himself; prod
confirms `paid`, `paid_at` = Stripe's real charge time (13:58:12Z — one second
earlier than the webhook's stamp; Stripe's answer won, as designed), audit
event `payment_verified_with_stripe` naming him. The §"one immediate action"
below is history.

### What shipped (all deployed, health-checked, tracker flipped)

| Commit | What |
|---|---|
| `7f8d5ed` | **Verify all with Stripe** (Alex's direct ask; filed as featreq-6349d779). `POST /api/invoices/verify-all-payments` sweeps EVERY `processing` invoice, any month; per-invoice isolation; only Stripe's answers recorded; button always in the month run's action row, no confirm. |
| `e10f6cc` | **Month arrows** (featreq-1947e574): back/forward flanking the run's month picker, guarded by the same dirty-edit confirm as the picker. |
| `66eda3b` | **Invoice Recap page** (featreq-0c2d4ce5): the ONE invoicing surface staff can see — per sent invoice: total / accounting services / each reimbursed expense individually. `GET /api/invoice-recap`, session-gated NOT owner-only, scoped by `visibleClientIdSet`; masters all-or-nothing like Client Recap. Validated over real August rows: 37 rows, 0 reconciliation failures. |
| `7e4063e` | **Sort + search in invoicing** (featreq-a1e61913): search box + sort control in the month run (client A–Z is now the DEFAULT order, superseding I2's number order — her explicit rule), search + client-A–Z default in History. The open editor's row is exempt from the search filter (unsaved-edit protection, pinned). |
| `cf71d4a` | **Search skips inactive clients** (featreq-60f24838): a typed query never returns a retired client's rows across Checklists/Board/Gantt/Delayed/Contacts/recurring lists; empty query changes nothing (history keeps its subject); the Add-from-existing template picker excludes them unconditionally. Shared helper `inactiveClientIdSet` in `clientLifecycle.ts`. |

### Worth knowing from this session

- **The tracker's raw status `'sent'` is NOT a bug**: the assistant's
  "send to Alex" flow creates rows with status `sent`, and `mapFeatureRequest`
  (db/store.js) read-maps it to `new`. Only raw SQL ever sees `sent` — the app
  never does. Don't "fix" it.
- **featreq-8cec48db (hours-per-client tagging panel) sits in `needs_input`**
  with one question for Brittany: does tagging update the invoice live or on
  save, and does the panel show/override adhoc tags made earlier at time
  review? Its own spec left both open — don't build past them.
- The queue is now: `featreq-97ae3214` invoice redesign (planned, ungated) and
  `featreq-68638ed2` Skip vs Push (planned, one open question) — unchanged
  from the entry below.

**2026-09-02 — Five ships since the last entry, the "math still
is not mathing" thread is CLOSED, and there was ONE immediate action: Alex (or
you, with him watching) presses "Verify with Stripe" on INV-2026-08-003
(DONE — see the entry above).**

`main` is `2498fe2`, deployed SUCCESS, `/health` 200, tree clean and in sync.
Suite **2646 tests / 154 files**. The voice agent was re-provisioned after every
manifest change (once through an ElevenLabs 500 — a single retry cleared it).

### The one immediate action

**INV-2026-08-003** (Mind Body & Spirit, $10.61, card) sat in `processing` for
12 days after the money settled. The month run now shows a **Verify with
Stripe** button on it. Stripe was pre-confirmed read-only: payment intent
`succeeded`, charged **2026-08-20T13:58:12Z** — so one press moves it to Paid
with the real charge time and writes a `payment_verified_with_stripe` audit
event naming who asked. If Alex already pressed it, just confirm it sits in
Paid and move on.

Root cause — worth knowing because it shaped two safeguards: **not a lost
webhook, an event-order race.** A card payment fires
`payment_intent.succeeded` and `checkout.session.completed` near-simultaneously
with no promised order. `succeeded` landed first and marked the invoice paid;
the late `completed` wrote its `processing` over the settled truth (the row
already carried `paid_at`, `payment_method='card'` and the intent id — only the
status was wrong). Any card payment could hit this. The fixes in `2498fe2`:

- **Paid is sticky** (`applyInvoicePayment` in `db/store.js`): no payment-side
  event can move a paid invoice backwards; the late event's OTHER facts
  (session ids, the card-fee line) still apply. Pinned by a test that replays
  this invoice's exact out-of-order sequence.
- **Verify with Stripe** (`POST /api/invoices/:id/verify-payment`): offered on
  `processing` only. It asks Stripe (`retrievePaymentIntentStatus` in
  `lib/stripe-rail.js`) BEFORE writing anything — the route order is pinned by
  a test — and records only Stripe's answer. Still settling → 409, nothing
  changes; Stripe unreachable → 502, never a guess. This is deliberately NOT
  the raw override Alex asked for, and **Mark paid still refuses `processing`**
  for the same reason: on an invoice with a live Stripe payment, Stripe's
  answer beats anyone's memory of it.

### What shipped (2026-08-31 → 09-01)

| Commit | What |
|---|---|
| `bf86622` `aa2ea92` `2703769` | **Period label v2** (featreq-81429ad1) — the v1 OFFSET picker went back ("The period covers should allow me to pick dates and then the how often should determine the next period"), so the recipe now carries a first date WINDOW she types and the task's own recurrence steps it forward — the exact machinery a reimbursed expense's covered dates use (`nextCoverageRange`; `lib/checklist-period-label.js`), and the tests pin the two features together so they cannot drift. Her original constraint holds and is tested by field-for-field comparison: turning the label on changes NOTHING else about a generated instance. **She approved this version — the item is Done.** |
| `e57c158` | **Recap round two** (featreq-926862e2), from her two emailed markups: billing type in the header line, three COST columns on the roles table (estimated / actual / over-under, with the labor-cost-basis note), and the Billing tiles reshaped to Estimated invoice / Actual invoice / Over-Under. All variances derived in `lib/client-recap.js` (master roll-ups SUMMED, never recomputed); staff payloads structurally lack the cost columns. Alex's scope ruling on the tiles: "as long as the number is right the bucket doesn't matter." |
| `876f2ab` | **Invoice pricing** (featreq-cfb1536a) — invoices now charge the hours they PRINT. This was the last raw-clock-priced surface and the true end of "math still is not mathing": an hourly line's amount is `periodMoney(rows, rate)` off the rows-rule hours (`periodDisplayHours`), the same figure the recap's roles table and payroll print, so the recap's Actual Invoice now matches its own hours table (her $103.75-over-$103.54 case). Plus her editable **Billed hours** field in the month-run editor: she types the hours, the amount auto-recalculates and refuses typing, the detail text rewrites to what she chose, and the server re-derives the amount again on save (`sanitizeInvoiceLines`). Legacy lines without an `hours` field keep their editable amount. |
| `ce542c6` | **Manual Mark as Paid** (featreq-602d2c6e, Alex's own item) — for money that never touched the app (a check, Zelle). Offered on draft/reviewed/sent/overdue with a confirm; refuses `processing` (a real debit is settling — the webhook owns it); expires BOTH open checkout sessions after commit so the emailed pay link dies (double-pay prevention); audit event in the same transaction. **Undo manual payment** exists ONLY on a manual mark with no payment intent — a mis-click escape, not a money tool; webhook-paid invoices stay what they are. |
| `2498fe2` | **Sticky paid + Verify with Stripe** — above. |

### Facts settled this stretch — do not re-derive, do not re-ask

- **The pricing rule is A — no automatic rounding — plus the editable hours
  field.** She first wrote B on the tracker, then REVISED in person with Alex
  mid-build (before any pricing code was written). The revision is recorded
  verbatim on the tracker as an appended `clarification_answer` block marked
  "[REVISED 2026-09-01 …] — this supersedes the B above". If a future reading
  of the item stops at the B, that is the interpretation trap §1 warns about.
- `periodDisplayHours` / `periodMoney` now price BOTH sides of the money —
  payroll cost AND invoice billing. `personPeriodCost` remains forecast-only.
- Mark-paid's refusal of `processing` and the narrow undo are DELIBERATE — the
  reasoning is in the table above and in the tests' comments. Do not widen
  either because someone hits a wall; the wall is the feature.

### The queue

1. **`featreq-97ae3214` — invoice redesign (planned, UNGATED, ready to build).**
   Her spec: three sections with per-section totals, hours grouped **by role**
   (Alex ruled the bucket doesn't matter as long as the number is right —
   senior_bookkeeper lands under "Accounting Services"), invoice number/date,
   "Billing Period: Month Year", Due on Demand, the time breakdown as page 2,
   footer "Spread success, not stress...". Hard constraint: section totals must
   sum EXACTLY to what the per-person lines would bill — group the lines, never
   re-derive the money. Role rows must carry `hours`+`rate` like per-person
   lines do (the billed-hours editor and `sanitizeInvoiceLines` key off them).
   **Run `scripts/check-print-pdf.mjs` after any layout change** — jsdom is
   blind to paged media (§4).
2. **`featreq-68638ed2` — Skip vs Push (planned).** Buildable except ONE open
   question for Brittany: when someone skips/pushes their own task in a
   sequence, does that trigger the next step or block it? (The "toggle"
   question in the dev notes is ALREADY answered inside her own text — whole
   phase vs single subtask, chosen at initiation — don't re-ask that half.)

She reviews live; re-read the board at session start, not just at the end.

### Traps this stretch added

- **A test failing at the turn of a month may be the CLOCK, not your change.**
  Two suites failed at ~21:00 EDT on Aug 31 (= Sep 1 UTC); a speculative fix
  was written and had to be reverted. The method that settled it: `git stash`
  and run the suite on clean HEAD — both failures pre-existed. Root cause: the
  In-progress list is report-period(month)-scoped, so on the 1st a task due
  yesterday exists only inside the COLLAPSED Overdue pin. The fix is the
  `expandOverduePin()` helper (`preview-effective-checklist-scope.test.tsx`);
  green local AND under `TZ=UTC` now.
- **`tmp/` is NOT eslint-ignored.** A leftover `.cjs` patch script broke
  `npm run verify`. Delete scratch scripts before verifying, or keep them in
  the session scratchpad outside the repo.
- **Month-run UI tests:** tabs never auto-follow a status change (pinned since
  `3362519`) — after a merge that moves an invoice, CLICK the destination tab;
  and the editor's `openId` survives the tab switch, so clicking the row again
  TOGGLES it closed. Both cost real debugging time.
- happy-dom has no `window.confirm` — `vi.stubGlobal('confirm', fn)` with
  `vi.unstubAllGlobals()` teardown (pattern in the dirty-guard and mark-paid
  suites).
- The positional-INSERT column-count tests (invoices gained `hours`/`rate` on
  lines, plus payment columns) did their job twice this stretch — when they
  fail after you add a column, EXTEND the placeholders, never the other way.

### Unchanged, still watching

- **September's KLC generate is the first combined invoice** (~$720, master
  `client-lamjjjc`). The first send is irreversible — eyes on it when it runs.
- The contact-list remainder, desktop signing + the updater-key backup, and the
  three parked items are exactly as the 2026-08-30 entry lists them.

**2026-08-30 — PICK UP HERE. The queue has real work in it again: Brittany
answered the period-label question, and it is the top item.**

`main` is `a93b2a0`, deployed SUCCESS, `/health` 200
(`{postgres, stripe: live, stripeWebhook: configured}`), tree clean and in
sync. Suite **2571 tests / 149 files**. Nine features shipped 2026-08-22 → 30;
each has its own entry below this one.

### The queue, in the order to work it

**1. `featreq-81429ad1` — "Checklist /task" (planned, HIGH, ANSWERED, ready).**
Her one-liner was genuinely ambiguous — *"I need a time period area - like the
period the task is due for so you can keep it straight, but not all
checklist/task would have it and then the next would spring forward"* — so it
went back with ONE concrete reading rather than a guess. She confirmed it
2026-08-30, verbatim:

> 1. - next to the title
> 2. purely a label not to change anything we have already done

So: an OPTIONAL per-task label naming the period the work COVERS ("July
books"), distinct from the due date, rendered **next to the task title**, and
**purely cosmetic — it must not feed any report, filter, billing month, or
existing number.** Her "the next would spring forward" means the label advances
when the recurring materializer creates the next cycle's instance. Not every
task carries one. Re-read her exact words in the tracker before building, and
do not widen the scope — "not to change anything we have already done" is the
whole constraint.

**2. `featreq-68638ed2` — Skip and Push buttons (planned, medium).** Out of her
own Brain session and well-formed: two distinct buttons, where *push* keeps a
task alive with a new due date (defaults to the next cycle, editable) instead of
killing it like *skip*. Both carry the existing skip requirements — the
who's-responsible dropdown and a written explanation — and both surface on the
review dashboard. **Her draft truncates mid-sentence** at "there'd be a toggle
for wh…": ASK what that toggle governed rather than guessing. Everything before
it is safe to build.

**3. Twelve items sit in Shipped awaiting her review.** She reviews live, so the
board moves while you work — re-read it at session start, not just at the end.

**Parked; do not start unprompted:** `featreq-79b6d974` engagement-to-billing
(in_progress, needs a PLANNING SESSION with Alex — it reshapes navigation for
everyone, and its Track B was superseded by the invoicing that shipped);
`featreq-ef7f4e35` TOTP encryption (blocked on ALEX generating and storing
`TOTP_ENC_KEY` — Claude must never handle that key); `featreq-15ff79f7`
Brittany-pushes-her-own-update (policy locked, Tier 0 shipped, Tiers 1–5 remain,
build-only, do not re-open the questions).

### What is live now that was not a week ago

- **KLC consolidated billing — MIGRATED and armed.** Master `client-lamjjjc`
  ("KLC Floors & More") with four subs, including the existing KLC client
  renamed "KLC Floors & More — Bookkeeping". **September's generate produces the
  first combined invoice** — that is the moment to watch, and the first send is
  irreversible. Dry run over real rows: $720.00 exact, one combined line, no
  company names. Design + the two review blockers: the 2026-08-28 entry.
- **AI confidence ratings** on every generated draft — advisory, never blocks —
  plus the correction corpus that records what she changes. That corpus is the
  trust-ladder measurement the plans' "bulk-send once trusted" gate was missing;
  it needs months of data before automation tiers are a real conversation.
- **Desktop app v0.2.0** — self-updating from `desktop-v*` tags, tray,
  close-to-tray, auto-start. Sign-in is the topbar "Open in desktop" handoff;
  an email `pbjsa://` button is DEAD ON ARRIVAL (web mail strips custom
  schemes — tested and confirmed). Do not rebuild that.
- **PWA install**, the **global topbar timer**, the **master recipient picker**,
  the **audit backlog's remainder**, and the assistant's **transient-400 retry**
  (Britt's Brain outage 2026-08-28: the provider intermittently rejects valid
  requests; identical requests succeeded 7/8 on replay).

### Traps this stretch added

- **`.omc/project-memory.json` keeps capturing throwaway patch scripts as the
  project's build/test commands** — repaired three times now. If a session opens
  with a giant `node -e` string presented as "the build command", that is this
  bug. The real commands are in `package.json`.
- **`scripts/check-print-pdf.mjs` SKIPS when playwright is missing** (it is,
  here) and prints a skip message rather than failing — so a "clean" run proves
  nothing. It runs against the cached Chromium via a tiny wrapper module passed
  as `PLAYWRIGHT_MODULE` (executablePath →
  `%LOCALAPPDATA%/ms-playwright/chromium-1234/chrome-win64/chrome.exe`). Do
  that after ANY print-path change; jsdom cannot see paged media.
- **A stale worktree** sits at `.claude/worktrees/laughing-raman-651691`
  (`a6ff061`, merged) from the recipient-picker session. Safe to prune — but
  per the 2026-08-27 lesson, run `git status` INSIDE a worktree before removing
  it: two of the last four held real uncommitted work that looked stale.
- CRLF everywhere and no prettier config — both described in the 2026-08-26
  entry, both still bite.

### Open decisions that need ALEX, not Brittany

- **Desktop code signing.** Unsigned installers trip SmartScreen once per user;
  Azure Trusted Signing (~$10/mo) is the fix and the CI workflow already has the
  seam. Separately: **back up `D:\PBJ Accounting Work\desktop-updater-key\`** —
  if that and the GitHub Actions secret are both lost, no installed shell can
  ever be updated again.
- **The contact-list remainder**: the Dobco and Sophie Paris merges (both hold
  time entries that must move first), retainer amounts (column S ≈ 1.5× the
  monthly fee), the 2026-09-13 → 10-13 covered windows on 31 rows, four second
  reimbursement lines, and "Relentless Training LLC" which matches no client
  under any spelling. Several are prod writes; all need his explicit yes.
- **M3 (CSRF uniformity)** is now the audit backlog's ONLY open item, still
  deferred by its own warning label — its own focused task, never part of a
  batch (the Vite dev proxy rewrites Host, so verify against `node server.js`).
- **`invoiceRenderMode` is unpersisted** — combined rendering derives from the
  billing-master flag. If she ever asks for company names ON the paper invoice
  (option 1), that needs a column before it is a flag flip.


**2026-08-28 (late) — KLC consolidated billing is BUILT and shipped; the
MIGRATION is the remaining step and needs Alex's explicit yes.** Brittany
answered Q3 ("2" — the paper shows one combined line, no company names; the
split lives app-side only) and the pre-approved build ran: four parallel
agents (store/lib/server/UI) against `docs/plans/consolidated-billing-2026-08.md`,
then an adversarial review that found **2 blockers** — the Stripe hosted
checkout page still rendered the per-company breakdown (the one client-facing
surface outside our own renderers; now routed through
`clientFacingInvoiceLines` with negative-match tests), and a migration-month
double-bill (a sub with a live invoice re-billed on the master; now filtered
with skip reason `already-billed-on-own-invoice`, tripwire-tested). Also
fixed from review: three vanishing-hour paths (updateTimeEntry re-target,
split, adjust) + one-off reimbursements now refuse masters; subs' prior-month
true-ups carry onto the master (`sub-adjustment` flag); skip-reason lifecycle
ordering; master recap gated on per-sub visibility (403
`master_subs_not_visible`); card-fee/retainer-credit lines survive combined
rendering (`COMBINED_KEPT_KINDS` — the fee's kind is `card-fee`); masters
hidden from every WORK picker via `workableClients` (three-tier rule in
`src/lib/clientLifecycle.ts`); fakePostgres harness now exercises the PG
guard branches. Suite 2332 → **2524 / 146 files**; print check PASSED via
the wrapper (`scratchpad playwright wrapper — cached Chromium`); merged-draft
dry run over REAL prod rows: $55+$185+$295+$185 = $720 exact, one combined
line, name-leak clean.

Known and deliberate: `invoiceRenderMode` (the future option-1 flip) is
UNPERSISTED — combined derives from `is_billing_master`; a column comes with
any option-1 ask. The recipient PICKER is a filed follow-up chip
(`invoiceRecipientClientId` is migration-set; sends refuse with a sentence
naming Alex until then). Team-assignment picker still offers masters
(admin action, not work — deliberate). History's per-company rows under a
master invoice: not built, noted in the plan.

**The migration RAN 2026-08-29** with Alex's explicit yes: master `client-lamjjjc` ("KLC Floors & More"), four subs linked, recipient = the KLC sub (renamed "KLC Floors & More — Bookkeeping"). September's generate produces the first combined invoice. Undo snapshot: `docs/prod-snapshots/2026-08-28-klc-master-pre-migration.json`.

**2026-08-27 (later) — the real Windows .exe exists, WORKS (Alex confirmed on
his machine), and its sign-in went through one field-tested redesign.** Alex
approved phase 2 same-day; `docs/plans/desktop-shell-2026-08.md` records what
was built and what deliberately wasn't (CI, signing, tray — pending his
verdict after using it). Installer is UNSIGNED (SmartScreen warns once);
build with `cd desktop && npx tauri build`.

**The sign-in lesson, so nobody rebuilds the dead version:** v1 put an
"Open in the desktop app" pbjsa:// button in the sign-in email, gated on the
shell's user-agent. It rendered perfectly and did NOTHING — web mail clients
(Gmail) strip non-http link schemes. The protocol registration was fine (the
registry had pbjsa:// → pbj-desktop.exe); the mail client was the wall.
v2 is Alex's design and shipped the same hour: sign into the WEB app, then
the **"Open in desktop" button in the topbar** (next to the bell; his call —
"let's not bury it" — after v2 started in Settings). It mints a one-time
login token via `POST /api/auth/desktop-handoff` (session-gated, token minted
for the session user only) and the browser opens pbjsa://verify/<token>,
riding the normal /verify flow, TOTP included. The email is back to one
button, and `lib/login-link-email.test.mjs` pins it scheme-free so the dead
button cannot quietly return. The topbar button hides inside the shell and
on phone widths. Suite 2325 → **2329 / 138 files**.

**2026-08-27 — the app is installable as a desktop/phone app (PWA), and the
"real .exe" question is parked as a plan.** Alex's side project while waiting
on Brittany. Phase 1 shipped: `public/manifest.webmanifest` + three PNG icons
rendered from the brand favicon (Chromium-rendered; the maskable variant keeps
the mark inside the 80% safe zone), manifest/theme-color/touch-icon links in
`index.html`, and `.webmanifest` in `server.js`'s mime map. Windows Edge/Chrome
now offer "Install this site as an app" — own window, taskbar icon, same live
app, same sign-in, nothing bundled so nothing can go stale.

**Deliberately NO service worker** — this app's stale-tab history (the
bulk-save staleness guard, the refresh toast) makes an offline cache a second
place for a stale bundle to hide, and installability doesn't need one.
`src/__tests__/pwa-install.test.ts` pins the wiring AND that absence — if you
add a service worker on purpose, update that test and the index.html comment
together.

Phase 2 (a real Windows executable) is a decision package, not work:
`docs/plans/desktop-shell-2026-08.md` — Tauri shell around the prod URL, the
magic-link-opens-the-browser problem and its `pbjsa://` protocol answer, and
the signing/distribution costs. Build only if Alex asks after living with the
PWA.

**2026-08-26 — PICK UP HERE. Four ships in one day, one production data write,
and three questions sitting with Brittany.**

`main` is `096c279` (this entry), pushed, tree clean, deploy SUCCESS, `/health` 200
(`{postgres, stripe: live, stripeWebhook: configured}`). Suite **2320 tests /
136 files**. The voice agent has been re-provisioned twice today — the manifest
changed both times.

**The queue right now:** 1 needs-answer, 1 planned-but-blocked, 2
planned_not_eom (both parked, unchanged), 1 in_progress (the parked
engagement-to-billing), 6 shipped awaiting her review. **Brittany approved
retainer invoicing (`951595c2`) and reimbursed-expense auto-advance
(`fe3f8b0f`) while this session ran** — they are Done now, which is why the
Shipped list looks different from the last handoff.

### What shipped today

| Commit | What |
|---|---|
| `c93a643` | **The paid lock** (featreq-ead3a215). Her rule, wider than the question asked: "invoices should not be editable once paid all invoices should lock after paid." Content edits refused on `paid` AND `processing`; `sent`/`overdue` stay editable; Void is the only way out and stays open. Guard sits ABOVE `updateInvoice`'s `if (this.pool)` split so one check covers both backends, pinned by a source-position test. Route maps `InvoiceLockedError` → 409 `invoice_locked`; `ApiError` gained `code` because one route now answers 409 for two different facts. |
| `6362521` | **Invoice time breakdown, off by default** (featreq-f1aadccc). Four opt-in levels per client (person / day / week / entry) + an amounts toggle. **Every line is `amount: 0`** — the breakdown explains an invoice, it never prices one, so no setting can move a total. Both new columns default `off`, so no data migration: confirmed live as off/false on all 51 clients. |
| `dea7ba0` | **Payroll rounding, round FOUR** (featreq-7c8f64d7). See below — this one has a lesson. |
| `6ef764f` | The consolidated-billing plan (docs only). |
| `49e28b2` | The undo snapshot for the role-hours backfill (docs only). |

### The payroll fix, and why three earlier passes missed it

`displayHours` and `personPeriodCost` were **never wrong**. The defect was at the
CALL SITES: the report printed one hours figure and multiplied a different one.
The Hours column is the sum of each row's two-decimal hours (Allison, 31 entries
→ 14.75h); the money multiplied `displayHours` of the RAW period total (14.78h),
and Billable $ multiplied raw minutes outright.

Summing rounded rows lands ABOVE the rounded total for one person and BELOW for
another — Allison 14.75 vs 14.78, Lisa (63 entries) 22.61 vs 22.59. That is why
it read as a rounding bug for three rounds and never was. **Brittany found it**,
in one sentence on the tracker: "Note Allison's cost/billable are HIGHER than
hand math while Lisa's are LOWER, so it's not a simple rounding-up bug."

The rule now: `periodDisplayHours(rows)` is the costing figure, and
`periodMoney(rows, rate)` prices both sides off it — cost rate and bill rate
alike. `personPeriodCost` survives for the one thing it is right for, pricing a
FORECAST (the Recap's estimated hours, one typed number with no rows), and says
so in its own doc comment.

**Four existing tests asserted the old target and were rewritten, not deleted.**
One of them stated the defect as intent: *"eight ten-minute rows each read 0.17h
and would price at $6.29, for $50.32 — but 80 minutes is 1.33h and pays $49.21.
Eleven pennies come off."* Eleven pennies coming off a column that reads 0.17
eight times is exactly what made the report un-multipliable. If you find yourself
about to "fix" a test here, read that comment first.

The guard is `src/__tests__/payroll-round-four.test.ts` — Allison's 31 and Lisa's
63 REAL entry minutes as a fixture, pinning all four figures. Verified as a
tripwire: reverting the rule fails it with **$561.64**, the number she was shown.
Minutes only, no names or clients.

Firm-wide August impact, measured read-only before pushing: **$1.52**.

### The one production data write (approved, applied, reversible)

**43 blank role-hour fields filled across 17 clients** from her 2026-08-25
contact list, per her exact rule: *"Do not change any that are already in but if
there are blanks in the program add in these numbers."* Clients with any estimate
went 24 → 39.

The `is null` guard is **in the UPDATE statement**, not just the plan, and the
committed snapshot was re-verified against live rows inside the write
transaction. 21 of her sheet values were skipped because the app already had a
number there.

**Undo: `docs/prod-snapshots/2026-08-26-role-hours-pre-backfill.json`**, committed
BEFORE the write. (Contrast the 2026-07-21 177-row backfill, which is not
reversible today because its snapshot went to a temp directory.)

### Waiting on Brittany — do not start these

1. **`featreq-bcee7e31`** (needs_input) — three questions about the KLC combined
   invoice. **Q3 is irreversible once an invoice is sent**: may KLC see Bright
   Tower, Chemtrex and XACT named on the document? Do not guess it.
2. **`featreq-65f5eac1`** (planned, BLOCKED on the above) — she chose option A,
   one invoice to KLC, "But I would like to be able to evaluate each company
   separate and see what each paid". Plan of record:
   `docs/plans/consolidated-billing-2026-08.md`. **Not started on purpose** — the
   generator is one-invoice-per-client behind the
   `invoices_client_period_monthly_live` unique index, and consolidation ripples
   into the never-generates detector, each company's own reimbursement coverage
   ledger, Invoice History/client page, and single-client generate. The plan
   names each. Read it before writing a line.
3. The six Shipped items are awaiting her approval. She reviews live — assume the
   tracker moves while you work.

### Still open from her spreadsheet (all need Alex's explicit yes)

Her contact list is at `D:\PBJ Accounting\PB&J Strategic Accounting_Customer
Contact List.xlsx`. **It is a hand-annotated QuickBooks export and 11 of its 42
client rows are column-SHIFTED** (payment terms landed in L, not P) — rows 10,
11, 12, 13, 16, 24, 43, 44, 45, 50, 52. A blind import writes the wrong column.
Full column decode is in the `contact-list-intake-2026-08` memory.

- the two merges she flagged: Dobco and Sophie Paris, both `client-seed-*`
  artifacts of the Jan–May import, holding 6 and 1 time entries that must move
  before the seed row goes;
- the retainer amounts (column S ≈ **1.5× the monthly fee** — Cooper 2100/1400,
  FHS 172.5/115, Westview 112.5/75 all exactly 1.5);
- the covered windows (**2026-09-13 → 2026-10-13** on 31 rows);
- four second-reimbursement lines (Associated Enterprise, Four Leaf, Reflect &
  Renew, Ride Right).

**Flagged and unresolved:** "Relentless Training LLC" is on her list but has NO
client in the app under any spelling. Raised in her tracker notes.

### Two traps this session hit, so you don't

- **Do not run `npx prettier` on this repo.** There is no prettier config and no
  prettier dependency; running it reformatted an entire 1400-line file. The house
  style is what eslint enforces and nothing else. (Caught and reverted.)
- **The repo is CRLF.** Heredoc/`Write` edits land as LF and produce whole-file
  diffs. The patch scripts in this session all read the file, normalize to \n,
  match, then write back with the original line endings — copy that shape.
- `.omc/project-memory.json` had captured two throwaway patch scripts as the
  project's `buildCommand` and `testCommand`, and a fresh session gets that
  injected as project memory. Repaired to `npm run build` / `npm test`. If you
  see a giant `node -e` string presented as "the build command", it is that bug
  again — the real commands are in `package.json`.

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
