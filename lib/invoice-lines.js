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
 */
export function renderedInvoiceLines(lines) {
  return (Array.isArray(lines) ? lines : []).filter((line) => !isOmittedAdhoc(line))
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
  const recurringLines = recurringReimbursements
    .filter(
      (recurring) =>
        recurring.clientId === client.id &&
        recurringReimbursementAppliesToPeriod(recurring, billingPeriod),
    )
    .map((recurring) => ({
      kind: 'recurring',
      label: `Recurring: ${recurring.description}`,
      detail: recurring.frequency,
      amount: recurring.amount,
    }))

  const done = (lines) => ({
    lines,
    total: lines.reduce((total, line) => total + line.amount, 0),
    billableMinutes,
    entryCount: billableEntries.length,
    plan,
    periodLabel,
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
    lines.push(...reimbursementLines, ...recurringLines)
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
      ...reimbursementLines,
      ...recurringLines,
    ]
    return done(lines)
  }

  // Hourly, with the cutover described on PER_EMPLOYEE_BILLING_START.
  let employeeLines
  let adhocLines = []
  if (billingPeriod >= PER_EMPLOYEE_BILLING_START) {
    const employeeById = new Map(employees.map((employee) => [employee.id, employee]))
    const rateFor = (employeeId) => {
      const employee = employeeById.get(employeeId)
      return employee && typeof employee.billRate === 'number' && !Number.isNaN(employee.billRate)
        ? employee.billRate
        : defaultHourlyRate
    }

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

  return done([...employeeLines, ...adhocLines, ...reimbursementLines, ...recurringLines])
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
