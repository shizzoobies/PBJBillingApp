# Building an in-app feedback loop for the DevOps app

Written 2026-08-15 for the agent orchestrating that build. Self-contained — you
don't need the other project to follow it.

This describes a working in-app feedback loop that has run for months between a
developer and an end client on another app Alex maintains, and adapts it for
**your** situation: an internal DevOps tool where a **team of admins** both files
and monitors the work, rather than a single external owner.

The mechanics are one table and a handful of statuses. **The value is in the
conventions and the ownership rules** — those are what this document is really
for. Read §2 and §5 even if you skim the rest, because that's where a
single-owner design quietly breaks when you point it at a team.

---

## 1. The loop

One page inside the app carries the entire conversation about the product, so
nothing lives in Slack threads or anyone's inbox:

```
An admin files a request
        ↓
It gets an OWNER and a refined spec              (new → planned)
        ↓
Someone builds it                                (planned → in_progress)
        ↓
It ships, verified live                          (→ shipped)
        ↓
THE FILER verifies it against what they meant
        ├── right   → done
        └── wrong   → back to planned, with their words attached
```

Two side channels:

- **A clarification lane** — when the builder can't proceed without a decision,
  the item goes to `needs_input` with one written question. The answer stays
  attached to the item forever.
- **Optional: a brainstorm chat** — a low-stakes AI conversation for half-formed
  ideas that files a draft when it's cooked. Valuable for a non-technical owner;
  **less valuable for admins who can already write a clear ticket.** Don't build
  it first, and possibly don't build it at all. Ask them.

---

## 2. What changes when the audience is a team

The original design assumes one person on each side. Every one of these
assumptions breaks with a team of admins. This section is the reason this
document exists.

**1. An item with no owner is nobody's job.** With one client, "who's handling
this" never came up. With five admins it's the failure mode: items get read by
everyone and picked up by no one, or two people build the same thing. Add
`assigned_to` and make it visible in every list. An item in `planned` with no
assignee is a queue smell — surface it (§6).

**2. "The owner accepted it" becomes ambiguous.** Decide explicitly and enforce
it: **the person who filed it is the person who verifies it.** They're the only
one who knows what they meant. If the filer is unavailable, an admin lead can
accept, but record *who* accepted — `approved_by` isn't decoration on a team.

**3. Duplicate filings are guaranteed.** Three admins will file the same broken
thing during the same incident. Provide search-before-file (even a naive title
match on the create form) and a way to merge or link an item to a primary. If
you skip this, the board fills with near-duplicates within a month and people
stop trusting it as a picture of reality.

**4. Notification fan-out gets loud fast.** One client's tracker generated a
handful of notices a week. A team's will generate that per day. Build per-user
preferences from the start (§7) — retrofitting them after everyone has muted
the channel is too late.

**5. Your filers are engineers, which is a mixed blessing.** They write precise
reproduction steps — and they file **solutions instead of problems**. "Add a
retry to the deploy webhook" hides the actual report, which might be "deploys
silently fail about once a week." Capture both, separately (§4). The proposed
fix is useful signal; it is not the requirement.

**6. This is not an incident tool.** A DevOps app already has alerting, on-call,
and probably a ticket system. Draw the line explicitly and write it on the page:
**this loop is for changes to the app itself** — its features, its bugs, its
usability. Incidents in the *systems it monitors* belong wherever they already
belong. Without a stated boundary this becomes a second, worse incident queue
inside six weeks.

---

## 3. The data model

One table. Everything below the line is what a team needs beyond the
single-owner original.

| Column | Type | Why |
|---|---|---|
| `id` | text PK | |
| `filed_by` | text NOT NULL | who reported it |
| `title` | text NOT NULL | short name; the builder may rewrite for clarity |
| `report` | text NOT NULL | **the filer's own words, never edited** — §4 |
| `proposed_fix` | text | what they think should happen, kept separate — §4 |
| `spec` | text | the refined, buildable statement — §4 |
| `status` | text NOT NULL | §5 |
| `priority` | text NOT NULL | one field only: `urgent`/`high`/`medium`/`low` |
| `area` | text | which part of the app — drives filtering, not logic |
| `dev_notes` | text | append-only, written TO the filer — §8 |
| `review_note` | text | the filer's words when they send it back |
| `clarification_question` / `clarification_answer` | text | the question lane |
| `shipped_at`, `created_at`, `updated_at` | timestamptz | |
| — | | |
| `assigned_to` | text | **who owns it now** (§2.1) |
| `approved_by` / `approved_at` | text / timestamptz | who accepted, on a team (§2.2) |
| `duplicate_of` | text FK → same table | merge target (§2.3) |
| `status_changed_at` | timestamptz | **age-in-status, the basis of monitoring (§6)** |
| `resolved_by_ref` | text | commit SHA / deploy id that closed it |

Notes from experience:

- **`status_changed_at` is not the same as `updated_at`.** A note added to an
  item touches `updated_at` but the item hasn't *moved*. Every staleness view
  you'll want is built on time-in-current-status, so store it separately and set
  it only on a status transition.
- **`resolved_by_ref` is nearly free here and worth it.** For a DevOps audience,
  "which deploy fixed this" is a question that will absolutely get asked.
- **One priority field.** The reference app carries both a boolean `urgent` and a
  text `priority` because they were added at different times. It's a scar, not a
  design. Don't reproduce it.

---

## 4. Filing: separate the symptom from the proposed fix

This is the adaptation that matters most for a technical audience.

Give the create form **three** fields, in this order:

1. **What happened / what's wrong** → `report`. The observed behavior.
2. **What you think should happen** (optional) → `proposed_fix`.
3. **How to see it** → repro steps, into `report` or its own field.

Then the builder writes `spec` — the buildable statement — while leaving
`report` untouched forever.

Why the split: an engineer filing "add a retry to the deploy webhook" has
already made a design decision, and if you build exactly that you may fix
nothing. The underlying report ("deploys silently fail about once a week") might
be better served by surfacing the failure than by retrying it. **Keep both. Build
against the report; treat the proposed fix as expert input, not as the spec.**

Every spec should end with an explicit, observable close condition:

```
Fixed when: <the thing someone can look at and agree about>
```

If you can't write that line, you don't understand the request yet. Ask (§9).

---

## 5. Statuses and who may move them

```
new  →  triaged  →  in_progress  →  shipped  →  done
          ↑                            │
          └────── sent back ───────────┘
                (review_note set)

needs_input   — blocked on an answer
blocked       — blocked on something else (name it in dev_notes)
duplicate     — closed, pointing at duplicate_of
wont_do       — closed deliberately, with a reason in dev_notes
```

- **`new`** — as filed. Unrefined, unassigned.
- **`triaged`** — has an **owner**, a priority, and a spec. Nothing enters this
  state without an `assigned_to`. (The reference app calls this `planned`; use
  whatever word your admins already say.)
- **`in_progress`** — actively being worked. Set it honestly; a queue where
  everything sits in `in_progress` tells you nothing.
- **`shipped`** — **deployed and verified live**, not "the code is merged." The
  rule that has saved the reference project repeatedly: tests green → pushed →
  deploy reports SUCCESS **on that commit's hash** → health check passes. A
  failed push followed by a health check will cheerfully report the *previous*
  version as healthy; match the hash.
- **`done`** — the filer confirmed it (§2.2).
- **`wont_do`** — a real state. An unanswered "no" rots at the bottom of a board
  forever; a stated "no, because…" closes cleanly.

---

## 6. Monitoring the queue (your "monitored" requirement)

With a team, the queue itself needs watching or it silently rots. Build a small
admin dashboard on top of `status_changed_at`. Everything here is a single
query:

- **Counts by status**, with the total in flight.
- **Unowned work** — anything in `triaged` with no `assigned_to`. Should be zero.
- **Stalled** — items whose `status_changed_at` is older than a threshold you
  agree per status (e.g. `in_progress` > 7 days, `needs_input` > 3 days). These
  are the two that actually hurt: work that stopped, and questions nobody
  answered.
- **Awaiting verification** — `shipped` items nobody has confirmed. On a team
  this is the biggest silent pile; things get built, deployed, and never
  looked at. Nudge the filer, not the whole channel.
- **Oldest open item** — a single number that keeps everyone honest.
- **Reopen rate** — how often shipped items come back. If it climbs, the
  refinement step (§4) is being skipped, not the coding.

Make it a page admins actually land on, and keep it to numbers they can act on.
A dashboard with fourteen charts gets ignored exactly as fast as no dashboard.

---

## 7. Notifications without fatigue

- **In-app is the source of truth; email/Slack is best-effort.** Never let a
  delivery failure break the action that triggered it. Log and move on.
- **Per-user, per-event-type preferences**, stored as a sparse map of opt-outs
  where a missing key means "on." Default sensible, let people trim.
- **Route by role in the item, not by broadcast.** The assignee hears about
  their items; the filer hears when theirs ships or needs an answer; an admin
  lead can opt into the firehose. Nobody should need to mute the whole thing.
- **A daily digest beats per-event mail** for anything that isn't blocking.

---

## 8. Dev notes are written to the filer

`dev_notes` is append-only, chronological, and addressed to the person who filed
it. Even with a technical audience:

- **Lead with what they'll see**, not what you changed. "Deploys that fail now
  surface in the activity feed within a minute" beats "added a webhook retry."
- **Say what was actually wrong** — especially when the app was at fault.
- **State limits in the same note, not later.** "Failures from before today
  weren't recorded, so the history starts now." People forgive limits they're
  told about and lose confidence over ones they discover.
- **Say what you did NOT do.** Deferred scope and judgment calls belong in
  writing. An admin who finds an undisclosed gap stops trusting the disclosed
  ones.
- **When the filer was right, say so plainly.** Costs nothing.
- Reference the commit or deploy in `resolved_by_ref`, not in prose.

---

## 9. The clarification lane

1. `status = needs_input` plus **one** question, with the trade-off stated in
   terms the filer can decide on.
2. They answer in the app; the answer stays attached.
3. Back to `triaged`.

**Only ask when the answer changes what you build.** Otherwise pick the
defensible option, build it, and record the choice in the dev notes with an
offer to change it. A queue that asks five questions a week trains people to
ignore the sixth. Also: put an SLA on this lane in your monitoring (§6) — an
unanswered question is the most expensive state an item can be in, because the
work is loaded and stopped.

---

## 10. Conventions that carry over unchanged

Learned the hard way on the reference project:

1. **"Still not working" usually means the interpretation missed, not the code.**
   Reproduce the filer's exact steps before touching anything. One complaint
   there took four rounds because each pass re-read the diff instead of the
   report — the real issue was that the field they wanted to edit had no input
   at all.
2. **Verify against real data before believing anything**, including your own
   prior fix and including comments in the code. A comment there asserted an
   authorization rule that was false for 8 of 11 endpoints.
3. **Never mark shipped what isn't live.** Match the deployed hash (§5).
4. **Validate risky database changes against production in a rolled-back
   transaction** before deploying them — especially anything touching a
   wholesale write path. Cheap, and it has caught real breakage.
5. **Own mistakes out loud in the notes.** Trust compounds; so does its absence.

---

## 11. Build order

1. Table + statuses + a list grouped by status. Nothing else.
2. Filing (three fields, §4) and triage (owner + priority + spec).
3. Dev notes on the item.
4. The verification step: accept, or send back with the filer's words.
5. Assignment and the unowned/stalled views (§6) — early, not last. This is what
   makes it work for a team rather than a person.
6. Notifications with preferences.
7. Duplicate linking.
8. Brainstorm chat only if they actually want it.

Steps 1–5 are the product.

---

## 12. Decide these with the admins before building

- **Who may file?** All admins, or everyone who uses the app? (Wider means more
  signal and more triage load. Pick deliberately.)
- **Who triages, and how often?** An unowned queue is the default failure. A
  standing 15 minutes on a set day beats good intentions.
- **Who accepts a shipped item if the filer is out?**
- **What's the boundary against your existing incident/ticket tooling** (§2.6),
  and should items link to it rather than duplicate it?
- **What's your dangerous window** — the change-freeze equivalent (release
  weeks, audits, peak season)? The reference project holds risky changes during
  its client's month-end close. Yours will have one; honor it in the workflow
  rather than in someone's memory.
- **Do stalled items nudge a person or a channel?** (A person. Almost always a
  person.)
