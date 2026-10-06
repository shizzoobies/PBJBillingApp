import type { ClientRecap, ClientRecapDirection } from './api'

/**
 * The Client Recap as a spreadsheet (featreq-0f761138, Alex).
 *
 * One LONG table - Section, Row, Field, Value - rather than a copy of each
 * card's layout: the recap is five differently-shaped cards, and a team member
 * taking the numbers into a spreadsheet to plan a client's profitability wants
 * something they can filter and pivot, not five tables stacked with blank
 * lines between them. Every figure the page shows is here under the same
 * words the page uses, so the two can be checked against each other line by
 * line. Money and hours are plain numbers (no currency symbol, no "h"), which
 * is what a spreadsheet can add up; a blank is what the page shows as an em
 * dash - nothing to compare against - never a zero.
 *
 * Owner payloads carry the money sections. A staff payload (no financials:
 * `billing`, `profitability`, `estimates` null) exports exactly what that
 * person sees - the hours table without its cost columns - and nothing else.
 */

export type ClientRecapCsvCell = string | number | null
export type ClientRecapCsvRow = [string, string, string, ClientRecapCsvCell]

export const CLIENT_RECAP_CSV_HEADERS = ['Section', 'Row', 'Field', 'Value']

const PERIOD_TYPE_LABEL: Record<ClientRecap['periodType'], string> = {
  month: 'Monthly',
  quarter: 'Quarterly',
  year: 'Yearly',
}

const BILLING_TYPE_LABEL: Record<string, string> = {
  hourly: 'Hourly',
  subscription: 'Monthly subscription',
  annual: 'Annual',
}

/** A number as the page would print it, or a blank for "nothing to compare against". */
const cell = (value: number | null | undefined): ClientRecapCsvCell =>
  value === null || value === undefined ? '' : value

/**
 * Free text typed by people (a reimbursement description, a task title, sales
 * tax notes, the client's name) is kept from being read as a formula by the
 * spreadsheet that opens the file: a leading =, +, - or @ gets an apostrophe,
 * the convention every spreadsheet shows as plain text.
 */
const text = (value: string | null | undefined): string => {
  const raw = value ?? ''
  return /^[=+\-@]/.test(raw) ? `'${raw}` : raw
}

/**
 * The Over/Under word the page prints beside a variance, as its own field. An
 * exact match is "On estimate" on the plan-vs-actual rows and "Matches invoice"
 * on the Billing tile, the same words the page uses.
 */
const directionWord = (direction: ClientRecapDirection, onLabel = 'On estimate'): string =>
  direction === 'on' ? onLabel : direction ?? ''

const SALES_TAX_STATUS: Record<string, string> = {
  not_started: 'Not started',
  open: 'Open',
  overdue: 'Overdue',
  done: 'Done',
}

export function buildClientRecapCsv(recap: ClientRecap): {
  headers: string[]
  rows: ClientRecapCsvRow[]
} {
  const rows: ClientRecapCsvRow[] = []
  const add = (section: string, row: string, field: string, value: ClientRecapCsvCell) =>
    rows.push([section, row, field, value])

  // ---- Who and when ----
  add('Client', '', 'Name', text(recap.client.name))
  add(
    'Client',
    '',
    'Billing type',
    recap.client.billingMode
      ? (BILLING_TYPE_LABEL[recap.client.billingMode] ?? recap.client.billingMode)
      : recap.isBillingMaster
        ? 'Billing master (roll-up)'
        : '',
  )
  if (recap.isBillingMaster && recap.subs) {
    add('Client', '', 'Companies', recap.subs.map((sub) => sub.name).join(', '))
  }
  add('Period', '', 'Type', PERIOD_TYPE_LABEL[recap.periodType])
  add('Period', '', 'Label', recap.periodLabel)
  add('Period', '', 'Start', recap.range.start)
  add('Period', '', 'End', recap.range.end)
  add('Period', '', 'Months in period', recap.monthsInPeriod)

  // ---- Billing (owner only) ----
  if (recap.billing) {
    const profit = recap.estimates?.profit ?? null
    add('Billing', '', 'Service value', cell(profit?.serviceValue))
    add('Billing', '', 'Invoice', recap.billing.revenue)
    add('Billing', '', 'Over/Under', cell(profit?.serviceValueDelta))
    add(
      'Billing',
      '',
      'Over/Under direction',
      directionWord(profit?.serviceValueDirection ?? null, 'Matches invoice'),
    )
    add('Billing', '', 'Plans', recap.billing.planNames.join(', '))
    add('Billing', '', 'Hourly rate', cell(recap.billing.hourlyRate))
    add('Billing', '', 'Monthly rate', cell(recap.billing.monthlyRate))
    add('Billing', '', 'Reimbursements total', recap.billing.reimbursementTotal)
    recap.billing.reimbursements.forEach((item, index) => {
      const row = `Reimbursement ${index + 1}`
      add('Billing', row, 'Date', item.date)
      add('Billing', row, 'Description', text(item.description))
      add('Billing', row, 'Amount', item.amount)
    })
  }

  // ---- Time & hours: the ESTIMATE | ACTUAL | OVER/UNDER table, priced for owners ----
  const costByTier = new Map((recap.estimates?.byTier ?? []).map((row) => [row.tier, row]))
  const showCost = recap.estimates != null
  for (const role of recap.time.byRole) {
    const priced = costByTier.get(role.tier)
    add('Time & hours', role.tier, 'People', role.people.join(', '))
    add('Time & hours', role.tier, 'Estimate (hours)', cell(role.estimatedHours))
    add('Time & hours', role.tier, 'Actual (hours)', role.actualHours)
    add('Time & hours', role.tier, 'Over/Under (hours)', cell(role.deltaHours))
    add('Time & hours', role.tier, 'Over/Under direction', directionWord(role.direction))
    if (showCost) {
      add('Time & hours', role.tier, 'Cost rate', cell(priced?.costRate))
      add('Time & hours', role.tier, 'Cost estimate', cell(priced?.estimatedCost))
      // The page prints $0.00 for a role with no priced row, never a blank.
      add('Time & hours', role.tier, 'Cost actual', priced?.actualCost ?? 0)
      add('Time & hours', role.tier, 'Cost over/under', cell(priced?.costDelta))
      add('Time & hours', role.tier, 'Cost over/under direction', directionWord(priced?.costDirection ?? null))
      add('Time & hours', role.tier, 'Service value', cell(priced?.serviceValue))
    }
  }
  const totals = recap.time.roleTotals
  add('Time & hours', 'Total', 'Estimate (hours)', cell(totals.estimatedHours))
  add('Time & hours', 'Total', 'Actual (hours)', totals.actualHours)
  add('Time & hours', 'Total', 'Over/Under (hours)', cell(totals.deltaHours))
  add('Time & hours', 'Total', 'Over/Under direction', directionWord(totals.direction))
  if (recap.estimates) {
    add('Time & hours', 'Total', 'Cost estimate', cell(recap.estimates.cost.estimated))
    add('Time & hours', 'Total', 'Cost actual', recap.estimates.cost.actual)
    add('Time & hours', 'Total', 'Cost over/under', cell(recap.estimates.cost.delta))
    add('Time & hours', 'Total', 'Cost over/under direction', directionWord(recap.estimates.cost.direction))
    add('Time & hours', 'Total', 'Service value', cell(recap.estimates.profit.serviceValue))
  }
  if (recap.time.estimatesVisible && !recap.time.hasEstimate) {
    add('Time & hours', '', 'Note', 'No estimate set for this client.')
  }
  // Only meaningful when some roles ARE estimated - the page shows it the same way.
  if (recap.time.hasEstimate && recap.time.unestimatedRoles.length > 0) {
    add('Time & hours', '', 'Roles with hours but no estimate', recap.time.unestimatedRoles.join(', '))
  }

  // ---- Hours by person ----
  for (const person of recap.time.byStaff) {
    add('Hours by person', person.name, 'Role', person.tier)
    add('Hours by person', person.name, 'Hours', person.hours)
    add('Hours by person', person.name, 'Billable hours', person.billableHours)
  }
  add('Hours by person', '', 'Total hours', recap.time.totalHours)
  add('Hours by person', '', 'Billable hours', recap.time.billableHours)
  add('Hours by person', '', 'Administrative hours', recap.time.adminHours)
  add('Hours by person', '', 'Prior period hours', recap.time.priorHours)
  add('Hours by person', '', 'Change from prior period (hours)', recap.time.deltaHours)

  // ---- Profitability (owner only) ----
  if (recap.profitability) {
    const profit = recap.estimates?.profit ?? null
    add('Profitability', '', 'Estimated revenue', cell(profit?.estimatedRevenue))
    add('Profitability', '', 'Estimated cost', cell(profit?.estimatedCost))
    add('Profitability', '', 'Estimated profit', cell(profit?.estimatedProfit))
    add('Profitability', '', 'Actual revenue', cell(profit?.actualRevenue ?? recap.billing?.revenue))
    add('Profitability', '', 'Labor cost', recap.profitability.laborCost)
    add('Profitability', '', 'Actual profit', recap.profitability.margin)
    add('Profitability', '', 'Over/Under', cell(profit?.delta))
    add('Profitability', '', 'Over/Under direction', directionWord(profit?.direction ?? null))
  }

  // ---- Projected invoice (monthly recaps, owner only) ----
  if (recap.projection) {
    const p = recap.projection
    add('Projected invoice', '', 'Estimate?', p.isEstimate ? 'Yes' : 'No')
    add('Projected invoice', '', p.isEstimate ? 'Projected total' : 'Invoice total', cell(p.amount))
    add('Projected invoice', '', 'Service', cell(p.serviceAmount))
    add('Projected invoice', '', 'Reimbursements recorded', p.reimbursementsToDate)
    add('Projected invoice', '', 'Hours to date', p.hoursToDate)
    add('Projected invoice', '', 'Business days elapsed', p.businessDaysElapsed)
    add('Projected invoice', '', 'Business days in month', p.businessDaysInMonth)
    add('Projected invoice', '', 'Basis', p.method)
  }

  // ---- Tasks & workflow ----
  add('Tasks', '', 'Due this period', recap.tasks.dueCount)
  add('Tasks', '', 'Completed', recap.tasks.completedCount)
  add('Tasks', '', 'Overdue', recap.tasks.overdueCount)
  add('Tasks', '', 'Open', recap.tasks.openCount)
  // Row = title plus due date: the same title recurs across the months of a
  // quarter, and across companies on a billing master, and a spreadsheet
  // lookup on the Row must not merge them.
  for (const task of recap.tasks.dueThisPeriod) {
    const row = `${text(task.title)} (${task.dueDate})`
    add('Tasks', row, 'Title', text(task.title))
    add('Tasks', row, 'Due', task.dueDate)
    add('Tasks', row, 'Assignee', task.assignee ?? '')
    add('Tasks', row, 'Status', task.done ? 'Done' : task.overdue ? 'Overdue' : 'Open')
  }

  // ---- Sales tax (not on a billing master) ----
  if (recap.salesTax) {
    const tax = recap.salesTax
    add('Sales tax', '', 'Status', SALES_TAX_STATUS[tax.status] ?? tax.status)
    add('Sales tax', '', 'Task', tax.taskTitle ?? '')
    add('Sales tax', '', 'Due', tax.dueDate ?? '')
    if (tax.figures) {
      add('Sales tax', '', 'Taxable sales', cell(tax.figures.taxableSales))
      add('Sales tax', '', 'Tax collected', cell(tax.figures.taxCollected))
      add('Sales tax', '', 'Tax owed', cell(tax.figures.taxOwed))
      add('Sales tax', '', 'Notes', text(tax.figures.notes))
    }
  }

  return { headers: CLIENT_RECAP_CSV_HEADERS, rows }
}

/**
 * "client-recap-17-signature-llc-2026-Q1.csv": the client, then the period as
 * the URL spells it. A name with no Latin letters or digits falls back to the
 * client's id so two such clients cannot share a filename; a long name is cut.
 */
export function clientRecapCsvFilename(recap: ClientRecap): string {
  const slug =
    recap.client.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || recap.client.id || 'client'
  return `client-recap-${slug}-${recap.period}.csv`
}
