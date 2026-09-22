# Rates that change without rewriting the past

Written 2026-09-22 from Brittany's "Just spitballing" session of the same day
(tracker item `featreq-23351561`, status `brainstorm`). She is starting to
raise her hourly rates and does a yearly rate review per client, and she
wants two guarantees: a new client can start on higher rates while existing
clients stay where they are until their review, and an employee raise must
never change what a past Client Recap says the work cost.

## 0. The decision (Alex, 2026-09-22)

**Rate versions pinned per client.** Bill rates on the Team page become dated
versions; each client is pinned to the month whose rates it bills at; at
review Brittany moves the client to the current rates from a month she picks.
Cost rates get the same history, keyed by the date the time was worked. This
keeps her June 2026 decision (each person bills at their own rate) and adds
exactly one new concept.

Rejected: per-client per-person overrides (a 55 x 8 grid that goes stale) and
reviving one hourly rate per client (reverses June). "Ask Brittany first" was
not needed: her transcript is unambiguous about the two guarantees, and the
open questions she listed are answered by this design (history is shown; cost
stays the hourly rate).

## 1. Why the current model cannot do it

- Hourly billing is per employee: `users.bill_rate`, one firm-wide number per
  person, resolved in `buildInvoiceLines` (`lib/invoice-lines.js`) as
  `employee.billRate`, else the client's retired `hourlyRate`. Raising Lisa's
  rate raises her on every hourly client next month. There is no way to raise
  new clients only.
- Cost is `users.cost_rate`, one number per person, read live at render by
  `buildCostRateMap()` in `server.js` and handed to `buildClientRecap`. A raise
  reprices every past month. `lib/client-recap.js` says so in its own comment:
  no rate history is kept, multi-month views are a restatement at today's
  rates.
- The only time-awareness in pricing is the global constant
  `PER_EMPLOYEE_BILLING_START = '2026-06'`, plus the rate frozen inside each
  sent invoice's `line_items` jsonb. Time entries snapshot nothing.
- No effective-dated pattern exists in the schema to copy. The nearest
  relative is `recurring_reimbursements.coverage_history` (a stored,
  idempotent ledger read by `lib/expense-coverage.js`).

## 2. The model

### 2.1 Bill rate versions

New table `bill_rate_versions` (Postgres) and a `billRateVersions` slice in the
auth store (file backend, beside where `billRate` already lives, NOT in
`app-data.json`):

| column | type | meaning |
|---|---|---|
| `user_id` | text, FK users | the person |
| `effective_period` | text `YYYY-MM` | first billing period this rate applies to |
| `rate` | numeric(12,2) | $/hour charged for this person's time |
| `created_at`, `created_by` | | audit |

Primary key `(user_id, effective_period)`.

Edit rule (Team page, owner-only): the Bill rate box gains an **effective
from** month, defaulting to the current month. Saving with a month that
already has a row for that person **replaces** that row (a correction).
Saving a later month **adds** a version. Saving an earlier month than the
latest is allowed (backfilling a forgotten change) and inserts in order.
Deleting a version is allowed only for the newest one and only if no client
is pinned at or after it.

`users.bill_rate` stays and mirrors the **latest** version after every edit,
so every existing reader keeps working until it is moved to the resolver.

### 2.2 The client's pin

New column `clients.hourly_rate_period` (text `YYYY-MM`, nullable; both
backends, in the bulk-save clamp list beside `hourlyRate`). Meaning: this
client bills each person at that person's bill rate **as it stood in that
month**. Only Hourly clients use it; Monthly and Annual clients ignore it.

- New clients are pinned to the month they are created.
- **Move to current rates from (month)** (client page, owner-only) sets the
  pin to the chosen month (default: next month) and appends to
  `clients.hourly_rate_history` (jsonb array, both backends):
  `{ from: 'YYYY-MM' | null, to: 'YYYY-MM', changedAt, changedBy }`.
  The action is a targeted endpoint (`PUT /api/clients/:id/hourly-rate-period`),
  not part of the bulk save, so a stale owner tab cannot clobber a pin.
- Billing masters (KLC) hold no pin of their own; each sub-client keeps its
  own, and the consolidated draft prices each company at its own pin, the
  same way it already refuses to blend rates.

### 2.3 Cost rate versions

New table `cost_rate_versions` and matching auth-store slice:

| column | type | meaning |
|---|---|---|
| `user_id` | text, FK users | the person |
| `effective_date` | date | first day worked at this rate |
| `rate` | numeric(12,2) | $/hour cost |
| `created_at`, `created_by` | | audit |

Primary key `(user_id, effective_date)`. Same edit rule as bill rates, with an
**effective from** date defaulting to today. `users.cost_rate` mirrors the
latest version.

Cost is keyed by the **entry date**, not the billing period, because a raise
lands on a payday, and the payroll report's semi-monthly windows are date
ranges. A September recap therefore costs September's entries at the rate in
force on each entry's date.

### 2.4 The resolver

New pure module `lib/rate-history.js` (plus `.d.ts`), no I/O:

```
billRateFor(versions, employeeId, ratePeriod) -> number | null
   the row with the greatest effective_period <= ratePeriod, else null
costRateFor(versions, employeeId, entryDate)  -> number | null
   the row with the greatest effective_date <= entryDate, else null
```

Null means "no rate on file" and keeps today's meaning: bill falls back to
the client's `hourlyRate` (the firm default), cost counts as zero.

## 3. Who reads the resolver

Every place that prices or costs time goes through it. One function each
side, no second implementation.

**Billing (`billRateFor` with the client's pin):**
- `buildInvoiceLines` (`lib/invoice-lines.js`): `rateFor` reads the resolver.
  The pre-June legacy branch is untouched. A pinned month before `2026-06` is
  impossible (the migration floors at `2026-06`).
- `buildInvoiceDraft` and the consolidated draft (`lib/invoice-draft.js`).
- `buildClientRecap` revenue (`lib/client-recap.js`), which already prices
  month by month: each month uses the client's pin **as of that month**,
  read from `hourly_rate_history`, so a client moved in March has January and
  February priced at the old rates. The "today's rates" caption on
  multi-month views goes away for hourly clients.
- The estimate tier rate (`resolveTierRate` bill side).
- The AI hours summary in `server.js` (`buildInvoiceHoursSummary`, master
  variant too).
- `lib/firm-analytics.js` `clientProfitability`, which today still prices at
  the retired `client.hourlyRate` (a known inconsistency this build closes).
- Reports page "Billable $" column: no single rate per person exists any
  more, so the server prices each entry at its client's pin for the entry's
  period and returns the per-person total, the same rows the invoices would
  bill.

**Cost (`costRateFor` by entry date):**
- `laborCost` in `lib/payroll-cost.js` takes a `(employeeId, entryDate)`
  resolver instead of a per-person map.
- `buildClientRecap` labor cost, tier cost rate, margin.
- Payroll costing on Reports (`src/lib/payrollAggregation.ts` consumers) via
  the server supplying per-entry cost, or the versions list to the client.
- `lib/firm-analytics.js` cost side.

`buildCostRateMap()` is replaced by `loadRateVersions()` returning both lists
for owners and empty lists for staff (rates stay owner-only, redacted in
`scopeAppDataForSession` like every other rate).

**Untouched by design:** sent, paid, voided invoices. Their `line_items`
carry their own `rate`; `sanitizeInvoiceLines` keeps re-deriving amount from
stored hours x stored rate. The Invoice Recap reads stored invoices and is
already correct.

## 4. Migration (idempotent, runs in `initialize()` on both backends)

1. Create the two tables / slices.
2. For every user with a non-null `bill_rate`, insert a `bill_rate_versions`
   row at `2026-06` if that user has no versions yet.
3. For every user with a non-null `cost_rate`, insert a `cost_rate_versions`
   row at `1970-01-01` if none exist (a floor before any time entry).
4. For every client with `billing_mode = 'hourly'` and a null pin, set
   `hourly_rate_period = '2026-06'` and `hourly_rate_history = []`.

After the migration every price and every cost equals today's numbers
exactly. This is the property the production reproduction (section 7)
proves before the push.

## 5. UI

**Team page** (owner-only): the Bill rate and Cost rate boxes each gain an
effective-from input (month for bill, date for cost) and a small "history"
disclosure listing prior versions. The default effective-from is the current
month / today, so the common edit is one extra glance, not a new step.

**Client page, Billing card, Hourly clients** (owner-only, redacted for
staff): a "Hourly rates" block showing each team member's rate at the
client's pin, the line "Rates from (Month YYYY)" with its age ("20 months"),
the **Move to current rates from (month)** control, and the history list
from `hourly_rate_history`. Monthly and Annual clients show nothing new.

**Add-client modal:** nothing visible changes; the pin is set server-side to
the creation month.

**Client Recap:** the billing tile's multi-month caption changes from
"today's rates" to "the rates in force each month" for hourly clients; the
cost line's help text says cost uses each person's rate on the day worked.

**Capability manifest:** the Team page Bill rate / Cost rate entries, the
per-employee billing paragraph, the Client Recap "today's rates" paragraph,
and a new Client page "Hourly rates" entry. Re-provision the voice agent
after deploy.

## 6. Out of scope

- An anniversary reminder engine. The age line on the client page is enough
  for her yearly pass; a reminder is a separate ask if she wants one.
- Per-client per-person overrides.
- Cost beyond the hourly rate (she said "just the hourly rate for now").
- Repricing anything already sent.
- A priced package (still a separate ask, per the Packages ship note).

## 7. Tests and proof

- Unit tests for `lib/rate-history.js`: exact-month hit, earlier month,
  before the first version (null), unordered input, two people.
- Store tests on BOTH backends for every new column and both version tables:
  add, replace-on-same-period, latest-mirror on `users.bill_rate` /
  `cost_rate`, pin default on client create, pin move + history append, the
  newest-only delete rule.
- `buildInvoiceLines` tests: two clients on different pins bill the same
  person at different rates in the same period; a client moved in March
  prices February at the old rate in the recap.
- `laborCost` tests: an entry the day before a raise costs the old rate, the
  day of the raise the new rate.
- **Read-only production reproduction before the push**: run the migration
  logic in memory over the live rows, price every hourly client's August and
  September drafts through the new path, and diff against the sent invoices'
  stored lines. Zero differences is the gate. Same for August labor cost on
  every Client Recap.
- `npm run verify` green; push; `/health` commit check; voice re-provision.

## 8. Draft tracker note for Brittany (`featreq-23351561` dev_notes, on ship)

Hourly rates now keep their history. On the Team page each person's bill
rate and cost rate carry an "effective from" date, so a raise or a price
change starts on the date you pick and leaves everything before it alone.
Each hourly client's page shows the rates that client is on and the month
they date from; when you review a client, press "Move to current rates
from" and pick the month. New clients start on the current rates. The
Client Recap costs each person's time at the rate they were paid on the day
they worked it, so a raise never changes a past recap. Nothing already sent
has changed.
