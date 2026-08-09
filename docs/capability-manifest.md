# PB&J Strategic Accounting — Capability Manifest

This document is the AI assistant's complete knowledge of what the app can and
cannot do. It is sent to the model as system context. Keep it accurate: any
commit that adds, changes, or removes a user-facing feature MUST update this
file in the same commit.

Audience note: the assistant talks to the firm OWNER. Staff (bookkeepers)
see a reduced version of the app — owner-only abilities are marked.

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
- Recent activity feed (owner).
- Quick actions: New task, Invite bookkeeper, Add client, Notifications.
- "Viewing as" (owner): preview the app exactly as a specific bookkeeper sees
  it (read-only preview; exit anytime).

## Time tracking (Time page)

- Live timer: pick employee → client → optional task → describe
  the work → start/stop. The most accurate way to log time.
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
    entry's current client already ticked. Tick the others, choose evenly /
    custom / full duration to each, confirm. This is what to use when someone
    logged time to one client and then realized the work covered several.
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
    switch modes, then save.
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
  - A CUSTOM split must add up EXACTLY to the tracked block — to the second, not
    the minute. The modal shows how much is still unassigned (or over) and has a
    one-click button to hand the remainder to the last client; the split can't
    be saved until it balances. Even splits divide the block to the exact second
    and always add up. "Full duration to each client" is the deliberate
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
  logged time before they can log time in a LATER week. A prior week blocks when
  it's un-submitted (never submitted) OR was sent back for changes (rejected) —
  they get a message naming the week to submit/fix. A week that's already
  submitted (pending owner approval) or approved does NOT block, so an
  awaiting-approval week never locks them out. Logging in the current week is
  always fine.

## Timesheet page

- Day-by-day view of what each person worked on, scoped by the shared Report
  period, with a total. Owner can switch between team members; staff see their own.
- Single-week mode (Report period = This week, or a one-week range): navigate
  weeks with ◀ ▶ arrows or "This week", and the per-week Submit / approval /
  lock workflow shows for that week.
- Multi-week range: the day list + total are read-only (no Submit/lock); pick a
  single week to submit or lock — the weekly submission model is unchanged.

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

- **The page is split into three TABS: "In progress", "Repeating" and
  "Standard"**, each showing a count. They used to sit stacked on top of each
  other, so getting to a repeating task meant scrolling past every in-progress
  checklist (hundreds of them). Now each is one click away.
  - **In progress** — the live checklists, exactly as before: the
    "Group by: Due date / Client" choice and its collapsible Overdue / Due this
    week / Due this month / Later / Completed sections are unchanged.
  - **Repeating** — the recurring task setups (owner edits them here; staff see
    the recurring checklists for their assigned clients).
  - **Standard** — the firm's reusable blueprint templates.
  - On "Repeating", tasks are grouped under their business, listed
    alphabetically, and **each business starts COLLAPSED** — you see a scannable
    list of business names with a count each, and click one to open its tasks.
    (Searching opens matching businesses automatically, and a link that jumps to
    a specific repeating task opens its business too.)
  - **Every tab has a search box.** On "Repeating" it matches the BUSINESS name
    or the task name, so you can jump straight to a client's repeating setup
    instead of scrolling the whole list; "Standard" searches template names, and
    "In progress" searches business or task name as before. Each shows "N of M"
    while you type, and Escape clears it.
  - The count on each tab reflects what you'd actually see — the "In progress"
    count applies the current report period and the assignee/client/status
    filters. If that count looks low, the report period is usually the reason
    (a narrow custom range hides everything outside it).
  - The "+ New" button stays available from all three tabs.
  - Links that jump to a specific task or a specific repeating setup switch to
    the right tab automatically, so a link never lands on a hidden area.
  - The recycle bin sits below the tabs and is always available (owner only).
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
  email notification ("Ready to continue"). Waiting items also appear on the
  Delayed page.
- Resolving a waiting step — **Done vs Clear** in the waiting editor: **Done**
  retires the blocker and keeps the waiting note visible on that checklist as a
  "Was waiting on: …" record (that instance only — future recurring instances
  start fresh), so there's a history of what the team keeps waiting on. Done
  does **NOT** check the step off — completing the work stays with the normal
  checkboxes (owner feedback: the reference should sit on the still-open step).
  **Clear** just un-flags and erases the note. Resolved steps stop counting on
  the Delayed page and the Board's pending chips. Done retires the WHOLE wait in
  one press — including any "waiting on a person" blockers on that step — and
  you see it happen: the amber "Waiting on: …" badge turns into a green "Was
  waiting on: … ✓" and the amber editor closes. If the server refuses (e.g. a
  blocker only its owner may mark done), the reason appears in red inside the
  waiting editor instead of the button appearing to do nothing.
- Waiting on a PERSON (two-way): you can also flag a step as waiting on a
  specific team member. That person is notified immediately that someone's
  blocked on them, sees it in a "Waiting on you" card on their Dashboard, and
  gets a "Mark done" button — clicking it notifies BOTH the step's assignee and
  whoever flagged it that they can continue. A step can wait on several people
  independently; each is cleared (and notified) on its own. The blocked side can
  cancel a waiting-on, which notifies that person it's no longer needed.
- **The hand-off has TWO steps, and the record is kept.** Clearing a wait used to
  delete it, which meant the name of whoever did the check disappeared the moment
  they finished. Now a wait moves through three states and is never destroyed:
  1. **Waiting** — amber. Sits on the Delayed page of the person being waited on,
     and of whoever asked (and the step's assignee, who is the one held up).
  2. **Done** — the person being waited on presses **Mark done**. It leaves THEIR
     Delayed page, notifies whoever asked, and shows green with "done by <name>"
     and a date, tagged "awaiting your OK".
  3. **Confirmed** — whoever asked presses **Confirm**. The wait closes out and
     leaves their Delayed page too, staying on the step in grey with a line
     through it, still naming who did the check and who confirmed.
  You cannot confirm work nobody has reported finished (the app says so and
  points you at Cancel instead), and the person who did the work cannot confirm
  their own. Owners can do either step on anyone's behalf. **Cancel** is
  unchanged and still erases the wait outright — that means "this never needed to
  happen", so no record is kept.
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
  owner as an override. Being assigned to the client lets you SEE and EDIT the
  checklist (add steps, rename, due dates) but never complete someone else's
  work; sub-steps follow their parent step's responsible person. Boxes you can't
  tick render disabled with a "assigned to someone else" tooltip, and the server
  enforces the same rule.
- Sharing/visibility: a team member assigned to a client sees ALL of that
  client's tasks (the whole shared board), not just tasks assigned to them
  personally. They can log time against any of those tasks AND add/edit items on
  any checklist for a client they're assigned to (completing steps is limited to
  the assigned person, per above; deletions still need owner approval). Staff can also CREATE a one-time task for any client
  they're assigned to (the "New task" button on the Checklists page). Owners can
  create/edit everything.
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
- **Scoping:** staff see only the clients they're assigned to (same as the rest
  of the app). The board is available to everyone, not owner-only.
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
- An older free-text wait with nobody attached to it still shows to the step's
  assignee (or to everyone if the step has no assignee), so nothing that predates
  the two-step hand-off silently vanishes from the page.
- Each row has a "Done" button that checks the step off right here — the same
  toggle used on the Checklists page / dashboard — so whoever was tagged (e.g. a
  bookkeeper waiting-on'd for a step) can complete it without leaving this page.
  A completed step drops off the list (done steps aren't shown).

## Clients (owner manages; staff see assigned)

- Client list: contact, billing type (Hourly / Monthly subscription / Annual),
  rate, assigned team, plans/services.
- Add client: a "+" Add client button in the top-right of the page header
  (opposite the "Clients" title, above the search bar; owner only) opens an
  Add-client modal. Fields: name, primary contact,
  billing type, monthly/annual rate (for subscription/annual clients), estimated
  monthly hours per role (informational only — never affects invoices), assigned
  bookkeeper(s), other contacts, plans/services. NOTE: there is no per-client hourly rate
  anymore — Hourly clients are billed off each team member's own bill rate (set
  on the Team page). Right after saving, a prompt asks "Open their checklist
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
  pick an optional task and a note, and starts the shared
  timer — the same one the Time page drives, so it keeps running as you navigate
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
- Assigned team controls which staff can see/log time for the client.

## Client Recap (owner only)

- A per-client review page (sidebar: "Client Recap") with a Monthly / Quarterly
  toggle and prev/next period navigation. Pick a client and see a full
  breakdown for the period: Time & hours (total / billable / administrative, by
  staff, vs. the prior period); Tasks & workflow (due / completed / overdue this
  period); Billing (revenue for the period, rate/plan, reimbursements); and
  Profitability (realized rate = fee ÷ hours, and margin when team cost rates are
  set).
- **Revenue here is now the same number the invoice bills.** It used to value an
  hourly client's time at that client's single hourly rate, but invoices have
  charged each team member's own bill rate since June 2026. On July 2026 data
  the two disagreed for 16 of 19 hourly clients — in both directions, so it was
  not a consistent offset: one client read $4,400.83 in Recap against a real
  invoice of $3,837.58, while another read $894.13 against $1,252.69. Recap and
  the invoice are now produced by one shared calculator, so **profit figures for
  hourly clients have shifted, some up and some down** — the new numbers are the
  correct ones. Monthly and annual clients are unaffected. A quarter is summed
  month by month rather than estimated as a rate times three.

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
- **Time is shown EXACTLY, e.g. "2m" or "1h 20m", not rounded to a decimal.**
  This matters for split time: a block divided across several clients leaves
  each client a few minutes, and the old one-decimal rounding printed those as
  "0.0h" — the hours appeared to vanish, and the rows didn't add up to the
  total. They do now.
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
> **Stripe is connected in TEST (sandbox) mode.** Payment links and the payment
> flow work end-to-end, but no real money can move until live Stripe keys are
> set. If asked whether a client can actually pay from the app: the plumbing is
> live, but it is still running on test keys — real payments are not taken yet.
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
> there is a **Send** button. It emails the invoice to the client's linked
> contacts (honoring a per-client email override on a shared contact), falling
> back to the email on the client record; if nobody has an address on file, it
> says exactly what is missing instead of failing quietly. The email carries the
> full breakdown, total, due date and the note to the client, plus a **Pay by
> bank transfer** button when there is an amount owed — each send gets a fresh
> payment link, and a re-send of a Paid or Processing invoice goes out as a
> statement with NO pay button so nobody can pay twice. Sending marks the
> invoice **Sent**; the first send's date is kept as THE sent date. The editor
> shows the last send ("Sent to ann@acme.com on Aug 9") and the button becomes
> **Send again**. A draft must be **marked reviewed** before it can be sent. A
> failed send shows the email provider's actual error and never marks the
> invoice sent — every attempt, including failures, is kept in a permanent
> per-invoice email log along with the total that was billed at the time.
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
> The per-client section BELOW the run is the older live-calculation view, kept
> for its preview and print.

- Per-client invoice drafts for the selected billing month: subscription
  plans and/or billable hours become line items; total due computed. For
  Hourly clients, billable hours are charged per team member at that person's
  own bill rate — the invoice shows one "Billable hours — <name>" line each.
  This per-employee billing applies from June 2026 onward; invoices for earlier
  months keep computing at the client's prior per-client hourly rate, so already
  -sent historical invoices stay exact and never change retroactively.
- This invoice's reimbursements: add out-of-pocket expenses (date,
  description, amount) — each becomes a line on the invoice. Recurring
  reimbursements supported.
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
- Print invoice (print-formatted sheet with firm branding).
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
  "not scanned", not "verified fine".
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
- Optional two-factor authentication (TOTP authenticator app + backup codes).
- Sessions, login history, and an activity log of actions in the app.
- Per-user revocation (revoke sign-in link / access).

## Notifications

- In-app bell with unread count + email (when email service is configured):
  task assigned, workflow stage advanced, case completed, manual time entry
  needs approval, "waiting cleared" (the task a step was waiting on is done).
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
  waiting-on updates, time entries needing approval, your time entry was
  sent back, deletion requests, edit requests/decisions, and Updates tracker
  activity. Turning a type off stops the EMAIL only — in-app bell notifications
  always arrive. All types default to on.
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
    them. Owners are exempt from both gates, and a removed team member is
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
- Client-facing portal (clients cannot log in or see anything)
- Online payment collection (invoices are sent/printed; payment happens
  outside the app)
- QuickBooks / Xero / bank-feed integration of any kind
- Automatic invoice sending on a schedule (sending is manual, per month)
- Document/file storage for client paperwork
- Payroll features
- Calendar sync (Google/Outlook)
- Native mobile app (the web app is responsive and works on phones)
- Custom report builder (Reports/Productivity CSVs are the export surface)
- Multi-firm / multi-workspace support
- Public API or webhooks
- Email inbox integration
- E-signatures

If the owner asks for one of these (or anything else missing), say it's not
supported yet and offer to send Alex a feature request.
