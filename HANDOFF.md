# PB&J Strategic Accounting — Cross-Agent Handoff

_Last updated: 2026-06-05_

## ⭐ ACTIVE TASK — 6-item client feedback batch (ALL SHIPPED ✅)

The full 6-item feedback batch from Brittany is **complete and pushed**. Awaiting her live testing / further feedback.

| # | Item | Status |
|---|------|--------|
| 1 | **Annual billing method** — flat yearly fee, billed once in a chosen month | ✅ Pushed (`db078f8`) |
| 2 | Organize repeating tasks → group by client (collapsible headers) | ✅ Live |
| 3 | Lock bug (locks affected all clients) → now scoped per-client | ✅ Live |
| 4 | Edit checklists under clients (full editor on client page) | ✅ Live |
| 5 | "Waiting on" note per checklist item (amber badge) | ✅ Live |
| 6 | **Group time billing** — pick Group → multiple clients, flexible split | ✅ Pushed (`d27262a`) |

Last commit: `d27262a`. **186 tests** green. Annual billing went live as `index-XMkNv5UW.js`; group-time deploy was pushed right after (watch the live bundle hash to confirm it landed). Both shipped DB migrations (annual_rate/annual_billing_month + billing_mode CHECK swap; time_entries.group_id).

### #6 as built (group time)
- `TimeEntry.groupId` ties the per-client entries from one group submission together.
- `allocateGroupMinutes(total, ids, mode, custom)` in utils.ts is the pure allocator (even / full / custom). Unit-tested.
- Owner-only "Bill to: A group" in the **manual** time modal → multi-client picker + allocation mode + live preview. Each client gets its own independent, separately-approved entry; a "Group" tag shows on recent entries.
- `logGroupTime()` in App.tsx loops the validated `createTimeEntry` endpoint (one entry per client) then does a single state update.
- Group entries carry no startAt/endAt/sessions (so the server preserves the allocated `minutes` instead of recomputing from the session envelope) and no taskId (a task belongs to one client).

### #1 Annual billing — spec & plan
Confirmed semantics: **"Flat yearly fee, billed once."** A flat yearly fee that appears on the invoice **once per year**, in a **chosen billing month**. Every other month shows **no** subscription charge.
Current model: `billingMode` is `'hourly' | 'subscription'` with `monthlyRate` + `monthlyServiceTier`. Add a third mode.
1. **Type** (`src/lib/types.ts`): add `'annual'` to `billingMode`; add `annualRate?: number` (yearly fee) + `annualBillingMonth?: number` (1–12).
2. **Store** (`db/store.js`): `alter table clients add column if not exists annual_rate ...` + `annual_billing_month ...`; update BOTH client INSERT paths (⚠️ 31-col alignment), SELECT list, read mapping. Verify `sanitizeAppData` keeps them.
3. **Invoice** (`src/lib/utils.ts`, `getInvoice`): when `billingMode === 'annual'`, emit the annual fee line **only** when the period's month === `annualBillingMonth`; otherwise no subscription line. Hourly/time lines unaffected.
4. **UI:** `BillingSectionBody` in `src/pages/ClientDetailPage.tsx` — add "Annual" option + `annualRate` + `annualBillingMonth` (month picker), using SectionKit save controls. Show annual line in invoice display.

### #6 Group time billing — spec & plan (biggest item)
Confirmed semantics: when logging time, pick **"Group"** → select **multiple clients** → choose a **per-entry allocation**: **split evenly / full duration to each / custom split** ("option for each full flexibility" = expose all three).
1. **Model** (`src/lib/types.ts`): **recommended** — materialize one child `TimeEntry` per client at save time, each tagged with a shared `groupId` (so they can be edited/deleted together) + the chosen allocation. Materializing keeps `getInvoice` simple (each client's invoice just sums its own entries) and avoids double-count risk.
2. **Store** (`db/store.js`): persist chosen shape in both backends (migration if new column/table).
3. **UI:** time-entry form — add "Group" target, multi-client picker, allocation-mode selector; for "custom", per-client hours/percent that must sum to the total duration.
4. **Invoice** (`src/lib/utils.ts`): each client gets only its allocated share; never double-count; estimated-hours rule still holds.
5. **⚠️ CONFIRM WITH USER BEFORE BUILDING:** does Brittany need to edit/delete the group entry **as one unit** later, or is recording the split once enough? Decides materialize-vs-keep-as-group (default rec: materialize + `groupId`).

**Suggested order:** #1 annual billing first (smaller, self-contained), then #6 group time (confirm the edit-as-group question first). User's stated default was annual billing first.

---

## Project identity

- App: **PB&J Strategic Accounting** — a bookkeeping/time-tracking/billing SaaS for an accounting firm.
- Local workspace: `D:\PBJ Accounting Work\AP For Time Stuff`
- GitHub repo: `https://github.com/shizzoobies/PBJBillingApp.git` (branch `main`)
- Live app (Railway, auto-deploys on push to `main`): `https://pbjbillingapp-production.up.railway.app`
- People: **Alex Anderson** (`asoalexander@gmail.com`) is the developer + an Owner. **Brittany Ferguson** (`emp-patrice`) is the firm owner/client the work is for. "push" / "go ahead" is the go signal to ship.

## Current reality (IMPORTANT — differs from the old handoff)

**GitHub `main` is the single source of truth and is fully current.** Every change is committed and pushed immediately, and Railway auto-deploys `main`. The old "GitHub is behind local" note is obsolete — ignore it. Start from the repo; the local workspace and remote are in sync.

## Workflow (follow this exactly)

1. Make the change.
2. **Verify:** `npm run verify` (= `eslint .` + `tsc -b && vite build` + `vitest run`). Tests must stay green (currently **172 tests**).
3. Commit with a descriptive multi-line message ending with the `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>` trailer. One feature per commit.
4. Push to `main` → Railway auto-deploys.
5. **Confirm the deploy** by diffing the bundle hash:
   `curl -s https://pbjbillingapp-production.up.railway.app/ | grep -o 'index-[A-Za-z0-9_-]*\.js'`
   Poll until the hash **changes** from the previous one. **Gotcha:** Railway often briefly serves an *intermediate* build — after the hash changes, `sleep 20` and re-check that it's the **same** (stable) hash before trusting it. Then optionally `curl` the `/assets/<hash>.js|.css` and `grep` for a string unique to your change to confirm it's really live.
6. Tell the user what to test, and remind them to hard-refresh (Ctrl+Shift+R) since Railway may serve the prior build for ~a minute.

### Hard constraints
- **Never commit `package-lock.json`** (gitignored on purpose; committing it breaks Railway `npm ci`). Never run `npm install` casually.
- `rescue-login.mjs` stays gitignored.
- Estimated-hours fields are **informational only** — must NEVER affect invoice totals.
- Don't push `--force` to main; don't skip hooks.

## Stack & architecture

- **Frontend:** React 19 + TypeScript + Vite. Entry `src/App.tsx` (large — holds the context provider + all the mutation handlers). Pages in `src/pages/`. Shared UI in `src/components/`. Styles all in `src/App.css` (one big file). Types in `src/lib/types.ts`. Pure logic in `src/lib/utils.ts`. API client in `src/lib/api.ts`.
- **Server:** `server.js` (plain Node http server, route-matched by path/method).
- **Persistence:** `db/store.js` — **dual backend**: Postgres (when `DATABASE_URL` is set, i.e. on Railway) AND a local JSON file fallback for dev. **Any data-model change must update BOTH paths.** Schema lives in the migration blocks inside `store.js` (`create table if not exists` + `alter table ... add column if not exists` — idempotent, run on every boot) and `db/schema.sql`.
- **Auth:** email magic-link + password + optional TOTP 2FA. Sessions cookie `pbj_session`. Gotcha: there's a `user_sessions` table (current) vs a legacy `sessions` table — use `user_sessions`.

### Data flow (critical mental model)
- `GET /api/app-data` returns the whole workspace, **scoped per session** (`scopeAppDataForSession` in `server.js`): owners get everything; non-owners get only their assigned clients/checklists/own time entries, with billing rates stripped.
- **Most workspace edits (clients, plans, contacts, templates) persist via a bulk autosave**: the frontend mutates local `data` via `updateWorkspaceData`, which debounces (~250ms) and `PUT`s the entire `data` to `/api/app-data` (`saveAppData`). There is **no per-field endpoint** for these — the bulk save is the only persistence path. `forceNextSaveRef` guarantees workspace edits aren't skipped.
- **Some operations use dedicated endpoints** (and `applyServerDataUpdate`, which increments a skip-counter so the echo doesn't re-save): time entries (`POST /api/time-entries`), checklist item toggles, reimbursements CRUD, checklist-template create/apply/duplicate, assigned-team, firm settings (`PUT /api/firm-settings`).
- **Bulk write is wipe-and-rewrite inside one transaction** (`store.write`): it deletes and re-inserts every table from the payload. It's **all-or-nothing** — one bad row throws and the whole save 500s (frontend shows "Couldn't save"). `filterBulkSaveOrphans` pre-drops rows whose `clientId`/`templateId` FK no longer exists (note: empty/`''` clientId is falsy → skipped → kept, which is how administrative time entries survive).

### Gotchas that have bitten us (read before touching data)
- **Adding a `Client` field** requires, in lockstep: (1) `Client` type in `types.ts`; (2) the clients **bulk INSERT** in `store.js` (column list + `$N` placeholder + value array must stay aligned — currently **31 columns**); (3) the clients **read mapping**; (4) an `alter table clients add column if not exists ...` migration. Miss any and the field silently doesn't persist while the save still returns 200 (the "green save, gone after refresh" bug class).
- **Normalizers silently drop new fields.** `ensureTemplateStages`, `normalizeSubItems`/`normalizeSubSubItems` (store), and `sanitizeAppData` rebuild objects — if you add a field to a checklist node/template and don't carry it through these, it vanishes on save. (This caused the "subtask due dates reset" and "day-of-month wouldn't engage" bugs.)
- **`sanitizeAppData`** (store) clamps numbers / drops bad dates before write; it keeps unknown fields (spreads), so plain new fields pass through, but it does coerce known numeric fields.
- **Frontend input reliability:** use the shared `SectionKit` controls. Plain blur-only inputs lose data if you type then refresh/navigate without clicking away. The shared `SavingTextInput`/`SavingNumberInput`/`SavingTextarea` commit on **debounce (700ms) + Enter + blur**, and resync to the canonical value when idle. They use a **focus `useState`, NOT a ref** — the `react-hooks/refs` lint rule forbids reading `.current` during render, and `react-hooks/set-state-in-effect` forbids sync setState in effects (mirror sync state into a ref inside a `useEffect` instead).
- `SaveNumberField` passes `null` through on clear (don't swallow it) so clearing a number actually persists.
- Locked sections use the `inert` attribute on the body (React 19 supports it) so the whole subtree is non-interactive without threading `disabled` everywhere.

## What's built (current feature set)

- **Auth & team:** magic-link/password login + 2FA, owner-managed team (invite, roles, sessions, soft-delete inactive members).
- **Clients:** profile, contacts (multi-select from a shared Contacts directory), address, billing (hourly **or** monthly), per-role estimated hours (Bookkeeper/Accountant/CFO, informational), plans/services chips, invoice settings (payment terms, footer, toggles), logo. **Monthly service package** dropdown (7 named tiers in `MONTHLY_SERVICE_TIERS`) drives the invoice line label when on monthly billing.
- **Checklists:** one-time + recurring templates → materialized live instances ("cases" for multi-stage). Per-node due dates (specific date or day-of-month) at item/sub-item/sub-sub-item level. Recycle bin. Standard (client-agnostic) blueprint templates + "apply to client".
- **Time tracking:** live timer + gated manual entry, approval workflow (pending → approved/rejected), weekly submissions, month-end timesheet locks. **Administrative time** (company meetings/internal): a checkbox on both timer and manual forms — no client/task, not billable, notes required (`TimeEntry.isAdministrative`, nullable `client_id` + `is_administrative` column).
- **Invoices / billing:** monthly period selector; subscription + hourly; one-off + recurring reimbursements (auto-populated on matching periods); reimbursements have inline edit.
- **Reports / productivity / gantt / dashboard:** owner analytics.
- **Settings (owner):** firm branding (name, tagline, logo, sidebar colors), address/contact/business identifiers, **"Default values for new clients"** (`FirmSettings.clientDefaults` → `client_defaults` JSON column) that pre-fill the Add-client form, plus 2FA + password management.
- **Contacts:** shared directory with CSV import (dedupe/merge), inline-editable fields incl. notes.

## Recent work (this batch of sessions) — what a fresh context won't know

- **6-item feedback batch, items #2–#5 shipped** (commit `ea5c5f5`; see ⭐ ACTIVE TASK above for the 2 remaining):
  - **#3 lock-scoping:** moved `SectionScopeContext` into its own file `src/components/sectionScope.ts` (fast-refresh lint). `CollapsibleSection` reads it and keys localStorage as `pbj.section.<scope><storageKey|title>`. `ClientDetailPage` wraps its tree in `<SectionScopeContext.Provider value={\`client:${client.id}:\`}>` so locks/collapse are per-client.
  - **#4 edit checklists under clients:** `ChecklistCard` (+ `NewTaskForm`) now `export`ed from `ChecklistsPage.tsx`; `ClientDetailPage`'s `ActiveChecklistsBody` renders a real `<ChecklistCard>` per active checklist (pulls ~16 handlers from `useAppContext`, `focused={false} focusRef={null}`).
  - **#5 "waiting on":** new `waiting_on text` column on `checklist_items` (full dual-backend pattern: type `ChecklistItem.waitingOn?`, migration, both INSERTs `$9`/sub_items→`$10::jsonb`, SELECT, read map, `updateChecklistItem` update path, `server.js` PATCH handler). UI: amber `.task-row-waiting` badge + `.item-waiting-input` in `DraggableTaskList`; `updateChecklistItem` patch type widened to include `waitingOn?: string | null` across `api.ts`/`AppContext.tsx`/`App.tsx`.
  - **#2 group repeating tasks by client:** `RepeatingTasksManager` now groups templates into collapsible per-client sections (`collapsedClients` Set, `clientGroups` Map, `.repeating-client-group/-header/-count/-body`, focus auto-expands the focused client).

- **Shared UI kit:** `src/components/SectionKit.tsx` + `src/lib/useSaveFlash.ts`. Exports `CollapsibleSection` (collapse + optional lock, **unlocked by default**, state persisted to `localStorage` keyed by section title — `pbj.section.<title>.{locked,collapsed}`), `SaveBadge`, `SavingTextInput/SavingNumberInput/SavingTextarea`, and field wrappers (`SaveTextField`, `SaveNumberField`, `SaveSelectField`, `SaveTextareaField`, `SaveToggleField`).
- **Save confidence:** per-field "Saving… / Saved ✓ / Couldn't save" badges (tied to `dataSyncState`), plus an always-on header sync banner ("All changes saved / Saving… / Couldn't save — retrying / Offline") in `AppLayout` (`syncMessage` computed in `App.tsx`).
- Applied collapse/lock + reliable inputs to **Client detail, Contacts, Plans, Settings (firm fields), Team**. (Time + Checklists pages were intentionally left — they're explicit-submit / already commit-on-change; Checklists already has its own collapse.)
- **Premium UI pass v1** (global, CSS-only in `App.css`): elevation tokens (`--shadow-sm/md/lg/hover`, `--radius`, `--ease`), softer floating panels, gradient primary buttons with hover/press lift, restyled tables (rounded container, tinted uppercase header, row hover, tabular figures), refined inputs/focus rings, summary **stat cards** with tinted icon badge, hover lifts on list rows.
- **Sidebar:** now sticky (`align-self:start; height:100vh; position:sticky; top:0; overflow-y:auto`) + elevated (right-edge shadow, z-index) — follows scroll instead of being flat.
- **Time approvals:** owners are now included in the queue, so an owner can see + approve their **own** logged time (server already allowed it; the UI was filtering owners out).
- Recurring-checklists card on the client page (search + "View" deep-link via `?focusTemplate=<id>` which auto-expands/scrolls the template on the Checklists page).
- Number-input spinners hidden globally.

## Known backlog / parked

- **Security backlog is parked** until the user says "pick up the security backlog" (after EOM). Items live in the user's memory file `security-notes.md`: deferred H3, Batch 6 (H5/M1), Batch 7 (M7/L4). Shipped: Batches 1–5 + the Origin same-origin fix.
- **Premium UI next layers** (discussed, not done): dashboard "hero", invoice-as-premium-document (letterhead/emphasized totals), empty states (icon + prompt), loading skeletons. Intensity chosen: "noticeably elevated."
- Possible future: extract more owner-only mutations off the bulk `PUT /api/app-data`; split `App.tsx`; CSV/date-range report exports.

## Important files

- `src/App.tsx` — context provider + all mutation handlers (timer, logTime, updateClient, template/checklist CRUD, autosave effect, sync state).
- `src/App.css` — all styles + the design tokens (`:root`).
- `src/components/SectionKit.tsx`, `src/lib/useSaveFlash.ts` — the shared save/lock/collapse kit.
- `src/components/AppLayout.tsx` — shell, sidebar, header sync banner.
- `src/lib/types.ts` — all types + `DEFAULT_FIRM_SETTINGS`, `MONTHLY_SERVICE_TIERS`.
- `src/lib/utils.ts` — `getInvoice`, materializer (`materializeRecurringChecklists`, `ensureTemplateStages`, due-date resolvers), status helpers.
- `server.js` — all API routes + `scopeAppDataForSession`.
- `db/store.js` — dual-backend persistence, schema migrations, bulk write/read.
- `src/pages/` — `ClientDetailPage`, `ClientsPage`, `TimePage`, `TimeApprovalsPage`, `ContactsPage`, `PlansPage`, `SettingsPage`, `ChecklistsPage`, `CaseDetailPage`, etc.

## Prompt for the next agent

```text
Continue the PB&J Strategic Accounting app.

GitHub repo (source of truth, auto-deploys to Railway): https://github.com/shizzoobies/PBJBillingApp.git
Local workspace: D:\PBJ Accounting Work\AP For Time Stuff
Live: https://pbjbillingapp-production.up.railway.app

Read HANDOFF.md fully first — especially "Workflow", "Data flow", and "Gotchas".

Two billing features remain in the active batch: #1 annual billing and #6 group time (see "⭐ ACTIVE TASK" at the top of HANDOFF.md for full specs). Start with #1; confirm the edit-as-group question before building #6.

Workflow: make change → `npm run verify` (must stay green, 172 tests) → commit (descriptive, Co-Authored-By trailer) → push main → confirm Railway deploy via bundle-hash diff (watch for intermediate builds; wait for a stable hash). Never commit package-lock.json.

When changing the data model, update BOTH the Postgres and file-fallback paths in db/store.js (type + INSERT alignment + read mapping + add-column migration), and make sure normalizers (ensureTemplateStages / normalizeSubItems / sanitizeAppData) preserve the new field.

For editable UI, reuse src/components/SectionKit.tsx controls so fields save reliably (debounce+Enter+blur) and show save badges.
```
