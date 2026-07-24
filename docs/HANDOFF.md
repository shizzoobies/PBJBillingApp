# Handoff — PBJBillingApp

Written 2026-07-21, last updated 2026-07-24. Everything below is live on `main`;
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
   before every push. Currently **512 tests / 50 files**.

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
- `clients` has only `assigned_bookkeeper_ids`. `assignedEmployeeIds` is a
  frontend/legacy field with **no DB column** — visibility uses bookkeeper ids.

---

## 5. Where things stand (newest first)

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

**Tracker state at handoff (2026-07-24):** ~11 items in Shipped awaiting
Brittany's review (each with a shipped-at pill); 3 in the EOM lane —
engagement-to-billing workflow (`featreq-79b6d974`, ALSO needs a planning
session with Alex first), client-tabs consolidation (`featreq-5c225d33`, her
option "(c)": fold into that same discussion), and historical hours
(`featreq-deef43f1`, guard-then-reimport plan above); nothing in Planned/New.
One interpretation flag left for Brittany inside a shipped item's dev_notes:
the Board "sort by team member box" was built as a FILTER — the note invites a
send-back if she meant ordering.

**The single most important pending code change:** the bulk-save staleness
guard (version token on GET, echoed on PUT, 409 on mismatch + log bulk saves
to activity_log). It gates the historical re-import and closes the app's last
known data-loss vector. Scheduled with the re-import ~Aug 6, after month close.

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
