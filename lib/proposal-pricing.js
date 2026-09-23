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

export const PROPOSAL_GROUPS = Object.freeze([
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
])

/** The groups whose lines add up to the monthly fee. */
export const MONTHLY_GROUPS = Object.freeze(PROPOSAL_GROUPS.slice(0, 8))
export const ANNUAL_GROUP = 'Annual and one-time'
export const CLEANUP_GROUP = 'Clean-up'

export const PROPOSAL_TIERS = Object.freeze(['Basic', 'Classes', 'Advance'])
export const PROPOSAL_ROLES = Object.freeze(['bookkeeper', 'accountant', 'controller'])
export const PROPOSAL_PRICING_KINDS = Object.freeze(['formula', 'flat', 'payroll', 'sales-tax'])
export const PROPOSAL_MULTIPLIERS = Object.freeze([
  'none',
  'weekly-x4',
  'quarterly-div3',
  'yearly-div12',
  'per-cleanup-month',
  'per-report',
  'per-form',
  /** Like per-form, but reads ONLY the selection's typed quantity - no fallback
   *  to any input. Used by Budget/Forecast so a return's forms count cannot
   *  leak into them (review I2). */
  'per-count',
])
/** Only rows in the Annual and one-time group carry one; it splits that group's total. */
export const PROPOSAL_CADENCES = Object.freeze(['annual', 'one-time'])
export const PAYROLL_RUNS = Object.freeze(['weekly', 'biweekly', 'monthly'])

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
  ['budget', 'Annual and one-time', 'Budget', null, 'formula', 'plAccounts', 0.05, 'controller', 'per-count', 'annual'],
  ['forecast', 'Annual and one-time', 'Forecast', null, 'formula', 'totalAccounts', 0.05, 'controller', 'per-count', 'annual'],
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

/** Recursively Object.freeze an object graph (arrays and plain objects only). */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/**
 * Frozen deep: `DEFAULT_PROPOSAL_PRICING.services[0].factor = 99` throws in
 * strict mode rather than silently succeeding. `defaultProposalPricing()`
 * itself always builds fresh, unfrozen objects, so callers still get a
 * mutable copy to edit.
 */
export const DEFAULT_PROPOSAL_PRICING = deepFreeze(defaultProposalPricing())

/** Round to cents at the line, so a total is always the sum of what is shown.
 *  Goes through toPrecision first to clear the floating-point noise (e.g.
 *  2.055 * 100 = 205.49999999999997) that made a plain Math.round misround
 *  half cents at some magnitudes. */
export function roundCents(value) {
  return Math.round(Number((Number(value) * 100).toPrecision(12))) / 100
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

/** A finite, non-negative number, or 0. Only numbers and numeric strings are
 *  valid input types - a boolean or an array silently coerces with `Number()`
 *  (`Number(true) === 1`), which used to read as a real count. */
function count(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return 0
  const n = Number(value)
  return value !== '' && Number.isFinite(n) && n >= 0 ? n : 0
}

/** True when a value was actually supplied but is not a type `count()` accepts
 *  (a boolean, an array, an object) - the line should flag 'invalid-input'
 *  rather than silently pricing it as 0. */
function isInvalidCount(value) {
  return (
    value !== null &&
    value !== undefined &&
    value !== '' &&
    typeof value !== 'number' &&
    typeof value !== 'string'
  )
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
      return { factor: 4, text: ' x 4 weeks', flag: null }
    case 'quarterly-div3':
      return { factor: 1 / 3, text: ' / 3', flag: null }
    case 'yearly-div12':
      return { factor: 1 / 12, text: ' / 12', flag: null }
    case 'per-cleanup-month': {
      const n = perCount(selection, values, 'cleanupMonths')
      return { factor: n, text: ` x ${n} clean-up months`, flag: null }
    }
    case 'per-report': {
      const n = perCount(selection, values, 'reportsNeeded')
      return { factor: n, text: ` x ${n} reports`, flag: null }
    }
    case 'per-form': {
      const n = perCount(selection, values, 'forms')
      return { factor: n, text: ` x ${n} forms`, flag: null }
    }
    case 'per-count': {
      // Unlike the per-* multipliers above, this one never falls back to an
      // input - her "__" blank is typed per proposal, not read off the
      // individual-return forms count (review I2).
      const typed = optionalAmount(selection?.quantity)
      if (typed === null) return { factor: 0, text: ' x 0 (no count typed)', flag: 'needs-count' }
      return { factor: typed, text: ` x ${typed}`, flag: null }
    }
    default:
      return { factor: 1, text: '', flag: null }
  }
}

function priceLine(service, selection, { rates, values, inputsByKey }) {
  const needsInput = service.pricing === 'formula' || service.pricing === 'payroll' || service.pricing === 'sales-tax'
  const inputMissing = service.inputKey ? !inputsByKey.has(service.inputKey) : needsInput
  if (inputMissing) {
    return {
      amount: 0,
      formula: service.inputKey
        ? `No input named "${service.inputKey}" in the catalog - this line prices at $0.00`
        : `This line names no input - this line prices at $0.00`,
      flag: 'unknown-input',
    }
  }
  const rate = service.role ? count(rates[service.role]) : 0
  const factor = count(service.factor)
  const multiplier = multiplierOf(service, selection, values)

  if (service.pricing === 'flat') {
    const rawTyped = selection?.flatAmount
    const typed = count(rawTyped)
    const amount = roundCents(typed * multiplier.factor)
    const formula = multiplier.text
      ? `${formatProposalMoney(typed)}${multiplier.text} = ${formatProposalMoney(amount)}`
      : `Flat ${formatProposalMoney(amount)}`
    return { amount, formula, flag: isInvalidCount(rawTyped) ? 'invalid-input' : multiplier.flag }
  }

  if (service.pricing === 'payroll') {
    const rawEmployees = values[service.inputKey]
    const employees = count(rawEmployees)
    const hours = rate * factor * employees
    const taxes = rate * PAYROLL_TAX_FACTOR
    const run = PAYROLL_RUNS.includes(selection?.payrollRun) ? selection.payrollRun : 'monthly'
    const runs = run === 'weekly' ? 4 : run === 'biweekly' ? 2 : 1
    const bonus = selection?.includeBonus === true ? rate * PAYROLL_BONUS_FACTOR * hours : 0
    const amount = roundCents(hours * runs + taxes + bonus)
    const label = run === 'biweekly' ? 'bi-weekly' : run
    const formula =
      `${employees} employees, run ${label}: (${formatRate(rate)} x ${factor} x ${employees})` +
      `${runs === 1 ? '' : ` x ${runs}`} + taxes ${formatRate(rate)} x ${PAYROLL_TAX_FACTOR}` +
      `${bonus ? ` + bonus ${formatRate(rate)} x ${PAYROLL_BONUS_FACTOR} x ${formatProposalMoney(hours)}` : ''}` +
      ` = ${formatProposalMoney(amount)}`
    return { amount, formula, flag: isInvalidCount(rawEmployees) ? 'invalid-input' : null }
  }

  if (service.pricing === 'sales-tax') {
    const rawReview = values[SALES_TAX_AMOUNT_KEY]
    const rawStates = values[service.inputKey]
    const review = count(rawReview)
    const states = count(rawStates)
    const file = review * states * multiplier.factor
    const withReview = selection?.includeReview === true
    const amount = roundCents(file + (withReview ? review : 0))
    const formula =
      `${formatProposalMoney(review)} x ${states} states${multiplier.text}` +
      `${withReview ? ` + review ${formatProposalMoney(review)}` : ''} = ${formatProposalMoney(amount)}`
    const invalid = isInvalidCount(rawReview) || isInvalidCount(rawStates)
    return { amount, formula, flag: invalid ? 'invalid-input' : multiplier.flag }
  }

  const rawN = values[service.inputKey]
  const n = count(rawN)
  const label = inputsByKey.get(service.inputKey)?.label ?? service.inputKey
  const amount = roundCents(n * factor * rate * multiplier.factor)
  const formula =
    `${n} ${String(label).toLowerCase()} x ${factor} x ${formatRate(rate)}` +
    `${multiplier.text} = ${formatProposalMoney(amount)}`
  return { amount, formula, flag: isInvalidCount(rawN) ? 'invalid-input' : multiplier.flag }
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
  const effectiveRates = rates ?? catalog?.rates
  const safeRates = effectiveRates && typeof effectiveRates === 'object' ? effectiveRates : {}

  // Dedupe by serviceId, last selection wins - a repeated add (a double
  // submit, two chat turns naming the same row) should price once, not
  // double the line (review I4).
  const dedupedSelections = new Map()
  for (const selection of Array.isArray(selections) ? selections : []) {
    dedupedSelections.set(selection?.serviceId, selection)
  }

  const lines = []
  for (const selection of dedupedSelections.values()) {
    const service = byId.get(selection?.serviceId)
    if (!service || service.active !== true) {
      // A row the catalog retired (or never had) does not vanish from a
      // proposal that already selected it - it prices at $0.00, flagged so
      // the letter and the list can call it out instead of quietly dropping it.
      lines.push({
        serviceId: selection?.serviceId ?? null,
        group: service?.group ?? null,
        name: service?.name ?? selection?.serviceId ?? 'Retired service',
        tier: service?.tier ?? null,
        cadence: service?.cadence ?? null,
        amount: 0,
        computedAmount: 0,
        formula: 'This service is retired - priced at $0.00',
        flag: 'retired',
        sortOrder: Number(service?.sortOrder) || 0,
      })
      continue
    }
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

const INPUT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,40}$/
const SERVICE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

function clampNumber(value, min, max, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/**
 * Validate an owner-edited catalog (spec §4.1). Mirrors `sanitizeClientDefaults`
 * in db/store.js: only well-typed values survive and nothing throws. Rates clamp
 * to [0, 1e6], factors to [0, 100], enums are checked, strings are capped,
 * unknown keys are dropped, service ids are unique (the first wins), and a row
 * whose input is not in the catalog is saved INACTIVE rather than refusing the
 * whole save.
 *
 * Anything that is not an object (a first read, a null column) is the seed.
 */
export function sanitizeProposalPricing(raw) {
  const seed = defaultProposalPricing()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return seed

  const rates = {}
  for (const role of PROPOSAL_ROLES) {
    rates[role] = clampNumber(raw.rates?.[role], 0, 1e6, seed.rates[role])
  }

  const seenKeys = new Set()
  const cleanedInputs = (Array.isArray(raw.inputs) ? raw.inputs : [])
    .filter((input) => input && typeof input === 'object')
    .map((input) => ({
      key: typeof input.key === 'string' ? input.key.trim() : '',
      label: cleanText(input.label, 80),
      help: cleanText(input.help, 200),
    }))
    .filter((input) => {
      if (!INPUT_KEY_PATTERN.test(input.key) || seenKeys.has(input.key)) return false
      seenKeys.add(input.key)
      return true
    })
    .map((input) => ({ ...input, label: input.label || input.key }))
    .slice(0, 60)
  const inputs = cleanedInputs.length > 0 ? cleanedInputs : seed.inputs
  const inputKeys = new Set(inputs.map((input) => input.key))

  const seenIds = new Set()
  const cleanedServices = (Array.isArray(raw.services) ? raw.services : [])
    .filter((service) => service && typeof service === 'object')
    .map((service, index) => {
      const id = typeof service.id === 'string' ? service.id.trim() : ''
      const group = PROPOSAL_GROUPS.includes(service.group) ? service.group : null
      const name = cleanText(service.name, 120)
      if (!SERVICE_ID_PATTERN.test(id) || seenIds.has(id) || !group || !name) return null
      seenIds.add(id)
      const pricing = PROPOSAL_PRICING_KINDS.includes(service.pricing) ? service.pricing : 'formula'
      const inputKey =
        typeof service.inputKey === 'string' && service.inputKey.trim()
          ? service.inputKey.trim()
          : null
      // Every kind but a plain flat amount reads a count; a row that names no
      // input, or one the catalog does not have, cannot price and is retired.
      const inputOk = inputKey ? inputKeys.has(inputKey) : pricing === 'flat'
      return {
        id,
        group,
        name,
        tier: PROPOSAL_TIERS.includes(service.tier) ? service.tier : null,
        pricing,
        inputKey,
        factor: clampNumber(service.factor, 0, 100, 0),
        role: PROPOSAL_ROLES.includes(service.role) ? service.role : null,
        multiplier: PROPOSAL_MULTIPLIERS.includes(service.multiplier) ? service.multiplier : 'none',
        cadence:
          group === ANNUAL_GROUP
            ? PROPOSAL_CADENCES.includes(service.cadence)
              ? service.cadence
              : 'annual'
            : null,
        active: service.active !== false && inputOk,
        sortOrder: clampNumber(service.sortOrder, 0, 1e6, index + 1),
      }
    })
    .filter(Boolean)
    .slice(0, 300)
  const services = Array.isArray(raw.services) ? cleanedServices : seed.services

  return { rates, inputs, services }
}

/** The prospect block, every field a capped string. */
export function cleanProposalProspect(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  return {
    company: cleanText(src.company, 200),
    contactName: cleanText(src.contactName, 200),
    email: cleanText(src.email, 320),
    phone: cleanText(src.phone, 60),
    notes: cleanText(src.notes, 4000),
  }
}

/**
 * The counts she collected: finite, non-negative, capped at 1e9. With
 * `allowedKeys`, only the catalog's own inputs survive.
 */
export function cleanProposalInputs(raw, allowedKeys = null) {
  const allowed = allowedKeys ? new Set(allowedKeys) : null
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, value] of Object.entries(raw)) {
    if (!INPUT_KEY_PATTERN.test(key)) continue
    if (allowed && !allowed.has(key)) continue
    if (value === null || value === undefined || value === '') continue
    const n = Number(value)
    if (!Number.isFinite(n) || n < 0) continue
    out[key] = Math.min(n, 1e9)
  }
  return out
}

/**
 * The rows she picked. One entry per service (the last one wins), numbers
 * finite and non-negative, the payroll run an enum, the two flags real
 * booleans. A field that is absent stays absent.
 */
export function cleanProposalSelections(raw) {
  const byId = new Map()
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!entry || typeof entry !== 'object') continue
    const serviceId = typeof entry.serviceId === 'string' ? entry.serviceId.trim() : ''
    if (!SERVICE_ID_PATTERN.test(serviceId)) continue
    const selection = { serviceId }
    for (const field of ['quantity', 'flatAmount', 'override']) {
      const n = optionalAmount(entry[field])
      if (n !== null) selection[field] = Math.min(n, 1e9)
    }
    if (PAYROLL_RUNS.includes(entry.payrollRun)) selection.payrollRun = entry.payrollRun
    if (typeof entry.includeBonus === 'boolean') selection.includeBonus = entry.includeBonus
    if (typeof entry.includeReview === 'boolean') selection.includeReview = entry.includeReview
    byId.delete(serviceId)
    byId.set(serviceId, selection)
  }
  return [...byId.values()].slice(0, 200)
}
