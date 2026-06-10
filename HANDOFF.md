# PB&J Strategic Accounting — Handoff

_Last updated: 2026-06-10. This supersedes earlier handoffs; git history has the old one._

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
default 1=Mon — the day the digest sends).

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
  edit/complete rights stay gated to assignee/editor.

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

## What shipped 2026-06-10 (newest first)

All on `main`, all **live** (verified 200/200/200). Commit → summary:

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
  tools, weekly digest all built. Possible Phase 4: more action tools (the
  set is just 3 — see `ACTION_TOOLS` in `lib/assistant.js`; each needs a store
  method + manifest line + a line in the server allowlist), action undo, and
  conversation search.
- **More watch-and-learn patterns** (e.g. "you reassign this to X every month —
  change the default assignee?").
- **Security backlog** (from memory `security-notes.md`): deferred Batches 4–7
  + H3 — review before any auth/session work.
- **Optional polish:** P3 from the visual review (skeleton loaders, save
  toasts, per-route page titles, favicon, login-page CTA).

## Memory pointers

Auto-memory lives at `~/.claude/projects/.../memory/` — see `MEMORY.md` index:
`project-overview`, `railway-deploy`, `collaboration-workflow`,
`due-date-mechanics`, `security-notes`, `ai-assistant`.
