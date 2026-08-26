# Consolidated billing — one invoice to KLC, four companies on it

**Tracker:** `featreq-65f5eac1` · **Status:** planned, not started · **Written** 2026-08-26

Brittany's answer, verbatim:

> **A** — But I would like to be able to evaluate each company separate and see
> what each "paid"

So: **one invoice, addressed to KLC, with Bright Tower, Chemtrex and XACT on it**
— and per-company attribution has to survive the merge, both on the document and
afterwards in reporting.

Her source data is column U of the 2026-08-25 contact list: Bright Tower
(`client-…`), Chemtrex and XACT are marked "Invoice will go to KLC". KLC Floors &
More (`client-6t9crg6`) is the payer and a billing client in its own right.

---

## 1. What exists today, and why this is not a small change

`generateInvoicesForPeriod` (db/store.js) loops clients and builds **exactly one
draft per client**. `invoices` carries a partial unique index
`invoices_client_period_monthly_live` on `(client_id, period)`. Nothing anywhere
in the app expresses "this client's work is billed to that client" — a grep for
`billToClientId` / `parent_client` is empty.

Four things key off "every active client gets an invoice", and each one has to be
taught otherwise:

| Surface | What breaks if we just skip the three |
|---|---|
| **Never-generates detector** | Reports three clients as silently unbilled, every month, forever |
| **Reimbursement coverage** | Each company has its own QBO recurring charge with its own covered-date ledger. The line must still be generated and the window still advanced — on someone else's invoice |
| **Invoice History / client page** | Chemtrex's page would show no invoice for the month, which reads as "we forgot to bill them" |
| **Single-client generate** | "Generate for Chemtrex" has to mean "regenerate KLC's invoice", or be refused with a sentence |

---

## 2. The shape

**Data.** `clients.bill_to_client_id text` — nullable, defaulted null, on both
backends. **Sanitized exactly like `plan_ids`**: a dangling id here would be the
2026-06-17 outage again (see the plan-refs memory — a dangling id in an array
with no FK crashed every bulk write). Rules: must reference an existing client,
may not be self, and may not chain (a payer cannot itself be billed elsewhere) —
one level only, checked on write.

**Generation.** In the client loop:

- a client with `billToClientId` set is **skipped for its own invoice** with a
  new `skipped` reason `billed-to-other` — a real answer, not silence, so the
  never-generates detector can report "billed on KLC's invoice" instead of
  "never generated";
- the payer's draft is built from its own lines **plus** each billed-to
  company's lines, in client-name order.

**Lines.** Every line gains `sourceClientId` (null = the payer's own work). Each
company's block gets a heading row and a subtotal, reusing the ad hoc block's
pattern (`invoice-run-adhoc` heading + grouped rows) rather than inventing a
second grouping idiom. `sourceClientId` is what answers "what did each pay"
later, so it is written on the line at generation and never derived afterwards.

**"See what each paid."** One payment lands on one invoice, so a company's paid
amount is its subtotal once the invoice is paid — a derived figure, not a second
money record:

- on the invoice editor, a per-company subtotal line;
- on each billed-to company's client page, "Billed on INV-2026-08-0xx (KLC) —
  $X · paid 2026-09-03";
- in Invoice History, the companies appear as rows under the payer's invoice.

No partial-payment apportionment: the rail takes full payment of an invoice, so
a company is paid when the invoice is. If that ever changes, apportion pro-rata
by subtotal and say so on the page.

---

## 3. Decisions still open

**For Brittany:**

1. **Does KLC's own work go on the same invoice?** Assumed yes — it is her
   client too, and "one invoice, one payment" implies it.
2. **One number or four?** Assumed **one** (`INV-2026-08-0xx`, KLC's), with the
   companies as sections. Four numbers on one document would be four invoices in
   an envelope, which is answer B and she picked A.
3. **Does the client see the other companies' names?** Assumed yes — they are
   all hers and KLC is paying for them. Worth confirming, because it is the one
   thing that cannot be undone after a send.

**For Alex:**

4. **Retainers and ad hoc** — assumed to follow the same routing (a billed-to
   company's retainer is issued to KLC). Not obviously right; a retainer is an
   engagement-level document.

---

## 4. Order of work

1. `bill_to_client_id` + sanitization + both backends + round-trip test
   (the bulk save's `clients` INSERT is positional — see the column-count test
   added 2026-08-26).
2. `sourceClientId` on lines, through `sanitizeInvoiceLines` and the
   snapshot/restore pair.
3. Generation: skip + merge + `billed-to-other` skip reason.
4. Invoice rendering: per-company sections and subtotals, print sheet included
   (run `scripts/check-print-pdf.mjs` — jsdom cannot see the print CSS).
5. The three read surfaces: client page, Invoice History, never-generates.
6. Rolled-back prod validation of a real merged draft for KLC + its three
   companies before anything ships.

**Not in v1:** partial-payment apportionment, more than one level of bill-to,
and moving an already-sent invoice's routing.
