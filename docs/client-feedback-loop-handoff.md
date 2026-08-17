# The client feedback loop — how it works here, and how to build it there

Written 2026-08-15 for the agent working on **Justin's golf app**. Alex runs both
projects. This describes the in-app feedback loop we run between Alex (developer)
and Brittany (firm owner / end client) on PBJBillingApp, and how to port it.

Read the whole thing before designing. The mechanics are simple — a table and a
few statuses. **The value is in the conventions**, and those were learned by
getting them wrong.

---

## 1. What the loop actually is

Justin should never have to email Alex about the app, and Alex should never have
to guess what Justin meant. One page inside the app carries the entire
conversation about the product:

```
Justin files a request in the app
        ↓
Alex refines it into a spec he can build from   (status: new → planned)
        ↓
Alex builds and ships it                        (planned → in_progress → shipped)
        ↓
Justin reviews it IN THE APP
        ├── it's right      → done
        └── it's not        → back to planned, with his own words attached
```

Two side channels hang off that spine:

- **A clarification lane** — when Alex needs an answer before he can build, the
  item goes to `needs_input` with a written question. Justin answers in the app.
  No email thread, no lost context, and the question sits attached to the item
  forever.
- **A brainstorm chat** — a low-stakes AI conversation ("just spitballing")
  where Justin can think out loud about a half-formed idea. When it's cooked,
  it files a draft into the tracker. Half of the best features here started as
  someone muttering a complaint at an AI at 5pm.

**Why it works:** the status field is a shared source of truth. Justin always
knows what's coming; Alex always knows what's waiting on whom. Nothing lives in
anyone's inbox.

---

## 2. The data model (this is the whole thing)

One table. Ours is `feature_requests`; call it whatever fits the golf app.

| Column | Type | Why it exists |
|---|---|---|
| `id` | text PK | |
| `user_id` | text NOT NULL | who filed it |
| `title` | text NOT NULL | short name — the dev may rewrite this to be clearer |
| `description` | text NOT NULL | **the owner's own words, preserved** — see §4 |
| `status` | text NOT NULL | the spine (§3) |
| `priority` | text NOT NULL | `urgent` / `high` / `medium` / `low` |
| `type` | text NOT NULL | bug vs feature vs question — drives nothing critical, helps triage |
| `urgent` | boolean | legacy flag kept alongside `priority`; don't add both in a new build |
| `priority_rank` | integer | manual ordering within a status |
| `dev_notes` | text | **append-only, plain English, written TO the owner** — see §5 |
| `review_note` | text | the owner's words when they send something back |
| `clarification_question` / `clarification_answer` | text | the question lane |
| `approved_by` / `approved_at` | text / timestamptz | who accepted a shipped item |
| `reviewed_by` / `reviewed_at` | text / timestamptz | who sent it back |
| `shipped_at` | timestamptz | set by the dev when it actually deploys |
| `created_at` / `updated_at` | timestamptz | |

That's it. No workflow engine, no state machine library. The discipline lives in
the conventions, not the schema.

**One thing we'd do differently:** we have both `urgent boolean` and
`priority text`. Pick one. Ours is a scar.

---

## 3. Statuses

```
new / sent  →  planned  →  in_progress  →  shipped  →  done
                  ↑                            │
                  └──────── sent back ─────────┘
                         (review_note set)

needs_input        — blocked on an answer from the owner
planned_not_eom    — deliberately held until a safe window (see below)
brainstorm         — drafts filed from the AI chat, not yet real requests
```

- **`new` / `sent`** — raw, as filed. Unrefined.
- **`planned`** — refined into something buildable. **The dev does this
  refinement, not the owner** (§4).
- **`in_progress`** — actively being built. Set it; the owner watching the board
  is the point.
- **`shipped`** — deployed and verified live. **Never set this from "the code is
  written."** Ours means: tests green → pushed → deploy SUCCESS on that commit's
  hash → health check 200. If it isn't live, it isn't shipped.
- **`done`** — the owner accepted it. Only the owner moves this.
- **`planned_not_eom`** — our month-close hold. For a bookkeeping firm, shipping
  risky changes during the 24th–5th window is how you disturb someone's books.
  The golf app will have its own equivalent (tournament weekend? league night?).
  **Ask Justin what his dangerous window is** and honor it.

---

## 4. Refinement: turn a complaint into a spec

Owners file things like *"the timesheet is wrong"* or *"still not working."*
That's not a defect — it's how humans report problems. The dev's job is to turn
it into something testable **without discarding the original words.**

Our convention: keep the owner's text in `description` untouched, and append a
block underneath:

```
[Confirmed rework spec] <what is actually broken, in specific terms>
Repro: <the exact steps>
Fixed when: <the observable outcome that ends the argument>
```

Two things make this work:

1. **The owner's words stay.** When a fix is rejected twice, the original
   phrasing is usually where the misread is hiding. Don't paraphrase over it.
2. **"Fixed when" is written before any code.** If you can't state the
   observable outcome, you don't understand the request yet — go ask.

**We automate half of this**: when an owner marks something "not approved", an
AI turns their one-line complaint into that spec block. It is *not* trusted
blindly; it's a first draft the dev edits. Worth building early — it converts a
grumble into a work item at the moment the grumble happens.

---

## 5. Dev notes: the part everyone underestimates

`dev_notes` is append-only and is **written to the owner, not to yourself**.
This is the single highest-leverage convention in the whole system.

Rules we hold to:

- **Plain English. No jargon, no bare commit hashes, no file paths.** "Fixed in
  a1b2c3d" tells Justin nothing. "Your scores now save the moment you enter
  them" tells him everything.
- **Lead with what they'll see**, not what you changed.
- **Say what was actually wrong**, especially when it wasn't their fault — and
  especially when it *was* the app's fault. Trust compounds.
- **State honest limits in the same note**, not later: "old rounds from before
  today don't have a start time — that was never recorded, so those show a
  dash." Owners forgive limits they're told about and lose confidence over ones
  they discover.
- **Tell them how to verify it**, in their words: "open last week's round, change
  the score, and confirm it sticks after a refresh."
- **When they were right, say so plainly.** "You were right, and it was bigger
  than one button" costs nothing and buys enormous goodwill.

If a note reads like a changelog, rewrite it. It's a message to a person.

---

## 6. The clarification lane

When the dev genuinely can't proceed without a decision:

1. Set `status = needs_input` and write `clarification_question` — **one
   question, phrased so a non-developer can answer it**, with the trade-off
   spelled out. Not "should I use optimistic locking?" but "if two people edit
   the same scorecard at once, should the second person be warned, or should
   their change just win?"
2. The owner answers in the app (`clarification_answer`).
3. The item goes back to `planned` and the answer stays attached forever.

**Do not** use this lane for things you can decide yourself. An owner who gets
five questions a week stops reading them. Ask when the answer changes what you
build; otherwise pick the defensible option, build it, and say what you chose
in the dev notes with an offer to flip it.

---

## 7. The brainstorm chat ("just spitballing")

A separate, low-stakes AI conversation for half-formed ideas. Ours taught us
three things worth copying:

- **Persist the session server-side.** Ours originally lived only in the open
  modal — closing the window destroyed the conversation. It also silently
  dropped everything past 30 messages, so long brainstorms "forgot" their own
  beginning. Persist from the first message; fold older turns into a running
  summary rather than truncating.
- **Feed past brainstorms into new ones** so "like we talked about last time"
  works.
- **Constrain the reply, but set a floor.** We used a JSON schema with no
  minimum length on the reply field, and under grammar-constrained decoding a
  hesitant model answered with a single comma — which then sat in the history
  teaching the next turn to do the same. Set `minLength`. Validate that a reply
  contains actual letters. Retry with a corrective nudge rather than resending
  the identical request.
- **Sanction the ordinary.** The model refused a perfectly normal message about
  an employee missing a deadline. If the assistant is meant to discuss the
  owner's team and operations, say so explicitly in the system prompt, and make
  a genuine can't-help arrive as a sentence rather than as silence.

---

## 8. Notifications

Keep it boring: an in-app bell backed by a `notifications` row, plus optional
email through whatever provider is already wired. Two rules that saved us:

- **In-app is the source of truth; email is best-effort.** Never let an email
  failure break the action that triggered it.
- **Per-user email preferences.** A sparse map of opt-outs keyed by event type,
  where a missing key means "on." Someone will want the app's notifications
  without the inbox traffic, and the first person to ask will be the owner.

---

## 9. Build order for the golf app

1. The table + statuses + a simple list view grouped by status. Nothing else.
2. Filing a request (owner) and refining it (dev).
3. Dev notes rendered on the item, newest last, plain text.
4. The review step: an accept action and a send-back action that captures the
   owner's words into `review_note` and returns it to `planned`.
5. The clarification lane.
6. Notifications.
7. The brainstorm chat, if Justin is the kind of person who thinks out loud.
   (Ask. Some owners aren't.)

Steps 1–4 are the whole product. Everything after is comfort.

---

## 10. The conventions that actually matter

If the other agent takes nothing else from this document:

1. **"Still not working" almost always means the interpretation missed, not the
   code.** Our worst offender took four rounds: three fixes to a "split time"
   complaint before the actual issue — that the field they wanted to edit had no
   input at all — surfaced by reproducing their steps instead of re-reading our
   own diff. **Reproduce the owner's exact steps before writing a line.**
2. **Verify against real data before believing anything** — including your own
   prior fix, and including comments in the code. We shipped a permissions fix
   because a comment claimed an authorization rule that turned out to be false
   for 8 of 11 endpoints.
3. **Never mark something shipped that isn't live.** Match the deployed commit
   hash to the one you pushed; a failed push followed by a health check will
   happily report the *previous* version as healthy.
4. **Own the app's mistakes out loud in the notes.** Several of our best moments
   were telling Brittany "this was our error, here's exactly what happened."
5. **Say what you did NOT do.** Deferred scope, known limits, and judgment calls
   belong in the note, not in your head. An owner who finds an undisclosed gap
   stops trusting the disclosed ones.
6. **One question at a time, and only when it changes the build.**

---

## 11. What to ask Justin before building

- What's his dangerous window (the equivalent of month close)?
- Does he want to think out loud with an AI, or just file requests?
- Who else uses the app, and should they be able to file too? (Ours is
  owner-only for filing; staff report through her. That's a real decision — it
  keeps the board clean but means staff friction reaches the dev late.)
- Email as well as in-app, or in-app only?

---

*Reference implementation: PBJBillingApp — `feature_requests` table,
`src/pages/UpdatesPage.tsx`, the `/api/feature-requests*` routes in `server.js`,
and `lib/assistant.js` for the brainstorm + read-back. Alex can grant access.*
