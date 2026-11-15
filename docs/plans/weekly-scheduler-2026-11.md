# My Week: a weekly planner in place of the Gantt tab

Ticket: featreq-f0e8046b ("Weekly client scheduler (revamping the Gantt tab)"), filed from a spitball session on 2026-11-14. Status of this document: a plan, nothing built. Written 2026-11-15.

## 1. What she asked for, in her words

- "what if we had a scheduler of some type that you could like look at the week and say ok I need to touch these clients ... and then sort clients by day"
- "Lisa would sort her own schedule but like maybe task due that week would populate and she could pick the day she wanted to touch them."
- Touching a client means: "Start work get to questions for me or the client."
- "I do not want to micromanage their days but just help them better structure their time and make sure they are not looking at a client again until it is answered."
- "say she works on Associated on Monday and then she could move it to a sent questions que that we could say revisit end of day"
- "I am trying to make it less overwhelming because everything has the same due date and I am not sure they can prioritize correctly."
- From the ticket: a main list of the person's clients with a short description of what needs doing and a status (Work on this week, In questions stage, Finished for month); she can peek at everyone's from her page with a button; "Maybe revamp the Gantt tab not sure we even use this."

The problem behind it: Lisa starts at the top of her list and works each client to 100 percent, so the clients at the bottom are not touched until the middle or end of the month, and she reopens a client the next morning only to find the questions are still unanswered.

## 2. What the app already has that this should stand on

- **The work itself.** Checklists carry a client, an assignee, a due date and steps; each step can have its own assignee and due date. "My work" for a person is already computed (`checklistsVisibleTo`, the "Assigned to me only" switch).
- **Questions already exist as "Waiting".** A step can be flagged as waiting on a teammate or on the client (`WaitingOn` in `src/lib/types.ts`: who is asked, the note, when it was answered `resolvedAt`, when the asker confirmed `verifiedAt`, questions back and send-backs). The Delayed page and the "Waiting on you" list read it. So "sent questions" and "answered" do not need a new concept: a client is in the questions queue while its open work for that person is waiting, and comes back when a wait is answered.
- **The Gantt tab** (`src/pages/GanttPage.tsx`, 343 lines) draws each person's checklists as bars by due date, with upcoming occurrences faded. Staff see only their own lane. Nothing else depends on it.
- **Start now** (featreq-1e29020b, 2026-11-15) lets a team member start the next checklist of a repeating task early, which is what makes planning ahead of the due date possible at all.

What the app does not have: any record of which DAY a person intends to work on a client, a per-week note, or a "finished for the month" mark that is the person's own call.

## 3. The proposal

A page called **My Week**, in the menu where Gantt is now.

**The left column: my clients this week.** One row per client the person has open work for. Under the client's name, the tasks that are due (title, due date, step, how many steps are done), a one-line note the person types ("bank feed first, then payroll"), and a status:

| Status | How it is set |
|---|---|
| Not planned | the starting state |
| Planned | she puts the client on one or more days |
| In questions | automatically, while every open step of hers for that client is waiting on someone; she can also move it there by hand with a note |
| Answered | automatically, when a wait is answered: the client comes back to the top of today |
| Finished for the month | automatically when her checklists for that client due this month are all complete; she can also set it by hand |

**The week: Monday to Friday, five columns.** She drags a client onto a day, or picks the day from a menu on the row. A client can be on more than one day (two tasks due in the week). Today's column is highlighted. A client that is "In questions" is shown greyed on its day with "waiting on Brittany since Monday" so she does not reopen it.

**The questions queue, at the bottom of today.** "Sent questions: revisit at the end of the day." Each entry says who is being waited on and for how long, and has one button: Open. When the answer is in, the entry moves up to "Answered: pick these up".

**Untouched this week** is a count at the top ("4 clients not started this week"), and those rows sort first, so the bottom of the list stops being the last to be seen.

**The owner's view.** A "Whose week" picker on the same page (owners only): Brittany sees any person's week read-only, plus a one-line summary per person (planned, in questions, not started).

**What it deliberately does not do:** it does not change due dates, does not assign work, does not track hours and does not show times of day. Her words: not micromanaging.

## 4. What has to be stored

One new table, endpoint-owned (never part of the bulk save, like skips and pending edits):

```
week_plan_entries
  id            text primary key
  user_id       text not null          -- whose plan
  week_start    date not null          -- the Monday
  client_id     text not null
  planned_days  date[] not null default '{}'
  note          text
  status_manual text                   -- null, 'questions', 'finished' (what she set by hand)
  status_note   text
  updated_at    timestamptz not null default now()
  unique (user_id, week_start, client_id)
```

Everything else on the page is derived on read from checklists and waits, so it cannot drift from the real work. Both backends (Postgres and the JSON file), as always. **This table needs Alex's yes before it is created.**

## 5. Questions for Brittany (on the ticket)

1. **What fills the list?** "Tasks due that week" would show almost nothing for three weeks and then everything, because most monthly work shares one due date. The default I would build: every client the person has open work for that is due this month or overdue, with this week's due dates marked.
2. **One row per client, or one line per task?** Default: one row per client with its tasks listed under it; the client can be placed on more than one day.
3. **Is the status per client or per task?** Default: per client, per week.
4. **Should "In questions" be automatic?** Default: yes, from the Waiting flags the team already uses, with a manual move as well.
5. **Monday to Friday, or seven days?** Default: Monday to Friday.
6. **Replace Gantt, or keep both?** Default: My Week takes Gantt's place in the menu and Gantt is removed a month later if nobody asks for it.
7. **End of day:** a reminder notification at a set time ("3 answers are in, 2 still waiting"), or is the section on the page enough? Default: the page only, to start.

## 6. Build order (three ships, each usable on its own)

1. **The page and the plan.** Table, endpoints (`GET /api/week-plan?week=&user=`, `PUT /api/week-plan/:clientId`), the list, the five day columns, the note, manual status, "not started" count. Staff see their own week only (server-side check, the same rule as the Gantt lane).
2. **Questions.** The queue driven by waits, the Answered section, greyed days, automatic "Finished for the month".
3. **The owner's peek and the Gantt hand-over.** "Whose week" picker, the per-person summary, the menu change, the capability manifest and the assistant's knowledge.

Rough size: comparable to the Board current-step view plus Skip a step together. Two review rounds per ship; the first ship needs the table approved.

## 7. Risks and things already checked

- **Who can see whose plan.** The plan is a person's own notes about their own week. Staff must not read another person's; the owner may read all. Enforced on the server, never by hiding a control.
- **Shared clients.** Two people work one client (step 1 Lisa, step 2 Allison). Each has their own row and their own status for that client; one person's "finished" does not hide it from the other.
- **A wait on the client vs a wait on Brittany** both count as "In questions"; the row says which.
- **No new idea of "done".** "Finished for the month" set by hand is only a planning mark; it never completes a checklist.
- **Performance.** The list is derived from data the page already has in memory; the only new read is one small table for one person and one week.
