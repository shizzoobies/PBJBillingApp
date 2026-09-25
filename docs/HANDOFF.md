# Handoff — PBJBillingApp

Written 2026-07-21, last updated 2026-09-23. Everything below is committed on
local `main` AND pushed — the eleven commits of 2026-09-15 went up at ~16:20
UTC, with the Railway deploy still in flight as this was written (§0 says what
to do first). The working tree was clean at handoff. Read this top to bottom before your first
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

**State right now (2026-09-25, start of day):** `main` = `3427efc`, pushed,
deployed, `/health` 200 with that commit. Suite **4063 tests / 210 files**,
green. Working tree clean, no worktrees, no unmerged branches except
`hold/july-security-p3` (never merge, never delete). Every AI call runs on
`claude-opus-5-5`; subagent dispatches default to Opus 5.5 (omit the model
alias). The two things that shipped on 09-24, newest first, are the top two
entries in section 5 - read them before touching anything:

- **The 1200 px layout pass** (`0a1436c` + handoff `3427efc`): from Lisa's
  screenshot; staff Clients single-column, two-column pages collapse below
  1360 px, owner Clients actions sticky, Reports single-column, wide tables
  scroll. Tracker `featreq-d62b995a` Shipped with the plain-language note.
- **Proposals** (`2f71374`, 34 commits): catalog in Settings, estimate + Opus 5.5
  intake chat, letter, PDF, send, accept/decline. `featreq-ef18a38e` Shipped;
  `featreq-311473e2` is parked at **Needs your answer** on purpose (three
  questions for Brittany: seed rates, sheet blanks, payroll bonus) - flip it to
  Shipped when she answers. Two policy calls made without Alex, reversible: a
  SENT proposal keeps its snapshot rates; Send warns-and-confirms on stale
  letter figures. Accept refuses a billing-master client outright (ask Alex).

Rate history (09-23, `40ed65d` + follow-ups 1-3, 5 live) and the 09-21/22 ships
are in their own section 5 entries; open rate-history follow-ups: 4, 6, 7.
Dev-server verification recipe (two launchers, seeded users, the local
owner's TOTP): the 09-24 afternoon entry and the session memory.

Then the queue / watch list:

0. **Lisa's 36 visible clients (Brittany's 09-24 email)** - by design, not a
   gate bug: 5 on her team, 31 via recurring "Monthly Reconciliations"
   templates assigned to her (Aug 14). Their "Assigned team" shows the
   Bookkeepington / Accountington TEST accounts because the 09-04 reset kept
   only explicit picks. One question is with Alex for Brittany: does Lisa
   really work those 31 (then pick her as the team), or are the templates
   mis-assigned (then reassign them on Checklists)? Retiring the two test
   accounts is a small change if she wants them gone. Reproduce with
   `scratchpad/lisa-visibility*.js` pattern (read-only pg).
0b. **Proposals follow-ups (not blocking):** Brittany's three answers on
   `featreq-311473e2`; Alex's billing-master question; the minors list in the
   Proposals section 5 entry (catalog row label, non-array `services` patch,
   SectionKit number-input draft reset, chat price allow-list, upsell CAS).
1. **Brittany's team re-pick is still unfinished** (13 of 55 clients had an
   empty team on 09-21; Lisa 5, Allison 1). Until a client has a team, staff
   see none of its invoices on the Invoice Recap, and nobody but the owners
   sees the KLC master's combined invoice. **Do NOT "fix" a Board complaint
   by adding people to teams** — the team list is the money gate; the Board
   now reads computed visibility (09-21 entry). The two TEST accounts are
   still explicitly on many teams — if she tests as one she sees a pile of
   invoices and thinks it is broken.
2. **Open Brittany questions:** (a) the two Skip/Push questions (§6 of the
   09-15 entry): may a single subtask be skipped/pushed on its own, and does
   a skip/push advance the next step in a sequence — Push is on every task
   the user can write (`0f68aef`), still whole-checklist; (b) from 09-18: a
   gapped recipe steps by occurrence (its December task covers October) — if
   she expects "the month before it runs", that is a different rule; (c) do
   the "[Review]" and "Test" clients, which look retired but are active, want
   retiring?
3. **Alex's own UI actions still pending from 09-15** (if not done): toggle
   Rivercity's invoicing opt-out, void INV-2026-09-022. The payment-terms
   normalization and the two client merges WERE applied 09-15 (`adc878c`).
4. **Deliverability owner steps** (09-04 entry): safe-sender ask to flagged
   clients, Google Postmaster Tools, DMARC reports to Cloudflare.
5. Resilience Tier 1 is built but the backups are DORMANT — no R2 secrets,
   and Alex said hold off for now (09-03 entry). Tier 2 waits on that.
6. **Watch:** September's KLC generate is the first combined invoice
   (~$720, master `client-lamjjjc`); the first send is irreversible. The
   Payment failed tab: INV-2026-08-031 sits in it until re-sent or paid.
7. Follow-ups: the client-blind checklist idempotency key + 116 legacy
   `(copy)` instances whose client differs from their template's (09-21
   entry — a decision, not a cleanup); team picks live in a field the bulk
   save rewrites, so a stale owner tab can clobber re-picked teams
   (targeted-endpoint pass); remove the eight inert `grantClientVisibility`
   call sites; share `firmDetailLines` between the PDF and the email;
   migrate `railway.json` to `.railway/railway.ts` before 2026-12-01.

**The permission classifier (2026-09-14, now mostly solved).** In a Claude Code
desktop session running in auto mode the classifier can refuse `git push`,
production writes, and the edits to the permission settings that would allow
either — which is why the 2026-09-14 commits sat unpushed. `.claude/settings.json`
now allows exactly two things: `Bash(git push origin main)` and
`Bash(node scripts/prod/tracker-update.mjs *)`. Those rules match **literal
commands**: run `git push origin main` on its own, and the tracker script as a
plain command — wrap either in a subshell, a `cd … && …` chain or a variable
and the rule stops matching, so the prompt comes back. The push rule
deliberately does not cover a force push or a branch delete. Everything else in
the ritual (build, `npm run verify`, commit, read-only production reproduction)
has always run fine. A session that still gets refused stops at the commit,
hands the push and the tracker flips to Alex, and says so plainly in its
handoff entry rather than reporting the work as shipped.

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
(history shows several Claude models); `package-lock.json` IS committed (since
2026-09-03) and must be Linux-generated — refresh it with the
`lockfile-refresh` workflow (§3), never with `npm install` on Windows; `tmp/` is NOT eslint-ignored, so scratch
scripts go in the OS-temp scratchpad, never the repo.

**Picking up in ANY Claude account or environment (claude.ai cloud session,
a colleague's account, a fresh install):** this file is the ONLY memory that
travels — there is no other context anywhere, so read it start to finish
before the first change. What works with nothing but the repo: everything
in §3's ritual up to the push (`npm ci`, `npm run verify`), and the push
itself deploys (Railway watches `main`). What needs credentials, and the
workaround when you have none:
- **Confirming a deploy** without the Railway CLI: `curl -s
  https://app.pbjsa.com/health` — the body carries `commit` (first 7 of
  the SHA Railway built); when it equals the commit you pushed and `ok` is
  true, the deploy is live. Give Railway two to four minutes after the push.
  If `/health` still shows the previous commit after ten minutes, the build
  failed; only the Railway dashboard or the CLI's GraphQL route (§5
  2026-09-03) shows a failed build's log — tell Alex.
- **Production reads and the tracker** need `DATABASE_PUBLIC_URL`. In a
  claude.ai cloud session it is unavailable unless Alex adds it to that
  environment's variables; without it, say plainly that you could not
  reproduce against production, and do not guess at data.
- **Voice re-provision** (manifest changed) needs `ELEVENLABS_API_KEY`,
  `ELEVENLABS_AGENT_ID`, `APP_PUBLIC_URL`, `VOICE_TOOL_SECRET` — without
  them, leave it as the FIRST line of your handoff entry so the next session
  with Railway access runs `node scripts/provision-voice-agent.mjs`.
- **Prod writes** (backfills, resets) are Railway-credentialed and need
  Alex's yes at run time regardless of where you are.
- Cloud sessions work on a branch; the merge to `main` is the deploy. Say
  in the handoff whether the branch is merged — the 2026-09-11 session did,
  and that is what let the next one pick up cleanly.

**On Alex's Mac specifically:** Setup: Node 22 (`node -v`), then `npm ci` (the committed lockfile is
Linux-generated and carries the darwin-arm64 rolldown/esbuild bindings, so it
installs clean on Apple silicon — do NOT run `npm install`, which would
rewrite the lockfile; refresh it only via the `lockfile-refresh` workflow).
Set `git config core.autocrlf false` in the clone so CRLF files stay CRLF
(the repo is mixed per file; the patch-script habit in §3 preserves each
file's endings). `npm run verify` needs nothing else. For deploys and
production diagnostics: `npx @railway/cli@latest login` (browser) and
`gh auth login` as `shizzoobies`; production reads use
`npx @railway/cli@latest variables --service Postgres --json | node <script>`
piped, never pasted. The print check needs Playwright, which is NOT a
devDependency: `npm i -g playwright && npx playwright install chromium`,
then `PLAYWRIGHT_MODULE="$(npm root -g)/playwright/index.mjs" node
scripts/check-print-pdf.mjs` (the script prints this hint itself if the
module is missing). NOT on the Mac and not needed for app work: the desktop updater
signing key (desktop releases stay on the PC), the Jan–May re-import assets,
Brittany's contact-list spreadsheet.

**Machine-local paths (the Windows PC only — gone elsewhere):** the repo at
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
   before every push. Currently **3341 tests / 185 files** (2026-09-21).

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

# health (expect 200) — the body's "commit" must equal the hash you pushed;
# this is the whole deploy check when you have no Railway login
curl -s https://app.pbjsa.com/health

# ONLY when docs/capability-manifest.md changed:
#   export ELEVENLABS_API_KEY / ELEVENLABS_AGENT_ID / APP_PUBLIC_URL / VOICE_TOOL_SECRET
#   from `npx @railway/cli@latest variables --service PBJBillingApp --json`, then:
node scripts/provision-voice-agent.mjs
```

**How the build actually runs (since 2026-09-03):** Railway builds the
`Dockerfile` (Node 22.23.2, npm 11.6.2, `npm ci` from the committed
`package-lock.json`) — NOT Railpack, so no `RAILPACK_*` variable does
anything and none should exist. **When you change dependencies in
`package.json`, refresh the lockfile on Linux in the same commit:**

```bash
gh workflow run lockfile-refresh.yml && gh run watch
gh run download --name package-lock      # writes package-lock.json here
git add package.json package-lock.json
```

A lockfile that disagrees with package.json fails `npm ci` inside the build;
Railway reports a FAILED deploy and the old image keeps serving. And
`/health` is a readiness check now: **503 means Postgres is unreachable**,
not that your code is broken — `docs/runbooks/monitoring-and-rollback.md`.

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

**2026-09-24 (afternoon) - every page stays usable at a 1200 px laptop window.**
Brittany forwarded Lisa's screenshot: on the staff Clients page the "Visible work"
panel sat beside the list and the Checklist / Time / Note buttons were scrolled out
of view inside `.table-wrap`. Root cause: the sidebar is 258 px and the only
breakpoint that collapsed `.two-column` / `.reports-layout` / `.invoice-layout` was
the 1100 px sidebar-hide rule, so from 1101 to ~1400 px every two-column page was
squeezed. Reproduced on the dev server at 1200x800 as the seeded bookkeeper.

- **Fix (`0a1436c`):** staff Clients is `content-grid client-scope-layout` (one
  column, Visible work below the list; `src/__tests__/clients-page-staff-layout.test.tsx`
  pins the order); `.two-column`, `.reports-layout`, `.invoice-layout` collapse below
  1360 px; `.reports-layout` is single-column at every width (the Payroll report is
  7-10 columns); `.report-metric-grid` is `auto-fit minmax(150px, 1fr)`; the invoice
  month-run editor pairs up at >= 1360 px and its lines + hours tables sit in
  `.table-wrap`; the proposal estimate layout pairs at >= 1360 px; the owner Clients
  table pins its actions cell sticky on the right (`.client-table td:last-child`,
  min-width 220 px = two buttons per line); Time entry actions wrap and the edit-row
  inputs shrink; Board column headers and Productivity controls no longer slide
  under the topbar.
- **Dev tooling:** `.claude/launch.json` (gitignored, local only) gained `pbj-api` (API on 4173 with
  `APP_PUBLIC_URL=http://localhost:5173` so the Vite proxy passes the origin check);
  run it plus `pbj-vite`. The seeded local owner has TOTP; the secret is in
  `tmp/auth-state.json` (gitignored) - a 30-second TOTP script in the session
  scratchpad signed in.
- **Not a bug, worth knowing:** Lisa sees 36 clients because 31 of them carry
  recurring "Monthly Reconciliations" templates assigned to her (Aug 14); their
  explicit team is the Bookkeepington/Accountington test accounts because the
  2026-09-04 team reset left only explicit picks and Brittany has not re-picked.
  Visibility follows tasks by design (team-visibility split).
**2026-09-24 - Proposals shipped (featreq-311473e2 + featreq-ef18a38e): an editable
pricing catalog, saved prospect estimates, an Opus 5.5 intake chat and letter,
emailed as a PDF, accepted into a client.** 34 commits on `feat/proposals`
(spec `docs/plans/proposals-2026-09.md`, plan `docs/plans/proposals-2026-09-plan.md`,
15 tasks by subagent-driven development, every task reviewed and re-reviewed, one
whole-branch review + fix wave), fast-forwarded to `main` as `4fa1123`.

- **Where it lives:** `lib/proposal-pricing.js` (seed catalog transcribed from her
  sheet, `priceProposal`, `applyProposalPatch`), `lib/proposal-pdf.js`,
  `lib/proposal-email.js`, `lib/firm-lines.js` (the ONE copy of the letterhead
  lines; the invoice PDF and email read it too), the proposals block in
  `db/store.js` (both backends; `ProposalStateError`), `/api/proposals*` routes
  in `server.js` (all owner-only; writes origin-checked), `src/pages/ProposalsPage.tsx`
  (replaces Engagements; `/engagements` redirects), `src/pages/ProposalEditorPage.tsx`
  + `src/components/proposals/*` (Estimate with the chat on the left, Letter,
  Activity), Settings > Proposal pricing.
- **Rules that bind (do not relax):** prices come ONLY from the calculator; the
  chat and the letter run on `claude-opus-5-5` via `runStructuredModel` with
  `modelFallback:false` and schemas with NO minimum/maximum/minItems/maxItems
  (tripwires); the letter may quote only snapshot figures (validator + a warn-and-
  confirm at Send when the estimate changed since the draft); a flagged or $0 line
  is "Not yet priced", never $0.00; a DRAFT reprices at today's rates when counts
  or services change, a SENT proposal keeps `pricingSnapshot.rates`, a catalog change
  alone never touches a proposal; every status write is guarded in SQL WHERE +
  the file backend (draft -> sent -> accepted/declined; Reprice/Delete drafts only);
  the editor has ONE save queue (`enqueue`/`latestRef`) and the chat, Copy, Delete
  all go through it; Accept checks client/package/billing-master rules BEFORE any
  write, links the client once (compare-and-set), filters plan ids to known plans
  (the June outage hazard), and stamps `createdClientId` on any later error so the
  route can broadcast; proposals are outside the bulk save and the fingerprint.
- **Prod:** the `proposals` table is created at first boot; the only new SQL
  against an existing table (`update clients set monthly_rate ...`) was trialed
  rolled-back on prod before the merge. Voice agent re-provisioned after deploy
  (manifest ~214 KB, tripwire 216,000).
- **Open for Brittany (on the tracker as Needs your answer):** the three seed
  rates (start at $0 - set them before the first proposal), the sheet blanks
  (client call, budget/forecast counts, payroll setup, tax return rate), and
  whether the payroll bonus really scales with the rate squared.
- **Open for Alex:** can a proposal be linked to a billing master at all (Accept
  refuses one even when nothing would be written)? Accept carries only the monthly
  fee (annual/one-time/clean-up are billed by hand); a clean-up-only proposal
  creates a $0 monthly client.
- **Follow-ups (not blocking):** new catalog rows share a "New service" label
  until renamed; a non-array `services` patch should keep the current catalog;
  `SavingNumberInput` in SectionKit does not reset its draft on a rejected same-
  value commit (EstimateTab works around it); the chat's price allow-list covers
  the current turn only; the upsell path has no compare-and-set before its writes
  (two-owner race); API-only `planIds` skip the retired-client check.
**2026-09-23 (evening) — rate-history follow-ups 1 and 2: a re-tag on a
billing master prices at each sub's pin, and every Billable $ on Reports
and the Dashboard's Projected billing price at the pin.** One commit on
`main`, from the final review of the rate-history build.

- **Re-tag on a master** (`lib/invoice-scope-retag.js`): `scopeLineTools`
  now takes the `clients` roster and resolves the rate period PER ENTRY —
  `ratePeriodAsOf(entry's own client, period)` — through all three exports
  (`applyScopeRetag`, `savedAdhocModesForEntries`,
  `unaccountedScopeEntries`; `.d.ts` in step). `ratePeriod` stays as the
  fallback for an entry whose client is not on the roster. The editor
  (`InvoiceMonthRun.tsx`) passes `clients` on `ScopePanelData` and no
  longer computes the invoice-level pin. The store never calls these (it
  only applies the tag flags; the lines come from the editor), so nothing
  server-side changed. Tests: a master with two subs on June/August pins,
  re-tagged to in-scope and to ad hoc on each, plus a ledger case and the
  un-stamped ad hoc match at the sub's rate.
- **Reports Billable $** (`ReportsPage.tsx`, the four reads at the old
  192/459/636/1234): a `billRateOn(entry)` resolver — `billRateAt` at
  `ratePeriodAsOf(entry's client, entry month)` — and `periodBillableOf`,
  which is the new `billableRevenue(entries, billRateOf)` in
  `lib/payroll-cost.js`: `laborCost`'s twin (shared `groupedMoney`
  helper), grouped by person AND rate, billable rows only, NOT deduped
  (full mode bills each client the block). The payroll summary's `amount`
  moved out of the `rows` memo (it would have gone stale when the versions
  landed after mount) — `amountFor(id)` mirrors `costFor`; the detail's
  per-row split groups by (person, rate) like the Cost split so the column
  still ties; the hours-by-month CSV prices each row at its own pin.
  "—" vs $0.00 semantics unchanged: "—" when the person has no rate on
  file at all (newest version, else the live mirror), like `periodCostOf`.
- **Dashboard Projected billing** (`DashboardPage.tsx`): the owner view
  now fetches `/api/rate-versions` and prices each hourly client's entries
  at `billRateAt(..., ratePeriodAsOf(client, billingPeriod), billingPeriod)`,
  firm default as the fallback, as before. The two existing Dashboard
  suites mock the api module wholesale, so they gained `fetchRateVersions`.
- Page tests: `reports-page-rate-pin.test.tsx` (Employee report row, two
  pins add to $100, payroll summary row and detail row + footer at the
  pin; the payroll cases date the entry today because the window is
  anchored to today) and new `dashboard-projected-billing.test.tsx`. All
  five FAIL against the pre-change pages (checked by swapping the old
  files in) and pass on the new ones. Manifest: the two "known follow-up"
  sentences now say the pin is used; the hours-panel and previews
  paragraphs name the master/sub case and the Dashboard.
- Nothing persists; both backends untouched. Follow-ups (3)–(7) of the
  entry below are still open.

**2026-09-23 — Rate history shipped (`cae6ad0`; 30 commits on
`feat/rate-history`, fast-forwarded to main): rates that change without
rewriting the past.** From Brittany's 09-22 Brain session, spec
`docs/plans/rate-history-2026-09.md`, plan `…-plan.md`. Built Fable
orchestrating / Opus 5.5 executing, one reviewer per task plus a final
whole-branch review; the reviews changed real behavior (below), so read the
rules here, not the plan.

*The model.* `bill_rate_versions(user_id, effective_period 'YYYY-MM', rate)`
and `cost_rate_versions(user_id, effective_date, rate)` on both backends
(file backend: slices in the auth store, NOT app-data.json).
`users.bill_rate` / `cost_rate` stay as a mirror of the NEWEST version
(date-blind — a raise dated ahead shows there). Each hourly client carries
`hourly_rate_period` (its rate month) and an append-only
`hourly_rate_history` `{from,to,changedAt,changedBy}`; both are
endpoint-owned — the bulk save restores what is stored and ignores the
payload, on both backends, for stored / stored-null / never-seen clients.
New hourly clients pin to their creation month; the boot migration pinned
every existing hourly client at 2026-06 and seeded one version per rated
user (2026-06 for bill, 1970-01-01 for cost) so nothing repriced — proven
read-only against production twice (29 hourly clients, 58 client-months,
627 entries, 0 differences; a +$1 mutation gives 86).

*The resolver (`lib/rate-history.js`) — every money surface goes through it:*
`billRateAt(versions, employee, pin, billingPeriod)` = the version at or
before the pin → else the person's EARLIEST version if it has started by
the billing month (a new hire's first rate holds until the client's review)
→ else `employee.billRate` only when the person has NO versions → else the
client's own (legacy, often $0) hourly rate. `ratePeriodAsOf(client, month)`
replays the ledger in WRITTEN order: a later move supersedes any earlier
move whose `to` is at/after its own, and cancels an earlier move that had
not started yet — so a correction or an undo takes effect (the first cut
read the ledger by month and never undid anything; the final review caught
it). Cost: `costRateFor(versions, id, entryDate)` by the DAY worked,
everywhere (recap, payroll summary AND detail, analytics); `laborCost`
groups rows by person AND rate so totals tie. Consequences the manifest
now states: a rate saved for month M reaches every client pinned at M or
later (the default month is the current one → every client created this
month); a person's first rate reaches earlier-pinned clients from its start
month; pre-June-2026 months keep the legacy per-client rule everywhere,
including the assistant's profitability tool (which used to price at the
retired client rate for ALL months — closed).

*Surfaces.* Team page: effective-from month/date on each rate box (local
time), history disclosure with Remove on the newest only (server refuses
otherwise, 409 with a sentence; also refused while any client is pinned at
or after that month, ledger `to`/`from` included), Save disabled on an
empty box (the old blank-to-clear path on `PUT /api/team/bill-rate` /
`cost-rate` now answers 409 `rate_history_kept` so a stale tab cannot wipe
a history). Client page → Billing → Hourly rates (hourly, owner only):
each person at the pin, "Rates from June 2026 — 3 months ago" / "this
month" / "starts in N months", Move to current rates from (default next
month; refuses months outside 01–12 or before 2026-06), history as "June
2026 → October 2026". Invoices/Reports previews, the draft generator (subs
of a master at their own pin), Client Recap (hourly multi-month now
reconciles; monthly/annual still restated), the AI hours summary, and
invoice scope re-tag all price at the pin. Staff never receive versions,
pins or ledgers (`loadRateVersions` → empty lists; redaction in
`scopeAppDataForSession`; the six new routes are not preview-aware, the UI
tolerates the 403).

*Follow-ups, in priority order:* (1) re-tag on a billing MASTER prices a
new line at the invoice month, not each sub's pin — **SHIPPED** in the
evening follow-up (entry above); (2) the Employee report's Billable $ and
the Dashboard revenue estimate read the newest mirror — **SHIPPED** in the
same follow-up; (3) DONE 09-23
(third delete guard: a person's only version is refused while any hourly
client is pinned before it, live or ledger `to`/`from`; manifest says so);
(4) the Hourly rates block lists everyone with a started rate, not the
assigned team — ask Brittany; (5) DONE 09-23 (`rateOf()` in the resolver:
only a finite `number` is a rate, so a `rate: null` row reads as no
rate — note the store's list paths still `Number()` the column, so a null
would reach the resolver as 0; unreachable while the columns are NOT
NULL); (6) the file-backend pin move and the
migration do two-slot read/writes (dev only); (7) `memberFilter` narrows
the payroll detail but not the summary (pre-existing).

*Process notes worth keeping.* The Plan agent type cannot write files —
have it return the plan in chunks under ~40k chars and assemble; scoped
reviewers repeatedly caught brief-inherited defects (a test asserting
nothing, a fixture that could never pass, UTC dates) — the brief is a
starting point, not evidence; two writers on one branch collide on git's
index, so one implementer at a time with reviewers in parallel. The visual
check ran against the file backend at http://127.0.0.1:5173 (the API serves
`dist/`; vite proxies to a foreign 4173 process on this machine) with the
demo owner enrolled in TOTP locally; the pane would not paint, so it was
DOM-level.

**2026-09-22 (night) — "Britt's Brain wasn't working": a provider-side
fault on ONE request shape, routed around (`21b0f0d`), and the assistant
model bumped to `claude-opus-5-5` (this commit).** Three of her brainstorm
turns (15:06, 16:02, 16:04 UTC) came back from `claude-opus-4-8` as HTTP
500 `api_error`; the brainstorm's deliberate no-fallback rule showed "at
capacity". Method worth keeping: reproduce through the app's own
`spitballChat` with the real session, then bisect with real content —
schema floors, max_tokens, messages alone, context alone, each past
summary alone all pass; the full request fails ~50% of raw attempts and
the SDK's identical retries fail together; drop the past-session
summaries block and it passes 8/8. Not the deploys (path untouched), not
the status-page incident (hours later, other models), no bad characters.

Two fixes: (1) `spitballChat` retries ONCE on the same model with
`pastSummaries` dropped (running summary + parked titles kept) on a
FALLBACK_STATUSES status or the transient "Invalid request data" 400, then
the unchanged 503; `modelFallback:false` stands; five tests pin it.
(2) The assistant default is now `claude-opus-5-5` (released 2026-09-21;
confirmed via the live models endpoint — the cached skill table predates
it). Proven on her real session through the app's code: 3/3, no reduced
retry needed, ~3.5 s a turn; refine also fine. Every assistant feature
(brainstorm, refine, read-back, walkthrough, package suggestions, chat)
follows the default; `INVOICE_AI_MODEL` (the confidence rating) was bumped
to `claude-opus-5-5` in the follow-up commit on Alex's word (plan doc
updated). **Trap found on the way, worth remembering:** 5.5's
structured-output validator REJECTS `minimum`/`maximum` on integers and
`minItems`/`maxItems` on arrays (400 "properties … are not supported") —
`claude-opus-5` accepted them. Two schemas carried them (the rating's
`score` + arrays; the package proposals' `dueDayOfMonth` + arrays), so the
rating would have 502'd on every Generate and "Suggest checklists" was
broken for the ~hour the assistant default was 5.5 before this fix. The
caps moved into the validators (which already clamped/sliced); a source-
scan tripwire in `lib/assistant.test.mjs` and a schema walk in
`lib/invoice-confidence.test.mjs` pin that no schema grows one back. Proven
by running every structured function for real on 5.5 (rating: high/92 on
INV-2026-08-058; suggestions, walkthrough, read-back, summary all OK).
`enum` and string `minLength` are accepted. Opus 5-
family models run adaptive thinking by default, so turns cost a little
more than 4.8's; nothing in the request shapes needed changing (no
prefill, no budget_tokens anywhere). The 08-28 outage and this are the
same family: the provider intermittently rejects specific prompt shapes;
the app now degrades the REQUEST instead of the model.

**2026-09-22 (later) — "Walk me through it" on the Updates page, and
Packages (plan bundles that bring their checklists).** One commit,
`d86b6f1`, two tracker items (featreq-cb1c5f95, featreq-f890f05b) — built
in parallel by two Opus agents that both appended to the tail of
`lib/assistant.js` and its tests, so they could not be split cleanly.
Suite **3449 tests / 190 files**.

- **Walkthrough:** `POST /api/feature-requests/:id/walkthrough` (owner-only)
  generates from dev_notes + a keyword-picked manifest section, stores it
  on the row (`walkthrough`, `walkthrough_at`, both backends — never
  cleared by a status change), returns the stored text unless
  `{regenerate:true}`. Inline panel on shipped cards beside the approve
  controls; approval untouched and pinned. Uses refine's plumbing INCLUDING
  its Haiku fallback — the output is persisted, so if a degraded model ever
  writes nonsense the fix is Regenerate (or switch it to
  `modelFallback:false` like spitball).
- **Packages:** `packages` table (Postgres) / auth-state slice (file backend
  — NOT `app-data.json`, which the bulk save replaces wholesale), outside the
  fingerprint by construction. Plans already link templates
  (`subscription_plans.template_ids`), so a package's checklist set defaults
  to the union of its plans' templates. Apply = union planIds via the
  targeted client update + `copyTemplateToClient` per standard template,
  skipping ones the client already has (`sourceTemplateId` — the server copy
  did NOT stamp it before this; the browser clone always did). **A package
  changes no money** (plans are labels; `lib/invoice-lines.js` untouched) —
  Brittany's note says so; a priced package is a separate ask. AI suggest
  = proposals only (`modelFallback:false`), created as standard templates
  only after Create selected + confirm. Residual: `deletePlan` does not
  strip the id from packages (FK-free idiom; apply filters unknown ids, the
  Plans page shows "A deleted plan"), so a package can quietly fall below
  two valid plans.

**2026-09-22 — the Team page's Assigned clients control moved under the
person's name and gained a one-click "Add all" of the clients they work
on** (`302b1a6`, Alex's direct ask: "how can Brittany add more people for
her team to see on the invoice recap, is there a quick and easy way … leave
it on the team page but move it right below the name"). The Suggested
block is `taskClientIdsForUser` minus the current team — the same rule
task visibility uses — shown to the owner BEFORE she presses anything; it
is a deliberate widening of the money gate and is documented in the
component as never-to-become-an-automatic-backfill (that is what the
09-04 split removed). Every add is still the per-client
`setClientAssignedTeamRequest`; the add menu stays open across picks.
Suite 3349 / 186. This is the tool for finishing the team re-pick in §0
item 1.

**2026-09-21 — two urgent Brittany bugs fixed (both were code, both
reproduced against production first) and owners can carry a cost rate.**
`main` = `4c66113`, deployed (health `commit` confirmed), suite **3341 tests
/ 185 files**, voice re-provisioned, all three tracker items Shipped with
notes in her terms. Built Fable-orchestrated / Opus-executed: two read-only
diagnosis agents first, fixes only after the diagnoses landed.

| Commit | What |
|---|---|
| `243fc76` | **Owner cost rate** (featreq-6fdd9e98, "I need a cost for Brittany"). One functional line: the Team page hid the Cost rate box for owner rows. Every read path was already role-agnostic and the field persisted on both backends; the rest of the diff corrects prose that claimed owner time carries no cost. Alex's row stays blank ($0) by his own ruling. |
| `6ddd53b` | **Board "my bookkeepers"** (featreq-4fa0e70f, urgent). The rule read the EXPLICIT team — the money gate since 09-04 — so an accountant who reaches clients by task assignment (Allison: 1 explicit, 14 task-derived) could never reveal a colleague. Now it reads the computed side: assignees of live work on the clients she can see, owners excluded at the leaf (toggle, board, Completed tab, Clients badge share it). Containment pinned. **Do not "fix" this by adding Allison to teams — that re-opens the 09-04 invoice leak.** |
| `4c66113` | **Recipe Duplicate** (featreq-0bc2437e, urgent). Duplicate was a live `{...source}` spread keeping the source's client AND createdAt; the materializer spawned Let's Eat instances in the minutes before she re-aimed the copy at I-95, and the client-blind idempotency key then owned those months for good. Now one shared clone (`src/lib/cloneChecklistTemplate.ts`) serves both copy paths; a Duplicate starts switched OFF, dated today, and opens its editor; changing a recipe's client with live instances confirms first. |

**Prod write (approved by Alex, September forward):** hard-deleted the two
misfiled instances `check-4lod9nn` / `check-5s3sv4f` (Let's Eat-stamped,
no time entries; items cascaded) and set `template-uyfnwg1.created_at` to
2026-09-21. Rehearsed in a rolled-back transaction first. Undo:
`docs/prod-snapshots/2026-09-21-i95-duplicate-pre-repair.json`. The recipe
is still OFF and `monthly` / Sep 30 exactly as Brittany left it — she turns
it on.

**Left open, deliberately:**
- The instance `clientId` snapshot + client-blind idempotency key
  (`lib/checklist-identity.js`) is the underlying hole; 116 legacy `(copy)`
  instances already mismatch their template's client from the Aug 14 seed.
  Historical, mostly worked — not touched. Repointing instances on a client
  change is a decision, not a cleanup (time entries and invoices hang off
  them).
- All 55 `clients.updated_at` share one bulk-save timestamp from 09-21:
  team picks live in a field `PUT /api/app-data` rewrites, so a stale owner
  tab can still clobber re-picked teams. The staleness guard covers it only
  if the tab is actually stale by fingerprint. Worth a targeted-endpoint
  pass.
- `activity_log` is trimmed to 200 rows per user, so "did she re-pick
  teams since 09-04" cannot be answered from it — read the team lists.
- Teams are still half re-picked (13 of 55 clients have an empty team).

**2026-09-18 — three planned items shipped in one day (billing-email check,
period-covered label, recipe start floor), one production write applied (17
period labels + 26 recipe anchors), and Brittany asked one clarifying
question.** `main` = `0d7a6b7` + this docs commit, deployed SUCCESS,
health 200, voice re-provisioned.

- `58087f0` **featreq-284119d9** — her "missing billing address" was the
  To 100% "Add a billing email" item checking only `client.email` (blank on
  50/51); it now runs `resolveInvoiceRecipients` (contacts too), mirrors
  `invoiceEmailAddressee` for masters (the named sub's addresses; the quick
  fix writes there and says so), still asks a sub (retainers), and a master
  with no receiving company raises "Pick a receiving company" (high).
- `8bc1fda` **featreq-053fccba** — three stacked defects in
  `lib/checklist-period-label.js`: anchor = meaningless nextDueDate for
  specific-months (SPA now anchors to the first designated month not yet
  finished; the math snaps stray anchors), steps counted calendar months (now
  scheduled occurrences), whole-month windows stepped end-anchored (now whole
  months, span preserved; Feb 28 in a leap year counts as month-end). Saving
  a recipe's dates restamps its OPEN instances from the anchor month on
  (`restampPeriodLabelsForTemplate`, both backends, wired into the bulk save
  because templates have no PATCH route). Production write, approved by Alex,
  applied after deploy: `scripts/prod/fix-period-labels.mjs --apply`
  re-anchored 26 recipes to 2026-09-01 (all set on 09-17) and restamped 17
  Sep-10 "Monthly Reconciliations" from "October 31 – November 30" to
  "August 1 – August 31"; snapshot in `docs/prod-snapshots/`, `--undo`
  available; re-scan after = 0 stored disagreements. Four recipes with a
  window but NO anchor were left alone (Associated Enterprises, Emerald,
  Four Leaf, Ride Right) — re-saving their dates fixes them. Read-only
  scan: `scripts/prod/scan-period-labels.mjs`. Open design question from
  review, NOT changed: a gapped recipe (Feb/Mar/May/Jun/Aug/Sep/Nov/Dec)
  steps by occurrence, so its December task covers October — if Brittany
  expects "the month before it runs", that is a different rule; ask her.
- `0d7a6b7` **featreq-c133daf8** — a recipe carries `createdAt` on both
  backends and nothing spawns before it (`lib/checklist-start-floor.js`):
  copies start on the first cycle on/after today unless a date is chosen (a
  chosen past date also sets the stamp, so the floor never fights it);
  specific-months skips months before creation at MONTH granularity; the
  cadence loop floors only when MORE THAN ONE backdated cycle would spawn.
  Mirrored in the browser materializer and the client page's local
  plan-checklist clone (a third path that bypasses the endpoint — the one
  most likely to be re-broken). Legacy recipes without a stamp are
  unchanged. Prod scanned first: 146/154 recipes carry the 2026-08-14 load
  date; nothing due is suppressed.
- **featreq-6fdd9e98 "I need a cost for Brittany"** → `needs_input` with a
  question asking whether she means a cost rate for herself (owners have no
  Cost rate box on the Team page; owner time is deliberately $0 in the recap
  per the manifest) and what number. Do not build until she answers.

Traps this stretch added: two agents editing the same file interleave
hunks — stage per item by rebuilding each file's content from line ranges;
`git add -p` under `diff.context=0` placed hunks at the wrong offsets. The
fixer scripts write a snapshot even in dry-run mode — delete dry-run
snapshots before committing. The manifest does not carry the SPA's hint
strings; anchor manifest patches on manifest text.


**2026-09-15 — the pay-window session: no 7-day window existed, the customer is
told due on receipt, the 30-day line is internal, the Pay link is durable, Past
due is a derived tab plus a dashboard section plus one email, preview-as was
the Allison leak, five tracker items closed. Eleven commits on local `main`,
PUSHED 2026-09-15 ~16:20 UTC with the deploy in flight as this was written —
production was still serving `5933d5d` at that moment.** Suite 3241 tests /
182 files, green (3010 / 176 the night before).

Alex's ask opened it: "clients let their invoices time out because we sent them
with the standard 1 week pay window; up that to 30 days", and "tell us when a
sent invoice has timed out". **Read-only production reproduction found there
was no 7-day window.** The default due date was already period end + 30 days.
What actually bites is two other things: 22 clients carry "Due on receipt"
terms, so their due date lands in the past on the day the invoice is sent; and
the real *timeouts* are Stripe's — a Checkout Session expires after 24 hours,
and a bank microdeposit verification after 10 days. The ask therefore
decomposed into three separate builds, and Alex made the calls: everyone gets
30 days; then, after seeing the wording, **the customer must still be told "Due
on receipt"**, which makes the stored 30-day date the firm's own internal
past-due line rather than a promise to the client; and yes to a durable pay
link.

| Commit | What |
|---|---|
| `38f6a43` | **Prod scripts**: the payment-terms normalization (renamed in `7eb9a32` once the client-facing wording changed) and `scripts/prod/tracker-update.mjs --file-shipped`, which files a new `shipped` row for a feature Alex ordered directly — this night's headline work had no tracker item of its own. |
| `03abb58` | **Every invoice is due 30 days after it is issued.** `DEFAULT_PAYMENT_WINDOW_DAYS` and `dueDateFromTerms(issueDate, terms, window)` replace the period-end arithmetic; a client whose terms parse to a *longer* Net N keeps the longer one; `paymentTermsLabel` prints terms that agree with the date. |
| `690537b` | **The client is told "Due on receipt."** Email, PDF and preview all say it, and no date is shown unless the client's terms parse to Net N of 30 or more. The stored `due_date` is internal: it drives Past due, and it is not what the customer reads. |
| `7eb9a32` | `scripts/prod/set-payment-terms-due-on-receipt.mjs` — 35 rows in the dry run, purely cosmetic (it aligns each client's stored terms string with what the invoice now prints). **Apply only with Alex's yes** (§6). |
| `e031dd4` | **The Pay button is a durable link.** `GET /pay/<token>` (and `/card`), backed by `invoices.pay_token` and a unique index, minted lazily and **persisted before the redirect**, so a link emailed weeks ago still opens a fresh Stripe page. Plain HTML status pages for paid / canceled / opted-out, and `returnTo` on the Checkout sessions. The email's Pay button and the copied link are now `app.pbjsa.com/pay/<token>`, not a one-shot Stripe URL. |
| `c4ed368` | **Past due.** `pastDueInvoice(invoice, today)` in `lib/invoice-overdue.js` — derived, never a stored status, and a payment failure wins over past due. A "Past due" tab between Sent and Payment failed, a row flag, a fifth stat, an alert in the editor, an owner dashboard section "Invoices past due", and an hourly `maybeNotifyPastDueInvoices` that sends **one** `invoice_past_due` owner email per invoice (marker `{kind:'past-due'}` in `email_log`) under a new `invoiceAlerts` prefs group. `recordInvoiceSent` re-stamps `due_date` on the FIRST send to send day + window. |
| `3b037a3` | **`scripts/prod/merge-client.mjs <dup> <survivor> [--apply]`**, for two real pairs: `client-seed-susannah-dobbs` → `client-1bk7piv` (Dobco, 6 entries) and `client-seed-sophie-sorensen` → `client-k8xj4gr` (Sophie Paris, 1 entry). It re-points every reference across the **eight FK-less `client_id` columns** and **retires** the duplicate instead of deleting it — `cleanupOrphanedClientData` would hard-delete a deleted client's children. Both dry runs verified and rolled back; apply needs Alex's yes. Dobco's April and May gain 3.6 billable hours when it lands. |
| `a0e4477` | **Preview-as was Brittany's "Allison can still see clients not hers".** The SPA now sends `X-Preview-As`; `previewScopedSession` (`lib/preview-scope.js`) scopes `/api/app-data`, `/api/invoice-recap`, `/api/waiting-on-me`, notifications, item deletions and pending edits to the previewed user, and every other `/api/` GET under preview **fails closed** with 403 `preview_unsupported`. The Invoice Recap had been answering with the owner's scope under Allison's name. Allison's real login shows Skyline only — verified against production. |
| `0f68aef` | **Hardening from the security review, plus two tracker items.** Preview: `setPreviewUser` moved out of the render phase, an unresolvable id refuses instead of guessing, cases / notes / team activity scoped, logout clears preview first, a `preview_started` activity row, behavioral tests. `featreq-68638ed2`: **Push is offered on every task the user can write** — it had ridden Skip's per-template opt-in, and only 6 of 150 templates allow skipping, so Push was invisible almost everywhere. `featreq-60f24838`: the FilterBar client dropdown hides retired clients ("17 Signature" sat at the top of the Checklists and Gantt filters), plus the two empty-query template-list holes. |
| `81c5033` | **Fixes from two Opus review passes.** Pay link: one live Stripe session per invoice (`swapInvoiceCheckoutSession` returns the id it replaced and all three mint sites expire *that* one), the `/card` return trip, HEAD never mints, per-IP last hop, `getClientById`, and its own try/catch so a failure is an HTML 502. Past due: the first-send re-stamp is `$5::date::text` (see the traps below), longer client terms are honored, each notify is wrapped in its own try/catch, and `GET /api/invoices?pastDue=1` returns the summary the dashboard reads. |
| `c175447` | **A client can opt out of platform invoicing** (`featreq-006f12f6`): `platformInvoicingOptOut`, a generate skip reason `opted-out`, 409 `client_opted_out` from send / payment-link / retainer, an opted-out `/pay` page, a month-run badge with Send disabled, and completeness checks that stop nagging about billing and email issues for that client. **And a found bug:** `clients.stripe_customer_id` was written but never SELECTed on Postgres, so every bulk save wiped it and every send created a *new* Stripe customer. It is now selected, stored-wins on bulk save, and stripped for non-owners. |

**Three of the five tracker items were interpretation, not code** — §7's
queue-run contract now says this out loud. Push was invisible because of a
visibility rule inherited from Skip; the filter complaint was a retired client
sitting at the top of a dropdown; and "Allison can still see clients not hers"
was preview mode answering with the owner's scope. Reproducing what the
reporter was actually looking at found all three. Re-reading the feature's code
would not have.

**Traps this stretch added.**

1. **`invoices.due_date` is TEXT in production**, not `date`. The committed
   first-send re-stamp used `$5::date` inside a `CASE` against it and failed at
   parse time — "CASE types text and date cannot be matched" — so every send
   would have 500'd. `$5::date::text` is the fix, confirmed and re-verified
   with rolled-back trials. **Never write `$n::date` in a CASE against that
   column.**
2. **`fakePostgres` does no type checking**, so the suite was green with that
   bug in it. For any new SQL, a rolled-back (`BEGIN` … `ROLLBACK`) trial
   against production is mandatory — it is the only thing that sees
   production's real column types. §4 has the recipe.
3. **Allow rules match literal commands.** Run `git push origin main` and
   `node scripts/prod/tracker-update.mjs …` as plain commands; a subshell, a
   `cd … && …` chain or a variable in the string and the classifier prompts
   again (§0).
4. **A new notification event needs a prefs group.** `invoice_past_due` lives
   in the new `invoiceAlerts` group — without one, nobody can turn the email
   off.

**Production facts recorded today (read-only).** The September run generated
2026-09-15 at 14:14 UTC, 35 drafts. Brittany re-picked 5 Sunset's team (Lisa)
at 14:18 UTC with three stale-tab refusals along the way — the first
`client_team_updated` since the 09-04 reset, and the only one so far. The KLC
master client's team is empty. The TEST accounts are still on 33 / 16 teams.
INV-2026-08-031, the microdeposit failure, was paid on 2026-09-15.
INV-2026-08-023 — Ride Right, $513.40 — is the only sent invoice past due
today, so the first boot of the new build sends exactly one `invoice_past_due`
email per owner.

**Two questions for Brittany** came out of this session and are written up in
§6: was the preview banner up when she saw Allison's extra clients, and do the
"[Review]" and "Test" clients — which look retired but are active — want
retiring?

**2026-09-14 — four planned items built in one night for the Brittany meeting;
seven commits UNPUSHED on local `main` because the session could not push.**
One desktop session, working the tracker queue ahead of Alex's 2026-09-15
meeting with Brittany. Everything in the ritual worked except the push: the
session's auto-mode permission classifier refused `git push`, refused the
tracker write, and refused the edits to the permission settings that would
have allowed either. The build, `npm run verify`, the commits themselves and
read-only production reproduction were all fine. So as of this entry
**production is still `a58b33d`**, and Alex pushes and runs the four tracker
flips himself — the exact commands are in §0.

| Commit | What |
|---|---|
| `7c52aa6` | **Client Recap lists active clients by default**, with an "Include inactive clients" checkbox that adds the retired ones, each marked "(inactive)". Resolves the `featreq-60f24838` send-back — "I can still see inactive clients on client recap - I want to be able to recap old clients but not on a regular basis" — which is a default, not a ban: the old clients stay reachable, they just stop being in the way. `clientLifecycle.ts`'s doctrine comment amended to match. **Invoice Recap deliberately untouched**: it is history-only and has no picker, so there is nothing there to default. Manifest updated. |
| `69bea34` | **The health test was red on `main`.** `src/__tests__/health-readiness.test.ts` asserts against a slice of the route's source, and `a58b33d`'s new `commit` field had pushed the body past the 1600-character slice — so the suite had been failing since that push, not because of anything in it. Widened to 2400. |
| `678478c` | **`scripts/prod/tracker-update.mjs`**, the committed single-row `feature_requests` write. It mirrors `updateFeatureRequest`'s semantics: `shipped` stamps `shipped_at` and clears the review fields, `done` stamps the approval; `--dry-run` prints the row and the planned change and writes nothing; the connection string comes from the environment or from the Railway CLI. It cannot touch another table or more than one row, and that is exactly what makes it runnable under the standing approval in §7 — keep it that way. Usage: `node scripts/prod/tracker-update.mjs <featreq-id> --status shipped --dev-notes-file <file>`. The commit also carries `docs/prod-snapshots/2026-09-14-featreq-0c2d4ce5-dev-note.txt` — the explanation Brittany is owed on the Invoice Recap item: the fix has been live since Sept 4, the team lists were reset so she must re-pick teams, and the two TEST accounts still hold 34 / 17 clients. |
| `4fcfc5e` | **Checklists: a Push button** (`featreq-68638ed2`). Push wears the same form as Skip — who, and an explanation — plus a date that defaults to the next cycle. It sets `due_date`, records the original in the new `checklists.cycle_due_date` (written once, so a second push still remembers where the task started) alongside `pushed_at` / `pushed_by`, and writes an audit row in `checklist_skips`, which gained `kind` ('skip' or 'push') and `new_due_date`. The materializer's identity keys read `cycleDueDate ?? dueDate` through `checklistIdentityDueDate` in `lib/checklist-identity.js`, and the Postgres unique partial index is replaced by `checklists_template_instance_uniq_v2` on `(template_id, coalesce(cycle_due_date, due_date), stage_index)` — that pair is what keeps a pushed task in its own cycle instead of colliding with, or suppressing, the next occurrence. Route `POST /api/checklists/:id/push`; activity `checklist_pushed`; notify event `checklist_pushed` in the `skippedTasks` prefs group; the dashboard section is now "Skipped and pushed tasks to review". The load-bearing test is `src/__tests__/checklist-push-next-occurrence.test.ts`, which runs the real materializer rather than a stand-in. |
| `bcfea18` | **Push hardening, from an Opus review pass** (it keeps finding real things). `projectRecurring.ts`'s Show-upcoming overlay keys on the cycle date — a default push lands on the next cycle's own date and was hiding that cycle's ghost. The index swap is one BEGIN/COMMIT on a dedicated client with a ROLLBACK, so v1 survives a dirty database instead of leaving the table with no unique index at all. Bulk save snapshots `cycle_due_date` / `pushed_at` / `pushed_by` before the wipe and writes the stored values back, in BOTH backends, so a stale tab can no longer erase a push. The SELECT column list is pinned, and the push date is capped two years out. Nits: the picker's minimum is the day after, an aria-label, clearer 409 wording on the race. |
| `d0cbf19` | **Invoices: an hours review panel beside the open invoice** (`featreq-8cec48db`). `src/components/InvoiceScopePanel.tsx` sits next to the open editor and groups the period's entries by team member (date, description, task, hours); each is tagged **In scope**, **Out of scope** or **Ad hoc** (with the three adhoc modes). Tags stage in editor state and the running total comes from `applyScopeRetag` (`lib/invoice-scope-retag.js`) — a pure function that adjusts the stored lines **in place** and never regenerates the invoice. Save sends `{ lineItems, blurb, entryTags }` to the existing `PATCH /api/invoices/:id`; `updateInvoice` validates every entry id (exists, in the period, and on the client or one of a master's subs), refuses unless the invoice is draft or reviewed and hourly with a period from 2026-06 on, and writes `time_entries.billable` / `is_adhoc` in the same transaction (Postgres) or the same read-modify-write (file). Generated adhoc lines carry an `entryId`, which `sanitizeInvoiceLines` now names, and the owner re-approval exemption was widened to `billable`. |
| `7f6b777` | **Hours panel fixes, from a second Opus review — two reproduced money bugs.** Adhoc→adhoc with no findable line no longer adds a second priced line (it blocks); a subtraction that would go negative no longer deletes the whole hourly line (it blocks); the arriving adhoc line is priced at the rate the hours were actually billing at, so the swap is net-zero (Fore Motion shows a half-cent, from the two roundings being independent). The warning survives a save via `unaccountedScopeEntries`, `savedAdhocModes` recognizes legacy adhoc lines, the Postgres `time_entries` UPDATE carries client and period predicates with the lookup inside the transaction, the server refuses `entryTags` on an invoice the feature does not apply to, and a reverted tag still leaves `tagEdits`. |

**Why the hours panel refuses instead of guessing.** Production reproduction
found that **38 of the 40 live hourly lines since the June cutover are
hand-renamed and carry no hours and no rate**. The naive design — add the ad
hoc line, take the hours off the hourly one — has nothing to take them off of
there, so it would have quietly double-billed. Hence the `blocked` rule: a
charge is only ever added when the matching hours could be taken off. The tag
still saves, and the row says why it could not be priced. That is the shape to
copy the next time a line-editing feature meets this data.

**Scope decision on Push**, flagged rather than guessed: push is
whole-checklist, exactly like skip. Whether a single subtask should be
skippable or pushable on its own, and whether a skip or a push should advance
the next step in a sequence, are Brittany's calls — Alex meets her 2026-09-15
(§6). Do not build past her answers.

**The manifest changed in `7c52aa6`, `4fcfc5e`, `bcfea18`, `d0cbf19` and
`7f6b777`**, so the **voice agent re-provision is owed after the deploy**
(`node scripts/provision-voice-agent.mjs`).

**Production read-only sweep at session start (2026-09-14):** `/health` 200,
serving `a58b33d`. INV-2026-08-031 is in the Payment failed tab and is the
only failure in the table — that feature is doing its job. The team re-pick is
NOT done (Lisa 0, Allison 1, the test accounts still 34 / 17,
`client_team_updated` never logged: exactly the post-reset state). The KLC
September combined invoice INV-2026-08-045 generated correctly — $929.93, 13
lines across the four members, no member billed separately — but it was never
emailed from the app and was marked paid by hand on 2026-09-01;
INV-2026-08-056 (Skyline, $255) is the same pattern, so ask Brittany whether
she means to send these from the app at all. No bounces and no complaints. 60
time entries in the last seven days. Backups still dormant — no R2 secrets in
GitHub or Railway — and Alex said hold off on that for now.

**The classifier constraint, recorded because it will happen again.** This
session ran in a Claude Code desktop session in auto mode, and the permission
classifier refused `git push`, the tracker write, and the settings edit that
would have allowed either. The fix is `scripts/prod/tracker-update.mjs` (above)
plus allow rules `Bash(git push*)` and
`Bash(node scripts/prod/tracker-update.mjs*)` in `.claude/settings.json`.
Until those are in place, a session that hits this should stop at the commit
and hand the push and the tracker flips to Alex — and say so, rather than
reporting the work as shipped.

**2026-09-11 — the month run has a "Payment failed" tab. MERGED + LIVE
(deployed 2026-09-13; the INV-2026-08-031 backfill was applied 2026-09-11).
Built and reviewed on branch `claude/brittany-update-requests-c74z9v`.**
Built from a claude.ai cloud session (no Railway login, no `DATABASE_URL`, so
no prod reproduction and no deploy — the first session in this history with
that constraint; §0's "picking up on a different machine" applies, plus: the
tracker is unreadable from there unless `DATABASE_PUBLIC_URL` is added to the
cloud environment's variables). Alex's ask, after an owner email "Payment
failed on invoice INV-2026-08-031 — Microdeposit verification … timed out":
"we need a failed section probably so she knows to follow up with the client."

What the failure IS: the client picked Stripe's manual bank entry instead of
instant login, never confirmed the microdeposits, and Stripe cancelled the
intent after 10 days. No money moved. The webhook (`server.js`
`payment_intent.payment_failed`) already put the invoice back to `sent` and
notified owners — and left NO trace on the invoice, so the row read "Sent"
exactly like a client who never opened the email. That was the gap.

| Commit | What |
|---|---|
| `03e4249` | **The tab.** NOT a status — a derived tab. `recordInvoicePaymentFailure` (db/store.js, both backends, modeled on `recordInvoiceDeliveryEvent`) appends `{kind:'payment', event:'failed', at, paymentIntentId, detail}` to the append-only `email_log`; never touches status; idempotent on the intent id. `unresolvedPaymentFailure()` (src/lib/utils.ts) = status `sent`/`overdue` AND newest failure newer than the newest successful invoice send → `byTab` routes it to **Payment failed** (between Sent and Paid) instead of Sent. Row: red `invoice-run-flag is-bad` "Payment failed Sep 10", Stripe's reason on hover. Editor: `role=alert` notice with the reason + "follow up, Send again for a fresh link, or Mark paid". **Send again is the follow-up and returns it to Sent.** A copied payment link does NOT clear it (that route logs no send) — the client's next attempt moving the status does. Owner notification now names the client. Manifest updated. |
| `f82e97d` | **From the Opus review pass** (it found real things — keep doing it): the Stripe event id is ledgered BEFORE the handler runs, so a 500 on the new log write would NOT be retried into a second chance — Stripe's retry answers `duplicate` — and the owners' notification would silently never fire. The write is `.catch`-wrapped, pinned by a source test that the catch sits between the write and the notify loop. Also: "the pay link no longer works" → "may" (true for bank — the Checkout session is spent — false for a card decline, whose session stays open); the manifest paragraph had swallowed the tabs paragraph's sort sentence; the UI fixture used 14:00Z, which `formatSentOn` (LOCAL time, no TZ pinned in the suite) renders as the next day at UTC+10 — every sibling fixture uses 10:00Z, now this one does too. |

Deliberately left (review flagged, cosmetic): dedup is on `paymentIntentId`
only, so a card retried inside the same Checkout session keeps the FIRST
attempt's date; a late failure for a voided-and-regenerated invoice logs onto
the dead row (matches delivery events; nothing renders, notification still
fires).

**INV-2026-08-031 itself predates the log write and will NOT appear in the
tab after deploy.** Alex asked for it backfilled with the reason:
`scripts/prod/backfill-payment-failure.mjs <number> [--apply]` — reads the
reason and time from production's OWN `invoice_payment_failed` notification
rows and the intent id from the invoice row, snapshot to
`docs/prod-snapshots/` before the write, `--undo <snapshot>`, dry-run by
default. It is a prod write: Alex's explicit yes at run time, then commit the
snapshot. The webhook has stored no client name for it — find it in the
August run under Sent (search "031").

**2026-09-04 (evening) — invoice email deliverability: named sender + human
reply-to, a Resend delivery webhook that puts Delivered / Bounced / Marked
as spam on the invoice, and a softer body. LIVE (`17a9797`), webhook
registered and proven with signed probes.** Brittany reported client
invoices landing in spam. Verified first: DKIM (resend._domainkey.pbjsa.com)
verified, return path `send.pbjsa.com` aligned, DMARC `p=reject` passing,
no click/open tracking — authentication was never the problem.

What changed:
- Service vars: `INVOICE_EMAIL_FROM` = `PB&J Strategic Accounting
  <billing@pbjsa.com>` (was a bare address), `INVOICE_REPLY_TO` =
  bferguson@pbjsa.com, `RESEND_WEBHOOK_SECRET` (set from the Resend API
  response, never seen). billing@ is a real M365 mailbox (Alex tested).
- `lib/notify.js` `sendInvoiceEmail`: reply_to, friendly From when the var
  is bare, Resend tags `invoice_id` + `kind`, and the provider message id
  stored on the email-log entry (`providerId`).
- `POST /api/resend/webhook` (server.js, verified on raw bytes by
  `lib/resend-webhook.js` — Svix HMAC, ±5 min, any-of signatures). Records
  `{kind:'delivery', event, at, providerId, to, detail}` on the invoice's
  email log via `recordInvoiceDeliveryEvent` (BOTH backends; Postgres
  `email_log || $2::jsonb`, proven in a rolled-back txn), idempotent, NEVER
  touches status; notifies every owner on bounced/complained
  (`invoice_email_bounced`). Resend webhook id
  `71dcdb62-ffdf-4f88-b188-e9d12e45993a`, events sent / delivered /
  delivery_delayed / bounced / complained. Live probe: signed 200
  `matched:false`, tampered 400, unrelated type 200 `ignored`.
- SPA: `InvoiceDeliveryBadge` on the month run next to "Sent to …";
  `latestInvoiceSend` now means the INVOICE email (acks/receipts excluded),
  so a bounced invoice never reads "Delivered" because the receipt landed.
  Invoices sent before this deploy have no providerId → no badge, by design.
- Body: amount + due date sentence above the pay button, firm contact
  block in the footer, both parts. `firmContactLines` is a copy of the PDF's
  `firmDetailLines` — a follow-up should share it.

Still Alex's / Brittany's: ask flagged clients to add billing@pbjsa.com to
contacts; register pbjsa.com in Google Postmaster Tools (DNS TXT) and point
the DMARC `rua` somewhere read (it goes to a GoDaddy default today). The
bigger lever if spam persists: send through her M365 mailbox via Graph.

Unrelated but noticed: Railway now warns that `railway.json` config-as-code
is deprecated in favor of `.railway/railway.ts`, "existing files keep
working until 2026-12-01". Migrate before then.


**2026-09-04 (later) — the team/visibility split is LIVE, the production
team lists were RESET to explicit picks, and the Invoice Recap is back for
staff scoped by the owner-picked team. Brittany must now re-pick each
client's team on the Team page — until she does, staff see NO invoices.**
Commits: `ba06474` (split, gate still on), `cbf5c6a` (gate off); plan
of record `docs/plans/team-visibility-split-2026-09.md`.

What is now true:
- `assignedBookkeeperIds` is the TEAM: only `setClientAssignedTeam`
  (picker on the client page / Team page), `createClient`, and the
  assistant's `assign_client` write it. `grantClientVisibility` is inert on
  both backends (call sites kept, slated for removal); the materializer no
  longer backfills.
- Visibility is computed: `visibleClientIdsForUser(data, userId)` in
  `lib/data-scope.js` = team ∪ clients where the person is assignee of a
  live checklist, a recurring template, or a template stage. Server:
  `visibleClientIdSet(session, data)` (takes the WORKSPACE — handing it a
  bare clients array silently narrows to the team; a test pins this) vs
  `teamClientIdSet(session, clients)` (money). SPA: the time picker and the
  visible-clients union both call the same leaf.
- Production reset (approved, applied 17:28 UTC, 37 rows): Lisa team 0,
  Allison team = Skyline, test accounts unchanged; computed visibility
  identical before/after for all four non-owners. Undo:
  `scripts/prod/restore-team-lists.mjs docs/prod-snapshots/2026-09-04T17-28-36-035Z-team-lists-before-reset.json --apply`.

Expected side effects Brittany will see: the Setup Checklist's "Assign a
team member" item lights up for ~37 clients (that IS her worklist); an
accountant's "their bookkeepers" open-task badge shrinks until teams are
re-picked. Tell her before she asks.

Tracker: `featreq-0c2d4ce5` is still `planned` with her review note; the
explanation in her terms (plan §3.6) is NOT posted — in-session tracker
writes were blocked; Alex posts it or approves the write. Follow-ups:
remove the eight `grantClientVisibility` call sites (list in its doc
comment in db/store.js); rename `buildInvoiceRecap`'s `visibleClientIds`
param to `teamClientIds`.


**2026-09-04 — "Allison can see clients invoices she is not on." She is
right; the Invoice Recap was OWNER-ONLY as containment (`00046f4`) for the
hours until the entry above. Kept for the diagnosis.**

The recap's gate (`visibleClientIdSet`) is correct. The field it reads is
not what anyone thinks it is: `grantClientVisibility` adds a person to a
client's team whenever they are given a checklist / case / template stage
there (six call sites in server.js + lib/assistant.js), and
`backfillAssignedBookkeepers` re-adds anyone named on a checklist or
template on every `read()`. Production, read-only: Lisa is on 35 clients,
33 task-derived; Allison on 15, 13 task-derived; Lisa sees Welch Properties'
invoice because of one "Clean up 2023" checklist. Nobody has used the
explicit team picker since at least early August (`client_team_updated`
never appears in activity_log). The UI even labels the picker "Who can see
this client". Ruled out: owner-only `/api/invoices`, the empty legacy
`client_assignments` table, the KLC master (team empty), the stale-save
race (fingerprint covers clients).

Decided by Alex 2026-09-04: (1) contain now — done; (2) build the split in
`docs/plans/team-visibility-split-2026-09.md` (explicit owner-picked team
gates money; task visibility computed at read time, never written into the
team); (3) reset the team lists to explicit-only and Brittany re-picks —
**a production write that still needs his explicit yes at write time, with a
snapshot first** (the provably-explicit survivors are listed in plan §3.5).
Tracker: `featreq-0c2d4ce5` stays `planned` (her review note is the
report); the explanation in her terms is NOT yet posted on it — the
dev_notes write was blocked in-session, so Alex posts it or approves the
write (text: plan §3.6 wording). When the split ships, the owner gate on
`/api/invoice-recap` comes off, the nav item's `ownerOnly` comes off, the
route-glue test flips back, and the manifest section reverts to "owner +
staff".

Trap: the containment comment in server.js and the manifest both name the
plan file — keep them in step when the split lands.


**2026-09-03 — Resilience Tier 1 is BUILT: Railway builds from a
Dockerfile, the lockfile is committed (Linux-generated), `/health` is a
readiness check, and nightly backups + a restore drill exist but are DORMANT
until Alex adds four R2 secrets.** `main` = `3d2cfc9` (+ this handoff),
deployed SUCCESS, `/health` 200 `"db":"ok"`.

Plan of record: `docs/plans/resilience-2026-09.md`. Alex chose **Tier 1 +
Tier 2 (Fly.io standby behind a Cloudflare load balancer)**; the Tier 3
Workers port was declined. What landed tonight, in order:

- **Dockerfile build** (`6b27ce9`; `Dockerfile`, `.dockerignore`,
  `railway.json` builder `DOCKERFILE`): multi-stage on
  `node:22.23.2-bookworm-slim`, npm 11.6.2 pinned in both stages,
  `npm ci --include=dev` to build, `--omit=dev` at runtime. First Dockerfile
  deploy was `5afbc64`; its GraphQL build log shows no Railpack and no npm
  10.9.8 anywhere, after which `RAILPACK_INSTALL_CMD` was deleted. This image
  is what the Fly.io standby will run — one artifact, every host.
- **Committed lockfile** (`5afbc64`, lockfileVersion 3): generated by
  `.github/workflows/lockfile-refresh.yml` on ubuntu, which asserts the
  linux-x64 / win32-x64 / darwin-arm64 rolldown + esbuild bindings are all
  present — the missing-linux-binding failure of 2026-04-30 (`a2e6afe`) was
  the original reason the file was gitignored. `npm ci` from it was also
  proven on this Windows machine. Refresh ritual is in §3.
- **`/health` readiness** (`3fe7af7`): `appDataStore.ping()` on both
  backends, 2-second bound scoped to the ping, 503 `{ok:false,
  db:'unreachable'}`, one console.warn per failure. Railway's deploy
  healthcheck now correctly FAILS a deploy into a database-down state.
  Runbook: `docs/runbooks/monitoring-and-rollback.md` — the Cloudflare
  Health Check and the second external monitor are Alex's dashboard steps
  and are NOT done yet.
- **Backups** (`3d2cfc9`): `.github/workflows/db-backup.yml` — nightly 08:15
  UTC `pg_dump` → R2 `daily/` (30 days) + `monthly/` (12 months), 100 KB
  floor, and a restore drill into a throwaway Postgres on the 1st or on
  demand that fails unless `invoices` and `time_entries` come back
  populated. Production is **PostgreSQL 18.6** (read-only `select version()`
  tonight; 59 invoices, 2,611 time entries, 18.7 MB) so `PG_MAJOR: '18'` —
  `pg_dump` refuses a server newer than itself, so the agent's guessed 16
  would have failed the first night. Runbook:
  `docs/runbooks/db-backup-and-restore.md`. GitHub Actions secrets present:
  `DATABASE_PUBLIC_URL` (plus the two Tauri signing ones).

**Owner TODOs (Alex) — Tier 1 is not finished until these exist, and Tier 2
cannot start:** (1) create the R2 bucket + a bucket-scoped API token and add
`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` as
repo Actions secrets, then run `db-backup` by hand with the drill checked and
read the log; (2) confirm Railway's Postgres volume backups are on; (3) the
Cloudflare Health Check + Betterstack monitor (runbook §2); (4) approve the
Cloudflare Load Balancer add-on and create a Fly.io account. **Then Tier 2:**
a Fly app from the same Dockerfile, the 17 service variables replicated (plan
§1 names them), the LB active/passive on `/health`, a failover drill, and an
entry here.

Traps: `.dockerignore` excludes tests, `docs/plans`, `docs/runbooks`, and
`desktop/` — if `server.js` ever reads a new file at runtime, it needs a
`COPY` line in the Dockerfile or production will 500 where dev works. The
Dockerfile copies `scripts/` wholesale, so the backup shell scripts ride
along in the image harmlessly. `packageManager` in package.json is still a
Railpack-breaker; it is irrelevant under the Dockerfile but do not add it
back "for Fly" without checking Fly's builder too.


**2026-09-03 (late) — every Railway deploy failed for two hours. SUPERSEDED
the same night by the Dockerfile build (entry above) — kept for the
diagnosis and the failed-build-log route.** `main` = `c7526ed` (the redesign + a reverted experiment), deployed
SUCCESS, `/health` 200.

What happened: from ~23:50 UTC every build died inside `npm install` with
`Cannot read properties of null (reading 'edgesOut')` — npm 10.9.8's arborist
crashing while loading a peer set. Not our code: the same crash reproduces on
the PREVIOUS commit (which had deployed fine at 12:21) under npm 10.9.8, and
both commits install cleanly under npm 11.6.2. A dependency published a
manifest that day whose peer graph npm 10.9.8 cannot walk (the crash lands
right after arborist places `rolldown@1.2.7`, Vite's bundler). Railway's
status page stayed green because nothing of theirs broke — and most projects
were shielded by a lockfile, which skips the peer re-resolution. Ours is
deliberately gitignored, so every build re-resolved fresh and hit it.

The fix that works, and the one that does not:
- **`RAILPACK_INSTALL_CMD = npx -y npm@11.6.2 install --include=dev --no-audit --no-fund`**
  set on the PBJBillingApp service (DELETED later that night once the
  Dockerfile build was confirmed — if you find it, it is cruft). `--include=dev` is required: the service
  has `NODE_ENV=production`, under which a plain install skips the
  devDependencies the build needs (tsc, vite). Railpack's own default install
  compensates for that; an override must do it itself.
- **Do NOT set `packageManager` in package.json.** It was tried (`11434fa`)
  and reverted (`c7526ed`): Railpack then "enables corepack shims" and the
  image export fails with `lstat /opt/corepack: no such file or directory`.
  The build and install both succeed — it dies at the very last step, which
  is what made it slow to diagnose.
- `RAILPACK_DISABLE_CACHES` and `RAILPACK_NODE_PRUNE_CMD` were set on wrong
  hypotheses and REMOVED again. If you find either present, it is cruft.

How to see a failed build's log (the CLI never shows one — `logs --build`
returns the last SUCCESSFUL build): Railway's GraphQL API,
`buildLogs(deploymentId)`, with `user.accessToken` from
`~/.railway/config.json`. That is how this was finally diagnosed. Or Alex
pastes it from the dashboard.

**Open question for Alex, raised 2026-09-03 — ANSWERED the same night: he
lifted the rule; the lockfile is committed, Linux-generated (entry above).**
The "lockfile stays gitignored" rule is what exposed us. A committed `package-lock.json` would have shielded
every build (and made installs deterministic besides). Nobody in this history
recorded WHY the rule exists. Until he rules, the override above is the
shield; when npm 11 becomes Railpack's default the override becomes a no-op.


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
`InvoiceDocument` is the client's view. Payment terms printed from each
client's record verbatim until 2026-09-15. Now the client-facing line says
"Due on receipt" (`paymentTermsLabel`) unless the record names a LONGER window,
and the stored 30-day due date is the firm's internal past-due line, shown in
the month run and on no client document.

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

### Production data steps waiting on Alex's yes (2026-09-15)

All of these are scripted or one-click, dry-run clean, and reversible; none has
been applied. Run them from the repo root after the deploy, each with Alex's
explicit yes at run time — §7 item 7 gives standing approval to single-row
`feature_requests` writes and to nothing else.

1. **`node scripts/prod/set-payment-terms-due-on-receipt.mjs --apply`** — 35
   rows, cosmetic. It aligns each client's stored payment-terms string with
   what the invoice now prints ("Due on receipt"). Nothing computes from that
   string any more; the due date comes from `dueDateFromTerms`.
2. **`node scripts/prod/merge-client.mjs client-seed-susannah-dobbs client-1bk7piv --apply`**
   and **`node scripts/prod/merge-client.mjs client-seed-sophie-sorensen client-k8xj4gr --apply`**
   — the two real duplicate pairs (Dobco, 6 time entries; Sophie Paris, 1).
   Both dry runs were verified and rolled back. The duplicate is **retired,
   never deleted**: eight `client_id` columns have no foreign key, and
   `cleanupOrphanedClientData` would hard-delete a deleted client's children.
   Best run when nobody is in the app; Brittany reloads afterward. Dobco's
   April and May pick up 3.6 billable hours.
3. **Two actions in the UI that are Alex's, not a script:** toggle
   **Rivercity**'s new platform-invoicing opt-out, and **void
   INV-2026-09-022**.

**A data note, not a step.** `clients.stripe_customer_id` was written but never
SELECTed on Postgres, so every bulk save wiped it and every send created a
*new* Stripe customer — production has accumulated duplicate Stripe customers
for any client invoiced more than once. `c175447` stops that. Nothing merges
the customers that already exist and nothing needs to; the only symptom is that
a client's receipts are scattered across customer records in the Stripe
dashboard. Worth knowing before someone reads that dashboard and concludes
something is broken.

### Two questions for Brittany (2026-09-15)

1. **Was the preview banner up when you saw Allison's extra clients?** The leak
   was real and is fixed (`a0e4477`): previewing as Allison answered the
   Invoice Recap with the owner's scope under her name. Allison's *real* login
   was checked against production and shows Skyline only. If she saw it outside
   preview, something else is going on and we need to know before the item is
   called closed.
2. **The "[Review]" and "Test" clients look retired but are active**, so they
   sit in pickers next to real clients. Does she want them retired, or are they
   in use? (Separate from the two TEST *accounts* still on 33 / 16 teams, which
   is her pruning job or an approved write.)

### Skip and Push — two questions for Brittany (2026-09-14)

The Push button shipped (§5, `featreq-68638ed2`) with the narrowest reading:
push is whole-checklist, exactly like skip. Two things were deliberately not
guessed, and Alex meets her 2026-09-15:

1. **Should a single subtask be skippable or pushable on its own?** Today both
   act on the whole checklist. A per-subtask push/skip is **new surface**, not
   a toggle — it needs its own audit rows, its own identity keys, and a rule
   for what a part-pushed checklist's due date even means. Get her answer
   before any of that gets built.
2. **Does a skip or a push trigger the next step in a sequence?** Today it
   does not: the checklist moves, and a sequence does not advance behind it.
   If she expects the next step to open, that is a materializer change, not a
   UI one.

### Deliverability — Alex's two dashboard steps (2026-09-04), for the road

DNS for pbjsa.com is on Cloudflare (nameservers carlane / melnicoff). Change
ONLY the records named here; the SPF record, `resend._domainkey`, and the
`send` subdomain records are what make invoices pass authentication.

**Google Postmaster Tools** (Gmail's report card: spam rate, reputation):
1. postmaster.google.com → sign in → red **+** → `pbjsa.com` → Next.
2. Copy the `google-site-verification=…` TXT value it shows.
3. Cloudflare → pbjsa.com → DNS → Records → Add: type TXT, name `@`,
   content = that value (a second google-site-verification TXT beside the
   existing one is fine — do not replace it).
4. Postmaster → Verify (retry after a minute if "not found").
Dashboards stay empty until enough mail reaches Gmail users — weeks at her
volume. Spam rate above ~0.3% is what Gmail acts on.

**DMARC reports somewhere read** (today `rua=` goes to a GoDaddy default):
1. Cloudflare → pbjsa.com → Email → **DMARC Management** → Enable.
2. Accept the offered `_dmarc` record update (it swaps only the `rua=`
   address; `p=reject; adkim=r; aspf=r` stay).
3. If not offered, edit the `_dmarc` TXT by hand: replace the
   `rua=mailto:…` part with the address on the DMARC Management page.
Within a day or two the page lists every source sending as pbjsa.com
(Microsoft 365, Resend via Amazon SES) with pass/fail counts.

**Then, per flagged client:** ask them to add billing@pbjsa.com to contacts
or safe senders, and resend from the Invoices page — the delivery badge
will say what happened this time.


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
6. **When an item comes back, reproduce what the reporter was looking at before
   touching code** — preview mode, a TEST account, a gate, a stale tab. Three
   of the five items closed on 2026-09-15 were interpretation, not code: Push
   was invisible because it had ridden Skip's per-template opt-in, the filter
   complaint was a retired client at the top of a dropdown, and "Allison can
   still see clients not hers" was preview-as answering with the owner's scope.
   None of the three would have been found by re-reading the feature's code.
7. **Standing approval (Alex, explicit):** single-row writes on
   `feature_requests` (status, dev_notes, clarification fields, shipped_at,
   and filing shipped records for features he ordered directly). Every OTHER
   prod write still needs his per-write approval with a durable undo snapshot.
8. Post a short digest here after each item lands.

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
