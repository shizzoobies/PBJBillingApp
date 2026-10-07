# Credit on account + billing period (featreq-110efd15)

Written 2026-10-07 morning for Alex's approval at noon. Nothing is built.

## The ask (Alex, for Brittany)

1. A client can pay quarterly, or on any period Brittany chooses per client, and still
   receive a monthly invoice with everyone else's; a month already paid goes out as a PAID invoice (no pay button) in the
   same send.
2. Some clients double-pay by accident; she needs to mark their next month paid, and that
   invoice goes out through the same paid-invoice send.

## What exists today (and why none of it fits)

- **Annual billing** puts the fee on one month only; the other months have no lines, so the
  client is skipped as "nothing to bill" (or gets a $0 invoice that later reads past due).
  No monthly paid invoice exists for them.
- **Retainer credit** is one credit per invoice, consumed whole, pointing at one invoice; it
  cannot hold a second payment, a manual credit, or a running balance.
- **The double-payment flag** (`amount-mismatch` with `reason: 'duplicate'`) records the
  second PaymentIntent and offers only "Mark as handled"; "apply it by hand" has no code.
  A settled bank duplicate's `succeeded` event is dropped as a repeat, so the marker keeps
  `settling: true` forever (fix with the Apply-as-credit step).
- **A paid invoice's email** still says "Amount due $X ... due on receipt"; only the PDF
  shows a PAID banner. That is wrong even for today's paid re-sends.
- Sending is one row at a time from the Reviewed tab; an invoice that is already Paid sits in
  the Paid tab and is easy to never send.
- Double payments reach the app only as a second Checkout completion on a still-open session,
  or a Stripe payment after a manual Mark paid. Money paid twice OUTSIDE the app (a second
  check) never reaches it: production shows zero duplicate flags, so her cases were outside.

## Design: credit on account (one mechanism for both asks)

**Ledger.** New table `account_credits` (both backends): id, client_id, amount, source_kind
(`overpayment` | `manual`), source_ref (PaymentIntent id or a UUID; UNIQUE with source_kind so
a credit is created once), for_period (optional YYYY-MM the credit is meant for), note,
created_by, created_at, voided_at/by. NO foreign keys: the bulk save deletes and re-inserts
clients, so this table lives outside it (file backend: server-owned key, stripped from the
read payload).

**Prepayment credits are derived, not stored.** A paid, non-void invoice of new kind
`prepay` yields one credit source per covered month (`prepay:<invId>:<YYYY-MM>`), whichever
way it became paid (webhook, Mark paid, Check with Stripe, never-email stamp).

**Draws are invoice lines.** A draw is a line `{ kind: 'account_credit', amount: -x,
draws: [{ sourceId, amount }] }` on the monthly invoice, excluded from the subtotal like the
retainer credit. Balance = credits minus draws on non-void invoices, so Void and Void &
regenerate hand the money back with no extra bookkeeping. Re-sized on save like the retainer
credit, under a per-client advisory lock so two drafts cannot spend the same credit.

**Draw at generation, Paid at Send.** The monthly run draws the credit tagged to that month
first, then the oldest credit, up to the draft's total, inside the insert transaction. The
draft stays reviewable and editable (late hours, expenses). When she sends an invoice whose
total is $0 from credit, the send route sets it Paid (method `credit`, paid now), then builds
the email and PDF from that row and sends with no pay link; the never-email Mark-reviewed
stamp does the same. Partly covered: it goes out for the remainder with a normal Pay link.

**Second payment -> credit.** "Apply as credit" beside Mark as handled on the Need-a-look
row: the server retrieves the PaymentIntent (as verify-payment does), requires `succeeded`
and the matching invoice id, takes `amount_received` (she may lower it, never raise), inserts
the overpayment credit and marks THAT marker handled in one transaction. Outside-the-app
double payments: a manual credit from the client page.

**Client page.** "Credit on account" panel beside the Retainer position: balance, Add
credit (amount, reason, optional month), and a ledger of credits with the invoices that drew
from them.

**What the client sees.** Paid email: "Paid in full - nothing is owed", no amount-due
panel. PDF banner "Paid <date> from credit on account". Credit line text "Paid from your
prepayment for Q4 2026" or "Credit on account".

**QBO export.** The prepayment invoice exports as item Prepayment (a liability); each draw as
a negative Prepayment line; service lines stay at the full fee so revenue lands monthly (the
retainer pattern). **Recap:** unchanged, revenue is rebuilt from live time monthly.
**Autopay:** a credit-covered invoice is refused (nothing owed / already paid); a partly
covered one is charged the remainder; a prepayment invoice is an ordinary first send and may
be charged. **KLC:** credit belongs to the master that pays; no billing period on masters or
subs in v1. **Hourly clients:** no billing period; a manual credit (a deposit) still works.

## Billing period (stage 2)

Client fields `billing_period_months` (any whole number of months, 1 = monthly as today,
chosen per client - no fixed menu) and `period_anchor_month`, subscription clients only (added to the client insert in the bulk save - coordinate with the B2 batching
plan, which touches the same insert). The monthly run issues the `prepay` invoice
(`monthlyRate x N`, naming the months) in the run BEFORE the first covered month; the
kind-scoped unique index lets it share a month with the monthly invoice. If a covered month's
prepayment is unpaid at Send, the row is flagged and Send asks before billing the fee again.
A fee change inside a prepaid period bills the difference on the monthly invoice.

## Alternatives considered

- Generate the monthly invoice already Paid: literal, but Paid locks the invoice (no late
  hours), Void & regenerate skips it, it sits in the Paid tab unsent, the never-email stamp
  refuses it.
- Build on the retainer: one credit per invoice, used whole; cannot hold a second payment or a
  manual credit; manual every month.

## Ship order (one deploy each, two review rounds, rolled-back prod trial per changed insert)

1a. `account_credits` on both backends + balance read + client panel + manual credit.
1b. `account_credit` line kind, re-size on save, QBO mapping.
1c. Auto-draw at generation.
1d. Paid at Send + the paid email copy (fixes today's paid re-sends too).
1e. "Apply as credit" on the Need-a-look row (also unsticks the settling marker).
2.  Billing period: prepayment invoices + the unpaid-prepayment send guard.

Stage 1 alone solves ask 2 and the paid-send half of ask 1. The manifest is ~100 bytes under
its cap: trim before each step.

## Decisions made (confirm or change)

Credit draws automatically and she can remove the line on a draft; prepayment credits are
derived from the paid invoice; billing periods for subscription clients only; a card
duplicate's credit defaults to the full amount received (fee included), lowerable. Alex
(10-07): there are no annual clients to migrate - the two rows on the old `annual` billing
mode are not treated as such; the old annual mode is left alone and not extended.

## Questions

- Brittany (posted on the ticket): should the prepayment invoice go out with the run before
  the first covered month (Q4's with September's)? What should the QuickBooks item be
  called for prepayments and credits?
- Alex: sequence stage 1 after the bulk-save batching (B2) or before? Both touch the save
  path; B2 first keeps the client insert change in one place.
