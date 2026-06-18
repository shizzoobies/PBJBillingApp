# PB&J Strategic Accounting — Handoff

_Last updated: 2026-06-18. This supersedes earlier handoffs; git history has the old one._

A time-tracking, checklist, and client-billing web app for a small bookkeeping
firm. This doc is written so a fresh session (or another dev) can resume cold.

---

## Who's who

- **Alex** (asoalexander@gmail.com) — the developer/owner of the codebase. "Push"
  from Alex is the go-signal to deploy. Feature requests from the in-app
  assistant email Alex.
- **Brittany Ferguson** — the firm **owner** (the app's primary user / "the
  client"). Owner role sees everything.
- **Team members / staff** — bookkeepers (e.g. Avery, Jordan). Reduced view:
  their assigned clients only. There is exactly **one owner**.

## Live + deploy

- **Live:** https://pbjbillingapp-production.up.railway.app
- **Host:** Railway, project **"PB&J App"**, service **PBJBillingApp** (+ a
  Postgres service). Auto-deploys `main` on push. Build = `npm run build`,
  start = `npm start`, healthcheck = `/health`.
- **Railway CLI is authenticated in this environment** as asoalexander@gmail.com
  (`npx @railway/cli@latest ...`, project linked). Use it to inspect/fix vars
  and watch deploys:
  - Watch a deploy: `npx @railway/cli@latest deployment list --service PBJBillingApp --json`
  - Audit vars: `... variables --service PBJBillingApp --json`
  - Trigger a deploy: `... redeploy --service PBJBillingApp --yes`
  - **Control-plane calls use the account login, not env keys.**
- **Deploy gotcha (hit 2026-06-10):** a malformed variable — a row literally
  named ` to Railway's Variables ` (a sentence fragment pasted into the name
  field) — caused every build to fail with `secret ID missing for ""
  environment variable`. The fix was deleting that row via CLI. **If builds
  fail with that error, audit variable _names_ for empty/whitespace/garbage**
  (the pretty list view hides them; use `--json` or the Raw Editor). Deleting a
  var does NOT auto-redeploy — trigger one explicitly.

## Env vars (Railway)

Set and required: `DATABASE_URL`, `ANTHROPIC_API_KEY` (assistant — confirmed
set), `RESEND_API_KEY` + `EMAIL_FROM` (email — confirmed set), `APP_PUBLIC_URL`,
`JWT_SECRET`, `OWNER_EMAIL`, `ADMIN_EMAIL`, `OWNER_BOOTSTRAP_PASSWORD`,
`NODE_ENV`. Optional: `FEATURE_REQUEST_EMAIL` (defaults asoalexander@gmail.com),
`ASSISTANT_MODEL` (defaults `claude-opus-4-8`), `ASSISTANT_DIGEST` (set `off`
to disable the weekly digest email), `ASSISTANT_DIGEST_DOW` (0=Sun..6=Sat,
default 1=Mon — the day the digest sends), `ASSISTANT_CAPACITY_TARGET`
(weekly-hours target for the capacity analytics, default 40).

**Voice agent (ElevenLabs) — all set in Railway:** `ELEVENLABS_API_KEY`,
`ELEVENLABS_AGENT_ID` (agent_7701ktt20z3qf06bwytj27bgya62),
`ELEVENLABS_WEBHOOK_SECRET` (HMAC for the post-call webhook — created in the
ElevenLabs dashboard's workspace webhook "pbj-billing post-call"),
`VOICE_TOOL_SECRET` (random; the shared `x-voice-secret` header on every voice
tool webhook). ⚠️ **The `ELEVENLABS_API_KEY` was pasted into chat during
setup — rotate it when convenient** (new key in ElevenLabs → update the
Railway var → revoke the old).

---

## Architecture (the load-bearing facts)

- **Frontend:** React 19 + TypeScript + Vite. **Backend:** plain Node `http`
  server in `server.js` (no framework). **Store:** `db/store.js` is a dual
  backend — **Postgres when `DATABASE_URL` is set, JSON-file fallback
  otherwise** (`tmp/app-data.json`, `tmp/auth-state.json` locally).
- **EVERY data-model change must touch BOTH backends** in `db/store.js`: the
  pg path (migration `alter table ... add column if not exists` / `create table
  if not exists`, SELECT, read-map, INSERT(s), update path) AND the JSON-file
  path. Miss one and prod (pg) or dev (file) silently diverges.
- **Auth:** magic-link (15-min single-use) + password + optional TOTP 2FA.
  Sessions in `user_sessions` (NOT the legacy `sessions` — see security memory).
- **Notifications:** `notify(store, userId, event, payload)` in `lib/notify.js`
  — always writes the in-app bell row; also emails via **Resend** if
  `RESEND_API_KEY`+`EMAIL_FROM` set. Add new event types to `KNOWN_EVENTS` +
  `defaultSubject`.
- **Data scoping for staff:** `scopeAppDataForSession` in server.js strips a
  non-owner down to their assigned clients. **As of 2026-06-10, staff receive
  ALL checklists for assigned clients** (not just ones assigned to them);
  edit/complete rights stay gated to assignee/editor. Per-client access checks
  reuse `visibleClientIdSet(session, clients)`.

## The AI assistant + voice agent (load-bearing facts)

- **Text assistant brain:** Anthropic Messages API in `lib/assistant.js`
  (`runAssistantChat`), streamed as SSE over `POST /api/assistant/chat`.
  Persona = the PERSONA constant in `lib/assistant.js` + the capability
  manifest. Tools: read tools (snapshot, usage patterns, the 4 analytics),
  draft-only tools (`send_feature_request`, `email_report`, `build_report`),
  and propose-only action tools (`make_template_recurring`, `assign_client`,
  `generate_tasks_now`). Drafts/proposals/reports come back on the chat result
  and render as cards/modal; **nothing mutates or sends without the owner's
  click** (e.g. `POST /api/assistant/action` is the only execute path).
- **Voice agent (ElevenLabs Conversational AI):** owner-only, in the assistant
  panel (mic button). `@elevenlabs/react` `useConversation` (wrapped in
  `ConversationProvider` in AppLayout). The browser opens a session via a
  signed URL minted by `GET /api/assistant/voice/signed-url` (key stays
  server-side). That endpoint also returns **dynamic variables**: `owner_name`
  (first name), `today`, `memory_digest`, and `user_id` (the caller).
- **Voice tools are webhooks** ElevenLabs calls at `POST /api/voice/tools/:name`
  (authed by the shared `x-voice-secret` header). Read tools return data;
  write-ish tools (memory, actions, reports, feature requests) PARK a pending
  item — the panel polls it during a call and renders the card/modal; the owner
  still confirms. Persisted memory: `voice_memories`; transcripts via
  `POST /api/voice/post-call` (HMAC-verified) → `voice_transcripts`.
- **`scripts/provision-voice-agent.mjs`** is the source of truth for the
  agent's config. It uploads the manifest to the agent's knowledge base, syncs
  the 12 tools, and PATCHes the agent (system prompt from
  `docs/voice-agent-persona.md`, greeting, knowledge base, tool ids). It
  deliberately leaves the **voice and LLM** as set in the dashboard. Run:
  `ELEVENLABS_API_KEY=… ELEVENLABS_AGENT_ID=… APP_PUBLIC_URL=… VOICE_TOOL_SECRET=… node scripts/provision-voice-agent.mjs`
  (pull `VOICE_TOOL_SECRET` from Railway `variables --json`).
- **ElevenLabs schema gotchas (both cost a 422):** in a tool's
  `request_body_schema`, EVERY node (including nested array/object item
  properties) must set one of `description` / `dynamic_variable` /
  `is_system_provided` / `constant_value` / `is_omitted`; and a property may set
  **only one** of those (a `dynamic_variable` prop must NOT also have a
  `description`). The `caller_id` field on every tool is bound to the `user_id`
  dynamic variable so the webhook parks under the actual signed-in user (the
  firm has >1 owner-role account, so "first owner" routing was wrong).
- **`pending-*` stores** (`lib/pending-actions.js`, `createPendingActionStore`)
  are in-memory, per-user, TTL'd — used for voice-parked actions, reports, and
  feature-request drafts. Ephemeral by design (a restart drops them; she asks
  again).

## Build / verify / deploy process (DO THIS)

1. `npm run verify` = lint + build + test. **Before pushing schema/test
   changes, clear the stale tsbuildinfo cache first** or a clean Railway build
   can fail where local passed:
   ```
   find . -name "*.tsbuildinfo" -not -path "./node_modules/*" -delete
   rm -f node_modules/.tmp/*.tsbuildinfo
   npm run verify
   ```
2. **TS tests must not import plain-JS `lib/*.js`** (no `allowJs`) — it breaks
   the clean build. Test JS libs with `lib/**/*.test.mjs` (already in the vitest
   `include`; runs under vitest, invisible to tsc). TS/TSX tests live in `src/`.
3. Commit on `main`. Push only on Alex's "push". Commit message footer:
   `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
4. After push, watch the deploy (CLI above or poll the bundle hash at the live
   URL), then health-check `/`, `/api/firm-settings/public`, `/health` (expect
   200/200/200).
5. **Voice changes need a re-provision AFTER deploy** — if you touched
   `docs/voice-agent-persona.md`, the voice tool list, or anything the agent
   relies on (new `/api/voice/tools/*` route), run
   `scripts/provision-voice-agent.mjs` (see above) once the deploy is green, so
   the agent's tools point at routes that now exist and its prompt/KB are
   current. Sequencing matters: deploy first (route exists), then provision.

## Local dev quirks (important for verification)

- `npm run dev` runs Vite (5173) + `node server.js` (4173) concurrently. Vite
  proxies `/api` + `/health` → 4173.
- **The Vite dev proxy rewrites Host, so same-origin POSTs guarded by
  `isCrossSiteOrigin` get 403'd through 5173.** Verify POST flows against
  `node server.js` on **4173 directly** (serves `dist` same-origin like prod),
  or add an `Origin: http://localhost:4173` header in curl.
- **Vite's file watcher sometimes serves stale modules** after edits (saw it
  this session). If changes don't appear, stop/restart the preview server.
- **Local login for testing:** forge a session row in `tmp/auth-state.json`
  (`userSessions.push({id: <uuid>, userId, createdAt, lastSeenAt, ...})`) and
  set cookie `pbj_session=<id>`. Owner is Brittany (role owner); staff are
  emp-avery (senior_bookkeeper) / emp-jordan (bookkeeper). Then drive flows with
  curl or Playwright. NOTE: dev-data may be mutated from this session's testing
  (Jordan assigned to Clover, some entries cleared) — it's gitignored scratch,
  reseed from `prototype-data.json` if you want it pristine.
- Don't commit `tmp/*` (gitignored), `package-lock.json` (gitignored on
  purpose), `rescue-login.mjs`, or `.playwright-mcp/`.

---

## What shipped 2026-06-18 — Outage recovery + hardening + bug pass (newest first)

A subscription-plan deletion took the **whole app offline**; the session was
incident recovery, then a full hardening + audit pass. All on `main`, all
**live** (each deploy verified 200/200/200). See memory `plan-refs-outage` and
`audit-backlog` for the durable detail.

- **THE OUTAGE (root cause + fix).** On Wed 2026-06-17 ~7:57 PM ET, Brittany
  (owner; user id `emp-patrice`) deleted subscription plan `plan-9zqirio` while
  invoicing. `clients.plan_id` has an FK (`on delete set null`) but the
  multi-plan **`clients.plan_ids[]` array has NO FK**, so the deleted id
  lingered there. `write()` re-derives the scalar `plan_id` from `planIds[0]`,
  so the orphan violated the FK and aborted the ENTIRE wipe-and-reinsert
  transaction — and since `read()` calls `write()` when recurring checklists
  materialize, **every read 500'd → total offline for all users**. No data was
  lost (rollback); Brittany's ~30 min of unsaved invoicing never persisted
  (acceptable per her). Prod data repaired by clearing the orphan; then three
  fixes: `6b822f3` write() strips dangling plan refs (`sanitizeClientPlanRefs`);
  `dfa0150` `deletePlan` now `array_remove`s the id from `plan_ids[]` (root
  cause — pg path had diverged from the file path); `d8479e4` read()'s
  materialize write-back is wrapped in try/catch (a bad row can never 500 every
  read again).
- **`80708d7` Tier C authz.** Time-entry PATCH/DELETE now enforce client
  visibility for non-owners + re-validate a new `taskId` belongs to the entry's
  client; `previewAs` role mapping is case-insensitive; out-of-scope
  `GET /api/cases/:id` returns 404 (no id enumeration); `limit` clamped on the
  4 list endpoints; voice tools don't fall back to `owners[0]` on missing
  `caller_id`.
- **`b7f3684` Tier B dates.** Every user-facing "today"/"this month" now uses
  the LOCAL day via `localDateOnly()` (Checklists overdue/due-soon + create
  defaults, Dashboard buckets, Active board horizon, Gantt, Productivity,
  Time Approvals month, reimbursement defaults, `currentBillingPeriod`,
  `currentWeekStart`). Was UTC → showed "overdue"/"due today" a day early after
  ~6pm and could misassign a reimbursement to the next month. **Left on UTC**
  (server parity): the client recurring materializer's `today` + `createdAt`
  in `src/lib/utils.ts`, and `dateOffset` (seed/test only).
- **`d8479e4` Tier A hardening.** (1) Empty-payload **wipe guard** on
  `PUT /api/app-data` — refuses a body missing `clients` or one that would drop
  a populated workspace to zero clients (new `clientCount()`). (2) read() write
  -back try/catch backstop. (3) `sanitizeAppData` **de-dupes ids** (a duplicate
  id would abort the bare-INSERT bulk write). (4) `validUserIds` guard drops
  orphan `client_assignments` / `weekly_submissions`.
- **`e05d2eb` Timer local day.** The live timer logged the entry date in UTC;
  now uses `localDateOnly(timer.startedAt)` so it matches the manual form +
  wall clock.
- **`9f8caac` Offline alarm.** Big, sticky, pulsing red bar at the top of the
  workspace when sync is offline/error past the 4s grace — tells Brittany work
  is NOT saving and to contact Alex (`asoalexander@gmail.com`, mailto). Was
  only a small topbar pill before. (`AppLayout.tsx` + `.sync-alarm-bar` CSS.)
- **`2a18cb4` Weekly gate softened.** The timer-stop 423 ("submit last week
  first") now fires ONLY when a prior week was **rejected** by an owner — an
  un-submitted or still-pending prior week no longer blocks logging.
  `findBlockingRejectedWeek` in `lib/time-entry.js`.

**Prod read-only diagnosis tooling (used this session):** the prod Postgres is
reachable from local via the PUBLIC proxy —
`DATABASE_URL=$(railway variables --service Postgres --json | grep DATABASE_PUBLIC_URL)` +
append `?sslmode=no-verify`. The `activity_log` table (cols: id, user_id,
action, target, created_at) is the audit trail and pinpointed the outage
trigger to the second. Railway `logs` only keeps a tiny recent buffer — useless
for historical timing; use `activity_log`.

## What shipped 2026-06-16 — Active Checklists board (newest first)

On `main`, **live** (deploy green, 200/200/200). Built from Brittany's PDF
feedback: show the active checklists as **columns by service type**, with
collapsible client rows, a period toggle, completed clients dropping off, and
an at-a-glance view of who's still open per task.

- **`fb19867` Active Checklists board (`/board`).** New sidebar page **Board**
  (not owner-only — staff see it, scoped to assigned clients). One **column per
  service category** (the columns); each column lists clients with OPEN work of
  that type; a client row expands to the live `ChecklistCard`. Completing a
  client's checklist drops it off automatically. **Period toggle** (week / month
  / quarter, default month) is a *horizon* — shows work due on/before the end of
  the period, so overdue stays visible and the view widens. Owner-only **"Manage
  columns"** (add/rename/reorder/delete; delete → its checklists become
  "Uncategorized"). Where a checklist lands = its **"Board column"** picker on
  the repeating-template editor and the new-task form; generated checklists
  inherit it.
  - **Data model (BOTH backends):** new **`service_categories`** store
    (endpoint-managed like `sales_tax_records` — NOT in the bulk app-data write,
    so autosave can't clobber it; seeded with Monthly/Quarterly Bookkeeping,
    Sales Tax, Payroll) + **`categoryId`** on `checklist_templates` and
    `checklists`, threaded through every pg read/SELECT/INSERT path (the file
    backend rides along since it stores objects verbatim).
  - **Server/API:** `/api/service-categories` GET (any session) + POST/PUT/
    DELETE (owner + CSRF). `categoryId` accepted on one-time checklist create.
    Categories load into `AppContext` via a dedicated fetch (separate from the
    bulk workspace data), with add/rename/reorder/delete mutators.
  - **Pure engine:** `src/lib/activeBoard.ts` (frontend TS — the board is a view
    over data the client already holds; period math is self-contained so it
    doesn't touch the shared `lib/periods.js` validators Client Recap relies on)
    + `src/__tests__/activeBoard.test.ts`. NOTE the frontend convention:
    shared pure logic lives in **`src/lib/*.ts`** (TS), not root `lib/*.js`
    (which is server-only and can't be imported from TS — no `allowJs`).
  - Manifest updated (same-commit rule) **and the voice agent re-provisioned**
    after deploy, so both assistant surfaces know about the Board.

## What shipped 2026-06-16 — voice agent + reports + Client Recap (newest first)

All on `main`, all **live**. The session's arc: the **voice agent** + an
**assistant report generator** + a **Client Recap page**. (Phase 4 Tracks
B/C/D were NOT built — we did this instead; they're still open below.)

- **`145962e` Feature request when a report's data is missing.** If a requested
  report needs data the app doesn't track, the assistant (text + voice) says so
  and offers to `send_feature_request` to Alex (confirm-first). Voice gained the
  `send_feature_request` tool (it had none) via a parked draft →
  `/api/assistant/pending-feature-requests` → panel card.
- **`9483b29` Reports are visual-first.** The assistant doesn't read a report
  aloud (one-line "it's on your screen"), and asks one clarifying question when
  a report request is vague. Persona-only (voice + text).
- **`5ff06a7` Caller-id routing (important fix).** Voice memory/actions/reports
  were parked under "first owner" but the panel polls under the logged-in user;
  with two owner-role accounts (Alex + Brittany) they mismatched → "nothing on
  screen." Now the signed-url passes `user_id`, every tool relays it as
  `caller_id`, and the webhook parks under that caller.
- **`3c94305` (+ `fb49bd8` schema fix) Report generator.** New `build_report`
  tool: the assistant composes any report (sections/stats/tables) from its read
  tools → `AssistantReportModal` with **Save as PDF** (browser print; reuses
  the app's print system — `body.printing-report`). Text returns it on the chat
  result; voice parks it → `/api/assistant/pending-reports` → modal pops.
- **`4f560f0` Client Recap page** (`/client-recap`, NOT owner-only). Per-client
  Monthly/Quarterly review: time, tasks, sales-tax filing status (everyone);
  Billing, Profitability, and recorded sales-tax figures (owner only). Access
  is server-scoped (403 for a client you're not on; financials stripped from
  staff payloads). New `sales_tax_records` store (both backends),
  endpoint-only (NOT in the bulk autosave). `lib/periods.js` +
  `lib/client-recap.js` (pure, tested). Plan: `.omc/plans/client-recap-plan.md`.
- **`b63ac2a` Voice V2 — memory + live tools + transcripts.** `voice_memories`
  (remember/recall + a per-session digest), the analytics as voice webhooks,
  and post-call transcripts (`voice_transcripts`, HMAC-verified webhook).
- **`7694c6b` Voice hang-up fix.** The cleanup effect depended on the
  `useConversation` object (new identity each render) → it hung up the moment a
  call connected. Routed cleanup through a ref.
- **`dfec6a4` Voice actions, propose-only.** Voice can propose the 3 action
  tools; they only ever FILE a confirm card (`pending-actions`) — the owner's
  tap in the panel is the ONLY execute path. "THE RULE THAT NEVER BENDS" added
  to both personas.
- **`8e5826f` Casual + personal.** First-name-only address (enforced
  server-side); occasional family check-in for Brittany (3 daughters, husband
  Mark), gated to when she's the caller.
- **`f54b503` Voice V1.** Talk to the assistant: signed-URL transport, mic
  button + live voice bar (avatar pulse), persona authored
  (`docs/voice-agent-persona.md`), manifest synced to the agent's KB.

## What shipped 2026-06-10 (newest first)

All on `main`, all **live** (verified 200/200/200). Commit → summary:

- **`2358921` Assistant Phase 4 Track A — analytical Q&A.** The assistant now
  answers business questions (owner-only, read-only, pre-aggregated): client
  profitability for a month (revenue, hours, realized rate = fee ÷ hours, and
  true margin where cost rates are set), hours by client/staff, what's overdue
  / due soon, and who's over capacity. New pure engine `lib/firm-analytics.js`
  (4 aggregators) wired in as 4 read tools via a generalized `readTools`
  handler map in `lib/assistant.js`. Added an OPTIONAL per-employee **cost
  rate** (`users.cost_rate`, both backends; `setEmployeeCostRate`; owner-only
  `PUT /api/team/cost-rate`; field in the Team page member detail) — margin
  only, NEVER billed; without it the assistant reports realization only.
  Tests: `lib/firm-analytics.test.mjs`. 238/238. Phase 4 plan +
  Tracks B/C/D in `.omc/plans/ai-assistant-phase4-plan.md`.
- **`facb0b8` Assistant Phase 3 — streaming + persistence + action tools +
  weekly digest.** (1) Chat now streams as SSE over the POST body
  (`runModel` seam in `lib/assistant.js`; client parses delta/done/error;
  pre-stream auth/CSRF/rate errors still JSON). (2) Conversation persisted:
  `assistant_messages` (both backends, 200-turn cap) + GET/DELETE
  `/api/assistant/history`; panel loads on open, trash icon clears. (3) Action
  tools — the assistant DOES things, confirm-gated: `make_template_recurring`,
  `assign_client`, `generate_tasks_now`. The model only PROPOSES (speaks
  names); `POST /api/assistant/action` (owner + CSRF + server-side allowlist)
  resolves names→ids and mutates only after the owner clicks "Run it". (4)
  Deterministic Monday digest email (top automation opportunities, deduped per
  ISO week via `assistant_digest_state`, no-op without Resend; `ASSISTANT_DIGEST`
  /`ASSISTANT_DIGEST_DOW`). 232/232 tests (new `lib/assistant.test.mjs`).
- **`b5c10ab` Team visibility — DEPLOYED GREEN.** A bookkeeper assigned to a
  client now sees + can log time against ALL that client's tasks (was: only
  their own), fixing "can't save a future get-ahead task." Widened 3 assignee
  gates (server scoping, server time-entry `allowedToLog`, client
  `eligibleChecklistsFor` → moved to `lib/utils.ts`, unit-tested). Edit/complete
  still assignee-only; queue + summary counts stay "mine". Verified: staff
  logged against a teammate's task → 201 (was 403). 223/223 tests.
- **`23a99e1` Assistant Phase 2 — watch-and-learn.** `lib/usage-patterns.js`
  (deterministic, no model call) detects (a) tasks created by hand 2+ months
  w/o a template, (b) same manual time entry 3+×/90d, (c) stalled active
  templates. `GET /api/assistant/insights` (top-3, minus dismissed) +
  `POST .../insights/dismiss` (persisted per-user). Panel shows "Noticed
  something" cards; chat got a `get_usage_patterns` tool.
- **`7f20fa4` Assistant Phase 1 — chat + feature requests.** Owner-only
  floating sparkle button → chat grounded in `docs/capability-manifest.md`;
  `send_feature_request` tool DRAFTS only, owner confirms, emails Alex via
  Resend + logs it. `lib/assistant.js`, `POST /api/assistant/chat` (owner-only,
  20/5min rate limit, friendly 503 if no key).
- **`da91bc9` dev file-store race fix.** Serialized JSON read/write in the file
  backend (per-path promise queue) — fixed local "Unexpected end of JSON input"
  500s. Postgres (prod) never hit it.
- **`464d237` / `ff85e1d` / `43fd522` Visual polish batches 1–3.** Sidebar
  contrast guard (auto-legible nav text vs any brand color, unit-tested),
  styled native selects/date inputs, dead-space fix, offline-banner grace,
  softer stat cards; quiet checklist row controls + heatmap/Gantt legibility +
  hover states; compact sticky header + mobile drawer nav + "…" overflow menu
  on task cards.
- **`3084885` / `97d0721` Waiting-on notifications.** A checklist step can name
  the specific task it's waiting on (`waitingForChecklistId` on item +
  sub-item); when that task completes, the blocked step's assignee gets an
  in-app + email `waiting_cleared` notification.
- **`a062431` Get-ahead generate fix** (earlier): the
  `POST /api/checklist-templates/:id/generate` endpoint was owner-only; now
  staff can generate for assigned clients.

## The AI assistant — STANDING RULE

**`docs/capability-manifest.md` is the assistant's only source of truth. ANY
commit that adds/changes/removes a user-facing feature MUST update the manifest
in the SAME commit** — otherwise the assistant lies to Brittany. (Also recorded
in memory `ai-assistant.md`.) Owner-only, forever. Tests in
`src/__tests__/assistant.test.tsx` assert manifest coverage + panel behavior.
The manifest is ALSO the voice agent's knowledge base — so a manifest change
isn't fully live for voice until the agent is re-provisioned (step 5 above).
Behavior rules for both surfaces live in two personas: `lib/assistant.js`
PERSONA (text) and `docs/voice-agent-persona.md` (voice) — keep them in sync.

---

## Collaboration workflow

- **Plan first, get approval, then build; "push" = deploy.** Use AskUserQuestion
  for genuine product/permission decisions. Build + verify locally, present a
  summary, wait for "push" before deploying.
- **Hard constraints:** never commit `package-lock.json`; `rescue-login.mjs`
  stays gitignored; estimated-hours fields are informational only (never affect
  invoices); never `push --force` to main; never skip hooks/signing.

## Backlog / next ideas

- **Assistant Phase 3 — SHIPPED (`facb0b8`).** Streaming, persistence, action
  tools, weekly digest.
- **Assistant Phase 4 — Track A shipped (`2358921`); B/C/D still NOT built.**
  Approved + spec'd in `.omc/plans/ai-assistant-phase4-plan.md`:
  - **Track B (actions)** — 5 confirm-gated tools: `reassign_task`,
    `set_task_due_date`, `create_contact`, `create_client`, `draft_invoice`
    (draft only). Decided: ship all 5; hold complete/delete/approve for later.
    NOTE: the existing 3 action tools already use the propose→card→tap pattern
    (`buildActionProposal`/`executeAssistantAction` in `lib/assistant.js` +
    `pending-actions`); new ones follow it + a voice tool in the provision
    script.
  - **Track C (briefing)** — daily morning-briefing card + new insight types,
    composing Track A's aggregators.
  - **Track D (staff)** — read-only, own-clients-only assistant for
    bookkeepers (no actions, no feature requests); reuse
    `scopeAppDataForSession`; needs a focused data-scoping security pass.
- **LIKELY RESOLVED — "can't save time" (the bookkeeper timer report).**
  2026-06-18 root-caused two contributing bugs, both now fixed + live: (1) the
  weekly-submission gate 423'd on timer-stop whenever a prior week wasn't
  pending/approved — softened so only a **rejected** week blocks (`2a18cb4`);
  (2) the timer dated entries in **UTC**, landing evening work on the wrong
  day/week (`e05d2eb`). Confirm with the affected bookkeeper that start/stop now
  works. (The older, separate "can't see future-dated tasks" DISPLAY question —
  Recent list cap / week-scoped Timesheet / collapsed "Later" bucket — was never
  pinned; revisit only if she re-reports it.)
- **OPEN — audit backlog (memory `audit-backlog`).** The 2026-06-18 audit's
  leftover LOW/MED items, deliberately deferred: M3 CSRF uniformity (its own
  task — SameSite=Lax already mitigates; dev-proxy 403 caveat), M2/L2
  content-type 415 guards + firm-settings field whitelist, L3 checklist-item
  visibility, store-7 file-backend sanitize parity (dev-only), store-8 cleanup
  counts. Tier A/B/C high-value items already shipped (see 2026-06-18 section).
- **OPEN — verify the voice report modal end-to-end with Brittany** now that
  caller-id routing is fixed (`5ff06a7`). If it still doesn't pop, pull the
  ElevenLabs conversation log (CLI with the API key) to see the tool call.
- **Side observation (unconfirmed):** generating a get-ahead task once appeared
  to create a duplicate instance for the same due date — possible glitch in the
  generate + materializer dedup. Not chased; verify before relying on it.
- **Rotate `ELEVENLABS_API_KEY`** — it passed through chat during setup.
- **More watch-and-learn patterns** (e.g. "you reassign this to X every month —
  change the default assignee?").
- **Security backlog** (from memory `security-notes.md`): deferred Batches 4–7
  + H3 — review before any auth/session work.
- **Optional polish:** P3 from the visual review (skeleton loaders, save
  toasts, per-route page titles, favicon, login-page CTA).

## Memory pointers

Auto-memory lives at `~/.claude/projects/.../memory/` — see `MEMORY.md` index:
`project-overview`, `railway-deploy`, `collaboration-workflow`,
`due-date-mechanics`, `security-notes`, `ai-assistant`, `plan-refs-outage`
(the 2026-06-17 outage: cause + fixes + prod read-only diagnosis tooling),
`audit-backlog` (deferred low-priority audit items).
