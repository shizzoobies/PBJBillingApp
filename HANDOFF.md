# PB&J Strategic Accounting Cross-Agent Handoff

## Project Identity

- Project name: `PB&J Strategic Accounting`
- Local workspace path: `D:\PBJ Accounting Work\AP For Time Stuff`
- GitHub repo: `https://github.com/shizzoobies/PBJBillingApp.git`
- Current branch in this workspace: `main`
- Current checked-out commit in this workspace: `c1aab9677cebab3614d30fa18cdf9b08c344761e`
- Handoff updated on: `2026-04-30`

## Very Important Current Reality

The GitHub repo is behind the real working state.

This local workspace contains important uncommitted and unpushed changes that do **not** exist yet on GitHub. Any future Codex or Claude Code session must understand this before assuming the repo is current.

That means:

1. If a new agent starts from GitHub alone, it will **not** have the latest backend auth, persistence, checklist extraction, recurring checklist template work, or the new admin reporting UI.
2. Until these local changes are committed and pushed, GitHub is only the last published baseline, not the true current state.
3. Future work should be done with a GitHub-first discipline:
   - pull latest remote state
   - reconcile against this handoff and the local file list below
   - commit intentional changes
   - push to GitHub at the end of each meaningful work session

## Required Workflow For Any Next Agent

Use this exact operating model unless the user says otherwise:

1. Clone or pull the repo from:
   - `https://github.com/shizzoobies/PBJBillingApp.git`
2. Read this file first:
   - `HANDOFF.md`
3. Verify whether the local machine still has the richer workspace at:
   - `D:\PBJ Accounting Work\AP For Time Stuff`
4. If yes, compare GitHub state to the local workspace state before making assumptions.
5. Preserve existing local work. Do not overwrite or revert it casually.
6. After each meaningful milestone:
   - run verification
   - commit
   - push to GitHub
7. Keep GitHub as the shared source of truth going forward so Codex, Claude Code, and any other coding assistant can continue from the same state.

## Current Working Tree Status

At time of handoff, this workspace has these local changes:

- modified:
  - `README.md`
  - `package-lock.json`
  - `package.json`
  - `server.js`
  - `src/App.css`
  - `src/App.tsx`
  - `vite.config.ts`
- untracked:
  - `HANDOFF.md`
  - `db/`
  - `output/`
  - `prototype-data.json`
  - `railway.json`

## What Has Been Built Locally

### App / stack

- React + TypeScript + Vite frontend
- Node server in `server.js`
- backend persistence layer in `db/store.js`
- Postgres-ready schema in `db/schema.sql`
- local file fallback persistence for development

### Auth / sessions

- login is now session-backed
- cookie session name: `pbj_session`
- endpoints exist for:
  - `GET /api/login-options`
  - `GET /api/session`
  - `POST /api/login`
  - `POST /api/logout`
- seeded demo users:
  - Patrice Bell - Owner
  - Avery Johnson - Senior Bookkeeper
  - Jordan Ellis - Bookkeeper
- default demo password:
  - `pbj-demo`
  - can be overridden with `AUTH_DEMO_PASSWORD`

### Persistence / API progress

- `GET /health` exists
- `GET /api/app-data` exists
- `PUT /api/app-data` exists
  - important: this is now effectively owner/admin-only
- dedicated route already extracted:
  - `POST /api/time-entries`
- dedicated checklist route already extracted:
  - `POST /api/checklists/:checklistId/items/:itemId/toggle`

### Checklist system state

The checklist system is no longer just flat ad hoc checklists.

Local work now supports:

- recurring checklist templates in the app data model
- template frequency options:
  - `daily`
  - `weekly`
  - `monthly`
  - `quarterly`
  - `annually`
- owner/admin can:
  - create templates
  - change titles
  - change assigned employee
  - change client
  - change frequency
  - change next due date
  - toggle active/inactive
  - add/remove template items
- employees can:
  - only see assigned live checklist instances
  - only check off items on assigned checklist instances
  - they cannot add/remove template items through the intended flow
- recurring live checklist instances are materialized from templates when app data is loaded

### Reporting state

An owner/admin reporting section now exists in the frontend.

It currently includes:

- month summary
  - tracked hours
  - billable hours
  - internal hours
  - projected billing
  - active client count
  - staff coverage count
- employee reporting
  - tracked hours per person
  - billable/internal split
  - entry count
  - client count
- client reporting
  - tracked hours per client
  - billable/internal split
  - staff count
  - projected billing
- category/work-type breakdown

### Billing / invoices

- invoice draft and billing queue UI still exists
- monthly period selector drives billing context and reports
- subscription and hourly client billing still works in the prototype UI

### Railway / deployment prep

- `railway.json` exists
- Railway doc exists at:
  - `output/doc/Railway Setup Guide - PBJ Strategic Accounting.docx`

## Important Files

- frontend app:
  - `src/App.tsx`
- frontend styles:
  - `src/App.css`
- API/server:
  - `server.js`
- persistence layer:
  - `db/store.js`
- schema:
  - `db/schema.sql`
- seed data:
  - `prototype-data.json`
- deployment config:
  - `railway.json`
- setup notes:
  - `README.md`
- Railway walkthrough docx:
  - `output/doc/Railway Setup Guide - PBJ Strategic Accounting.docx`

## Verification Most Recently Completed

These checks passed locally in this workspace:

- `npm run lint`
- `npm run build`
- owner authenticated app-data load
- employee blocked from owner-only whole-workspace update path with `403`
- assigned employee checklist toggle still works
- recurring templates and generated live checklists load correctly

## What The Next Agent Should Do First

If the goal is to continue development safely across tools, the next agent should:

1. Pull or clone the GitHub repo.
2. Read this handoff.
3. Compare GitHub state against the richer local workspace.
4. Stage and commit the current local changes intentionally.
5. Push them to GitHub so the remote catches up to the real state.
6. Only then continue feature work.

## Suggested Commit Strategy

If the next agent is asked to publish the current local work, a reasonable commit split would be:

1. backend auth + persistence + Railway prep
2. dedicated checklist API extraction + permission hardening
3. recurring checklist template system + admin reporting UI

If the user prefers a single catch-up commit, that is also acceptable, but it should still be pushed immediately after verification.

## Best Next Product Steps

After GitHub is brought up to date, the next best work items are:

1. Extract more owner-only mutations off `PUT /api/app-data`
   - checklist template CRUD endpoints
   - client mutations
   - plan mutations
2. Add export/report actions
   - CSV export for employee/client reports
   - custom date range reporting in addition to monthly reporting
3. Normalize checklist recurrence further
   - stronger instance generation rules
   - maybe background generation later
4. Split `src/App.tsx` into smaller modules/components
5. Verify the app against a real Railway Postgres `DATABASE_URL`
6. Commit and push every meaningful milestone

## Prompt For The Next Agent

```text
Continue the PB&J Strategic Accounting app.

GitHub repo: https://github.com/shizzoobies/PBJBillingApp.git
Primary local workspace used so far: D:\PBJ Accounting Work\AP For Time Stuff

Important:
- The GitHub repo is behind the true local state.
- Read HANDOFF.md before making assumptions.
- Compare local workspace changes against GitHub before proceeding.
- Preserve local work.
- After verification, commit and push so GitHub becomes the shared source of truth for future Codex and Claude Code sessions.

Current local feature state includes:
- session-backed login
- backend persistence layer with file fallback and Postgres-ready schema
- dedicated time-entry API route
- checklist toggle API route
- owner-only recurring checklist template management
- employee-assigned live checklist instances
- owner/admin reporting section

If publishing current work is allowed, first bring GitHub up to date with the local workspace, then continue feature development.
```
