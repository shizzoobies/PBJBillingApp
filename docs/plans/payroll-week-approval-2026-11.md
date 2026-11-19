# Weekly payroll review and "Approve week"

Ticket: featreq-20b13da0 ("Payroll approvals: weekly review and 'approve week'"), status New, from Brittany's brainstorm session on 2026-11-17. Status of this document: a plan, nothing built. Written 2026-11-19 from a reading of the code at `acd09977`; no production data was read for it.

## 0. The two-minute version (for Alex)

**What she gets.** One screen where she does what she does in Excel today: pick a Sunday-to-Saturday week, filter to one person, read every entry in day order with its length and description, see day totals and the week's totals at the top (hours, pay at cost, billable), see flags on the entries that need a look (manual, clock times edited, overlapping or double-entered time, math that does not add up), send an entry back (to fix, or just to tell the person), tick off the manual entries, and press **Approve week**. That week is then locked for payroll: nobody can change its time without an owner reopening it, and it never needs approving again. The QuickBooks time export (featreq-e01549db) takes exactly "approved, locked weeks" as its input.

**What surprised me in the code.** There is already a button called "Approve week" (Time Approvals, Weekly submissions tab, `src/pages/TimeApprovalsPage.tsx:453` and `:675`). It flips the week's still-pending entries to approved and marks the person's weekly submission approved (`db/store.js:13443`). **It locks nothing.** Any entry in an "approved" week can still be edited, resumed, split or deleted by its owner (the only server-side lock on editing is the month lock, `server.js:12619`); the edit quietly sends that one entry back to pending while the week keeps saying "approved". The button's tooltip says it "seals" the week (`TimeApprovalsPage.tsx:450`); it does not. That gap, plus no totals in money, no day subtotals and no flags, is very likely what she means by "I can not really approve it correctly there".

**What it costs.**

| Ship | What | Needs |
|---|---|---|
| 1 | The review screen, read-only: week picker, person filter, entries in her order, day and week totals, all the flags | nothing stored; no schema |
| 2 | Per-entry actions: send back to fix, send back to inform, acknowledge a manual entry | **one new table** (`payroll_week_approvals`), your yes |
| 3 | Approve week and the lock, enforced on the server on every path that changes time | same table; two review rounds (save path and money) |
| 4 | Hand-off to the QuickBooks export: a pay period is ready only when both of its weeks are locked | rides with the QuickBooks plan's stage 4 |

Rough size: ship 1 is about the size of the payroll report's stretches work (2026-11-17); ship 3 is the risky one, comparable to the month lock plus the bulk-save restore work done for skips and covered dates.

**Risks.**
- **The lock is only as good as the list of paths that can change time.** Section 5 lists eleven; missing one means a "locked" week that is not. Ship 3 carries a test that fails when a new writer of `time_entries` appears without the lock check.
- **The bulk save rewrites `time_entries` from the owner's page copy** (`db/store.js:11281`, `:11407`). A locked week has to be restored from what is stored, the way the endpoint-owned checklist fields are, or one owner save could rewrite locked time.
- **Owners are exempt from the month lock today** (`server.js:11727`). The week lock is meant to hold for owners too (that is what "I do not need to approve again" requires, and what the QuickBooks export needs). That is your call (section 9).
- **The deploy hand-over** runs two versions for a few seconds; an old container knows nothing about week locks. The approval stores a signature of every entry it approved, so any change that slips through, by any path, shows as "changed after approval" instead of passing silently.

## 1. What she asked for, in her words

- "Right now approvals come to the approval screen but I can not really approve it correctly there ie that is not how I really approve."
- "Normally I download the excel sort by week Sunday-Saturday. Sort by employee and then review the length of time they worked and their description."
- "it comes over weekly submissions and then I can filter by employee. it could sort by day and total days and then total week at top - total hours total pay at cost & billable."
- "I have an approval button on the side of each submission and I can approve or deny. Option to send back for employee to update or just send back to inform employee."
- "Then after I finish, I click approve week. This locks it in for payroll and I do not need to approve again."
- "Here would let me know if it was manual entered and force an approval here to that they manual entered."
- "This area would check if they have a double stated timesheet entered over lapped or other issues."

The ticket's summary adds: entries do not need individual approvals; an entry sent back for an update stays open until it is fixed; manual entries are flagged and need her acknowledgment; the screen checks for overlapping or double-entered time and that the math is right; "approve week" approves all of the week's entries and locks the week for payroll. Open on the ticket: can she approve the week while a sent-back entry is still open; what happens if something turns up after a week is locked; other checks beyond overlaps and math.

## 2. What the app does today (read from the code)

### 2.1 Per-entry approval

- Every entry carries `approvalStatus` (`pending` / `approved` / `rejected`), `approvalNote`, `approvedBy`, `approvedAt` on the `time_entries` row (`db/store.js:7669`, the bulk row shape at `:506`).
- **What lands pending.** A plain timer capture is saved **approved** at once; a manual entry and the shares of a split land pending (`db/store.js:12340-12364`, "a PURE timer capture skips the per-entry daily queue"). An owner's own time is saved approved whatever the method (`isOwnersOwnTime`, `lib/time-entry.js:283`; passed as `selfApproved`, `server.js:11840`). Edits: `approvalAfterEdit` (`lib/time-entry.js:320`) returns `requeue` for any edit of an approved or sent-back entry except an owner flipping only `isAdhoc` / `billable` (`editRequiresReapproval`, `:259`); an owner editing her own pending or approved entry approves it.
- **So the Approval queue only ever sees manual entries, split shares and edits.** Most of Lisa's and Allison's time (timer captures) never passes through it, which is one more reason the queue is "not how I really approve".
- **Routes.** `POST /api/time-entries/:id/approve` and `/reject` (`server.js:12325-12415`), owner only. Reject requires a note, sets `rejected`, and notifies the person: "sent back your 1.50h entry on ... Edit and resubmit it from the Time page" (`server.js:12392-12410`, kind `time_entry_rejected`). `POST /api/time-entries/approve-batch` (`server.js:11915`). A new manual entry notifies every owner (`time_entry_manual`, `server.js:11891`).
- **What "sent back" does.** The entry stays in the data and **still counts on the payroll report**, which ignores approval status (`src/pages/ReportsPage.tsx:535-544`; the QuickBooks plan says the same, `docs/plans/qbo-time-sync-2026-11.md:108`). The person sees it in a "sent back" list on Time (`src/pages/TimePage.tsx:250-258`) and on Timesheet (`src/pages/TimesheetPage.tsx:277`) with the note and an "Edit & resubmit" button (`TimePage.tsx:3450-3461`). Editing it makes it pending again (`editRequiresReapproval` treats `rejected` like `approved`). A sent-back ENTRY does not block the person from logging time; only a sent-back WEEK does (below).
- **The page.** Time Approvals (`/time-approvals`, owner only, `src/components/navItems.ts:50`) has three tabs in this order: Weekly submissions, Approval queue, Timesheet locks (`TimeApprovalsPage.tsx:42-46`).

### 2.2 The two existing locks, and the weekly record she could approve

| | Weekly submission | Month lock |
|---|---|---|
| Stored in | `weekly_submissions` (`db/store.js:8076`), one row per person per Sunday `week_start`, `status` pending / approved / rejected, reviewer, note | `timesheet_locks` (`db/store.js:7948`), one row per person per `YYYY-MM` |
| Set by | the person: `POST /api/timesheets/weekly-submissions`, session user only, Sunday enforced (`server.js:12762-12797`) | an owner: `POST /api/timesheets/lock`, only for a month that has ended (`server.js:12703-12746`) |
| Owner actions | approve (`server.js:12799`, store `:13443`: entries pending to approved), reject with note (`:12832`, store `:13550`; no notification is sent), reopen an approved week (`:12871`, store `:13604`: entries approved back to pending) | unlock (`server.js:12749`); locking also approves the month's pending entries (`db/store.js:13263-13280`) |
| What it refuses | **logging new time**, not editing: a non-owner may not log time in the current week or later while an earlier week with time is unsubmitted or rejected (`listBlockingWeeks`, `lib/time-entry.js:604`; `server.js:11738-11790`; also on split `:12060-12095` and split adjust `:12270-12295`). Backfilling an ended week never gates (`lib/time-entry.js:623`) | **create, edit, delete, split, adjust** by a non-owner, for an entry dated in that month (`server.js:11727`, `:12619`, `:12681`, `:12064`, `:12268`); 423 "This timesheet month is locked. Contact an owner to make changes." |
| Owners | exempt | exempt |

So yes, there is already a per-person, per-week record she could approve: `weekly_submissions`. Its "approved" status is not a lock, and both tables ride the bulk save from the page copy (`db/store.js:11282-11283` delete, `:11414-11429` re-insert; both are in the staleness fingerprint, `lib/workspace-version.js:60-67`). Section 4 argues for a new table rather than turning that status into a lock.

### 2.3 Pay period facts

- Bi-weekly, Sunday to Saturday, paid a week behind ("bi-weekly from sunday to saturday with a week in the hole", her answer on featreq-e01549db, 2026-11-12). The current period started Sunday 2026-11-01, so periods run Nov 1-14, Nov 15-28, Nov 29-Dec 12. Paid by the hour: Lisa (`emp-a41095f0`) and Allison (`emp-41def8a0`).
- **No pay period is stored anywhere**; the payroll report's weekly / bi-weekly toggle is screen state (`ReportsPage.tsx:524-530`; `qbo-time-sync-2026-11.md:109`).
- The app's week is the same Sunday-anchored week everywhere (`weekStartOf`, `lib/time-entry.js:531`; browser twin `src/lib/utils.ts:114`). A pay period is two of those weeks. A week can straddle two months (Nov 29 - Dec 5), which is why a week lock cannot be expressed as a month lock.

### 2.4 Building blocks already there (and the rules they carry)

- `src/lib/payrollClock.ts`: `clockSpansOf` (`:41`, stretches in time order, Clock in = earliest start, Clock out = latest stop), `buildSplitBlocks` (`:83`, read off EVERY entry), `splitNote` (`:116`), `clockMismatchNote` (`:158`, "Hours typed in (clock time 1h 55m)" / "The shares do not add up ..." beyond `CLOCK_TOLERANCE_MINUTES = 1`, `:142`), `howLogged` (`:246`: manual, timer_edited, timer, timer_unread, no_clock) with its labels and the "Clock times edited" chip (`:280`).
- The payroll Hours report (`PayrollHoursReport`, `src/pages/ReportsPage.tsx:490`): one row per entry, grouped under its day in clock-in order (`dayGroups`, `:647-703`), per-row cost and billable, the full-mode "full block, counted once" rule (`:1218-1220`, from `duplicateFullSliceIds`, `lib/payroll-cost.js:47`).
- `lib/payroll-cost.js`: costing hours are the sum of the ROWS' two-decimal hours, never the re-rounded total (`sumDisplayHours` `:175`, `periodDisplayHours` `:203`; the rule is spelled out at `ReportsPage.tsx:584-595`); cost = printed hours x cost rate (`personPeriodCost` `:156`, `periodMoney` `:219`, `sumPersonCosts` `:230`); billable is not deduped (`billableMinutes` `:70`, `billableRevenue` `:344`); cost and bill rates are read for the day worked (the report's `costRateOn` / `billRateOn` props).

The review screen must compute its totals with these same functions, so the screen, the report and the QuickBooks export can never put two numbers on one week. Ship 1 lifts the `dayGroups` row builder out of `ReportsPage.tsx` into `src/lib` so both pages call one function.

### 2.5 Overlaps today

Nothing checks overlaps. The two near-relatives: `findAlreadyLoggedTimer` (`lib/time-entry.js:470`) refuses a second entry holding a stretch that starts at the same instant (one timer saved twice; live since `854012cb`), and `hasDuplicateSessionStart` (`lib/time-entry.js:506`) refuses one stretch listed twice inside an entry. Neither looks at stretches that merely intersect.

From the 2026-11-17 read-only payroll audit (session notes, not re-run for this plan): since January, minutes worked on two entries at once were Allison 2 pairs (25 min), Lisa 5 pairs (99 min), Brittany 4 pairs (77 min), most a timer overlapping a manual or edited entry. That is few enough that every flag can be shown and looked at by hand.

## 3. The screen

A new first tab on Time Approvals, **Payroll review** (`APPROVAL_TABS`, `TimeApprovalsPage.tsx:42`). Owner only, enforced on the server.

**Top bar.** Week picker: "‹ Nov 8 - Nov 14, 2026 ›", always a Sunday-to-Saturday week, with "Week 2 of pay period Nov 1 - Nov 14" beside it. Person filter: everyone, or one person (hourly people first). One status line per person in the week: "Lisa: submitted Nov 15 · 3 flags · 1 sent back, waiting on Lisa · not approved".

**Totals at the top** (her "total week at top"), for the filter:

| | Hours | Pay at cost | Billable |
|---|---|---|---|
| Week | 38.42 | $864.45 | $1,920.00 |
| Pay period so far (both weeks) | 76.10 | ... | ... |

Hours = sum of the rows' two-decimal hours with full-mode repeats counted once; cost and billable from `lib/payroll-cost.js` at the rate on each day. A person with no cost rate shows "-" not $0.00 (the report's rule, `ReportsPage.tsx:748-757`).

**The entries, in the order she reads in Excel:** grouped by person (when "everyone"), then by day Sunday to Saturday, then by clock-in time; hours-only entries last in their day. Each day ends with a day total line ("Tue Nov 10: 7.85 h · $176.63 cost · $392.50 billable"). Each row: date, client (or Administrative), task, description in full (not truncated: she reads it), clock in / out and the stretches when more than one, hours, cost, billable, and how it was logged.

**Flags** on a row, each a chip with one sentence on hover:

| Flag | When | Source |
|---|---|---|
| Manual entry | `entryMethod === 'manual'`; needs her tick (below) | `howLogged` |
| Clock times edited | timer entry whose stretches sit on exact minutes after Aug 17 | `howLogged`, existing chip |
| Overlaps another entry | one of its stretches intersects a stretch of another entry of the same person by more than 1 minute (section 6) | new check |
| Logged twice | two entries of one person hold a stretch starting at the same instant, or two hours-only entries on one day with the same client, task, minutes and description | new check, same rule as `findAlreadyLoggedTimer` |
| Hours do not match clock | `clockMismatchNote` is not empty | existing |
| Sent back | `approvalStatus === 'rejected'`; "waiting on Lisa since Nov 16" | existing field |
| Fixed, look again | was sent back from this screen and has since been edited (now pending) | existing field plus the mark in section 4 |
| Changed after approval | in a week approved earlier, the entry no longer matches its stored signature (section 4) | new |

Plus whatever she adds in answer to question 3.

**Per-entry actions** at the right of each row:
- **Send back to fix.** A note is required. Today's reject: the entry becomes `rejected`, the person is notified with the note (`server.js:12392`). It stays open until they edit it.
- **Send back to inform.** A note is required. The person is notified ("Brittany left a note on your 1.50h entry on Nov 10: ..."); nothing about the entry changes, and nothing waits on them.
- **Acknowledge** (manual entries only): a tick, "Manual entry: OK". Recorded with who and when.

There is no per-entry Approve button: the week is what she approves (question 5).

**Approve week** at the bottom and at the top, per person (the filter must be one person, or the button approves each person shown, listed by name in the confirm). It is held, with the reason in words, while any of these is true: a manual entry is not acknowledged; an entry is sent back to fix and not yet fixed (question 1); an overlap or logged-twice flag has neither been sent back nor acknowledged. The confirm says what will happen: "Approve and lock Lisa's week of Nov 8 - Nov 14: 38.42 hours, $864.45 at cost. Nobody can change this time until an owner reopens the week."

**An approved week** reads "Approved and locked by Brittany, Nov 16, 4:12 PM" with a **Reopen** button (owner only, a reason is required).

**Assumed without asking** (tell us if wrong): a week the person did not submit can still be approved, and the screen says "not submitted"; approving it counts as submitted for the logging gate, so the person is never then blocked by a week she has already locked (`listBlockingWeeks` learns about locked weeks the way it learns about locked months, `lib/time-entry.js:604-648`). The owners' own time is left out of the person filter by default and can be picked; it is locked like anyone's when approved.

## 4. Data design

### 4.1 One new table, endpoint-owned

```
payroll_week_approvals
  id              text primary key
  user_id         text not null            -- whose week (no foreign key, cardinal rule 6)
  week_start      date not null            -- the Sunday
  status          text not null            -- 'open' | 'approved'
  approved_by     text
  approved_at     timestamptz
  totals          jsonb                    -- at approval: { hours, costCents, billableCents, entries }
  entry_signatures jsonb not null default '{}'  -- at approval: { "<entry id>": "<signature>" }
  entry_marks     jsonb not null default '{}'   -- { "<entry id>": { kind: 'ack' | 'informed' | 'sent_back', by, at, note, signature } }
  history         jsonb not null default '[]'   -- every approve / reopen: { action, by, at, reason, totals }
  updated_at      timestamptz not null default now()
  unique (user_id, week_start)
```

A row appears the first time she marks an entry in that week (`status 'open'`) and turns `approved` on Approve week. Never part of the bulk save and never in the staleness fingerprint, like `week_plan_entries` (`db/store.js:7828`, endpoints `:35395`, `:35425`). Both backends, as always (file backend: `data.payrollWeekApprovals`). Postgres reorders jsonb keys, so anything that compares stored marks uses `stableStringify`. **This table needs your yes.**

A signature is a hash of what payroll depends on: person, date, minutes, client, administrative flag, stretches, group id. An acknowledgment or a send-back stores the signature it was given against, so editing a manual entry after she ticked it un-ticks it ("changed since you acknowledged it"), and a fixed sent-back entry is recognized as fixed.

**Why not reuse `weekly_submissions`.** It is the person's own act (submit), it is rewritten by every bulk save from the page copy (`db/store.js:11423`), it is in the fingerprint, and its "approved" already means "approved, still editable" to every page and to the reopen route. Making that same status mean "locked" changes what stored data means under every open tab and every old container. A separate table keeps "they submitted" and "she locked it" apart, and lets the old Weekly submissions tab keep working until it is retired. The cost is one more table; the gain is that nothing existing changes meaning.

**Why not a stamp on `time_entries`.** The bulk save deletes and re-inserts every row from the page copy (`db/store.js:11281`), so a stamp there would need snapshot-and-restore around every save; a separate table needs neither.

### 4.2 What Approve week does

One endpoint, `POST /api/payroll-weeks/:userId/:weekStart/approve`, owner only, same-origin. In one transaction: re-read the week's entries on the server, recompute the flags with the same pure module the screen uses, refuse (409 with the reasons in words) if the screen's hold conditions are not met, flip the week's still-pending entries to approved (as `approveWeeklySubmission` does, so the Time page pills agree), store the signatures and totals, set `status 'approved'`, append to `history`, record activity `payroll_week_approved`. The request carries the totals she saw; a mismatch with the server's recomputation is refused ("the week changed while you were looking; reload").

### 4.3 What "locked" refuses, and the message

Every change to an entry dated in a locked week of that person, by anyone, owners included (section 9 question A). 423, code `payroll_week_locked`, message: "This week (Nov 8 - Nov 14) was approved for payroll by Brittany on Nov 16 and is locked. Ask an owner to reopen it." The assistant's `diagnose_time_logging` (`lib/assistant.js:235`, handler `server.js:1141`) learns the third cause so "why can't I log time" names it.

### 4.4 Unlock

`POST .../reopen`, owner only, reason required. The row goes back to `open`, the history keeps the approval and the reopen (who, when, why, the totals at approval), activity `payroll_week_reopened`, and the person is notified. Entries keep their approval status; edits then re-queue as usual, and the week has to be approved again to lock. If the week was already sent to QuickBooks, the export shows it "changed since sent" (section 7).

### 4.5 Audit

`history` on the row (every approve and reopen with totals), the activity log entries, the per-entry marks with who and when, and the signatures, which let the screen say exactly which entry changed after approval.

## 5. Where the lock has to be enforced (server side)

Every path that writes `time_entries`, found by reading `db/store.js` for `insert into` / `update` / `delete from time_entries`:

| # | Path | Where | Lock rule |
|---|---|---|---|
| 1 | Create (manual, timer, group holding) | `server.js:11531`, store `createTimeEntry` `:12472`, `createTimerEntryOnce` `:12395` | refuse when the date is in a locked week |
| 2 | Edit, including resume / add time, move to another day, client or person | `server.js:12413-12660`, store `updateTimeEntry` `:13131` | refuse when the OLD or the NEW (person, week) is locked |
| 3 | Delete | `server.js:12662`, store `:13212` | refuse |
| 4 | Split | `server.js:11946-12190`, store `splitTimeEntry` `:12577` | refuse |
| 5 | Adjust split | `server.js:12197`, store `adjustSplitGroup` `:12851` | refuse if any share is in a locked week |
| 6 | Approve / send back one entry; approve batch | `server.js:12325-12415`, `:11915`; store `approveTimeEntries` `:13230` | refuse send-back in a locked week (it would reopen it silently); approving is harmless |
| 7 | Old weekly approve / reject / reopen | `server.js:12799`, `:12832`, `:12871` | reopen refuses on a locked week (it flips entries to pending, store `:13626`) |
| 8 | Month lock | store `lockTimesheet` `:13263` | only touches pending entries; a locked week has none, so no change |
| 9 | Bulk save | `write()` `db/store.js:10867`, deletes `:11281`, re-insert `:11407` | rows of locked weeks are re-inserted from what is stored, not from the payload; a payload that differed is logged |
| 10 | Invoice save tagging billable / ad hoc | `updateInvoice`, `db/store.js:19725-19745` | allowed by default: scope flags do not change hours or pay (the same carve-out as `editRequiresReapproval`); your call, section 9 |
| 11 | Deleting a client deletes its time | orphan cleanup `db/store.js:26585`, `filterOrphans` `:10949` | refuse to delete a client with time in a locked week, or keep that time; your call |

The check is one store method, `lockedPayrollWeeks(userId, dates)`, read inside the same statement or transaction as the write where the path has one. Ship 3 adds a source-reading test that lists every `time_entries` writer in `db/store.js` and fails when one appears that does not consult it.

## 6. Overlap and double-entry check

**What counts.** For one person, take every entry's stretches (`clockSpansOf`; the `startAt`/`endAt` pair when there are no stretches). Two stretches from **different entries** overlap when they intersect by more than 1 minute. Not an overlap: two shares of the same split block (same `groupId`): they carry the block's stretches on purpose and are one unit (`payrollClock.ts:13-14`, `lib/payroll-cost.js:23-37`). Two stretches inside one entry that intersect are flagged too ("this entry's stretches overlap"). Hours-only entries cannot overlap; they are checked for "logged twice" only.

**Where it lives.** A pure module `lib/payroll-week-checks.js` with a sibling `.d.ts`, imported by the browser (the flags on screen) and by the server (the approve endpoint recomputes and refuses). One rule, two callers, like `lib/time-entry.js`.

**Counting real overlaps** (not done for this plan). A read-only count needs one read-only connection (`default_transaction_read_only`, the temp-table-first shape in HANDOFF section 4), `time_entries` expanded to one row per stretch with `jsonb_array_elements(sessions)` (falling back to `started_at` / `ended_at`), a self-join on `user_id` where the intervals intersect by more than a minute and the entry ids differ and `group_id` is null or different, grouped by person and month. The 2026-11-17 audit figures in section 2.5 came from that shape; re-run it before ship 1 to set expectations for the first week she reviews.

**The math check.** Day total = sum of its rows; week total = sum of the days; the shares of an even or custom split add up to their block (`clockMismatchNote`); a row's hours agree with its clock time within a minute. The screen shows the arithmetic, and a failure is a flag on the row, never a silent correction.

## 7. Hand-off to the QuickBooks export

The export (`docs/plans/qbo-time-sync-2026-11.md`, stage 4) sends a pay period per person. With this feature:
- A pay period is **ready to send** only when both of its weeks are approved and locked for that person. The preview names any week that is not ("Allison, week of Nov 8: not approved").
- The export reads a locked week's entries and records, in its ledger, the approval row id and the `approved_at` it sent against. A week reopened and re-approved after sending shows "changed since sent" (the QuickBooks plan's own rule, `qbo-time-sync-2026-11.md:88`), and the signatures say which entries.
- The pay period anchor (Sunday 2026-11-01, every 14 days) has to be stored once so both screens agree which two weeks make a period; section 9.

## 8. Ships, and two versions at once

**Ship 1: the review screen, read-only.** The tab, the week picker, filter, rows, day and week and period totals, all flags. The row builder lifted from `ReportsPage.tsx` into `src/lib`, the checks module. Nothing stored, nothing locked; the existing tabs untouched. Useful alone: she can review a week the way she does in Excel without downloading it.

**Ship 2: per-entry actions.** The table; send back to fix (existing reject route), send back to inform (new notification kind), acknowledge. Old tabs never see the table; nothing existing changes meaning.

**Ship 3: Approve week and the lock.** The approve and reopen endpoints, the lock on every path in section 5, the bulk-save restore, `listBlockingWeeks` learning locked weeks, the assistant's third cause. Then the old Weekly submissions "Approve week" is retired: its route answers "Weeks are approved on Payroll review now" so an old tab's button cannot approve a week without locking it, and the Approval queue tab is retired if she says yes to question 5. Staff still submit their week; the submission shows on her screen.
- *Old staff tabs:* show edit buttons on locked weeks; the server refuses with the readable 423 message, which those pages already print.
- *Old owner tabs:* approving a week flips entries in `time_entries` (in the fingerprint), so an old tab's next bulk save takes one 409 and reloads; even without that, `write()` restores locked rows.
- *Deploy hand-over:* for a few seconds the old container accepts edits it does not know are locked. No week is locked before ship 3 is live, so this matters only for a week locked during a later deploy; the signatures catch it as "changed after approval".

**Ship 4: QuickBooks hand-off.** With the QuickBooks plan's stage 4.

Each ship: `docs/capability-manifest.md` updated, voice agent re-provisioned, two review rounds on ships 2 and 3 (save path and money), a rolled-back production trial for ship 3's `write()` restore with `read()` and `write()` stubbed.

## 9. Choices

### Questions for Brittany (on the ticket, in her words; the default is what gets built on "yes to all")

1. **Can you approve a week while an entry you sent back to be fixed is still waiting on the employee?** Default: no. Approve week stays greyed with "1 entry waiting on Lisa" until it is fixed and you have looked at it again.
2. **If something turns up after a week is locked, what happens?** Default: an owner presses Reopen and types why; the week unlocks, the change is made, and you approve the week again. If it was already sent to QuickBooks, it shows as changed so you can resend it.
3. **Other checks besides overlapping time, double entries and math?** Default: also flag an entry over 10 hours, a day over 12 hours, and an entry with a blank or one-word description.
4. **When you "send back just to inform", does that time still count for payroll?** Default: yes. It is a note to the employee only; the entry is approved with the week.
5. **Does Approve week replace approving entries one by one?** Default: yes. The separate Approval queue goes away; manual entries and splits show on the weekly screen instead, and manual ones need your tick.
6. **Review one Sunday-Saturday week at a time, or the whole two-week pay period on one screen?** Default: one week at a time, with the pay period's two-week totals shown at the top.
7. **While a week is locked, what does the employee see?** Default: their time for that week shows "Approved for payroll" and cannot be edited, deleted or resumed; to change it they ask you.

### Alex's decisions

A. **Do owners obey the week lock?** Recommended: yes, until they reopen the week (unlike the month lock). Without it, "locked for payroll" is only a lock on staff.
B. **The new table `payroll_week_approvals`** (section 4.1): its shape, and the choice of a new table over reusing `weekly_submissions`.
C. **Bulk save:** restore locked weeks' rows from storage (recommended) or refuse a save whose payload differs for a locked week.
D. **Invoice scope tagging** of entries in a locked week (section 5 row 10): allow (recommended) or refuse.
E. **Deleting a client with time in a locked week** (row 11): refuse the delete (recommended) or let it remove the time.
F. **Where the pay period anchor lives** (2026-11-01, every 14 days): a firm setting (it is not secret, so `firm_settings` is fine), or a constant until the QuickBooks work stores periods.
G. **Retiring the old Weekly submissions approve and the Approval queue** at ship 3, and whether the month lock stays as a second, coarser lock (recommended: it stays; it is how a finished month is closed for staff).
H. **Effort and order:** four ships as above, ship 3 with two review rounds and a rolled-back trial; ship 1 can start before her answers (none of the seven changes it).
