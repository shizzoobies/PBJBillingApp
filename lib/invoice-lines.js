/**
 * The invoice line builder — the ONE place money becomes invoice lines.
 *
 * Lifted verbatim out of `src/lib/utils.ts` (behavior-for-behavior; the tests in
 * `src/__tests__/get-invoice.test.ts` pin that nothing changed) so it can be
 * plain JS and therefore shared. It now has three consumers:
 *
 *   - `src/lib/utils.ts` → `getInvoice()`, which the UI renders
 *   - the I1 server-side draft generator, which persists invoices
 *   - `lib/client-recap.js`, for the revenue half of per-client profit
 *
 * Why that matters: before this existed there were TWO implementations of "what
 * do we bill this client", and they disagreed. Client Recap valued hourly work
 * at the client's legacy `hourlyRate` while invoices had billed each employee's
 * own `billRate` since the June 2026 cutover. Measured on July 2026 production
 * data that was wrong for 16 of 19 hourly clients — overstating some, e.g.
 * $4,400.83 against a real invoice of $3,837.58, and understating others. A
 * third copy inside the server generator would have made it worse, so there is
 * now one.
 *
 * Everything here is PURE: same inputs, same lines, no clock and no I/O.
 */

import { coverageLineLabel, resolveCoverageForPeriod } from './expense-coverage.js'
// Billing now shares THE hours rule with payroll (featreq-cfb1536a, her answer
// revised in person to A): a person's billed hours are the sum of their rows'
// two-decimal hours, and money is that figure times the rate. One calculator,
// both sides — what stops the recap and the invoice ever disagreeing again.
import { displayHours, periodDisplayHours, periodMoney, roundToCent } from './payroll-cost.js'
// The SAME week anchor the timer gate and the assistant use. A breakdown that
// grouped weeks differently from the timesheet would be two calendars.
import { weekStartOf } from './time-entry.js'
// The reimbursed-vs-services split, from the module that already had to draw
// the same line for the Invoice Recap. One list, so the invoice's expense
// section and the recap can never disagree about what an expense is.
import { REIMBURSED_LINE_KINDS } from './invoice-recap.js'
// THE staff tier mapping (leaf module — see its header for why it is not in
// client-recap.js any more). The invoice's role groups and the recap's roles
// table read the same four tiers.
import { recapStaffTier } from './staff-tiers.js'
// THE rate resolver (lib/rate-history.js). A client bills each person at that
// person's rate AS IT STOOD in the client's pinned month, so pricing can no
// longer read a single live number off the employee record.
import { billRateAt, ratePeriodAsOf } from './rate-history.js'

/**
 * Hourly billing cutover (YYYY-MM, inclusive). Periods on/after this month bill
 * hourly clients at each EMPLOYEE's bill rate; earlier months keep the LEGACY
 * per-CLIENT rate so already-sent historical invoices stay byte-for-byte exact.
 * This is an accounting firm — a number that was invoiced must never move.
 */
export const PER_EMPLOYEE_BILLING_START = '2026-06'

export const MONTH_NAMES = [
  '',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

export const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
})

/**
 * Two-decimal hours for invoice line detail: 90 -> "1.50h", 120 -> "2.00h".
 *
 * The plain-JS twin of `formatDecimalHours` in `src/lib/utils.ts` — this module
 * is imported by the Node server, which cannot load TypeScript, so the two must
 * be kept identical by hand. Always two decimals; a client reading
 * "20.22h at $16.00/hr" can check the arithmetic, "20.2h" they cannot.
 */
export function formatDecimalHours(minutes) {
  const hours = minutes / 60
  return `${(hours === 0 ? 0 : hours).toFixed(2)}h`
}

/** Out-of-range or absent billing months fall back to January. */
export function normalizeBillingMonth(value) {
  const month = Number(value)
  if (!Number.isFinite(month) || month < 1 || month > 12) return 1
  return Math.floor(month)
}

/** "2026-06" -> "June 2026". */
export function getBillingPeriodLabel(period) {
  const [year, month] = String(period).split('-').map(Number)
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(
    new Date(year, month - 1, 1),
  )
}

/** A time entry belongs to a period when its date starts with "YYYY-MM". */
export function isInBillingPeriod(entry, period) {
  return String(entry?.date ?? '').startsWith(period)
}

/* -------------------------------------------------------------------------- */
/* Ad hoc time                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What the owner decided to do with one piece of AD HOC time — work outside the
 * client's scoped arrangement, flagged `isAdhoc` on the time entry itself.
 *
 *   - `billed`   — the default. A line with detail, charged at the employee's
 *                  own bill rate, exactly like scoped hourly work.
 *   - `courtesy` — the line still prints, at $0.00, so the client SEES the work
 *                  was done and not charged. No reason is required.
 *   - `omitted`  — not on the client's invoice at all. The line stays on the
 *                  draft (at $0.00) so she can put it back.
 */
export const ADHOC_MODES = ['billed', 'courtesy', 'omitted']

/** Anything unrecognized (or absent) is the default, "invoice it". */
export function normalizeAdhocMode(value) {
  return ADHOC_MODES.includes(value) ? value : 'billed'
}

/**
 * The same adhoc line under a different mode. THE one rule turning the owner's
 * three-way choice into money, shared by the month-run editor and the server's
 * line sanitizer so the running total on screen and the stored total can never
 * describe different decisions.
 *
 * `adhocAmount` is what billing this work WOULD charge, kept on the line even
 * while it is at $0.00 — that is what makes courtesy and omit reversible.
 */
export function adhocLineForMode(line, mode) {
  const next = normalizeAdhocMode(mode)
  // Falls back to the line's own amount, matching the server's sanitizer: a
  // line that somehow arrived without a reserve must not be zeroed by a flip to
  // courtesy and back. Absent means "nobody has set this yet", not "worth zero".
  const reserved = Number(line?.adhocAmount ?? line?.amount)
  const billable = Math.round((Number.isFinite(reserved) ? reserved : 0) * 100) / 100
  return {
    ...line,
    adhocMode: next,
    adhocAmount: billable,
    amount: next === 'billed' ? billable : 0,
  }
}

/** Is this an ad hoc line the owner chose to keep off the client's invoice? */
function isOmittedAdhoc(line) {
  return line?.kind === 'adhoc' && normalizeAdhocMode(line.adhocMode) === 'omitted'
}

/**
 * The lines that actually PRINT on the client's document — every line except an
 * adhoc one the owner omitted. Screen, PDF and email all render through this,
 * which is why "omit" needs no special case in any of the three.
 *
 * Omitted lines carry $0.00, so totals agree whether or not a surface filters:
 * this hides the row, it does not change the money.
 *
 * DELIBERATELY A POSITIVE-IDENTIFICATION FILTER: it drops only what it can
 * positively identify as an omitted ad hoc line and passes everything else
 * through untouched, which makes it safe over lines that carry no `kind` at all
 * and idempotent over lines already filtered once. The in-app print sheet
 * (src/pages/InvoicesPage.tsx) relies on both — it hands over display-mapped
 * lines of label/detail/amount, and `clientFacingInvoiceLines` runs a
 * standard-mode document back through here afterwards. Making this strict about
 * `kind` would empty that sheet silently; see the test in adhoc-invoicing.test.mjs.
 */
export function renderedInvoiceLines(lines) {
  return (Array.isArray(lines) ? lines : []).filter((line) => !isOmittedAdhoc(line))
}

/**
 * Is this a plan line with no money on it? A subscription client at a monthly
 * rate of 0 (or an annual client at 0 in its billing month) has no monthly
 * service to bill, and a "Subscription Plan" section holding one $0.00 row says
 * they do (featreq-87b20ed7).
 *
 * ONLY `kind: 'plan'`, ONLY exactly zero in cents. A courtesy ad hoc line is
 * $0 on purpose, a `time_detail` row is $0 by design, and a negative plan line
 * is a credit — none of those are this.
 */
export function isEmptyPlanLine(line) {
  return line?.kind === 'plan' && Math.round((Number(line?.amount) || 0) * 100) === 0
}

/**
 * The lines minus any empty plan line. THE ONE PLACE the "show only the sections
 * the client has" rule lives for stored invoices: `clientFacingInvoiceLines`
 * applies it, so the print sheet, the PDF and the email all inherit it, and the
 * month run's "N lines" count asks it too. Display only — nothing stored changes,
 * and the dropped line was $0, so no total can move.
 */
export function withoutEmptyPlanLines(lines) {
  return (Array.isArray(lines) ? lines : []).filter((line) => !isEmptyPlanLine(line))
}

/**
 * Is this an hours row with no hours on it? The hourly section offers three role
 * rows she can fill (CFO / Advisory, Accounting, Bookkeeping), and a row she
 * added or left at 0.00 is on the DRAFT so she can fill it later, but it has
 * nothing to tell the client: it is left off their copy, exactly as a $0 plan
 * line is.
 *
 * ONLY `kind: 'hourly'`, ONLY a numeric `hours` of exactly 0, ONLY exactly zero
 * in cents. A legacy hourly line carries no `hours` field at all and can never
 * match, so every stored invoice prints as it always did; a courtesy ad hoc line
 * is `adhoc`, not `hourly`, and still prints at $0.00 on purpose.
 */
export function isEmptyHoursLine(line) {
  return (
    line?.kind === 'hourly' &&
    typeof line.hours === 'number' &&
    line.hours === 0 &&
    Math.round((Number(line.amount) || 0) * 100) === 0
  )
}

/**
 * The lines minus anything that has no money AND no content to show: an empty
 * plan line and an empty hours row. THE ONE PLACE the client's copy drops them —
 * `clientFacingInvoiceLines` applies it (so the print sheet, the PDF, the email
 * and Stripe checkout all inherit it) and the month run's "N lines" count asks it
 * too. Display only: both dropped kinds are $0, so no total can move.
 */
export function withoutEmptyLines(lines) {
  return (Array.isArray(lines) ? lines : []).filter(
    (line) => !isEmptyPlanLine(line) && !isEmptyHoursLine(line),
  )
}

/**
 * The most an hours line's hourly rate may be: $10,000. Above it is a typo (an
 * extra zero), so the editor will not take it and the store's sanitizer refuses
 * it the way it refuses an over-cap hours value.
 */
export const MAX_HOURLY_RATE = 10000

/**
 * The most hours one hours line may carry: 100,000. The store's sanitizer refuses
 * more, and the editor's hours box will not take it.
 */
export const MAX_LINE_HOURS = 100000

/**
 * The detail text of an hours line: "1.50h at $75.00/hr". ONE function for the
 * generator, the hours panel's re-tag and the editor's hours and rate boxes, so
 * the sentence the client reads cannot come out three different ways.
 */
export function hourlyLineDetail(hours, rate) {
  return `${hours.toFixed(2)}h at ${currency.format(rate)}/hr`
}

/* -------------------------------------------------------------------------- */
/* The RENDERING MODE — what a client-facing document shows                    */
/* -------------------------------------------------------------------------- */

/**
 * How a client-facing document renders its lines.
 *
 *   'standard' — every stored line, exactly as it has always printed. Every
 *                client that is not a billing master.
 *   'combined' — ONE line for the whole month. Brittany's answer to "does KLC
 *                see the other companies' names" was "2": the printed and
 *                emailed document shows a single combined line, and the
 *                per-company split lives app-side only (editor, recaps,
 *                history, "what each paid").
 *
 * Named as a MODE rather than a boolean because the other option is already
 * written down: option 1 prints per-company named sections with subtotals. It
 * is a third mode and one more branch in `clientFacingInvoiceLines`, not a
 * rewrite of the renderers. What a SENT document showed is locked at send, so
 * this only ever decides what a not-yet-sent invoice looks like.
 *
 * THIS FILE rather than `invoice-email.js` for the reason `resolveInvoiceRecipients`
 * moved to its own module: the PRINT sheet in the browser has to ask the same
 * code the PDF and the email ask, and it must not drag the email's brand markup
 * into the client bundle to do it. It sits beside `renderedInvoiceLines`
 * because it is the next layer on exactly that rule — which line PRINTS.
 *
 * It is NOT a second money calculator and must never become one: it restates
 * `invoice.total`, a figure already computed elsewhere, and does no arithmetic
 * of its own.
 */
export const INVOICE_RENDER_MODES = Object.freeze(['standard', 'combined'])

/**
 * The mode this client's document renders in. A billing master defaults to
 * 'combined' — that is the answer, and a master that has never been given an
 * explicit setting must not fall back to printing its subs' names.
 */
export function invoiceRenderMode(client) {
  if (!client?.isBillingMaster) return 'standard'
  const mode = String(client?.invoiceRenderMode ?? '').trim()
  return INVOICE_RENDER_MODES.includes(mode) ? mode : 'combined'
}

/**
 * The mode THIS DOCUMENT renders in — the client's setting, minus the documents
 * the setting must not reach.
 *
 * A RETAINER INVOICE is exempt and always standard. It is an engagement-level
 * document with one line reading "Retainer", issued when a client signs; run
 * through the combined branch it would print "Bookkeeping services — August
 * 2026" for money that is not a month's bookkeeping. Retainers stay per-sub in
 * v1 anyway (see docs/plans/consolidated-billing-2026-08.md), so a master
 * should never have one — this is the guard for when one turns up regardless.
 *
 * Separate from `invoiceRenderMode` rather than folded into it because the two
 * answer different questions: that one is the CLIENT's setting, this is what a
 * given document does with it. Renderers want this one.
 */
export function invoiceDocumentRenderMode(invoice, client) {
  if (invoice?.kind === 'retainer') return 'standard'
  return invoiceRenderMode(client)
}

/**
 * The combined line's wording, in ONE place — same discipline as
 * CARD_PAYMENT_COPY, and for a stronger reason: this single sentence is the
 * ENTIRE description a client reads on a four-company invoice, and the print
 * sheet, the PDF and the email have to say it identically.
 */
/**
 * The detailed-hours appendix heading — "page 2".
 *
 * It lives HERE, not in invoice-email.js, because all three renderers need it
 * and this is the module the browser bundle already imports. Pulling
 * invoice-email.js into `src/` would drag the email markup into the bundle,
 * reversing the split that moved `resolveInvoiceRecipients` out to
 * lib/invoice-recipients.js — and that module has no .d.ts, so `tsc -b`
 * would fail on it besides.
 *
 * It is not a section title: `time_detail` is deliberately excluded from
 * {@link invoiceSections}, so it cannot ride on a section object.
 */
export const DETAIL_SECTION_TITLE = 'Detailed Hours'

/**
 * The last line of a client-facing document when the client has no
 * `footerNote` of her own — her wording, verbatim. ONE constant so the PDF,
 * the email's `quoteAlt` (the exact sentence rendered inside
 * `brittany-quote.png`) and the print sheet cannot drift into three
 * different sentences.
 */
export const INVOICE_FOOTER_DEFAULT =
  'Spread success, not stress, thanks for choosing PB&J Strategic Accounting.'

export const COMBINED_INVOICE_COPY = {
  label: (periodLabel) =>
    periodLabel ? `Bookkeeping services — ${periodLabel}` : 'Bookkeeping services',
}

/**
 * The line kinds a COMBINED document still prints beside its one line.
 *
 * The combined branch suppresses lines that describe the WORK, because on a
 * master those name the sub companies. These two describe the CHARGE instead,
 * and suppressing them would leave a client unable to reconcile what they were
 * asked to pay:
 *
 *   'card-fee'        — the webhook appends this after a card payment and it is
 *                       inside `invoice.total`. Without it the receipt PDF shows
 *                       one line at the fee-inclusive total and never says a fee
 *                       was charged, which is exactly what the emailed wording
 *                       promises it will say.
 *   'retainer_credit' — money already on account, given back. Without it the
 *                       client sees a smaller number than the work and no reason
 *                       for it. It is also the only line that can be negative.
 *   'account_credit'  — the same thing for credit on account (a prepayment or an
 *                       overpayment), drawn down on this invoice. Negative too.
 *
 * None names a sub company: all come from shared label constants and carry no
 * company-specific detail (an account credit's `draws` name credits, never
 * companies, and are not printed). Adding a kind here means proving that too.
 */
export const COMBINED_KEPT_KINDS = new Set(['card-fee', 'retainer_credit', 'account_credit'])

/**
 * The lines the CLIENT actually reads, for this client's rendering mode.
 *
 * In 'combined' mode the stored lines are replaced wholesale by one line
 * carrying the invoice total. Not filtered, not relabeled — REPLACED, because
 * the thing being suppressed is not only the company names in the labels: a
 * recurring reimbursement line's coverage window ("covers Sep 1 – Sep 30") also
 * describes one company's specific charge, and so does every hours line's
 * detail. The only way to be sure nothing sub-specific reaches the page is for
 * nothing sub-specific to be on it.
 *
 * TWO KINDS OF LINE SURVIVE THE MERGE, because they explain the number rather
 * than describe the work — see COMBINED_KEPT_KINDS. Everything else goes.
 *
 * WHICH MEANS THE COMBINED BRANCH REQUIRES `kind` ON THE LINES IT IS HANDED,
 * and note that this is a STRONGER requirement than `renderedInvoiceLines`
 * above, which tolerates kind-less lines by design. Hand this display-mapped
 * lines of label/detail/amount and nothing errors: `kept` matches nothing, and
 * the card fee is silently folded back into one line printed at the
 * fee-inclusive total — the exact bug this function exists to prevent, wearing
 * the fix as a disguise. That is not hypothetical; the in-app print sheet
 * mapped `kind` off before calling here and reproduced it one layer up
 * (2026-08-28). Callers pass STORED lines, or they carry `kind` through.
 *
 * The money is untouched: the combined line plus whatever was kept sums to
 * `invoice.total` exactly, which is the figure the totals block states.
 */
export function clientFacingInvoiceLines(invoice, client) {
  // A $0 plan line and an hours row with no hours are left off the client's copy
  // (see `isEmptyPlanLine`, `isEmptyHoursLine`), so a section or a role heading
  // with nothing in it does not print. In combined mode they were never going to
  // survive the merge below, which keeps only COMBINED_KEPT_KINDS.
  const rendered = withoutEmptyLines(renderedInvoiceLines(invoice?.lineItems))
  if (invoiceDocumentRenderMode(invoice, client) !== 'combined') return rendered

  // Kept in their stored order, after the combined line — where they already
  // read on an ordinary invoice: a credit under the services, a card fee last.
  const kept = rendered.filter((line) => COMBINED_KEPT_KINDS.has(line?.kind))
  const keptTotal = kept.reduce((sum, line) => sum + (Number(line?.amount) || 0), 0)
  const period = String(invoice?.period ?? '')
  return [
    {
      kind: 'combined',
      label: COMBINED_INVOICE_COPY.label(
        /^\d{4}-\d{2}$/.test(period) ? getBillingPeriodLabel(period) : '',
      ),
      detail: '',
      // The total LESS what is stated separately below it, so the column adds up
      // to the amount due. Rounded where every other line in this file rounds.
      amount: Math.round(((Number(invoice?.total) || 0) - keptTotal) * 100) / 100,
    },
    ...kept,
  ]
}

/**
 * The invoice's THREE SECTIONS, as the client reads them (featreq-97ae3214).
 *
 * ── FEED THIS THE RESOLVED LINES, NEVER `invoice.lineItems` ──────────────
 *
 * The input must be the output of {@link clientFacingInvoiceLines}. Grouping
 * STORED lines and applying the render mode afterwards re-opens the leak that
 * shipped as a blocker on 2026-08-28: on a billing master's invoice the sub
 * company names live in labels, their coverage windows in details, and every
 * merged line carries `sourceClientId`. Combined mode exists to replace all
 * of that with one line; a section layer upstream of it would print the very
 * breakdown the client chose not to see. Downstream, there is nothing left to
 * leak.
 *
 * Money is READ, never recomputed: a section total is the sum of its own rows'
 * amounts, so the three totals add up to what the per-person lines have always
 * billed. That is the constraint Alex attached to this feature.
 *
 * @param {Array} lines resolved client-facing lines
 * @param {{combined?: boolean}} [opts] pass the render mode's verdict
 * @returns {Array<{key: string, title: string|null, totalLabel: string|null,
 *   rows: Array, total: number|null, groups: Array<{key: string,
 *   title: string|null, rows: Array}>|null}>}
 */
export function invoiceSections(lines, { combined = false } = {}) {
  const rows = Array.isArray(lines) ? lines.filter(Boolean) : []

  // A master's document has one line that belongs to none of her three names,
  // and per-section totals there would expose the split the client chose to
  // hide — the same reason the Subtotal row is suppressed in this mode.
  if (combined) {
    return rows.length
      ? [{ key: 'combined', title: null, totalLabel: null, rows, total: null, groups: null }]
      : []
  }

  const of = (kinds) => rows.filter((line) => kinds.has(line?.kind))
  const hasMoney = (line) => Math.round((Number(line?.amount) || 0) * 100) !== 0
  const sum = (list) =>
    Math.round(list.reduce((t, line) => t + Math.round((Number(line?.amount) || 0) * 100), 0)) / 100

  const planKinds = new Set(['plan'])
  const workKinds = new Set(['hourly', 'adhoc'])
  const expenseKinds = new Set(REIMBURSED_LINE_KINDS)

  const planRows = of(planKinds)
  // A `time_detail` row is informational and belongs on the appendix — but
  // ONLY if it carries no money. The $0.00 invariant is enforced by the
  // GENERATOR (`timeBreakdownLines`), not by the store, and production has a
  // sent invoice (INV-2026-08-044) whose entire $256.25 sits on three
  // hand-built time_detail lines labeled with role names. Moving those to an
  // appendix would render a real invoice with an empty body over a live total.
  // So: money means it is a charge, and a charge stays in the body.
  const workRows = rows
    .filter((line) => workKinds.has(line?.kind))
    .concat(rows.filter((line) => line?.kind === 'time_detail' && hasMoney(line)))
  // A recurring line the generator stamped `section: 'software'` prints in its
  // own Software section (featreq-a69a3cc0). Only a recurring line can: a stray
  // `section` on any other kind is ignored, so the one-off reimbursements and
  // every other kind land exactly where they always did.
  const isSoftware = (line) => line?.kind === 'recurring' && line?.section === 'software'
  const softwareRows = rows.filter(isSoftware)
  const expenseRows = of(expenseKinds).filter((line) => !isSoftware(line))
  // THE RESIDUAL BUCKET, not an allowlist: everything not already claimed by
  // plan/work/expenses above, MINUS a zero-amount `time_detail` row (that is
  // page 2, excluded on purpose — see the comment above). A line whose kind is
  // in none of the named sets — `combined` handed to this in the wrong mode, a
  // kind added to INVOICE_LINE_KINDS later, or no kind at all — still carries
  // money, and dropping it would print a smaller total than `invoice.total`
  // states. See the section-coverage test below: every kind, plus a kind-less
  // line, must land in exactly one section.
  const chargeRows = rows.filter(
    (line) =>
      !planKinds.has(line?.kind) &&
      !workKinds.has(line?.kind) &&
      !expenseKinds.has(line?.kind) &&
      line?.kind !== 'time_detail',
  )

  const out = []
  if (planRows.length) {
    out.push({
      key: 'plan',
      title: 'Subscription Plan',
      totalLabel: 'Total Subscription Plan',
      rows: planRows,
      total: sum(planRows),
      groups: null,
    })
  }
  if (workRows.length) {
    out.push({
      key: 'work',
      title: 'Ad-Hoc / Billable Hours',
      totalLabel: 'Total Ad-Hoc/Billable Hours',
      rows: workRows,
      total: sum(workRows),
      groups: roleGroups(workRows),
    })
  }
  if (expenseRows.length) {
    out.push({
      key: 'expenses',
      title: 'Client Reimbursed Expenses',
      totalLabel: 'Total Client Reimbursed Expenses',
      rows: expenseRows,
      total: sum(expenseRows),
      groups: null,
    })
  }
  if (softwareRows.length) {
    out.push({
      key: 'software',
      title: 'Software',
      totalLabel: 'Total Software',
      rows: softwareRows,
      total: sum(softwareRows),
      groups: null,
    })
  }
  if (chargeRows.length) {
    out.push({
      key: 'charges',
      title: null,
      totalLabel: null,
      rows: chargeRows,
      total: null,
      groups: null,
    })
  }
  return out
}

/** Tier -> the heading she wrote on the marked-up invoice. */
const ROLE_GROUP_TITLES = Object.freeze({
  CFO: 'CFO / Advisory Services',
  Accountant: 'Accounting Services',
  Bookkeeper: 'Bookkeeping Services',
  Other: 'Other Services',
})
/** Fixed print order — the tiers never reshuffle month to month. */
const ROLE_GROUP_ORDER = Object.freeze(['CFO', 'Accountant', 'Bookkeeper', 'Other'])

/**
 * The hours section's role sub-groups, in fixed order.
 *
 * Rows with no `roleTier` — legacy invoices, the pre-cutover single line, a
 * row the owner typed herself — come FIRST and untitled. Never under a guessed
 * heading, never dropped: an unrecognized row still has to print, because it
 * still has money on it.
 */
function roleGroups(workRows) {
  // `.includes` on the fixed ORDER array, never a bracket lookup on the titles
  // object: a roleTier of 'constructor' (or any other Object.prototype key)
  // is truthy through `ROLE_GROUP_TITLES[line.roleTier]`, which used to land
  // the row in neither bucket and drop it from the rendered rows while its
  // money stayed inside section.total.
  const untitled = workRows.filter((line) => !ROLE_GROUP_ORDER.includes(line?.roleTier))
  const groups = untitled.length
    ? [{ key: 'ungrouped', title: null, rows: untitled }]
    : []
  for (const tier of ROLE_GROUP_ORDER) {
    const rows = workRows.filter((line) => line?.roleTier === tier)
    if (rows.length) groups.push({ key: tier, title: ROLE_GROUP_TITLES[tier], rows })
  }
  return groups
}

/**
 * The three role rows the month-run editor always offers in its hours block, in
 * print order, with the headings the client's copy already uses (the SAME
 * `ROLE_GROUP_TITLES`, never a second spelling). `Other` is not offered as a
 * row: it is what a person with no recognized role bills under, not a role she
 * fills by hand.
 */
export const INVOICE_HOURS_ROLE_ROWS = Object.freeze(
  ROLE_GROUP_ORDER.filter((tier) => tier !== 'Other').map((tier) =>
    Object.freeze({ tier, title: ROLE_GROUP_TITLES[tier] }),
  ),
)

/**
 * What a person's hours line is called.
 *
 * The role's title ("Accounting Services") for CFO, Accountant and Bookkeeper —
 * the heading she writes by hand on the marked-up invoice, instead of a staff
 * member's name on a client's bill. When another person in the SAME role holds a
 * line on the invoice (`shared`), the name is appended so two rows never share a
 * label ("Accounting Services — Allison Lehmann"). Anyone whose role is not one
 * of the three (`Other`), and a line with no employee record, keep
 * "Billable hours — <name>": there is no title to say instead.
 */
export function hoursLineLabel(employee, { shared = false } = {}) {
  const name = employee?.name ?? 'Unknown'
  const tier = employee ? recapStaffTier(employee.role) : null
  const title = tier && tier !== 'Other' ? ROLE_GROUP_TITLES[tier] : null
  if (!title) return `Billable hours — ${name}`
  return shared ? `${title} — ${name}` : title
}

/**
 * The labels that identify a person's hours line when it carries no
 * `employeeId`: the old "Billable hours — <name>" and "<Role title> — <name>".
 * What the hours panel's re-tag falls back on for a draft generated before the
 * stamp existed. EVERY shape carries the person's name. A BARE role title is
 * deliberately not one: a line with no `employeeId` and a bare title is a row she
 * typed by hand, and a re-tag must leave it alone (a Generate line with a bare
 * title always carries its `employeeId` and is found by that).
 */
export function hoursLineLabelShapes(employee) {
  const name = employee?.name ?? 'Unknown'
  const old = `Billable hours — ${name}`
  const tier = employee ? recapStaffTier(employee.role) : null
  const title = tier && tier !== 'Other' ? ROLE_GROUP_TITLES[tier] : null
  return title ? { old, titled: [`${title} — ${name}`], tier } : { old, titled: [], tier }
}

/**
 * The rate a NEW hours row for `tier` starts at — a default she can overtype.
 *
 *   1. the rate of an hours line already on this invoice in that tier;
 *   2. else the staff rate for that tier at the client's rate month
 *      (`billRateAt`, the same chain Generate prices with). When two people in
 *      the tier bill at different rates the first by name wins — a default, not
 *      a rule, and the rate box is right there;
 *   3. else the client's own `hourlyRate`;
 *   4. else 0.
 */
export function defaultHoursRowRate({
  tier,
  lines = [],
  employees = [],
  billRateVersions = [],
  client = null,
  period = '',
}) {
  const sibling = (Array.isArray(lines) ? lines : []).find(
    (line) =>
      line?.kind === 'hourly' &&
      line.roleTier === tier &&
      typeof line.rate === 'number' &&
      Number.isFinite(line.rate),
  )
  if (sibling) return sibling.rate

  const ratePeriod = ratePeriodAsOf(client, period || null)
  const staff = (Array.isArray(employees) ? employees : [])
    .filter((employee) => employee && !employee.inactiveAt && recapStaffTier(employee.role) === tier)
    .slice()
    .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')))
  for (const employee of staff) {
    const rate = billRateAt(billRateVersions, employee, ratePeriod, period || null)
    if (rate !== null) return rate
  }

  const fallback = Number(client?.hourlyRate)
  return Number.isFinite(fallback) && fallback >= 0 ? fallback : 0
}

/**
 * The detailed-hours appendix — her "detailed hours as page 2".
 *
 * Safe to move anywhere on the document because of the breakdown's invariant:
 * every `time_detail` line is $0.00 (see {@link timeBreakdownLines}), so
 * lifting the block out of the table cannot move a total. Empty when the
 * client's breakdown is off (the default), and empty in combined mode because
 * `time_detail` is not kept there — so a master's page 2 is suppressed rather
 * than printed blank.
 */
export function invoiceDetailRows(lines) {
  const rows = Array.isArray(lines) ? lines.filter(Boolean) : []
  // Zero-amount only — see the note in `invoiceSections`. A time_detail row
  // carrying money is a charge that happens to be mislabeled, and it prints in
  // the body with the rest of the money rather than on an appendix.
  return rows.filter(
    (line) => line?.kind === 'time_detail' && Math.round((Number(line?.amount) || 0) * 100) === 0,
  )
}

/**
 * Does a recurring reimbursement's cadence land on this period? Counts whole
 * months from `startDate`, so a quarterly item starting in January bills in
 * January, April, July, October — and never before it starts.
 */
export function recurringReimbursementAppliesToPeriod(recurring, period) {
  if (!recurring?.startDate) return false
  const periodYear = Number(String(period).slice(0, 4))
  const periodMonth = Number(String(period).slice(5, 7))
  const startYear = Number(String(recurring.startDate).slice(0, 4))
  const startMonth = Number(String(recurring.startDate).slice(5, 7))
  if (
    !Number.isFinite(periodYear) ||
    !Number.isFinite(periodMonth) ||
    !Number.isFinite(startYear) ||
    !Number.isFinite(startMonth)
  ) {
    return false
  }
  const periodKey = periodYear * 12 + periodMonth
  const startKey = startYear * 12 + startMonth
  if (periodKey < startKey) return false
  const monthsSinceStart = periodKey - startKey
  if (recurring.frequency === 'monthly') return true
  if (recurring.frequency === 'quarterly') return monthsSinceStart % 3 === 0
  if (recurring.frequency === 'annually') return monthsSinceStart % 12 === 0
  return false
}

/**
 * Build the invoice lines for one client + billing period.
 *
 * AD HOC time (`entry.isAdhoc`) separates out on HOURLY clients from the
 * per-employee cutover onward — see the partition below. Flat-fee clients
 * (subscription / annual) are untouched: their billable hours are already
 * covered by the fee and surface as a scope flag rather than a charge, so
 * turning ad hoc time into a charge there is a pricing decision the owner has
 * not made. Their flagged entries stay flagged and simply do not bill.
 *
 * @returns {{
 *   lines: Array<{label: string, detail?: string, amount: number}>,
 *   total: number,
 *   billableMinutes: number,
 *   entryCount: number,
 *   plan: object|null,
 *   periodLabel: string,
 * }}
 */
export function buildInvoiceLines({
  client,
  entries = [],
  plans = [],
  billingPeriod,
  reimbursements = [],
  recurringReimbursements = [],
  employees = [],
  defaultHourlyRate = 0,
  billRateVersions = [],
  ratePeriod = null,
}) {
  const billableEntries = entries.filter(
    (entry) =>
      entry.clientId === client.id && entry.billable && isInBillingPeriod(entry, billingPeriod),
  )
  // Every billable minute of the month, ad hoc INCLUDED — this answers "how
  // much billable work was there", which is a different question from what any
  // one line covers. Deliberately computed before the ad hoc partition below,
  // so it does not match the per-person hours lines on a client with
  // ad hoc time. Display only; no money is derived from it.
  const billableMinutes = billableEntries.reduce((total, entry) => total + entry.minutes, 0)

  // Subscribed plans/services are labels only — the amount comes from the
  // client's own rate. `plan` keeps the first match for back-compat.
  const planIds = Array.isArray(client.planIds) ? client.planIds : []
  const subscribedPlans = planIds
    .map((id) => plans.find((item) => item.id === id))
    .filter(Boolean)
  const plan = subscribedPlans[0] ?? null
  const periodLabel = getBillingPeriodLabel(billingPeriod)

  const reimbursementLines = reimbursements
    .filter(
      (reimbursement) =>
        reimbursement.clientId === client.id &&
        String(reimbursement.date ?? '').startsWith(billingPeriod),
    )
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map((reimbursement) => ({
      kind: 'reimbursement',
      label: `Reimbursement: ${reimbursement.description}`,
      detail: new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }).format(new Date(`${reimbursement.date}T12:00:00`)),
      amount: reimbursement.amount,
    }))

  // Synthesized per period — no row is stored. Stopping it means deleting the
  // recurring record.
  //
  // A PAUSED expense bills nothing at all. That is what makes the pause worth
  // having, and it is also what creates the gap the resolver later asks her to
  // confirm: the months it sat out are months the window did not move.
  const recurringLines = recurringReimbursements
    .filter(
      (recurring) =>
        recurring.clientId === client.id &&
        !recurring.coveragePaused &&
        recurringReimbursementAppliesToPeriod(recurring, billingPeriod),
    )
    .map((recurring) => {
      const isSoftwareLine = recurring.category === 'software'
      const base = {
        kind: 'recurring',
        // A software line prints under its own "Software" heading, so the
        // plan's name stands alone; an expense keeps its "Recurring:" label.
        label: isSoftwareLine ? recurring.description : `Recurring: ${recurring.description}`,
        detail: recurring.frequency,
        amount: recurring.amount,
        ...(isSoftwareLine ? { section: 'software' } : {}),
      }
      // No covered-date wording configured: exactly the line this has always
      // produced. The feature is opt-in per expense.
      const coverage = resolveCoverageForPeriod(recurring, billingPeriod)
      if (!coverage) return base
      const label = coverageLineLabel(recurring, coverage)
      return {
        ...base,
        ...(label ? { label } : {}),
        // The id is what lets a confirmation find its way back to the expense's
        // ledger — matching on the label would break the moment she edits the
        // wording, which is the one thing this line is built to let her do.
        recurringId: recurring.id,
        coverageStart: coverage.start,
        coverageEnd: coverage.end,
        needsCoverageConfirmation: coverage.needsConfirmation,
        ...(coverage.reason ? { coverageReason: coverage.reason } : {}),
      }
    })

  // `summed` is the order the total is ADDED in, when that differs from the
  // order the lines are shown in. Float addition is not associative, so a total
  // summed in a new display order could land a hair away from the one this has
  // always produced; the hours lines are summed in their old (by-name) order and
  // shown in their new (by-role) one, and the total is bit-for-bit what it was.
  const done = (lines, summed = lines) => ({
    lines,
    total: summed.reduce((total, line) => total + line.amount, 0),
    billableMinutes,
    entryCount: billableEntries.length,
    plan,
    periodLabel,
  })

  // Hoisted out of the hourly branch: the optional time breakdown belongs on a
  // subscription invoice too — that is the case Brittany actually asked for
  // ("the subscription line and price ... and then for the clients I choose I
  // can click the time breakdown") — and it needs the same per-employee rate to
  // say what an hour was worth.
  const employeeById = new Map(employees.map((employee) => [employee.id, employee]))
  /**
   * WHAT ONE HOUR OF THIS PERSON'S TIME BILLS AT, for THIS client.
   *
   * The shared chain in `billRateAt` (lib/rate-history.js), then the client's
   * own `defaultHourlyRate`:
   *
   *   1. the person's bill rate AS IT STOOD in the client's pinned month
   *      (`ratePeriod`). This is what lets a new client start on higher rates
   *      while an existing one stays where it is until her yearly review
   *      moves it.
   *   2. else the person's FIRST version, once it has started — never their
   *      live `billRate`, which mirrors the NEWEST version, future raises
   *      included.
   *   3. else, only for someone with no versions at all (every caller that
   *      passes none, and every older test), the live `billRate`.
   *   4. the client's own `defaultHourlyRate` — the firm default, the meaning
   *      "no rate on file" has always carried here.
   *
   * `ratePeriod ?? billingPeriod` is what makes an UNPINNED client price at
   * today's rates, exactly as it did before any of this existed.
   */
  const rateFor = (employeeId) =>
    billRateAt(
      billRateVersions,
      employeeById.get(employeeId) ?? { id: employeeId },
      ratePeriod,
      billingPeriod,
    ) ?? defaultHourlyRate

  const breakdownMode = normalizeTimeBreakdownMode(client.invoiceTimeBreakdownMode)
  const breakdownAmounts = client.invoiceTimeBreakdownAmounts === true
  /**
   * The breakdown block for a given set of entries. Always `amount: 0` lines —
   * see `timeBreakdownLines`. Adding this to an invoice cannot change its total,
   * which is what makes it safe to hand a per-client switch to the owner.
   */
  const breakdownFor = (forEntries) =>
    timeBreakdownLines({
      entries: forEntries,
      employees,
      mode: breakdownMode,
      showAmounts: breakdownAmounts,
      rateFor,
    })

  if (client.billingMode === 'annual') {
    // A flat yearly fee billed ONCE, in the client's chosen month. Every other
    // month shows no service line — just whatever reimbursements landed.
    const annualRate =
      typeof client.annualRate === 'number' && !Number.isNaN(client.annualRate)
        ? client.annualRate
        : 0
    const billingMonth = normalizeBillingMonth(client.annualBillingMonth)
    const periodMonth = Number(String(billingPeriod).slice(5, 7))
    const lines = []
    // A $0 fee still gets its line: it is what keeps the client from being
    // skipped as "nothing to bill" and what the owner types an amount onto. It
    // is left off the CLIENT's copy by `clientFacingInvoiceLines`.
    if (periodMonth === billingMonth) {
      lines.push({
        kind: 'plan',
        label: serviceLabel(client, subscribedPlans, 'Annual service'),
        detail: `Annual fee · billed in ${MONTH_NAMES[billingMonth]}`,
        amount: annualRate,
      })
    }
    lines.push(...breakdownFor(billableEntries), ...reimbursementLines, ...recurringLines)
    return done(lines)
  }

  if (client.billingMode === 'subscription') {
    // The client's own monthlyRate is the line amount. No included-hours or
    // overage math exists any more.
    const monthlyRate =
      typeof client.monthlyRate === 'number' && !Number.isNaN(client.monthlyRate)
        ? client.monthlyRate
        : 0
    const lines = [
      // Emitted even at a rate of 0: the line is what keeps a client whose rate
      // was left blank from being skipped as "nothing to bill", and what the
      // owner types an amount onto in the editor. A $0 plan line is left off
      // the CLIENT's copy by `clientFacingInvoiceLines` (featreq-87b20ed7).
      {
        kind: 'plan',
        label: serviceLabel(client, subscribedPlans, 'Monthly service'),
        detail: 'Monthly service',
        amount: monthlyRate,
      },
      // Every entry the month tracked, ad hoc included: on a subscription
      // invoice nothing here is a charge, so there is no partition to respect —
      // it is simply what the fee bought.
      ...breakdownFor(billableEntries),
      ...reimbursementLines,
      ...recurringLines,
    ]
    return done(lines)
  }

  // Hourly, with the cutover described on PER_EMPLOYEE_BILLING_START.
  let employeeLines
  // The same lines in the order the total has always been added in.
  let employeeLinesForTotal
  let adhocLines = []
  let breakdownLines = []
  if (billingPeriod >= PER_EMPLOYEE_BILLING_START) {
    // THE PARTITION. This is the one place a billable entry is sorted into a
    // billing path, and the two sides are disjoint by construction: ad hoc time
    // becomes its own per-entry line and is gone from the per-person hours
    // totals below. An entry is billed once, through whichever side its
    // flag puts it on — never twice, never neither.
    const scopedEntries = billableEntries.filter((entry) => !entry.isAdhoc)
    const adhocEntries = billableEntries.filter((entry) => Boolean(entry.isAdhoc))

    // One line per piece of ad hoc work, at that employee's own rate — the same
    // rate their scoped hours bill at. Oldest first, so the group reads as a
    // little diary of the out-of-scope requests. Every line starts on 'billed';
    // the owner changes that per line in the month run.
    adhocLines = adhocEntries
      .slice()
      .sort(
        (a, b) =>
          String(a.date ?? '').localeCompare(String(b.date ?? '')) ||
          String(a.description ?? '').localeCompare(String(b.description ?? '')),
      )
      .map((entry) => {
        const rate = rateFor(entry.employeeId)
        // Priced off the SAME 2dp hours the detail prints — this used to charge
        // raw clock minutes under a detail reading "0.05h", which is the "math
        // is not mathing" she caught on the recap.
        const hours = displayHours(entry.minutes)
        const amount = roundToCent(hours * rate)
        const when = adhocDateLabel(entry.date)
        const employee = employeeById.get(entry.employeeId)
        const who = employee?.name ?? 'Unknown'
        return {
          kind: 'adhoc',
          label: `Adhoc — ${String(entry.description ?? '').trim() || 'One-off work'}`,
          detail: `${when} · ${who} · ${formatDecimalHours(entry.minutes)} at ${currency.format(rate)}/hr`,
          amount,
          adhocMode: 'billed',
          adhocAmount: amount,
          // WHICH PIECE OF TIME THIS LINE IS. Stamped so the invoicing-side
          // scope panel can take the line back off when she re-tags that entry
          // as in-scope or out-of-scope — matching on the label would break the
          // moment she retypes it, which is the one thing the label is hers to
          // do. Carried through `sanitizeInvoiceLines` for the same reason
          // `sourceClientId` is: that sanitizer drops what it does not name.
          entryId: entry.id,
          // Which section of the redesigned invoice this row prints under.
          // PRESENTATIONAL ONLY — no amount, hours or rate is derived from it.
          // Stamped only when the employee record still exists: a MISSING
          // employee means the tier is unknown, not "Other" — Other is for a
          // real employee whose role this build does not recognize.
          ...(employee ? { roleTier: recapStaffTier(employee.role) } : {}),
        }
      })

    // Each person's ROW minutes, kept — the billed hours are the sum of the
    // rows' two-decimal hours (the same figure the recap's roles table and the
    // payroll report print), never a re-rounding of the raw total. Pricing raw
    // clock time under printed 2dp hours is the defect she reopened the recap
    // for: her own screenshot's client read 1.3h and 0.05h that multiply to
    // $103.75 over a revenue line of $103.54.
    const rowsByEmployee = new Map()
    for (const entry of scopedEntries) {
      const rows = rowsByEmployee.get(entry.employeeId)
      if (rows) rows.push(entry.minutes)
      else rowsByEmployee.set(entry.employeeId, [entry.minutes])
    }
    // How many people hold an hours line in each role on THIS invoice. Two in one
    // role means a bare role title would label both lines the same, so each gets
    // its name appended (`hoursLineLabel`).
    const peopleInTier = new Map()
    for (const employeeId of rowsByEmployee.keys()) {
      const employee = employeeById.get(employeeId)
      if (!employee) continue
      const tier = recapStaffTier(employee.role)
      peopleInTier.set(tier, (peopleInTier.get(tier) ?? 0) + 1)
    }
    const personLines = Array.from(rowsByEmployee.entries()).map(([employeeId, rowMinutes]) => {
      const employee = employeeById.get(employeeId)
      const rate = rateFor(employeeId)
      const hours = periodDisplayHours(rowMinutes)
      const tier = employee ? recapStaffTier(employee.role) : null
      return {
        name: employee?.name ?? 'Unknown',
        tier,
        line: {
          kind: 'hourly',
          label: hoursLineLabel(employee, { shared: (peopleInTier.get(tier) ?? 0) >= 2 }),
          detail: hourlyLineDetail(hours, rate),
          // HOURS AND RATE RIDE THE LINE (her ask: "the hours seperate so if I
          // want to round more I can and then the amount just auto calculates").
          // The editor renders hours as their own field and derives the amount;
          // the server re-derives it again on save, so the three can never
          // disagree. Hand math works by construction: hours × rate = amount.
          hours,
          rate,
          amount: periodMoney(rowMinutes, rate) ?? 0,
          // WHOSE HOURS THIS LINE HOLDS. The label is hers to retype (she renames
          // a line "CFO/Advisory Services" and sets its rate), and the hours
          // panel's re-tag then finds the line by this rather than by a label
          // that no longer says anything. Never printed: the PDF, the email, the
          // print sheet and the QuickBooks export all write label and detail.
          ...(employeeId ? { employeeId } : {}),
          // Which role group this row prints under on the redesigned invoice.
          // PRESENTATIONAL ONLY: the money above is untouched by it, and a line
          // without it renders ungrouped rather than under a guessed heading —
          // which is exactly what the legacy pre-cutover branch below relies on.
          // Stamped only when the employee record still exists — see the adhoc
          // line above for why a missing record must not read as "Other".
          ...(employee ? { roleTier: tier } : {}),
        },
      }
    })
    // Shown by role (CFO, Accountant, Bookkeeper, Other, then a person with no
    // record), then by name; ADDED UP in the order it always was — by the old
    // "Billable hours — <name>" label, i.e. by name — so the total cannot move.
    const tierRank = (tier) => {
      const at = ROLE_GROUP_ORDER.indexOf(tier)
      return at === -1 ? ROLE_GROUP_ORDER.length : at
    }
    employeeLines = personLines
      .slice()
      .sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || a.name.localeCompare(b.name))
      .map((person) => person.line)
    employeeLinesForTotal = personLines
      .slice()
      .sort((a, b) =>
        `Billable hours — ${a.name}`.localeCompare(`Billable hours — ${b.name}`),
      )
      .map((person) => person.line)

    /**
     * THE BREAKDOWN ON AN HOURLY INVOICE, and why 'person' adds nothing here.
     *
     * An hourly client's charge lines ARE the per-person view — one hours line
     * each (titled by role, `hoursLineLabel`), with the hours and the money. Adding
     * an informational copy of the same thing would print every name twice and
     * read as a double bill.
     *
     * So 'person' is deliberately a no-op on this branch, and day / week / entry
     * add the detail that genuinely is not on the invoice yet. Nothing about the
     * hourly charge lines changes in any mode: Brittany's "I just want the
     * subscription line and price" describes a SUBSCRIPTION invoice, and an
     * hourly client has no such line to fall back to.
     *
     * Scoped entries only — the ad hoc block below already lists each piece of
     * out-of-scope work with its own billing decision.
     */
    breakdownLines = breakdownMode === 'person' ? [] : breakdownFor(scopedEntries)
  } else {
    // Legacy: one line at the client's own stored rate — the exact shape
    // historical invoices were sent in. Ad hoc is deliberately NOT separated
    // here: no pre-cutover entry carries the flag, and the promise this branch
    // exists to keep is that an already-sent number never moves. Flagging an
    // old entry ad hoc leaves it inside this aggregate, billed once, as before.
    employeeLines = [
      {
        kind: 'hourly',
        label: 'Billable hours',
        detail: `${formatDecimalHours(billableMinutes)} at ${currency.format(client.hourlyRate)}/hr`,
        amount: (billableMinutes / 60) * client.hourlyRate,
      },
    ]
    employeeLinesForTotal = employeeLines
  }

  const rest = [...breakdownLines, ...adhocLines, ...reimbursementLines, ...recurringLines]
  return done([...employeeLines, ...rest], [...employeeLinesForTotal, ...rest])
}

/**
 * "2026-08-04" -> "Aug 4, 2026", matching the reimbursement lines' date style.
 *
 * Exported for `lib/invoice-scope-retag.js`, which builds an ad hoc line for an
 * entry re-tagged from the invoicing side and must produce the SAME detail
 * string this does — a line that reads differently depending on where it was
 * created would be two formats for one thing.
 */
export function adhocDateLabel(date) {
  const parsed = new Date(`${String(date ?? '')}T12:00:00`)
  if (Number.isNaN(parsed.getTime())) return String(date ?? '')
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(parsed)
}

/* -------------------------------------------------------------------------- */
/* Card processing fee                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Stripe's US card pricing, as named constants so there is exactly ONE place to
 * change if Stripe moves its rates. 2.9% of the amount charged, plus 30 cents.
 */
export const STRIPE_CARD_PERCENT = 0.029
export const STRIPE_CARD_FIXED = 0.3

/**
 * The label the card fee carries everywhere it appears — the Checkout line, the
 * stored invoice line the webhook appends, the QBO export that reads that line.
 * Shared so the three can never drift into three different names for one charge.
 */
export const CARD_PROCESSING_FEE_LABEL = 'Card processing fee'

/**
 * The fee that must be ADDED to an invoice so the firm nets the invoice total
 * exactly when the client pays by card.
 *
 * This is a gross-up, not a markup. Charging `total × 2.9% + $0.30` would leave
 * the firm short, because Stripe takes its cut of the LARGER amount actually
 * charged. Solving `charged × (1 − 2.9%) − $0.30 = total` for `charged` is what
 * makes the firm whole.
 *
 * Computed in whole cents, because the thing being promised here is exactness:
 * a client's card statement and the invoice have to agree to the penny. Rounding
 * the gross-up to the nearest cent can land a fraction of a cent BELOW what nets
 * the total, so the result is verified and bumped by a cent when it falls short.
 * One bump is always enough (a cent of charge is 0.971 cents of net, and the
 * worst rounding-down loses under half a cent), but the loop is written as a
 * loop so that stays true if the rate ever changes.
 *
 * Never negative and never charged on a zero or credit invoice.
 */
export function cardProcessingFee(total) {
  const owedCents = Math.round((Number(total) || 0) * 100)
  if (!Number.isFinite(owedCents) || owedCents <= 0) return 0
  const fixedCents = Math.round(STRIPE_CARD_FIXED * 100)
  const keep = 1 - STRIPE_CARD_PERCENT

  let chargedCents = Math.round((owedCents + fixedCents) / keep)
  // The epsilon is float slack, not tolerance for netting less: the comparison
  // is on a product of floats, and a true equality must not read as short.
  while (chargedCents * keep - fixedCents < owedCents - 1e-9) chargedCents += 1

  return (chargedCents - owedCents) / 100
}

/** What the client's card is actually charged: the invoice total plus the fee. */
export function cardChargedTotal(total) {
  const owed = Number(total) || 0
  return Math.round((owed + cardProcessingFee(owed)) * 100) / 100
}

/**
 * The fee as an invoice LINE, for the webhook to append when a card payment
 * lands. Built here rather than at the call site so the line the client was
 * charged on the Checkout page and the line written onto the invoice of record
 * are the same number from the same function.
 */
export function cardProcessingFeeLine(invoice) {
  return {
    kind: 'card-fee',
    label: CARD_PROCESSING_FEE_LABEL,
    detail: 'Paid by card',
    amount: cardProcessingFee(invoice?.total),
  }
}

/* -------------------------------------------------------------------------- */
/* Retainers                                                                  */
/* -------------------------------------------------------------------------- */

/** What a retainer invoice's single line says. */
export const RETAINER_LABEL = 'Retainer'

/** What the credit says on the invoice it is applied to. */
export const RETAINER_CREDIT_LABEL = 'Retainer applied — credit'

/**
 * What a retainer is worth AGAINST a given set of lines — the one rule turning
 * "she has $2,500 on account" into money on an invoice.
 *
 * WHAT THIS GUARANTEES: the number it returns, added to the lines it was given,
 * cannot come out below zero. That is the whole of it, and it is enough for the
 * thing worth preventing — an invoice reading -$400 is a promise to pay a
 * client, which this app has no mechanism for and no business printing.
 *
 * WHAT IT DOES NOT COVER, so nobody reads more into it than is here:
 *   - It is a function of the lines it is HANDED. It is the caller's job to
 *     re-run it on every save (`_resolveRetainerCredit` does), because lines
 *     removed after a credit was sized would otherwise leave the credit larger
 *     than what remains.
 *   - It says nothing about lines added later by another path. The card
 *     processing fee the payment webhook appends is grossed up from the total
 *     AFTER the credit, which is correct, but it is a separate calculation and
 *     not one this floor is watching.
 *   - It does not return the unused remainder of a retainer that outsizes the
 *     invoice. Applying it settles the retainer in full and gives back less than
 *     it held; the difference is the owner's to hand back outside the app,
 *     deliberately, because refunding a client is not a thing a billing screen
 *     should do on its own.
 *
 * Returns a NEGATIVE number (or zero), because that is what it is on the line.
 *
 * `lines` may include an existing credit line; it is filtered out, so re-sizing
 * an already-credited invoice is idempotent rather than shrinking toward zero.
 */
export function retainerCreditAmount(lines, retainerAmount) {
  // A credit on account is sized AFTER the retainer, off what the retainer
  // leaves, so it is not part of what the retainer is measured against.
  const rest = (Array.isArray(lines) ? lines : [])
    .filter((line) => line?.kind !== 'retainer_credit' && line?.kind !== 'account_credit')
    .reduce((sum, line) => sum + (Number(line?.amount) || 0), 0)
  const held = Math.round((Number(retainerAmount) || 0) * 100) / 100
  // A negative or absent retainer holds nothing; an invoice already at or below
  // zero has nothing left to credit.
  if (held <= 0 || rest <= 0) return 0
  return -(Math.min(held, Math.round(rest * 100) / 100))
}

/**
 * The credit as an invoice LINE, built here rather than at the call sites so the
 * figure the owner sees on the Apply button, the figure the editor puts in the
 * table, and the figure the server stores are all the same function's answer.
 *
 * The retainer's id rides on the line: it is what lets the save know WHICH
 * retainer to mark applied, and what lets removing the line free that same one
 * again.
 */
export function retainerCreditLine({ lines, retainerAmount, retainerId, retainerNumber }) {
  return {
    kind: 'retainer_credit',
    label: RETAINER_CREDIT_LABEL,
    detail: retainerNumber ? `Retainer ${retainerNumber}` : 'Retainer held on account',
    amount: retainerCreditAmount(lines, retainerAmount),
    retainerInvoiceId: retainerId ?? null,
  }
}

/* -------------------------------------------------------------------------- */
/* Credit on account                                                          */
/* -------------------------------------------------------------------------- */

/** What a credit on account says on the invoice it is drawn on. */
export const ACCOUNT_CREDIT_LABEL = 'Credit on account'

/** A dollar amount as whole cents (NaN when it is not a number). Half-cents round up. */
export const accountCreditCents = (value) => Math.round(Number((Number(value) * 100).toPrecision(15)))

/**
 * The line's wording: "Credit on account", or "Credit on account - meant for
 * November 2026" when every credit it draws was recorded for that one month.
 */
export function accountCreditLabel(forPeriods) {
  const periods = new Set((Array.isArray(forPeriods) ? forPeriods : []).map((period) => period ?? null))
  const only = periods.size === 1 ? [...periods][0] : null
  return typeof only === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(only)
    ? `${ACCOUNT_CREDIT_LABEL} - meant for ${getBillingPeriodLabel(only)}`
    : ACCOUNT_CREDIT_LABEL
}

/**
 * What one credit still has to give, in cents, as far as ONE invoice is
 * concerned: its amount less what every OTHER invoice has drawn from it (the
 * invoice's own draws are what is being sized, so they do not count against it).
 * A void credit has nothing. `credit.draws` is the store's ledger view.
 */
export function accountCreditAvailableCents(credit, ownInvoiceId = null) {
  if (!credit || credit.voidedAt) return 0
  const others = (Array.isArray(credit.draws) ? credit.draws : []).reduce(
    (sum, draw) => (draw?.invoiceId === ownInvoiceId ? sum : sum + accountCreditCents(draw?.amount)),
    0,
  )
  return Math.max(0, accountCreditCents(credit.amount) - others)
}

/**
 * What an invoice can take from the client's credit: every line OTHER than a
 * credit on account (the retainer credit stays in, so the two credits can never
 * together push the total below zero), floored at zero, in cents.
 */
export function accountCreditWantedCents(lines) {
  const rest = (Array.isArray(lines) ? lines : [])
    .filter((line) => line?.kind !== 'account_credit')
    .reduce((sum, line) => sum + accountCreditCents(line?.amount || 0), 0)
  return Math.max(0, rest)
}

/**
 * The ONE rule that turns "this client has credit on account" into draws on an
 * invoice: the server sizes the line with it on every apply and every save, and
 * the editor never does (it asks the server), so the figure the owner sees is the
 * figure stored.
 *
 *   - never more than the invoice's pre-credit total (so the credit cannot push
 *     the total below zero), and never more than any one credit has left once
 *     every OTHER invoice's draws are counted;
 *   - with `existing` draws (a save of an invoice that already carries the line)
 *     it keeps those credits in that order and only SHRINKS them to fit;
 *   - with none (a fresh apply) it draws the credits meant for this invoice's own
 *     month first, then the oldest first.
 *
 * Returns `{ draws, totalCents, label, line }`; `line` is null when nothing can be
 * drawn. `credits` are the store's views (`draws: [{ invoiceId, amount }]`).
 */
export function planAccountCreditDraws({ lines, credits, invoiceId = null, period = '', existing = null }) {
  const pool = Array.isArray(credits) ? credits : []
  const byId = new Map(pool.map((credit) => [credit.id, credit]))
  let wanted = accountCreditWantedCents(lines)
  const drawn = new Map()
  const take = (credit, ask) => {
    const open = accountCreditAvailableCents(credit, invoiceId) - (drawn.get(credit.id) ?? 0)
    const cents = Math.min(ask, open, wanted)
    if (!(cents > 0)) return
    drawn.set(credit.id, (drawn.get(credit.id) ?? 0) + cents)
    wanted -= cents
  }
  if (Array.isArray(existing) && existing.length > 0) {
    for (const draw of existing) {
      const credit = byId.get(draw?.creditId)
      if (credit) take(credit, accountCreditCents(draw.amount))
    }
  } else {
    const rank = (credit) => (period && credit.forPeriod === period ? 0 : 1)
    const ordered = pool
      .filter((credit) => !credit.voidedAt)
      .sort(
        (a, b) =>
          rank(a) - rank(b) ||
          String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')) ||
          String(a.id).localeCompare(String(b.id)),
      )
    for (const credit of ordered) take(credit, Infinity)
  }
  const draws = [...drawn].map(([creditId, cents]) => ({ creditId, amount: cents / 100 }))
  const totalCents = [...drawn.values()].reduce((sum, cents) => sum + cents, 0)
  const label = accountCreditLabel(draws.map((draw) => byId.get(draw.creditId)?.forPeriod ?? null))
  return {
    draws,
    totalCents,
    label,
    line:
      totalCents > 0
        ? { kind: 'account_credit', label, detail: '', amount: -(totalCents / 100), draws }
        : null,
  }
}

/**
 * PAID BY CREDIT (stage 1d). Is this invoice $0 BECAUSE a credit line covers it?
 * A credit on account line (a prepayment or an overpayment), a retainer credit
 * line, or both, with a total of exactly zero. A $0 invoice with NO credit line
 * (a genuine nothing-to-bill statement) is not covered; neither is a partly
 * covered one, which goes out for the remainder.
 */
export function invoiceCoveredByCredit(invoice) {
  if (accountCreditCents(invoice?.total) !== 0) return false
  return (Array.isArray(invoice?.lineItems) ? invoice.lineItems : []).some(
    (line) =>
      (line?.kind === 'account_credit' || line?.kind === 'retainer_credit') &&
      accountCreditCents(line.amount) < 0,
  )
}

/** The statuses Send can mark paid by credit: anything before money moved or the invoice was withdrawn. */
export const CREDIT_PAYABLE_STATUSES = new Set(['draft', 'reviewed', 'sent', 'overdue'])

/** Will Send (or a never-email invoice's Mark reviewed) mark this invoice paid by credit? */
export function invoicePaidByCreditAtSend(invoice) {
  return CREDIT_PAYABLE_STATUSES.has(invoice?.status) && invoiceCoveredByCredit(invoice)
}

/** The invoice as the paid-by-credit stamp will leave it: what the preview builds the documents from. */
export function invoiceAsPaidByCredit(invoice, stamp) {
  return { ...invoice, status: 'paid', paymentMethod: 'credit', paidAt: stamp }
}

/**
 * How a credit payment reads in a sentence: "credit on account", or "your
 * prepayment" when the credit line carries a month ("Credit on account - meant
 * for November 2026"), which is how a prepayment shows on the invoice. When ONLY
 * a retainer credit covers the invoice it is "your retainer".
 */
export function creditPaymentWords(invoice) {
  const lines = Array.isArray(invoice?.lineItems) ? invoice.lineItems : []
  const drawn = lines.filter((line) => line?.kind === 'account_credit' && accountCreditCents(line.amount) < 0)
  if (drawn.length === 0 && lines.some((line) => line?.kind === 'retainer_credit' && accountCreditCents(line.amount) < 0)) {
    return 'your retainer'
  }
  const meant = drawn.some((line) => String(line.label ?? '').startsWith(`${ACCOUNT_CREDIT_LABEL} - meant for `))
  return meant ? 'your prepayment' : 'credit on account'
}

/**
 * The explicitly-picked service package (e.g. "The Classic"), else the
 * subscribed plan names, else a generic label.
 */
function serviceLabel(client, subscribedPlans, fallback) {
  if (client.monthlyServiceTier && client.monthlyServiceTier.trim()) {
    return client.monthlyServiceTier
  }
  if (subscribedPlans.length > 0) {
    return subscribedPlans.map((item) => item.name).join(', ')
  }
  return fallback
}

/* -------------------------------------------------------------------------- */
/* The paid lock                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The statuses in which an invoice's CONTENT is frozen.
 *
 * Brittany's rule, verbatim off the tracker (featreq-ead3a215): "invoices should
 * not be editable once paid all invoices should lock after paid." She was
 * answering a narrower question — whether a retainer credit should freeze at the
 * amount paid — and gave the general rule instead, so the general rule is what
 * this is.
 *
 * `processing` is in here and `sent` is not, which is the one judgment call in
 * this file. The line is MONEY COMMITTED, not "left the building":
 *
 *   - `processing` means the client has authorized a specific amount and an ACH
 *     debit is settling against it. Editing the copy of record mid-settlement
 *     produces exactly the harm she is asking to prevent, and the row locks
 *     afterwards anyway — with the edit baked in. Days can pass in this state.
 *   - `sent` and `overdue` mean nobody has paid anything yet. Correcting an
 *     invoice before a client pays it is ordinary bookkeeping, she did not ask
 *     for it to stop, and taking it away would be a worse app.
 *
 * This freezes CONTENT, never the lifecycle: `void` stays reachable from a
 * paid invoice on purpose. Withdrawing an invoice that turned out to be wrong
 * is the correct escape, and it is the only one — which is the point. A void is
 * a visible act with its own record; a silent edit is not. The one exception is
 * `processing`: see `invoiceVoidRefusal`.
 *
 * It also answers the retainer question STRUCTURALLY rather than with a second
 * rule: a retainer must be `paid` before it can be credited anywhere
 * (`listUnappliedRetainers`), and a paid invoice's total can no longer move — so
 * the credit can no longer drift from the money that came in. There is no
 * snapshot to keep in sync because there is nothing left to snapshot against.
 */
export const LOCKED_INVOICE_STATUSES = Object.freeze(['processing', 'paid'])

/**
 * The fields that ARE the invoice's content — what the client is looking at.
 *
 * `entryTags` is here because re-tagging an entry's scope is a line edit wearing
 * another hat: it moves hours between a person's billable line and an ad hoc
 * line, and the save that carries it carries those lines too. A paid invoice
 * that refused the lines but took the tags would end up describing work its own
 * totals no longer match.
 */
export const LOCKED_INVOICE_FIELDS = Object.freeze([
  'lineItems',
  'blurb',
  'dueDate',
  'entryTags',
])

/** What she reads when a locked invoice refuses an edit. */
export const INVOICE_LOCKED_MESSAGE =
  'This invoice is locked because it has been paid — it has to keep matching what the client paid. Void it and issue a new one if it is wrong.'

/** Same sentence for an invoice whose payment is still settling. */
export const INVOICE_PROCESSING_LOCKED_MESSAGE =
  'This invoice is locked because a bank payment is going through against it. Wait until it is paid or fails before changing or voiding it.'

/** The error code a void aimed at a clearing payment is refused with. */
export const INVOICE_PAYMENT_PROCESSING_CODE = 'invoice_payment_processing'

/** What she reads when she tries to void an invoice whose bank payment is clearing. */
export const INVOICE_PAYMENT_PROCESSING_MESSAGE =
  'A bank payment is still clearing on this invoice. Wait until it is paid or fails, then void it.'

/** Whether this invoice's content is frozen. */
export function isInvoiceLocked(invoice) {
  return LOCKED_INVOICE_STATUSES.includes(invoice?.status)
}

/** The sentence for a given locked invoice, or null if it is not locked. */
export function invoiceLockMessage(invoice) {
  if (!isInvoiceLocked(invoice)) return null
  return invoice.status === 'processing'
    ? INVOICE_PROCESSING_LOCKED_MESSAGE
    : INVOICE_LOCKED_MESSAGE
}

/**
 * Why this patch may not be applied to this invoice — or null if it may.
 *
 * Deliberately keyed on the KEYS PRESENT rather than on whether the values
 * differ. "Your tab is out of date" and "you changed nothing" are the same
 * request on the wire, and answering the second one with a silent success would
 * let a stale tab believe it saved. She gets a sentence either way.
 *
 * A status patch is judged separately: `void` is the escape hatch and always
 * allowed, but nothing may walk a paid invoice back to `draft` or `reviewed` —
 * un-reviewing money that has already landed is the same lock from the other
 * side.
 */
export function invoiceLockRefusal(invoice, patch) {
  const message = invoiceLockMessage(invoice)
  if (!message) return null
  const touched = LOCKED_INVOICE_FIELDS.some((field) => (patch ?? {})[field] !== undefined)
  const rewinds =
    typeof (patch ?? {}).status === 'string' &&
    patch.status !== 'void' &&
    patch.status !== invoice.status
  return touched || rewinds ? message : null
}

/**
 * The one exception to "void is always reachable": an invoice whose bank payment
 * is still CLEARING (`processing`) cannot be voided. The money is already on its
 * way, and `applyInvoicePayment` ignores a void invoice — so voiding here would
 * let the payment arrive against no live invoice with nothing saying so. Once
 * the payment settles (`paid`) or fails (back to `sent`), void is open again.
 *
 * Separate from `invoiceLockRefusal` because it answers with its own error code
 * (the page shows it beside the buttons, not as a "locked" notice). Returns
 * `{ code, message }`, or null when the patch may go ahead.
 */
export function invoiceVoidRefusal(invoice, patch) {
  if (invoice?.status !== 'processing') return null
  if ((patch ?? {}).status !== 'void') return null
  return {
    code: INVOICE_PAYMENT_PROCESSING_CODE,
    message: INVOICE_PAYMENT_PROCESSING_MESSAGE,
  }
}

/* -------------------------------------------------------------------------- */
/* The optional time breakdown                                                */
/* -------------------------------------------------------------------------- */

/**
 * How much detail about the month's time appears on the invoice.
 *
 * Brittany's ask, 2026-08-25: "Time breakdown should be an auto off. As of now I
 * just want the subscription line and price and the expense reimbursement line
 * and price and then for the clients I choose I can click the time breakdown."
 * Her contact list sets "Show Time Breakdown" to Off on 37 of 42 clients (the
 * other five rows simply run out of data), so OFF is the default and the whole
 * feature is opt-in per client.
 *
 *   off     no time lines at all
 *   person  one line per person, their total hours for the month
 *   day     one line per person per day
 *   week    one line per person per week
 *   entry   one line per entry
 *
 * "So basically, with our current group there would be a total of 3 lines with
 * total hours for the month" — three people, three lines.
 */
export const TIME_BREAKDOWN_MODES = Object.freeze(['off', 'person', 'day', 'week', 'entry'])

/** Anything unrecognized is OFF. A bad value must never start billing detail. */
export function normalizeTimeBreakdownMode(value) {
  return TIME_BREAKDOWN_MODES.includes(value) ? value : 'off'
}

/**
 * "12.34 hours" — her rule, verbatim: "All should only show total not like clock
 * in clock out times just xx hours." No start time, no end time, anywhere in
 * this file. Two decimals is the firm's standard everywhere else (featreq-7c8f64d7).
 */
export function breakdownHoursLabel(minutes) {
  return `${(minutes / 60).toFixed(2)} hours`
}

/** "Aug 4, 2026" — the same date style the ad hoc and reimbursement lines use. */
function breakdownDateLabel(date) {
  return adhocDateLabel(date)
}

/**
 * The month's time, as INFORMATIONAL invoice lines.
 *
 * THE ONE INVARIANT, and the reason this is safe to hand a client: every line it
 * returns has `amount: 0`, so switching the breakdown on or off — or between
 * modes — CANNOT move the invoice total. The money is decided by the service
 * line and the hours line; this only explains it. Nothing here is a charge, and
 * a future edit that gives one of these lines an amount is a double-bill.
 *
 * That is also what lets the same block sit on a subscription invoice and an
 * hourly one without meaning two different things. On a subscription invoice it
 * shows what the fee bought; on an hourly invoice it breaks down the single
 * "Billable hours" charge above it. Same lines, same rule.
 *
 * `showAmounts` is her "option to turn on billing amount for that person too" —
 * what the time was WORTH, written into the line's detail text rather than its
 * amount, because the amount field is the one thing that must stay zero.
 */
export function timeBreakdownLines({
  entries = [],
  employees = [],
  mode = 'off',
  showAmounts = false,
  rateFor = () => 0,
} = {}) {
  const resolved = normalizeTimeBreakdownMode(mode)
  if (resolved === 'off') return []

  const nameById = new Map((employees ?? []).map((employee) => [employee.id, employee.name]))
  const nameOf = (id) => nameById.get(id) ?? 'Unknown'

  // Sorted before grouping so every mode reads the same way: people
  // alphabetically, and each person's work oldest first.
  const sorted = (entries ?? [])
    .slice()
    .sort(
      (a, b) =>
        nameOf(a.employeeId).localeCompare(nameOf(b.employeeId)) ||
        String(a.date ?? '').localeCompare(String(b.date ?? '')) ||
        String(a.description ?? '').localeCompare(String(b.description ?? '')),
    )

  const money = (minutes, employeeId) =>
    currency.format((minutes / 60) * rateFor(employeeId))

  const withAmount = (minutes, employeeId, text) =>
    showAmounts ? `${text} · ${money(minutes, employeeId)}` : text

  const line = (label, detail) => ({ kind: 'time_detail', label, detail, amount: 0 })

  if (resolved === 'entry') {
    // Every entry, one line each. The description is what she wrote in the
    // timer, so this is the most a client can be shown short of the raw log —
    // and still no clock times.
    return sorted.map((entry) =>
      line(
        nameOf(entry.employeeId),
        withAmount(
          entry.minutes,
          entry.employeeId,
          `${breakdownDateLabel(entry.date)} · ${String(entry.description ?? '').trim() || 'Work'} · ${breakdownHoursLabel(entry.minutes)}`,
        ),
      ),
    )
  }

  // person / day / week are the same fold over a different bucket key.
  const bucketOf = (entry) => {
    if (resolved === 'person') return ''
    if (resolved === 'week') return weekStartOf(String(entry.date ?? ''))
    return String(entry.date ?? '')
  }

  const groups = new Map()
  for (const entry of sorted) {
    const bucket = bucketOf(entry)
    const key = `${entry.employeeId}\u0000${bucket}`
    const found = groups.get(key)
    if (found) found.minutes += entry.minutes
    else groups.set(key, { employeeId: entry.employeeId, bucket, minutes: entry.minutes })
  }

  return Array.from(groups.values()).map((group) => {
    const who = nameOf(group.employeeId)
    const label =
      resolved === 'person'
        ? who
        : resolved === 'week'
          ? `${who} — week of ${breakdownDateLabel(group.bucket)}`
          : `${who} — ${breakdownDateLabel(group.bucket)}`
    return line(label, withAmount(group.minutes, group.employeeId, breakdownHoursLabel(group.minutes)))
  })
}
