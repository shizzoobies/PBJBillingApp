# PB&J App — "To 100%" status & what's new (for Brittany)

_Prepared 2026-06-19 for the walkthrough with Brittany. Companion to the live
**"To 100%"** page in the app (sidebar), which always shows the current,
self-updating version of the checklist in Part 2._

---

## Part 1 — What's new in this round (things to try)

Everything below is live in the app. Walk through these together and jot
feedback as you go.

### Saving is fixed (the big one)
- **The "it says all changes saved but didn't" bug is fixed.** The "saved"
  indicator now only says *All changes saved* once your change is actually on
  the server, and the app will no longer wipe out what you're typing when it
  syncs in the background. If a save ever fails it now keeps retrying and stays
  on a clear error state instead of pretending it saved.
- This likely also fixes the checklist complaints (edits that "didn't stick").

### Billing
- **No more per-client hourly rate.** Hourly clients are now billed off each
  **team member's own bill rate**, set on the **Team** page (expand a person →
  *Bill rate*). The invoice shows one "Billable hours — <name>" line per person.
- **You can set your own rate.** The bill-rate box now shows for owners too, so
  your own billable hours get billed.
- **Team billable hours no longer read zero** — the employee report now includes
  owners and shows a **Billable $** column (hours × bill rate).

### Clients & checklists
- From a client's page, the **recent checklists now link straight to the exact
  checklist** so you can jump in and edit it. Active checklists are editable
  right on the client page.
- **Plans → checklists → board:** on the **Plans** page you can attach checklist
  templates to a plan; on a client who's on that plan, a **"Set up plan
  checklists"** button adds that standard work to the client, and it shows up in
  the right **Board** column automatically.

### Contacts
- A contact can be **on many companies with a different email per company**.
- The contacts list now shows **which clients** each contact is tied to (by
  name), and **flags contacts not linked to any client**.
- You can **link contacts together** and **archive old contacts** (hidden from
  the active list and client pickers).

### Reports & recap
- **Client Recap:** the sales-tax area was removed.
- **Reports:** new **"Hours by month"** CSV download — one row per time entry
  (date, employee, client, task, hours, billable, description).

---

## Part 2 — Your "To 100%" setup checklist

The app now has a live **"To 100%"** page (sidebar) that lists exactly what's
left to finish, updating itself as you fill things in and deep-linking to each
fix. It checks:

- **Billing** — Monthly/Annual clients that have no rate set (invoice would be
  $0).
- **Clients** — clients missing a billing email, with no assigned team member,
  with no contact, or on a plan whose plan-checklists haven't been set up yet.
- **Team** — team members (including you) with no **bill rate** set.
- **Plans** — plans with no checklist templates attached.
- **Contacts** — contacts not linked to any client (link them or archive them).

When all of those are done, the page shows **"You're all set — 100%."**

---

## Still open / not in this round (for discussion)

- Per Brittany's review tomorrow — gather feedback on the above, especially the
  Plans↔checklists↔board flow (first pass) and the per-employee billing.
- Voice assistant will be re-provisioned after deploy so it knows all the new
  features.
