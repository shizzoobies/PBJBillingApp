# Invoicing — pickup handoff

Rewritten 2026-08-09. **Supersedes the 2026-08-05 version of this file**, which
said "Nothing is built / ON HOLD" — both are now wrong. Read this, then
`docs/plans/invoicing-in-app-2026-08.md` (the plan of record, including the
decision changes at the top), then `docs/HANDOFF.md` for house rules.

Everything below is committed. Nothing depends on machine-local memory.

## Status: I1–I3 shipped and live. I4 is half-built.

| Phase | State |
|---|---|
| **I1** invoice engine — numbered drafts, idempotent per (client, period) | shipped |
| **I2** monthly run — review, edit, print, Download-for-QBO | shipped |
| **I3** ACH rail — Checkout session, webhook, payment link + button | shipped |
| **I4** email the invoice | **shipped** — see the note on `INVOICE_EMAIL_FROM` below |
| **I5** dashboard tiles, reminders, reconciliation | not started |
| Card payments | **blocked** — see "Card" below |

Production is live at `https://app.pbjsa.com` with real Stripe sandbox keys.
No invoice has been emailed and no real payment has been taken yet.

## I4 is wired end-to-end (2026-08-08)

`POST /api/invoices/:id/send` + the Send button in the month-run editor now
call the part-1 pieces. Behavior worth knowing beyond the original spec:
- A re-send of a `paid`/`processing` invoice goes out as a statement with NO
  pay button (fresh Checkout links are minted only for unpaid, unsettled
  invoices — double-pay guard).
- The Send button is disabled on `draft` (UI-only nudge; the endpoint itself
  does not enforce review — deliberate, matches the payment-link route).
- Post-delivery bookkeeping failures return 200 with a console error — once
  the email is out, the response never claims "send failed".
- The email log entry now records the `total` billed at send time.
- Still Alex's job: set `INVOICE_EMAIL_FROM=billing@pbjsa.com` in Railway once
  that mailbox is real; until then sends go from `EMAIL_FROM`
  (notifications@pbjsa.com — probably not a monitored mailbox).

Commit `82a8441` added the three part-1 pieces. Original state of that commit,
for history:

Already built and tested (20 unit tests, `lib/invoice-email.test.mjs`):
- `lib/invoice-email.js` — `buildInvoiceEmail()` (subject + HTML + plain text)
  and `resolveInvoiceRecipients()` (linked contacts first, honoring a
  per-client email override on a shared contact, falling back to the client
  record, returning a `reason` when there is nobody).
- `db/store.js` → `recordInvoiceSent()` — appends to the append-only
  `email_log`, marks the invoice sent, keeps the FIRST `sentAt`, and does NOT
  claim sent when the attempt failed.
- `lib/notify.js` → `sendInvoiceEmail()` — uses `INVOICE_EMAIL_FROM` falling
  back to `EMAIL_FROM`; returns the provider's own error text rather than a
  generic message.

### The remaining work, in order

1. **`POST /api/invoices/:id/send`** in `server.js`. Owner-only, `isCrossSiteOrigin`
   guard, `application/json` guard — copy the shape of the neighbouring
   `/payment-link` route. It should:
   - refuse a `void` invoice (409)
   - `resolveInvoiceRecipients()`; if `to` is empty return 409 **with the
     `reason` string** so the page can say what is missing
   - create a **fresh** Checkout session (hosted Checkout URLs expire, roughly
     24h — do not reuse `stripeCheckoutSessionId` from an earlier send)
   - `buildInvoiceEmail()` → `sendInvoiceEmail()` → `recordInvoiceSent()`
   - return the updated invoice
   - if Stripe is unconfigured, still allow sending WITHOUT a pay link — the
     email is built to stand alone, and `payUrl` is optional by design
2. **Send button** in `src/components/InvoiceMonthRun.tsx`, next to
   "Payment link" in the editor footer. Show the last send from `emailLog`
   ("Sent to ann@acme.com on Aug 9") and label the repeat action "Send again".
3. **Set `INVOICE_EMAIL_FROM`** in Railway to `billing@pbjsa.com` (Alex's job —
   see the mailbox warning below).
4. `docs/capability-manifest.md`, then re-provision the voice agent.

## Environment — what is set and what is proven

| | |
|---|---|
| `STRIPE_SECRET_KEY` | set, **sandbox** (`sk_test_`) |
| `STRIPE_WEBHOOK_SECRET` | set; rolled 2026-08-09 after I leaked the old one to the transcript |
| Stripe webhook endpoint | exists in the sandbox, enabled, `https://app.pbjsa.com/api/stripe/webhook`, exactly the three events |
| ACH + Financial Connections | Alex confirmed the account is live and set up for payments |
| `RESEND_API_KEY` | set — **replaced 2026-08-09**; the previous key was domain-scoped and 403'd with a misleading "domain is not verified" |
| `pbjsa.com` in Resend | verified. DKIM at the root, envelope SPF on `send.pbjsa.com`, root SPF untouched |
| `EMAIL_FROM` | `PB&J Strategic Accounting <notifications@pbjsa.com>` — magic-link sign-in confirmed working |
| `INVOICE_EMAIL_FROM` | **not set** — I4 falls back to `EMAIL_FROM` until it is |

**⚠️ UNPROVEN: the Stripe signing secret has never verified a genuinely
Stripe-signed event.** Config is verified; the secret itself is not. Alex chose
to find out during the live test. The failure is recoverable — the payment
still succeeds, the invoice just stays at `processing`, Stripe logs 400s, and
after fixing the secret a Resend/retry lands (the `stripe_events` dedup ledger
prevents double-apply).

**⚠️ `notifications@pbjsa.com` is probably not a real mailbox** (MX is
Microsoft 365). Fine for sign-in links; **not** fine for invoices — clients
reply to invoices. `billing@pbjsa.com` should be a real monitored mailbox
before I4 sends anything.

## Decisions made this session (some supersede the locked plan)

- **Card is available to every client, not per-client opt-in** (Alex relaying
  Brittany). Supersedes half of decision 2; recorded at the top of the plan.
- **Card is blocked on a real constraint, not on code.** US rules forbid
  surcharging DEBIT cards, and Checkout does not reveal credit-vs-debit before
  payment, so a fee line added up front would surcharge debit too. Likely
  answer is a flat convenience fee on the card channel (ACH being the default
  channel), plus the network notification surcharging normally requires. Needs
  Stripe or her advisor to confirm. **ACH is unaffected.**
- **Month run is in invoice-number order**, not flagged-first — a list that
  rearranges while you work through it is disorienting.
- **Download-for-QBO is always enabled**, not gated on everything being reviewed.
- **No bulk "mark all reviewed"** — decision 4 is review-then-send per client
  until trust is earned.
- **Delayed page is filtered per viewer**, owners included.

## Things that will bite you

1. **`db/store.js` has two backends.** Tests run the file backend; production is
   Postgres. New SQL gets a rolled-back `BEGIN…ROLLBACK` test against prod
   before deploying (HANDOFF §4). That is how the partial unique index and the
   `ON CONFLICT` predicate were validated.
2. **`invoices` must stay snapshot-and-restored in the bulk save.** `client_id`
   is `on delete restrict`, so `delete from clients` cannot run while an invoice
   exists. Break the restore and every owner autosave wedges — silently. Four
   tests in `db/store-staleness.test.mjs` pin it.
3. **`invoices` is deliberately OUT of the bulk-save payload and out of the
   staleness fingerprint.** A stale owner tab must never rewrite an invoice.
4. **The QBO export's `Item` column is a placeholder.** It matches against the
   product/service list in Brittany's own QBO file, which we cannot see. Needs
   one real import to confirm. Everything else in that file is exact.
5. **Money is recomputed server-side.** `PATCH /api/invoices/:id` ignores any
   totals in the payload and derives them from the lines.
6. **One calculator for money.** `lib/invoice-lines.js` is shared by the UI, the
   generator and Client Recap. Do not add a fourth implementation — the third
   one is what made Recap disagree with the invoice for 16 of 19 hourly clients.

## Local dev gotchas that cost time today

- **`pkill` does not see Windows node processes.** A "restart" silently fails
  with `EADDRINUSE` and the OLD binary keeps answering, so your change appears
  not to work. Kill by port through PowerShell (`Get-NetTCPConnection -LocalPort
  N` → `Stop-Process`).
- **`npm run dev` collides under the preview harness.** It sets `PORT`, so
  `server.js` grabs Vite's port, Vite falls back to 5174, and Vite's proxy
  points at 4173 where nothing listens. Run the API separately on **4173**.
- **Mutating endpoints 403 through the Vite proxy** — `Origin` is
  `localhost:5173` while `Host` is `127.0.0.1:4173`, so the cross-site guard
  correctly refuses. Start the API with
  `APP_PUBLIC_URL=http://localhost:5173`. Does not arise in production.
- **A stale HttpOnly session cookie cannot be overwritten from JS.** `POST
  /api/logout` first, then set one. Owners are forced into TOTP enrollment on
  magic-link login, so that path will not get you a session.
- **Sessions must be minted BEFORE the server boots**, or it clears the cookie.
- **Never print a secret.** A "show only the prefix" helper split on `_` and
  emitted an entire `whsec_` value into the transcript. Report set/not-set.

## Verify before every push

`npm run verify` (eslint + `tsc -b && vite build` + vitest). Currently **975
tests / 73 files**. Then push to `main` → poll Railway until SUCCESS **on your
commit's hash** → `/health` 200 → update the manifest for user-visible changes
→ `node scripts/provision-voice-agent.mjs`.

## Where the pieces live

```
lib/invoice-lines.js      the ONE money calculator (UI + generator + Recap)
lib/invoice-draft.js      due dates, numbering, adjustments, scope flags
lib/invoice-email.js      I4 — subject/HTML/text + recipient resolution
lib/qbo-export.js         Download-for-QBO CSV
lib/stripe-rail.js        Checkout session, signature verification
db/store.js               invoices table, generate/list/update, webhook writes
server.js                 /api/invoices*, /api/stripe/webhook
src/components/InvoiceMonthRun.tsx   the monthly run + editor
src/pages/InvoicesPage.tsx           older per-client view (preview + print)
scripts/set-stripe-keys.ps1          optional interactive key setter
```
