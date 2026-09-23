# PB&J Strategic Accounting — Capability Manifest

This document is the AI assistant's complete knowledge of what the app can and
cannot do. It is sent to the model as system context. Keep it accurate: any
commit that adds, changes, or removes a user-facing feature MUST update this
file in the same commit.

Audience note: the assistant talks to the firm OWNER. Staff (bookkeepers)
see a reduced version of the app — owner-only abilities are marked.

## How durations are displayed (site-wide rule)

Two formats, chosen by what the screen is for:

- **REPORTING surfaces show two-decimal hours — always x.xx.** Client Recap,
  the payroll Hours report (summary and detail), the Dashboard and Reports
  summary cards, Productivity, client month totals, the workspace summary strip
  and invoice line detail. "20.22h", "1.00h", "0.50h" — never one decimal and
  never a bare integer, so a column adds up by eye.
- **Live time-ENTRY and APPROVAL surfaces keep hours-and-minutes** ("1h 20m",
  "23m", "45s"): the Time page entry rows and split allocations, the running
  timer, the Timesheet week/day rows, Time Approvals, the submit-timesheet
  prompt, the log-time modal, per-entry and per-session rows on a client, and
  the "time logged" line on a task or case. When someone is logging or approving
  ONE piece of work, "23m" is the honest reading and "0.38h" is not.

The displayed hours ARE the costing input: labor cost is the two-decimal hours a
report shows times the pay rate, so multiplying a printed Hours cell by hand
reproduces the Cost cell beside it. The full rule is under the payroll Hours
report below ("HOW LABOR COST IS CALCULATED").

## Navigation map

Sidebar pages: Dashboard, Engagements, Time, Timesheet, Time Approvals,
Checklists, Board, Delayed, Clients, Client Recap, Contacts, Reports,
Productivity, Gantt, Invoices, Invoice Recap, Plans, Team, To 100%, Updates
(owner only), Settings. A billing-month picker, notification bell, and account
menu sit in the top bar on every page.

**The owner's sidebar is grouped into sections** (nineteen flat links was too
many to scan). In order: Dashboard, Engagements, **Clients** (Clients, Contacts,
Client Recap), **Billing** (Invoices, Invoice Recap, Plans), **Operations**
(Time, Timesheet, Time Approvals, Checklists, Board, Delayed, Gantt), Team,
**Reports** (Reports, Productivity), Updates, **Settings** (Settings, To 100%).
Dashboard, Engagements, Team and Updates stand alone — a heading over a single
link is more clutter than help. Updates is deliberately top-level rather than
under Settings, since that is where feature requests are filed and shipped work
is reviewed.

**Staff keep a flat sidebar** — they see eight links, where section headings
would outweigh the content. Nothing moved for them and no route changed for
anyone; this is purely how the list is presented.

**Engagements is a placeholder.** The section is visible before it has content
so it does not appear out of nowhere later; opening it explains that the intake
form and proposals are on the way and that clients are still added on the
Clients page meanwhile. Owner-only.
- New-version prompt: a browser tab left open across a deploy shows a small
  "A new version of the app is ready — Refresh" toast (bottom-right; Refresh
  loads it) within a few minutes, and immediately when you come back to the
  tab. If something just
  fixed "isn't showing", refresh the tab first — an old tab runs the old app
  until it reloads.
- Out-of-date tab protection: if a tab has been open while someone else changed
  something, the app refuses to save that tab's copy of the workspace rather
  than let it overwrite the newer data, showing "This tab is out of date" with a
  Reload button. Reloading is the only way forward, and anything typed but not
  yet saved must be entered again — deliberately, because saving the old copy
  would erase everyone else's changes. It is rare: tabs sync with each other
  automatically, so it generally only appears after a tab sat idle or lost its
  connection. Owners only (staff never save the whole workspace).
- Most list/board pages have an instant search box: type to filter by name and
  key fields, with a live result count, matched-text highlight, and a clear
  button. Coverage: Clients (name/contact/email/billing type), Contacts
  (name/title/email/phone/company emails/linked client), Plans (name/notes),
  Team (name/email/role), Checklists & Gantt (task title/client — composes with
  the assignee/client/status filters), Delayed (task title/client/waiting note),
  and the Board (client/task title — composes with the Report period). Reports
  and Productivity remain aggregate views with their own filters.
- **Search results skip inactive clients.** A typed search never returns rows
  of a client marked inactive — their checklists, board rows, gantt bars,
  delayed items, recurring templates and linked contacts stop matching. With no
  search typed, lists are unchanged (existing history stays visible), and the
  Clients page still shows inactive clients on its Inactive / All tabs. The
  "Add from existing" template picker on a client page no longer offers retired
  clients' templates at all.
- Report period (shared date range): a "Report period" control on the Time,
  Timesheet, Board, and Checklists pages views a range longer than one week —
  a preset (This week, This month, This quarter, This year to date) or Custom
  with From/To date pickers. The range filters each of those four views, and
  your last-used range is remembered per user (in your browser). It's separate
  from the top-bar billing-month picker, which is only for invoicing.

## Dashboard

- At-a-glance cards: overdue tasks, due this week, stuck cases, unbilled hours.
  Each card links to the relevant page.
- "Your queue": checklist items assigned to you that need action.
- Team overview (owner): each member's open/overdue counts, last active,
  link to view their tasks.
- Cases in flight: multi-step cases with current step, who holds it, and a
  Stuck badge when blocked. Click to open the case.
- **"Skipped and pushed tasks to review (N)" (owner only)** — this year's
  quietly-skipped recurring tasks AND those pushed to a new date, newest first:
  the task, the client, who did it, when, which of the three reasons they
  picked, and their written explanation. A pushed row reads "Pushed to
  &lt;date&gt;" where a skipped row reads "Skipped". One "Reviewed" button per
  row clears it off the dashboard. Hidden when there is nothing to review, and
  never shown to a bookkeeper or an accountant. **Reviewing keeps the record** —
  an audit trail: the row is stamped with who reviewed it and when, never
  deleted. See "Skipping a recurring task" and "Pushing a recurring task to a
  new date" under Checklists.
- **"Invoices past due (N)" (owner only)** — every invoice that has gone out,
  is still owed, and is past its 30-day line, across ALL months, oldest line
  first: invoice number, client, when it was sent, days past due, total, and a
  link to the Invoices page. Same rule as the month run's **Past due** tab, so
  the two never name different invoices; one with a failed payment is left out
  here (it has its own tab). Hidden when nothing is past due, and never shown to
  a bookkeeper or while an owner is previewing as somebody else.
- Recent activity feed (owner).
- Quick actions: New task, Invite bookkeeper, Add client, Notifications.
- "Viewing as" (owner): preview the app exactly as a specific bookkeeper sees
  it (read-only preview; exit anytime).
  - **Every page built for preview shows the previewed person's own data**, not
    the owner's — the Invoice Recap (only the clients that person's team is on),
    the notification bell and its unread badge, "Waiting on you", the
    item-deletion and pending-edit approval queues, a case timeline, a client's
    notes, and a team member's activity log. Entering or leaving preview
    refreshes all of them at once, no reload needed.
  - **Owner-only pages stay owner-only in preview, which means they refuse.**
    Firm settings, the AI assistant, invoices, the client recap and the feature
    tracker answer firm-wide and a bookkeeper cannot open them, so while viewing
    as one they say they cannot load, exactly as she would see.
  - Anything not built for preview **refuses to answer rather than showing the
    owner's data** — including naming somebody the app cannot find: preview
    refuses instead of quietly falling back to the owner. A panel that says it
    cannot load while viewing as somebody else is deliberate — report it and it
    will be taught about preview; it never quietly shows the owner's figures
    under a bookkeeper's name.
  - Entering a preview is written to the activity log, against the owner who
    started it.
  - Preview stays strictly read-only: nothing can be changed from inside it.

## Time tracking (Time page)

- Live timer: pick employee → client → task → describe the work → start/stop.
  The most accurate way to log time.
- **Client, task and detail are REQUIRED before time can be logged.** Nothing is
  auto-filled any more: the description box starts empty and the app never
  invents a "standard" note, so what's saved is only what a person typed.
  - **Starting a timer is still instant** — start the clock with nothing filled
    in and fill the fields in while it runs (from the Time page, the Track
    time button on a client, or the **timer control in the top bar, which is
    on every screen**). The running clock stays in the top bar and keeps
    ticking as you move around; click it to go to the Time page to stop and
    log. The top-bar control can also start administrative
    (non-client) time; group time still starts from the Time page.
  - The rule bites at **Stop & log**. If something is missing the save is
    blocked and a prompt appears under each field that needs it ("Add a detail
    to log this time."). **The timer keeps running and no tracked time is lost**
    — answer the prompts and Stop & log works immediately.
  - Manual entries follow the same rule (on top of the required "why manually?"
    reason).
  - Administrative time has no client or task by definition, but **still needs a
    note** describing the work.
  - A group block (one block spanning several clients) is covered by its member
    clients and needs no task, but it does need a detail.
  - **The client field starts on "Choose client"** — a placeholder, not a real
    client (it used to open on whichever client sorted first, so time could be
    logged against the wrong one by someone who never looked). The placeholder
    can't be re-selected once you've picked somebody, on both the live timer
    and "Log time manually". **Start timer stays grayed out until a client is
    picked** (it says why on hover) — everything else about starting is still
    instant, with no task and no detail. Not applicable to administrative time
    or "bill to multiple clients", neither of which shows the single-client
    field.
  - **The form clears itself once the time is logged** — client (back to
    "Choose client"), task, detail, the administrative box and any group
    selection — so the next entry starts clean and no description is logged
    twice. A blocked or refused Stop & log clears nothing: everything typed
    stays until the time is actually saved.
  - Editing an entry can't blank a detail that was filled in. Older entries
    saved before this rule (blank description) still load and stay fully
    editable — their minutes, client and date can be fixed as before.
- **AD HOC TIME — one-off work outside what the client is scoped for.** Tick
  **"Ad hoc (outside scoped work)"** and the time bills on its own invoice line
  at that person's rate instead of disappearing into the month's hours.
  - Anyone who logs time can set it, on all three surfaces: the live timer
    (tickable while it runs; the answer rides on the timer to the stop and
    survives a refresh), "Log time manually", and the edit form on a saved
    entry. Flagged entries show an "Ad hoc" chip in Recent time.
  - Administrative time never offers it — there's no client for it to be
    outside the scope of. Marking an entry administrative clears the flag.
  - Splitting flagged time across clients carries the flag onto every slice,
    and so does adjusting a split: dividing out-of-scope work doesn't make it
    scoped.
  - **The owner has the final say at review** — see Time Approvals — and
    decides per line what to do with it on the invoice. See Invoices.
  - Internal (non-billable) ad hoc time still doesn't bill, same as any other
    internal time. Ad hoc is about WHICH line billable time lands on.
- The TASK box on the Time page — in the live timer AND in "Log time manually" —
  is pick-or-type, not a fixed dropdown, suggesting:
  - that client's open tasks (picking one attaches the time to the real
    checklist, as the old dropdown did),
  - that client's UPCOMING recurring tasks, shown as "Name (upcoming)" —
    choosing one generates the instance now and attaches to it,
  - every STANDARD task in the workspace (the client-agnostic blueprints on the
    Checklists page's "Standard" tab), and
  - anything you TYPE. A name that isn't in the list is saved as the entry's
    free-text task name, so it shows in the Task column on the Time page lists,
    in daily/weekly approvals, and in the Raw report export.
  Suggestions are de-duplicated by name with the client's real task winning a
  tie; leaving the box empty means no task. This replaced a dropdown that made
  custom task names impossible on any client that already had an open task.
- Track time for a single client, or SPLIT it across multiple clients.
  Available to EVERYONE who logs time (not just owners); the server enforces
  that every client picked is one that person is allowed to bill.
  - Log time manually → pick "A group", choose the clients, and choose how to
    divide the block (evenly, a custom minutes-per-client amount, or the full
    duration to each). Saving creates one billable entry per client in a single
    action (a live preview shows each client's share) — a true one-step split,
    no leftover "un-split" entry. An optional Task box (a standard task or your
    own words) names every entry.
  - **A tracked group block can be EDITED before it is split** — change the
    start/stop times, duration, date, description or billable, and it stays a
    group block across all its clients. You do NOT have to pick a single client
    first: the client box offers "Keep as group time (N clients) — split it
    below", and picking an actual client is optional and collapses the block to
    that one client. Split it after editing, as usual.
  - Live timer → pick "A group" and the clients, track the block, then "Split
    across clients" on the saved entry (in Recent time) to divide it the same
    ways. (Splitting a running timer happens after stop.) A multi-client timer
    block has no task until it is split; then pick each entry's task in its
    edit form.
  - ANY client time entry can be split after the fact — it need not have
    started as a "group". Every entry in Sent back / Recent time has a "Split
    across clients" action (also in its edit form, next to Save): a checkbox
    list of the clients that person may bill, the entry's current client
    already ticked. Tick the others, choose how to divide it, confirm — for when
    someone logged time to one client and then realized the work covered
    several.
    - Splitting to a SINGLE client is refused on purpose: that's just moving
      the entry, so use the Client dropdown in the edit form instead.
    - Administrative time can't be split — it has no client. Give it a client
      first.
    - The replacement entries go back into the daily approval queue as
      pending, even if the original was already approved (same rule as any
      other edit to an approved entry). Billable / internal is carried over.
  - A SPLIT CAN BE ADJUSTED AFTERWARD — it is not permanent. Any entry from a
    split shows "Adjust split" (in Recent time / Sent back, and in its edit
    form) instead of "Split across clients". It reopens the split as actually
    saved: clients ticked, each one's exact minutes filled in, the saved mode
    preselected, and the current total shown as "was". Change amounts, add or
    remove clients, switch modes, then save. Switching a reopened split to **By
    percentage** fills the boxes with what is billed today (36m and 24m of an
    hour show as 60% and 40%), so it can be re-divided without arithmetic.
    - THE TOTAL MAY CHANGE. Unlike creating a split, an adjustment does not have
      to add up to the original block — it is an explicit correction of what
      gets billed. The clock-in / clock-out times stay as the record of the time
      that was actually worked.
    - Adjusting down to ONE client is allowed: that's pulling a client back out
      of a split. (Creating a one-client "split" is still refused — that's just
      moving an entry.)
    - The whole group is replaced in one step and keeps its identity, so the
      time stays one split rather than becoming a trail of leftovers, and every
      adjusted entry goes back through approval. Adjustments are written to the
      activity log (who adjusted it, how many clients, old total → new total).
  - Editing ONE entry of a split (a typo in the notes, the date, the client)
    never disturbs the split: it keeps its own share of the time and stays part
    of the group. Resume / Add time on one still adds exactly the time added.
    To change how the time is DIVIDED, use "Adjust split".
  - Splitting is ATOMIC: the per-client entries are created and the source
    entry removed in ONE step, so a failure can never leave both behind
    double-counting the same time.
  - Each split entry KEEPS the block's clock-in / clock-out (manual group entries
    too) and its task — a checklist task stays on its own client's entry, the
    others show its name — while billing only its own share of the minutes.
    (Entries split from 2026-09-23 on; earlier split rows keep what they had.)
    Adjusting a split keeps each client's own task.
  - Every split is written to the activity log (who split what, how many
    clients, how many hours).
  - HOW THE SPLIT IS DIVIDED — the modal leads with the two easy answers:
    - **Evenly** — the same share of the block to every client.
    - **By percentage** — type each client's share ("60% / 40%"). The boxes open
      on an even percentage each, the modal shows each percentage in TIME as you
      type ("60% — 36m"), and a running line says whether it adds up ("Adds up
      to 95% — 5% left"); it can't be saved until the percentages total exactly
      100. Nobody works out minutes by hand.
    - **Exact minutes** — still available, in the compact row underneath. Type
      the minutes for each client. Needed for seconds-precision corrections, and
      it's what a saved split reopens on.
    - **Full duration to each** — unchanged and deliberately different: every
      client is billed the whole block (a meeting that serves several clients).
  - Percentages are just a friendlier way to SAY a custom split: they are
    converted to exact seconds and saved as a normal custom split, so nothing
    downstream (approval, payroll, invoicing, reports) sees a new kind of entry.
  - A CUSTOM / percentage split must add up EXACTLY to the tracked block — to the
    second, not the minute. Percentages that total 100 always convert to seconds
    that add up perfectly: the leftover seconds of an awkward block (33.33% of
    45m 20s) are handed out one at a time, so nothing is lost or invented. In
    exact-minutes mode the modal shows how much is still unassigned (or over) and
    has a one-click button to hand the remainder to the last client; the split
    can't be saved until it balances. Even splits divide the block to the exact
    second and always add up.
- Administrative work toggle: internal/company time with no client or task.
- Log time manually: same fields plus date and duration, for after-the-fact
  entries. Manual entries are flagged for owner approval ("manual" badge) and
  notify the owner.
- "Get ahead" tasks: picking an "(upcoming)" recurring task in the task box
  (above) generates it now so time can be logged against it. Staff can do this
  for their assigned clients.
- Recent time list: edit or delete your recent entries, scoped by the shared
  Report period (defaults to this month; the live timer and log form aren't
  affected). It shows EVERY entry in range (it used to cap at the 8 most
  recent, silently hiding older ones from anyone who logs a lot).
- Both Time-page lists — "Sent back" and "Recent time" — collapse from a chevron
  in their heading and each scrolls in its own box, so a long list never pushes
  the other (or anything below) off the screen.
- Editing an entry changes EVERY field, not just the time: the client it's
  billed to, the task, the date, the description, billable, the administrative
  toggle, the work sessions AND the hours/minutes duration, and — for owners —
  which team member it belongs to. A different client clears a task from the
  old client (the task list follows the client); switching to administrative
  drops its client/task and makes it non-billable.
- THE TIME ITSELF IS EDITABLE TWO WAYS, on every entry — timer captures
  included. The edit form offers both:
    - the WORK SESSIONS (clock in / clock out) — when the work happened; and
    - an HOURS + MINUTES duration — what actually gets BILLED.
  They normally agree, so changing a clock time updates the duration. But
  TYPING A DURATION WINS: the entry bills exactly what was typed, and the
  clock-in / clock-out times stay untouched as the record of when the work
  happened. (A session-backed entry used to have no duration field, and a typed
  time was silently recomputed from the unchanged clock — so the time could not
  be edited before splitting.) A hint under the field shows what the entry will
  bill and whether that came from the sessions or from you.
- EDIT THE TIME FIRST, THEN SPLIT IT. Adjusting an entry down from 60 to 45
  minutes and then splitting it divides 45 — the split always divides the
  entry's current billed time, and each slice keeps the original clock-in /
  clock-out. This works on a slice too: retyping one slice's duration bills that
  amount without restoring the whole block or disturbing its siblings.
- Typing a duration on a TIMER entry does not turn it into a manual entry — it
  is an edit, and goes through the normal approval queue like any other edit. No
  manual reason is required.
- Saving an edit RESUBMITS the entry for approval: a rejected entry goes back to
  pending, and so does an approved one (a changed entry must be re-approved
  rather than keep its old sign-off). A save that changes nothing leaves the
  approval state alone. Bookkeepers still can't edit a locked month; owners are
  exempt, and non-owners can only move an entry onto a client they're assigned
  to.
- Billable vs non-billable is determined by the client's billing setup.
- Weekly-submission gate: staff must SUBMIT (or resubmit) a prior week that has
  logged time before logging NEW time — dated in the CURRENT week or a future
  one. A prior week blocks when it's un-submitted OR was sent back for changes
  (rejected), with a message naming the week to submit/fix. A week already
  submitted (pending owner approval) or approved does NOT block, so an
  awaiting-approval week never locks them out.
- Catching up on a PAST week is always allowed: adding a forgotten entry to, or
  fixing one in, any week that has already ended never hits this gate, even if
  an older week is un-submitted or was sent back (editing never hit it; adding
  now matches). Only a LOCKED timesheet month, which an owner must unlock, stops
  a past-week change.
- **Guided "Submit timesheet" flow** (Aug 2026, client request): the submit
  button on the Time and Timesheet pages no longer sends whatever week is on
  screen. It opens a prompt that works PAST WEEKS FIRST: if any earlier week
  still needs submitting, it auto-selects the OLDEST, names it ("Submitting week
  of Sun Jul 26 – Sat Aug 1") with its hours, and says how many more are queued
  ("2 more past weeks still need submitting after this one"). Confirming sends
  that one week; the prompt then advances to the next oldest, and can be closed
  at any point. A week that was SENT BACK appears in the same queue as a
  resubmit and says so.
- When nothing prior is outstanding, the prompt says "All past weeks are
  submitted — nothing prior to submit." and then asks the completion question:
  "Are you finished logging time for the current week (Sun Aug 9 – Sat Aug 15)?
  Submitting sends it to the owner for approval." — Yes submits it, "Not yet"
  closes. **That explicit yes is the only way the current week gets submitted
  from the app.** The prompt's list of outstanding past weeks uses the SAME rule
  as the weekly-submission gate above (logged time, un-submitted or sent back,
  sealed months excluded), so the prompt and the gate can never disagree.
- If nothing prior is outstanding AND the current week can't be submitted
  (already pending or approved, or its month is locked), the prompt says so and
  offers only "Done". The server still accepts a submission for any week, so an
  owner can still ask someone to submit early.
- **The "Submit timesheet" button grays out once there is nothing to send**
  (Aug 2026, client request) — it used to stay bright after a week had gone in,
  which read as "you still owe this." On both pages it is disabled, with a
  tooltip saying why, whenever this click has nothing to submit: "Submitted —
  awaiting review." for a pending week, "Approved — this week is closed." for
  an approved one, a locked-month message when the month is sealed, and
  "Nothing left to submit — every week you owe is in." otherwise. The reason
  quoted is the week ON SCREEN, so paging to a week still owed lights the
  button back up.
- Two cases deliberately keep the button live. A SENT BACK week stays clickable
  — the resubmit path; graying it out would dead-end the rejection flow. And a
  week that is pending or approved while an OLDER week is still owed keeps it
  enabled, because that older week is exactly what the weekly gate blocks new
  time on; the tooltip then names the week the click would actually send
  ("This week is submitted and awaiting review. Submitting sends the week of
  Sun Aug 2 – Sat Aug 8 instead."). That naming applies whenever the click
  would send a week OTHER than the one on screen, including when the viewed
  week is itself owed but an older one is queued ahead of it ("Submitting sends
  the week of Sun Aug 2 – Sat Aug 8 first.").
- If no one is signed in the button reads "Sign in to submit a timesheet."
  rather than claiming the person is caught up.
- Inside the prompt, the confirm button disables itself and reads "Submitting…"
  while the request is open, so a double-click can't fire two submissions.
- None of this is UI-only: a weekly submission is one row per person per week,
  so re-submitting the same week can never create a second one, and an
  already-approved week is returned untouched rather than knocked back to
  pending.

## Timesheet page

- Day-by-day view of what each person worked on, scoped by the shared Report
  period, with a total. Owner can switch between team members; staff see their own.
- Single-week mode (Report period = This week, or a one-week range): navigate
  weeks with ◀ ▶ arrows or "This week", and the approval / lock status for that
  week shows alongside. The "Submit timesheet" button opens the guided flow
  described above — it always starts with the oldest past week still owed, not
  the week being viewed.
- Multi-week range: the day list + total are read-only (no Submit/lock); pick a
  single week to submit or lock — the weekly submission model is unchanged.
- **Every duration on the page is BILLED time, not clock time** (Aug 2026, client
  request). Each row still shows the clock-in → clock-out it came from, but the
  minutes beside it are that entry's own billed minutes. For a SPLIT block, each
  slice keeps the whole original block's clock-in/out as its audit trail, so a
  25-minute block split across 20 clients shows ~1m 15s per client and a
  25-minute day — not 25 minutes twenty times. For a hand-corrected entry, the
  page reports the corrected duration with the untouched clock times beside it.
  Day, range and week totals are sums of those billed minutes.

## Time Approvals (owner only)

- **TABBED sections.** The page's three areas — **Weekly submissions**,
  **Approval queue** and **Timesheet locks** — used to be stacked (signing off a
  month meant scrolling past every submitted week and pending entry); each is
  now one click away, using the same tab bar as the Checklists page. Each tab label shows its
  pending count: weeks awaiting review, entries awaiting approval, and people
  not yet locked for the month shown in the locks table (0 for a month that
  hasn't ended, since those can't be locked). The page OPENS on the first tab
  with pending work, or on Weekly submissions when everything is clear. The
  open tab is in the URL (`?section=weekly|queue|locks`) so it can be linked
  and survives a refresh, and an old `#weekly-submissions` / `#approval-queue`
  / `#timesheet-locks` link opens the matching tab. Navigation only — nothing
  about how time is approved, rejected or locked changed.
- **What needs per-entry approval** (changed Jul 2026 per owner request): a
  pure TIMER capture is auto-approved the moment it's saved — never in the daily
  approval queue; the weekly submission / month lock reviews it as a whole.
  Individual daily approval is reserved for time a person TYPED: manual entries
  (which always carry a reason), the per-client allocations from splitting a
  group time block, and any entry EDITED afterwards (editing an approved entry
  re-queues it as pending — a changed client/time/date never silently keeps its
  old sign-off).
- **AD HOC — the owner's backstop.** Every entry in the approval queue carries
  an **"Ad hoc (outside scoped work)"** tick. Employees set it when logging;
  review is where a missed one is added or a wrong one taken off. It saves the
  moment it's ticked (no need to also approve the entry), because it decides
  how the time bills and the invoice run reads it straight off the entry.
  **Only owners can change it on somebody else's time** — enforced on the
  server, not just hidden in the page. Administrative entries have no tick.
  **An owner ticking it does NOT un-approve an already-approved entry** — the
  flag changes how the work bills, not the record of it, and the person ticking
  it is the approver. (Every other edit still re-queues, as does this one if a
  bookkeeper changes it on their own approved time, or an owner changes
  anything else alongside it.)
- Weekly submissions: staff submit a week; approving seals every pending
  entry in it. Rejecting unlocks the week so the bookkeeper can edit and
  resubmit.
- Reopen an approved week (undo an approval): a "Recently approved" list shows
  the latest approved weeks, each with "Reopen", which un-approves the week —
  the submission goes back to pending (re-entering the review queue) and its
  sealed entries become pending and editable again. (If the month is ALSO
  locked, unlock it in the Month-end section — the two are independent;
  unlocking a month is what actually lets staff edit that month's time.)
- Weekly review modal: expand any individual entry; per-entry actions —
  "Approve this entry" or "Send back with note" (the note is required and the
  bookkeeper sees it). The owner does not edit staff time directly.
- Sending an entry back NOTIFIES the bookkeeper: an in-app bell + email naming
  the client, the date, the hours and the owner's reason, linking to the Time
  page to edit and resubmit. (Rejection used to be silent — only a red note in
  their Recent time list.)
- A team member sees ALL of their own time — client work for their assigned
  clients, administrative time, AND unsplit GROUP holding entries. A group block
  has no single client (its members sit in the group list until it's split for
  billing), so it used to fall outside the client-scoping rule and vanish from
  the bookkeeper's own view: they couldn't see, edit or split time they had
  tracked, and their totals came up short of the owner's for the same day. Only
  the member COUNT is shown, never the member client names.
- "SENT BACK" section (Time page): a panel at the top of the Time page listing
  every one of YOUR entries an owner returned, so they're found and fixed in one
  place. Unlike Recent time it is NOT scoped by the report period and NOT capped
  (Recent time's old 8-entry cap is what used to hide rejected entries from
  anyone who logs a lot). Oldest first, each with the owner's reason and the
  normal editor; "Edit & resubmit" sends it straight back for approval without
  resubmitting the week. Hidden entirely when nothing is sent back.
- "N sent back" badge: individual entries can be returned while the WEEK's
  submission stays "pending", so the week status alone never reveals it. Both the
  Time page week bar and the Timesheet week controls show a red "N sent back"
  count for that week whenever any of its entries are rejected. Editing a
  sent-back entry resubmits it (back to pending) automatically.
- Every approval surface (the week-review list and the individual approval
  queue) shows CLOCK IN → CLOCK OUT for each entry, with per-session rows and
  each session's length when a day was split, so hours can be audited against
  when the work happened. Timer entries and older ones predating the sessions
  model fall back to their start/stop stamps rather than showing nothing.
- Approval queue: filter Pending / Rejected / All individual submitted entries.
- Timesheet locks: lock a month per employee — pending entries are
  auto-approved and the employee can no longer change that month. "Lock all"
  locks everyone at once. Locking is the month-end sign-off. Only a month that
  has ALREADY ENDED can be locked — locking the current or a future month would
  block everyone from tracking time in it (the per-row Lock and "Lock all" are
  hidden for such months; the server rejects it too). Unlocking any month
  always works.

## Checklists (tasks)

- **Overdue work is PINNED to the top of the page, above everything.** When you
  have anything past due, a slim red "Overdue" bar with a count is the first
  thing on the Checklists page — collapsed by default so it signals without
  shouting. Click it to expand one row per late task: the business, the task,
  when it was due, how many days late, and whose task it is, longest-overdue
  first. It starts collapsed on every visit.
  - **Nothing can bury it.** It sits above the tabs, so it shows on every tab,
    and ignores the assignee/client/status filters, the search box, the
    group-by choice and the report period — those narrow the list below, never
    the panel. (So its count, of the tasks IN the panel, can differ from the
    "Overdue" section count in the list below.)
  - **Clicking a row takes you to that task's card** in the In progress list and
    clears whatever was hiding it: it switches to the In progress tab, clears
    the filters and the search box, and shows the task even outside the current
    report period. **It does not change your report period** — that setting is
    shared with the Timesheet, where a changed range would break the weekly
    submit; the one task you jumped to is simply let through.
  - Late tasks appear **twice** on purpose: in the panel (the nudge) and in
    their normal place in the list (where you actually work).
  - **A skipped cycle never appears there** — a task deliberately moved to its
    next occurrence is not late, same rule as everywhere else in the app.
  - **When nothing is overdue the panel is simply absent** — no "all caught up"
    banner; not seeing it IS the good news.
  - Each person sees their own scope: staff their own overdue tasks, the owner
    the whole firm's.
- **The page is split into four TABS: "In progress", "Repeating", "Standard"
  and "Completed"**, each showing a count. They used to be stacked, so reaching
  a repeating task meant scrolling past every in-progress checklist (hundreds
  of them); now each is one click away.
  - **In progress** — the live checklists, exactly as before: the
    "Group by: Due date / Client" choice and its collapsible Overdue / Due this
    week / Due this month / Later / Completed sections are unchanged.
  - **Repeating** — the recurring task setups (owner edits them here; staff see
    the recurring checklists for their assigned clients).
  - **Standard** — the firm's reusable blueprint templates.
  - **Completed** — the history of finished tasks (see below).
  - On "Repeating", tasks are grouped under their business, listed
    alphabetically, and **each business starts COLLAPSED** — you see a scannable
    list of business names with a count each, and click one to open its tasks.
    (Searching opens matching businesses automatically, and a link that jumps to
    a specific repeating task opens its business too.)
  - **In progress / Repeating / Standard each have a search box** (Completed has
    filters instead — see below). On "Repeating" it matches the BUSINESS name
    or the task name, so you can jump straight to a client's repeating setup
    instead of scrolling the whole list; "Standard" searches template names, and
    "In progress" searches business or task name as before. Each shows "N of M"
    while you type, and Escape clears it.
  - The count on each tab reflects what you'd actually see — the "In progress"
    count applies the current report period and the assignee/client/status
    filters. If that count looks low, the report period is usually the reason
    (a narrow custom range hides everything outside it).
  - The "+ New" button stays available from all four tabs.
  - Links that jump to a specific task or a specific repeating setup switch to
    the right tab automatically, so a link never lands on a hidden area.
  - The recycle bin sits below the tabs and is always available (owner only).
- **Completed tasks tab — the record of finished work.** A finished task never
  moved anywhere: it stays where it always was and is simply filtered out of the
  active lists. This tab is the view of them, newest first, showing WHAT was
  completed, for WHICH client, by WHOM, and WHEN.
  - **Read-only.** There is nothing to press: no checkboxes, no editing, and no
    way to re-open a task from here. Re-opening is done on the In progress tab,
    where the usual permission rules apply.
  - **Who sees what:** an employee sees their own completed tasks; an
    **Accountant** also sees the completed tasks of the people staffed on the
    clients they're assigned to; the owner sees everything. (This is the same
    rule the open-tasks count uses. There is no supervisor field in the data, so
    "their bookkeepers" means "the people on the same clients".)
  - **Filters:** client, person, and a completed-from / completed-to date range.
  - **"Completed by" is the person responsible for the task.** Completing a step
    requires being its responsible person, so that's who finished it — the app
    does not separately record which account clicked the checkbox.
  - **Dates before this feature show "—", not a guess.** The app did not record
    completion times until this tab was built (a step was just ticked or not),
    and those moments cannot be recovered; rather than print a made-up date on
    an audit screen, older rows show a dash, with a note under the table saying
    why. Everything completed from now on carries a real timestamp. Setting a
    date range hides the dashed rows (an unknown date can't be said to fall
    inside a window), and the tab says so.
- **THE PERIOD A TASK'S WORK COVERS, shown next to its title.** A recurring task
  can carry a small label naming the period it is FOR — "July 13 – August 13,
  2026" on a task due at the end of August — so a stack of similar-looking
  monthly tasks can be told apart at a glance. It sits beside the task title on
  the checklist card.
  - **Off unless it was turned on for that repeating task** — like skipping, a
    setting on the repeating setup ("Show the period it covers"), chosen at
    creation and changeable later on the Repeating tasks list. Most tasks have
    none, and a task without one shows nothing at all — no empty space, no dash.
  - **You pick the dates**: beside the switch, the FIRST period the task covers
    — a From and a To, e.g. July 13 to August 13. Nothing else to fill in.
  - **It advances on its own, by however often the task repeats**: the next
    occurrence reads "August 13 – September 13, 2026", the one after
    "September 13 – October 13, 2026", with nothing to reset or roll over. A
    quarterly task steps a quarter, a yearly one a year.
  - **It behaves, and is worded on screen, like covered dates on a reimbursed
    expense**: set the first window once and every later cycle moves itself.
  - **Changing the dates re-anchors from the next occurrence on.** Occurrences
    already created keep the label they were born with.
  - **IT IS ONLY A LABEL.** It does not change anything: not the due date, not
    which month work is billed in, not any report, total, filter or sort. It is
    there to be read. Turning it on for a repeating task changes nothing about
    the tasks it creates except that they now carry the label.
- **A REPEATING TASK STARTS THE DAY IT IS SET UP. Past occurrences are not
  created.** Setting one up — by hand, or with "Set up plan checklists" on a
  client — produces its first task on or after that day, never filling in the
  months or weeks before. A task set up in September on a recipe that runs in
  February, March, May, June, August, September, November and December opens
  with September, not with five older ones to delete. A weekly or monthly
  recipe likewise starts at its first cycle from today rather than catching up
  from whatever date the blueprint carried.
  - **Tasks that already exist are never touched** — only ones that would have
    been created from now on.
  - **One occurrence that is already due still appears.** Setting up a monthly
    task today and dating it the 1st of this month gives you this month's task —
    that is a date you chose, not a back-fill. What is skipped is a run of them:
    a recipe whose date came from a blueprint months back.
  - **Choosing a first due date yourself still wins.** If you pick a date when
    you set the task up, that date is used exactly as you typed it, past or not.
- **Skipping a recurring task (a "quiet skip").** When someone won't complete a
  recurring task this cycle but will catch it on the next occurrence, they can
  step past this one instead of letting it sit there flagged as overdue.
  - **Skipping is OFF unless it was turned on for that repeating task** — a
    setting on the repeating setup itself ("Allow skipping an occurrence…"),
    chosen at creation and changeable later on the Repeating tab; setups are
    owner-managed, so the owner decides. **With it off there is no skip button
    at all** — not a grayed-out one — so nobody is invited to ask for something
    never on offer.
  - **One-off tasks are never skippable**, because there is no next occurrence to
    catch them on. Skipping only exists for repeating work.
  - **What the person doing it sees:** a "Skip this cycle" button on the task
    card and one small form — a required dropdown for **who couldn't complete
    it (me / a colleague / the client)** and a required written explanation. No
    approval to wait for, no block: the task leaves their active list for this
    cycle, and that's the end of it for them.
  - **The next occurrence still generates exactly as normal**, on its own due
    date, open and unskipped. Skipping one cycle changes nothing about the
    schedule.
  - **A skipped task does not read as overdue anywhere.** The overdue rules are
    unchanged — a skipped occurrence simply isn't in the lists they read, because
    it was deliberately moved on rather than missed.
  - **Who gets told:** the owner every time, and an **Accountant** when a
    **Bookkeeper** skips a task on a client that accountant is assigned to (no
    supervisor field exists, so "their bookkeepers" means "the people on the
    same clients", as everywhere). Both are ordinary in-app notifications plus
    the usual email, and both can be
    turned off per person under Settings → Notifications ("Skipped recurring
    tasks").
  - **The owner reviews them on her Dashboard** — see "Skipped tasks to review"
    there. Marking one reviewed clears it off the dashboard and keeps the record
    permanently.
  - **A skip is not a deletion and not a completion.** The task is still there,
    still attached to its time entries and its history; it is simply out of the
    way for this cycle.
- **Pushing a recurring task to a new date.** When someone still intends to do a
  recurring task but not by the date it is due, they can push it — the task
  stays open and moves to a new due date instead of being stepped past.
  - **"Push to a new date" is on every task you can edit** — recurring or
    one-off, whatever the repeating setup says about skipping: beside "Skip this
    cycle" where skipping is turned on, on its own everywhere else. **Skip is
    unchanged**: it still appears only where an owner turned it on for that
    repeating setup, and never on a one-off. (Push used to share that setting, which is why it was
    hard to find — it was on 6 of 150 repeating setups.)
  - **The form is the same, plus a date.** A required dropdown for **who could
    not complete it (me / a colleague / the client)**, a required written
    explanation, and a **new due date pre-filled with the next cycle** of that
    task's own schedule (a monthly task offers next month, a quarterly one next
    quarter). The date is editable to anything later than the current due date;
    a push only ever moves a task forward. The picker starts the day after the
    current due date, and a push may not land more than **two years** past it —
    further out is a mistyped year far more often than a plan, and a genuinely
    distant task can simply be pushed twice.
  - **It is not a completion and not a skip.** Nothing is checked off, nothing is
    unblocked, and no next step is started. The task simply lives on at its new
    date, with every step exactly as it was.
  - **It keeps its place in the cycle, so the next occurrence still generates.**
    The task remembers its original due date, and that is what the schedule
    counts: a task pushed from September into October does not make September
    generate again, and October's own occurrence is still created on time as a
    separate task — even on the very same day.
  - **The card says so.** A pushed task reads "Pushed · was &lt;date&gt;" beside
    its due date, so the new date explains itself.
  - **Who gets told:** exactly the same people as a skip — the owner every time,
    and an **Accountant** when a **Bookkeeper** pushes a task on a client that
    accountant is assigned to. Same in-app notice plus email, same per-person
    switch under Settings → Notifications ("Skipped and pushed recurring tasks").
  - **The owner reviews pushes on her Dashboard,** in the same list as skips
    (see "Skipped and pushed tasks to review" there); marking one reviewed
    clears it off the dashboard and keeps the record permanently.
  - **Still open, not built:** whether a push should apply to a single step
    rather than the whole task, and whether pushing a step in a multi-step case
    should trigger the next step. Today a push always applies to the whole task
    and triggers nothing.
- **When a team member creates a task, the owner is notified.** The notice names
  the task and the person, so she can decide whether skipping should be allowed
  on that kind of work. (Repeating setups — where the skip setting actually
  lives — are owner-managed, so this is what tells her there is a call to make.)
- **When a step is completed is now recorded.** Ticking a step stamps the
  completion time; un-ticking it (or adding a sub-step to a finished item,
  which re-opens it) clears the stamp. The stamp survives ordinary saves — a
  background workspace save can neither erase a completion date nor invent one.
- A checklist = a task for a client: title, client, assignee, due date,
  frequency (one-off, weekly, monthly, quarterly, annual), steps.
- Steps support sub-steps and sub-sub-steps, drag-to-reorder, per-step due
  date and per-step assignee ("Same as checklist" by default), and checkboxes.
- "Paste a list" turns pasted lines into steps in one go.
- Each checklist card leads with the CLIENT NAME (bold + larger) and shows the
  checklist name just beneath it, so a long list is easy to scan by client; the
  due date is bold. (On a client's own detail page the client name is already
  obvious, so the card leads with the checklist title there instead.)
- Adding a task to a live RECURRING instance asks the owner where it goes: "This
  checklist only" or "This + all future" (also added to the template's matching
  stage, so every future instance includes it) — for both "Add an item" and
  "Paste a list". Non-owners, and one-off checklists, add to the current
  checklist directly with no prompt.
- Group the page by due date or by client; filter by assignee, client, status.
- Waiting on (the hourglass ⏳): flag a step as waiting, write who/what it's
  waiting on (free text), optionally pick the SPECIFIC other task it's waiting
  for — when that task completes, the blocked step's assignee gets an in-app +
  email notification ("Ready to continue"). That picker offers **only this
  client's other tasks that you can actually open** — never the whole
  workspace. Skipped occurrences are left out (a skipped task never completes,
  so the ping would never fire), as are recycle-bin tasks and other people's
  tasks you aren't on; an internal task with no client sees only the other
  no-client tasks. A link **already saved** is the exception: it stays listed
  and selected even if that task belongs to another client, has since been
  skipped or recycled, or isn't yours — a cross-client one shows its client's
  name in brackets — so opening the editor can never quietly break an existing
  dependency. The task you pick saves WITH the wait you're composing (see
  "Creating a wait is Save" below) and is fixed afterwards. Waiting items also
  appear on the Delayed page.
- Resolving a waiting step — **Done vs Clear** in the waiting editor, for a step
  flagged waiting the free-text way with **no saved wait live on it** (once a
  wait is saved both disappear; see the lock below). **Done** retires the flag
  and keeps the note visible on that checklist as a "Was waiting on: …" record
  (that instance only — future recurring instances start fresh), a history of
  what the team keeps waiting on. Done does **NOT** check the step off —
  completing the work stays with the normal checkboxes (owner feedback: the
  reference should sit on the still-open step). **Clear** just un-flags and
  erases the note. Resolved steps stop counting on the Delayed page and the
  Board's pending chips. A server refusal shows its reason in red inside the
  waiting editor instead of the button appearing to do nothing.
- Waiting on a PERSON (two-way): you can also flag a step as waiting on a
  specific team member. That person is notified immediately that someone's
  blocked on them, sees it in a "Waiting on you" card on their Dashboard, and
  gets a "Mark done" button — clicking it notifies BOTH the step's assignee and
  whoever flagged it that they can continue. A step can wait on several people
  independently; each is cleared (and notified) on its own. You can wait on a
  colleague or on the task's client — **never on yourself**: your own name isn't
  in the picker, and the server refuses it ("A wait names who you are waiting ON
  — pick the client or a colleague, not yourself").
- **The hand-off has TWO steps, and the record is kept.** Clearing a wait used to
  delete it, erasing the name of whoever did the check the moment they finished.
  Now a wait moves through three states and is never destroyed:
  1. **Waiting** — amber. Sits on the Delayed page of the person being waited on,
     and of whoever asked (and the step's assignee, who is the one held up).
  2. **Done** — the person being waited on presses **Mark done**. It leaves THEIR
     Delayed page, notifies whoever asked, and shows green with "done by <name>"
     and a date, tagged "awaiting your OK".
  3. **Approved** — whoever asked presses **Approve**. The wait closes out and
     leaves their Delayed page too — and stays on the checklist step as a
     **completed sub-item**: a ticked box with the label struck through, exactly
     like a task you check off, with the full record underneath ("asked by
     <name> <date> · done by <name> <date> · confirmed by <name> <date>"). It
     stays there permanently — after the step is checked off, after the amber
     waiting editor closes, and whether or not you can edit the task. The tick
     belongs to the WAIT, not the step: confirming a wait never checks the step
     itself off, and the box can't be un-ticked.
  You cannot approve work nobody has reported finished (the app says so — the
  wait keeps until they press Done), and the person who did the work cannot
  approve their own. Owners can do either step on anyone's behalf.
- **A saved wait can never be removed — by anyone.** The old **Cancel** (the ×)
  that erased one outright is gone, and so is the route behind it: a wait is
  the shared record of who asked, who did it and who confirmed, so removing one
  would take that receipt from everybody on it, not just whoever pressed the
  button. Nothing in the app deletes a wait, and the old `cancel` request is
  refused server-side with the reason ("A saved wait is the record of who asked
  and who did it, so it stays on the task. Mark it done and approve it
  instead."), so an old browser tab can't do it either. The way out is forward:
  Mark done → Approve, or Send back for another lap; the record, with its
  dates, stays on the task permanently through every stage.
- **Send back — "not approved, do it again."** At step 2 the person who asked
  gets a **Send back** button beside Approve. It asks for a note (required) and
  hands the wait straight back: it turns amber again, reappears in the other
  person's "Waiting on me" list with a Done, and notifies them exactly like the
  original request did. Nothing is overwritten — the original note stays put, and
  every send-back note is kept in order alongside who had reported it done and
  when, so a wait that went round three times reads back in full. The step itself
  is never ticked off by any of this.
- **Question — "what exactly do you need?"** The person being waited on gets a
  second button beside Done — on their Delayed page AND on the wait's chip on the
  checklist step: **Question**, which opens a message box. Sending it does
  **NOT** complete the wait — the item stays on their list, still their move.
  Every question is kept on the wait (attributed and timestamped, alongside the
  send-back history) and whoever asked gets a notification with the question in
  it; the step's assignee and the person being waited on are told too, so a
  question an owner sends on someone's behalf is never invisible to them. The
  LATEST question shows on both sides — the Delayed page and the checklist step
  — so nobody has to remember what was asked. A wait on the CLIENT has no
  Question: a client has no login to read one.
- **Creating a wait is Save, and it is final.** The first click on "Waiting on…"
  opens an editor and commits **nothing**: pick the person (or the client), type
  the message that goes WITH the wait, and optionally choose the task it's
  waiting for — all held on your screen until **Save** writes them in one go.
  **Clear** (only before Save) discards the whole draft if you opened the picker
  by accident: nothing is created or notified, and nothing the step already had
  is touched.
- **Save locks everything.** Once a wait is saved, the person or client it names,
  its message and the task it waits for are all fixed — "all info is locked and
  cannot be changed." On a step carrying a live wait the editor shows no note
  box, task picker, Clear or Done at all; the saved task link still READS
  ("Waiting for: <task>") so you can see the dependency. The only controls left
  are the wait's own: Mark done, Question, Approve, Send back. The server
  enforces the same rule — changing the step's waiting note or task link, or
  un-flagging it, while a wait is live is refused with the reason ("This wait
  was saved, so who it names, its message and the task it waits for are fixed.
  Mark it done and approve it instead."), so an old browser tab can't do it
  either. A SECOND wait on the same step still works but is no way in: its
  composer offers no task picker, and the server refuses a create that would
  change the locked link. Renaming the step, changing its due date or
  reassigning it are untouched by the lock — the step's business, not the
  wait's. The lock lifts once every wait on the step is approved, so a finished
  step can be tidied up normally.
- **Save is a request, and the app waits for it.** Save stays disabled until the
  wait is actually created, so a double-click on a slow connection can't create
  two permanent waits; if the server refuses, everything typed stays on screen
  beside the reason instead of being thrown away.
- **A wait cannot be lost to an unrelated save.** Waits are written only by the
  waiting-on buttons; every other save — including the big background one as
  you work — leaves them exactly as they are on the server, whatever the saving
  tab had loaded. So neither a wait nor the note, task link and flag it locked
  can be flattened by somebody else's autosave.
- **Ticking a step off doesn't hide a live wait.** A checked-off step that still
  has an open wait keeps showing it ("This step is checked off, but a wait on it
  is still open"), so Approve / Send back stay reachable from the step.
- **The waited-for task is checked, not just filtered.** The picker only offers
  this client's other tasks; the server now holds the same line, so a link to a
  task that no longer exists, to another client's task, or to the task itself is
  refused with a plain sentence rather than saved. A link that was ALREADY saved
  can always be re-sent, so an older cross-client dependency never becomes
  unsavable.
- **Waiting on the CLIENT.** The same picker offers the task's own client
  alongside the team (the task already belongs to one). A client has no login,
  so there is nobody to hand back to or notify: a single press ("Heard back")
  by whoever flagged it or the step's assignee closes it out, keeping the same
  record of who cleared it and when.
- Recurring templates: build a template once (with steps/sub-steps); the app
  materializes an instance each period automatically. Frequencies: daily,
  weekly, biweekly, monthly, quarterly, annually, or specific months. Each
  template recurs on its OWN cadence independently — a monthly template never
  blocks a weekly one from generating. Templates support multi-stage cases
  (see Cases). Owner manages templates; "get ahead" lets staff generate the
  next instance early (this actually CREATES it).
- Upcoming (read-only preview): the Board and Gantt can show FUTURE recurring
  instances that haven't been generated yet — projected from each template's
  recurrence rule and shown faded with an "Upcoming" badge. These are
  read-only previews only: they are NOT real tasks, can't be edited/checked,
  and nothing is created (unlike "get ahead"). A "Show upcoming" toggle turns
  them on/off; the horizon is the selected Report period.
- Cases (multi-stage workflows): a template can define stages (e.g. Data
  entry → Review → Filing) with a primary assignee per stage. Completing a
  stage advances the case and notifies the next assignee; the case opener is
  notified when the whole case completes. Stuck cases are flagged on the
  Dashboard.
- Task card actions: Edit details (title, due date, assignee) — the owner and any
  assignee/editor/assigned-staff can open the editor. Delete task — for the OWNER
  (the approver) it moves the task to the owner-only Recycle bin immediately
  (time entries preserved, restorable until emptied). For STAFF, deleting a
  whole checklist OR an individual step/sub-step files a deletion REQUEST an
  owner must approve; nothing is removed until then. The owner sees a "Pending
  deletion requests" queue at the top of the Checklists page (whole-checklist
  and per-item) with Approve (delete) / Reject (keep), and gets a bell
  notification when one is filed; the task/item shows a "Deletion requested"
  badge to staff until resolved.
- APPROVAL IS ONLY FOR DELETES. Adding a step, editing a step (rename / due date /
  assignee), and editing a task's details all apply IMMEDIATELY for anyone
  authorized to edit that task — no approval, no pending-edit queue. Completing
  steps and "waiting" flags always applied directly and still do. Deleting a
  checklist or a step still files a request an owner must approve (above).
  (Any pending task edits filed under the old model can still be approved or
  rejected from the existing queue; no new ones are created.)
- CHECKING A STEP OFF IS PERSONAL: only the person a step is assigned to can tick
  it — its own assignee when set, otherwise the checklist's assignee — plus the
  owner as an override. Being assigned to the client lets you SEE the checklist,
  not edit it (see the sharing rules below), and never lets you complete someone
  else's work; sub-steps follow their parent step's responsible person. Boxes you can't
  tick render disabled with a "assigned to someone else" tooltip, and the server
  enforces the same rule.
- Sharing/visibility: a team member assigned to a client — or anyone holding a
  task on it, which grants the same seeing without joining the team — sees ALL
  of that client's tasks on the shared board and can LOG TIME against any of
  them. But SEEING is not EDITING. **Only the task's assignee, a named editor,
  or an owner can change a checklist** — rename it, change its due date or
  assignee, add, edit, reorder or delete steps, or flag a step as waiting. A
  colleague on the same client gets a read-only card; the server refuses the
  write with a 403 either way. (Sharing a client used to be enough to edit a
  co-worker's live checklist.) A step handed to one person specifically can be
  edited by that person. Staff can still CREATE a one-time task for any client
  they're assigned to (the Checklists page's "New task" button). Owners can
  create/edit everything.
- WHOSE TASKS EACH VIEW SHOWS (owners always see everyone):
  - **Clients tab → Checklist button** — YOUR OWN active checklist for that
    client, the same view as the Checklists tab's In-progress list. If you have
    none it says "No active task at this time" rather than showing a
    colleague's.
  - **Checklists → In progress** — your own active checklists (plus any the
    owner explicitly named you a viewer on).
  - **Checklists → Repeating** — everyone assigned to the client can SEE the
    recurring recipes; only the owner changes them.
  - **Checklists → Standard** — every team member can browse the blueprints
    ("Standard templates") READ-ONLY; only an owner edits one. An accountant can copy one to a client
    (the usual "Copy to client" picker, below); a bookkeeper views only.
  - **Gantt** — your own lane and your own tasks only.
  - **Open/late task counts on the Clients list** — your own open tasks. An
    ACCOUNTANT also sees those of the people staffed alongside them on their
    clients. (There is no supervisor field in the data — "the bookkeepers you
    oversee" is read as shared client assignment.)
  - **Board** — your own active checklists, same as the Checklists tab; an
    ACCOUNTANT can tick "Show my bookkeepers'" (see Board). (It used to be the
    whole shared board — every colleague's task on every client you share,
    which the owner spotted reviewing as a bookkeeper.)
- Recurring checklists (the repeating "recipes") — team members can VIEW those
  for their assigned clients in TWO places: (1) a read-only "Recurring
  checklists" section on the main Checklists page (under "Your clients"),
  grouped by client, collapsible, searchable, each recipe with its cadence,
  next due date and steps — so staff see what's coming up where they work; and
  (2) each client's detail page, with its own "Recurring checklists" section
  plus an "Upcoming (next 60 days)" list. Both exist so staff know what exists
  and don't create duplicates. A repeating checklist can't generate the same
  task twice for one due date any more — one period gives exactly one task,
  however many people have the app open, and "Generate a task now" on a date
  that already has one opens the existing task instead. Staff can't create,
  restructure, or turn recipes on/off (owner-only) — but they CAN add steps,
  both to generated instances and (via the "this + all future" prompt)
  APPENDED to the recipe itself for a client they're assigned to. Appending is
  the only recipe change a non-owner can make; editing or removing existing
  recipe steps stays owner-only, and standard (client-agnostic) blueprints stay
  owner-only entirely.
- **Accountants can apply a standard checklist to their own clients** (it used
  to be owner-only). A team member whose staff role is **Accountant** gets the
  same "Copy to client…" control on standard blueprint rows, with two limits,
  both enforced on the server whatever the page shows: **standard blueprints
  only** (not a template bound to another client), and only onto a **client
  they are assigned to**. Bookkeepers still ask an owner; owners can apply any
  template to any client.
- **Copy a template onto a client from the Checklists tab.** Every template row —
  standard blueprints on the "Standard" tab AND recurring templates on the
  "Repeating" tab — carries a "Copy to client…" button on the row itself, no
  expanding needed (owners on any row, accountants on standard rows). Choosing a
  client in its picker creates a new recurring checklist there from the
  template's stages and steps, and the row confirms "Copied to <client>". The
  same copy is used everywhere, so a standard blueprint and another client's
  recurring checklist copy the same way.
- **Duplicate a repeating task (and what the copy does).** "Duplicate" inside an
  expanded repeating task makes a copy of the recipe titled "<name> (copy)"
  that **arrives switched OFF**, **starts today** (never filling in months from
  before it was made), and opens its own editor with a note saying so. Pick its
  client, change anything else, then turn it on — nothing is generated for
  anyone until you do. The order matters: a copy left on would create this
  month's task for the ORIGINAL client within seconds, and a task keeps the
  client it was created for forever, which also blocks the new client's month.
- **Changing a repeating task's client asks first.** If the recipe has already
  created tasks, switching its client shows a confirmation naming the count —
  "3 existing tasks stay with Let's Eat, LLC. Only new tasks will be created for
  I-95 Signature, LLC." Existing tasks are never moved to the new client; only
  tasks created from then on belong to it.
- Owners can apply a template **directly from the Clients page** too: each client
  row's "Template" button opens a picker of standard templates and recurring
  templates copied from other clients and applies the chosen one (the same copy
  as the Checklists page's "Copy to client…"), including for brand-new clients
  the moment they're added.
- Time logged against a task shows on the card.
  **How the dates move (fixed 2026-09-18):** the window you type lands on the
  occurrence in front of you and moves forward by the recipe's own schedule -
  a some-months-of-the-year recipe steps by the months it actually runs, a
  full calendar month stays a full month, and a longer window keeps its
  length. Saving a recipe's dates updates its open tasks right away; finished
  tasks keep the period they had.

## Board — Active Checklists (sidebar: "Board")

- A second view of the active checklists, grouped **by service type** ("service
  categories" — e.g. Monthly Bookkeeping, Quarterly Bookkeeping, Sales Tax,
  Payroll), laid out as a **wrap grid** (client feedback, round 2): as many
  groups per row as fit (each at least ~320px wide), wrapping to the next row,
  with the page scrolling vertically — one column on a narrow screen, several
  on a wide one. Each section lists the **clients that still have open work**
  of that type, with a count badge.
- Each client row is **collapsible** — expand it to see and work the client's
  live checklist(s) for that column (same checkboxes/cards as the Checklists
  page). Completing a client's checklist **removes that client from the column**
  automatically, so the board always shows what's still open.
- **Report period** at the top (the shared date-range control): the board is a
  horizon — a checklist shows when it's due on or before the END of the selected
  period (`to`), so overdue work stays visible and the view widens as you pick a
  larger range (week → month → quarter → year-to-date → custom).
- **Due vs pending at a glance:** every checklist on the board carries a status
  chip — gray "Due <date>", red "Overdue — was due <date>", or amber
  "Pending — <reason>" when any open step is flagged waiting (the waiting note,
  or who it's waiting on; hover shows all reasons). Collapsed client rows roll
  these up as "N pending" / "N overdue" chips, answering "what's still due,
  what's stuck, and why" without expanding anything.
- **Filters:** alongside the client filter, a **team-member filter** (only
  checklists assigned to the selected member(s)); both are multi-select and
  compose with search and the Report period. **"Show upcoming" now defaults
  OFF** — the board opens with real, materialized work only; tick it to overlay
  the faded upcoming (projected) items.
- **Scoping — whose work you see:** the standard board is **only the checklists
  you're active on** (as the task's assignee, or a viewer the owner named) — a
  bookkeeper sees hers, an accountant hers; the OWNER sees the whole board.
  Staff only ever see clients they're assigned to, as everywhere. The board is
  available to everyone, not owner-only.
- **"Show my bookkeepers'" (accountants):** a toggle beside "Show upcoming",
  offered only to an accountant who actually has people under her. Ticking it
  folds their checklists onto the board, each tagged with whose it is and faded
  so it never reads as your own; untick to go back to just yours. Their cards
  are read-only (the server enforces it too). With no supervisor field in the
  data, "the bookkeepers under her" means **the people doing live work on the
  clients she can see** — whoever holds the checklists and recurring tasks
  there; the same rule as the Clients list's open/late counts and the Completed
  tasks tab. **Owners are excluded everywhere**: the owner works clients herself
  but is not one of her accountant's bookkeepers, so her tasks never appear on
  the toggle's list, the board or the completed history. This is deliberately
  NOT the client's hand-picked team list, which gates invoices and money;
  nothing here widens it.
- **Filter by client:** a "Filter by client" dropdown in the board toolbar
  narrows the board to one or more selected clients (multi-select checkboxes);
  "Clear" (or no selection) shows all clients again. It only lists clients that
  currently have work on the board, and hides itself when there's ≤1.
- **Which column a checklist lands in:** its "Board column", set on the
  repeating template (or one-time task) and inherited by generated checklists;
  anything with none shows in "Uncategorized".
- **Setting the column later still fixes old tasks:** checklists generated
  BEFORE their repeating template got a Board column used to sit in
  "Uncategorized" forever; they now follow their template's current column
  automatically, so tagging the recipe is enough. A checklist you moved by hand
  keeps where you put it and is never pulled back.
- **Re-tagging an existing checklist:** open a checklist's Edit (the ⋯ menu on its
  card, on the board or the Checklists page) and pick a "Board column" (including
  "Uncategorized"). This moves it between columns — e.g. to pull an item out of
  the Uncategorized column into the right one — and the board updates immediately.
  Owner/creator edits apply directly; other authorized editors' changes route to
  the task's approver like any other task-details edit.
- **Managing columns (owner only):** "Manage columns" on the board lets the owner
  add, rename, reorder, or delete columns. Deleting a column doesn't delete its
  checklists — they move to "Uncategorized" until re-tagged.

## Delayed page (owner + staff)

- Every OPEN step flagged "waiting on", grouped by client, so you can see what's
  blocked and why. Staff see it scoped to their assigned clients. Clear the flag
  from the Checklists page (or under the client) once unblocked.
- **The list is now yours, not the whole firm's**: waits that are your move or
  that hold you up — the ones you are being waited on for, plus the ones you
  asked for or own the step for. Marking your part done moves it off your list
  onto the asker's to confirm; confirming takes it off theirs. This applies to
  owners too, so a firm-wide "everything stuck anywhere" view is no longer on
  this page.
- **Leaving this page is not disappearing.** A confirmed wait drops off
  everyone's Delayed list and stays on its checklist step as a completed,
  struck-through sub-item naming who asked, who did it and who confirmed it
  (see Checklists): this page is what's still stuck; the step keeps the history.
- An older free-text wait with nobody attached still shows to the step's
  assignee (or to everyone if the step has none), so nothing predating the
  two-step hand-off silently vanishes from the page.
- **Two tabs: "Waiting on me" and "I'm waiting on others."** Same underline tab
  bar as Time Approvals, with a live count in each label; the page opens on whichever
  has work (clicking the quiet one sticks — it won't bounce back).
  - **Waiting on me** — someone is blocked on you. Each wait has two buttons.
    **Done** says "my part is finished": the wait leaves this list and goes back
    to whoever asked, who has the final say; it does NOT tick the checklist step
    off. **Question** (see Checklists) finishes nothing, so the item stays here
    and stays yours. (A wait on a client has no Question — no login.)
  - **I'm waiting on others** — waits you asked for (and waits on a client). While
    the other person hasn't finished, the row is a **read-only reminder**: no
    Done, no buttons, just what you're waiting on and why. Once they mark it done
    the row gains exactly two buttons, **Approve** and **Send back**.
  - One step can appear on both tabs at once with different waits on each — being
    owed something and owing something on the same step is normal.
- **Send back ("not approved")** works as described under Checklists: a
  required note, back to the other person's "Waiting on me" tab with a Done
  again, notified like the original request, nothing overwritten. You lose the
  two buttons until they re-report it finished.
- The step's own "Done" toggle survives on this page only for an OLD free-text
  wait, which has no wait record to resolve. A completed step drops off the list
  (done steps aren't shown).

## Clients (owner manages; staff see assigned)

- Client list: contact, billing type (Hourly / Monthly subscription / Annual),
  rate, assigned team, plans/services. The assigned team shown comes from one
  stored field — for a client whose team had drifted between the two old
  representations, this column changes to match who can actually see it.
- Add client: a "+" Add client button in the top-right of the page header
  (opposite the "Clients" title, above the search bar; owner only) opens an
  Add-client modal. Fields: name, primary contact,
  billing type, monthly/annual rate (for subscription/annual clients), estimated
  monthly hours per role (informational only — never affects invoices), assigned
  bookkeeper(s), other contacts, plans/services. NOTE: there is no per-client hourly rate
  anymore — Hourly clients are billed off each team member's own bill rate (set
  on the Team page). **The team picked on this form can see the new client
  immediately** — it is the same assignment visibility reads, with no separate
  step of re-picking the team on the client's page. Right after saving, "Open
  their checklist now?" — yes jumps straight into the new client's checklist +
  notes modal. (Contacts and Plans have the same "+" add-in-a-modal flow.) The
  header (title + "+" + search) stays pinned as you scroll, so the add button
  is always reachable.
- **Primary contact is a real contact, chosen from the directory.** It used to
  be a free-text box that a later page load quietly turned into a bare contact
  record (no email, no phone) — so nothing was in Contacts right after saving,
  and a variant of a name already on file ("Britt" for "Brittany Ferguson")
  produced a second, emptier record. Now:
  - The field is a **picker of existing contacts**, plus **"+ Add a new
    contact…"** which opens name / email / phone right there in the form.
  - The contact is created and linked **the moment you save** — open Contacts
    straight after and it is there, with the email and phone you entered.
  - Typing a name that exactly matches an existing contact (same name AND email,
    ignoring case and spacing) **links that person instead of duplicating them**.
    Matching is deliberately exact: a near-match that silently attached a client
    to the wrong person would be worse than one extra record.
  - The primary contact is simply the FIRST of the client's linked contacts —
    not a separate field. The chip list below it is therefore labeled **"Other
    contacts"**, and the primary is merged in ahead of them on save.
  - Archived contacts are hidden from the picker, as everywhere else.
  - The Add-client button stays disabled until a name, a primary contact, and at
    least one assigned employee are filled in, rather than doing nothing on click.
- Client detail page (owner): everything about one client, in four TABS
  instead of one long scroll — **Overview** (client name, contacts & address,
  assigned team, logo, notes), **Billing** (rate and services, plan checklists,
  recurring reimbursements, expenses & reimbursements, invoice customization),
  **Checklists** (active, recurring and recent checklists), and **Time** (this
  client's time entries). Overview opens by default. The Checklists tab shows
  the open-checklist count and the Time tab this month's entry count. The tab is
  in the URL (`?tab=time`), so a page can be linked straight to a tab, and older
  `#client-section-…` links open whichever tab now holds that section.
- **Client detail → Billing → "+ Add package"**, next to "+ Add plan /
  service", lists the packages (built on the Plans page, Packages tab) and
  applies one to this client in a single press: its plans are added to the
  client's selected services and its checklists set up for them.
  - First, a confirm names exactly what will change — plans added, checklists
    created, ones skipped as already set up here, and the line that matters
    most: **nothing on the invoice changes — plans are labels; the monthly rate
    stays as it is.**
  - It is safe to press twice: plans already on the client are not re-added and
    a checklist already set up from that blueprint is skipped, so re-applying
    fills gaps without duplicates. The result is reported inline ("2 plans
    added, 3 checklists created, 1 already set up and skipped").
  - Each new checklist starts from the day it is set up — no back-dated tasks
    for the weeks before it (the same rule as "Set up plan checklists").
  - The button is not offered for a **billing master** (it holds no work of its
    own) or for a **retired** client (the app stops offering retired clients for
    new work), and the server refuses both as well.
- **Client detail → Billing → Hourly rates (Hourly clients, owner only).** Lists
  what this client is billed for each team member's time — everyone whose
  bill rate has started by that month, not only the client's assigned team — at
  the rates the client is on from its rate month. After a move to a future
  month those are the upcoming rates; this month's invoice still prices at the
  earlier rate month until the new one starts. Underneath: the **rate month**
  and how long ago it was ("Rates from June 2026 — 3 months ago", or "this
  month"), so a client overdue a rate review is visible at a glance. Hourly
  clients that existed when rate history arrived are on June 2026; a new client
  (or one switched to Hourly) starts on the current month's rates
  automatically. A client with no rate month on file yet reads **"Current rates
  (not pinned)"** and shows today's rates.
  - **Move to current rates from (month)** — defaulting to next month — puts
    the client on that month's rates from that month on; earlier months keep
    billing at the old ones. A move to a future month reads "Rates from October
    2026 — starts in 1 month".
  - Every move is kept: **"Rate month history"** lists each one as "June 2026 →
    September 2026" with the date it was made.
  - A later move REPLACES an earlier one it overlaps. Moving to a month that
    has not started yet and then moving again (a correction — say October,
    then November, both chosen in September) means the first move never took
    effect: October still bills at the old rates. Moving back to the earlier
    month undoes the move for every month. Moving to an earlier month than
    the current one (say, in November, back to September) reprices every
    month from then on whose invoice has not been generated yet.
  - Saving a bill rate on the Team page never moves a client's rate month, but
    can still change what the client bills: which clients a saved rate
    reaches, and the exception for a person's FIRST rate, are under Team →
    Bill rate. To leave a client alone, date the raise after its rate month.
  - Monthly and Annual clients show nothing here — they bill a fee, not a
    person's rate.
- Client detail → Time tab: everything logged against this client — who logged
  it, the notes, the clock-in → clock-out times, exact hours and minutes,
  billable/internal, and the approval status (Pending / Approved / Rejected,
  with the send-back note). A strip on top shows this month's tracked hours,
  billable hours, and entry count. The latest 12 entries show first with a
  "Show all N entries" expansion; the list scrolls in its own box. A **Track
  time** button starts the shared timer for this client without leaving the page
  (same modal as the client list's "Time" button). The entries themselves are
  read-only here — editing, splitting, and resubmitting still happen on the Time
  page. Staff see only the entries their own scoped data contains.
- Client detail page (staff): assigned bookkeepers/accountants can open their
  assigned clients in a scoped view — client name + contacts (read-only), active
  & recurring checklists, recent work, notes, and the Time tab for their own
  entries — with the same tabs MINUS Billing (all of it is owner-only; a
  `?tab=billing` link opens Overview for them). Owner-only sections (billing
  rates, plan checklists, reimbursements/expenses, branding, invoice settings,
  assigned team) and the Delete-client action are hidden, and financial fields
  are stripped from their data server-side.
- Client notes: a timestamped, attributed notes log on each client. The owner
  and the client's assigned staff can read and add notes; you can delete your
  own note (the owner can delete any). Notes support lightweight rich text
  (bold, italic, bullet/numbered lists, links) via a small formatting toolbar.
  Notes persist independently of the bulk autosave so staff can add them.
- Quick access from the client LIST: each row has a "Checklist" button that
  opens a modal with that client's active (editable) checklists plus the notes
  panel (add + history) — no need to open the client. It is tinted green for
  clients with active checklists. **Beside it, each row shows the client's open
  task count and — only when there is one — a "late" count** ("2 open · 1
  late"). The late count is a SUBSET of the open count: "2 open · 1 late" means
  one of those two is past due, not three tasks. A task counts as late if its
  due date has passed, including when an unfinished STEP inside it is due
  earlier than the task — the same rule as the Checklists page's "Overdue"
  section, so the two never disagree. A client with nothing open shows no
  counts. Next to it, "Note" opens a notes-only modal (add + history). A third
  "Time" button opens a TRACK-TIME modal for that client without leaving the
  list: this month's logged time for them, a task and a note, and the shared
  timer. Both boxes may be left blank to start right away — task and detail are
  required only at Stop & log, and can be filled in on the Time page while it
  runs. It is the same timer the Time page drives, so it keeps running as you
  navigate and stops there as usual; only one timer runs at a time, so if one
  is going the modal says so and offers the Time page instead. All three buttons
  work for owners and assigned staff (bookkeepers / accountants) on any client
  they can see.
  - The "Time" modal's TASK box is pick-or-type like the Time page's: that
    client's open tasks AND every STANDARD task in the workspace, de-duplicated
    by name with the client's real task winning a tie, plus anything typed,
    used exactly as typed. One of the client's own open tasks attaches the entry
    to that real checklist; a standard task or typed name is stored as the
    entry's free-text task name (the field used when a client has no open task),
    so it shows in the task column on reports instead of being lost in the
    notes. An empty box means no task.
- The client's "Active checklists" section has a "Due this month" toggle that
  filters to checklists due in the current calendar month (with a count).
- Client lifecycle / onboarding (owner): every client has a stage —
  Proposal → Onboarding → Active (existing clients are Active). The Clients list
  has stage tabs (Active · Onboarding · Proposal · All, defaulting to Active, with
  counts) and each row shows a stage badge. "Start onboarding" builds a 3-stage
  onboarding checklist (Proposal / Onboarding / Client) and moves the client to
  Proposal; it shows only on clients not yet Active (an Active client is already
  onboarded). As the team completes each stage the client advances
  automatically (Proposal → Onboarding → Active). The owner can also set a
  stage directly, and add new clients straight into any stage (defaults to
  Active). Staff see the badge but don't manage stages.
- Inactive clients (owner): a client who has left is retired rather than
  deleted. "Mark inactive" — on each client row and on the client's own page
  (next to Delete) — asks for confirmation naming exactly what changes and sets
  the stage to Inactive; "Reactivate", in the same two places, puts them
  straight back to Active. Both are written to the activity log.
  - What an inactive client is hidden from: the Clients list (they move to
    the "Inactive" tab, with a count, and are gone from Active/Onboarding/
    Proposal — "All" still shows them); the staff Clients list entirely; the
    time-tracking client pickers (timer, group timer, manual entry, the
    split-across-clients list, the Track time modal, and the client dropdown
    when editing an entry); the "For which client" picker when creating a task
    or recurring checklist; template copy targets; the Team page's "+ Add
    client"; the Invoices billing queue and its client picker; the **Client
    filter on the Checklists and Gantt pages** (a filter over work still
    outstanding, which a retired client has none of — if a saved link already
    names one, it stays in the list so the filter still reads correctly); the
    **repeating-task lists** on Checklists, whether or not anything is typed in
    the search box; and the Client Recap picker, which lists active clients only
    until you tick "Include inactive clients" on it.
  - What is NOT touched: every time entry, checklist, invoice, note,
    reimbursement, contact link, plan, and assigned-team member stays exactly
    as it was. Nothing is deleted, and reactivating restores the client with
    all of it intact — the stage flag is the only thing that changed.
  - What still shows them: reports and analytics for any period they have data
    in, timesheets, time approvals, the Board and Gantt filters, invoice
    history (including the monthly archive), and their own client page, which
    stays fully viewable across all tabs with an "Inactive" banner. Their
    Client Recap is still there too — it is one checkbox away, not gone.
  - What stops happening: their recurring checklists generate no new instances
    (existing ones stay open and visible, and generation resumes on
    reactivation), and the monthly invoice run skips them (existing invoices
    are untouched). The Start onboarding, Track time, Template and "Add
    recurring checklist" buttons are hidden while they are inactive. Inactive
    clients are not counted as a To-100% setup problem — retiring a client is
    an intended state, not an unfinished step.
- Assigned team is the list an OWNER picks: who works this account. Only an
  owner changes it, on the client's page or the Team page — being given a task
  on a client no longer adds anyone to it (it used to, which is why team lists
  had grown to include everyone who had ever held a checklist there). **This
  list is what decides who sees the client's invoices.**
- Seeing a client is wider than being on its team, on purpose: anyone assigned
  a checklist, a recurring template, or a template stage on a client can see
  that client's tasks and log time to it, whether or not they are on the team.
  Money is the one thing that follows the team alone.
- An owner can be listed on a client's assigned team too — it records who works
  the account, but grants the owner nothing extra: owners already see and can
  act on every client regardless of assignment.

## Client Recap (owner only)

- A per-client review page (sidebar: "Client Recap") with a **Monthly /
  Quarterly / Yearly** toggle and prev/next period navigation — the arrows step
  by whichever one is active, so Yearly moves 2026 → 2025. A quarter is three
  calendar months, a year is the calendar year (Jan 1 – Dec 31); nothing is
  fiscal or prorated.
- **The client picker lists active clients by default**, so the monthly round
  does not scroll past companies that have left. An "Include inactive clients"
  checkbox beside it puts them back, each marked "(inactive)", and their recap
  loads exactly as it always did. Unticking it while on a retired client
  returns you to the first active one.
- **The page reads plan against reality, top to bottom, in this order:** Time &
  hours, Billing, Profitability, the projected invoice, and **Tasks & workflow
  last**. Tasks used to sit second, above the money; it moved to the bottom
  because the recap is opened for the numbers.
- **The header names the client's billing type** — "Billing type: Hourly" /
  "Monthly subscription" / "Annual" — right under the page title, per her
  margin note. A billing master shows none: it has no mode of its own.
- **Time & hours is a table: ESTIMATE | ACTUAL | OVER/UNDER for hours, then
  COST ESTIMATE | COST ACTUAL | COST OVER/UNDER in dollars, one row per role,
  with a Total row.** The cost columns price the same rows: a role's estimated
  hours at its people's pay rate against the actual labor cost, with the
  variance colored the same way as hours (under plan is green — less was spent).
  A role with no estimate, or whose people have no pay rate on file, shows an
  em dash rather than a variance against zero; the labor-cost basis line prints
  under the table. It replaced four stat tiles (total hours, billable,
  administrative, vs. the prior period). Each row is named for the people who
  filled that role and tagged with the role, so it reads one person per line in
  the normal case. Rows are per ROLE because that is the grain the estimate is
  set at (Client page → Estimated monthly hours, per CFO / Accountant /
  Bookkeeper) — a role estimate is never split between two people on a guess;
  when several people share a role the row names all of them.
- **Everything in that table adds up by hand.** A role's Actual is its people's
  printed x.xx hours added together; the Total is the roles added together (and
  is the same figure as the client's total hours everywhere else); every
  Over/Under is that row's Actual minus that row's Estimate. When every role has
  an estimate, the Total's Over/Under is exactly the rows' Over/Unders added up.
  A role with hours but **no** estimate (em-dashed, not a variance against a
  zero nobody typed) still counts toward the Total — unplanned work is still
  over plan — and a line under the table says so.
- **Profitability is the same three columns, for profit:** Estimate | Actual |
  Over/Under, one row. The realized-rate and margin tiles are gone; **margin is
  now the Actual column** — the same revenue − labor cost figure it always was,
  standing next to the plan it is judged against. The definitions and the
  labor-cost basis print underneath.
- **Billing is three tiles: Estimated Invoice | Actual Invoice | Over/Under** —
  her relabel of the old revenue/rate/reimbursements tiles. Estimated Invoice
  is the expected service revenue (a monthly client's plan fee; an hourly
  client's estimated hours at bill rates); Actual Invoice is the same service
  revenue the Profitability panel measures against; Over/Under subtracts them,
  green when over (billed more than planned). Reimbursements are excluded from
  both sides and keep their own line and list under the tiles; the rate tile's
  job moved to the billing-type line in the header.
- **Ad hoc work counts toward the period's revenue at its default value** —
  what invoicing it would charge. The recap is computed from the time itself,
  not from a particular draft invoice, so it can't see a "show detail only" or
  "leave off" you set on one month's invoice (the same way it has never seen a
  line you hand-edited). It answers "what is this client's work worth", not
  "what was billed".
- **Labor cost counts team members who have a pay rate on file, owners
  included; time from anyone without a rate carries no hourly cost**, exactly
  as the payroll report and every other cost figure have always treated it.
  **Margin is now always a figure.** The recap used to withhold margin ("—")
  whenever anyone who logged time had no cost rate; since the owner had none
  and works on most clients, that blanked margin nearly everywhere (on August
  2026 data she had logged time on 31 of the 34 clients with any). An owner who
  sets a Cost rate on the Team page is costed exactly like anybody else, here
  and everywhere labor cost is computed; one who leaves it blank costs nothing,
  so a client she works alone shows its full fee as profit. The reason is
  printed under every cost and profit figure.
- **Every hours figure on the recap reads as x.xx** — the totals and each
  person's row. Those printed per-person hours are also what labor cost is
  priced from: pricing each person's shown hours at their cost rate and adding
  the results gives the recap's labor cost exactly (see "HOW LABOR COST IS
  CALCULATED" under Reports).
- **The role table is in a FIXED order that does not move month to month:**
  CFO tier first, then Accountant, then Bookkeeper, then anyone whose role isn't
  set; several people in one role read alphabetically inside the row. (It used
  to sort by hours, so it reshuffled every month.) The tier comes from the staff
  role: **Owner → CFO, Accountant → Accountant, Bookkeeper → Bookkeeper** (there
  is no separate "CFO" staff role; CFO names the owner's own tier, matching the
  client's estimated CFO hours field). A role nobody logged time in AND with no
  estimate doesn't appear — no zero row is invented — while a role that WAS
  estimated and never worked appears at 0.00h actual, which is how "we planned
  eight hours of CFO time and did none of it" gets caught. The roles present
  keep their order regardless.
- **Revenue here is the same number the invoice bills** — Recap and the invoice
  come from one shared calculator. It used to value an hourly client's time at
  the client's single hourly rate, though invoices have charged each team
  member's own bill rate since June 2026; on July 2026 data the two disagreed
  for 16 of 19 hourly clients, in both directions (one read $4,400.83 in Recap
  against a real invoice of $3,837.58, another $894.13 against $1,252.69). So
  **profit figures for hourly clients shifted, some up and some down** — the new
  numbers are the correct ones. Monthly and annual clients are unaffected. A
  quarter or a year is summed month by month, not estimated as a rate times
  three or twelve.
- **Estimated vs. actual** — the comparison that catches an overrun while it is
  still happening — has **no separate "Estimated vs. actual" panel** any more:
  hours live in Time & hours and profit in Profitability.
  - **Hours per role.** The client's Estimated monthly hours against hours
    worked, per role, over or under — e.g. a Bookkeeper estimated at 10 hours
    who worked 12 reads "+2.00h over". A **quarterly** recap multiplies the
    monthly estimates by 3 and a **yearly** one by 12, and the column header
    says which ("monthly estimates × 12 months").
  - **Profit** (owner only). Estimated profit = expected revenue − estimated
    cost (each role's estimated hours × that role's cost rate), where expected
    revenue is the client's monthly rate (monthly clients), a twelfth of the
    annual fee (annual clients), or the estimated hours at each role's bill rate
    (hourly clients). Actual profit = invoiced service revenue minus actual
    labor cost — the Billing and Profitability panels' figures, from the same
    calculators. Reimbursements are excluded from both sides. All of this is
    stated on screen under the figures.
  - **A role's cost/bill rate** comes from the people ASSIGNED to the client in
    that role, failing that from whoever logged time in it; several people at
    different rates are averaged, and the panel says so. A role whose people
    have no pay rate costs nothing on BOTH sides — it never makes the comparison
    unavailable. That is typically the owner's CFO role, but only while she
    leaves her Cost rate blank; once set, it prices like any other.
  - **"No estimate set" is a normal, honest state** — most clients have none.
    They show the actual side only and **no variance at all**; nothing is
    compared against a zero nobody entered. A slim banner at the top of Time &
    hours says so and points at Client page → Estimated monthly hours.
- **Projected end-of-month invoice** (owner only, monthly view only) — always
  labeled an Estimate, always with its basis printed underneath:
  - A monthly/annual (plan) client: the known, fixed plan amount plus the
    reimbursements recorded so far.
  - An hourly client: the billable work booked so far scaled by the business
    days elapsed — "projected from 12.00 billable hours over 10 of 21 business
    days" — plus reimbursements as recorded. Reimbursements are never
    extrapolated.
  - A month that has already ended shows the **actual** invoice, described as
    such, not a projection.
  - Quarterly and Yearly views show no projection: it is a month-shaped
    question.
- The recap's MONEY — billing, profitability, estimated profit and the
  projection — is **owner-only**: absent from a staff member's data entirely,
  not merely hidden on screen. **So are the estimates** (planning data set on
  the Client page, which staff do not manage): a staff payload gets the same
  role rows and ACTUAL hours with Estimate and Over/Under em-dashed, and no "go
  set them on the Client page" prompt, a dead end for someone who can't. In
  practice the whole page is owner-only anyway ("Client Recap" only appears in
  an owner's sidebar); the gate is defense in depth.
- **An HOURLY client's quarterly or yearly recap reconciles.** Every month in
  the period is priced at the **rate month that client was on at the time**
  (read back from its rate-month history), so a client moved to current rates
  in March has January and February priced at the old rates and the figure
  matches the invoices actually issued. (A month before June 2026 prices the
  way its invoice did, at the client's old single hourly rate.) Labor cost
  likewise uses each person's cost rate on the day they worked (see Team →
  Cost rate). A **Monthly or Annual** client still has a single live fee and a
  single plan list, so its multi-month revenue IS a restatement at today's
  numbers. The Billing panel says which applies whenever the period spans more
  than one month.
- **Sales tax stays monthly or quarterly.** The recap's sales-tax status is
  month-shaped (it reports one filing task), and recording sales-tax figures
  against a whole year is refused by the server — a year-keyed tax record would
  be a figure with no filing behind it.

## Contacts

- Shared contact directory: name, title, email, phone, notes. Import from CSV.
  Lockable (owner).
- Each contact shows the actual client NAMES it's linked to (clickable), and a
  "Not linked to any client" flag for contacts on no client (with an Unlinked
  filter to find them).
- Per-company email: a contact on multiple clients can have a client-specific
  email override; the base email is the default. The client's contact area and
  emails use the per-company address when set.
- Linked contacts: relate contacts to each other (symmetric — linking A to B
  links B to A).
- Groups: give a contact an optional Group name (e.g. "Smith Family") — pick an
  existing group or type a new one. The Contacts page groups the list under
  group headers BY DEFAULT (groups sorted alphabetically, members by name,
  ungrouped contacts in their own section last); a "Group by group" toggle flips
  to a flat, name-sorted list. Composes with search + the Unlinked filter.
- Archive: archive old/inactive contacts into an Archived section; archived
  contacts are hidden from the active directory and from client contact pickers.
  Unarchive to restore.

## Reports (owner only)

- Payroll hours report: total hours worked per team member over a WEEKLY or
  BI-WEEKLY period (toggle), independent of the billing month — for running
  payroll. Both use the app's Sun–Sat weeks (the weeks staff submit), so
  bi-weekly = two consecutive Sun–Sat weeks. A date picker + ‹ › (a full period
  per step) move the window; "This period" jumps to now. To line bi-weekly up
  with the firm's payroll cycle, set the start to a day in the pay period's
  first week — the cadence is then preserved.
  Table of each member's hours (billable/internal split + entry count) with a
  grand total.
- **Hours read as x.xx** ("20.22h", "1.00h", "0.50h") on the summary and the
  day-and-job detail alike, never one decimal: the old one-decimal rounding
  printed a few-minute split allocation as "0.0h", so hours appeared to vanish
  and the rows didn't add up to the total.
- **Every hours TOTAL is the sum of the rows shown above it**, not a rounding of
  the minutes behind them, so adding the Hours column by hand lands on the
  printed total: rows of 0.17h + 0.17h + 0.75h total 1.09h, though the
  underlying 10 + 10 + 45 minutes would round to 1.08h. This composes down the
  detail table (each day subtotal sums its rows; the grand total sums the day
  subtotals). Same rule on the Client Recap card (total and billable sum the
  by-staff list, and Total − vs-prior lands exactly on the printed delta) and in
  the assistant's hours summaries.
- **Hours is the costing column.** Cost is that figure × the pay rate — nothing
  else is needed to check it, except across a cost-rate change inside the
  period (see "HOW LABOR COST IS CALCULATED" below). An exact "Minutes" column
  used to sit between Hours and Billable to explain why the two would not
  multiply out; that gap is gone and so is the column.
- **Billable time, Billable $ and Cost appear on the PRINTED report**, not just
  on screen — on both the per-member summary and the day-and-job detail, with
  totals.
  - **Billable $** = billable hours × that person's BILL rate — what the work
    bills at (revenue). Each hour is priced at the person's rate for the RATE
    MONTH of the client it was worked for — the same figure that client's
    invoice carries — so a client still on older rates bills at those here and
    one moved to the current rates bills at these; a raise dated ahead reaches
    a client only once it is moved. The per-person figure adds up the rows at
    each rate, and the detail rows below split it, so the column ties.
  - **Cost** = ALL hours worked × that person's COST rate — what the firm pays
    for the time. It deliberately covers internal hours too, not just billable
    ones, because the firm pays for those as well. Set a person's cost rate on
    the Team page ("$/hour — for margin reports only, never billed").
  - Side by side, the two columns give margin per person and per day.
  - **An OWNER's Cost is whatever her own cost rate says** (Team page, like
    everyone else): an owner who wants her hours in the firm's labor cost (to
    budget against) enters a rate and is costed from it here. One who leaves it
    blank shows "—" and adds nothing — a finished answer, not a missing setting
    — and the Cost total is then the firm's STAFF labor cost.
  - Anyone with no rate configured shows "—" rather than "$0.00", so an unset
    rate never reads as "billed nothing" or "cost nothing".
- **HOW BILLABLE HOURS ARE PRICED ON INVOICES — changed 2026-09-01, her call.**
  An hourly line charges exactly the two-decimal hours it prints, times the
  rate: "0.05h at $125.00/hr" is $6.25, to the penny, every time. A person's
  billed hours are the sum of their entries' two-decimal hours — the same
  figure the Client Recap's roles table and the payroll report show — so the
  recap's Actual Invoice matches its own hours table. (Invoices used to charge
  the raw clock time underneath while printing rounded hours, so
  hand-multiplying a line never quite landed — the "math is not mathing" she
  reported.) Ad hoc lines follow the same rule. Only newly generated invoices
  price this way: already-issued ones are untouched, and lines from before the
  change keep their stored amounts even when edited.
- **THE HOURS ON AN HOURLY LINE ARE EDITABLE, AND THE AMOUNT FOLLOWS.** In the
  month run's editor each hourly line shows its hours in a small "Hours" box
  with the rate beside it. Change the hours — round 1.31 up to 1.5 for a
  rounder bill — and the amount recalculates as hours × rate; the amount box
  does not accept typing on these lines. The printed invoice shows the hours
  you chose. There is NO automatic rounding: nothing rounds unless you round it.
- **HOW LABOR COST IS CALCULATED — the rule, on every surface. Labor cost = the
  two-decimal hours shown × the cost rate: round the hours FIRST, then
  multiply.** In the firm owner's own words, verbatim: *"I pay by the minute so
  if someone works 20 hours and 13.4 minutes rounded to the 2nd decimal then I
  would pay 20.22 times her cost and that time because the staple for all
  comparisons"*. So 20h 13.4m at a $16 cost rate is 20.22 × 16 = **$323.52**.
  - **Per person, per period, off the ROWS the report prints.** Round EACH of
    that person's entries for the period to two-decimal hours and add them up —
    that sum is the report's Hours figure — then multiply by their cost rate and
    settle the cent. Across a cost-rate change inside the period, each side's
    rows are summed and priced at their own rate and the two amounts added. A
    cost TOTAL is the sum of the per-person amounts.
  - **Why each row and not the period's raw minutes:** the two are not the same
    number, and the money used to be built from the raw minutes while the report
    printed the rows. On the 8/8–8/22 run, Allison's 31 rows added to 14.75h
    where her raw minutes rounded to 14.78h, and Lisa's 63 rows added to 22.61h
    where hers rounded to 22.59h — one person's cost read HIGH and the other's
    LOW against the column above it. The figure on the page is the one that gets
    multiplied.
  - The two consequences that matter, and the whole reason for the rule:
    **multiplying a visible Hours cell by the pay rate gives the Cost cell
    beside it**, and **adding up the visible Cost column lands exactly on the
    total printed underneath it.** A line under the summary totals says so. The
    one exception to the first: for a person whose cost rate changed inside the
    period, a single Hours × rate check on their summary row will not match;
    their day-level rows, which each carry one rate, do.
  - It is the same rule EVERYWHERE — payroll Hours report (summary, detail and
    all three exports), the Employee report, the Client Recap's labor cost and
    margin, estimated-vs-actual cost, and the assistant's client profitability
    and margin answers. They all call the same calculator, so no two surfaces
    round differently (which RATE a figure uses is covered below).
  - **BILLABLE $ follows the identical rule**, with the bill rate in place of
    the cost rate: the billable-hours figure shown × that person's bill rate.
    Multiply the Billable hours cell by hand and you get the Billable $ cell.
    Per-entry Billable $ cells are that period total split across the person's
    own rows, exactly as the Cost cells are, so that column adds up too.
  - **It changed on 2026-08-19 and was corrected again on 2026-08-26.** Before
    08-19, cost was computed from exact seconds and rounded once at the end — a
    defensible rule, and not the one the firm pays by: it made the printed Hours
    column un-multipliable, so reports carried an exact-minutes column to
    explain a few cents of drift. On 08-26 the rule was right and the call
    sites were not: the money was priced off the period's re-rounded raw minutes
    while the Hours column showed the sum of the rows. Cost, Billable $ and the
    hours beside them now all come from the same figure, on the payroll
    summary, the day-and-job detail, the Employee report and every export. Each
    change moved figures (typically) by a few cents to a couple of dimes per
    person per period, in either direction (across the whole firm for August 2026, the
    08-26 fix moved total labor cost by $1.52); the 08-19 difference is because
    the RULE changed, not because anything was wrong before. Nothing stored
    changed either time — every report, past and present, recomputes under the
    current rule.
  - **Per-ENTRY Cost cells** in the day-and-job detail table and the "Raw
    hours" export are that person's pay for the PERIOD split across their own
    entries, so **the Cost column adds up to the total under it exactly**. A
    row cannot both be priced on its own hours and add up to what the person is
    paid — the per-row rounding reaches dollars over a month of entries — and
    the total is the half that has to be right. In practice a row still lands
    within a few cents of its own hours × rate, and closer the more entries
    there are; a muted note under the detail totals says so on the page. A
    full-mode repeat shows no cost, on screen and in the export alike (the firm
    pays for the block once).
  - **WHICH cost rate, now that rates are dated.** Every cost figure on the
    payroll and Employee reports — per-entry Cost cells and the "Raw hours"
    export, each person's PERIOD Cost (the payroll summary's Cost column, the
    Summary CSV, the Employee report's Cost and its CSV), and every total under
    them — uses the cost rate the person was paid on the DAY each entry was
    worked. So the summary, the detail and their totals always agree: a raise
    mid-period shows up only in the rows it landed on, and hours worked before
    it are never paid at the new rate.
  - **Anyone with no cost rate** reads "—" on their rows and contributes
    nothing to any cost total — a correct, finished state, not a gap. Owners
    too: one who has entered a Cost rate on the Team page is priced from it,
    one who has not keeps the em dash.
- Payroll report detail — "Time by day and job": below the per-member summary,
  the same period day by day. **EVERY TIME ENTRY IS LISTED INDIVIDUALLY** —
  never merged for sharing a day, client or task. Each row shows the job (the
  client billed; '(Admin)' for non-client time), team member, task, CLOCK IN,
  CLOCK OUT, session count, hours, billable hours, Billable $ and Cost. Rows sit
  under their day's header with that day's total, in clock-in order (minutes-
  only entries, with no timestamps, come last with "—" for the stamps). A "Team
  member" filter scopes the detail to one person (payroll is usually run per
  person) or all.
- **Group splits made in "full" mode count ONCE toward payroll hours and cost.**
  Full mode deliberately bills every client on the split the WHOLE block (a
  1-hour block across 3 clients is 3 billable hours — the intended billing), but
  the person worked, and the firm pays for, one hour, so tracked hours, day
  subtotals, grand totals and Cost count the block once. Every slice still
  appears as its own row and counts toward Billable / Billable $; the repeated
  rows carry a muted "full block · counted once" note (and no Cost) so the
  subtotal explains itself. Even and custom splits carve the block up and count
  normally.
- Payroll exports (three): "Summary CSV" (per-member totals), "By day & job
  (summary)" (Date, Team member, Job, Task, Hours, Billable hours — the
  COLLAPSED breakdown, ready to pivot; the on-screen table is per-entry), and
  "Raw hours" (one row per time entry, scoped to the pay period and member
  filter).
- Both RAW exports carry "Billable hours" and "Billable $", and payroll "Raw
  hours" also "Cost" — matching the printed report, blank rather than 0.00 when
  the person has no rate set.
- **The payroll exports price Cost off the Hours column they carry**, so a
  spreadsheet can re-derive it with one multiplication. "Summary CSV" is
  Employee, Tracked hours, Billable hours, Internal hours, Entries, Cost — the
  original five keep their names and positions, with Cost appended. The
  "Tracked minutes (exact)" / "Tracked hours (4dp)" columns (and "Minutes
  (exact)" / "Hours (4dp)" on "Raw hours") existed only to reconcile a cost the
  printed hours could not reproduce, and were REMOVED on 2026-08-19 when that
  stopped being true.
- Both RAW exports (payroll "Raw hours" and the monthly "Hours by month") include
  CLOCK IN and CLOCK OUT stamps plus a Sessions count, so hours can be audited
  against when the work actually happened: clock in = the first start, clock out
  = the last stop, and Sessions > 1 marks a day split across several stretches.
  Entries logged as minutes only (no timer/manual timestamps) leave them blank.
- Month summary: tracked hours, internal hours, billable mix, projected
  billing (each hourly client priced at its pinned rate month, as its invoice
  would be), employee coverage.
- Employee report (hours by person, including billable $ = each person's
  billable hours, each at their bill rate for that client's rate month — the
  same figure the invoice and the payroll Billable $ above carry — and **Cost** = their tracked
  hours, each at the COST rate in force on the day it was worked, so it matches
  the payroll report; owners are included) and Client report (hours by
  client), each with Download CSV. Print-friendly output — the Cost column is on the printed
  employee table and in its CSV, matching the payroll tables: "—" (never
  "$0.00") for anyone with no cost rate on file, owners included — and an owner
  who has set one is costed like everybody else.
- Hours by month: a raw, line-by-line CSV export of every time entry in the
  selected period (Date, Employee, Client, Task, Hours, Billable, Description),
  sorted by date — for month-by-month detail / external bookkeeping.

## Productivity (owner only)

- Throughput by person (tasks completed, avg items/day) over a chosen range,
  daily or weekly; Download CSV.
- Activity heatmap: hours, items completed, cases moved per day/week.
  Hover a cell for exact numbers.

## Gantt (owner + staff)

- One bar per active checklist, grouped by assignee, on a month timeline:
  not started / in progress / completed / overdue colors, milestone diamonds
  for due dates. Click a row to open the underlying checklist. Filter by
  assignee, client, status. Staff see it scoped to their assigned clients; the
  owner sees the whole firm.
- "Show upcoming" toggle: overlays projected future recurring instances (within
  the Report period) as faded, dashed, non-interactive bars marked "Upcoming" —
  a read-only preview that creates nothing.

## Invoices (owner only)

> **The monthly run is live.** At the top of the Invoices page: pick a month,
> press **Generate**, and the app builds one numbered draft invoice per client
> with something to bill — lines, a due date, any prior-month adjustment
> carried forward, and out-of-scope flags.
>
> **The client is asked to pay on receipt. The due date the app records is the
> firm's own.** The invoice and email say **"Due on receipt"** and show no date.
> The app stores a date **30 days after the invoice is first SENT** — the
> firm's internal past-due line, after which an invoice counts as late and gets
> chased. It appears only in the month run (hovering it says so), nowhere the
> client can see.
>
> Generating the month stamps a **provisional** date (30 days from the day the
> draft was built); the first send replaces it with 30 days from the day the
> email actually went out. That matters when a run is built early: September's
> invoices were generated on the 15th to be emailed on October 1, and would
> otherwise have gone past due two weeks before the client saw the bill.
> **Sending an invoice AGAIN never moves the line** — chasing a client does not
> buy them another thirty days.
>
> **The exception is a client whose own payment terms name a LONGER window.**
> "Net 45" on a client's record means 45 days: the invoice prints their own
> wording and due date — the window they were promised — and the first send
> re-stamps 45 days from sending, not 30, so date and wording always agree.
> Terms that are shorter ("Net 15"), ask for payment now ("Due on receipt",
> "Due on Demand"), or are blank all produce an invoice that asks for payment
> on receipt and is chased after 30 days.
>
> **Moving between months:** back and forward arrows flank the month picker —
> one press steps the run one month and the list reloads, no calendar popup.
> The picker still jumps straight to a distant month. Stepping with unsaved
> edits in an open invoice asks before discarding them, same as the picker.
>
> **The month's invoices are grouped into status tabs** — **To review**,
> **Reviewed**, **Sent**, **Past due**, **Payment failed**, **Paid**, **Voided**
> — so you work one group at a time. Sent and Processing both live under
> **Sent** (each row still shows its own status). **Past due** and **Payment
> failed** are DERIVED tabs, not statuses: an invoice in either is still Sent
> underneath and still owed, worked out fresh every time the page is drawn, so
> nothing can go stale. (Nothing ever writes an "Overdue" status — being late
> is a fact about today's date, not a state.) All seven tabs show their counts
> at once, so you see the shape of the month without opening anything; an
> empty tab is dimmed but still there.
>
> **Past due** is the chase list: invoices that have gone out, are still owed,
> and whose 30-day line has passed. The row carries a red **Past due · N days**
> flag (hovering names the line, e.g. "Past-due line was October 15, 2026"),
> and the count sits in the strip above beside Need a look. An invoice due
> TODAY is not past due — the client has the day. Opening one says what to do:
> **Send again** to nudge them (a fresh pay link rides along; it does not move
> the line, so the invoice stays here until paid), or **Mark paid** if it was
> settled another way. An invoice both past due AND with a failed payment shows
> under **Payment failed** only — the more actionable of the two; nothing is
> chased from two lists. Every owner is notified once per invoice (bell +
> email) the first time it passes the line, never repeated.
>
> **Payment failed** is the follow-up list: the client tried to pay and it did
> not go through — most often a bank account entered by hand and never
> verified within Stripe's 10-day microdeposit window, or a debit their bank
> returned. These are still **Sent** and still owed (nothing was collected);
> they sit here so the client who tried and stalled is not lost among those
> who have not opened their email. The row shows a red **Payment failed
> [date]** flag, and opening it shows Stripe's reason and what to do: a
> bank-payment link is spent once the attempt fails (a card link may still
> work), so follow up with the client and **Send again** — the re-send carries
> a fresh link and moves the invoice back to Sent — or **Mark paid** if they
> pay another way. Every owner is notified (bell + email) the moment a payment
> fails, naming the invoice, the client and the reason.
>
> Within a tab invoices are **alphabetical by client by default**, with a Sort
> control for invoice-number order or total (high to low); rows never
> rearrange while you work through them. Marking one reviewed, sending or
> voiding it just moves it out of the tab you are on (its new tab's count goes
> up) — you are not dragged along after it.
>
> **Search the month:** a search box above the tabs narrows every tab to
> invoices matching a client name or invoice number, with an "N of M" count.
> The stat strip stays whole-month while you search, and an invoice open for
> editing never disappears because of what was typed. History has the same
> search box, composing with its Year / Client / Status filters, and its month
> tables also open alphabetical by client (click a column header to re-sort).
>
> Above the tabs are the counts for To review / Reviewed / Need a look / Past
> due and the month total (Past due turns amber when there is anything in it).
> Rows flagged for a second look get an amber rule down the left and keep their
> place in number order, so they can turn up in any tab — a small amber dot on
> a tab means some are in there. Switching tabs with unsaved edits in an open
> invoice asks before discarding them.
>
> **AI confidence rating (advisory).** After Generate, an AI reviewer rates each
> monthly draft's accuracy — a badge on the row says **high confidence**,
> **check N things**, or **low confidence**. It checks the arithmetic (printed
> hours times each person's bill rate, reconciled against the month's tracked
> time), plan-vs-hourly consistency, covered-date windows, ad hoc dispositions,
> whether descriptions name the right month, and how the invoice compares to
> last month's. Open the invoice to see its summary, specific concerns, and up
> to three questions it would ask you. THE RATING IS ADVISORY ONLY — IT NEVER
> BLOCKS, CHANGES, OR SENDS ANYTHING, AND IT NEVER TOUCHES THE NUMBERS. An
> unrated or low-confidence invoice can be reviewed and sent exactly as before.
> Each rating fills in on its own a few seconds after generation; **Re-rate**
> refreshes one after edits, and the card says if you edited since it was
> rated. Retainer invoices are not rated (one manual line, nothing to check);
> invoices from before this feature have no badge.
>
> **The AI's questions (skippable).** Clicking **Mark reviewed** on an invoice
> whose rating has unanswered questions shows them once more with answer boxes
> — **Answer & approve** or **Skip & approve**; approval is never held up.
> Answers are remembered and make future ratings smarter about how you like
> invoices done; skipping costs nothing. Questions can also be answered any
> time from the open invoice.
>
> Click any row to edit it: change a line's wording or amount, add or remove
> lines, write the note to the client, then **Print** it or **Mark reviewed**.
> Print produces the SAME printed invoice the per-client view has always
> produced — one format, not two — from the stored lines, not a recalculation.
> Print is disabled while there are unsaved edits, so you can never print
> something different from what is stored. Reviewed can go **Back to draft**.
> **Void** keeps the invoice on the record, struck through, and frees that
> client to be generated again.
>
> **What the client's invoice looks like (redesigned September 2026, to
> Brittany's marked-up sample).** The printed invoice, the emailed PDF and the
> email body share one layout: charges split into three titled sections, each
> with its own total — **Subscription Plan** ("Total Subscription Plan"),
> **Ad-Hoc / Billable Hours** ("Total Ad-Hoc/Billable Hours"), and **Client
> Reimbursed Expenses** ("Total Client Reimbursed Expenses") — then the
> invoice's Total due. An empty section is left out, so an hourly client's
> invoice has no Subscription Plan section. Inside the hours section lines are
> grouped under **CFO / Advisory Services**, **Accounting Services**, and
> **Bookkeeping Services** by who did the work (owner → CFO / Advisory;
> accountant → Accounting; bookkeeper → Bookkeeping); each line still shows its
> own hours, rate and amount, so the math can be checked by hand. THE SECTION
> TOTALS ALWAYS ADD UP TO WHAT THE INVOICE BILLED BEFORE THE REDESIGN — the
> regrouping changed how charges are arranged, never what they are. The header
> reads **Invoice no.**, **Invoice Date**, and **Billing Period: Month Year**
> (the old "Issued" label is gone), the letterhead no longer carries the firm
> tagline, and the closing line is "Spread success, not stress, thanks for
> choosing PB&J Strategic Accounting." unless the client has its own footer
> note. If a client's **time breakdown** is on, the detailed hours print as a
> separate **page 2** headed "Detailed Hours" (off — the default — the invoice
> stays one page). A billing master's combined invoice is unaffected: still one
> combined line and no sections, headings or company names, as the client
> chose. The payment-terms line and the **Due** field both say **on receipt**,
> unless the client's own terms name a longer window, in which case their
> wording and due date print instead.
>
> **MARK PAID — for money that arrived outside the app.** A check, a direct
> transfer nobody linked, an invoice never sent through the system: open it in
> the month run and press **Mark paid**. It works on Draft, Reviewed and Sent
> invoices (a past-due one is still Sent underneath); it is NOT offered while a
> bank payment is **going through** (a real debit is settling — let it finish,
> or the two answers would race). Marking paid records the date, locks the
> invoice like any paid invoice, and **kills any payment links already emailed
> for it** so a client cannot pay twice with an old button. Who marked it and
> when is kept on the record.
>
> **Verify with Stripe** appears on invoices whose payment is still shown as
> going through. It asks Stripe whether the payment settled and records only
> Stripe's answer: settled moves the invoice to Paid with the real charge time;
> still-settling changes nothing and the button says so. It fixes a payment
> that completed on Stripe but never flipped here (a lost or out-of-order
> webhook) — no guessing, no manual override on a live payment.
>
> **Verify all with Stripe** — the same check as one sweep, in the month run's
> action row (always there, next to Download for QBO): EVERY invoice in any
> month whose payment is still shown as going through is checked independently
> against Stripe in one press, and only Stripe's answers are recorded. The
> result is a plain sentence — how many were confirmed paid (named by invoice
> number), how many are genuinely still settling, how many could not be
> checked; with nothing holding it just says so. Use it when payments look
> stuck rather than checking invoices one at a time.
>
> **Undo manual payment** appears only on invoices marked paid BY HAND — press
> it and the invoice returns to Sent (or Reviewed if it was never sent),
> editable and collectible again. An invoice a real payment settled has no such
> button: money that actually moved stays recorded exactly as it moved.
>
> **ONCE AN INVOICE IS PAID IT IS LOCKED**, so it keeps matching what the client
> actually paid: lines and note go read-only, **Save changes**, **Add a line**
> and the remove buttons are gone, and a gray line at the top says why. The same
> lock applies while a payment is still **going through** (an ACH debit can take
> a few days to settle) — the invoice the client authorized must not move
> mid-payment. Nothing lifts it: a paid invoice cannot go **Back to draft**
> either.
>
> **Void is the way out.** If a paid invoice turns out to be wrong, void it and
> issue a new one. That is deliberate — a void stays on the record where you and
> the client can both see it happened, and a silent edit would not.
>
> Invoices that have been **sent but not paid** are still fully editable. Nobody
> has paid those yet, and fixing one before they do is ordinary work.
>
> This also keeps a **retainer credit** honest: a retainer must be paid before
> it can be credited to a final invoice, and a paid invoice's total can no
> longer change, so the credit can never drift from the money that came in.
>
> **AD HOC WORK IS SHOWN SEPARATELY, AND YOU DECIDE WHAT TO DO WITH EACH
> PIECE.** Time flagged "Ad hoc" on the Time page (see Time tracking) does not
> disappear into "Billable hours — <name>": it gets its own block on the draft,
> headed **"Ad hoc — outside scope"**, one line per piece of work — `Adhoc —
> <what was done>`, with the day, who did it, and the hours at their rate
> underneath. Each line carries a dropdown with three answers:
>
> - **Invoice it** (the default) — an ordinary charge at that person's rate. You
>   can overtype the amount like any other line.
> - **Show detail only ($0.00)** — the line still appears on the client's
>   invoice, at no charge, so they can see the work was done and not billed. No
>   reason or explanation is asked for.
> - **Leave off the invoice** — the client never sees it. The line stays on your
>   draft at $0.00 so you can put it back; changing your mind restores the
>   amount it was holding.
>
> On the two you're not charging, the row reads $0.00 (which is what the client
> will see) with **"would be $X"** beside the dropdown, so you can see what
> you're giving away without switching back to look.
>
> The choice flows through everything — the month total, the printed invoice,
> the PDF and the emailed invoice all read the same lines. Courtesy lines print
> at $0.00; omitted lines are not printed (and are left out of the QBO export —
> a courtesy line is exported, since it IS on their invoice).
>
> **A piece of time is billed exactly once.** An ad hoc entry is either an ad hoc
> line or part of the ordinary hours — never both — so flagging time can add a
> charge or move one, but it can never double it.
>
> Ad hoc applies to **hourly clients** from June 2026 onward. Flat-fee
> (subscription / annual) clients are unaffected for now: their billable hours
> are covered by the fee, so flagged time there is recorded but not charged.
> Regenerating a month rebuilds the ad hoc lines from current data, discarding
> the choices made on them like any other edit.
>
> **THE HOURS BEHIND THE INVOICE SIT BESIDE IT, AND YOU CAN RE-TAG THEM
> THERE.** An invoice opened in the month run shows a **Hours this period**
> panel next to the lines (beside them on a wide screen, below on a narrow one):
> every time entry for the invoice's month and client, grouped by team member,
> with Date, Description, Task and Hours; each member's heading carries their
> in-scope, ad hoc and out-of-scope subtotals. On a billing master rows group by
> company first, then person.
>
> Each row's dropdown — **In scope**, **Out of scope**, **Ad hoc** — shows the
> tag the entry ALREADY has from logging or review, so this is an override, not
> a fresh decision. **Ad hoc** offers the same three options as the ad hoc block
> above (Invoice it / Show detail only / Leave off the invoice), and billed ad
> hoc work is charged at that person's bill rate for the client's rate month
> — on a billing master, each company's own rate month, exactly as Generate
> priced the hours beside it. It is the last catch
> before an invoice goes out: out-of-scope or one-off work that slipped into
> the ordinary hours can be moved without leaving the invoice.
>
> **Nothing happens until you press Save.** Tags stage up, marked **"Will apply
> on save"**, and the running total under the lines shows what the invoice will
> come to. One Save writes the lines and the re-tagged entries together, so the
> invoice can never bill work the entries disagree about; until then Print, Send
> and the payment link wait behind "Save your changes first", as with any typed
> edit. Re-tagging never changes an entry's approval — approval is about whether
> the record of the work is right; the tag is about how it bills.
>
> **Out of scope travels beyond this invoice:** it marks the time non-billable
> everywhere, reports and analytics included. To keep the hours billable but off
> this one invoice, use **Ad hoc → Leave off the invoice** instead.
>
> **When the lines have been renamed, the tag saves but the money does not
> move.** The panel can only shift hours between lines that carry their own
> hours and rate — the "Billable hours — <name>" lines Generate writes. Once a
> line is retyped ("Bookkeeping Services", "CFO/Advisory Services", "For
> services rendered for the month of") there is no telling which of them holds
> a given entry, so the app refuses to add a charge it cannot also subtract
> (that would bill the work twice). The row says so — *"The tag stands, but
> these hours are on a renamed line — adjust the invoice line yourself"* — the
> tag is still recorded, and the line is edited by hand. **That warning stays
> on the row after the save** for as long as the lines and the tag disagree, so
> an unadjusted charge cannot go quiet. The same refusal covers a line rounded
> DOWN below the hours leaving it (left exactly as typed, not deleted) and **an
> ad hoc row whose own line was renamed** — the panel can no longer tell that
> line bills that entry, so it cannot re-price or re-mode it.
>
> Where the panel does not offer the decision: **subscription and annual
> clients** and **months before June 2026** have no per-employee hourly lines,
> so hours show for reference with the controls disabled and a line saying why
> — and a tag sent for one of those invoices anyway (a stale tab, a replayed
> request) is refused by the server rather than half-applied. So is a re-tag on
> **sent, processing, paid and voided** invoices — past review the client holds
> a copy of what it would change, so the app refuses rather than quietly
> rewriting it. A month signed off by a timesheet lock shows a **Month locked**
> note on the row; an owner may still re-tag it.
>
> **Download for QBO** exports the month as a line-level CSV for QuickBooks'
> invoice import. Voided invoices are left out. ⚠️ The `Item` column is a
> placeholder until Brittany confirms the product/service names in her own QBO
> file — everything else in the export is exact.
>
> Running Generate again is safe and expected: a client that already has an
> invoice for that month is skipped, never rewritten, so a second run cannot
> revert edits. A client with nothing to bill gets no invoice. **Nor does a
> client opted out of platform invoicing**, and the run says so when it finishes
> ("… 1 client opted out of platform invoicing.") rather than passing over it
> in silence — see **Opt out of platform invoicing** below.
>
> **Void & regenerate.** Next to Generate. Generate leaves an existing invoice
> alone, so it cannot refresh a month built early that has since moved on —
> this button can. It voids every **Draft** and **Reviewed** invoice for the
> chosen month and immediately rebuilds them from current data. It NEVER
> touches an invoice that has gone out (Sent, Processing and Paid stay exactly
> as they are; a past-due invoice is Sent, so it is safe too) or any other
> month. The trade is real and the confirm states it with the actual counts
> ("Void 12 drafts and 3 reviewed invoices for August 2026…"): line edits, the
> note to the client and the review status on the voided invoices are
> **discarded**, not carried forward. Voided invoices stay on the record,
> struck through, as always. The button is grayed out when there are no unsent
> invoices to rebuild. Afterwards it reports how many were voided, how many
> rebuilt, and how many were left alone because they had been sent or paid.
>
> **Expect the invoice numbers to jump after a regenerate — that is fine.**
> Numbers run `INV-2026-08-001`, `INV-2026-08-002`, … within a month. A voided
> invoice KEEPS its number and numbers are never reused, so rebuilt invoices get
> fresh higher ones: regenerating a 12-invoice August moves the live invoices
> from `INV-2026-08-001`–`012` to `INV-2026-08-013`–`024`. The gap is
> deliberate — a number that was on a document must never point at a different
> document later. **Download for QBO** leaves voided invoices out, so the
> export has no gap at all.
>
> **Stripe is LIVE — real money moves.** Payment links and card payments run on
> the live Stripe account, and real payments have settled through it. Can a
> client actually pay from the app? Yes — by bank transfer (ACH) from a payment
> link, or by card. Since every send and link is real, practicing or testing
> belongs on the **Test** client, never a real one.
>
> **Payment link (bank transfer).** On an invoice with an amount owed, the
> **Payment link** button does NOT open a payment page (Brittany is not the
> payer); it creates a secure link and shows it to copy and send to the client.
> Creating one marks the invoice **Sent**. The client pays by bank transfer
> (ACH), which takes about **4 business days to clear**, so the invoice reads
> **Processing** for several days before it turns **Paid** — normal for bank
> transfers, not stuck. A failed payment puts the invoice back to Sent,
> notifies the owners and lists it under **Payment failed** (above) until it is
> sent again or paid another way — and the same link keeps working for the
> retry. No button on a voided invoice or one with nothing owed.
>
> **The payment link does not expire.** It is a PB&J address
> (`app.pbjsa.com/pay/...`), not a Stripe one, and builds a fresh Stripe payment
> page every time it is opened, so a link emailed weeks ago still works. It is
> the same link the emailed invoice's **Pay** button uses — one link per
> invoice however the client got it; pressing **Payment link** again hands back
> the same one rather than replacing it. Opened after the invoice is settled or
> withdrawn it charges nobody twice: a plain page says the invoice is already
> paid, already being processed, or was canceled. If asked why the old link
> used to stop working: the button carried a Stripe address, and those expire
> about a day after they are made.
>
> **After the client pays, the payment page thanks them** and says that if they
> just finished checkout the payment is being confirmed with the bank and the
> page will show Paid once it clears — it does not claim the money arrived (the
> page can be reached before the bank has said anything) and does not send
> them into the app, which they cannot sign into. A client who backs out sees
> "Nothing was charged" and a button to start again.
>
> **A card payer comes back to the card page.** Backing out of or finishing on
> the card link (`app.pbjsa.com/pay/.../card`) returns the client to that same
> card address, so a retry gets the card page they chose, with the processing
> fee shown, rather than being quietly switched to bank transfer.
>
> **Opening a payment link is written into the invoice's history** as a
> "Payment link opened" line, at most once a day however often the client
> reloads it. It is NOT a send and never marks the invoice sent — it is the
> evidence for "we never got the invoice" when the invoice was in fact opened.
> Only a real browser visit is logged; link checkers and mail scanners are not.
>
> **Send (email the invoice).** In the month-run editor, next to Payment link,
> **Send** emails the invoice to **every address attached to that client**:
> each linked contact's general address AND any client-specific addresses on
> that contact (a contact on several clients can hold a different address for
> each, and more than one for the same client — all are used), plus the address
> on the client record. Archived contacts are skipped, and no address gets two
> copies. A personal address on a contact attached to the client counts too —
> that is how some clients actually receive mail.
>
> **You can see who it goes to before you send.** Each row in the month run
> shows its recipient count, and opening it lists them by name
> ("Anthony Cooper <anthony@…>", "Client record <billing@…>"). A client with
> **no address on file** is flagged on the row before the run starts, its Send
> button disabled with the reason on it — it no longer fails only after you
> press Send. The email carries the full breakdown, total, due date and the
> note to the client, plus a big pink **Pay $[amount]** button (bank transfer)
> when there is an amount owed — the invoice's permanent link (above), so a
> client opening the email a month later can still pay; a re-send of a Paid or
> Processing invoice goes out as a statement with NO pay button so nobody can
> pay twice. Sending marks the invoice **Sent**; the first send's date is kept
> as THE sent date. The editor shows the last send ("Sent Aug 9 to 2
> recipients"), which opens to the actual addresses so a past send can be
> audited, and the button becomes **Send again**. A draft must be **marked
> reviewed** before it can be sent. A failed send shows the email provider's
> actual error and never marks the invoice sent; every attempt, failures
> included, is kept in a permanent per-invoice email log with the total billed
> at the time.
>
> **You can see whether the email actually arrived.** Next to "Sent … to …" a
> small badge says what the mail provider did with the message:
>
> - **Delivered** — reached the client's mail server. Nothing to do.
> - **Delayed** — the client's mail server is holding it for a retry; normal,
>   and usually clears within the hour. Nothing to do yet.
> - **Bounced** — could not be delivered at all. **Check the client's email
>   address** on their Contacts (a typo, a closed mailbox, a changed domain),
>   fix it, and press **Send again**. Hover the badge for the provider's reason.
> - **Marked as spam** — it arrived and the client's provider filed it as junk.
>   **Ask the client to add billing@pbjsa.com to their contacts or safe-sender
>   list**, then press **Send again**. Nothing is wrong with the invoice.
>
> **No badge means no news yet** — sent a moment ago, or before this existed.
> The badge never changes the invoice's status: a bounce does not un-send an
> invoice, the bill still stands and the due date has not moved. **A bounce or
> a spam complaint also notifies every owner** through the bell.
>
> **The invoice email itself is built to stay out of spam.** It comes from the
> firm's name, not a bare address ("PB&J Strategic Accounting
> <billing@pbjsa.com>"), replies go to the billing mailbox, it says in one plain
> sentence what is owed and when before the pay button, and its footer carries
> the firm's address, phone and email — the same details as the PDF letterhead.
>
> **Choosing who gets it.** When a client has **more than one** address on file,
> Send opens a checkbox list — one line per address, showing whose it is — with
> **everything ticked**, so sending to all is still one click. Untick any you do
> not want; the invoice goes only to the confirmed addresses, and the email log
> records exactly those. With a single address there is no dialog — it just
> sends. The per-client **Email invoice** button shows the same list. The
> server only accepts a choice from that client's own addresses; it cannot be
> asked to email anyone else.
>
> **All three client emails are branded.** The invoice, the payment
> acknowledgment and the receipt share one design: the PB&J logo at the top, a
> white rounded card on a pale ice-blue page, teal headings and labels with the
> amount due and the pay button in brand pink, and Brittany's script quote —
> "Spread success, not stress, thanks for choosing PB&J Strategic Accounting." —
> above the footer. The quote's words are also the image's alt text and a line in
> the plain-text version, so a client whose inbox blocks images still reads it,
> and the pay button is a colored button rather than an image, so it works with
> images off too.
>
> **Every invoice email carries a PDF of the invoice**, named after the invoice
> number (`INV-2026-08-001.pdf`) and built from the invoice as it stands at that
> moment, so an edit made before sending is in it. It holds the same content as
> the printed invoice: the firm's
> logo and details, the invoice number, the month, the issue and due dates, who
> it bills, every line with its detail and amount, the subtotal and total,
> payment terms, the note to the client and the footer note. If the PDF cannot
> be built for any reason the email still goes out — without the attachment,
> never held back.
>
> **After the client pays, the client hears from us** — automatically; nothing
> is queued for Brittany to send.
>
> - **Bank transfer, when the payment starts:** an acknowledgment — "Payment
>   received… your receipt will follow when the transfer completes, typically a
>   few business days from now" — with the amount and the invoice number, and no
>   attachment, because the money has not landed yet.
> - **When the payment completes (either channel):** a receipt with the amount,
>   the method, the date and the invoice number — and the invoice **PDF stamped
>   PAID** attached, rebuilt after the payment so the stamp names the date and
>   channel, and so a card-paid invoice's fee line is in the attachment.
> - **Card payments go straight to paid**, so a card client gets the receipt
>   only, never the acknowledgment.
>
> Both go to exactly the addresses the invoice went to, each **once per
> invoice** (a repeated processor notice cannot produce a second thank-you),
> recorded in the invoice's email log alongside the sends. If one fails, the
> payment is still recorded correctly; only the notice is lost.
>
> **Pay by card — a per-client option, off by default.** A **Pay by card**
> toggle on a client's **Billing** tab (owner only). Every client is bank
> transfer only until it is switched on for that one client; **bank transfer is
> the no-fee default for everyone and always stays available.**
>
> With it on, the emailed invoice keeps **Pay by bank transfer** and adds a
> smaller card option underneath: "Prefer to pay by card? Pay $103.30 (includes
> a $3.30 card processing fee — bank transfer has no fee)." The client chooses.
> Both links are minted fresh on every send, and paying through one
> **immediately kills the other**, so an invoice can never be paid twice.
>
> **The fee is calculated so the firm receives the invoice total exactly** — not
> a flat percentage on top, which would leave the firm short because the
> processor takes its cut of the larger amount charged. It is worked backwards
> from what the firm must net (2.9% + 30¢ on the charged amount), rounded so it
> is never a penny under: on a $100.00 invoice the client pays $103.30 and the
> firm receives $100.00.
>
> **Where the fee shows up.** Nowhere unless the client actually pays by card:
> the invoice, the month run and QuickBooks show the ordinary total while it is
> unpaid. When a card payment lands, a **Card processing fee** line is added and
> the total recalculated, so History, the month run and the Download-for-QBO
> export show the money that actually arrived. A bank-transfer payer is never
> charged a fee and no fee line ever appears.
>
> **The Payment link button stays bank transfer only**, even for a card-enabled
> client: it hands back a bare URL, and the fee explanation would not travel
> with it. Card is offered through **Send**, where the email explains it. The
> email's card button is a durable PB&J link too (`app.pbjsa.com/pay/.../card`),
> working as long as the bank-transfer one does.
>
> **Opt out of platform invoicing — a per-client switch, off by default.** On a
> client's **Billing** tab (owner only), beside Pay by card, the **Opt out of
> platform invoicing** toggle: "No invoices are generated or sent for this
> client here; they are billed outside the app." It is for a client invoiced by
> the firm's older method that should not be part of this app's billing at all.
>
> With it on, **nothing is generated and nothing can go out** for that client:
> the month run builds them no invoice (and reports them, so a short month reads
> as a setting, not a fault), **Generate for this one client** answers
> "<Client> is invoiced outside the app, so no invoice was created", and a
> retainer invoice is refused the same way. An invoice from before the switch
> stays on screen with an **Opted out** flag, **Send** and **Payment link**
> grayed out with that reason; a pay link already in the client's inbox stops
> taking money and shows the "cannot be paid online right now" page. Their time,
> tasks, team and contacts are untouched — only the billing moved — and the
> setup checklist stops asking for a billing rate or email for them, since
> nothing here reads either. Switching it back off puts them straight back into
> the next month run.
>
> **Email invoice can build the invoice first.** The per-client **Email
> invoice** button sends the STORED invoice for the client and month on screen.
> If that client has no live invoice for that month (none, or only voided
> ones), it no longer stops but asks: "<Client> has no invoice for August 2026
> yet. Generate it now? (Just this client — nothing else is created.)" Yes
> builds ONE invoice, for that client only, and stops at a **draft**, saying so
> ("Invoice INV-2026-08-043 created as a draft — mark it reviewed in the August
> 2026 month run above, then send"). It does NOT send it or mark it reviewed:
> review before send is the rule everywhere. No changes nothing. With genuinely
> nothing to bill — no hours, plan or reimbursements that month — it says so
> instead of creating an empty invoice. For a client **opted out of platform
> invoicing** it does not offer to build one at all: it answers "<Client> is
> invoiced outside the app, so no invoice was created."
>
> **History — every month, on the same page.** A switch at the very top of the
> Invoices page: **This month** (everything above — the run and the per-client
> view below it — where the page always opens) and **History**, the archive. It
> is not remembered between visits, because the month you are billing is what
> this page is for.
>
> History lists **every month ever generated, newest first**, each collapsed to
> a single line until opened: "August 2026 · 14 invoices · $12,400.00 billed ·
> $9,800.00 paid · $2,600.00 outstanding". **Voided invoices are left out of all
> four figures** — a void is a withdrawn document, and counting it would say the
> firm billed money it never asked for — but are counted separately at the end
> of the line ("· 2 voided"), so a month that is half voids never looks like
> one where invoices went missing. **Paid** is the invoices actually settled;
> **outstanding** is billed minus paid, so a **Processing** invoice counts as
> OUTSTANDING — deliberately: a bank transfer that has not cleared is money
> that has not arrived.
>
> Open a month and you get a compact table — **Number, Client, Status, Total,
> Sent, Paid** — in invoice-number order, with voided rows dimmed and struck
> through exactly as they are in the run. Click any column heading to sort by it
> (click again to reverse). Sorting applies **within** each month; the months
> themselves always stay newest first.
>
> Above the months are three filters — **Year**, **Client** and **Status**.
> Year and Client offer only what is in the archive (no never-invoiced clients,
> no empty years); Status is always the full lifecycle list. They narrow the
> rows AND recompute every total, so filtering to one client turns each month
> line into that client's month; a month left empty disappears from the list.
>
> **History is read-only** — no edit, send or void; the month run is where
> invoices are worked on, and one place has to own that. Each row does two
> things: **Print** (the same printed invoice as everywhere, from the stored
> lines), and **clicking the invoice number opens that month in the run** (the
> switch flips back to This month and the run's picker moves to that month).
> With unsaved edits open in the run it asks first, naming the month holding
> them ("You have unsaved invoice edits in August 2026"); keeping them leaves
> you in History with a line saying so. Until months have been generated,
> History says so and shows nothing.
>
> **RETAINERS — the two ends of an engagement:** a **retainer invoice** when the
> client signs, and a **retainer credit** on the invoice you decide is the last
> one. The monthly invoicing in between is untouched.
>
> **Issuing one.** On the client's **Billing** tab, the **Retainer invoice**
> panel: type the amount, optionally a note for the invoice line, and press
> **Issue retainer invoice…**; after a confirm it creates a DRAFT retainer
> invoice for that client. This is deliberately manual — the app cannot know
> when an engagement letter comes back signed, so pressing that button IS the
> signing event. Nothing generates one for you.
>
> **After that it is an ordinary invoice**, in the month run for the month it
> was issued in and in History, tagged **Retainer**: review it, edit its line,
> send it, take payment and print it like any other. It may sit in the same
> month as that client's regular invoice — separate documents, told apart by
> the tag. **Generate** and **Void & regenerate** ignore retainers entirely: a
> retainer never stops the month's real invoice being built, and rebuilding a
> month never throws a retainer away.
>
> **Retainer numbers run on their own sequence:** `INV-RET-2026-001`,
> `INV-RET-2026-002`, … counted per YEAR, not per month, because a retainer is
> not part of any month's batch. They can never collide with the monthly
> `INV-2026-08-001` numbers.
>
> **Giving it back — THE APP OFFERS, YOU DECIDE WHEN.** Once a retainer is
> **paid**, every invoice for that client shows **Apply retainer credit ($X)**
> beside "Add a line". Nothing is ever applied automatically — which invoice
> ends an engagement is your judgment, and to the app the final invoice looks
> like any other month. Pressing it adds a line **"Retainer applied — credit"**
> at a negative amount, and the total drops accordingly.
>
> **Applying and removing are both yours.** Delete the credit line with its
> ordinary bin icon and save — the retainer goes straight back on account and is
> offered again on the next invoice you open. Nothing about this is one-way.
>
> **The credit is added before the invoice goes out, not after.** Apply appears
> on **Draft** and **Reviewed** invoices only: crediting a sent one would leave
> the client's copy and the copy of record disagreeing about the amount, with no
> send to tell them. A credit applied BEFORE sending is untouched by this — it
> travels with the invoice through Sent and Paid like any other line, and the
> invoice stays editable.
>
> **The amount on the credit line is not typed.** The app sizes it from the
> retainer and the rest of the invoice and re-sizes it on every save, so the box
> is read-only; the wording of the line is still yours to change.
>
> **Voiding gives the retainer back.** Void a credited invoice — singly or by
> regenerating the month — and the retainer returns to the account
> automatically, offered again on the next invoice: nobody will pay a voided
> invoice, so leaving the retainer marked spent would strand it where nothing
> would ever show it.
>
> **You cannot void a retainer that has been given back.** It would leave the
> other invoice carrying a credit against a withdrawn document. The app refuses
> and says exactly where to go: "This retainer is applied to INV-2026-08-004 —
> remove the credit from that invoice first."
>
> **If a retainer holds more than one client's worth of history, the button
> names the one it is offering** ("Apply retainer INV-RET-2026-001 credit
> ($500.00)"). A client with two retainers is offered the older one first;
> choosing between them is not built yet, so apply the first, then the second.
>
> **A retainer can never be given back twice.** The moment it is applied the app
> records which invoice took it, enforced on save, not just in the buttons: the
> same retainer applied to a second invoice — another tab, another owner — is
> refused outright with "That retainer has already been applied to another
> invoice", and nothing of it is stored.
>
> **The credit can never make an invoice negative.** A retainer larger than the
> final invoice stops at the invoice's own total, taking it to exactly $0.00 —
> never below — and the button says so ("$2,500.00 is held on account; this
> invoice can take $400.00 of it"). Applying it settles the retainer in full;
> returning the remainder is done outside the app, deliberately — paying a
> client is not something a billing screen should do on its own.
>
> **A fully credited invoice still goes out.** If the credit takes the total to
> $0.00 the invoice sends as a statement, with no pay button, because there is
> nothing to pay. If money is still owed, the pay link and the card option (if
> that client has one) charge the NET amount — the credit is part of the lines
> the total is computed from, so everything downstream agrees.
>
> **Where retainers show up elsewhere:** **History** (tagged Retainer) and
> **Download for QBO** — the retainer invoice and the credit line both export,
> sharing one item name so they net out over the engagement. **Client Recap
> revenue does NOT count retainers**, deliberately: a retainer is money held on
> account, not revenue in the month it is paid, recognized through the monthly
> invoices it later offsets — so crediting the final invoice does not dent that
> month's recap revenue; the work was still worth what it was worth.
>
> **Combined billing (billing masters).** A client can be a **billing master**:
> it does no work of its own but bills for a group of companies (its "subs").
> Each sub's time, checklists, reimbursements and recap stay on the sub as
> normal — the sub just gets no monthly invoice of its own ("Billed on the
> master's invoice" shows where it would be), and the master's monthly invoice
> carries every sub's charges. In the month run the owner sees it broken out by
> company with per-company subtotals — but THE CLIENT SEES ONE COMBINED LINE
> ("Bookkeeping services — the month") with one total: no company names or
> per-company amounts on the printed invoice, the PDF or the email — the
> client's own choice. The email goes to whichever sub's contacts the owner
> picked for that master ("Combined invoice recipient", under Billing on the
> master's client page); with none picked, sending refuses with a sentence
> pointing there. Retainers are still issued per company, never combined. The
> master's Client Recap rolls up each company's numbers (each sub keeps its own
> recap); a couple of figures (sales tax status, projection) do not roll up and
> say why with a dash. A billing master cannot have time logged to it,
> checklists on it, or recurring reimbursements of its own — the app refuses,
> because its job is billing, not work.
>
> The per-client section BELOW the run is the older live-calculation view, kept
> for its preview and print.

- Per-client invoice drafts for the selected billing month: subscription
  plans and/or billable hours become line items; total due computed. For
  Hourly clients, billable hours are charged per team member at that person's
  own bill rate **as it stood in the rate month that client is pinned to** —
  one "Billable hours — <name>" line each. So raising someone's bill rate does
  NOT raise every hourly client next month; a client moves to newer rates at
  its review (Client page → Billing → Hourly rates). Which clients a raise does
  reach, the FIRST-rate exception, and how someone with no bill rate at all
  bills (the client's legacy hourly rate on the invoice, the firm default on
  the previews) are under Team → Bill rate.
  This per-employee billing applies from June 2026 onward; invoices for earlier
  months keep computing at the client's prior per-client hourly rate, so already
  -sent historical invoices stay exact and never change retroactively. Nothing
  already sent is ever repriced — a sent invoice carries its own rates.
  The on-screen previews — this per-client view, Projected billing on the
  Reports page and on the Dashboard, and the Billable $ columns on the
  Employee report and the payroll Hours report — price a pinned client's hours
  at its pin too, so for everyone with a bill rate on file they match the
  invoice the month run generates.
- **TIME BREAKDOWN ON THE INVOICE — OFF UNLESS YOU TURN IT ON, PER CLIENT.**
  By default an invoice says what the client is paying and nothing about the
  hours behind it: a monthly client sees the subscription line and any expense
  reimbursement line, with their prices, and that is all. On the
  client page, **Time breakdown on the invoice** offers four levels of detail
  when you want them:
  - **One line per person (total hours)** — each person and their total for the
    month. Three people on a client means three lines.
  - **Per person, per day** — a line for each day someone worked.
  - **Per person, per week** — a line for each week someone worked.
  - **Every entry for the month** — one line per entry, with what was done.

  With any level switched on, a second control appears — **Show amounts on the
  breakdown** — which adds what each line of time was worth.

  **The breakdown never changes what the client owes.** Every line it adds is
  $0.00 and carries no charge; it explains the invoice, it does not price it. So
  switching it on, off, or between levels is always safe, on any invoice, and
  the total does not move.

  Hours are always shown as a total — "4.00 hours" — never as clock-in and
  clock-out times.

  On an **Hourly** client, "one line per person" adds nothing — the invoice
  already bills one "Billable hours — <name>" line per person with the hours
  and money on it — while per day, per week and every entry still add detail.
  An hourly client's charges are unaffected by this setting either way.
- This invoice's reimbursements: add out-of-pocket expenses (date,
  description, amount) — each becomes a line on the invoice. Recurring
  reimbursements supported.
- Reimbursed expenses can name the DATES THEY COVER, and keep those dates
  current on their own. Set up on the client page (Recurring reimbursements):
  tick "The invoice wording names the dates this covers", write the wording ONCE
  with placeholders — `{range}`, `{start}`, `{end}`, `{description}` — and enter
  the first covered period by hand (e.g. July 13 to August 13). Every later
  invoice fills in its own cycle's dates: "QuickBooks Online — August 13 –
  September 13, 2026". The cycle turns on the day the first period ENDS; short
  months clamp (a 31st becomes the 28th in February) and the cycle returns to
  its own day the following month.
  - The window moves when an invoice is GENERATED, not on a calendar: voiding a
    month and regenerating it reuses that month's window, so a rebuilt invoice
    covers the same dates as the first one.
  - VOIDING un-bills the window: a month voided and never rebuilt goes back to
    unbilled, so the next invoice generated offers that same period instead of
    quietly moving past it.
  - Quarterly and annual expenses cover three months and twelve months per
    cycle respectively, matching their own frequency.
  - Pause an expense (the pause button on its row) and it stops billing
    entirely. It keeps its place — nothing advances while it sits out.
  - The invoice ASKS, rather than guessing, whenever the next window is not
    simply the one after the last (a skipped cycle, a paused expense switched
    back on, or a month generated behind one already billed): the line is
    flagged "Confirm the covered dates" in the month-run editor with a proposed
    period she can accept or edit. Until she answers, the invoice can be neither
    marked reviewed NOR sent — both are refused; voiding it is the way out if
    she does not want to answer.
  - What she confirms is what the following cycle counts forward from, including
    the day of the month: moving a covered period's end onto a different day
    moves the whole cycle onto that day rather than snapping back next month.
  - Confirming refreshes the invoice wording around the new dates — unless she
    has typed her own wording on that line, which is left exactly as she wrote it.
  - An expense that does not use this bills exactly as it always did.
- Customize: adjust line items, the intro/footer notes and which client fields
  appear — on the PRINTED sheet only. These edits are session-only and never
  emailed: Email invoice always sends the stored invoice, so to change what a
  client receives, edit the lines in the month-run editor and save. Email
  invoice is unavailable while Customize is open, so the two cannot disagree
  about what went out.
- Email invoice: actually sends the STORED invoice (never the Customize
  version) for the selected client and billing month to that client's contacts
  on file, through the same rail as the month run's Send button — it does not
  open a mail draft. The month must have been generated first, and the invoice
  must be past Draft (mark it reviewed in the month run), otherwise the button
  explains what is missing instead of sending. Asks for confirmation first, and
  reports who it went to and when.
- Print invoice: opens the browser's print dialog on a clean, print-formatted
  invoice sheet with firm branding — only the invoice prints, not the sidebar,
  billing queue or the rest of the screen. From there the browser can print it
  or "Save as PDF". Printing emails nothing and saves nothing to the invoice.
  - The SAME sheet is what every Print button produces — the month-run
    editor's, History's, and this page's Print invoice — one printed format, so
    what she prints matches what the client was emailed (the emailed PDF
    mirrors this sheet; the month-run editor's Print is disabled while there
    are unsaved edits). Three caveats before telling a client "it's identical":
    - The PDF is built by a SEPARATE server renderer, not from this sheet. They
      share the line calculation and the money formatter, so amounts and lines
      always agree; the layout is a hand-maintained mirror, so small
      presentation differences are possible.
    - The PDF can carry things the printed sheet does not: a **PAID** banner
      once the invoice is marked paid, and, on a card payment, the processing
      fee line added at payment time. Printing never stamps an invoice PAID.
    - The PDF is attached best-effort: if it fails to render, the email still
      goes out without it.
  - The month run's and History's Print show the STORED invoice for that row;
    this page's Print invoice shows the live per-client calculation for the
    selected client and month, including any Customize edits.
- Billing queue: all clients with their month total, ready to review.
- Estimated hours fields anywhere in the app are informational only and
  never change invoice amounts.

## Invoice Recap (owner + staff)

> **The one invoicing page staff can see.** (It was owner-only for part of
> 2026-09-04 while a visibility bug was fixed: the "assigned team" list used to
> widen automatically whenever someone got a task on a client, so staff saw
> invoices for clients they only had a checklist on. That list is now one only
> an owner picks, and the page reads only it.) Built so the team can record
> each month's deposits correctly: for every invoice that actually went out
> for a month (sent, processing or paid — never drafts; a past-due invoice is
> Sent, so it counts), one card shows the company's **Invoice total**, the
> **Accounting services** amount and the **Reimbursed expenses** total — then
> every client-reimbursed expense **listed individually with its
> description**, never combined, so it is clear what each was for. Accounting
> services + reimbursed expenses always add up to the invoice total, because
> all three come from the same stored lines.
>
> **Each team member sees only their assigned clients' invoices** — the
> ASSIGNED TEAM an owner picked on the client's page or the Team page, never a
> list a task assignment widened; owners see every client. A team member who
> sees none has not been put on any client's team yet. On a combined
> (billing-master) invoice, each reimbursed expense names its company; the
> combined invoice itself appears only for people who can see the master
> client.
>
> Navigate months with the back/forward arrows or the month picker at the top.
> Retainer invoices are not in this recap — a retainer is money held on
> account, not a monthly bill. Amounts here are read-only; editing invoices
> stays on the owner-only Invoices page.

## Plans (owner only)

- Subscription plan catalog: name + notes (e.g. "Monthly Close Essentials").
  Attach plans to clients (plans label the monthly invoice line).
- A plan can be linked to a set of checklist TEMPLATES — the standard work that
  comes with it — drawn ONLY from the firm's standard BLUEPRINT templates (the
  client-agnostic ones on the Checklists page), never a client-bound checklist,
  so the picker lists only blueprints and only blueprint checklists show on a
  plan. On a client's detail page, for each plan the client is on, a "Plan
  checklists" panel shows that plan's templates, marks which are already set up,
  and "Set up plan checklists" adds the missing ones. Each starts from the day
  it is set up — no back-dated tasks (see "A repeating task starts the day it
  is set up" under Checklists). Templates carry a board column, so the new
  checklists land in the right Board column automatically — connecting plans →
  checklists → board.
- **Packages — plans you apply together.** A **Packages** tab at the top of
  the Plans page, next to the **Plans** tab (Plans opens by default; the tab
  is in the URL as `?tab=packages`, so a link can open straight to it). A
  package is a named combination of plans the firm already has (two or more —
  one plan is just that plan), plus the standard blueprint checklists that
  come with them, so setting a client up is one press instead of a plan and a
  checklist at a time.
  - **A package is not a price.** Applying one changes nothing on the invoice:
    plans are LABELS on the monthly service line, and the amount billed is the
    client's own monthly rate. It adds labels and sets up work, never touches
    money, and the confirm dialog says so first.
  - Each package has a name, an optional description, its plans, and its
    **Checklists** — which start as everything the chosen plans already bundle
    (the union, no repeats) and are edited from there. Only the firm's standard
    BLUEPRINT checklists can be in a package, the same rule plans follow.
  - Deleting a package removes only the shortcut. Every client it was applied
    to keeps their plans and their checklists.
  - **"Suggest checklists" — the AI proposes, you decide.** Inside a saved
    package, this asks the assistant what the package is missing. It looks at
    the package's plans and every standard checklist the firm already has
    (including those on the package, so it does not suggest them back) and
    answers with up to five proposals — each with its recurrence, its steps,
    and one sentence on why this package needs it. **It creates nothing.** The
    proposals arrive as unticked tick boxes; pick the ones you want, press
    "Create selected", and confirm. Only then are they created — as ordinary
    standard blueprint checklists attached to the package, indistinguishable
    from ones you wrote. Nothing is set up on any client until the package is
    applied. If the AI is busy or its answer doesn't hold up, the panel says so
    in a sentence and nothing is created.

## To 100% (owner only)

- **What this page is (and deliberately is NOT):** it answers one question —
  "what parts of the app aren't working or aren't fully configured?" —
  organized BY TAB, mirroring the sidebar. ONLY problems appear; day-to-day
  checklist work (active checklists with unchecked steps) NEVER shows here —
  that's operations, on the Checklists page and the Board. A tab with nothing
  wrong renders as a slim GREEN row ("Nothing missing"), so the owner also sees
  which areas are fully working.
- Tabs covered, in sidebar order: **Checklists** (recurring recipes that will
  silently never generate), **Board** (recipes with no Board column — their
  checklists pile into "Uncategorized"), **Clients** (missing email / team /
  contacts / plan checklists), **Invoices** (Monthly/Annual clients with no
  rate — their invoice would be $0), **Plans**, **Team** (no bill rate),
  **Contacts** (unlinked). Tabs without automated checks (Time, Timesheet,
  Dashboard, reports) aren't listed, and the page says so — unlisted means
  "not scanned", not "verified fine". A client whose team lived only in the old
  `client_assignments` table (never the field that gates visibility) now shows
  here as "missing a team member" instead of silently.
- "Add a billing email for <Client>" asks EXACTLY what the Send button asks: a
  client is listed only when there is no address anywhere to email their
  invoice to, checked with the send route's own recipient resolver (a
  contact's client-specific address, that contact's own address, then the
  client record's address), so a client whose email lives on its CONTACTS is
  not asked for one. Consolidated billing follows the sending rule: for a
  MASTER the addresses checked are the sub it sends to, and the quick fix
  writes the address onto that sub — where the send reads it — saying so on
  the item and the field. A sub is still asked for its own address, since it
  can still hold its own retainer invoice.
- "Pick a receiving company for <Master>" (Invoices, high): a billing master
  has no contacts of its own, so its combined invoice is emailed to the one
  company it names. With none named — or one that has moved out from under the
  master — nothing can be sent at all, so this item links straight to the
  "Combined invoice recipient" picker under Billing on the master's client page.
- Top-of-page summary: one chip per tab that HAS problems, with its count;
  clicking a chip opens that tab's section and scrolls to it. Sections with
  issues are collapsed by default; green tabs are always visible.
- Fix in place: most items open a small QUICK-FIX modal with only the missing
  field(s) — a monthly/annual rate, a billing email, the assigned-team picker,
  or "Set them up" for a plan's missing checklists — saving without leaving the
  page (the item disappears once filled in). Items with no single field (bill
  rate → Team page, contacts, plan templates) deep-link instead.
- Ignore: any item can be IGNORED (something the owner knows about but doesn't
  need to fix). Ignored items move to a collapsible "Ignored" section at the
  bottom and can be Restored anytime; the ignore list is saved per owner.
- RECURRING CHECKLISTS THAT WON'T GENERATE (the "Checklists" category): the most
  important check, because this failure is otherwise SILENT — a recurring
  checklist saved with a mandatory field missing never creates anything and
  nothing says so. Each broken recipe is named (title · client) with the exact
  missing field and a link to it, and says whether it has NEVER generated a
  checklist or has merely stopped:
  no client attached; no stages; first stage has NO STEPS; a specific-months
  recipe with no months chosen; no next due date; "repeat every year" off with a
  past scheduled year; the recipe is switched off; or the first stage has no
  assignee (it generates, but lands on nobody — and only the assigned person or
  an owner can complete a step). Standard blueprints are skipped: they're recipes
  to copy, never scheduled, so an empty one isn't a fault. These mirror the
  materializer's own conditions, so the list is exactly "what is silently not
  running".
- Shows "You're all set — 100%" when nothing is misconfigured anywhere.
- Suggestions that stand for several outstanding things name each one rather
  than only counting them: the "plan checklists not set up" item lists each
  specific missing checklist by name (already-added ones are excluded, and the
  count matches the named list).

## Team (owner only)

- Invite bookkeeper: name, email, role (Bookkeeper / Accountant / etc.) —
  sends a sign-in link by email.
- Roster: each member's role and last login; expand for details; reorder.
- Assigned clients (expand a member, FIRST thing under their name): the list of
  clients this person is on the team of. Chips for who they are already on,
  each with an X to take one away, and a "+ Add client" menu that STAYS OPEN
  while clients are picked — one click per client, no re-opening between them.
  Adding a client here is what lets that person see the client's invoices on
  the Invoice Recap: the assigned list is the money gate, and nothing else
  opens invoices. (Seeing tasks, time and notes is wider — anyone holding work
  on a client can see it without being on the team.)
- Suggested (inside Assigned clients): when someone holds live work on clients
  they are not on the team of, the page lists them — "The 4 clients Lisa
  currently has work on:" — each addable in one click, plus "Add all 4", which
  adds them all and confirms ("Added 4 clients."). Retired clients are never
  suggested. It is a suggestion, not an automatic fill-in: nobody gains access
  to a client's invoices until the owner clicks.
- Resend sign-in link; revoke access.
- Bill rate (expand a member): the $/hour charged to clients for this person's
  billable hours on Hourly-billed clients. Set for ANY member including the
  owner (so the owner's own hours bill). Owner-only to edit. A member with no
  bill rate on file bills the generated invoice at the client's legacy hourly
  rate — a per-client rate with no field on the Client page anymore, $0 for
  any client created since it left — while the on-screen previews show the
  firm default rate instead, so give everyone who logs billable time a bill
  rate. **Every saved rate carries an "effective from" month**, defaulting to
  the current month — so a raise starts the month you pick and leaves every
  earlier month alone. Saving a month that already has a rate corrects it;
  saving an earlier month backfills a change you forgot to record.
  - **Which clients a saved rate reaches.** An hourly client bills each
    person's rate as it stood in the client's **rate month** (shown on Client
    page → Billing → Hourly rates), and saving a rate never moves a client's
    rate month. A rate reaches every hourly client whose rate month is its
    effective-from month or later (up to the next month this person already has
    a rate saved for). With the default — the current month — that is every
    client on the current month's rates, including any client created or
    switched to Hourly this month, and every client already moved to this month
    or later; every other client stays put until it is moved at its review. A
    correction or backfill likewise reprices every client whose rate month is
    that month or later, for any month whose invoice has not been generated
    yet. To leave those clients alone, date the raise after their rate month.
  - **The exception: a person's FIRST rate.** Someone with no rate on file as
    of a client's rate month (hired after it, or given their first rate later)
    bills at the FIRST bill rate they were given, from the month it starts —
    including at clients whose rate month is earlier — never a later raise,
    held there until the client's rate month moves. For a month before their
    first rate starts, their hours bill like someone with no bill rate on file.
- Cost rate (expand a member): optional $/hour pay/cost rate per member. Set
  for ANY member including an owner — an owner who wants her own hours in the
  firm's labor cost (for budgeting) enters her rate here, and from then on her
  time is costed exactly like anyone else's on the Client Recap, the payroll
  and employee reports, and the assistant's margin analytics. Owner-only to
  edit, informational — it is NEVER billed and never shown to staff. With no
  cost rate on file that person's time simply costs nothing: their Cost cells
  read "—" and the assistant reports realization only. (Distinct from bill
  rate above.) **Every saved cost rate carries an "effective from" date**,
  defaulting to today, and time is costed at the rate in force **on the day it
  was worked** — so a raise lands on its payday and never changes what a past
  recap says the work cost.
- How both rate boxes behave:
  - **Save is disabled while the box is empty** — a blank box no longer clears
    a rate. After a save, "Effective from" resets to the current month (bill)
    or today (cost).
  - The rate shown in the box is the **newest version on file** — the one with
    the latest effective-from, even if that is a future month. Backfilling an
    older month does not change what the box shows.
  - **"Rate history"** lists every version with the month or date it starts
    from; a cost rate that was on file before dated rates existed reads "Since
    the start". **Only the newest version can be removed** (Remove sits on
    that row) — an older one is what past months were billed or costed at. To
    clear a rate entirely, remove versions one at a time, newest first; when
    the last one goes the rate reads blank.
  - **A bill-rate version cannot be removed while any client is pinned at or
    after its month** — including a month a client's rate history still bills
    a past period at. The page shows the reason as a sentence; move that client
    first.
  - **A person's only bill-rate version also cannot be removed while any hourly
    client is pinned before its month** (live, or in a month that client's rate
    history still prices) — that client bills the person's first rate from its
    start month until the client's review, so removing it would drop the client
    to its own hourly rate (often $0) on invoices not yet generated. To change a
    person's only rate, save its month again with the new amount instead.
- Roles: owner has everything; staff see their assigned clients, their own
  time, and ALL tasks for those clients (logging time against any of them),
  while editing/completing stays limited to tasks assigned to them. There is
  exactly one owner.

## Settings (owner only)

- Firm identity: name, tagline, logo upload (shows in sidebar, login,
  invoices, printed reports), brand color (sidebar background), sidebar text
  color, active-section color. A built-in contrast guard auto-corrects any
  illegible color combination, so branding can't break readability.
- Mailing address, contact details, EIN — used on invoices.
- Sections can be locked to prevent accidental edits.

## Security & sign-in

- Email magic-link sign-in (15-minute, single-use links) and password
  sign-in; owner can also use a password recovery path.
- **Signing in the Windows desktop app:** sign into the web app first, then
  click **Open in desktop** at the top of the screen (next to the bell); the
  browser asks to open "PBJ Accounting" and the installed app opens signed in.
  (The sign-in email cannot do this — email programs block app-opening links.)
  The button is not shown inside the desktop app or on phone-sized screens. If
  nothing happens, the desktop app is not installed, or is already open and
  signed in.
- Optional two-factor authentication (TOTP authenticator app + backup codes).
- Sessions, login history, and an activity log of actions in the app.
- Per-user revocation (revoke sign-in link / access).

## Install as an app (computer and phone)

> The app can be installed so it opens in its own window with its own taskbar
> or home-screen icon — no browser tabs, no address bar. Nothing changes about
> how it works: it is the same live app, always current, same sign-in.
>
> **On Windows (Edge):** open the app, click the ⋯ menu → **Apps** →
> **Install this site as an app** (Chrome: ⋮ menu → **Cast, save, and share**
> → **Install page as app**, or the install icon in the address bar). It then
> lives in the Start menu and taskbar like any program.
>
> **On iPhone (Safari):** Share button → **Add to Home Screen**. On Android
> (Chrome): ⋮ menu → **Add to home screen** / **Install app**.
>
> There is nothing to update or uninstall-to-upgrade — the installed app loads
> the live site, so every new feature is just there, and the same refresh
> notice appears when a new version ships.

## Notifications

- In-app bell with unread count + email (when email service is configured):
  task assigned, workflow stage advanced, case completed, manual time entry
  needs approval, "waiting cleared" (the task a step was waiting on is done),
  and the waiting-on hand-off itself: someone is waiting on you, they finished
  your part, or they have a question about it.
- Every notification email names the CLIENT it's about — a labeled "Client:
  <name>" line at the top and appended to the subject, so the recipient can
  tell which client it concerns from their inbox. The client is resolved from
  the notification's task/client automatically (client-less ones omit the line).
- Emails include a one-click sign-in link.
- **Per-user email preferences**: every user can choose which notification
  types reach them by EMAIL, via an "Email notifications" section at the TOP
  of the Notifications page. Fastest way there: click the notification bell,
  then "Email preferences" in the dropdown footer — it jumps straight to the
  section. Owners also see the same section on the Settings page. Toggle types: task assigned to you,
  workflow progress (someone advances/completes a workflow you opened),
  waiting-on updates (including a question sent back about one), time entries
  needing approval, your time entry was
  sent back, deletion requests, edit requests/decisions, skipped recurring
  tasks, Updates tracker activity, and invoice alerts. Turning a type off stops
  the EMAIL only — in-app bell notifications always arrive. All types default to
  on.
- **Invoice alerts** (the "invoiceAlerts" toggle, owners): an invoice is ready to
  send, a client's invoice email bounced or was marked as spam, or **a sent
  invoice passes its 30-day past-due line**. The past-due notice names the
  invoice number, the client, the total and the line it passed, links to the
  Invoices page, and arrives **once per invoice, ever** — the app checks hourly
  and remembers which invoices it has mentioned, so nothing repeats while a bill
  goes unpaid; remembering and sending are one step, so two app instances
  running at once still produce one notice. Past-due notices alone can be
  switched off by setting the server's `INVOICE_PAST_DUE_NOTICES` to `off`.
- **Skipped recurring tasks** (the "skippedTasks" toggle): both halves of the
  quiet-skip flow — a recurring task skipped for a cycle, and a team member
  creating a task (so the owner can decide whether skipping should be allowed
  on it). Who is told is under "Skipping a recurring task" in Checklists.
- **Updates tracker activity** (the "updatesTracker" toggle): the OTHER owner is
  notified when a new update is logged and whenever one CHANGES STATUS —
  shipped, sent back to Planned, picked up as In progress, moved to Britt's
  Brain, and so on — naming who did it, the title, and the move ("Shipped →
  Planned"), with the review note when one was given. The tracker is owner-only
  and both owners work the queue, so this keeps each aware of the other's
  changes without watching the page. Nobody is notified of their own action,
  and edits that DON'T move an item (retitling, re-ranking, dev notes) send
  nothing.

## Billing month concept

- The top-bar billing month selector scopes Invoices, Reports, and unbilled
  hours to that month. Time entries belong to the month of their date.

## AI Assistant (this assistant)

- Owner-only chat: answers questions about how to use the app, grounded in
  this manifest.
- Voice: the assistant panel has a microphone button — tap it to TALK to the
  assistant out loud (real-time voice) and tap again to end. It speaks back.
  Voice is owner-only. Typing still works alongside it.
- Voice can set things up too, with the same guardrail as text: asking by voice
  only FILES A CONFIRMATION CARD in the panel for one of the four actions below
  (adding a team member means the client's ASSIGNED TEAM — the owner-picked
  list that also decides who sees that client's invoices). Nothing changes
  until the owner taps "Run it"; the assistant never takes an action on its
  own, by voice or by text.
- The voice assistant pulls LIVE firm data when asked: client profitability,
  hours by client/staff, what's overdue or due soon, who's at capacity, and
  the current workspace setup — same numbers as the app's reports. The
  "why isn't this working?" diagnostics below work by voice too, with the
  same answers.
- The voice assistant REMEMBERS across calls: say "remember that…" and it
  saves the fact for future conversations (it also recalls older memories on
  request). Call summaries are kept after each conversation.
- Can draft a feature request to Alex (the developer / admin) when something
  isn't supported — the owner reviews the draft and confirms before any email
  is sent. It goes to the admin email; sent requests are recorded in the
  activity log AND appear on the owner's "Updates" page (the tracker) to be
  prioritized and tracked.
- Generates reports on request from any data it can read (profitability,
  hours, deadlines, capacity, clients, workspace setup): ask — e.g. "give me a
  Q2 profitability report" — and it assembles a structured report (sections,
  key figures, tables) in a modal you can read and "Save as PDF". Works by text
  and by voice (the report pops up on screen during a call). Owner-only. Asked
  for a report the app has no data for, it says so and offers to send Alex a
  feature request to build it (you confirm before it sends).
- After producing a report or analysis, offers to email it to the owner.
  On "yes" it shows a confirm card; only on confirm does it email the report
  to the owner's address. It tells the truth about whether the email actually
  went out (it never claims "sent" when the email pipeline rejected it).
- Watches for repeated manual work and shows up to 3 suggestion cards when the
  panel opens: tasks created by hand month after month (recurring template
  candidates), the same time entry logged manually 3+ times, and recurring
  templates whose schedule looks stalled. Each card deep-links to the right
  page; "Don't show again" dismisses it permanently. Or just ask "what do I do
  repeatedly?" in chat.
- Replies stream in as they're written. The conversation is saved, so it's
  still there on reload and on another device; the trash icon in the panel
  header clears it.
- Can DO a few things directly, each behind a confirmation card (nothing
  happens until the owner clicks "Run it"):
  - Make a template recurring for a client (attach an existing template on a
    weekly / monthly / quarterly / annual schedule).
  - Assign a client to a team member (give them access).
  - Generate a task list now from a template.
  - Turn a switched-off recurring checklist back on.
  For anything else the app can't do, it still offers a feature request to
  Alex rather than pretending to act.
- Optional weekly digest email: on Mondays (configurable) the owner gets an
  email summarizing the top automation opportunities, when email is
  configured. It's deterministic — the same patterns shown in the panel.
- Answers analytical questions about the firm's real data (owner-only,
  read-only, pre-aggregated):
  - Client profitability for a month — revenue, hours, realized rate
    (fee ÷ hours), and true margin where team cost rates are set. Surfaces
    which fixed-fee clients eat more time than their fee implies. An hourly
    client's revenue is priced as its invoice is (from June 2026 on, each
    person's bill rate in the client's rate month at the time; before that, the
    old single hourly rate × billable hours), and cost at each person's cost
    rate on the DAY worked — the same rules as the Client Recap and payroll report.
  - Hours logged by client and/or staff over any date range (billable vs
    administrative).
  - What's overdue or due soon, with the client and assignee.
  - Who's over or near capacity this week (hours vs a weekly target).
  Numbers come straight from time entries and billing settings — it reports,
  it doesn't change anything, and it never alters invoices.
- **Diagnoses "why isn't this working?" against the firm's real settings**
  (owner-only, read-only). Most "broken" reports here turn out to be a
  setting, not a bug, so the assistant checks before it guesses. Ask in plain
  words — by chat or by voice — and it answers with the exact row:
  - **"Why can't [person] log time?"** — it checks the two gates the timer
    itself applies and names what's stopping them: a **locked timesheet month**
    (only an owner can unlock it, on the Timesheet page), or an **earlier week**
    never submitted or sent back for changes (that person submits/resubmits
    it). It names every blocking week at once, says who fixes each, and says
    plainly when nothing is blocking them. It answers for logging time TODAY;
    backfilling an ended week is never gated, so only the month lock can stop
    that. Owners are exempt from both gates, and a removed team member is
    reported as such rather than as a gate.
  - **"Why did [client]'s checklist never show up?"** — it runs the same gate
    the generator uses and reports, per recurring checklist, whether it will
    generate next cycle and, if not, exactly which ingredient is missing: no
    client, no stages, no steps in the first stage, no months chosen (for
    "specific months"), a scheduled year that isn't this year, no next due
    date, or **switched off**. It also says whether the checklist has ever
    generated anything, and warns when one will generate but has nobody
    assigned or no Board column. Ask without naming anything and it lists
    every recurring checklist that will never generate — the silent kind that
    produces nothing and says nothing.
  - **"What changed recently?"** — it reads the activity log for the last 7
    days (or any window you ask for) and says who did what, in plain English.
    Narrow it to a client, a checklist, or a person to trace a surprise back
    to the change that caused it.
- Turning a **switched-off recurring checklist back on** is the one fix it can
  make from a diagnosis — as a confirmation card like every other action
  (switching it off again undoes it). For any OTHER missing ingredient (no
  steps, no due date, no client) it tells the owner exactly what to fix and
  where; it does not change those itself.

## Updates (owner only)

- A tracker for pending feature updates and bug fixes — the owner's roadmap.
  Items come from requests drafted by this assistant (chat → "Send to Alex"),
  which land here automatically, and from the owner adding them directly.
- Adding an item directly: title, type, **priority (set right in the add form;
  defaults to Medium)**, and a plain-language description.
- **"Just spitballing…" (Britt's Brain)**: for ideas that aren't requests yet.
  The button at the top opens a little chat where the AI thinks it through
  WITH the owner — reflecting the idea back and asking a few questions per
  turn, never pushing toward a spec. When the idea has shape (or she clicks
  "Wrap it up & organize"), it offers an organized draft (The idea / What it
  could look like / Open questions / Why it matters), and one click saves it to
  the **Britt's Brain** section — a parking spot for thinking, NOT the dev
  queue: excluded from "Copy all" and the developer's queue runs until Alex
  moves one to Planned via the normal status dropdown. The full transcript is
  kept in the item's notes. If the AI is unavailable, "Save my notes as-is"
  still files the raw idea.
- **Just spitballing remembers.** The brainstorm is saved on the server as you
  go — close the window, come back tomorrow, or switch devices and it is right
  where you left it. Past about thirty messages the earlier part is condensed
  into a running summary the AI keeps referring to, instead of quietly dropping
  off the front. Each finished brainstorm is remembered for the next — "like we
  talked about last time" works, because it sees the gist of past sessions plus
  the titles of everything parked in Britt's Brain. **"Start fresh"** (bottom of
  the window) tucks the current brainstorm away — asking first if there's
  anything in it — and starts a clean one; nothing is deleted, and the archived
  session is exactly what the AI recalls later.
- **When the AI is at capacity, spitballing says so instead of getting worse.**
  If the AI stumbles on a turn it quietly retries that turn without the
  older-sessions memory — usually all it takes — before ever saying it is at
  capacity. If the provider is overloaded, the brainstorm shows "The AI is at
  capacity right now — give it a minute and try again. Your notes are safe."
  rather than answering with a weaker stand-in model, whose degraded reply
  would be saved into the conversation and drag down everything after it. Wait
  a minute and re-send; nothing typed is lost. (Other AI features — Refine for
  dev, the feedback read-back — do quietly use the stand-in, because their
  suggestions are reviewed before anything is saved.)
- Each item has a type (Feature / Bug / Improvement), a status (New → Planned →
  Planned (not near EOM) → In Progress → Needs answer → Shipped → Done, or
  Won't do), and a color-coded priority level — Urgent (red), High (orange),
  Medium (blue), Low (slate).
- **Planned (not near EOM)**: a parking lane for planned items that touch a lot
  of the app. The developer's queue picks these up only MID-month (roughly the
  6th through the 23rd), never in the firm's month-end close window, so a risky
  change can't break things while the books are being closed. Move an item in
  or out with the normal status dropdown.
- **Needs your answer** (clarification loop): an item the developer can't build
  without a decision moves to "Needs answer" with the blocking question, and
  appears in an amber panel pinned ABOVE all sections with the question, an
  answer box and "Answer & return to Planned" — which stores the answer on the
  item (shown as "Q: … — A: …" on its card) and puts it straight back into the
  Planned queue for the developer.
- Every Shipped item shows **when it went live** ("Shipped Jul 24 · 9:12 PM")
  next to its title, so the owner knows how fresh each change is. Re-shipping
  (after a send-back) re-stamps the time.
- Layout: a TAB BAR across the top, one tab per status, each showing its COUNT
  — the shape of the whole queue at a glance, one click to switch. Shipped is
  the first tab and the default, so the owner lands on just-shipped work
  awaiting her sign-off. Empty statuses keep their tab (showing 0 — "In
  progress 0" is itself useful); the "Hide Done / Won't do" toggle removes
  those two tabs entirely, and if the selected tab disappears the view falls
  back to the first one. Within a tab items are ordered by priority level
  (Urgent → Low) and drag-to-rank within their level; dragging only re-ranks
  within the same status. Changing an item's status moves it to the matching
  tab; changing its priority moves it between levels.
- Ship + approve workflow: when the developer has pushed an update they set the
  item to "Shipped" (a violet badge; still open, awaiting sign-off) — the
  Shipped tab is captioned "Awaiting your approval". A Shipped item shows "Mark
  approved" (moves it to "Done" and records who approved it and when —
  "Approved by <name> · <date>") AND "Not approved", which opens a reason box.
  "Send back" first runs an **AI read-back**: the assistant restates the reason
  in the owner's own terms ("So the change you want is …" — or asks which of
  two readings she means), and only after "Yes — send back" is it filed. The
  item returns to **Planned** (straight back into the developer's queue, like
  answering a clarification) with an amber "Not approved — <date>: <reason>"
  note plus the confirmed dev-ready rework spec. If the AI is unavailable, a
  "send back without the read-back" fallback means feedback is never blocked.
  An In-Progress item's whole card gently pulses.
- **"Walk me through it"** sits beside "Mark approved" and "Not approved" on
  every Shipped item. It opens a panel on the card itself (nothing pops up over
  it) with a plain-language walkthrough for the owner in four parts: **What
  changed** (a few sentences), **Where to find it** (the page and controls by
  name), **Try it** (a short numbered list to follow now), and **What did NOT
  change** (the scope of the approval). The AI writes it from the developer's
  shipped notes plus the matching part of this manifest — never from code or
  commit details — and it is SAVED with the item, so re-opening the card shows
  the same walkthrough instantly; "Regenerate" asks for a fresh one. It is
  reading material only: it never approves, sends back, or changes status, and
  if the AI is unavailable the panel says so in one sentence while both review
  buttons work exactly as before.
- Editing an item: click the title or "Edit" to edit the title + description in
  place; Save commits it (typing doesn't auto-save). Status, priority, and type
  still change immediately from their dropdowns.
- "Refine for dev": sends a rough item to the AI to rewrite it into a clean,
  implementation-ready spec (Problem / Desired behavior / Where in the app /
  Acceptance); the owner accepts or discards the suggestion.
- "Copy for Claude Code" (per item) and "Copy all (prioritized)" put a clean,
  paste-ready markdown spec on the clipboard so the owner can hand work to the
  developer's build tool in one click.
- Owner-only — staff don't see this page.

## NOT supported (yet) — common asks

The app currently has NO:
- Client-facing portal (clients cannot log in or see anything — they can pay
  an invoice from its emailed link, but there is nothing to sign into)
- QuickBooks / Xero / bank-feed integration of any kind
- Automatic invoice sending on a schedule (sending is manual, per month)
- Document/file storage for client paperwork
- Payroll features
- Calendar sync (Google/Outlook)
- Native mobile app in an app store (but the web app is responsive AND
  installable — see "Install as an app": own window, own icon, phone home
  screen)
- Custom report builder (Reports/Productivity CSVs are the export surface)
- Multi-firm / multi-workspace support
- Public API or webhooks
- Email inbox integration
- E-signatures

If the owner asks for one of these (or anything else missing), say it's not
supported yet and offer to send Alex a feature request.
