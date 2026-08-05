# In-App Invoicing — plan of record (locked 2026-08-04)

> **⛔ ON HOLD (Alex, 2026-08-05): do NOT start any invoicing phase (I1–I5) —
> not in queue runs, not opportunistically.** Alex is pivoting to another
> project and wants his full attention on this build once it starts; he will
> give an explicit go. The plan below is complete and review-approved
> (Brittany 2026-08-05) — it is ready to execute the moment he says so.

Decided with Alex 2026-08-04 (structured questions, all answered). Covers
tracker `featreq-2cd78b22` (Brittany's monthly invoicing braindump) and
**supersedes** the "monthly prep packet" scope in
`billing-and-engagements-2026-08.md` Track B: the packet's content survives as
the draft generator (I1/I2), but the end-state is now **full invoicing from
inside the app — generate, review, email with a payment link, get paid** —
with Stripe as the payment rail. This is a PLAN; nothing here is being built
yet. P1 (sidebar regroup, week of Aug 6) still ships first.

## Locked decisions — do not re-open without Alex

1. **The app is the invoice of record** (numbering, line items, history).
   Stripe is the payment rail only: each send creates a **Checkout Session**
   (`mode: 'payment'`) and our email carries the pay link. NOT the Stripe
   Invoicing product (second system of record + ~0.4–0.5%/invoice fee), NOT
   the QBO API (already rejected this morning). QBO remains Brittany's ledger;
   the app replaces her manual invoicing workflow, and reconciliation guidance
   (Stripe payouts → QBO) is part of I5.
2. **ACH is the payment method; card is PER-CLIENT OPT-IN only** (Brittany,
   2026-08-05 review): the pay link and email show `us_bank_account` only
   (0.8% capped $5) by default. A card alternative appears ONLY for clients
   with a "card allowed" flag (default OFF, set when the client has asked),
   and that client pays the convenience-fee line (~the processing cost).
   ⚠️ Compliance caveat baked in: card surcharging rules vary by state (FL
   permits with disclosure); the fee line wording needs Brittany's sign-off
   and a sanity check before I3 ships. Stripe has no native surcharge switch —
   it is modeled as an explicit line item on the card session only.
3. **Sender: `billing@pbjsa.com`.** Client-facing invoices never go from the
   testing domain. GATE: Alex/Brittany verify pbjsa.com in Resend (SPF/DKIM)
   before I4 sends anything. (HANDOFF already flags EMAIL_FROM deliverability.)
4. **First ship is review-then-send per client.** The monthly run generates
   every draft; Brittany reviews/edits each and clicks Send per invoice.
   Bulk-send and scheduled auto-send are later, after trust is earned.

## Brittany's braindump → where each step lands

| Her manual step (featreq-2cd78b22) | In-app |
|---|---|
| 1–2. Download hours report, break out by client, cost + billing per client | I1 draft generator (the app already computes all of it) |
| 3a. Record reimbursed expenses, estimate next month | Reimbursements already exist; estimates = adjustment lines (I2) |
| 3b/4d. Adjust invoice ± prior month | `prior-month adjustment` line kind, carried automatically (I1) with manual override (I2) |
| 4a–b. Copy last month's invoice; hourly vs plan | Generator reads billing mode/plan per client; last month's blurb/custom lines pre-fill (I2) |
| 4e. Change descriptions | Editable line labels + per-client remembered descriptions (I2) |
| 4f. "Confirm no extra charges — the girls won't know" | Out-of-scope flags on the draft (already a locked decision) (I1) |
| 4g–h. Add blurb, send | Blurb editor + Send with pay link (I4) |
| 5. Evaluate monthly profit per client | Recap profit line (already locked; same data) (I1) |

## Phases

### I1 — Invoice engine (drafts, no sending)
New `invoices` table (BOTH backends, migration in `initialize()`):
`id, client_id, period 'YYYY-MM', number` (sequential `INV-2026-08-001`),
`status` (`draft → reviewed → sent → processing → paid`, plus `overdue`,
`void`), `line_items` jsonb (`kind`: plan | hourly | reimbursement |
recurring | adjustment | scope-flag | card-fee; label, detail, hours/qty,
rate, amount), `subtotal, total, due_date` (from the client's existing
`payment_terms`), `blurb, sent_at, paid_at, stripe_checkout_session_id,
stripe_payment_intent_id, payment_method, email_log` jsonb.
Generator = the existing `getInvoice()` line builder + reimbursements +
recurring reimbursements + prior-month adjustment + out-of-scope flags +
profit (recap). **Idempotent per (client_id, period) with a partial unique
index — apply today's materializer lesson from day one.** Clients gain
`stripe_customer_id` (nullable).

### I2 — Review & edit (Invoices page rebuild)
Monthly-run view: pick a period → every client's draft with status chips.
Per-invoice editor: add/edit/remove lines, adjustment line, blurb (pre-filled
from last month's — confirmed 2026-08-05, "QBO for some reason does not keep
that"), scope-flag review ("the girls won't know" surfaces here), mark
Reviewed. Print stylesheet for a clean paper/PDF-via-print copy.
Owner-only throughout (staff never see invoicing).

**Month-aware descriptions (Brittany, 2026-08-05):** her only recurring manual
edit in QBO is changing each copied description to name the month being paid
for. Descriptions carry over per client AND the month reference auto-advances:
service lines name the SERVICE month; reimbursed-expense estimate lines name
the FUTURE month (her estimate-ahead workflow); the prior-month true-up
adjustment names the PRIOR month. Implement as a `{month}` token substituted
at generation, so a hand-edited description stays hand-edited.

**QBO bulk export (Brittany, 2026-08-05):** a "Download for QBO" button (per
month, and per invoice) producing line-level CSV in the exact column shape
QuickBooks Online's invoice import expects (InvoiceNo, Customer, InvoiceDate,
DueDate, Item, ItemDescription, ItemQuantity, ItemRate, ItemAmount — verify
against the current QBO import template at build time), so she bulk-adds the
month's invoices into QBO in one pass. This replaces I5's vaguer
"reconciliation guidance" as the concrete QBO bridge and ships WITH I2.

### I3 — Stripe rail
Env on Railway: `STRIPE_SECRET_KEY` (**restricted key** — charges/customers/
checkout only), `STRIPE_WEBHOOK_SECRET`. Per send: ensure Stripe Customer for
the client (store id); create Checkout Session `mode:'payment'`,
`payment_method_types:['us_bank_account']`, line items mirrored, invoice
number in metadata; the card-alternative session adds the convenience-fee
line (decision 2 caveat). Webhook `POST /api/stripe/webhook` —
signature-verified, idempotent by event id: `checkout.session.completed` →
`processing` (ACH settles async, ~4 business days),
`payment_intent.succeeded` → `paid` + `paid_at`,
`payment_intent.payment_failed` → back to `sent` + owner notification.
No card data ever touches the app. Needs the FIRM's Stripe account —
whose account + key provisioning is an Alex action before I3.

### I4 — Send & track  *(gated on decision 3's domain verification)*
Invoice email: app-rendered lines + terms + footer (client invoice display
prefs already exist) + blurb + ACH pay link + card-alternative link.
Sends recorded in `email_log`; re-send button; statuses flow
sent → processing → paid; overdue = past `due_date` and unpaid, surfaced on
the Invoices view. Manual "send reminder" (auto-reminders deferred to I5).

### I5 — Close the loop
Dashboard tiles (outstanding / paid this month / overdue), month-lock tie-in,
Stripe payouts → QBO reconciliation guidance for Brittany, opt-in
auto-reminders, bulk-send once trusted. Future (explicitly deferred): saved
ACH mandate + autopay via Setup Intents; partial payments; refunds stay in
the Stripe dashboard.

## Sequencing

P1 sidebar regroup (week of Aug 6) → **I1 → I2** (no external dependencies,
can ship immediately after P1) → **I3** (needs Stripe account + restricted
key) → **I4** (needs pbjsa.com verified in Resend + fee-wording sign-off) →
I5. Engagement track P2–P4 unchanged and independent; P4 (proposal → plan)
eventually feeds I1's plan lines.

## Needs before build (owner actions, not code)

1. Stripe account + restricted API key into Railway (Alex).
2. pbjsa.com verified in Resend; `billing@pbjsa.com` (Alex/Brittany).
3. Brittany's sign-off on the card-convenience-fee wording (and a quick
   state-rules sanity check).
4. Brittany's preferences via tracker when I2 nears: invoice numbering
   format, default due terms, blurb tone.
