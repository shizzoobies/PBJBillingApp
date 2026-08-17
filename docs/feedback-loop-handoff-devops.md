# Building an in-app feedback loop for the DevOps app

Written 2026-08-15 for the agent orchestrating that build. Self-contained — you
don't need any other project to follow it.

This describes a working in-app feedback loop that has run for months between a
developer and an end client on another app Alex maintains, adapted for **your**
situation: an internal DevOps tool where **many admins file and watch the work,
and exactly one person — Alex — ships it.**

The mechanics are one table and a handful of statuses. **The value is in the
authority model (§2) and the conventions (§8–§10).** Read those even if you skim
the rest.

---

## 1. The loop

One page inside the app carries the whole conversation about the product, so
nothing lives in Slack threads or anyone's inbox:

```
Any admin files a request
        ↓
ALEX triages it: priority + a buildable spec        (new → triaged)
        ↓
ALEX builds it                                      (→ in_progress)
        ↓
ALEX ships it, verified live                        (→ shipped)
        ↓
THE ADMIN WHO FILED IT verifies it in the app
        ├── right   → done
        └── wrong   → back to triaged, in their own words
```

Plus a **clarification lane**: when Alex can't proceed without a decision, the
item goes to `needs_input` with one written question; the filer answers in the
app and the answer stays attached forever.

An optional **brainstorm chat** (a low-stakes AI conversation that files a draft
when an idea is cooked) is valuable for non-technical owners. Your admins can
already write a clear ticket. **Don't build it first, and probably don't build
it at all** unless they ask.

---

## 2. The authority model — build this in from the start

**Everyone can ask. One person can ship.** That is the rule, and it is not a UI
preference — enforce it server-side. Hiding a button is not a permission model;
a fix on the reference project found 8 of 11 endpoints accepting writes they
should have refused, because the guarding lived only in the interface.

| Action | Who |
|---|---|
| File a request | any admin |
| Edit the report they filed | its filer, until it's triaged |
| Triage: set priority, write the spec, accept into the queue | **Alex only** |
| Move to `in_progress` / `shipped` / `wont_do` | **Alex only** |
| Ask a clarification question | **Alex only** |
| Answer a clarification question | the filer (or Alex on their behalf, recorded) |
| Accept a shipped item → `done` | **the filer** |
| Send a shipped item back | **the filer** |
| Comment / add context | any admin |
| Change someone else's priority or spec | nobody but Alex |

Three consequences worth designing for rather than discovering:

**Alex is the bottleneck, deliberately.** That's a legitimate choice for a tool
that touches production — but it must be *visible*, not silent. An admin whose
request sits untouched for three weeks with no signal concludes the system is
theatre and goes back to Slack. §6 exists mostly for this.

**"Waiting on Alex" is a real state, and should look like one.** Don't leave a
filed item sitting in `new` looking identical to something nobody has read. A
plain "received, not yet triaged" is honest and buys enormous patience. If he's
away, say so on the page.

**Verification stays with the filer, not the shipper.** Alex knows the change is
deployed; only the person who asked knows whether it's what they meant. Never
let the shipper close their own build as accepted — on the reference project
this separation is what surfaces the misreads, and there have been plenty.

---

## 3. The data model

One table.

| Column | Type | Why |
|---|---|---|
| `id` | text PK | |
| `filed_by` | text NOT NULL | who reported it |
| `title` | text NOT NULL | short name; Alex may rewrite for clarity |
| `report` | text NOT NULL | **the filer's own words, never edited** — §4 |
| `proposed_fix` | text | what they think should happen, kept separate — §4 |
| `spec` | text | Alex's buildable statement — §4 |
| `status` | text NOT NULL | §5 |
| `priority` | text NOT NULL | one field: `urgent`/`high`/`medium`/`low` |
| `area` | text | which part of the app; filtering only |
| `dev_notes` | text | append-only, written TO the filer — §8 |
| `review_note` | text | the filer's words when they send it back |
| `clarification_question` / `clarification_answer` | text | the question lane |
| `duplicate_of` | text → same table | merge target — §7 |
| `status_changed_at` | timestamptz | **age-in-status; the basis of §6** |
| `resolved_by_ref` | text | commit SHA / deploy id that closed it |
| `accepted_by` / `accepted_at` | text / timestamptz | the filer's sign-off |
| `shipped_at`, `created_at`, `updated_at` | timestamptz | |

Notes from experience:

- **`status_changed_at` ≠ `updated_at`.** Adding a note touches `updated_at`, but
  the item hasn't *moved*. Every staleness view is built on time-in-status, so
  set this only on a status transition.
- **No `assigned_to` field.** Build is always Alex, so an assignee column would
  be a lie that eventually gets believed. If a second shipper is ever added, that
  is the moment to introduce it — not before.
- **`resolved_by_ref` is nearly free and this audience will ask for it** —
  "which deploy fixed this" is a natural DevOps question.
- **One priority field.** The reference app carries both an `urgent` boolean and
  a `priority` text because they arrived at different times. It's a scar, not a
  design.

---

## 4. Filing: separate the symptom from the proposed fix

The most important adaptation for a technical audience. Three fields on the
create form:

1. **What happened / what's wrong** → `report`
2. **What you think should happen** (optional) → `proposed_fix`
3. **How to see it** → repro steps

Alex then writes `spec`, leaving `report` untouched forever.

Why: an engineer filing *"add a retry to the deploy webhook"* has already made a
design decision. Build exactly that and you may fix nothing — the real report
might be *"deploys silently fail about once a week,"* better served by surfacing
the failure than retrying it. **Keep both. Build against the report; treat the
proposed fix as expert input, not as the requirement.**

Every spec ends with an observable close condition:

```
Fixed when: <the thing someone can look at and agree about>
```

If Alex can't write that line, the request isn't understood yet — that's what
§9 is for.

---

## 5. Statuses

```
new  →  triaged  →  in_progress  →  shipped  →  done
  │        ↑                           │
  │        └────── sent back ──────────┘
  │             (review_note set)
  │
  └──→ needs_input / blocked / duplicate / wont_do
```

- **`new`** — as filed. **Show the filer that it's been received but not yet
  read** (§2).
- **`triaged`** — Alex has set a priority and written a spec. This is the
  promise that it's real work, not a wish.
- **`in_progress`** — actively being built. Set it honestly; a board where
  everything sits here tells nobody anything.
- **`shipped`** — **deployed and verified live**, never "the code is merged."
  The rule that has repeatedly saved the reference project: tests green →
  pushed → deploy reports SUCCESS **on that commit's hash** → health check
  passes. A failed push followed by a health check will happily report the
  *previous* version as healthy. Match the hash.
- **`done`** — the filer confirmed it. Only they can set it.
- **`wont_do`** — a real, respectful state. An unanswered "no" rots at the
  bottom of a board forever; a stated "no, because…" closes cleanly.

---

## 6. Monitoring — mostly about keeping the bottleneck honest

With one shipper, queue health *is* Alex's throughput and the filers' trust.
Build a small dashboard on `status_changed_at`; each line is one query:

- **Untriaged, and how old** — the single most important number. If items sit in
  `new` for weeks, the loop is decaying regardless of how much is shipping.
- **Time-to-first-response** — filing to triage. This is what an admin
  experiences as "does anyone read these?"
- **Awaiting verification** — `shipped` items nobody has confirmed. On a team
  this becomes the biggest silent pile: built, deployed, never looked at. Nudge
  the filer directly, not a channel.
- **Unanswered questions** — `needs_input` older than a few days. The most
  expensive state an item can be in: the work is loaded and stopped.
- **Oldest open item** — one number that keeps everyone honest.
- **Reopen rate** — how often shipped items come back. If it climbs, the
  refinement step (§4) is being skipped, not the coding.

Keep it to numbers someone can act on. A dashboard with fourteen charts is
ignored exactly as fast as no dashboard.

---

## 7. Duplicates and notifications

**Duplicates are guaranteed.** Three admins will file the same broken thing
during the same incident. Give the create form a search-before-file (a naive
title match is enough) and let Alex link an item to a primary via
`duplicate_of`. Skip this and the board fills with near-duplicates within a
month, and people stop trusting it as a picture of reality.

**Notifications, routed by role in the item:**

- **Alex gets everything** — he's the single gatekeeper, so his channel is the
  one at real risk of fatigue. Give him a **daily digest** for new filings and
  immediate alerts only for `urgent`.
- **A filer hears about their own items only**: triaged, shipped (please verify),
  and any question aimed at them.
- **In-app is the source of truth; email/Slack is best-effort** — never let a
  delivery failure break the action that triggered it.
- **Per-user, per-event opt-outs**, stored as a sparse map where a missing key
  means "on." Retrofitting preferences after everyone has muted the channel is
  too late.

**This is not an incident tool.** Your DevOps app already has alerting and
on-call. Write the boundary on the page: **this loop is for changes to the app
itself.** Incidents in the systems it monitors belong where they already belong.
Without a stated boundary this becomes a second, worse incident queue inside six
weeks.

---

## 8. Dev notes are written to the filer

`dev_notes` is append-only, chronological, and addressed to the person who filed
it — even for a technical audience:

- **Lead with what they'll see**, not what changed. "Failed deploys now appear in
  the activity feed within a minute" beats "added a webhook retry."
- **Say what was actually wrong**, especially when the app was at fault.
- **State limits in the same note, not later.** "Failures before today weren't
  recorded, so the history starts now." People forgive limits they're told about
  and lose confidence over ones they discover.
- **Say what you did NOT do** — deferred scope and judgment calls, in writing.
- **When the filer was right, say so plainly.** Costs nothing, buys a lot.
- Put the commit or deploy in `resolved_by_ref`, not in prose.

---

## 9. The clarification lane

1. `status = needs_input` plus **one** question, with the trade-off stated in
   terms the filer can actually decide on.
2. They answer in the app; the answer stays attached to the item.
3. Back to `triaged`.

**Only ask when the answer changes what gets built.** Otherwise pick the
defensible option, build it, and record the choice in the dev notes with an
offer to change it. A queue that asks five questions a week trains people to
ignore the sixth.

---

## 10. Conventions that carry over unchanged

Learned the hard way on the reference project:

1. **"Still not working" usually means the interpretation missed, not the code.**
   Reproduce the filer's exact steps before touching anything. One complaint
   there took four rounds because each pass re-read the diff instead of the
   report — the real problem was that the field they wanted to edit had no input
   at all.
2. **Verify against real data before believing anything** — including your own
   prior fix, and including comments in the code. A comment there asserted an
   authorization rule that was false for 8 of 11 endpoints.
3. **Never mark shipped what isn't live.** Match the deployed hash (§5).
4. **Validate risky database changes against production in a rolled-back
   transaction** before deploying — especially anything touching a wholesale
   write path. Cheap, and it has caught real breakage repeatedly.
5. **Own mistakes out loud in the notes.** Trust compounds; so does its absence.

---

## 11. Build order

1. Table + statuses + a list grouped by status. Nothing else.
2. Filing (three fields, §4), with the permission model enforced server-side
   from the first endpoint — not added later.
3. Triage: priority + spec, Alex only.
4. Dev notes on the item.
5. The verification step: the filer accepts, or sends back in their own words.
6. The untriaged/awaiting-verification views (§6). Early — this is what keeps a
   single-gatekeeper queue from silently rotting.
7. Notifications with preferences and Alex's digest.
8. Duplicate linking.

Steps 1–6 are the product.

---

## 12. Decide with the admins before building

- **Who counts as an admin who can file?** Just the admin group, or anyone who
  uses the app? Wider means more signal and more triage load on one person.
- **What's the promise on first response?** Not a delivery date — just "someone
  has read it by X." That single expectation is what keeps people filing.
- **What happens when Alex is away?** Items wait. Decide whether the page says
  so, and whether anything can jump the queue in a genuine emergency.
- **Where's the boundary against existing incident/ticket tooling** (§7), and
  should items link to it rather than duplicate it?
- **What's the dangerous window** — change-freeze, release week, audit season?
  The reference project holds risky changes during its client's month-end close.
  Encode yours in the workflow rather than in someone's memory.
