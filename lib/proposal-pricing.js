/**
 * PROPOSAL PRICING — the catalog math behind every proposal
 * (featreq-311473e2 / featreq-ef18a38e, docs/plans/proposals-2026-09.md §4).
 *
 * Pure: same inputs, same answer, no clock and no I/O. The AI never computes a
 * price — every dollar a proposal, its letter, or its PDF shows comes out of
 * `priceProposal`, which is why the intake chat and the letter validator are
 * handed its lines rather than asked to multiply anything.
 *
 * One formula shape for every catalog row:
 *   count x factor x role rate x multiplier
 * plus two explicit blocks that do not fit it (payroll, sales tax) and flat
 * rows whose amount is typed per proposal (her sheet's blanks).
 */

export const PROPOSAL_GROUPS = [
  'Monthly',
  'Reconciliations',
  'AR',
  'AP',
  'Payroll',
  'Sales tax',
  'Reports',
  'Additional reports',
  'Annual and one-time',
  'Clean-up',
]

/** The groups whose lines add up to the monthly fee. */
export const MONTHLY_GROUPS = PROPOSAL_GROUPS.slice(0, 8)
export const ANNUAL_GROUP = 'Annual and one-time'
export const CLEANUP_GROUP = 'Clean-up'

export const PROPOSAL_TIERS = ['Basic', 'Classes', 'Advance']
export const PROPOSAL_ROLES = ['bookkeeper', 'accountant', 'controller']
export const PROPOSAL_PRICING_KINDS = ['formula', 'flat', 'payroll', 'sales-tax']
export const PROPOSAL_MULTIPLIERS = [
  'none',
  'weekly-x4',
  'quarterly-div3',
  'yearly-div12',
  'per-cleanup-month',
  'per-report',
  'per-form',
]
/** Only rows in the Annual and one-time group carry one; it splits that group's total. */
export const PROPOSAL_CADENCES = ['annual', 'one-time']
export const PAYROLL_RUNS = ['weekly', 'biweekly', 'monthly']

/** Her payroll block: bonus = A x .13 x H, taxes T = A x .5. */
export const PAYROLL_BONUS_FACTOR = 0.13
export const PAYROLL_TAX_FACTOR = 0.5
/** The sales-tax block's D. Its `inputKey` is the state count (E). */
export const SALES_TAX_AMOUNT_KEY = 'salesTaxReviewAmount'

const DEFAULT_INPUTS = [
  { key: 'transactions', label: 'Transactions', help: 'X - transactions per month in their books' },
  { key: 'balanceSheetAccounts', label: 'Balance sheet accounts', help: 'Y' },
  { key: 'plAccounts', label: 'Profit and loss accounts', help: 'W' },
  { key: 'totalAccounts', label: 'Total accounts', help: 'Z' },
  { key: 'invoicesPerWeekAR', label: 'Customer invoices per week', help: 'F - accounts receivable' },
  { key: 'invoicesPerWeekAP', label: 'Vendor bills per week', help: 'G - accounts payable' },
  { key: 'employees', label: 'Employees', help: 'I - people on payroll' },
  { key: 'salesTaxReviewAmount', label: 'Sales tax review amount', help: 'D - dollars per sales tax review' },
  { key: 'states', label: 'Sales tax states', help: 'E - states they file in' },
  { key: 'cleanupMonths', label: 'Months of clean-up', help: 'How many months of books need clean-up' },
  { key: 'reportsNeeded', label: 'Reports needed', help: 'How many reports they want' },
  { key: 'forms', label: 'Forms', help: 'Forms on an individual return' },
  { key: 'accountsNeedingAttention', label: 'Accounts needing detailed attention', help: 'Clean-up' },
  { key: 'chartAccountsToClean', label: 'Chart of accounts entries to clean', help: 'Clean-up' },
  { key: 'clientCallHours', label: 'Client call hours', help: 'Hours of client calls per month' },
]

// [id, group, name, tier, pricing, inputKey, factor, role, multiplier, cadence]
const SEED_ROWS = [
  ['monthly-weekly-transactions-basic', 'Monthly', 'Weekly transactions', 'Basic', 'formula', 'transactions', 0.07, 'bookkeeper', 'none'],
  ['monthly-weekly-transactions-classes', 'Monthly', 'Weekly transactions', 'Classes', 'formula', 'transactions', 0.1, 'bookkeeper', 'none'],
  ['monthly-weekly-transactions-advance', 'Monthly', 'Weekly transactions', 'Advance', 'formula', 'transactions', 0.13, 'bookkeeper', 'none'],
  ['monthly-monthly-transactions-basic', 'Monthly', 'Monthly transactions', 'Basic', 'formula', 'transactions', 0.03, 'bookkeeper', 'none'],
  ['monthly-monthly-transactions-classes', 'Monthly', 'Monthly transactions', 'Classes', 'formula', 'transactions', 0.05, 'bookkeeper', 'none'],
  ['monthly-monthly-transactions-advance', 'Monthly', 'Monthly transactions', 'Advance', 'formula', 'transactions', 0.07, 'bookkeeper', 'none'],
  ['reconciliations', 'Reconciliations', 'Reconciliations', null, 'formula', 'balanceSheetAccounts', 0.25, 'bookkeeper', 'none'],
  ['ar-prepare-invoices', 'AR', 'Prepare invoices', null, 'formula', 'invoicesPerWeekAR', 0.13, 'accountant', 'none'],
  ['ar-send-invoices', 'AR', 'Send invoices', null, 'formula', 'invoicesPerWeekAR', 0.03, 'bookkeeper', 'none'],
  ['ar-follow-up', 'AR', 'Follow up with clients', null, 'formula', 'invoicesPerWeekAR', 0.03, 'bookkeeper', 'none'],
  ['ar-collections', 'AR', 'Support with collections', null, 'formula', 'invoicesPerWeekAR', 0.01, 'bookkeeper', 'none'],
  ['ap-enter-invoices', 'AP', 'Enter invoices', null, 'formula', 'invoicesPerWeekAP', 0.05, 'bookkeeper', 'none'],
  ['ap-pay-invoices', 'AP', 'Pay invoices', null, 'formula', 'invoicesPerWeekAP', 0.03, 'controller', 'none'],
  ['ap-contact-vendors', 'AP', 'Contact vendors', null, 'formula', 'invoicesPerWeekAP', 0.01, 'controller', 'none'],
  ['payroll', 'Payroll', 'Payroll', null, 'payroll', 'employees', 0.05, 'accountant', 'none'],
  ['sales-tax-monthly', 'Sales tax', 'File sales tax monthly', null, 'sales-tax', 'states', 0, null, 'none'],
  ['sales-tax-quarterly', 'Sales tax', 'File sales tax quarterly', null, 'sales-tax', 'states', 0, null, 'quarterly-div3'],
  ['sales-tax-yearly', 'Sales tax', 'File sales tax yearly', null, 'sales-tax', 'states', 0, null, 'yearly-div12'],
  ['reports-monthly-basic', 'Reports', 'Monthly reports', 'Basic', 'formula', 'totalAccounts', 0.03, 'accountant', 'none'],
  ['reports-monthly-advance', 'Reports', 'Monthly reports', 'Advance', 'formula', 'totalAccounts', 0.05, 'accountant', 'none'],
  ['reports-quarterly-basic', 'Reports', 'Quarterly reports', 'Basic', 'formula', 'totalAccounts', 0.03, 'accountant', 'quarterly-div3'],
  ['reports-quarterly-advance', 'Reports', 'Quarterly reports', 'Advance', 'formula', 'totalAccounts', 0.05, 'accountant', 'quarterly-div3'],
  ['reports-needed-basic', 'Reports', 'Reports needed', 'Basic', 'formula', 'totalAccounts', 0.03, 'accountant', 'per-report'],
  ['reports-needed-advance', 'Reports', 'Reports needed', 'Advance', 'formula', 'totalAccounts', 0.05, 'accountant', 'per-report'],
  ['budget-vs-actual', 'Additional reports', 'Budget vs actual', null, 'formula', 'plAccounts', 0.05, 'controller', 'none'],
  ['cash-flow-weekly', 'Additional reports', 'Cash flow weekly', null, 'formula', 'totalAccounts', 0.05, 'controller', 'weekly-x4'],
  ['cash-flow-monthly', 'Additional reports', 'Cash flow monthly', null, 'formula', 'totalAccounts', 0.05, 'controller', 'none'],
  ['kpi-reports', 'Additional reports', 'KPI reports', null, 'formula', 'totalAccounts', 0.07, 'controller', 'none'],
  ['client-call', 'Additional reports', 'Client call', null, 'formula', 'clientCallHours', 1, 'controller', 'none'],
  ['budget', 'Annual and one-time', 'Budget', null, 'formula', 'plAccounts', 0.05, 'controller', 'per-form', 'annual'],
  ['forecast', 'Annual and one-time', 'Forecast', null, 'formula', 'totalAccounts', 0.05, 'controller', 'per-form', 'annual'],
  ['payroll-setup', 'Annual and one-time', 'Payroll setup', null, 'flat', null, 0, null, 'none', 'one-time'],
  ['business-return', 'Annual and one-time', 'Business return', null, 'flat', null, 0, null, 'none', 'annual'],
  ['individual-return', 'Annual and one-time', 'Individual return', null, 'flat', null, 0, null, 'none', 'annual'],
  ['individual-return-multiple-forms', 'Annual and one-time', 'Individual return with multiple forms', null, 'flat', 'forms', 0, null, 'per-form', 'annual'],
  ['cleanup-transactions-basic', 'Clean-up', 'Monthly transactions', 'Basic', 'formula', 'transactions', 0.03, 'bookkeeper', 'per-cleanup-month'],
  ['cleanup-transactions-classes', 'Clean-up', 'Monthly transactions', 'Classes', 'formula', 'transactions', 0.05, 'bookkeeper', 'per-cleanup-month'],
  ['cleanup-transactions-advance', 'Clean-up', 'Monthly transactions', 'Advance', 'formula', 'transactions', 0.07, 'bookkeeper', 'per-cleanup-month'],
  ['cleanup-reconciliations', 'Clean-up', 'Reconciliations', null, 'formula', 'balanceSheetAccounts', 0.25, 'bookkeeper', 'per-cleanup-month'],
  ['cleanup-accounts-attention', 'Clean-up', 'Accounts needing detailed attention', null, 'formula', 'accountsNeedingAttention', 0.13, 'controller', 'per-cleanup-month'],
  ['cleanup-chart-of-accounts', 'Clean-up', 'Chart of accounts clean-up', null, 'formula', 'chartAccountsToClean', 0.07, 'accountant', 'none'],
]

/**
 * A fresh copy of the seed catalog: her sheet, row for row, with ZERO role
 * rates — the proposal rates are hers to set (spec §9: they are not the team's
 * bill rates). Always a new object, so no caller can mutate the seed.
 */
export function defaultProposalPricing() {
  return {
    rates: { bookkeeper: 0, accountant: 0, controller: 0 },
    inputs: DEFAULT_INPUTS.map((input) => ({ ...input })),
    services: SEED_ROWS.map(
      ([id, group, name, tier, pricing, inputKey, factor, role, multiplier, cadence], index) => ({
        id,
        group,
        name,
        tier,
        pricing,
        inputKey,
        factor,
        role,
        multiplier,
        cadence: group === ANNUAL_GROUP ? (cadence ?? 'annual') : null,
        active: true,
        sortOrder: index + 1,
      }),
    ),
  }
}

export const DEFAULT_PROPOSAL_PRICING = Object.freeze(defaultProposalPricing())

/** Round to cents at the line, so a total is always the sum of what is shown. */
export function roundCents(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100
}

/** "$1,234.50" — the one money format the formula strings and the letter use. */
export function formatProposalMoney(amount) {
  return `$${roundCents(amount).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

/** "$75/hr", or "$72.50/hr" when the rate has cents. */
function formatRate(rate) {
  return `${Number.isInteger(rate) ? `$${rate}` : formatProposalMoney(rate)}/hr`
}

/** A finite, non-negative number, or 0. */
function count(value) {
  const n = Number(value)
  return value !== null && value !== undefined && value !== '' && Number.isFinite(n) && n >= 0
    ? n
    : 0
}

/** A finite, non-negative number, or null when the field is absent or junk. */
function optionalAmount(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** The per-row count behind a per-* multiplier: the typed quantity wins, else the input. */
function perCount(selection, values, key) {
  const typed = optionalAmount(selection?.quantity)
  return typed ?? count(values[key])
}

function multiplierOf(service, selection, values) {
  switch (service.multiplier) {
    case 'weekly-x4':
      return { factor: 4, text: ' x 4 weeks' }
    case 'quarterly-div3':
      return { factor: 1 / 3, text: ' / 3' }
    case 'yearly-div12':
      return { factor: 1 / 12, text: ' / 12' }
    case 'per-cleanup-month': {
      const n = perCount(selection, values, 'cleanupMonths')
      return { factor: n, text: ` x ${n} clean-up months` }
    }
    case 'per-report': {
      const n = perCount(selection, values, 'reportsNeeded')
      return { factor: n, text: ` x ${n} reports` }
    }
    case 'per-form': {
      const n = perCount(selection, values, 'forms')
      return { factor: n, text: ` x ${n} forms` }
    }
    default:
      return { factor: 1, text: '' }
  }
}

function priceLine(service, selection, { rates, values, inputsByKey }) {
  if (service.inputKey && !inputsByKey.has(service.inputKey)) {
    return {
      amount: 0,
      formula: `No input named "${service.inputKey}" in the catalog - this line prices at $0.00`,
      flag: 'unknown-input',
    }
  }
  const rate = service.role ? count(rates[service.role]) : 0
  const multiplier = multiplierOf(service, selection, values)

  if (service.pricing === 'flat') {
    const typed = count(selection?.flatAmount)
    const amount = roundCents(typed * multiplier.factor)
    const formula = multiplier.text
      ? `${formatProposalMoney(typed)}${multiplier.text} = ${formatProposalMoney(amount)}`
      : `Flat ${formatProposalMoney(amount)}`
    return { amount, formula, flag: null }
  }

  if (service.pricing === 'payroll') {
    const employees = count(values[service.inputKey])
    const hours = rate * count(service.factor) * employees
    const taxes = rate * PAYROLL_TAX_FACTOR
    const run = PAYROLL_RUNS.includes(selection?.payrollRun) ? selection.payrollRun : 'monthly'
    const runs = run === 'weekly' ? 4 : run === 'biweekly' ? 2 : 1
    const bonus = selection?.includeBonus === true ? rate * PAYROLL_BONUS_FACTOR * hours : 0
    const amount = roundCents(hours * runs + taxes + bonus)
    const label = run === 'biweekly' ? 'bi-weekly' : run
    const formula =
      `${employees} employees, run ${label}: (${formatRate(rate)} x ${service.factor} x ${employees})` +
      `${runs === 1 ? '' : ` x ${runs}`} + taxes ${formatRate(rate)} x ${PAYROLL_TAX_FACTOR}` +
      `${bonus ? ` + bonus ${formatRate(rate)} x ${PAYROLL_BONUS_FACTOR} x ${formatProposalMoney(hours)}` : ''}` +
      ` = ${formatProposalMoney(amount)}`
    return { amount, formula, flag: null }
  }

  if (service.pricing === 'sales-tax') {
    const review = count(values[SALES_TAX_AMOUNT_KEY])
    const states = count(values[service.inputKey])
    const file = review * states * multiplier.factor
    const withReview = selection?.includeReview === true
    const amount = roundCents(file + (withReview ? review : 0))
    const formula =
      `${formatProposalMoney(review)} x ${states} states${multiplier.text}` +
      `${withReview ? ` + review ${formatProposalMoney(review)}` : ''} = ${formatProposalMoney(amount)}`
    return { amount, formula, flag: null }
  }

  const n = count(values[service.inputKey])
  const label = inputsByKey.get(service.inputKey)?.label ?? service.inputKey
  const amount = roundCents(n * count(service.factor) * rate * multiplier.factor)
  const formula =
    `${n} ${String(label).toLowerCase()} x ${service.factor} x ${formatRate(rate)}` +
    `${multiplier.text} = ${formatProposalMoney(amount)}`
  return { amount, formula, flag: null }
}

/**
 * Price a proposal.
 *
 * `selections` name catalog rows by id. A row that is missing or inactive
 * never prices. An `override` replaces the amount and keeps the computed one
 * beside it, so the estimate can show both.
 *
 * @returns {{ lines: object[], totals: { monthly: number, annual: number, oneTime: number, cleanup: number } }}
 */
export function priceProposal({ catalog, rates, inputs, selections } = {}) {
  const services = Array.isArray(catalog?.services) ? catalog.services : []
  const byId = new Map(services.map((service) => [service.id, service]))
  const inputsByKey = new Map(
    (Array.isArray(catalog?.inputs) ? catalog.inputs : []).map((input) => [input.key, input]),
  )
  const values = inputs && typeof inputs === 'object' ? inputs : {}
  const safeRates = rates && typeof rates === 'object' ? rates : {}

  const lines = []
  for (const selection of Array.isArray(selections) ? selections : []) {
    const service = byId.get(selection?.serviceId)
    if (!service || service.active !== true) continue
    const priced = priceLine(service, selection, { rates: safeRates, values, inputsByKey })
    const override = optionalAmount(selection.override)
    lines.push({
      serviceId: service.id,
      group: service.group,
      name: service.name,
      tier: service.tier ?? null,
      cadence: service.cadence ?? null,
      amount: override === null ? priced.amount : roundCents(override),
      computedAmount: priced.amount,
      formula:
        override === null
          ? priced.formula
          : `${priced.formula} (price set to ${formatProposalMoney(override)})`,
      flag: priced.flag,
      sortOrder: Number(service.sortOrder) || 0,
    })
  }
  lines.sort((a, b) => a.sortOrder - b.sortOrder)

  const sum = (keep) => roundCents(lines.filter(keep).reduce((total, line) => total + line.amount, 0))
  const totals = {
    monthly: sum((line) => MONTHLY_GROUPS.includes(line.group)),
    annual: sum((line) => line.group === ANNUAL_GROUP && line.cadence !== 'one-time'),
    oneTime: sum((line) => line.group === ANNUAL_GROUP && line.cadence === 'one-time'),
    cleanup: sum((line) => line.group === CLEANUP_GROUP),
  }
  return { lines: lines.map(({ sortOrder: _sortOrder, ...line }) => line), totals }
}
