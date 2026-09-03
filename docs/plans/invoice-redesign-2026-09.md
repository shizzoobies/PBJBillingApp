# Invoice redesign — three sections, role grouping, hours as page 2

**Tracker:** `featreq-97ae3214` · **Written** 2026-09-03 · Spec from her
2026-08-31 "Invoices" email + marked-up sample PDF (quoted in the tracker row).

Alex's ruling already on file (tracker dev_notes, 2026-09-01): on which section
a person's hours land — *"as long as the number is right the bucket doesn't
matter"* — so `senior_bookkeeper` → **Accounting Services** needs no further
sign-off. **The constraint he attached is the one that governs this build: the
three section totals must sum to exactly what per-person lines bill today.**

---

## 0. The decision that shapes everything: this is a RENDERING change

The tracker row predicted "a real restructure of `lib/invoice-lines.js`".
Recon says that would be both unnecessary and dangerous. Two independent
findings force the same conclusion:

1. **Merging people into one role row breaks the money.** Her columns are
   Description | Hours | Rate | Amount — one rate per row. Two people in one
   role at different rates have no single rate, so `hours × rate ≠ amount`.
   Worse, it fails silently: `sanitizeInvoiceLines` (`db/store.js:1121-1141`)
   *re-derives* `amount = hours × rate` whenever a line carries both, so the
   first save after a hand-edit would quietly rewrite the invoice's money.
2. **Grouping must happen downstream of `clientFacingInvoiceLines`.** Sub
   company names live in labels, coverage windows in details, and every merged
   line carries `sourceClientId`. Grouping stored lines and *then* applying
   combined mode re-opens the KLC leak that shipped as a blocker on 2026-08-28.

**Therefore:** stored `lineItems` keep their present per-person shape. The
redesign adds (a) one additive, non-money field so a renderer can tell which
role a line belongs to, and (b) a presentation layer that groups the *resolved*
client-facing lines into titled sections. Every money invariant — `hours × rate`
exactness, the sanitizer, `sourceClientId` attribution, Client Recap sums, QBO
row counts, the editor's round-by-hand control — holds by construction, not by
test.

**What the client sees** (rows stay per-person, headings are the new part):

```
AD-HOC / BILLABLE HOURS
  CFO / Advisory Services
    Billable hours — Brittany Ferguson   3.50   $150.00   $525.00
  Bookkeeping Services
    Billable hours — Lisa Mockabee      22.61   $125.00  $2,826.25
                        Total Ad-Hoc/Billable Hours       $3,351.25
```

If she later wants ONE row per role, that is a different feature and it forces
the mixed-rate question above — do not slide into it.

## 1. The contract (all lanes build against this)

### 1a. `roleTier` on work lines — the only data change

`lib/invoice-lines.js` stamps `roleTier` on each `hourly` and `adhoc` line at
generation, where `employees` is in scope. Values reuse the EXISTING mapping —
do not write a second one: `recapStaffTier(employee.role)` from
`lib/client-recap.js:72-83` → `'CFO' | 'Accountant' | 'Bookkeeper' | 'Other'`.
(`Employee.role` is itself derived from `users.role` by `dbRoleToEmployeeRole`,
`db/store.js:342-353`: `owner→Owner`, `senior_bookkeeper→Accountant`, else
`Bookkeeper`.) Purely presentational: nothing reads it for money.

Because `sanitizeInvoiceLines` drops every property it does not name
(`db/store.js:1063-1073`), `roleTier` needs an explicit branch there or it
evaporates on the first save. It must also be added to `INVOICE_LINE_KINDS`'
neighbouring type decls (`lib/invoice-lines.d.ts`, `src/lib/types.ts`).

A line with no `roleTier` (legacy invoices, the pre-cutover single line, a
hand-added custom row) renders **ungrouped at the top of the hours section** —
never under a wrong heading, never dropped.

### 1b. `invoiceSections(lines, { combined })` — the presentation layer

New export in `lib/invoice-lines.js`, beside `clientFacingInvoiceLines`. Takes
**already-resolved client-facing lines** and returns:

```js
[ { key, title, rows: [line…], total, groups?: [{ key, title, rows }] } … ]
```

- `plan` → **Subscription Plan**
- `hourly` + `adhoc` → **Ad-Hoc / Billable Hours**, sub-grouped by `roleTier`
  in fixed order CFO → Accountant → Bookkeeper → Other, titled
  *CFO / Advisory Services*, *Accounting Services*, *Bookkeeping Services*,
  *Other Services*. Ungrouped (no `roleTier`) rows come first, untitled.
- `reimbursement` + `recurring` → **Client Reimbursed Expenses**. Reuse
  `REIMBURSED_LINE_KINDS` (`lib/invoice-recap.js:36`) — do not write a
  second list.
- `card-fee`, `retainer_credit`, `retainer`, `adjustment`, `custom` → a final
  **untitled** block, no section total (these are charges/credits, not work;
  `adjustment` is already excluded from subtotal).
- `time_detail` → **excluded entirely** — it is page 2 (§1c).
- Each section total = `Σ round2(row.amount)` over its own rows. Sections with
  no rows are omitted (an hourly client shows no Subscription Plan section).

**`combined: true` returns a single untitled section with no total** — the same
suppression the Subtotal row already gets (`lib/invoice-pdf.js:329`). A master's
resolved array is `[combined, card-fee?, retainer_credit?]`, which fits none of
her three names, and per-section totals there would expose the split the client
chose to hide. Pinned by the existing tests that assert no per-company amount
appears (`src/__tests__/invoice-print-master-combined.test.tsx:207`).

**Section total labels must not be the bare word "Subtotal"** — a combined-mode
PDF test asserts `not.toContain('Subtotal')` (`lib/invoice-pdf.test.mjs:315`).
Her wording is "Total Subscription Plan" / "Total Ad-Hoc/Billable Hours" /
"Total Client Reimbursed Expenses", which is safe.

### 1c. Page 2 — detailed hours

The existing time-breakdown lines (`kind: 'time_detail'`, `amount: 0` by
invariant) become an appendix after a hard page break, titled with her label.
Zero money risk: the invariant means pulling them out cannot move a total.

- **Suppressed entirely in combined mode** — `time_detail` is not in
  `COMBINED_KEPT_KINDS`, so a master's page 2 would otherwise print blank.
- **Suppressed when there are none** (breakdown mode `off` — the default for
  all 51 clients today, so most invoices stay one page).
- PDF: explicit `doc.addPage()`. **Note `lib/invoice-pdf.js:324-365` (totals,
  terms, blurb, footer) has NO bottom guard today** — adding a page makes that
  latent overflow reachable; add the guard as part of this work.
- Print sheet: a `break-before: page` rule scoped to the new section — the
  invoice print block (`src/App.css:3449-3550`) currently has no page-break
  rules at all.
- Email: page 2 has no meaning in an email body. `time_detail` rows keep
  rendering inline as they do today, after the sections. HTML **and** the
  plain-text alternative must agree (`lib/invoice-email.js:299-301`).

### 1d. Header / footer changes (her markup)

| Change | Today | Becomes |
|---|---|---|
| Letterhead tagline | `firmSettings.tagline` printed | **removed** (PDF `invoice-pdf.js:83`; print sheet `InvoicesPage.tsx:1248,1309`) |
| Date fields | `Issued` + `Due` | **`Invoice no.`** + **`Invoice Date`** + `Due`. The number currently appears only in the 20pt title. |
| Print sheet's date | `new Date()` — TODAY, not the invoice's date (`InvoicesPage.tsx:1228-1232`) | the invoice's own date — this is a real bug the rename exposes |
| Period label | period sub-label | **`Billing Period: Month Year`** |
| Footer | `client.footerNote \|\| "Thank you for trusting {firm}."` | default becomes **"Spread success, not stress, thanks for choosing PB&J Strategic Accounting."**; a per-client `footerNote` still wins |

**Payment terms — FLAGGED, not guessed.** Her markup shows *"Due on Demand"*.
The four KLC-group clients' stored `paymentTerms` say *"Due on receipt"*. Terms
are per-client DATA and are already printed from the record, so this build keeps
printing the client's stored terms — changing what the record says is Alex's
call, not a code change. Raised with him; if he wants the words to read "Due on
Demand" that is a client-record edit (or a firm-default change), not this ticket.

**"Small description based on plans chosen"** (Subscription Plan section): the
plan line's label already comes from `serviceLabel` (`invoice-lines.js:811-819`
— `monthlyServiceTier` → joined plan names → fallback) and its detail is the
literal `'Monthly service'`. Use the plan names for the description; if the
plans carry no description text, leave the existing detail rather than inventing
copy.

## 2. Surfaces to change

1. `lib/invoice-lines.js` — stamp `roleTier`; add `invoiceSections`; types.
2. `db/store.js` — one `sanitizeInvoiceLines` branch preserving `roleTier`
   (both backends are unaffected otherwise; this is a jsonb-carried field).
3. `lib/invoice-pdf.js` — section headings + per-section totals, header/footer
   per §1d, page 2 + the missing bottom guard.
4. `lib/invoice-email.js` — sections in the HTML table AND the plain-text part.
5. `src/pages/InvoicesPage.tsx` + `src/App.css` — the print sheet's sections,
   page 2 break, header/footer, and the today-vs-invoice-date fix.
6. `scripts/check-print-pdf.mjs` — its `pages === 1` assertion becomes
   per-mode. **Its fixture is a one-row stub that will not paginate naturally,
   so it must gain a real `time_detail` section or the check passes vacuously
   and stops protecting anything.**
7. `docs/capability-manifest.md` — the invoice document description; re-provision
   the voice agent after deploy.

**Not in scope:** the month-run editor keeps its current flat table (her spec is
about the document the client receives); merged one-row-per-role; changing
stored line shape; the live per-client preview's pre-existing double-listing bug
(`InvoicesPage.tsx:228-237`, dating to the June cutover).

## 2a. What the build and the review found (2026-09-03)

- **Production has a sent invoice that breaks the `time_detail` invariant.**
  INV-2026-08-044 (Dobco Properties) carries its whole $256.25 on three
  hand-built `time_detail` rows labeled "CFO/Advisory Services". The $0.00
  invariant is the GENERATOR's, not the store's. Rule adopted: a `time_detail`
  row is page-2 material only when it carries no money; one with money is a
  charge and stays in the body. Found by the 59-invoice dry run, not by tests.
- **Every display-row construction site must carry `kind`.** `invoiceSections`
  selects by kind, so a kind-less row vanishes from the document while its money
  stays in Total due. The live preview, Customize's seed/draft mapping, and
  Customize's "Add line" (the review's blocker) all had to be stamped. The
  section layer now also has a RESIDUAL bucket — anything unclaimed prints
  plainly in the untitled charges block — so that class of bug cannot recur
  silently, pinned by a test that iterates every kind in `INVOICE_LINE_KINDS`
  plus a kind-less row.
- **The print sheet's date fix had a timezone edge**: `new Date(isoTimestamp)`
  is the LOCAL day, the PDF's `stampDate` is the UTC day — a 9pm ET generate
  would print two different dates on two client-facing copies. Both now use the
  UTC calendar day.
- **The live preview's June-cutover double-listing** (`subscriptionLines`
  filtered by label, which stopped matching per-person labels) went from
  "reader has to add it up" to "the sheet prints a wrong section total" once
  section totals existed. Fixed by filtering on kind. It was dormant (breakdown
  off for all 51 clients) but one client setting from a printable contradiction.
- The footer sentence was hardcoded in four places; it is one exported constant
  now (`INVOICE_FOOTER_DEFAULT`, `lib/invoice-lines.js`).
- `scripts/check-print-pdf.mjs` gained a third mode — the one-page invoice with
  no appendix, which is what all 51 clients actually print — so a broadened
  page-break rule cannot pass on the two-section fixture alone.
- Deliberately unchanged, noted: charge rows (card fee, adjustment, credits,
  hand-typed customs) now always print after the three sections regardless of
  stored position; the owner's on-screen `InvoicePreview` stays a flat list
  (review view) while the print sheet is sectioned (client view).

## 3. Verification (money first)

- `npm run verify` green.
- **`node scripts/check-print-pdf.mjs` for real**, via the cached-Chromium
  wrapper (`PLAYWRIGHT_MODULE`) — jsdom cannot see paged media.
- **Production dry run before push:** rebuild real August invoices read-only and
  assert, per invoice, that Σ section totals === the stored `total`, and that
  every existing line's amount is byte-identical to what is stored. This is the
  direct test of Alex's constraint.
- The negative combined-mode assertions must pass untouched: no sub company
  name and no per-company amount on any client-facing surface.
