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

/** Rounded for display: 90 -> "1.5h", 120 -> "2h". */
export function formatHours(minutes) {
  const hours = minutes / 60
  return `${Number.isInteger(hours) ? hours.toFixed(0) : hours.toFixed(1)}h`
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
  if (billingPeriod >= PER_EMPLOYEE_BILLING_START) {
    const employeeById = new Map(employees.map((employee) => [employee.id, employee]))
    const minutesByEmployee = new Map()
    for (const entry of billableEntries) {
      minutesByEmployee.set(
        entry.employeeId,
        (minutesByEmployee.get(entry.employeeId) ?? 0) + entry.minutes,
      )
    }
    employeeLines = Array.from(minutesByEmployee.entries())
      .map(([employeeId, minutes]) => {
        const employee = employeeById.get(employeeId)
        const rate =
          employee && typeof employee.billRate === 'number' && !Number.isNaN(employee.billRate)
            ? employee.billRate
            : defaultHourlyRate
        return {
          kind: 'hourly',
          label: `Billable hours — ${employee?.name ?? 'Unknown'}`,
          detail: `${formatHours(minutes)} at ${currency.format(rate)}/hr`,
          amount: (minutes / 60) * rate,
        }
      })
      .sort((a, b) => a.label.localeCompare(b.label))
  } else {
    // Legacy: one line at the client's own stored rate — the exact shape
    // historical invoices were sent in.
    employeeLines = [
      {
        kind: 'hourly',
        label: 'Billable hours',
        detail: `${formatHours(billableMinutes)} at ${currency.format(client.hourlyRate)}/hr`,
        amount: (billableMinutes / 60) * client.hourlyRate,
      },
    ]
  }

  return done([...employeeLines, ...reimbursementLines, ...recurringLines])
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
