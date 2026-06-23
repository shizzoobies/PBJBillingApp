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
Invoices, Plans, Team, To 100%, Settings. A billing-month picker, notification
bell, and account menu sit in the top bar on every page.
- Most list/board pages have an instant search box: type to filter by name and
  key fields, with a live result count, matched-text highlight, and a clear
  button. Coverage: Clients (name/contact/email/billing type), Contacts
  (name/title/email/phone/company emails/linked client), Plans (name/notes),
  Team (name/email/role), Checklists & Gantt (task title/client — composes with
  the assignee/client/status filters), Delayed (task title/client/waiting note),
  and the Board (client/task title — composes with the period toggle). Reports
  and Productivity remain aggregate views with their own filters.

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
- Track time for a single client, or split across a group of clients
  (allocates minutes across them).
- Administrative work toggle: internal/company time with no client or task.
- Log time manually: same fields plus date and duration, for after-the-fact
  entries. Manual entries are flagged for owner approval ("manual" badge) and
  notify the owner.
- "Get ahead" tasks: the task dropdown includes upcoming recurring tasks that
  haven't materialized yet; picking one generates it now so time can be logged
  against it. Staff can do this for their assigned clients.
- Recent time list: edit or delete your recent entries (until approved/locked).
- Billable vs non-billable is determined by the client's billing setup.
- Staff can always log time, with one exception: if an owner sent a prior
  week's timesheet back for changes (rejected), that week must be fixed and
  resubmitted before more time can be logged. A week that's simply
  un-submitted or still awaiting approval never blocks logging.

## Timesheet page

- Week-by-week view of what each person worked on, day by day, with a week
  total. Owner can switch between team members; staff see their own.
- Navigate weeks with arrows or jump to "This week".

## Time Approvals (owner only)

- Weekly submissions: staff submit a week; approving seals every pending
  entry in it. Rejecting unlocks the week so the bookkeeper can edit and
  resubmit.
- Weekly review modal: expand any individual entry; per-entry actions —
  "Approve this entry" or "Send back with note" (the note is required and the
  bookkeeper sees it). The owner does not edit staff time directly.
- Approval queue: filter Pending / Rejected / All individual submitted entries.
- Timesheet locks: lock a month per employee — pending entries are
  auto-approved and the employee can no longer change that month. "Lock all"
  locks everyone at once. Locking is the month-end sign-off.

## Checklists (tasks)

- A checklist = a task for a client: title, client, assignee, due date,
  frequency (one-off, weekly, monthly, quarterly, annual), steps.
- Steps support sub-steps and sub-sub-steps, drag-to-reorder, per-step due
  date and per-step assignee ("Same as checklist" by default), and checkboxes.
- "Paste a list" turns pasted lines into steps in one go.
- Group the page by due date or by client; filter by assignee, client, status.
- Waiting on (the hourglass ⏳): flag a step as waiting, write who/what it's
  waiting on, optionally pick the SPECIFIC other task it's waiting for — when
  that task completes, the blocked step's assignee gets an in-app + email
  notification ("Ready to continue"). Waiting items also appear on the
  Delayed page.
- Recurring templates: build a template once (with steps/sub-steps); the app
  materializes an instance each period automatically. Templates support
  multi-stage cases (see Cases). Owner manages templates; "get ahead" lets
  staff generate the next instance early.
- Cases (multi-stage workflows): a template can define stages (e.g. Data
  entry → Review → Filing) with a primary assignee per stage. Completing a
  stage advances the case and notifies the next assignee; the case opener is
  notified when the whole case completes. Stuck cases are flagged on the
  Dashboard.
- Task card actions: Edit details (title, due date, assignee) — available to the
  owner and to a task's assignee/editor. Delete task — for the OWNER it moves the
  task to the owner-only Recycle bin immediately (time entries preserved, restore
  anytime until emptied). For STAFF, deleting — a whole checklist OR an
  individual step/sub-step — files a deletion REQUEST that an owner must approve;
  nothing is removed until then (editing/adding don't need approval). The owner
  sees a "Pending deletion requests" queue at the top of the Checklists page
  (both whole-checklist and per-item requests) with Approve (delete) / Reject
  (keep), and gets a bell notification when a request is filed; the requested
  task/item shows a "Deletion requested" badge to staff until resolved. Owners
  delete immediately (they're the approver).
- Sharing/visibility: a team member assigned to a client sees ALL of that
  client's tasks (the whole shared board), not just tasks assigned to them
  personally. They can log time against any of those tasks AND add/edit items on
  any checklist for a client they're assigned to (deletions still need owner
  approval, per above). Owners can edit everything.
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
- **Period toggle** at the top: This week / This month / This quarter. It's a
  horizon — a checklist shows when it's due on or before the end of the selected
  period, so overdue work stays visible and the view widens week → month →
  quarter.
- **Scoping:** staff see only the clients they're assigned to (same as the rest
  of the app). The board is available to everyone, not owner-only.
- **Which column a checklist lands in:** set its "Board column" on the repeating
  template (or one-time task) — generated checklists inherit it. Anything with no
  column shows in an "Uncategorized" column.
- **Managing columns (owner only):** "Manage columns" on the board lets the owner
  add, rename, reorder, or delete columns. Deleting a column doesn't delete its
  checklists — they move to "Uncategorized" until re-tagged.

## Delayed page (owner + staff)

- Every step flagged "waiting on", grouped by client, so you can see what's
  blocked and why. Staff see it scoped to their assigned clients; the owner sees
  the whole firm. Clear the flag from the Checklists page (or under the client)
  once unblocked.

## Clients (owner manages; staff see assigned)

- Client list: contact, billing type (Hourly / Monthly subscription / Annual),
  rate, assigned team, plans/services.
- Add client: name, primary contact, billing type, monthly/annual rate (for
  subscription/annual clients), estimated monthly hours per role (informational
  only — never affects invoices), assigned bookkeeper(s), plans/services. NOTE:
  there is no per-client hourly rate anymore — Hourly clients are billed off
  each team member's own bill rate (set on the Team page).
- Client detail page (owner): everything about one client — tasks, time,
  contacts, billing, branding, invoice settings, notes.
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
  visible at a glance.
- The client's "Active checklists" section has a "Due this month" toggle that
  filters to checklists due in the current calendar month (with a count).
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
- Archive: archive old/inactive contacts into an Archived section; archived
  contacts are hidden from the active directory and from client contact pickers.
  Unarchive to restore.

## Reports (owner only)

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
  comes with that plan. On a client's detail page, for each plan the client is
  on, a "Plan checklists" panel shows that plan's templates, marks which are
  already set up on the client, and a "Set up plan checklists" button adds the
  missing ones to the client. Because templates carry a board column, the new
  checklists land in the right Active-Checklists-board column automatically —
  connecting plans → checklists → board.

## To 100% (setup checklist, owner only)

- A live "Setup checklist" page (sidebar: "To 100%") that lists everything still
  missing for the workspace to be fully set up, grouped by category and updating
  itself as you fill things in. Each item deep-links to where it's fixed.
- Checks: Monthly/Annual clients with no rate; clients missing a billing email,
  an assigned team member, or a contact; clients on a plan whose plan checklists
  aren't set up yet; team members with no bill rate; plans with no checklist
  templates; contacts not linked to any client. Shows "You're all set — 100%"
  when nothing is outstanding.

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
  activity log.
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
