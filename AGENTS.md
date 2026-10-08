# PBJBillingApp — handoff for any coding agent (Codex, Claude, or a person)

This file is the short version. The long one is [`docs/HANDOFF.md`](docs/HANDOFF.md):
read its **section 0** ("Quick start") first on every session — it is rewritten at the end of
each working session and says exactly where things stand, what is in flight and what is held.
`CLAUDE.md` holds the same cardinal rules in Claude's phrasing; this file is tool-neutral.

## 1. What this is, who is who

- The time-tracking / checklist / proposal / invoicing app of **PB&J Strategic Accounting**, live
  at **https://app.pbjsa.com**, deployed by **pushing `main`** to `github.com/shizzoobies/PBJBillingApp`
  (Railway builds the `Dockerfile` and auto-deploys; nothing else deploys).
- **Alex** is the developer and the person you talk to. **Brittany** is the client (the firm's
  owner; app user id `emp-patrice`). Her requests arrive through the in-app **Updates tracker**
  (table `feature_requests`), never by editing code herself.
- **The app moves real money** (Stripe live since 2026-08-18; invoices, card/bank payments, credit
  on account). Sends, voids, payments and anything that writes production data are production
  actions: know the undo before you act, and never write to the production database without
  Alex's explicit yes (one exception below).
- Alex is an owner-role user but is **not the firm**: nothing client-tax-related (the 1099 /
  engagement letters) may ever be emailed to him; reply-to on client mail is Brittany's mailbox.

## 2. Repo map

| Path | What |
|---|---|
| `server.js` | the Node HTTP server: every `/api/*` route, Stripe + Resend webhooks, auth. NOT booted by tests - route glue is pinned by source-reading tests that slice a fixed character window after an anchor (widen the window when a route grows; say so). |
| `db/store.js` | the data layer with **TWO backends**: Postgres (`DATABASE_URL` set - production) and a JSON file (`tmp/app-data.json`, `tmp/auth-state.json` - tests, local dev). **Every persisted change must be made in both.** Tests run the file backend plus recording fakes for the Postgres statements (`db/store-staleness.test.mjs`), so a Postgres-only mistake passes CI silently. |
| `lib/*.js` | pure modules (invoice lines, PDFs, emails, rules). ESM; sibling `.d.ts` where the browser imports them. |
| `src/` | the React + TypeScript SPA (Vite). `src/components/navItems.ts` is the sidebar; `src/lib/api.ts` the fetch layer; `src/lib/types.ts` the shared types. |
| `docs/capability-manifest.md` | the AI assistant's and voice agent's knowledge base. **Must be updated with every user-visible change**; one line per paragraph (no hard wraps); a test fails `verify` above **205,000 bytes** - it usually sits within a few hundred bytes of that, so **trim first** (fact-preserving) before adding. |
| `docs/HANDOFF.md` | the running history and state (section 0 = now; section 5 = newest-first log; section 4 = production diagnostics and rolled-back trials). |
| `docs/plans/*.md` | the design docs for the bigger features (credit on account, billing period, letters, batching...). |
| `scripts/prod/` | production tooling (below). `scripts/provision-voice-agent.mjs` = the voice agent provisioner. |
| `.superpowers/sdd/` | git-ignored scratch: briefs, reports, reviews, the run ledger. Local to a machine; not history. |

## 3. Cardinal rules (the ones that break things)

1. **Two backends.** Any store change touches Postgres AND the file backend, with tests on both.
2. **`npm run verify`** (eslint + `tsc -b && vite build` + vitest) must be green **before every push**,
   and the push must be gated on its exit code - never on grepped output. Run it from the folder
   you built in; **never two vitest runs in one folder at once** (they share `tmp/app-data.json`
   and fail by the hundreds).
3. **Deploy is part of done:** push `main` -> poll `https://app.pbjsa.com/health` until its
   `commit` equals the hash you pushed -> read the boot log. If the manifest changed,
   **re-provision the voice agent** at the released commit (`node scripts/prod/voice-provision.mjs`).
4. **One item per deploy.** Ship pieces one at a time as each finishes - never a batch of unrelated
   changes in one push. Each commit must be green and deployable alone.
5. **Never write to production data without Alex's explicit yes.** Read-only queries are fine.
   Rolled-back trials (`BEGIN ... ROLLBACK`) are fine and are the best way to prove a store
   change against real data - but since 2026-10-01 the whole-workspace save `write()` takes
   EXCLUSIVE locks on 14 tables, so a trial must never call the real `write()` (or a `read()` that
   can trigger the materializer write-back) against production; stub both.
   The ONE standing exception: single-row tracker writes through `scripts/prod/tracker-update.mjs`.
6. **Schema changes** (`alter table`, new tables) ship as look-first `create/alter ... if not exists`
   blocks in `initialize()` and need Alex's yes beforehand. No foreign keys to the bulk-saved tables.
7. **Secrets never appear in chat or commits.** Environment comes from Railway
   (`npx @railway/cli@latest variables --service <PBJBillingApp|Postgres> --json`), read by scripts,
   never pasted. Test credentials only on localhost.
8. **Never merge or delete `hold/july-security-p3`** (sole copy of two files). The desktop app's
   updater key lives outside the repo (`D:\PBJ Accounting Work\desktop-updater-key`).
9. **American English** everywhere (labor, color, labeled).
10. Commit messages: a plain-English title saying what changed for the user, and an attribution
    trailer naming the agent that wrote it (e.g. `Co-Authored-By: <agent name> <noreply@...>`).
    The history holds several agents' trailers; that is fine.

## 4. How work arrives and leaves (the process)

1. **Read state:** `docs/HANDOFF.md` section 0, then the open tracker items:
   `node scripts/prod/tracker-list.mjs` (one line each) and
   `node scripts/prod/tracker-read.mjs featreq-xxxxxxxx` (full text, Brittany's answers, dev notes).
   `planned` = Alex has said go. `needs_input` = waiting on Brittany's answer through the tracker.
   `new` = not yet decided. Her decisions go to HER as a question on the ticket (`--question`),
   not to Alex in chat.
2. **Plan before building** anything non-trivial: a short plan Alex approves ("push" / "go" is
   the signal). For a feature, a doc under `docs/plans/`.
3. **Build in a worktree per lane**, never on `main` in the primary checkout:
   `git worktree add -b <branch> ../AP-laneB main` and link the packages
   (`New-Item -ItemType Junction -Path ..\AP-laneB\node_modules -Target .\node_modules` in
   PowerShell). Remove the LINK (never its target) before `git worktree remove`.
4. **Review before shipping.** Every change gets an independent read-only review (a second agent
   or a second pass) with a per-commit verdict; money or save-path changes get **two** rounds -
   first passes find real defects most of the time. Fix rounds are folded into the commit they
   belong to; each commit stays green alone.
5. **Prove risky store changes on real data** with a rolled-back trial (section 4 of the HANDOFF
   has the shape: one connection, one outer transaction, the store's begin/commit/rollback mapped
   to savepoints, `read()` and `write()` stubbed, everything rolled back, then a read-only check
   that nothing persisted).
6. **Ship:** from the primary checkout on `main`, `npm run verify && bash scripts/prod/ship.sh <hash>`
   (quiet check -> fast-forward -> push -> health poll -> boot log). Then, if the manifest changed,
   `node scripts/prod/voice-provision.mjs`.
7. **Flip the ticket** with a note in Brittany's words:
   `node scripts/prod/tracker-update.mjs featreq-xxxxxxxx --status shipped --dev-notes-file <note.txt>`
   (`--status in_progress` when you start; `--status needs_input --question "..."` to ask her;
   `--file-new --title ... --description-file ...` to file a follow-up). Dev notes are capped at
   4,000 characters and prepend; older notes roll off.
8. **Write the handoff** at the end of a session: section 0 state paragraph + a section 5 entry
   in `docs/HANDOFF.md`, committed and pushed like any change.

## 5. Production access and diagnostics

- Railway CLI must be **linked** in the folder you run it from (`npx @railway/cli@latest link`,
  project PBJBillingApp); the primary checkout is linked, worktrees are not.
- Read-only Postgres: `DATABASE_PUBLIC_URL` from the Postgres service's variables; `pg` is a
  dependency. Example scripts: `scripts/prod/quiet-check.mjs`, `tracker-list.mjs`, `tracker-read.mjs`.
- Logs: `npx @railway/cli@latest logs --service PBJBillingApp`. A whole-workspace save logs
  `[bulk-save] write committed in <N>ms after <K> lock attempt(s)` (expect under a second).
- `/health` returns `{ ok, mode, db, stripe, stripeWebhook, commit }`; 503 means Postgres is
  unreachable, not that the code is broken. The old image keeps serving on a FAILED build; failed
  build logs are only reachable through Railway's GraphQL (HANDOFF).
- Stripe: the webhook endpoint is `app.pbjsa.com/api/stripe/webhook`; events it needs are listed
  in the HANDOFF; the signing secret lives in Railway. Never create test payments against live.
- **`invoices.updated_at` is not an event time** - the bulk save re-stamps every invoice it
  restores. Use `invoice_events`, `email_log` and the review events.
- Local dev: `npm run dev` pair (API on 4173 + Vite); seed users and the owner's TOTP come from
  the git-ignored `tmp/auth-state.json` (HANDOFF "Dev server login"). Stop dev servers before vitest.

## 6. Things that look like bugs but are rules

- Timers start instantly; task, client and detail are required at **Stop & log** (group timers
  included since 2026-10-08). A group holding block is unbillable until it is split.
- A sent invoice that is changed says "Changed since sent" and offers Send again; a void or a
  save that races a payment is refused (409 `invoice_changed`) and the page reloads itself.
- A whole-workspace save that cannot get its table locks answers 503 `workspace_busy`; the tab
  keeps its edits and retries every 4 s. A stale tab's save is refused (409) by the fingerprint.
- Credit on account: prepayment credits are derived from PAID anchor invoices, never stored;
  the send guard holds a later month with reasons `unpaid` (Send anyway offered), `processing`
  and `not_applied` (no override). A refunded or disputed credit is never drawn automatically.
- The server's "today" is the firm's day (US Eastern) for recurring checklists; a few places still
  use the UTC day on purpose (tracker `featreq-52362eac`).

## 7. Where to look when something is "not working" for Brittany

Nine times in ten it is interpretation, not code: reproduce what she is looking at (preview-as
identity, the exact page, the filter state) before changing anything. Her send-backs and the
reasons are logged in `docs/HANDOFF.md` section 5.
