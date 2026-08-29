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
// The SAME week anchor the timer gate and the assistant use. A breakdown that
// grouped weeks differently from the timesheet would be two calendars.
import { weekStartOf } from './time-entry.js'

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
 *
 * Neither names a sub company: both come from one shared label constant and
 * carry no company-specific detail. Adding a kind here means proving that too.
 */
export const COMBINED_KEPT_KINDS = new Set(['card-fee', 'retainer_credit'])

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
  const rendered = renderedInvoiceLines(invoice?.lineItems)
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
}) {
  const billableEntries = entries.filter(
    (entry) =>
      entry.clientId === client.id && entry.billable && isInBillingPeriod(entry, billingPeriod),
  )
  // Every billable minute of the month, ad hoc INCLUDED — this answers "how
  // much billable work was there", which is a different question from what any
  // one line covers. Deliberately computed before the ad hoc partition below,
  // so it does not match the "Billable hours — <name>" lines on a client with
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
      const base = {
        kind: 'recurring',
        label: `Recurring: ${recurring.description}`,
        detail: recurring.frequency,
        amount: recurring.amount,
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

  const done = (lines) => ({
    lines,
    total: lines.reduce((total, line) => total + line.amount, 0),
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
  const rateFor = (employeeId) => {
    const employee = employeeById.get(employeeId)
    return employee && typeof employee.billRate === 'number' && !Number.isNaN(employee.billRate)
      ? employee.billRate
      : defaultHourlyRate
  }

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
  let adhocLines = []
  let breakdownLines = []
  if (billingPeriod >= PER_EMPLOYEE_BILLING_START) {
    // THE PARTITION. This is the one place a billable entry is sorted into a
    // billing path, and the two sides are disjoint by construction: ad hoc time
    // becomes its own per-entry line and is gone from the "Billable hours —
    // <name>" totals below. An entry is billed once, through whichever side its
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
        const amount = (entry.minutes / 60) * rate
        const when = adhocDateLabel(entry.date)
        const who = employeeById.get(entry.employeeId)?.name ?? 'Unknown'
        return {
          kind: 'adhoc',
          label: `Adhoc — ${String(entry.description ?? '').trim() || 'One-off work'}`,
          detail: `${when} · ${who} · ${formatDecimalHours(entry.minutes)} at ${currency.format(rate)}/hr`,
          amount,
          adhocMode: 'billed',
          adhocAmount: amount,
        }
      })

    const minutesByEmployee = new Map()
    for (const entry of scopedEntries) {
      minutesByEmployee.set(
        entry.employeeId,
        (minutesByEmployee.get(entry.employeeId) ?? 0) + entry.minutes,
      )
    }
    employeeLines = Array.from(minutesByEmployee.entries())
      .map(([employeeId, minutes]) => {
        const employee = employeeById.get(employeeId)
        const rate = rateFor(employeeId)
        return {
          kind: 'hourly',
          label: `Billable hours — ${employee?.name ?? 'Unknown'}`,
          detail: `${formatDecimalHours(minutes)} at ${currency.format(rate)}/hr`,
          amount: (minutes / 60) * rate,
        }
      })
      .sort((a, b) => a.label.localeCompare(b.label))

    /**
     * THE BREAKDOWN ON AN HOURLY INVOICE, and why 'person' adds nothing here.
     *
     * An hourly client's charge lines ARE the per-person view — one
     * "Billable hours — <name>" line each, with the hours and the money. Adding
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
  }

  return done([
    ...employeeLines,
    ...breakdownLines,
    ...adhocLines,
    ...reimbursementLines,
    ...recurringLines,
  ])
}

/** "2026-08-04" -> "Aug 4, 2026", matching the reimbursement lines' date style. */
function adhocDateLabel(date) {
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
  const rest = (Array.isArray(lines) ? lines : [])
    .filter((line) => line?.kind !== 'retainer_credit')
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
 * locked invoice on purpose. Withdrawing an invoice that turned out to be wrong
 * is the correct escape, and it is the only one — which is the point. A void is
 * a visible act with its own record; a silent edit is not.
 *
 * It also answers the retainer question STRUCTURALLY rather than with a second
 * rule: a retainer must be `paid` before it can be credited anywhere
 * (`listUnappliedRetainers`), and a paid invoice's total can no longer move — so
 * the credit can no longer drift from the money that came in. There is no
 * snapshot to keep in sync because there is nothing left to snapshot against.
 */
export const LOCKED_INVOICE_STATUSES = Object.freeze(['processing', 'paid'])

/** The fields that ARE the invoice's content — what the client is looking at. */
export const LOCKED_INVOICE_FIELDS = Object.freeze(['lineItems', 'blurb', 'dueDate'])

/** What she reads when a locked invoice refuses an edit. */
export const INVOICE_LOCKED_MESSAGE =
  'This invoice is locked because it has been paid — it has to keep matching what the client paid. Void it and issue a new one if it is wrong.'

/** Same sentence for an invoice whose payment is still settling. */
export const INVOICE_PROCESSING_LOCKED_MESSAGE =
  'This invoice is locked because a payment is going through against it. Wait for it to settle, or void it if it is wrong.'

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
