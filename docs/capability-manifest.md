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
Productivity, Gantt, Invoices, Plans, Team, To 100%, Updates (owner only),
Settings. A billing-month picker, notification bell, and account menu sit in the
top bar on every page.

**The owner's sidebar is grouped into sections** (nineteen flat links was too
many to scan). In order: Dashboard, Engagements, **Clients** (Clients, Contacts,
Client Recap), **Billing** (Invoices, Plans), **Operations** (Time, Timesheet,
Time Approvals, Checklists, Board, Delayed, Gantt), Team, **Reports** (Reports,
Productivity), Updates, **Settings** (Settings, To 100%). Dashboard,
Engagements, Team and Updates stand on their own without a heading — a heading
over a single link is more clutter than help. Updates is deliberately top-level
rather than filed under Settings, since that is where feature requests are filed
and shipped work is reviewed.

**Staff keep a flat sidebar** — they see eight links, where section headings
would outweigh the content. Nothing moved for them and no route changed for
anyone; this is purely how the list is presented.

**Engagements is a placeholder.** The section is visible before it has content
so it does not appear out of nowhere later; opening it explains that the intake
form and proposals are on the way and that clients are still added on the
Clients page meanwhile. Owner-only.
- New-version prompt: a browser tab left open across a deploy shows a small
  "A new version of the app is ready — Refresh" toast (bottom-right) within a
  few minutes, and immediately when you come back to the tab. Click Refresh to
  load the new version. If something that was just fixed "isn't showing",
  refresh the tab first — an old tab runs the old app until it reloads.
- Out-of-date tab protection: if a tab has been open while someone else changed
  something, the app will refuse to save that tab's copy of the workspace rather
  than let it overwrite the newer data. You'll see a "This tab is out of date"
  message with a Reload button. Reloading is the only way forward, and anything
  typed but not yet saved will need to be entered again — that trade is
  deliberate, because saving the old copy would erase everyone else's changes.
  This is rare in normal use: tabs sync with each other automatically, so it
  generally only appears when a tab has been sitting idle or lost its
  connection. It affects owners only (staff never save the whole workspace).
- Most list/board pages have an instant search box: type to filter by name and
  key fields, with a live result count, matched-text highlight, and a clear
  button. Coverage: Clients (name/contact/email/billing type), Contacts
  (name/title/email/phone/company emails/linked client), Plans (name/notes),
  Team (name/email/role), Checklists & Gantt (task title/client — composes with
  the assignee/client/status filters), Delayed (task title/client/waiting note),
  and the Board (client/task title — composes with the Report period). Reports
  and Productivity remain aggregate views with their own filters.
- Report period (shared date range): a "Report period" control on the Time,
  Timesheet, Board, and Checklists pages lets you view a range longer than one
  week. Pick a preset — This week, This month, This quarter, This year to date —
  or Custom with From/To date pickers. The chosen range filters what each of
  those four views shows, and your last-used range is remembered per user (in
  your browser). It's separate from the top-bar billing-month picker, which is
  only for invoicing.

## Dashboard

- At-a-glance cards: overdue tasks, due this week, stuck cases, unbilled hours.
  Each card links to the relevant page.
- "Your queue": checklist items assigned to you that need action.
- Team overview (owner): each member's open/overdue counts, last active,
  link to view their tasks.
- Cases in flight: multi-step cases with current step, who holds it, and a
  Stuck badge when blocked. Click to open the case.
- **"Skipped tasks to review (N)" (owner only)** — this year's quietly-skipped
  recurring tasks, newest first, each showing the task, the client, who skipped
  it, when, which of the three reasons they picked, and their written
  explanation. One button per row, "Reviewed", clears it off the dashboard. The
  section is hidden entirely when there is nothing to review, and it never
  appears for a bookkeeper or an accountant. **Reviewing keeps the record** — it
  is an audit trail, so the row is stamped with who reviewed it and when, never
  deleted. See "Skipping a recurring task" under Checklists.
- Recent activity feed (owner).
- Quick actions: New task, Invite bookkeeper, Add client, Notifications.
- "Viewing as" (owner): preview the app exactly as a specific bookkeeper sees
  it (read-only preview; exit anytime).

## Time tracking (Time page)

- Live timer: pick employee → client → task → describe the work → start/stop.
  The most accurate way to log time.
- **Client, task and detail are REQUIRED before time can be logged.** Nothing is
  auto-filled any more: the description box starts empty and the app never
  invents a "standard" note, so what's saved is only what a person typed.
  - **Starting a timer is still instant** — start the clock with nothing filled
    in and fill the fields in while it runs (from the Time page, the Track
    time button on a client, or the **timer control in the top bar, which is
    on every screen**). Once started, the running clock stays in the top bar
    and keeps ticking as you move around the app; click it to go to the Time
    page to stop and log. The top-bar control can also start administrative
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
    clients and needs no single task — its slices get tasks when it is split —
    but it does need a detail.
  - **The client field starts on "Choose client"** — a placeholder, not a real
    client. It used to open on whichever client sorted first, so time could be
    logged against the wrong one by someone who never looked at the field. The
    placeholder can't be re-selected once you've picked somebody, and the same
    thing happens on both surfaces: the live timer and "Log time manually".
    Because starting a timer needs to know who it's for, **Start timer stays
    greyed out until a client is picked** (it says why on hover) — everything
    else about starting is still instant, with no task and no detail. Not
    applicable to administrative time or to "bill to multiple clients", neither
    of which shows the single-client field at all.
  - **The form clears itself once the time is logged** — client, task, detail,
    the administrative box and any group selection all go back to blank (the
    client back to "Choose client"), so the next entry starts from a clean slate
    and no description is ever logged twice. A blocked or refused Stop & log
    clears nothing: everything typed stays put until the time is actually saved.
  - Editing an entry can't blank a detail that was filled in. Older entries
    saved before this rule (blank description) still load and stay fully
    editable — their minutes, client and date can be fixed as before.
- **AD HOC TIME — one-off work outside what the client is scoped for.** Tick
  **"Ad hoc (outside scoped work)"** and the time is billed on its own invoice
  line at that person's rate, instead of disappearing into the month's hours.
  - Anyone who logs time can set it, on all three surfaces: the live timer
    (tickable while it runs — the answer rides on the timer to the stop and
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
  is pick-or-type, not a fixed dropdown. One box that suggests:
  - that client's open tasks (picking one attaches the time to the real
    checklist, exactly as the old dropdown did),
  - that client's UPCOMING recurring tasks, shown as "Name (upcoming)" —
    choosing one still generates the instance now and attaches to it,
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
    no leftover "un-split" entry.
  - **A tracked group block can be EDITED before it is split** — open Edit on it
    and change the start/stop times, the duration, the date, the description or
    billable, and it stays a group block across all its clients. You do NOT have
    to pick a single client first; the client box offers "Keep as group time (N
    clients) — split it below", and picking an actual client is optional and
    collapses the block to that one client. Split it across its clients after
    editing, as usual. (Previously the form refused to save unless you chose one
    client or marked it administrative, which forced a group block to be
    collapsed just to correct its clock in/out.)
  - Live timer → pick "A group" and the clients, track the block, then "Split
    across clients" on the saved entry (in Recent time) to divide it the same
    ways. (Splitting a running timer happens after stop.)
  - ANY client time entry can be split after the fact — it does not have to
    have been started as a "group". Every entry in Sent back / Recent time has
    a "Split across clients" action (also inside its edit form, next to Save),
    which opens a checkbox list of the clients that person may bill with the
    entry's current client already ticked. Tick the others, choose how to divide
    it, confirm. This is what to use when someone logged time to one client and
    then realized the work covered several.
    - Splitting to a SINGLE client is refused on purpose: that's just moving
      the entry, so use the Client dropdown in the edit form instead.
    - Administrative time can't be split — it has no client. Give it a client
      first.
    - The replacement entries go back into the daily approval queue as
      pending, even if the original was already approved (same rule as any
      other edit to an approved entry). Billable / internal is carried over.
  - A SPLIT CAN BE ADJUSTED AFTERWARD — it is not permanent. Any entry that came
    out of a split shows "Adjust split" (in Recent time / Sent back, and inside
    its edit form) instead of "Split across clients". It reopens the split with
    the distribution that is actually saved: the clients already ticked, each
    one's exact minutes filled in, the mode it was saved with preselected, and
    the current total shown as "was". Change the amounts, add or remove clients,
    switch modes, then save. Switching a reopened split to **By percentage**
    fills the boxes with what is billed today (36m and 24m of an hour show up as
    60% and 40%), so it can be re-divided without any arithmetic.
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
  - Each split entry KEEPS the original block's clock-in / clock-out times, so
    the Raw report shows the real start and stop for split time instead of
    leaving those columns blank.
  - Every split is written to the activity log (who split what, how many
    clients, how many hours).
  - HOW THE SPLIT IS DIVIDED — the modal leads with the two easy answers:
    - **Evenly** — the same share of the block to every client.
    - **By percentage** — type each client's share ("60% / 40%"). The boxes open
      on an even percentage each, the modal shows what each percentage means in
      TIME as you type ("60% — 36m"), and a running line says whether it adds up
      ("Adds up to 95% — 5% left"). The split can't be saved until the
      percentages total exactly 100. Nobody has to work out minutes by hand.
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
    second and always add up. "Full duration to each client" is the deliberate
    exception: every client is billed the whole block.
- Administrative work toggle: internal/company time with no client or task.
- Log time manually: same fields plus date and duration, for after-the-fact
  entries. Manual entries are flagged for owner approval ("manual" badge) and
  notify the owner.
- "Get ahead" tasks: the task box lists upcoming recurring tasks that
  haven't materialized yet (marked "(upcoming)"); picking one generates it now so
  time can be logged against it. Staff can do this for their assigned clients.
- Recent time list: edit or delete your recent entries. The list is scoped by the
  shared Report period (defaults to this month); the live timer and the log form
  aren't affected by it. It shows EVERY entry in range (it used to cap at the 8
  most recent, which silently hid older ones from anyone who logs a lot).
- Both Time-page lists — "Sent back" and "Recent time" — collapse from a chevron
  in their heading and each scrolls inside its own box, so a long list can never
  push the other one (or anything below it) off the screen.
- Editing an entry lets you change EVERY field, not just the time: the client it's
  billed to, the task, the date, the description, billable, the administrative
  toggle, the work sessions AND the hours/minutes duration, and — for owners —
  which team member it belongs to. Picking a different client clears a task from
  the old client (the task list follows the chosen client); switching an entry to
  administrative drops its client/task and makes it non-billable.
- THE TIME ITSELF IS EDITABLE TWO WAYS, on every entry — including ones captured
  by the timer. The edit form offers both:
    - the WORK SESSIONS (clock in / clock out) — when the work happened; and
    - an HOURS + MINUTES duration — what actually gets BILLED.
  They normally agree, so changing a clock time updates the duration with it.
  But TYPING A DURATION WINS: the entry bills exactly what was typed, and the
  clock-in / clock-out times stay untouched as the record of when the work
  happened. (Previously a session-backed entry had no duration field at all, and
  a typed time was silently recomputed from the unchanged clock — so the time
  could not be edited before splitting.) A hint under the field shows what the
  entry will bill and whether that came from the sessions or from you.
- EDIT THE TIME FIRST, THEN SPLIT IT. Adjusting an entry down from 60 to 45
  minutes and then splitting it divides 45 — the split always divides the
  entry's current billed time, and each slice keeps the original clock-in /
  clock-out. This works on a slice too: retyping one slice's duration bills that
  amount without restoring the whole block or disturbing its siblings.
- Typing a duration on a TIMER entry does not turn it into a manual entry — it
  is an edit, and goes through the normal approval queue like any other edit. No
  manual reason is required.
- Saving an edit RESUBMITS the entry for approval: a rejected entry goes back to
  pending, and so does an already-approved one (a changed entry has to be
  re-approved rather than keeping its old sign-off). A save that changes nothing
  doesn't touch the approval state. Bookkeepers still can't edit a locked month;
  owners are exempt, and non-owners can only move an entry onto a client they're
  assigned to.
- Billable vs non-billable is determined by the client's billing setup.
- Weekly-submission gate: staff must SUBMIT (or resubmit) a prior week that has
  logged time before they can log NEW time — time dated in the CURRENT week or a
  future one. A prior week blocks when it's un-submitted (never submitted) OR was
  sent back for changes (rejected) — they get a message naming the week to
  submit/fix. A week that's already submitted (pending owner approval) or
  approved does NOT block, so an awaiting-approval week never locks them out.
- Catching up on a PAST week is always allowed: adding a forgotten entry to, or
  fixing an entry in, any week that has already ended never hits this gate, even
  if an older week is un-submitted or was sent back. (Editing an entry never hit
  it either — adding one now matches.) The only thing that stops a past-week
  change is a LOCKED timesheet month, which an owner has to unlock.
- **Guided "Submit timesheet" flow** (Aug 2026, client request): the submit
  button on the Time page and the Timesheet page no longer sends whatever week
  is on screen. One click opens a prompt that works PAST WEEKS FIRST. If any
  week before this one still needs submitting, the prompt auto-selects the
  OLDEST one, names it plainly ("Submitting week of Sun Jul 26 – Sat Aug 1")
  with its hours, and says how many more past weeks are queued behind it
  ("2 more past weeks still need submitting after this one"). Confirming sends
  that one week; the prompt then advances to the next oldest, and the person can
  close it at any point. A week that was SENT BACK appears in the same queue as
  a resubmit and says so.
- When nothing prior is outstanding, the prompt says "All past weeks are
  submitted — nothing prior to submit." and then asks the completion question:
  "Are you finished logging time for the current week (Sun Aug 9 – Sat Aug 15)?
  Submitting sends it to the owner for approval." — Yes submits it, "Not yet"
  closes. **That explicit yes is the only way the current week gets submitted
  from the app.** The prompt's list of outstanding past weeks uses the SAME rule
  as the weekly-submission gate above (logged time, un-submitted or sent back,
  sealed months excluded), so the prompt and the gate can never disagree.
- If nothing prior is outstanding AND the current week can't be submitted
  (already pending, already approved, or its month is locked), the prompt says
  so and offers only "Done". The server still accepts a submission for any week,
  so an owner can still ask someone to submit early.
- **The "Submit timesheet" button grays out once there is nothing to send**
  (Aug 2026, client request). It used to stay bright and clickable after a week
  had already gone in, which read as "you still owe this." Now, on both the Time
  page and the Timesheet page, the button is disabled — with a tooltip saying
  why — whenever this click has nothing to submit: "Submitted — awaiting
  review." for a week that is pending, "Approved — this week is closed." for an
  approved one, a locked-month message when the month is sealed, and "Nothing
  left to submit — every week you owe is in." otherwise. The reason quoted is
  the week ON SCREEN, so paging to a week that is still owed lights the button
  back up.
- Two cases deliberately keep the button live. A week that was SENT BACK stays
  clickable — that is the resubmit path, and graying it out would dead-end the
  rejection flow. And a week that is pending or approved while an OLDER week is
  still owed keeps the button enabled, because that older week is exactly what
  the weekly gate blocks new time on; the tooltip then names the week the click
  would actually send ("This week is submitted and awaiting review. Submitting
  sends the week of Sun Aug 2 – Sat Aug 8 instead."). That naming applies
  whenever the click would send a week OTHER than the one on screen, including
  when the viewed week is itself still owed but an even older one is queued
  ahead of it ("Submitting sends the week of Sun Aug 2 – Sat Aug 8 first.").
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
  minutes beside it are that entry's own billed minutes. This matters for a SPLIT
  block: each slice keeps the whole original block's clock-in/out as its audit
  trail, so a 25-minute block split across 20 clients shows ~1m 15s per client
  and a 25-minute day — not 25 minutes twenty times. It also matters for an entry
  whose duration was hand-corrected: the page reports the corrected duration, and
  the untouched clock times stay visible beside it. Day totals, the range total
  and the week total are sums of those billed minutes.

## Time Approvals (owner only)

- **TABBED sections.** The page's three areas — **Weekly submissions**,
  **Approval queue** and **Timesheet locks** — used to be stacked, so signing
  off a month meant scrolling past every submitted week and every pending
  entry. Each is now one click away, using the same tab bar as the Checklists
  page. Each tab shows its own pending count in the label: weeks awaiting
  review, entries awaiting approval, and people not yet locked for the month
  shown in the Timesheet locks table (0 for a month that hasn't ended, since
  those can't be locked). The page OPENS on the first tab that has pending
  work, so the queue that needs attention is the one you land on; when
  everything is clear it opens on Weekly submissions. The open tab is in the
  URL (`?section=weekly|queue|locks`) so it can be linked and survives a
  refresh, and an old `#weekly-submissions` / `#approval-queue` /
  `#timesheet-locks` link opens the matching tab. Navigation only — nothing
  about how time is approved, rejected or locked changed.
- **What needs per-entry approval** (changed Jul 2026 per owner request): a
  pure TIMER capture is auto-approved the moment it's saved — it never appears
  in the daily approval queue, and the weekly submission / month lock is where
  it gets reviewed as a whole. Individual daily approval is reserved for time a
  person TYPED: manual entries (which always carry a reason), the per-client
  allocations created by splitting a group time block, and any entry that gets
  EDITED afterwards (editing an approved entry re-queues it as pending — a
  changed client/time/date never keeps its old sign-off silently).
- **AD HOC — the owner's backstop.** Every entry in the approval queue carries
  an **"Ad hoc (outside scoped work)"** tick. Employees set it when they log the
  time; review is where a missed one gets added or a wrong one taken off. It
  saves the moment it's ticked (no need to also approve the entry), because it
  decides how the time bills and the invoice run reads it straight off the
  entry. **Only owners can change it on somebody else's time** — enforced on the
  server, not just hidden in the page. Administrative entries have no tick.
  **An owner ticking it does NOT un-approve an already-approved entry** — the
  flag doesn't change the record of the work, only how it bills, and the person
  ticking it is the approver. (Every other edit still re-queues, and so does
  this one if a bookkeeper changes it on their own approved time, or if an owner
  changes anything else alongside it.)
- Weekly submissions: staff submit a week; approving seals every pending
  entry in it. Rejecting unlocks the week so the bookkeeper can edit and
  resubmit.
- Reopen an approved week (undo an approval): a "Recently approved" list on the
  Time Approvals page shows the latest approved weeks, each with a "Reopen"
  button. Reopening un-approves the week — the submission goes back to pending
  (re-entering the review queue) and that week's sealed entries become pending
  and editable again. (If the month is ALSO locked, unlock it in the Month-end
  section — the two are independent; unlocking a month is what actually lets
  staff edit that month's time.)
- Weekly review modal: expand any individual entry; per-entry actions —
  "Approve this entry" or "Send back with note" (the note is required and the
  bookkeeper sees it). The owner does not edit staff time directly.
- Sending an entry back NOTIFIES the bookkeeper: rejecting a time entry gives its
  owner an in-app bell + email naming the client, the date, the hours and the
  owner's reason, linking to the Time page to edit and resubmit. (Previously
  rejection was silent — the only trace was a red note in their Recent time list.)
- A team member sees ALL of their own time — client work for clients they're
  assigned to, administrative time, AND unsplit GROUP holding entries. A group
  block has no single client (its members sit in the group list until it's split
  for billing), so it used to fall outside the client-scoping rule and vanish
  from the bookkeeper's own view: they couldn't see, edit or split time they had
  tracked, and their totals came up short of what the owner saw for the same day.
  Only the member COUNT is shown, never the member client names.
- "SENT BACK" section (Time page): a dedicated panel at the top of the Time page
  listing every one of YOUR entries an owner returned, so they're found and fixed
  in one place. Unlike the Recent time list it is NOT scoped by the report period
  and NOT capped, which is what previously hid them — Recent time only renders the
  8 most recent entries, so anyone who logs a lot never saw their rejected ones.
  Oldest first (longest outstanding first), each with the owner's reason and the
  normal editor; "Edit & resubmit" sends it straight back for approval without
  resubmitting the week. The whole section is hidden when nothing is sent back.
- "N sent back" badge: individual entries can be returned while the WEEK's
  submission stays "pending", so the week status alone never reveals it. Both the
  Time page week bar and the Timesheet week controls show a red "N sent back"
  count for that week whenever any of its entries are rejected. Editing a
  sent-back entry resubmits it (back to pending) automatically.
- Every approval surface shows CLOCK IN → CLOCK OUT for each entry (both the
  week-review list and the individual approval queue), with per-session rows and
  each session's length when a day was split, so hours can be audited against
  when the work happened. Timer and older entries that predate the sessions model
  fall back to their start/stop stamps rather than showing nothing.
- Approval queue: filter Pending / Rejected / All individual submitted entries.
- Timesheet locks: lock a month per employee — pending entries are
  auto-approved and the employee can no longer change that month. "Lock all"
  locks everyone at once. Locking is the month-end sign-off. Only a month that
  has ALREADY ENDED can be locked — the current (in-progress) or a future month
  can't be, since that would block everyone from tracking time in it (the
  per-row Lock button and "Lock all" are hidden for such months; the server
  rejects it too). Unlocking any month always works.

## Checklists (tasks)

- **Overdue work is PINNED to the top of the page, above everything.** When you
  have anything past due, a slim red "Overdue" bar with a count is the first
  thing on the Checklists page — collapsed by default so it signals without
  shouting. Click the bar to expand it into one row per late task: the
  business, the task, when it was due and how many days late it is, and whose
  task it is. Longest-overdue first. It starts collapsed on every visit; when
  nothing is overdue there is no bar at all.
  - **Nothing can bury it.** It sits above the tabs, so it shows on every tab;
    it ignores the assignee/client/status filters, the search box, the group-by
    choice and the report period. Those all narrow the list below — the whole
    point of the panel is that none of them reach it. (The panel's count is of
    the tasks IN the panel, so it can differ from the "Overdue" section count in
    the list below, which the report period and filters do narrow.)
  - **Clicking a row takes you to that task's card** in the In progress list and
    clears whatever was hiding it: it switches back to the In progress tab,
    clears the filters and the search box, and shows the task even when it falls
    outside the current report period. **It does not change your report period**
    — that setting is shared with the Timesheet, where a changed range would
    break the weekly submit; the one task you jumped to is simply let through.
  - Late tasks appear **twice** on purpose: once in the panel, once in their
    normal place in the list. The panel is the nudge; the list is where you
    actually work.
  - **A skipped cycle never appears there.** A task deliberately moved to its
    next occurrence is not late, so it is not in the panel — same rule as
    everywhere else in the app.
  - **When nothing is overdue the panel is simply absent** — there is no "all
    caught up" banner. Not seeing it IS the good news.
  - Each person sees their own scope: staff see their own overdue tasks, the
    owner sees the whole firm's.
- **The page is split into four TABS: "In progress", "Repeating", "Standard"
  and "Completed"**, each showing a count. They used to sit stacked on top of
  each other, so getting to a repeating task meant scrolling past every
  in-progress checklist (hundreds of them). Now each is one click away.
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
    and those old moments cannot be recovered. Rather than print a made-up date
    on an audit screen, older rows show a dash, with a note under the table
    saying why. Everything completed from now on carries a real timestamp.
    Setting a date range hides the dashed rows, since an unknown date can't be
    said to fall inside a window; the tab says so when a range is set.
- **THE PERIOD A TASK'S WORK COVERS, shown next to its title.** A recurring task
  can carry a small label naming the period it is FOR — "July 13 – August 13,
  2026" on a task due at the end of August — so a stack of similar-looking
  monthly tasks can be told apart at a glance. It sits beside the task title on
  the checklist card.
  - **Off unless it was turned on for that repeating task.** Like skipping, it
    is a setting on the repeating setup itself ("Show the period it covers"),
    chosen when the task is created and changeable afterwards on the Repeating
    tasks list. Most tasks do not have one, and a task without one shows
    nothing at all — no empty space, no dash.
  - **You pick the dates.** Beside the switch you set the FIRST period the task
    covers — a From and a To, for example July 13 to August 13. That is the only
    thing to fill in.
  - **It advances on its own, by however often the task repeats.** The next
    occurrence reads "August 13 – September 13, 2026", the one after that
    "September 13 – October 13, 2026", with nothing to reset or roll over. A
    quarterly task steps a quarter, a yearly one steps a year.
  - **It is the same behavior as covered dates on a reimbursed expense** — set
    the first window once and every cycle after it moves itself — and it is
    worded the same way on screen, so the two read alike.
  - **Changing the dates re-anchors from the next occurrence on.** Occurrences
    already created keep the label they were born with.
  - **IT IS ONLY A LABEL.** It does not change anything: not the due date, not
    which month work is billed in, not any report, total, filter or sort. It is
    there to be read. Turning it on for a repeating task changes nothing about
    the tasks it creates except that they now carry the label.
- **Skipping a recurring task (a "quiet skip").** When someone won't complete a
  recurring task this cycle but will catch it on the next occurrence, they can
  step past this one instead of letting it sit there flagged as overdue.
  - **Skipping is OFF unless it was turned on for that repeating task.** It is a
    setting on the repeating setup itself ("Allow skipping an occurrence…"),
    chosen when the task is created and changeable afterwards on the Repeating
    tab. Repeating setups are owner-managed, so the owner is the one who decides.
    **With it off there is no skip button at all** — not a greyed-out one — so
    nobody is invited to ask for something that was never on offer.
  - **One-off tasks are never skippable**, because there is no next occurrence to
    catch them on. Skipping only exists for repeating work.
  - **What the person doing it sees:** a "Skip this cycle" button on the task
    card, and one small form — a required dropdown for **who couldn't complete
    it (me / a colleague / the client)** and a required written explanation.
    Nothing else happens: no approval to wait for, no block. The task leaves
    their active list for this cycle and that's the end of it for them.
  - **The next occurrence still generates exactly as normal**, on its own due
    date, open and unskipped. Skipping one cycle changes nothing about the
    schedule.
  - **A skipped task does not read as overdue anywhere.** The overdue rules are
    unchanged — a skipped occurrence simply isn't in the lists they read, because
    it was deliberately moved on rather than missed.
  - **Who gets told:** the owner every time, and an **Accountant** when a
    **Bookkeeper** skips a task on a client that accountant is assigned to. (Same
    substitution as everywhere else in the app: there is no supervisor field in
    the data, so "their bookkeepers" means "the people on the same clients".)
    Both are ordinary in-app notifications plus the usual email, and both can be
    turned off per person under Settings → Notifications ("Skipped recurring
    tasks").
  - **The owner reviews them on her Dashboard** — see "Skipped tasks to review"
    there. Marking one reviewed clears it off the dashboard and keeps the record
    permanently.
  - **A skip is not a deletion and not a completion.** The task is still there,
    still attached to its time entries and its history; it is simply out of the
    way for this cycle.
- **When a team member creates a task, the owner is notified.** The notice names
  the task and the person, so she can decide whether skipping should be allowed
  on that kind of work. (Repeating setups — where the skip setting actually
  lives — are owner-managed, so this is what tells her there is a call to make.)
- **When a step is completed is now recorded.** Ticking a step stamps the
  completion time; un-ticking it clears the stamp (a re-opened step has no
  completion date). Adding a sub-step to a finished item re-opens it and clears
  the date the same way. The stamp survives ordinary saves — a background
  workspace save can neither erase a completion date nor invent one.
- A checklist = a task for a client: title, client, assignee, due date,
  frequency (one-off, weekly, monthly, quarterly, annual), steps.
- Steps support sub-steps and sub-sub-steps, drag-to-reorder, per-step due
  date and per-step assignee ("Same as checklist" by default), and checkboxes.
- "Paste a list" turns pasted lines into steps in one go.
- Each checklist card leads with the CLIENT NAME (bold + larger) and shows the
  checklist name just beneath it, so a long list is easy to scan by client; the
  due date is bold. (On a client's own detail page the client name is already
  obvious, so the card leads with the checklist title there instead.)
- Adding a task to a live RECURRING instance asks the owner where it should go:
  "This checklist only" (just this instance) or "This + all future" (also added
  to the template's matching stage, so every future instance includes it). Both
  "Add an item" and "Paste a list" use this prompt. Non-owners, and non-recurring
  (one-off) checklists, add to the current checklist directly with no prompt.
- Group the page by due date or by client; filter by assignee, client, status.
- Waiting on (the hourglass ⏳): flag a step as waiting, write who/what it's
  waiting on (free text), optionally pick the SPECIFIC other task it's waiting
  for — when that task completes, the blocked step's assignee gets an in-app +
  email notification ("Ready to continue"). That picker offers **only this
  client's other tasks that you can actually open** — never the whole workspace,
  so there is nothing unrelated to scroll past. Skipped occurrences are left out
  (a skipped task never completes, so the ping would never fire), as are tasks in
  the recycle bin and other people's tasks you aren't on; an internal task with
  no client sees only the other no-client tasks. A link **already saved** is the
  exception to all of that: it stays in the list and selected even if that task
  belongs to another client, has since been skipped or recycled, or isn't yours
  — a cross-client one shows its client's name in brackets — so opening the
  editor can never quietly break an existing dependency. The task you pick is
  part of the wait you're composing — it saves WITH it (see "Creating a wait is
  Save" below) and is fixed afterwards. Waiting items also appear on the Delayed
  page.
- Resolving a waiting step — **Done vs Clear** in the waiting editor. These two
  belong to a step flagged waiting the free-text way, with **no saved wait live
  on it**; the moment a wait is saved they both disappear (see the lock below).
  **Done** retires the flag and keeps the waiting note visible on that checklist
  as a "Was waiting on: …" record (that instance only — future recurring
  instances start fresh), so there's a history of what the team keeps waiting on.
  Done does **NOT** check the step off — completing the work stays with the
  normal checkboxes (owner feedback: the reference should sit on the still-open
  step). **Clear** just un-flags and erases the note. Resolved steps stop
  counting on the Delayed page and the Board's pending chips. If the server
  refuses anything, the reason appears in red inside the waiting editor instead
  of the button appearing to do nothing.
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
  delete it, which meant the name of whoever did the check disappeared the moment
  they finished. Now a wait moves through three states and is never destroyed:
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
- **A saved wait can never be removed — by anyone.** There used to be a **Cancel**
  (the ×) that erased it outright. It is gone, and so is the route behind it: a
  wait is the shared record of who asked, who did it and who confirmed, so
  removing one would take that receipt away from everybody on it, not just from
  whoever pressed the button. Nothing in the app deletes a wait, and the old
  `cancel` request is refused server-side with the reason ("A saved wait is the
  record of who asked and who did it, so it stays on the task. Mark it done and
  approve it instead."), so an old browser tab can't do it either. The way out of
  a wait is forward: Mark done → Approve, or Send back for another lap. The record
  — who asked, who did it, who confirmed, and the dates — stays on the task
  permanently through every stage.
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
  checklist step, so they never have to go looking for it: **Question**, which
  opens a message box. Sending it does **NOT** complete the wait — the item stays
  right where it is on their list, still their move. Every question is kept on
  the wait (attributed and timestamped, alongside the send-back history) and
  whoever asked gets a notification with the question in it, so they can answer;
  the step's assignee and the person being waited on are told too, so a question
  an owner sends on someone's behalf is never invisible to them. The LATEST
  question shows on both sides — on the Delayed page and on the checklist step —
  so nobody has to remember what was asked. A wait on the CLIENT has no Question:
  a client has no login to read one.
- **Creating a wait is Save, and it is final.** The first click on "Waiting on…"
  opens an editor and commits **nothing**. You pick the person (or the client),
  type the message that goes WITH the wait, and optionally choose the other task
  it's waiting for — all three are held on your screen until you press **Save**,
  which writes them in one go. **Clear** discards the whole draft if you opened
  the picker by accident: nothing is created, nothing is notified, and nothing
  the step already had is touched. Clear is only available before Save.
- **Save locks everything.** Once a wait is saved, the person or client it names,
  its message and the task it waits for are all fixed — "all info is locked and
  cannot be changed." On a step carrying a live wait the editor no longer shows a
  note box, a task picker, a Clear or a Done at all; the saved task link still
  READS ("Waiting for: <task>") so you can see the dependency. The only controls
  left are the wait's own: Mark done, Question, Approve, Send back. The server
  enforces the same rule rather than trusting the screen — an attempt to change
  the step's waiting note, its task link, or to un-flag it while a wait is live
  is refused with the reason ("This wait was saved, so who it names, its message
  and the task it waits for are fixed. Mark it done and approve it instead."), so
  an old browser tab can't do it either. Adding a SECOND wait to the same step
  still works, but it cannot be used as a way in: the composer for it offers no
  task picker, and the server refuses a create that would change the locked link.
  Renaming the step, changing its due date or reassigning it are untouched by the
  lock — they're the step's business, not the wait's. The lock lifts once every
  wait on the step is approved, so a step whose hand-offs are finished can be
  tidied up normally.
- **Save is a request, and the app waits for it.** Save stays disabled until the
  wait is actually created, so a double-click on a slow connection can't create
  two permanent waits; if the server refuses, everything typed stays on screen
  beside the reason instead of being thrown away.
- **A wait cannot be lost to an unrelated save.** Waits are written only by the
  waiting-on buttons. Every other save — including the big background one the app
  does as you work — leaves them exactly as they are on the server, whatever the
  saving tab happened to have loaded. So a wait can't be flattened by somebody
  else's autosave, and neither can the note, task link and flag it locked.
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
  alongside the team. You never choose which client — the task already belongs to
  one. Because a client has no login, there is nobody to hand back to and nobody
  to notify: it is a single press ("Heard back") by whoever flagged it or the
  step's assignee, and it closes out in one go, keeping the same record of who
  cleared it and when.
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
  assignee/editor/assigned-staff can open the editor. Delete task — for the OWNER it
  moves the task to the owner-only Recycle bin immediately (time entries preserved,
  restore anytime until emptied). For STAFF, deleting — a whole checklist OR an
  individual step/sub-step — files a deletion REQUEST that an owner must approve;
  nothing is removed until then. The owner sees a "Pending deletion requests" queue
  at the top of the Checklists page (both whole-checklist and per-item requests) with
  Approve (delete) / Reject (keep), and gets a bell notification when a request is
  filed; the requested task/item shows a "Deletion requested" badge to staff until
  resolved. Owners delete immediately (they're the approver).
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
- Sharing/visibility: a team member assigned to a client sees ALL of that
  client's tasks on the shared board and can LOG TIME against any of them. But
  SEEING is not EDITING. **Only the task's assignee, a named editor, or an owner
  can change a checklist** — rename it, change its due date or assignee, add,
  edit, reorder or delete steps, or flag a step as waiting. A colleague staffed
  on the same client gets a read-only card; the server refuses the write with a
  403 either way. (Before, sharing a client was enough to edit a co-worker's
  live checklist.) A step handed to one person specifically can be edited by
  that person. Staff can still CREATE a one-time task for any client they're
  assigned to (the "New task" button on the Checklists page). Owners can
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
  - **Checklists → Standard** — blueprints are owner-edited. An accountant can
    view one and copy it to a client (the usual "Copy to client" picker); a
    bookkeeper views only.
  - **Gantt** — your own lane and your own tasks only.
  - **Open/late task counts on the Clients list** — your own open tasks. An
    ACCOUNTANT also sees those of the people staffed alongside them on their
    clients. (There is no supervisor field in the data — "the bookkeepers you
    oversee" is read as shared client assignment.)
  - **Board** — your own active checklists, same as the Checklists tab. An
    ACCOUNTANT can tick "Show my bookkeepers'" to fold in the work of the people
    staffed alongside her on her clients; their cards are tagged with whose they
    are and stay read-only. (It used to be the whole shared board — every
    colleague's task on every client you share. That's what the owner spotted
    reviewing as a bookkeeper.)
- Recurring checklists (the repeating "recipes") — team members can VIEW the
  recurring checklists for the clients they're assigned to in TWO places:
  (1) the main Checklists page has a read-only "Recurring checklists" section
  (under "Your clients") grouped by client, collapsible, searchable, each recipe
  showing its cadence + next due date and its steps — so staff see what's coming
  up on their clients right where they work, without drilling into each client;
  and (2) each client's detail page has its own "Recurring checklists" section
  plus an "Upcoming (next 60 days)" list. Both exist so staff know what exists
  and don't create duplicates. A repeating checklist also can't generate the same
  task twice for the same due date any more — one period gives exactly one task,
  no matter how many people have the app open at once, and "Generate a task now"
  on a date that already has one just opens the existing task instead of making a
  second. Staff can't create, restructure, or turn recurring
  recipes on/off (that stays owner-only) — but they CAN add steps, both to the
  already-generated checklist instances and (via the "this + all future" prompt)
  APPEND a step to the recurring recipe itself for a client they're assigned to.
  Appending is the only recipe change a non-owner can make; editing or removing
  existing recipe steps remains owner-only, and standard (client-agnostic)
  blueprints stay owner-only entirely.
- Standard templates (the firm's client-agnostic blueprints) are visible READ-ONLY
  to every team member on the Checklists page ("Standard templates" section) — they
  can browse the standard steps but only an owner can EDIT a blueprint.
- **Accountants can apply a standard checklist to their own clients.** Previously
  every apply was owner-only and an accountant had to ask. Now a team member whose
  staff role is **Accountant** gets the same "Copy to client…" control on standard
  blueprint rows, with two limits: it works for **standard blueprints only** (not a
  template bound to another client), and only onto a **client they are assigned
  to**. Bookkeepers are unchanged and still ask an owner. Owners are unchanged and
  can apply any template to any client. Both limits are enforced on the server, so
  they hold no matter what the page shows.
- **Copy a template onto a client from the Checklists tab.** Every template row —
  standard blueprints on the "Standard" tab AND recurring templates on the
  "Repeating" tab — carries a "Copy to client…" button on the row itself (no need
  to expand the row first; owners on any row, accountants on standard rows). It
  opens a client picker; choosing a client creates a new recurring checklist on
  that client from the template's stages and steps, and the row confirms with
  "Copied to <client>". Same copy used everywhere, so a standard blueprint and
  another client's recurring checklist copy the same way.
- Owners can apply a template **directly from the Clients page** too: every client
  row has a "Template" button that opens a picker of standard templates and
  recurring templates copied from other clients, and applies the chosen one to that
  client (same underlying copy as the Checklists page's "Copy to client…"). Works
  for brand-new clients the moment they're added to the list.
- Time logged against a task shows on the card.

## Board — Active Checklists (sidebar: "Board")

- A second view of the active checklists, grouped **by service type** ("service
  categories" — e.g. Monthly Bookkeeping, Quarterly Bookkeeping, Sales Tax,
  Payroll). The sections lay out as a **wrap grid** (client feedback, round 2):
  as many groups per row as the screen fits (each at least ~320px wide),
  wrapping to the next row when a row is full, and the page scrolls vertically
  to reach lower rows — one column on a narrow screen, several on a wide one.
  Each section lists the **clients that still have open work** of that type; a
  count badge shows how many.
- Each client row is **collapsible** — expand it to see and work the client's
  live checklist(s) for that column (same checkboxes/cards as the Checklists
  page). Completing a client's checklist **removes that client from the column**
  automatically, so the board always shows what's still open.
- **Report period** at the top (the shared date-range control): the board is a
  horizon — a checklist shows when it's due on or before the END of the selected
  period (`to`), so overdue work stays visible and the view widens as you pick a
  larger range (week → month → quarter → year-to-date → custom).
- **Due vs pending at a glance:** every checklist on the board carries a status
  chip — grey "Due <date>", red "Overdue — was due <date>", or amber
  "Pending — <reason>" when any open step is flagged waiting (the reason is the
  waiting note, or who it's waiting on; hover shows all reasons). Collapsed
  client rows roll these up as "N pending" / "N overdue" chips, so the board
  answers "what's still due, what's stuck, and why" without expanding anything.
- **Filters:** alongside the client filter there's a **team-member filter**
  (shows only checklists assigned to the selected member(s); both are
  multi-select and compose with search and the Report period). **"Show
  upcoming" now defaults OFF** — the board opens with real, materialized work
  only; tick the toggle to overlay the faded upcoming (projected) items.
- **Scoping — whose work you see:** the standard board is **only the checklists
  you're active on** (the task's assignee, or someone the owner named a viewer
  on it) — a bookkeeper sees hers, an accountant sees hers. The OWNER still sees
  the whole board. Staff also only ever see clients they're assigned to, same as
  the rest of the app. The board is available to everyone, not owner-only.
- **"Show my bookkeepers'" (accountants):** a toggle beside "Show upcoming",
  offered only to an accountant who actually has people under her. Ticking it
  folds their checklists onto the board, each tagged with whose it is and faded
  so it never reads as your own; untick to go back to just yours. Their cards
  are read-only — seeing is not editing, and the server enforces that anyway.
  There is no supervisor field in the data, so "the bookkeepers under her" is
  read as **the people staffed alongside her on her clients** — the same
  substitution the open/late task counts on the Clients list make.
- **Filter by client:** a "Filter by client" dropdown in the board toolbar
  narrows the board to one or more selected clients (multi-select checkboxes);
  "Clear" (or no selection) shows all clients again. It only lists clients that
  currently have work on the board, and hides itself when there's ≤1.
- **Which column a checklist lands in:** set its "Board column" on the repeating
  template (or one-time task) — generated checklists inherit it. Anything with no
  column shows in an "Uncategorized" column.
- **Setting the column later still fixes old tasks:** checklists that were
  generated BEFORE their repeating template was given a Board column used to sit
  in "Uncategorized" forever, even though the recurring checklist itself showed
  the right board. They now follow their template's current column automatically,
  so tagging the recipe is enough — there's nothing to re-tag one by one. A
  checklist you moved by hand keeps where you put it and is never pulled back.
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
- **The list is now yours, not the whole firm's.** It shows waits that are
  actually your move or that you are held up by — the ones you are being waited
  on for, plus the ones you asked for or own the step for. Marking your part done
  takes it off your list and moves it onto the asker's to confirm; confirming
  takes it off theirs. This applies to owners too, so a firm-wide "everything
  that is stuck anywhere" view is no longer on this page.
- **Leaving this page is not disappearing.** A confirmed wait is resolved, so it
  correctly drops off everyone's Delayed list — and at the same time it stays on
  its checklist step as a completed, struck-through sub-item naming who asked,
  who did it and who confirmed it (see Checklists). The two are different places:
  this page is what's still stuck; the step keeps the history.
- An older free-text wait with nobody attached to it still shows to the step's
  assignee (or to everyone if the step has no assignee), so nothing that predates
  the two-step hand-off silently vanishes from the page.
- **Two tabs: "Waiting on me" and "I'm waiting on others."** Same underline tab
  bar as Time Approvals, with a live count in each label; the page opens on
  whichever has work (clicking the quiet one sticks — it won't bounce back).
  - **Waiting on me** — someone is blocked on you. Each wait has two buttons.
    **Done** says "my part is finished": the wait leaves this list and goes back
    to whoever asked, who has the final say. It does NOT tick the checklist step
    off. **Question** opens a message box and sends what you type to whoever
    asked — it finishes nothing, so the item stays right here and stays yours;
    they get a notification with your question in it, and the question is kept on
    the wait for both of you to read. (A wait on a client has no Question — a
    client has no login.)
  - **I'm waiting on others** — waits you asked for (and waits on a client). While
    the other person hasn't finished, the row is a **read-only reminder**: no
    Done, no buttons, just what you're waiting on and why. Once they mark it done
    the row gains exactly two buttons, **Approve** and **Send back**.
  - One step can appear on both tabs at once with different waits on each — being
    owed something and owing something on the same step is normal.
- **Send back ("not approved").** Instead of approving, you can send a wait
  straight back with a note saying what still needs doing. The note is required.
  It returns to the other person's "Waiting on me" tab with a Done again, and
  they're notified the same way as the original request. Nothing is overwritten:
  the original note stays, and every send-back note is kept in order alongside
  who had reported it done and when. You lose the two buttons again until they
  re-report it finished.
- The step's own "Done" toggle survives on this page only for an OLD free-text
  wait, which has no wait record to resolve. A completed step drops off the list
  (done steps aren't shown).

## Clients (owner manages; staff see assigned)

- Client list: contact, billing type (Hourly / Monthly subscription / Annual),
  rate, assigned team, plans/services. The assigned team shown here now comes
  from one stored field — for any client whose team had drifted between the two
  old representations, this column changes the moment that ships, to match who
  can actually see the client.
- Add client: a "+" Add client button in the top-right of the page header
  (opposite the "Clients" title, above the search bar; owner only) opens an
  Add-client modal. Fields: name, primary contact,
  billing type, monthly/annual rate (for subscription/annual clients), estimated
  monthly hours per role (informational only — never affects invoices), assigned
  bookkeeper(s), other contacts, plans/services. NOTE: there is no per-client hourly rate
  anymore — Hourly clients are billed off each team member's own bill rate (set
  on the Team page). **The team picked on this form can see the new client
  immediately** — assignment saved here is the same one visibility reads, so
  there's no separate step of an owner re-picking the team on the client's own
  page afterward. Right after saving, a prompt asks "Open their checklist
  now?" — choosing yes jumps straight into the new client's checklist + notes
  modal. (Contacts and Plans have the same "+" add-in-a-modal flow.) The header
  (title + "+" + search) stays pinned to the top as you scroll the list, so the
  add button is always reachable.
- **Primary contact is a real contact, chosen from the directory.** It used to
  be a free-text box: the name was stored on the client, and only on some later
  page load did a repair step quietly turn it into a bare contact record (no
  email, no phone). So right after saving there was nothing in Contacts to find,
  and typing a variant of a name already on file ("Britt" for "Brittany
  Ferguson") produced a second, emptier record. Now:
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
- Client detail page (owner): everything about one client in one place, split
  into four TABS instead of one long scroll —
  **Overview** (client name, contacts & address, assigned team, logo, notes),
  **Billing** (rate and services, plan checklists, recurring reimbursements,
  expenses & reimbursements, invoice customization),
  **Checklists** (active checklists, recurring checklists, recent checklists),
  and **Time** (this client's time entries). Overview opens by default. The
  Checklists tab shows the number of open checklists and the Time tab the number
  of entries logged this month. The tab is in the URL (`?tab=time`), so a client
  page can be linked straight to a tab, and older `#client-section-…` links open
  whichever tab now holds that section.
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
  entries. They get the same tabs MINUS Billing (every panel in it is
  owner-only, so the tab isn't shown at all — and a `?tab=billing` link opens
  Overview for them). Owner-only sections (billing rates, plan checklists,
  reimbursements/expenses, branding, invoice settings, assigned team) and the
  Delete-client action are hidden, and financial fields are stripped from their
  data server-side.
- Client notes: a timestamped, attributed notes log on each client. The owner
  and the client's assigned staff can read and add notes; you can delete your
  own note (the owner can delete any). Notes support lightweight rich text
  (bold, italic, bullet/numbered lists, links) via a small formatting toolbar.
  Notes persist independently of the bulk autosave so staff can add them.
- Quick access from the client LIST: each row has a "Checklist" button that
  opens a modal with that client's active (editable) checklists plus the notes
  panel (add + history) — no need to open the client and scroll. The button is
  tinted green for clients that currently have active checklists, so open work is
  visible at a glance. **Beside it, each row shows that client's open task count
  and — only when there is one — a "late" count** (e.g. "2 open · 1 late"), so
  outstanding work per client is readable without opening anything. The late
  count is a SUBSET of the open count, never a separate total: "2 open · 1 late"
  means one of those two is past its due date, not three tasks. A task counts as
  late if its due date has passed, including when an unfinished STEP inside it is
  due earlier than the task itself — the same rule the Checklists page's
  "Overdue" section uses, so the two can never disagree. A client with nothing
  open shows no counts at all. Right next to it is a "Note" button that opens a
  notes-only modal (add a note + read history) for anyone who just needs to jot
  a note. A third "Time" button opens a TRACK-TIME modal for that client without
  leaving the list: shows how much time is logged for them this month, lets you
  pick a task and a note, and starts the shared
  timer. Both boxes may be left blank to start the clock right away — the task
  and detail are required only at Stop & log, and can be filled in on the Time
  page while it runs. It is the same timer the Time page drives, so it keeps running as you navigate
  and stops there as usual. Only one timer runs at a time, so if one is already
  going the modal says so and offers the Time page instead. All three buttons
  work for owners and assigned staff (bookkeepers / accountants) on any client
  they can see.
  - The "Time" modal's TASK box is pick-or-type, not a fixed dropdown: it
    suggests that client's open tasks AND every STANDARD task in the workspace
    (the client-agnostic blueprints on the Checklists page's "Standard" tab),
    de-duplicated by name with the client's real task winning a tie — and you
    can type anything that isn't listed, which is used exactly as typed. Picking
    one of the client's own open tasks still attaches the entry to that real
    checklist; a standard task or a typed name is stored as the entry's
    free-text task name (the same field used when a client has no open task), so
    it shows in the task column on reports instead of being lost in the notes.
    Leaving the box empty means no task, as before.
- The client's "Active checklists" section has a "Due this month" toggle that
  filters to checklists due in the current calendar month (with a count).
- Client lifecycle / onboarding (owner): every client has a stage —
  Proposal → Onboarding → Active (existing clients are Active). The Clients list
  has stage tabs (Active · Onboarding · Proposal · All, defaulting to Active, with
  counts) and each row shows a stage badge. "Start onboarding" on a client builds
  a 3-stage onboarding checklist (Proposal / Onboarding / Client) and moves the
  client to Proposal. That button only shows on clients who aren't Active yet
  (Proposal or Onboarding) — an Active client is already onboarded, so it's
  hidden there; as the team completes each stage of that checklist the
  client automatically advances (Proposal → Onboarding → Active). The owner can
  also set a client's stage directly. New clients can be added straight into any
  stage (defaults to Active). Staff see the badge but don't manage stages.
- Inactive clients (owner): a client who has left is retired rather than
  deleted. "Mark inactive" sits on each client row and on the client's own page
  (next to Delete), asks for confirmation naming exactly what changes, and sets
  the client's stage to Inactive. "Reactivate" is in the same two places and
  puts them straight back to Active. Both are written to the activity log.
  - What an inactive client is hidden from: the Clients list (they move to
    the "Inactive" tab, with a count, and are gone from Active/Onboarding/
    Proposal — "All" still shows them); the staff Clients list entirely; the
    time-tracking client pickers (timer, group timer, manual entry, the
    split-across-clients list, the Track time modal, and the client dropdown
    when editing an entry); the "For which client" picker when creating a task
    or recurring checklist; template copy targets; the Team page's "+ Add
    client"; and the Invoices billing queue and its client picker.
  - What is NOT touched: every time entry, checklist, invoice, note,
    reimbursement, contact link, plan, and assigned-team member stays exactly
    as it was. Nothing is deleted, and reactivating restores the client with
    all of it intact — the stage flag is the only thing that changed.
  - What still shows them: reports and analytics for any period they have data
    in, timesheets, time approvals, Client Recap, the Board and Gantt filters,
    invoice history (including the monthly archive), and their own client page,
    which stays fully viewable across all tabs with an "Inactive" banner.
  - What stops happening: their recurring checklists generate no new instances
    (existing ones stay open and visible, and generation resumes on
    reactivation), and the monthly invoice run skips them (existing invoices
    are untouched). The Start onboarding, Track time, Template and "Add
    recurring checklist" buttons are hidden while they are inactive. Inactive
    clients are not counted as a To-100% setup problem — retiring a client is
    an intended state, not an unfinished step.
- Assigned team controls which staff can see/log time for the client. An owner
  can be listed on a client's assigned team too — it records who works the
  account, but grants the owner nothing extra: owners already see and can act
  on every client regardless of assignment.

## Client Recap (owner only)

- A per-client review page (sidebar: "Client Recap") with a **Monthly /
  Quarterly / Yearly** toggle and prev/next period navigation — the arrows step
  by whichever one is active, so Yearly moves 2026 → 2025. A quarter is three
  calendar months, a year is the calendar year (Jan 1 – Dec 31); nothing is
  fiscal or prorated.
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
  A role with no estimate, or no pay rate (the owner), shows an em dash rather
  than a variance against zero; the labor-cost basis line prints under the
  table. It replaced four stat tiles (total hours, billable,
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
  A role with hours but **no** estimate shows an em dash rather than a variance
  against a zero nobody typed — its hours still count toward the Total (unplanned
  work is still over plan), and the page says so in a line under the table.
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
- **Labor cost counts team members who have a pay rate on file; owner time
  carries no hourly cost.** The recap used to withhold margin entirely — showing
  "—" — whenever anyone who logged time had no cost rate. Because the owner
  correctly has no cost rate (she draws no hourly wage) and works on most
  clients, that blanked margin nearly everywhere: on August 2026 data she had
  logged time on 31 of the 34 clients with any. Someone with no rate now simply
  adds nothing to labor cost, which is exactly how the payroll report and every
  cost figure elsewhere have always treated them — the recap was the odd one
  out. **Margin is now always a figure**, and a client the owner works alone
  shows its full fee as profit. The reason is printed on screen under every
  cost and profit figure so the number is never a puzzle.
- **Every hours figure on the recap reads as x.xx** — the totals and each
  person's row. Those printed per-person hours are also what labor cost is
  priced from: pricing each person's shown hours at their cost rate and adding
  the results gives the recap's labor cost exactly (see "HOW LABOR COST IS
  CALCULATED" under Reports).
- **The role table is in a FIXED order that does not move month to month:**
  CFO tier first, then Accountant, then Bookkeeper, then anyone whose role isn't
  set. Where a role is filled by several people, their names read alphabetically
  inside the row. It used to sort by hours, so the list reshuffled every month
  as workload moved. The tier comes from the
  team member's staff role: **Owner → CFO, Accountant → Accountant, Bookkeeper →
  Bookkeeper** (the app has no separate "CFO" staff role; CFO is the name used
  for the owner's own tier, matching the client's estimated CFO hours field).
  A role that nobody logged time in AND that has no estimate simply doesn't
  appear — no zero row is invented — while a role that WAS estimated and never
  worked does appear, at 0.00h actual, which is how "we planned eight hours of
  CFO time and did none of it" gets caught. The roles that are present keep
  their order regardless.
- **Revenue here is now the same number the invoice bills.** It used to value an
  hourly client's time at that client's single hourly rate, but invoices have
  charged each team member's own bill rate since June 2026. On July 2026 data
  the two disagreed for 16 of 19 hourly clients — in both directions, so it was
  not a consistent offset: one client read $4,400.83 in Recap against a real
  invoice of $3,837.58, while another read $894.13 against $1,252.69. Recap and
  the invoice are now produced by one shared calculator, so **profit figures for
  hourly clients have shifted, some up and some down** — the new numbers are the
  correct ones. Monthly and annual clients are unaffected. A quarter or a year
  is summed month by month rather than estimated as a rate times three or twelve.
- **Estimated vs. actual** — the comparison that catches an overrun while it is
  still happening. There is **no separate "Estimated vs. actual" panel** any
  more: it was absorbed into the two sections above, hours into Time & hours and
  profit into Profitability.
  - **Hours per role.** Estimated hours (the client's Estimated monthly hours
    fields) against hours actually worked, per role, with the difference and
    whether it ran **over** or **under** — e.g. a Bookkeeper estimated at 10
    hours who worked 12 reads "+2.00h over". The estimates are stated per MONTH,
    so a **quarterly** recap multiplies them by 3 and a **yearly** recap by 12,
    and the column header says which ("monthly estimates × 12 months").
  - **Profit** (owner only). Estimated profit = expected revenue − estimated
    cost, where
    estimated cost is each role's estimated hours × that role's cost rate, and
    expected revenue is the client's monthly rate (monthly clients), a twelfth
    of the annual fee (annual clients), or the estimated hours at each role's
    bill rate (hourly clients). Actual profit = the invoiced service revenue
    minus actual labor cost — the same two figures the Billing and
    Profitability panels show, from the same calculators. Reimbursements are
    excluded from both sides. All of this is stated on screen under the figures.
  - **A role's cost/bill rate** is taken from the people ASSIGNED to the client
    in that role; failing that, from whoever actually logged time in it. If
    several people are involved at different rates, the rate is their average
    and the panel says so. A role whose people have no pay rate (the CFO role,
    which is the owner's) costs nothing on BOTH sides of the comparison — it
    never makes the comparison unavailable.
  - **"No estimate set" is a normal, honest state** — most clients have no
    estimate on file. Those clients show the actual side only and **no
    variance at all**; nothing is ever compared against a zero nobody entered.
    A slim banner at the top of Time & hours says so and points at where to set
    them (Client page → Estimated monthly hours).
- **Projected end-of-month invoice** (owner only, monthly view only) — always
  labelled an Estimate, always with its basis printed underneath:
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
  projection — is **owner-only**: those figures are absent from a staff member's
  data entirely, not merely hidden on their screen. **So are the estimates**:
  how many hours the firm planned to spend on a client is planning data, set on
  the Client page, which staff do not manage. A staff payload gets the role
  table with the same rows and the same ACTUAL hours, and the Estimate and
  Over/Under columns em-dashed — and no "go set them on the Client page"
  prompt, which would be a dead end for someone who can't. In practice the whole
  page is owner-only anyway, since "Client Recap" only appears in an owner's
  sidebar; the gate is defense in depth.
- **A quarterly or yearly recap's revenue is a restatement, not a
  reconciliation.** Every month in the period is priced with the client's rates
  and plans **as they stand now** — no rate history is kept — so a client whose
  rate changed part-way through has the earlier months repriced at the new rate,
  and the figure will not match the invoices actually issued. It answers "what
  is this work worth at today's rates", which is the right question for a
  plan-vs-actual read. The Billing panel says so on screen whenever the period
  spans more than one month. A monthly recap has no such gap.
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
  payroll. Both period types use the app's Sun–Sat weeks (the same weeks staff
  submit), so bi-weekly = two consecutive Sun–Sat weeks. A date picker + ‹ ›
  buttons move the window (‹ › step by a full period); "This period" jumps to
  now. To line the bi-weekly window up with the firm's payroll cycle, set the
  start to a day in the pay period's first week — the cadence is then preserved.
  Table of each member's hours (billable/internal split + entry count) with a
  grand total.
- **Hours read as x.xx — two decimals, always** ("20.22h", "1.00h", "0.50h"), on
  the summary and the day-and-job detail alike. Two decimals, never one: the old
  one-decimal rounding printed a few-minute split allocation as "0.0h", so the
  hours appeared to vanish and the rows didn't add up to the total.
- **Every hours TOTAL is the sum of the rows shown above it**, not a rounding of
  the minutes behind them — so adding the Hours column by hand lands on the
  printed total. Rows of 0.17h + 0.17h + 0.75h total 1.09h, even though the
  underlying 10 + 10 + 45 minutes would round to 1.08h; 1.09 is the answer she
  gets with a calculator, so 1.09 is the answer printed. This composes down the
  detail table too: each day subtotal is the sum of its rows, and the grand
  total is the sum of the day subtotals. Same rule on the Client Recap card
  (total and billable are the sum of the by-staff list, and Total − vs-prior
  lands exactly on the printed delta) and in the assistant's hours summaries.
- **Hours is the costing column.** Cost is that figure × the pay rate — nothing
  else is needed to check it. An exact "Minutes" column used to sit between
  Hours and Billable to explain why the two would not multiply out; that gap is
  gone and so is the column.
- **Billable time, Billable $ and Cost appear on the PRINTED report**, not just
  on screen — on both the per-member summary and the day-and-job detail, with
  totals.
  - **Billable $** = billable hours × that person's BILL rate — what the work
    bills at (revenue).
  - **Cost** = ALL hours worked × that person's COST rate — what the firm pays
    for the time. It deliberately covers internal hours too, not just billable
    ones, because the firm pays for those as well. Set a person's cost rate on
    the Team page ("$/hour — for margin reports only, never billed").
  - Side by side, the two columns give margin per person and per day.
  - **The OWNER's Cost shows "—" and always will.** An owner draws no hourly
    wage, so her time carries no labor cost — that blank is the correct answer,
    not a missing setting, and nothing should prompt her to fill it in. The Cost
    total is therefore the firm's real STAFF labor cost.
  - Anyone with no rate configured shows "—" rather than "$0.00", so an unset
    rate never reads as "billed nothing" or "cost nothing".
- **HOW BILLABLE HOURS ARE PRICED ON INVOICES — changed 2026-09-01, her call.**
  An hourly line charges exactly the two-decimal hours it prints, times the
  rate: "0.05h at $125.00/hr" is $6.25, to the penny, every time. A person's
  billed hours are the sum of their entries' two-decimal hours — the same
  figure the Client Recap's roles table and the payroll report show — so the
  recap's Actual Invoice now matches its own hours table. (Invoices used to
  charge the exact raw clock time underneath while printing rounded hours,
  which is why hand-multiplying a line never quite landed; that is the "math
  is not mathing" she reported, and it is gone.) Ad hoc lines follow the same
  rule. Already-issued invoices are untouched: only newly generated ones
  price this way, and lines from before the change keep their stored amounts
  even when edited.
- **THE HOURS ON AN HOURLY LINE ARE EDITABLE, AND THE AMOUNT FOLLOWS.** In the
  month run's editor each hourly line shows its hours in a small "Hours" box
  with the rate beside it. Change the hours — round 1.31 up to 1.5 if you want
  a rounder bill — and the amount recalculates as hours × rate on its own; the
  amount box itself does not accept typing on these lines, because it is
  always the product of the two numbers next to it. The printed invoice shows
  the hours you chose. There is NO automatic rounding: nothing rounds unless
  you round it.
- **HOW LABOR COST IS CALCULATED — the rule, on every surface. Labor cost = the
  two-decimal hours shown × the cost rate: round the hours FIRST, then
  multiply.** In the firm owner's own words, verbatim: *"I pay by the minute so
  if someone works 20 hours and 13.4 minutes rounded to the 2nd decimal then I
  would pay 20.22 times her cost and that time because the staple for all
  comparisons"*. So 20h 13.4m at a $16 cost rate is 20.22 × 16 = **$323.52**.
  - **Per person, per period, off the ROWS the report prints.** Take that
    person's entries for the period, round EACH ONE to two-decimal hours, add
    those up — that sum is the Hours figure on the report — then multiply by
    their cost rate and settle the cent. A cost TOTAL is the sum of those
    per-person amounts.
  - **Why each row and not the period's raw minutes:** those two are not the
    same number, and the report prints the first while the money used to be
    built from the second. On the 8/8–8/22 run, Allison's 31 rows added to
    14.75h where her raw minutes rounded to 14.78h, and Lisa's 63 rows added to
    22.61h where hers rounded to 22.59h — so one person's cost read HIGH and the
    other's read LOW against the column above it. The figure on the page is the
    one that gets multiplied.
  - The two consequences that matter, and the whole reason for the rule:
    **multiplying a visible Hours cell by the pay rate gives the Cost cell
    beside it**, and **adding up the visible Cost column lands exactly on the
    total printed underneath it.** A line under the summary totals says so.
  - It is the same rule EVERYWHERE — payroll Hours report (summary, detail and
    all three exports), the Employee report, the Client Recap's labor cost and
    margin, estimated-vs-actual cost, and the assistant's client profitability
    and margin answers. They all call the same calculator, so no two surfaces
    can disagree.
  - **BILLABLE $ follows the identical rule**, with the bill rate in place of
    the cost rate: the billable-hours figure shown × that person's bill rate.
    Multiply the Billable hours cell by hand and you get the Billable $ cell.
    Per-entry Billable $ cells are that period total split across the person's
    own rows, exactly as the Cost cells are, so that column adds up too.
  - **It was corrected again on 2026-08-26.** The rule below was right and the
    call sites were not: the money was priced off the period's re-rounded raw
    minutes while the Hours column showed the sum of the rows. Cost, Billable $
    and the hours beside them now all come from the same figure, on the payroll
    summary, the day-and-job detail, the Employee report and every export.
    Figures move by a few cents to a couple of dimes per person per period, in
    either direction — measured across the whole firm for August 2026 the total
    labor cost moved by $1.52. Nothing stored changed; reports recompute.
  - **It changed on 2026-08-19.** Cost used to be computed from exact seconds
    and rounded once at the end — a defensible rule, and not the one the firm
    pays by: it made the printed Hours column un-multipliable, so reports had to
    carry an exact-minutes column to explain a few cents of drift. Figures on
    old and new reports differ slightly (typically a few cents to a couple of
    dimes per person per pay period, in either direction) because the RULE
    changed, not because anything was wrong before. Nothing stored changed —
    every report, past and present, recomputes under the current rule.
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
  - **The owner has no cost rate**, so her rows read "—" and she contributes
    nothing to any cost total. That is permanent and correct, not a gap.
- Payroll report detail — "Time by day and job": below the per-member summary,
  the same period broken down day by day. **EVERY TIME ENTRY IS LISTED
  INDIVIDUALLY** — entries are never merged just because they share a day,
  client or task. Each row shows the job (the client the time is billed to;
  '(Admin)' for non-client time), team member, task, CLOCK IN, CLOCK OUT,
  session count, hours, billable hours, Billable $ and Cost. Rows sit under
  their day's header with that day's total, in clock-in order (entries logged
  as minutes only, with no timestamps, come last and show "—" for the stamps).
  A "Team member" filter scopes the detail to one person (payroll is usually run
  per person) or all.
- **Group splits made in "full" mode count ONCE toward payroll hours and cost.**
  Full mode deliberately bills every client on the split the WHOLE block, so a
  1-hour block across 3 clients is 3 billable hours — that is the intended
  billing. But the person worked one hour and the firm pays for one hour, so
  tracked hours, day subtotals, grand totals and Cost count the block a single
  time. Every slice still appears as its own row and still counts toward
  Billable / Billable $; the repeated rows carry a muted "full block · counted
  once" note (and no Cost) so the subtotal always explains itself. Even and
  custom splits carve the block up and count normally.
- Payroll exports (three): "Summary CSV" (per-member totals), "By day & job
  (summary)" (Date, Team member, Job, Task, Hours, Billable hours — the
  COLLAPSED breakdown, ready to pivot; the on-screen table is the per-entry
  view), and "Raw hours" (one row per time entry, scoped to the pay period and
  member filter).
- Both RAW exports carry "Billable hours" and "Billable $"; the payroll
  "Raw hours" export also carries "Cost". These match the printed report — blank
  rather than 0.00 when the person has no rate set.
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
  billing, employee coverage.
- Employee report (hours by person, including billable $ = each person's
  billable hours × their bill rate, and **Cost** = their tracked hours × their
  COST rate; owners are included) and Client report (hours by client), each with
  Download CSV. Print-friendly output — the Cost column is on the printed
  employee table and in its CSV, matching the payroll tables: "—" (never
  "$0.00") for anyone with no cost rate, which is the permanent, correct answer
  for an owner.
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
> with something to bill — lines, a due date from that client's payment terms,
> any prior-month adjustment carried forward, and out-of-scope flags.
>
> **Moving between months:** the month picker has a back arrow and a forward
> arrow flanking it — one press steps the run one month and the list reloads to
> match, no calendar popup needed. The picker itself still works for jumping
> straight to a distant month. If an open invoice has unsaved edits, stepping
> months asks before discarding them, same as the picker.
>
> **The month's invoices are grouped into status tabs** — **To review**,
> **Reviewed**, **Sent**, **Paid**, **Voided** — so you work one group at a time
> instead of scrolling a single list of every client. Sent, Processing and
> Overdue all live under **Sent** (each row still shows its own status). Every
> tab carries its count, and all five counts stay visible at once, so you can
> see the shape of the month without opening anything; a tab with nothing in it
> is dimmed but still there. Within a tab the invoices are in INVOICE NUMBER
> order (they do not rearrange while you work through them). When you mark one
> reviewed, send it or void it, it simply leaves the tab you are on and its new
> tab's count goes up — you are not dragged along after it.
>
> Above the tabs are the counts for To review / Reviewed / Need a look and the
> month total. Rows flagged for a second look get an amber rule down the left.
> Flagged invoices keep their place in number order, so they can turn up in any
> tab — a small amber dot on a tab means some of the flagged ones are in there.
> If you switch tabs with unsaved edits in an open invoice, it asks before
> discarding them.
>
> **AI confidence rating (advisory).** After Generate, an AI reviewer reads each
> monthly draft and rates its accuracy — a small badge on the row says **high
> confidence**, **check N things**, or **low confidence**. It checks the
> arithmetic (printed hours times each person's bill rate, reconciled against
> the month's tracked time), plan-vs-hourly consistency, covered-date windows,
> ad hoc dispositions, whether descriptions name the right month, and how the
> invoice compares to last month's. Open the invoice to see the reviewer's
> summary, its specific concerns, and up to three questions it would ask you.
> THE RATING IS ADVISORY ONLY — IT NEVER BLOCKS, CHANGES, OR SENDS ANYTHING,
> AND IT NEVER TOUCHES THE NUMBERS. An unrated or low-confidence invoice can
> be reviewed and sent exactly as before. Ratings land a little after
> generation (each takes a few seconds and fills in on its own); a **Re-rate**
> button refreshes one after edits, and if you edited since it was rated the
> card says so. Retainer invoices are not rated — one manual line, nothing to
> check. Invoices from before this feature simply have no badge.
>
> **The AI's questions (skippable).** When you click **Mark reviewed** on an
> invoice whose rating still has unanswered questions, they appear once more
> with answer boxes — **Answer & approve** or **Skip & approve**, your choice,
> and approval is never held up. Answers are remembered and make future
> ratings smarter about how you like invoices done; skipping costs nothing.
> Questions can also be answered any time from the open invoice.
>
> Click any row to edit it: change a line's wording or amount, add or remove
> lines, write the note to the client, then **Print** it or **Mark reviewed**.
> Print produces the SAME printed invoice the per-client view has always
> produced — one format, not two — using the stored lines rather than
> recalculating. Save your changes first; Print is disabled while there are
> unsaved edits so you can never print something different from what is stored.
> Reviewed can go
> **Back to draft**. **Void** keeps the invoice on the record, struck through,
> and frees that client to be generated again.
>
> **MARK PAID — for money that arrived outside the app.** A check, a direct
> transfer nobody linked, an invoice that was never sent through the system:
> open the invoice in the month run and press **Mark paid**. It works on Draft,
> Reviewed, Sent and Overdue invoices; it is NOT offered while a bank payment
> is **going through** (a real debit is settling — let it finish, or the two
> answers would race). Marking paid records the date, locks the invoice like
> any paid invoice, and **kills any payment links already emailed for it** so a
> client cannot pay a second time with an old button. Who marked it and when is
> kept on the record.
>
> **Verify with Stripe** appears on invoices whose payment is still shown as
> going through. It asks Stripe directly whether the payment settled, and only
> records Stripe's answer: settled means the invoice moves to Paid with the
> real charge time, still-settling means nothing changes and the button says
> so. This is the fix for a payment that completed on Stripe but never flipped
> here (a lost or out-of-order webhook) — no guessing, no manual override on a
> live payment.
>
> **Verify all with Stripe** — the same check as one sweep. The button sits in
> the month run's action row (always there, next to Download for QBO) and
> checks EVERY invoice whose payment is still shown as going through, in any
> month, against Stripe in one press. Each invoice is checked independently and
> only Stripe's answers are recorded; the result is a plain sentence — how many
> were confirmed paid (named by invoice number), how many are genuinely still
> settling, and how many could not be checked. Pressing it when nothing is
> holding just says so. Use it when payments look stuck rather than checking
> invoices one at a time.
>
> **Undo manual payment** appears only on invoices marked paid BY HAND — press
> it and the invoice returns to Sent (or Reviewed if it was never sent),
> editable and collectible again. An invoice a real payment settled has no such
> button: money that actually moved stays recorded exactly as it moved.
>
> **ONCE AN INVOICE IS PAID IT IS LOCKED.** A paid invoice has to keep matching
> what the client actually paid, so it stops being editable: the lines and the
> note go read-only, and **Save changes**, **Add a line** and the remove buttons
> are gone. A grey line at the top of the invoice says why. The same lock applies
> while a payment is still **going through** (an ACH debit can take a few days to
> settle) — the invoice the client authorized must not move underneath them
> mid-payment. It lifts for nothing: a paid invoice cannot be walked **Back to
> draft** either.
>
> **Void is the way out.** If a paid invoice turns out to be wrong, void it and
> issue a new one. That is deliberate — a void stays on the record where you and
> the client can both see it happened, and a silent edit would not.
>
> Invoices that have been **sent but not paid** are still fully editable. Nobody
> has paid those yet, and fixing one before they do is ordinary work.
>
> This is also what keeps a **retainer credit** honest. A retainer has to be paid
> before it can be credited to a final invoice, and a paid invoice's total can no
> longer change — so the credit can never drift away from the money that actually
> came in.
>
> **AD HOC WORK IS SHOWN SEPARATELY, AND YOU DECIDE WHAT TO DO WITH EACH
> PIECE.** Time flagged "Ad hoc" on the Time page (one-off work outside what the
> client is scoped for — see Time tracking) does not disappear into "Billable
> hours — <name>". It gets its own block on the draft, headed **"Ad hoc —
> outside scope"**, with one line per piece of work: `Adhoc — <what was done>`,
> and underneath it the day, who did it, and the hours at their rate. Each line
> carries a dropdown with three answers:
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
> The choice flows through everything: the month total above, the printed
> invoice, the PDF and the emailed invoice all agree, because they are all
> reading the same lines. Courtesy lines print at $0.00; omitted lines are not
> printed at all (and are left out of the QBO export — a courtesy line is
> exported, since it IS on their invoice).
>
> **A piece of time is billed exactly once.** An ad hoc entry is either an ad hoc
> line or part of the ordinary hours — never both — so flagging time can add a
> charge or move one, but it can never double it.
>
> Ad hoc applies to **hourly clients** from June 2026 onward. Flat-fee
> (subscription / annual) clients are unaffected for now: their billable hours
> are already covered by the fee, so flagged time there is recorded but not
> charged. Regenerating a month rebuilds the ad hoc lines from current data like
> everything else — which means it also discards the choices you made on them,
> the same as any other edit.
>
> **Download for QBO** exports the month as a line-level CSV for QuickBooks'
> invoice import. Voided invoices are left out. ⚠️ The `Item` column is a
> placeholder until Brittany confirms the product/service names in her own QBO
> file — everything else in the export is exact.
>
> Running Generate again is safe and expected: a client that already has an
> invoice for that month is skipped, never rewritten, so a second run cannot
> revert edits. A client with nothing to bill gets no invoice at all.
>
> **Void & regenerate.** Next to Generate. Because Generate leaves an existing
> invoice alone, it cannot refresh a month that was built early and has since
> moved on — that is what this button is for. It voids every **Draft** and
> **Reviewed** invoice for the chosen month and immediately builds them again
> from current data. It NEVER touches an invoice that has already gone out:
> Sent, Processing, Paid and Overdue are left exactly as they are, and so is
> every other month. The trade is real and the confirm says so with the actual
> counts ("Void 12 drafts and 3 reviewed invoices for August 2026…"): line
> edits, the note to the client and the review status on the voided invoices
> are **discarded**, not carried forward. The voided invoices stay on the
> record, struck through, as they always do. The button is greyed out when
> there are no unsent invoices to rebuild. Afterwards it reports what happened
> — how many were voided, how many rebuilt, and how many were left alone
> because they had been sent or paid.
>
> **Expect the invoice numbers to jump after a regenerate, and don't worry
> about it.** Numbers run `INV-2026-08-001`, `INV-2026-08-002`, … within a
> month. A voided invoice KEEPS its number, and numbers are never reused, so
> the rebuilt invoices get fresh higher ones: regenerating a 12-invoice August
> moves the live invoices from `INV-2026-08-001`–`012` to `INV-2026-08-013`–
> `024`. That gap is deliberate — a number that was on a document must never
> point at a different document later. Voided invoices are also left out of
> **Download for QBO**, so the export has no gap in it at all.
>
> **Stripe is LIVE — real money moves.** Payment links and card payments run on
> the live Stripe account, and real payments have settled through it. If asked
> whether a client can actually pay from the app: yes — by bank transfer (ACH)
> from a payment link, or by card. Because every send and payment link is real
> now, any practicing or testing belongs on the **Test** client, never a real
> one.
>
> **Payment link (bank transfer).** On an invoice with an amount owed there is a
> **Payment link** button. It does NOT open a payment page - Brittany is not the
> payer - it creates a secure Stripe link and shows it to copy and send to the
> client. Creating one marks the invoice **Sent**. The client pays by bank
> transfer (ACH), which takes about **4 business days to clear**, so the invoice
> reads **Processing** for several days before it turns **Paid**. That delay is
> normal and is how bank transfers work - it is not stuck. A failed payment puts
> the invoice back to Sent and notifies the owners. There is no button on a
> voided invoice or one with nothing owed.
>
> **Send (email the invoice).** In the month-run editor, next to Payment link,
> there is a **Send** button. It emails the invoice to **every address attached
> to that client**: each linked contact's general address AND any
> client-specific addresses on that contact (a contact who appears on several
> clients can hold a different address for each, and can hold more than one for
> the same client — all of them are used), plus the address on the client
> record. Archived contacts are skipped, and the same address is never sent two
> copies. A personal address on a contact attached to the client counts too —
> that is how some clients actually receive mail.
>
> **You can see who it goes to before you send.** Each row in the month run
> shows its recipient count, and opening it lists them by name
> ("Anthony Cooper <anthony@…>", "Client record <billing@…>"). A client with
> **no address on file** is flagged as such on the row before the run starts,
> and its Send button is disabled with the reason on it — it no longer fails
> only after you press Send. The email carries the
> full breakdown, total, due date and the note to the client, plus a big pink
> **Pay $[amount]** button (bank transfer) when there is an amount owed — each send gets a fresh
> payment link, and a re-send of a Paid or Processing invoice goes out as a
> statement with NO pay button so nobody can pay twice. Sending marks the
> invoice **Sent**; the first send's date is kept as THE sent date. The editor
> shows the last send ("Sent Aug 9 to 2 recipients"), which opens to the actual
> addresses so a past send can be audited, and the button becomes
> **Send again**. A draft must be **marked reviewed** before it can be sent. A
> failed send shows the email provider's actual error and never marks the
> invoice sent — every attempt, including failures, is kept in a permanent
> per-invoice email log along with the total that was billed at the time.
>
> **Choosing who gets it.** When a client has **more than one** address on file,
> Send opens a short checkbox list — one line per address, showing whose it is —
> with **everything ticked**, so sending to all of them is still one click.
> Untick any you do not want and press Send; the invoice goes only to the
> addresses you confirmed, and the email log records exactly those. With a
> single address on file there is no dialog at all — it just sends. The same
> list appears from the per-client **Email invoice** button. The server only
> ever accepts a choice made from that client's own addresses; it cannot be
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
> **Every invoice email carries a PDF of the invoice.** The attachment is named
> after the invoice number (`INV-2026-08-001.pdf`) and is built from the invoice
> as it stands at that moment, so an edit made before sending is in the file the
> client receives. It holds the same content as the printed invoice: the firm's
> logo and details, the invoice number, the month, the issue and due dates, who
> it bills, every line with its detail and amount, the subtotal and total,
> payment terms, the note to the client and the footer note. If the PDF cannot
> be built for any reason the email still goes out — without the attachment,
> never held back.
>
> **After the client pays, the client hears from us.** Nobody had to do anything
> for this and nothing is queued for Brittany to send.
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
> Both go to exactly the same addresses the invoice went to. Each is sent **once
> per invoice** — a repeated notice from the payment processor cannot produce a
> second thank-you — and each is recorded in that invoice's email log alongside
> the sends. If one of these emails fails, the payment is still recorded
> correctly; only the notice is lost.
>
> **Pay by card — a per-client option, off by default.** On a client's **Billing**
> tab (owner only) there is a **Pay by card** toggle. Every client is bank
> transfer only until someone switches it on for that one client; **bank transfer
> is the no-fee default for everyone and always stays available.**
>
> With it on, the emailed invoice keeps the **Pay by bank transfer** button and
> adds a smaller card option underneath it: "Prefer to pay by card? Pay $103.30
> (includes a $3.30 card processing fee — bank transfer has no fee)." The client
> chooses. Both links are minted fresh on every send, and paying through one
> **immediately kills the other**, so an invoice can never be paid twice.
>
> **The fee is calculated so the firm receives the invoice total exactly.** It is
> not a flat percentage added on top — that would leave the firm short, because
> the card processor takes its cut of the larger amount actually charged. The fee
> is worked backwards from what the firm must net (2.9% + 30¢ on the charged
> amount), rounded so it is never a penny under. On a $100.00 invoice the client
> pays $103.30 and the firm receives $100.00.
>
> **Where the fee shows up.** Nowhere, unless the client actually pays by card.
> The invoice, the month run and QuickBooks all show the ordinary total while it
> is unpaid. When a card payment lands, a **Card processing fee** line is added to
> that invoice and its total is recalculated, so History, the month run and the
> Download-for-QBO export all show the money that actually arrived. A client who
> pays by bank transfer is never charged a fee and no fee line ever appears.
>
> **The Payment link button stays bank transfer only**, even for a card-enabled
> client. It hands back a bare URL to paste somewhere else, and the sentence
> explaining the fee would not travel with it. Card is offered through **Send**,
> where the email carries the explanation.
>
> **Email invoice can build the invoice first.** The per-client **Email
> invoice** button sends the STORED invoice for the client and month on screen.
> If that client has no live invoice for that month — none at all, or only
> voided ones — it no longer stops. It asks: "<Client> has no invoice for August 2026 yet. Generate it now? (Just
> this client — nothing else is created.)" Saying yes builds ONE invoice, for
> that client only; no other client's month is touched. It stops at a **draft**
> and says so ("Invoice INV-2026-08-043 created as a draft — mark it reviewed
> in the August 2026 month run above, then send"). It does NOT send it and does
> NOT mark it reviewed:
> review before send is the rule everywhere, and nothing is emailed off the
> back of that one question. Saying no changes nothing. If there is genuinely
> nothing to bill — no hours, plan or reimbursements that month — it says that
> instead of creating an empty invoice.
>
> **History — every month, on the same page.** At the very top of the Invoices
> page there is a switch: **This month** and **History**. This month is
> everything described above (the run, and the per-client view below it) and is
> where the page always opens; History is the archive. It is not remembered
> between visits, because the month you are billing is what this page is for.
>
> History lists **every month that has ever been generated, newest first**, each
> one collapsed to a single line until you open it: "August 2026 · 14 invoices ·
> $12,400.00 billed · $9,800.00 paid · $2,600.00 outstanding". **Voided invoices
> are left out of all four figures** — a void is a document that was withdrawn,
> and counting it would say the firm billed money it never asked for — but they
> are counted separately on the end of the line ("· 2 voided") so a month that
> is half voids never looks like a month where invoices went missing. **Paid**
> is the invoices that have actually settled; **outstanding** is billed minus
> paid, which means a **Processing** invoice counts as OUTSTANDING. That is
> deliberate: a bank transfer that has not cleared is money that has not
> arrived.
>
> Open a month and you get a compact table — **Number, Client, Status, Total,
> Sent, Paid** — in invoice-number order, with voided rows dimmed and struck
> through exactly as they are in the run. Click any column heading to sort by it
> (click again to reverse). Sorting applies **within** each month; the months
> themselves always stay newest first.
>
> Above the months are three filters — **Year**, **Client** and **Status**.
> Year and Client offer only what is actually in the archive (no clients who
> have never been invoiced, no years with nothing in them); Status is the full
> lifecycle list every time. They narrow the rows AND recompute every total, so
> filtering to one client turns each month line into that client's month; a
> month with nothing left in it disappears from the list entirely.
>
> **History is read-only.** There is no edit, send or void here — the month run
> is where invoices are worked on, and one place has to own that. Each row does
> two things: **Print** (the same printed invoice everything else produces, from
> the stored lines), and **clicking the invoice number opens that month in the
> run** — the switch flips back to This month and the run's picker moves to that
> month, ready to work. If an invoice is open in the run with unsaved edits, it
> asks first, naming the month holding them ("You have unsaved invoice edits in
> August 2026"); choosing to keep them leaves you in History with a line saying
> so, rather than moving you somewhere nothing happened. Until months have been
> generated, History says so and shows nothing.
>
> **RETAINERS — the two ends of an engagement.** An engagement is bookended by
> two documents: a **retainer invoice** when the client signs, and a **retainer
> credit** on the invoice you decide is the last one. The monthly invoicing in
> between is completely untouched by this.
>
> **Issuing one.** On the client's **Billing** tab there is a **Retainer
> invoice** panel: type the amount, optionally a note for the invoice line, and
> press **Issue retainer invoice…**. It asks to confirm, then creates a DRAFT
> retainer invoice for that client. This is a deliberate manual act — the app
> has no way of knowing when an engagement letter comes back signed, so pressing
> that button IS the signing event. Nothing generates one for you.
>
> **After that it is an ordinary invoice.** It appears in the month run for the
> month it was issued in, tagged **Retainer**, and in History the same way. You
> review it, edit its line, send it, take payment on it and print it exactly
> like any other. It is allowed to sit in the same month as that client's
> regular invoice — the two are separate documents and the tag is what tells
> them apart. **Generate** and **Void & regenerate** ignore retainers entirely:
> a retainer does not stop the month's real invoice being built, and rebuilding
> a month never throws a retainer away.
>
> **Retainer numbers run on their own sequence:** `INV-RET-2026-001`,
> `INV-RET-2026-002`, … counted per YEAR, not per month, because a retainer is
> not part of any month's batch. They can never collide with the monthly
> `INV-2026-08-001` numbers.
>
> **Giving it back — THE APP OFFERS, YOU DECIDE WHEN.** Once a retainer has been
> **paid**, every invoice for that client shows an **Apply retainer credit
> ($X)** button beside "Add a line". Nothing is ever applied automatically:
> which invoice ends an engagement is your judgment, and from the app's side the
> final invoice looks like any other month. Press it when you mean it. It adds a
> line reading **"Retainer applied — credit"** at a negative amount and the
> total drops accordingly.
>
> **Applying and removing are both yours.** Delete the credit line with its
> ordinary bin icon and save — the retainer goes straight back on account and is
> offered again on the next invoice you open. Nothing about this is one-way.
>
> **The credit is added before the invoice goes out, not after.** The Apply
> button appears on **Draft** and **Reviewed** invoices only. Crediting one that
> has already been sent would leave the copy in the client's inbox and the copy
> of record disagreeing about the amount, with no send to tell them so. A credit
> that was applied BEFORE the invoice went out is untouched by this — it travels
> with the invoice through Sent and Paid like any other line, and the invoice
> stays editable.
>
> **The amount on the credit line is not typed.** The app sizes it from the
> retainer and the rest of the invoice and re-sizes it on every save, so the box
> is read-only; the wording of the line is still yours to change.
>
> **Voiding gives the retainer back.** Void a credited invoice — one at a time,
> or by regenerating the whole month — and the retainer returns to the account
> automatically, offered again on the next invoice. A voided invoice is one
> nobody is going to pay, so the money it was going to hand back never will be,
> and leaving it marked spent would strand it where nothing would ever show it.
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
> **A retainer can never be given back twice.** The moment it is applied, the
> app records which invoice took it, and that is enforced when you save, not
> just hidden in the buttons: if the same retainer is somehow applied to a
> second invoice — another tab, another owner — that save is refused outright
> with "That retainer has already been applied to another invoice", and nothing
> of it is stored.
>
> **The credit can never make an invoice negative.** If the retainer is larger
> than the final invoice, the credit stops at the invoice's own total and takes
> it to exactly $0.00 — never below. The app says so on the button ("$2,500.00
> is held on account; this invoice can take $400.00 of it"). Applying it settles
> the retainer in full; returning the remainder to the client is something you
> do outside the app, deliberately, because paying a client is not something a
> billing screen should do on its own.
>
> **A fully credited invoice still goes out.** If the credit takes the total to
> $0.00 the invoice sends as a statement, with no pay button, because there is
> nothing to pay. If money is still owed, the pay link and the card option (if
> that client has one) charge the NET amount — the credit is part of the lines
> the total is computed from, so everything downstream agrees.
>
> **Where retainers show up elsewhere.** They appear in **History** tagged
> Retainer, and in **Download for QBO** — both the retainer invoice and the
> credit line export, sharing one item name so they net out over the life of the
> engagement. **Client Recap revenue does NOT count retainers.** That is
> deliberate: a retainer is money held on account, not revenue in the month it
> is paid, and it is recognized through the monthly invoices it later offsets.
> Crediting the final invoice therefore does not dent the revenue the recap
> reports for that month — the work was still worth what it was worth.
>
> **Combined billing (billing masters).** A client can be set up as a
> **billing master**: a client that does no work of its own but bills for a
> group of companies (its "subs"). Each sub's time, checklists, reimbursements
> and recap stay on the sub exactly as normal — the sub just stops getting its
> own monthly invoice ("Billed on the master's invoice" appears where its
> invoice would be), and the master's monthly invoice carries every sub's
> charges. Inside the month run, the owner sees the master's invoice broken
> out by company with per-company subtotals — but THE CLIENT SEES ONE
> COMBINED LINE ("Bookkeeping services — the month") with one total: no
> company names, no per-company amounts, on the printed invoice, the PDF, and
> the emailed invoice alike. That is deliberate and was the client's own
> choice. The invoice email goes to whichever sub's contacts the owner picked
> for that master — set in the "Combined invoice recipient" section on the
> master's client page, under Billing; if none is picked yet, sending refuses
> with a sentence pointing there. Retainers are still issued per company,
> never combined. The
> master's Client Recap shows each company's numbers rolled up (and each sub
> keeps its own recap); a couple of recap figures (sales tax status,
> projection) do not roll up and say why with a dash. A billing master cannot
> have time logged to it, checklists on it, or recurring reimbursements of
> its own — the app refuses, because the master's job is billing, not work.
>
> The per-client section BELOW the run is the older live-calculation view, kept
> for its preview and print.

- Per-client invoice drafts for the selected billing month: subscription
  plans and/or billable hours become line items; total due computed. For
  Hourly clients, billable hours are charged per team member at that person's
  own bill rate — the invoice shows one "Billable hours — <name>" line each.
  This per-employee billing applies from June 2026 onward; invoices for earlier
  months keep computing at the client's prior per-client hourly rate, so already
  -sent historical invoices stay exact and never change retroactively.
- **TIME BREAKDOWN ON THE INVOICE — OFF UNLESS YOU TURN IT ON, PER CLIENT.**
  By default an invoice says what the client is paying and nothing about the
  hours behind it: a monthly client sees the subscription line and its price
  plus any expense reimbursement line and its price, and that is all. On the
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

  On an **Hourly** client, "one line per person" adds nothing, because that
  invoice already bills one "Billable hours — <name>" line per person with the
  hours and money on it. Per day, per week and every entry still add detail
  there. An hourly client's charges are unaffected by this setting either way.
- This invoice's reimbursements: add out-of-pocket expenses (date,
  description, amount) — each becomes a line on the invoice. Recurring
  reimbursements supported.
- Reimbursed expenses can name the DATES THEY COVER, and keep those dates
  current on their own. Set up on the client page (Recurring reimbursements):
  tick "The invoice wording names the dates this covers", write the wording ONCE
  with placeholders — `{range}`, `{start}`, `{end}`, `{description}` — and enter
  the first covered period by hand (for example July 13 to August 13). Every
  invoice after that fills in its own cycle's dates: "QuickBooks Online — August
  13 – September 13, 2026". The day the first period ENDS on is the day the
  cycle turns; short months clamp (a 31st becomes the 28th in February) and the
  cycle returns to its own day the following month.
  - The window moves when an invoice is GENERATED, not on a calendar. Voiding a
    month and regenerating it reuses that month's window rather than stepping
    the cycle again, so a rebuilt invoice covers the same dates as the first one.
  - VOIDING un-bills the window. A month that is voided and never rebuilt goes
    back to being unbilled, so the next invoice generated offers that same
    period instead of quietly moving past it.
  - Quarterly and annual expenses cover three months and twelve months per
    cycle respectively, matching their own frequency.
  - Pause an expense (the pause button on its row) and it stops billing
    entirely. It keeps its place — nothing advances while it sits out.
  - The invoice ASKS, rather than guessing, whenever the next window is not
    simply the one after the last: a skipped cycle, a paused expense switched
    back on, or a month generated behind one already billed. That line is
    flagged "Confirm the covered dates" in the month-run editor with a proposed
    period she can accept or edit. Until she answers, the invoice can be neither
    marked reviewed NOR sent to the client — both are refused, and voiding it is
    the way out if she does not want to answer.
  - What she confirms is what the following cycle counts forward from, including
    the day of the month: moving a covered period's end onto a different day
    moves the whole cycle onto that day rather than snapping back next month.
  - Confirming refreshes the invoice wording around the new dates — unless she
    has typed her own wording on that line, which is left exactly as she wrote it.
  - An expense that does not use this bills exactly as it always did.
- Customize: adjust line items, the intro/footer notes and which client fields
  appear — on the PRINTED sheet only. These edits are session-only and are not
  emailed: Email invoice always sends the stored invoice. To change what a
  client receives by email, edit the lines in the month-run editor and save.
  Email invoice is unavailable while Customize is open, so the two cannot
  disagree about what went out.
- Email invoice: actually sends the stored invoice for the selected client and
  billing month to that client's contacts on file, through the same rail as the
  month run's Send button — it does not open a mail draft. It sends the STORED
  invoice, never the Customize panel's version, so line edits meant for the
  client belong in the month-run editor. The month must have been generated
  first, and the invoice must be past Draft (mark it reviewed in the month run),
  otherwise the button explains what is missing instead of sending. Asks for
  confirmation first, and reports who it went to and when.
- Print invoice: opens the browser's own print dialog on a clean, print-formatted
  invoice sheet with firm branding — the app's sidebar, billing queue and the
  rest of the screen are not printed, only the invoice. From there the browser
  can send it to a printer or "Save as PDF". Nothing is emailed and nothing is
  saved to the invoice by printing.
  - The SAME sheet is what every Print button in the app produces: the month-run
    editor's Print, History's Print, and this page's Print invoice. There is one
    printed invoice format, so what she prints matches what the client was
    emailed — the emailed PDF mirrors this sheet. Three caveats worth knowing
    before telling a client "it's identical":
    - The PDF is built by a SEPARATE renderer on the server, not from this
      sheet. They share the line calculation and the money formatter, so the
      amounts and the lines always agree; the layout is a mirror maintained by
      hand, so small presentation differences are possible.
    - The PDF can carry things the printed sheet does not: a **PAID** banner
      once the invoice is marked paid, and, on a card payment, the processing
      fee line added at payment time. Printing an invoice never stamps it PAID.
    - The PDF is attached best-effort. If it fails to render, the invoice email
      still goes out — without the attachment — rather than not going out.
  - The month run's and History's Print show the STORED invoice for that row.
    This page's Print invoice shows the live per-client calculation for the
    selected client and month, including any Customize edits.
  - Print is disabled in the month-run editor while there are unsaved edits, so
    she can never print something different from what is stored.
- Billing queue: all clients with their month total, ready to review.
- Estimated hours fields anywhere in the app are informational only and
  never change invoice amounts.

## Plans (owner only)

- Subscription plan catalog: name + notes (e.g. "Monthly Close Essentials").
  Attach plans to clients (plans label the monthly invoice line).
- A plan can be linked to a set of checklist TEMPLATES — the standard work that
  comes with that plan. A plan pulls ONLY from the firm's standard BLUEPRINT
  templates (the client-agnostic ones on the Checklists page), never a
  client-bound checklist, so the picker lists only blueprints and only blueprint
  checklists show on a plan. On a client's detail page, for each plan the client is
  on, a "Plan checklists" panel shows that plan's templates, marks which are
  already set up on the client, and a "Set up plan checklists" button adds the
  missing ones to the client. Because templates carry a board column, the new
  checklists land in the right Active-Checklists-board column automatically —
  connecting plans → checklists → board.

## To 100% (owner only)

- **What this page is (and deliberately is NOT):** it answers one question —
  "what parts of the app aren't working or aren't fully configured?" —
  organized BY TAB, mirroring the sidebar. ONLY problems appear. Normal
  day-to-day checklist work (active checklists with unchecked steps) NEVER
  shows here — that's operations, and it lives on the Checklists page and the
  Board. A tab with nothing wrong renders as a slim GREEN row ("Nothing
  missing"), so the owner also sees which areas are fully working.
- Tabs covered, in sidebar order: **Checklists** (recurring recipes that will
  silently never generate), **Board** (recipes with no Board column — their
  checklists pile into "Uncategorized"), **Clients** (missing email / team /
  contacts / plan checklists), **Invoices** (Monthly/Annual clients with no
  rate — their invoice would be $0), **Plans**, **Team** (no bill rate),
  **Contacts** (unlinked). Tabs without automated checks (Time, Timesheet,
  Dashboard, reports) aren't listed, and the page says so — unlisted means
  "not scanned", not "verified fine". A client whose team previously lived
  only in the old `client_assignments` table (never the field that actually
  gates visibility) now surfaces here as "missing a team member" — the
  single-source-of-truth cleanup makes that gap visible instead of silent.
- Top-of-page summary: one chip per tab that HAS problems, with its count;
  clicking a chip opens that tab's section and scrolls to it. Sections with
  issues are collapsed by default; green tabs are always visible.
- Fix in place: most items open a small QUICK-FIX modal with only the missing
  field(s) — a monthly/annual rate, a billing email, the assigned-team picker,
  or a "Set them up" button for a plan's missing checklists — and save without
  leaving the page (the item disappears the moment it's filled in). Items with no
  single field (bill rate → Team page, contacts, plan templates) deep-link
  instead.
- Ignore: any item can be IGNORED (something the owner knows about but doesn't
  need to fix). Ignored items move to a collapsible "Ignored" section at the
  bottom and can be Restored anytime; the ignore list is saved per owner.
- RECURRING CHECKLISTS THAT WON'T GENERATE (the "Checklists" category): the most
  important check, because this failure is otherwise SILENT — a recurring
  checklist saved with a mandatory field missing simply never creates anything,
  with nothing to say so. Each broken recipe is named (title · client) with the
  exact field that's missing and a link straight to it, and the detail says
  whether it has NEVER generated a checklist or has merely stopped:
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
- Resend sign-in link; revoke access.
- Bill rate (expand a member): the $/hour charged to clients for this person's
  billable hours on Hourly-billed clients. Set for ANY member including the
  owner (so the owner's own hours bill). Leave blank to fall back to the firm's
  default hourly rate. Owner-only to edit.
- Cost rate (expand a member): optional $/hour pay/cost rate per member. Owner-
  only, informational — it powers the assistant's margin analytics and is
  NEVER billed or shown to staff. Leave blank to skip; the assistant then
  reports realization only. (Distinct from bill rate above.)
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
  click **Open in desktop** at the top of the screen (next to the bell). The
  browser asks to open "PBJ Accounting" and the installed app opens signed
  in. (The sign-in email itself cannot do this — email programs block
  app-opening links.) The button does not appear inside the desktop app
  itself or on phone-sized screens. If nothing happens, the desktop app is
  not installed, or it is already open and signed in.
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
  <name>" line at the top of the email and appended to the subject, so the
  recipient can tell which client the notice refers to straight from their
  inbox. The client is resolved from the notification's task/client automatically
  (client-less notifications simply omit the line).
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
  tasks, and Updates tracker activity. Turning a type off stops the EMAIL only —
  in-app bell notifications always arrive. All types default to on.
- **Skipped recurring tasks** (the "skippedTasks" toggle): covers both halves of
  the quiet-skip flow — a recurring task being skipped for a cycle (the owner
  always; an accountant when a bookkeeper skips on a client that accountant is
  on), and a team member creating a task, so the owner can decide whether
  skipping should be allowed on it. See "Skipping a recurring task" under
  Checklists.
- **Updates tracker activity** (the "updatesTracker" toggle): the OTHER owner is
  notified when a new update is logged, and whenever an update CHANGES STATUS —
  shipped, sent back to Planned, picked up as In progress, moved to Britt's
  Brain, and so on. The message names who did it, the update's title, and the
  move ("Shipped → Planned"), including the review note when one was given. The
  tracker is owner-only and both owners work the queue, so this is how each stays
  aware of the other's changes without watching the page. Whoever made the change
  is never notified about their own action, and edits that DON'T move an item
  (retitling, re-ranking, dev notes) send nothing.

## Billing month concept

- The top-bar billing month selector scopes Invoices, Reports, and unbilled
  hours to that month. Time entries belong to the month of their date.

## AI Assistant (this assistant)

- Owner-only chat: answers questions about how to use the app, grounded in
  this manifest.
- Voice: the assistant panel has a microphone button — tap it to TALK to the
  assistant out loud (real-time voice) and tap again to end. It speaks back.
  Voice is owner-only. Typing still works alongside it.
- Voice can set things up too — with the same guardrail as text: asking by
  voice only FILES A CONFIRMATION CARD in the panel (make a template
  recurring, assign a client to a team member, generate a task list now,
  turn a switched-off recurring checklist back on).
  Nothing changes until the owner taps "Run it" on the card. The assistant
  never takes an action on its own, by voice or by text — every change
  requires the owner's explicit confirmation on a card.
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
  activity log AND appear on the owner's "Updates" page (the tracker) where they
  can be prioritized and tracked.
- Generates reports on request from any data it can read (profitability,
  hours, deadlines, capacity, clients, workspace setup). Ask for a report —
  e.g. "give me a Q2 profitability report" — and it assembles a structured
  report (sections, key figures, tables) and opens it in a modal you can read
  and "Save as PDF". Works by text chat and by voice (the report pops up on
  screen during a call). Owner-only. If you ask for a report the app doesn't
  have the data for, it says so and offers to send Alex a feature request to
  build it (you confirm before it sends).
- After producing a report or analysis, offers to email it to the owner.
  On "yes" it shows a confirm card; only on confirm does it email the report
  to the owner's address. It tells the truth about whether the email actually
  went out (it never claims "sent" when the email pipeline rejected it).
- Watches for repeated manual work and shows up to 3 suggestion cards when
  the panel opens: tasks created by hand month after month (recurring
  template candidates), the same time entry logged manually 3+ times, and
  recurring templates whose schedule looks stalled. Each card deep-links to
  the right page; "Don't show again" dismisses it permanently. The owner can
  also just ask "what do I do repeatedly?" in chat.
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
    which fixed-fee clients eat more time than their fee implies.
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
  - **"Why can't [person] log time?"** — it checks the same two gates the
    timer itself applies and names what's stopping them: a **locked
    timesheet month** (only an owner can unlock it, on the Timesheet page),
    or an **earlier week** that was never submitted or was sent back for
    changes (that person submits/resubmits it). It names every blocking week
    at once, says who fixes each, and says plainly when nothing is blocking
    them. It answers for logging time TODAY; backfilling a week that has
    already ended is never gated, so only the month lock can stop that. Owners
    are exempt from both gates, and a removed team member is reported as such
    rather than as a gate.
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
- Can turn a **switched-off recurring checklist back on** — the one fix it
  can make from a diagnosis. Like every other action it only proposes:
  a confirmation card appears and nothing happens until the owner taps
  "Run it", and switching it off again undoes it. For any OTHER missing
  ingredient (no steps, no due date, no client) it tells the owner exactly
  what to fix and where — it does not change those itself.

## Updates (owner only)

- A tracker for pending feature updates and bug fixes — the owner's roadmap.
  Items come from two places: requests drafted by this assistant (chat →
  "Send to Alex") land here automatically, and the owner can add items directly.
- Adding an item directly: title, type, **priority (set right in the add form —
  no need to create first and hunt for it afterwards; defaults to Medium)**,
  and a plain-language description.
- **"Just spitballing…" (Britt's Brain)**: for ideas that aren't requests yet.
  The button at the top opens a little chat where the AI thinks it through
  WITH the owner — reflecting the idea back and asking a few questions per
  turn, never pushing toward a spec. When the idea has shape (or she clicks
  "Wrap it up & organize"), the AI offers an organized draft (The idea / What
  it could look like / Open questions / Why it matters) and one click saves it
  to the **Britt's Brain** section — a parking spot for thinking, NOT the dev
  queue: these items are excluded from "Copy all" and the developer's queue
  runs until Alex moves one to Planned via the normal status dropdown. The
  full chat transcript is kept in the item's notes. If the AI is unavailable,
  "Save my notes as-is" still files the raw idea so nothing is ever lost.
- **Just spitballing remembers.** The brainstorm is saved as you go, on the
  server — close the window, come back tomorrow, or open the app on a different
  device and the conversation is simply there, right where you left it. A long
  session is never forgotten either: once it runs past about thirty messages the
  earlier part is condensed into a running summary the AI keeps referring to,
  instead of quietly dropping off the front. And each finished brainstorm is
  remembered for the next one — say "like we talked about last time" and it
  knows, because it can see the gist of your past sessions plus the titles of
  everything already parked in Britt's Brain. **"Start fresh"** (at the bottom of
  the window) tucks the current brainstorm away — it asks first if there's
  anything in it — and starts a clean one; nothing is deleted, and the archived
  session is exactly what the AI recalls later.
- **When the AI is at capacity, spitballing says so instead of getting worse.**
  If the AI provider is overloaded, the brainstorm shows "The AI is at capacity
  right now — give it a minute and try again. Your notes are safe." rather than
  quietly answering with a weaker stand-in model — a degraded reply would be
  saved into the conversation and drag down everything after it. Waiting a
  minute and re-sending is the fix; nothing typed is lost. (Other AI features —
  Refine for dev, the feedback read-back — do quietly use the stand-in, because
  their suggestions are reviewed before anything is saved.)
- Each item has a type (Feature / Bug / Improvement), a status (New → Planned →
  Planned (not near EOM) → In Progress → Needs answer → Shipped → Done, or
  Won't do), and a color-coded priority level — Urgent (red), High (orange),
  Medium (blue), Low (slate).
- **Planned (not near EOM)**: a parking lane for planned items that touch a lot
  of the app. The developer's queue only picks these up MID-month (roughly the
  6th through the 23rd), never during the firm's month-end close window, so a
  risky change can't break things right when the books are being closed. Move
  an item in or out with the normal status dropdown.
- **Needs your answer** (clarification loop): when the developer can't build an
  item without a decision, it moves to "Needs answer" with the blocking question
  attached. Those items appear in an amber panel pinned ABOVE all sections, each
  with the question, an answer box, and an "Answer & return to Planned" button —
  answering stores the answer on the item (shown as "Q: … — A: …" on its card
  afterwards) and puts it straight back into the Planned queue for the developer.
- Every Shipped item shows **when it went live** ("Shipped Jul 24 · 9:12 PM")
  right next to its title, so the owner knows how fresh each change is while
  reviewing. Re-shipping (after a send-back) re-stamps the time.
- Layout: a TAB BAR across the top, one tab per status, each showing its COUNT —
  so the shape of the whole queue (how many New, Planned, In Progress, Shipped…)
  is visible at a glance without opening anything, and one click switches
  between them. Shipped is the first tab and the default, so the owner still
  lands on just-shipped work awaiting her sign-off. Empty statuses keep their tab
  (showing 0) because "In progress 0" is itself useful; the "Hide Done / Won't
  do" toggle removes those two tabs entirely, and if the selected tab disappears
  the view falls back to the first one. Within a tab items are ordered by
  priority level (Urgent → Low) and drag-to-rank within their level; dragging
  only re-ranks within the same status. Changing an item's status moves it to
  the matching tab; changing its priority moves it between levels.
- Ship + approve workflow: when the developer has pushed an update they set the
  item to "Shipped" (a distinct violet badge; still open/awaiting sign-off) —
  the Shipped tab is captioned "Awaiting your approval". A Shipped
  item shows a "Mark approved" button (moves it to
  "Done" and records who approved it and when — "Approved by <name> · <date>") AND
  a "Not approved" button, which opens a reason box. Clicking "Send back" first
  runs an **AI read-back**: the assistant restates the reason in the owner's own
  terms ("So the change you want is …" — or asks which of two readings she
  means), and only after she clicks "Yes — send back" is it filed. The item then
  returns to **Planned** (straight back into the developer's queue — same as
  answering a clarification) carrying an amber "Not approved — <date>: <reason>"
  note plus the confirmed dev-ready rework spec. If the AI is unavailable there's
  a "send back without the read-back" fallback, so feedback is never blocked.
  An In-Progress item's whole card gently pulses.
- Editing an item: click the title or the "Edit" button to edit the title +
  description in place; a Save button commits the change (typing doesn't
  auto-save). Status, priority, and type still change immediately from their
  dropdowns.
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
