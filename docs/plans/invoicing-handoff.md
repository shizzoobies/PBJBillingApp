# Invoicing build — pickup handoff

Written 2026-08-05 for a fresh Claude session (or human) starting the in-app
invoicing build with no context from prior sessions. Read this, then the two
plan docs, then `docs/HANDOFF.md` for house rules. Everything here is
committed; nothing depends on any machine-local memory.

## Status: ON HOLD — wait for Alex's explicit go

Alex paused this before build start (2026-08-05) to give it full attention
later. **Do not start any phase until he says go in a live session.** When he
does, confirm whether the P1 sidebar regroup (Track A of
`billing-and-engagements-2026-08.md`) already happened — it was scheduled
for the week of Aug 6 and I1 was sequenced after it.

## What this is

Move Brittany's entire monthly invoicing routine into the app: generate a
draft invoice per client per month → she reviews/edits each → one click
emails it from `billing@pbjsa.com` with a Stripe pay link → the app tracks
sent / processing / paid / overdue. QuickBooks Online stays her ledger; a
**Download-for-QBO** CSV lets her bulk-import the month's invoices there.
Plan of record: **`docs/plans/invoicing-in-app-2026-08.md`** (read it fully —
phases I1–I5, data model, decisions). Parent roadmap:
`docs/plans/billing-and-engagements-2026-08.md`.

## State of play (2026-08-05)

- **Nothing is built.** Zero invoicing code exists beyond what's listed under
  "already in the codebase" below.
- The plan is **locked by Alex** (8 structured decisions, 2026-08-04) and
  **reviewed by Brittany** (email 2026-08-05, all refinements folded in):
  descriptions carry over with the month auto-advancing (`{month}` token);
  reimbursed-expense estimate lines name the FUTURE month; blurb carries
  over; QBO line-level export ships with I2; **card payments are per-client
  opt-in only** (default = ACH-only link, opted-in client pays the card fee).
- Tracker: `featreq-96afce66`-style contract applies; the invoicing item is
  **`featreq-2cd78b22`** (status planned, ON HOLD note in dev_notes). Its
  dev_notes carry the plain-English read-back Brittany approved.
- She has a 2-page PDF of the plan (Alex emailed it).

## Pre-build gates (owner actions, confirm before I3/I4)

1. Firm Stripe account + **restricted** API key in Railway env
   (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`). Not needed for I1/I2.
2. `pbjsa.com` verified in Resend; sender `billing@pbjsa.com`. Gates I4 —
   current `EMAIL_FROM` is a testing domain; client invoices must not use it.
3. Brittany's sign-off on the literal card-convenience-fee wording (policy is
   decided; the sentence is not). Card surcharge legality varies by state —
   sanity-check FL disclosure rules.

## Already in the codebase — build on, don't duplicate

- `getInvoice()` in `src/lib/utils.ts` — per-client invoice line builder
  (per-employee bill-rate lines or legacy flat rate). The I1 generator wraps
  THIS, plus reimbursements (one-time + recurring, both exist), prior-month
  adjustment (new), scope flags (new), profit (cost rates exist).
- `invoice_drafts` table — exists, empty, and **bulk-save-safe** since
  `32976f4` (the bulk save snapshots/restores it; removing its delete would
  wedge saves via the `ON DELETE RESTRICT` FK — don't "simplify").
- Per-client fields already stored: `payment_terms`, `footer_note`, invoice
  display prefs, rates. Firm settings: logo (pink SVG data-URL), name.
- Email: Resend via `lib/notify.js` (`buildEmailHtml` — root links only, no
  tokens in email; keep that rule for invoice mail).
- Idempotency pattern to copy: the checklists materializer's partial unique
  index + `ON CONFLICT DO NOTHING` (`lib/checklist-identity.js`,
  `db/store.js`). I1 invoices need the same per `(client_id, period)`.
- Time data is seconds-exact (`minutes` numeric); a typed duration wins over
  sessions (93cdcec). Payroll dedup for full-mode splits:
  `src/lib/payrollAggregation.ts`.

## House rules that WILL bite you (full list: docs/HANDOFF.md + CLAUDE.md)

1. `db/store.js` has **two backends** (Postgres + JSON file) — every
   persisted change touches both; tests only run the file backend, so do a
   rolled-back (`BEGIN…ROLLBACK`) statement test against prod Postgres for
   new SQL before deploying (HANDOFF §4).
2. `npm run verify` green before every push. Deploy = push to `main` → poll
   Railway until SUCCESS **on your commit's hash** (a failed push followed by
   a poll shows the PREVIOUS deploy's SUCCESS — always match hashes) →
   `/health` 200.
3. Pushing: this machine hosts TWO GitHub accounts (another project pushes as
   `pmuf-code`). Push exactly like this, every time:
   `gh auth switch --user shizzoobies && git push ; gh auth switch --user pmuf-code`
4. User-visible changes → update `docs/capability-manifest.md` → after deploy
   run `node scripts/provision-voice-agent.mjs` (env vars from Railway).
5. Production DB writes need Alex's explicit approval + a durable undo
   snapshot committed to the repo (`docs/prod-snapshots/` pattern). Tracker
   `feature_requests` single-row status/dev_notes writes have standing
   approval; set `shipped_at=now()` manually when flipping to shipped.
6. Dev notes to Brittany are plain-English, honest about limits, and re-read
   her words before re-coding — "still not working" usually means the
   interpretation missed, not the code (this repo's most-repeated lesson;
   see featreq-96afce66's three rounds).
7. Month-close freeze: risky changes don't ship the 24th–5th.

## Environment quick refs

- Repo: `D:\PBJ Accounting Work\AP For Time Stuff` (this machine); GitHub
  `shizzoobies/PBJBillingApp`; Railway service `PBJBillingApp`, DB service
  `Postgres` (`npx @railway/cli variables --service Postgres` for
  `DATABASE_PUBLIC_URL`). Prod: `https://app.pbjsa.com`.
- Tracker = the app's own Updates page, table `feature_requests`.
- People: Alex (developer/owner, the human you talk to), Brittany (firm
  owner / end client; her feedback arrives via tracker items + Alex).
