# How the PB&J app's update system works (a handoff for another project)

Written 2026-10-13 for a team building something similar on a DevOps pipeline. This describes
the process, not our code. Where we push to a branch to deploy, substitute your pipeline
trigger and gate on its result; everything else carries over.

## The people and the loop

- The **client** (the firm's owner) uses the app every day and is the only person who decides
  whether a change is right. She never reads code or chat logs.
- The **developer** approves plans and production changes, answers technical questions, and is
  the only one allowed to say "deploy".
- The **AI session** does the building, reviewing, testing and deploying, and keeps the paper
  trail.

Everything flows through one place: the **Updates tracker inside the app**. The client files
requests there in her own words; the status of each item is the protocol between the three
of us. Nothing is "done" until the item is in her review column with a note she can act on.

## The tracker is the work channel

One table, one row per request, with a small set of statuses that mean specific things:

| Status | Meaning |
|---|---|
| `new` | Filed, not yet triaged. The developer decides what gets planned. |
| `planned` | Approved to build. This is the queue. |
| `in_progress` | A session is building it. |
| `needs_input` | A question is waiting on the client, written as a plain-language question on the row. |
| `shipped` | Built and deployed. **This is the client's review queue.** The row carries a note in her words saying what changed and where to find it. |
| `done` | The client (or the developer) accepted it. |
| `wont_do` | Deliberately dropped, with the reason. |

Rules that keep it honest:

- **Her questions go to her on the ticket, not to the developer in chat.** A `needs_input`
  question is written so she can answer in one line. If she answers "I am not sure what you
  are asking", the question was too technical; re-ask it in plainer words with the current
  behavior spelled out and "just say fine" as a valid answer.
- **A send-back is not a bug report.** When she returns an item ("not approved" with a
  reason), the gap is almost always interpretation. Reproduce exactly what she is looking at
  (her account, her screen, her data) before touching code. Three of five send-backs in one
  week were resolved by looking, not coding.
- **Shipped is for her.** Technical follow-up tickets the developer or a session filed go
  straight to `done` when they ship, with the outcome summarized on *her* ticket. Her review
  column should hold only things she asked for.
- **The ticket is the audit trail.** Every ship appends a dated note: what changed, the commit,
  what she should look at, what was deliberately left out. Her answers stay on the row.

## From request to approved plan

1. **Read the request as she wrote it, then read the code.** Before saying anything is missing,
   grep for it. Twice we nearly rebuilt something that had already shipped.
2. **Investigate read-only first.** An architect pass maps what exists, where the request
   touches it, the risks, and the open decisions. Against production data when it matters,
   read-only.
3. **Write a short plan** and get the developer's approval before building anything that
   changes behavior. For a multi-part feature the plan lists stages that each ship alone.
4. **Decisions the developer makes stay made.** Record them where the next session will see
   them, and do not re-ask.

## Building: one item, one lane, one reviewer

- **One item at a time, each on its own branch in its own worktree.** Parallel items get
  parallel worktrees; they never share a working tree, and never share a test run (two test
  runs in one tree corrupt each other's temp data).
- **Tests first.** The failing test is written before the code. Every persisted change touches
  every storage backend the app has (ours has two; a change that passes on the test backend and
  fails on the production one is the classic silent failure).
- **An independent reviewer reads the diff before anything ships.** Not the agent that wrote
  it. The brief names the exact risks to hunt (double-spend, race, wrong default, lost data).
  Money or storage changes get at least two rounds. In our experience every round on money
  code found a real defect the builder had not seen.
- **Fix rounds go back to the builder as a numbered list**, one commit, re-verified, then a
  short re-check by the same reviewer.
- **The knowledge base ships with the feature.** Our in-app assistant reads a capability
  document; every user-visible change updates it in the same commit, and a tripwire test fails
  the build if the document exceeds its size cap. Trim before adding.

## Proving it before it goes live

- **Verify is one command** (lint, type-check, build, full test suite) and **the push is gated
  on its exit code**, never on reading the output by eye. One miss taught us that.
- **Rolled-back production trials for any new SQL or changed insert.** Open a transaction on
  the production database, run the new statements against temp copies of the real tables
  (`create temp table ... like real including all`), compare results to the stored rows both
  directions, read the timings, then `ROLLBACK`. Nothing is written, nothing is locked for more
  than a moment, and the real schema and data shapes are exercised rather than a fake.
- **Never write to production without the developer's explicit yes for that write**, a
  snapshot of the rows first, and the undo recipe recorded next to it.

## Shipping: one deploy per item

1. Commit first, then bring the branch up to date with main (rebase, or merge when rebase is
   refused), then verify again on the result.
2. Ship that one commit range: confirm production is quiet (no live records touched in the
   last few minutes), fast-forward main, push, and **poll the health endpoint until it reports
   the exact commit hash** you pushed. With a pipeline: trigger it with that commit, wait for
   its result, then do the same health poll.
3. Re-provision anything that consumes the knowledge document (our voice agent) **at the
   released commit**, so it never ships a draft.
4. Append the ship note to the ticket in the client's words and flip it to `shipped`.
5. Only then start the next item.

Never batch. A batch of six changes with one bad one costs a day of bisecting; six deploys
cost six health polls.

## Keeping the next session alive

- **A handoff document in the repo** with a "state right now" block at the top: the commit
  that is live, what shipped since last time, what is in flight and where, what waits on whom,
  and the rules that bit this session. The next session reads it first.
- **Persistent memory files** for things the repo cannot tell you: who the people are,
  decisions already made, traps already hit, the pattern that worked.
- **When a session must stop mid-build**, the builder commits a work-in-progress commit with a
  status file saying done / partial / not started / next three steps, so the next session
  resumes from the branch instead of from scratch.
- **Production diagnostics are read-only and cheap.** When something is reported broken, the
  first move is a read-only query against production to see what is actually there. It has
  found more real bugs than any test.

## What to adapt for a pipeline

- Replace "push main, Railway auto-deploys" with "trigger the pipeline for commit X and wait
  for its stage to succeed", keeping the health poll on the exact hash afterward.
- If the pipeline runs the verify step, still run it locally first and gate on it; the
  pipeline is the second gate, not the first.
- Keep the rolled-back production trial as a manual step before the pipeline run; a pipeline
  cannot judge whether a new insert matches the stored rows.
- Keep the tracker statuses and the "shipped is her review queue" rule exactly; that part has
  nothing to do with deployment and is where most of the value is.
