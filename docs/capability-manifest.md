# PB&J Strategic Accounting — Capability Manifest

This document is the AI assistant's complete knowledge of what the app can and
cannot do. It is sent to the model as system context. Keep it accurate: any
commit that adds, changes, or removes a user-facing feature MUST update this
file in the same commit.

Audience note: the assistant talks to the firm OWNER. Staff (bookkeepers)
see a reduced version of the app — owner-only abilities are marked.

## Navigation map

Sidebar pages: Dashboard, Time, Timesheet, Time Approvals, Checklists, Board,
Delayed, Clients, Client Recap, Contacts, Reports, Productivity, Gantt,
Invoices, Plans, Team, To 100%, Updates (owner only), Settings. A billing-month
picker, notification bell, and account menu sit in the top bar on every page.
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

- Live timer: pick employee → client → optional task (checklist) → describe
  the work → start/stop. The most accurate way to log time.
- Track time for a single client, or SPLIT it across multiple clients.
  Available to EVERYONE who logs time (not just owners); the server enforces
  that every client picked is one that person is allowed to bill.
  - Log time manually → pick "A group", choose the clients, and choose how to
    divide the block (evenly, a custom minutes-per-client amount, or the full
    duration to each). Saving creates one billable entry per client in a single
    action (a live preview shows each client's share) — a true one-step split,
    no leftover "un-split" entry.
  - Live timer → pick "A group" and the clients, track the block, then "Split
    across clients" on the saved entry (in Recent time) to divide it the same
    ways. (Splitting a running timer happens after stop.)
- Administrative work toggle: internal/company time with no client or task.
- Log time manually: same fields plus date and duration, for after-the-fact
  entries. Manual entries are flagged for owner approval ("manual" badge) and
  notify the owner.
- "Get ahead" tasks: the task dropdown includes upcoming recurring tasks that
  haven't materialized yet; picking one generates it now so time can be logged
  against it. Staff can do this for their assigned clients.
- Recent time list: edit or delete your recent entries (until approved/locked).
  The list is scoped by the shared Report period (defaults to this month); the
  live timer and the log form aren't affected by it.
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
- Approval queue: filter Pending / Rejected / All individual submitted entries.
- Timesheet locks: lock a month per employee — pending entries are
  auto-approved and the employee can no longer change that month. "Lock all"
  locks everyone at once. Locking is the month-end sign-off. Only a month that
  has ALREADY ENDED can be locked — the current (in-progress) or a future month
  can't be, since that would block everyone from tracking time in it (the
  per-row Lock button and "Lock all" are hidden for such months; the server
  rejects it too). Unlocking any month always works.

## Checklists (tasks)

- A checklist = a task for a client: title, client, assignee, due date,
  frequency (one-off, weekly, monthly, quarterly, annual), steps.
- Steps support sub-steps and sub-sub-steps, drag-to-reorder, per-step due
  date and per-step assignee ("Same as checklist" by default), and checkboxes.
- "Paste a list" turns pasted lines into steps in one go.
- Group the page by due date or by client; filter by assignee, client, status.
- Waiting on (the hourglass ⏳): flag a step as waiting, write who/what it's
  waiting on (free text), optionally pick the SPECIFIC other task it's waiting
  for — when that task completes, the blocked step's assignee gets an in-app +
  email notification ("Ready to continue"). Waiting items also appear on the
  Delayed page.
- Waiting on a PERSON (two-way): you can also flag a step as waiting on a
  specific team member. That person is notified immediately that someone's
  blocked on them, sees it in a "Waiting on you" card on their Dashboard, and
  gets a "Mark done" button — clicking it notifies BOTH the step's assignee and
  whoever flagged it that they can continue. A step can wait on several people
  independently; each is cleared (and notified) on its own. The blocked side can
  cancel a waiting-on, which notifies that person it's no longer needed.
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
- Edit approval (edits to someone else's task): a task now tracks who CREATED it.
  When you edit a task you created — or you're the owner — the change applies
  immediately. When you edit a task SOMEONE ELSE created (its details title/due/
  assignee, editing a step, or adding a step), the change does NOT apply — it's
  routed as a PENDING EDIT to that task's creator (tasks with no human creator —
  recurring/template/onboarding — route to the owner). The approver sees a "Pending
  task edits" queue at the top of the Checklists page with a "field: old → new"
  summary and Approve (apply) / Reject (discard), gets a bell notification, and the
  edited task shows an "Edit pending approval" badge until resolved; the editor is
  notified on approve/reject. Completing/checking off steps and "waiting" flags are
  the work, not edits — they always apply directly.
- Sharing/visibility: a team member assigned to a client sees ALL of that
  client's tasks (the whole shared board), not just tasks assigned to them
  personally. They can log time against any of those tasks AND add/edit items on
  any checklist for a client they're assigned to (deletions still need owner
  approval, per above). Staff can also CREATE a one-time task for any client
  they're assigned to (the "New task" button on the Checklists page). Owners can
  create/edit everything.
- Recurring checklists (the repeating "recipes") — team members can now VIEW the
  recurring checklists for the clients they're assigned to, on that client's
  detail page ("Recurring checklists" section), plus an "Upcoming (next 60 days)"
  list of the instances those recipes will generate — so they know what exists
  and what's coming and don't create duplicates. It's read-only for staff: they
  can't add, edit, or turn recurring recipes on/off (that stays owner-only), but
  they CAN add items to the already-generated checklists (which routes to the
  owner for approval, like any staff structural edit).
- Standard templates (the firm's client-agnostic blueprints) are visible READ-ONLY
  to every team member on the Checklists page ("Standard templates" section) — they
  can browse the standard steps but only an owner can edit a blueprint or apply one
  to a client.
- Time logged against a task shows on the card.

## Board — Active Checklists (sidebar: "Board")

- A second view of the active checklists, laid out as **columns by service
  type** (the columns are "service categories" — e.g. Monthly Bookkeeping,
  Quarterly Bookkeeping, Sales Tax, Payroll). Each column lists the **clients
  that still have open work** of that type; a count badge shows how many.
- Each client row is **collapsible** — expand it to see and work the client's
  live checklist(s) for that column (same checkboxes/cards as the Checklists
  page). Completing a client's checklist **removes that client from the column**
  automatically, so the board always shows what's still open.
- **Report period** at the top (the shared date-range control): the board is a
  horizon — a checklist shows when it's due on or before the END of the selected
  period (`to`), so overdue work stays visible and the view widens as you pick a
  larger range (week → month → quarter → year-to-date → custom).
- **Scoping:** staff see only the clients they're assigned to (same as the rest
  of the app). The board is available to everyone, not owner-only.
- **Filter by client:** a "Filter by client" dropdown in the board toolbar
  narrows the board to one or more selected clients (multi-select checkboxes);
  "Clear" (or no selection) shows all clients again. It only lists clients that
  currently have work on the board, and hides itself when there's ≤1.
- **Which column a checklist lands in:** set its "Board column" on the repeating
  template (or one-time task) — generated checklists inherit it. Anything with no
  column shows in an "Uncategorized" column.
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
  blocked and why. Staff see it scoped to their assigned clients; the owner sees
  the whole firm. Clear the flag from the Checklists page (or under the client)
  once unblocked.
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
  bookkeeper(s), plans/services. NOTE: there is no per-client hourly rate
  anymore — Hourly clients are billed off each team member's own bill rate (set
  on the Team page). Right after saving, a prompt asks "Open their checklist
  now?" — choosing yes jumps straight into the new client's checklist + notes
  modal. (Contacts and Plans have the same "+" add-in-a-modal flow.) The header
  (title + "+" + search) stays pinned to the top as you scroll the list, so the
  add button is always reachable.
- Client detail page (owner): everything about one client — tasks, time,
  contacts, billing, branding, invoice settings, notes. A sticky "Jump to
  section" pill bar at the top lets you jump to any section (Profile, Contacts,
  Team, Billing, Plan checklists, Expenses, Branding, Invoice, Checklists,
  Recurring, Activity, Notes); staff see only the pills for sections they can
  access.
- Client detail page (staff): assigned bookkeepers/accountants can open their
  assigned clients in a scoped view — client name + contacts (read-only), active
  & recurring checklists, recent work, and notes. Owner-only sections (billing
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
  panel (add + history) — no need to open the client and scroll. The button is
  tinted green for clients that currently have active checklists, so open work is
  visible at a glance. Right next to it is a "Note" button that opens a
  notes-only modal (add a note + read history) for anyone who just needs to jot
  a note. Both buttons work for owners and assigned staff (bookkeepers /
  accountants) on any client they can see.
- The client's "Active checklists" section has a "Due this month" toggle that
  filters to checklists due in the current calendar month (with a count).
- Client lifecycle / onboarding (owner): every client has a stage —
  Proposal → Onboarding → Active (existing clients are Active). The Clients list
  has stage tabs (Active · Onboarding · Proposal · All, defaulting to Active, with
  counts) and each row shows a stage badge. "Start onboarding" on a client builds
  a 3-stage onboarding checklist (Proposal / Onboarding / Client) and moves the
  client to Proposal; as the team completes each stage of that checklist the
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
  grand total, and a Download CSV.
- Month summary: tracked hours, internal hours, billable mix, projected
  billing, employee coverage.
- Employee report (hours by person, including billable $ = each person's
  billable hours × their bill rate; owners are included) and Client report
  (hours by client), each with Download CSV. Print-friendly output.
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
- Customize: adjust line items before sending.
- Email invoice (via the configured email service) or Print invoice
  (print-formatted sheet with firm branding).
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

## To 100% (setup checklist, owner only)

- A live "Setup checklist" page (sidebar: "To 100%") that lists everything still
  missing for the workspace to be fully set up, grouped by category. Each
  category section (Billing, Clients, Team, Plans, Contacts) collapses.
- Fix in place: most items open a small QUICK-FIX modal with only the missing
  field(s) — a monthly/annual rate, a billing email, the assigned-team picker,
  or a "Set them up" button for a plan's missing checklists — and save without
  leaving the page (the item disappears the moment it's filled in). Items with no
  single field (bill rate → Team page, contacts, plan templates) deep-link
  instead.
- Ignore: any item can be IGNORED (something the owner knows about but doesn't
  need to fix). Ignored items move to a collapsible "Ignored" section at the
  bottom and can be Restored anytime; the ignore list is saved per owner.
- Checks: Monthly/Annual clients with no rate; clients missing a billing email,
  an assigned team member, or a contact; clients on a plan whose plan checklists
  aren't set up yet; team members with no bill rate; plans with no checklist
  templates; contacts not linked to any client. Shows "You're all set — 100%"
  when nothing is outstanding.
- Suggestions that stand for several outstanding things name each one rather
  than only counting them: the "plan checklists not set up" item lists each
  specific missing checklist by name (already-added ones are excluded, and the
  count matches the named list).
- Checklist items to finish: a separate section (below the setup checks) that
  looks at the actual checklist work — every UNCHECKED step across active
  checklists, named and grouped by client, with each client collapsible. A step
  counts as incomplete when it isn't done (an item with any unfinished sub-step
  is itself unfinished); completed steps are hidden and each checklist links to
  itself so the owner can go check things off. Shows "Every checklist step is
  done" when nothing is outstanding. This is separate from the setup "You're all
  set — 100%" banner, which stays about configuration.

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
- Emails include a one-click sign-in link.

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
  recurring, assign a client to a team member, generate a task list now).
  Nothing changes until the owner taps "Run it" on the card. The assistant
  never takes an action on its own, by voice or by text — every change
  requires the owner's explicit confirmation on a card.
- The voice assistant pulls LIVE firm data when asked: client profitability,
  hours by client/staff, what's overdue or due soon, who's at capacity, and
  the current workspace setup — same numbers as the app's reports.
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

## Updates (owner only)

- A tracker for pending feature updates and bug fixes — the owner's roadmap.
  Items come from two places: requests drafted by this assistant (chat →
  "Send to Alex") land here automatically, and the owner can add items directly.
- Each item has a type (Feature / Bug / Improvement), a status (New → Planned →
  In Progress → Shipped → Done, or Won't do), and a color-coded priority level — Urgent
  (red), High (orange), Medium (blue), Low (slate).
- Layout: the list is organized into one COLLAPSIBLE section per status, each
  with its item count. Shipped is pinned to the TOP and is the only section
  EXPANDED by default (so the owner lands on just-shipped work awaiting her
  sign-off); every other section (New, Planned, In Progress, Done, Won't do)
  starts collapsed. "Expand all"/"Collapse all" and a "Hide Done / Won't do"
  toggle sit in the toolbar. Inside a section items are ordered by
  priority level (Urgent → Low) and drag-to-rank within their level; dragging
  only re-ranks within the same status. Changing an item's status moves it to
  the matching section; changing its priority moves it between levels.
- Ship + approve workflow: when the developer has pushed an update they set the
  item to "Shipped" (a distinct violet badge; still open/awaiting sign-off) —
  the "Shipped" section header reads "Shipped — awaiting approval". A Shipped
  item shows a "Mark approved" button (moves it to
  "Done" and records who approved it and when — "Approved by <name> · <date>") AND
  a "Not approved" button, which opens a reason box; sending it back returns the
  item to In Progress with an amber "Not approved — <date>: <reason>" note so the
  developer sees what to fix. An In-Progress item's whole card gently pulses.
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
