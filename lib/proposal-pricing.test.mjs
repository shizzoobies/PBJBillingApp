import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROPOSAL_PRICING,
  defaultProposalPricing,
  formatProposalMoney,
  priceProposal,
  sanitizeProposalPricing,
} from './proposal-pricing.js'

/**
 * The proposal calculator against HER SHEET (docs/plans/proposals-2026-09.md
 * §4.1 and §4.3). Every seeded row is priced once with the same worked set of
 * counts, at the team's current bill rates as stand-in proposal rates
 * (B 75 / A 115 / C 125 — the real proposal rates are hers to set).
 */
const rates = { bookkeeper: 75, accountant: 115, controller: 125 }
const inputs = {
  transactions: 120,
  balanceSheetAccounts: 20,
  plAccounts: 40,
  totalAccounts: 80,
  invoicesPerWeekAR: 10,
  invoicesPerWeekAP: 12,
  employees: 10,
  salesTaxReviewAmount: 50,
  states: 2,
  cleanupMonths: 6,
  reportsNeeded: 3,
  forms: 4,
  accountsNeedingAttention: 5,
  chartAccountsToClean: 30,
  clientCallHours: 2,
}
const catalog = defaultProposalPricing()
const price = (selections, overrides = {}) =>
  priceProposal({ catalog, rates, inputs: { ...inputs, ...overrides }, selections })
const one = (selection, overrides) => price([selection], overrides).lines[0]

describe('the seed catalog', () => {
  it('reproduces her sheet: 41 rows, every one active, zero rates', () => {
    expect(DEFAULT_PROPOSAL_PRICING.services).toHaveLength(41)
    expect(DEFAULT_PROPOSAL_PRICING.services.every((row) => row.active)).toBe(true)
    expect(DEFAULT_PROPOSAL_PRICING.rates).toEqual({ bookkeeper: 0, accountant: 0, controller: 0 })
    expect(DEFAULT_PROPOSAL_PRICING.inputs.map((input) => input.key)).toEqual([
      'transactions',
      'balanceSheetAccounts',
      'plAccounts',
      'totalAccounts',
      'invoicesPerWeekAR',
      'invoicesPerWeekAP',
      'employees',
      'salesTaxReviewAmount',
      'states',
      'cleanupMonths',
      'reportsNeeded',
      'forms',
      'accountsNeedingAttention',
      'chartAccountsToClean',
      'clientCallHours',
    ])
  })

  it('hands out a fresh copy every time, so nobody can edit the seed', () => {
    const copy = defaultProposalPricing()
    copy.services[0].factor = 99
    expect(defaultProposalPricing().services[0].factor).toBe(0.07)
  })

  it('has unique service ids', () => {
    const ids = DEFAULT_PROPOSAL_PRICING.services.map((row) => row.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('every seeded row against the worked sheet', () => {
  // [serviceId, amount]. Flat rows are typed at $250.00.
  const worked = [
    ['monthly-weekly-transactions-basic', 630],
    ['monthly-weekly-transactions-classes', 900],
    ['monthly-weekly-transactions-advance', 1170],
    ['monthly-monthly-transactions-basic', 270],
    ['monthly-monthly-transactions-classes', 450],
    ['monthly-monthly-transactions-advance', 630],
    ['reconciliations', 375],
    ['ar-prepare-invoices', 149.5],
    ['ar-send-invoices', 22.5],
    ['ar-follow-up', 22.5],
    ['ar-collections', 7.5],
    ['ap-enter-invoices', 45],
    ['ap-pay-invoices', 45],
    ['ap-contact-vendors', 15],
    ['payroll', 115],
    ['sales-tax-monthly', 100],
    ['sales-tax-quarterly', 33.33],
    ['sales-tax-yearly', 8.33],
    ['reports-monthly-basic', 276],
    ['reports-monthly-advance', 460],
    ['reports-quarterly-basic', 92],
    ['reports-quarterly-advance', 153.33],
    ['reports-needed-basic', 828],
    ['reports-needed-advance', 1380],
    ['budget-vs-actual', 250],
    ['cash-flow-weekly', 2000],
    ['cash-flow-monthly', 500],
    ['kpi-reports', 700],
    ['client-call', 250],
    ['budget', 1000],
    ['forecast', 2000],
    ['payroll-setup', 250],
    ['business-return', 250],
    ['individual-return', 250],
    ['individual-return-multiple-forms', 1000],
    ['cleanup-transactions-basic', 1620],
    ['cleanup-transactions-classes', 2700],
    ['cleanup-transactions-advance', 3780],
    ['cleanup-reconciliations', 2250],
    ['cleanup-accounts-attention', 487.5],
    ['cleanup-chart-of-accounts', 241.5],
  ]

  it('covers the whole catalog', () => {
    expect(worked.map(([id]) => id).sort()).toEqual(
      DEFAULT_PROPOSAL_PRICING.services.map((row) => row.id).sort(),
    )
  })

  for (const [serviceId, amount] of worked) {
    it(`${serviceId} prices ${formatProposalMoney(amount)}`, () => {
      const line = one({ serviceId, flatAmount: 250 })
      expect(line.amount).toBe(amount)
      expect(line.computedAmount).toBe(amount)
      expect(line.flag).toBeNull()
    })
  }

  it('writes the formula she can read under the line', () => {
    expect(one({ serviceId: 'monthly-weekly-transactions-basic' }).formula).toBe(
      '120 transactions x 0.07 x $75/hr = $630.00',
    )
    expect(one({ serviceId: 'cash-flow-weekly' }).formula).toBe(
      '80 total accounts x 0.05 x $125/hr x 4 weeks = $2,000.00',
    )
    expect(one({ serviceId: 'cleanup-reconciliations' }).formula).toBe(
      '20 balance sheet accounts x 0.25 x $75/hr x 6 clean-up months = $2,250.00',
    )
  })
})

describe('the payroll block', () => {
  // A = $115, employees = 10: H = 115 x .05 x 10 = 57.50, T = 115 x .5 = 57.50,
  // bonus = 115 x .13 x 57.50 = 859.625.
  const cases = [
    ['weekly', false, 287.5],
    ['weekly', true, 1147.13],
    ['biweekly', false, 172.5],
    ['biweekly', true, 1032.13],
    ['monthly', false, 115],
    ['monthly', true, 974.63],
  ]
  for (const [payrollRun, includeBonus, amount] of cases) {
    it(`run ${payrollRun}${includeBonus ? ' with bonus' : ''} = ${formatProposalMoney(amount)}`, () => {
      expect(one({ serviceId: 'payroll', payrollRun, includeBonus }).amount).toBe(amount)
    })
  }

  it('defaults to a monthly run and names the run in the formula', () => {
    expect(one({ serviceId: 'payroll' }).amount).toBe(115)
    expect(one({ serviceId: 'payroll', payrollRun: 'biweekly' }).formula).toContain('run bi-weekly')
  })
})

describe('the sales-tax block', () => {
  it('files D x states, divided for quarterly and yearly', () => {
    expect(one({ serviceId: 'sales-tax-monthly' }).amount).toBe(100)
    expect(one({ serviceId: 'sales-tax-quarterly' }).amount).toBe(33.33)
    expect(one({ serviceId: 'sales-tax-yearly' }).amount).toBe(8.33)
  })

  it('adds the review amount D when the review is included', () => {
    const line = one({ serviceId: 'sales-tax-quarterly', includeReview: true })
    expect(line.amount).toBe(83.33)
    expect(line.formula).toBe('$50.00 x 2 states / 3 + review $50.00 = $83.33')
  })
})

describe('multipliers, quantities, flat rows and overrides', () => {
  it('a typed quantity beats the input for a per-count row (her "__" blanks)', () => {
    expect(one({ serviceId: 'budget', quantity: 2 }).amount).toBe(500)
    expect(one({ serviceId: 'budget' }).amount).toBe(1000)
  })

  it('a flat row is the typed amount, and $0.00 when nothing is typed', () => {
    expect(one({ serviceId: 'payroll-setup', flatAmount: 400 }).formula).toBe('Flat $400.00')
    expect(one({ serviceId: 'payroll-setup' }).amount).toBe(0)
    expect(one({ serviceId: 'individual-return-multiple-forms', flatAmount: 90 }).amount).toBe(360)
  })

  it('an override replaces the amount and keeps the computed one beside it', () => {
    const line = one({ serviceId: 'reports-monthly-basic', override: 200 })
    expect(line.amount).toBe(200)
    expect(line.computedAmount).toBe(276)
    expect(line.formula).toBe('80 total accounts x 0.03 x $115/hr = $276.00 (price set to $200.00)')
  })

  it('a missing count prices $0.00 rather than NaN', () => {
    expect(one({ serviceId: 'reconciliations' }, { balanceSheetAccounts: undefined }).amount).toBe(0)
  })
})

describe('rows that must never price', () => {
  it('an inactive row never prices', () => {
    const retired = defaultProposalPricing()
    retired.services.find((row) => row.id === 'reconciliations').active = false
    const result = priceProposal({
      catalog: retired,
      rates,
      inputs,
      selections: [{ serviceId: 'reconciliations' }],
    })
    expect(result.lines).toEqual([])
    expect(result.totals.monthly).toBe(0)
  })

  it('an unknown service id is skipped', () => {
    expect(price([{ serviceId: 'not-a-row' }]).lines).toEqual([])
  })

  it('an unknown inputKey prices $0.00 and flags the line', () => {
    const broken = defaultProposalPricing()
    broken.services.find((row) => row.id === 'kpi-reports').inputKey = 'widgets'
    const [line] = priceProposal({
      catalog: broken,
      rates,
      inputs,
      selections: [{ serviceId: 'kpi-reports' }],
    }).lines
    expect(line.amount).toBe(0)
    expect(line.flag).toBe('unknown-input')
  })
})

describe('the four totals', () => {
  it('sums monthly groups, splits annual from one-time, and keeps clean-up apart', () => {
    const { lines, totals } = price([
      { serviceId: 'cleanup-chart-of-accounts' },
      { serviceId: 'monthly-weekly-transactions-basic' },
      { serviceId: 'reconciliations' },
      { serviceId: 'payroll', payrollRun: 'biweekly' },
      { serviceId: 'reports-monthly-basic', override: 200 },
      { serviceId: 'budget' },
      { serviceId: 'payroll-setup', flatAmount: 400 },
      { serviceId: 'cleanup-transactions-basic' },
    ])
    expect(totals).toEqual({ monthly: 1377.5, annual: 1000, oneTime: 400, cleanup: 1861.5 })
    // Catalog order, not selection order.
    expect(lines[0].serviceId).toBe('monthly-weekly-transactions-basic')
    expect(lines.at(-1).serviceId).toBe('cleanup-chart-of-accounts')
  })
})

describe('sanitizeProposalPricing', () => {
  it('is the seed for anything that is not an object', () => {
    expect(sanitizeProposalPricing(null)).toEqual(defaultProposalPricing())
    expect(sanitizeProposalPricing('junk')).toEqual(defaultProposalPricing())
  })

  it('passes the seed through unchanged', () => {
    expect(sanitizeProposalPricing(defaultProposalPricing())).toEqual(defaultProposalPricing())
  })

  it('clamps rates and factors, checks enums, caps strings, drops unknown keys', () => {
    const seed = defaultProposalPricing()
    const clean = sanitizeProposalPricing({
      rates: { bookkeeper: -5, accountant: 5e9, controller: '80', extra: 1 },
      inputs: seed.inputs,
      services: [
        { ...seed.services[0], factor: 500, junk: 1 },
        { ...seed.services[3], role: 'boss', multiplier: 'x9', tier: 'Gold', name: 'x'.repeat(300) },
      ],
      extra: true,
    })
    expect(clean.rates).toEqual({ bookkeeper: 0, accountant: 1e6, controller: 80 })
    expect(Object.keys(clean)).toEqual(['rates', 'inputs', 'services'])
    expect(clean.services[0].factor).toBe(100)
    expect(clean.services[0]).not.toHaveProperty('junk')
    expect(clean.services[1]).toMatchObject({ role: null, multiplier: 'none', tier: null })
    expect(clean.services[1].name).toHaveLength(120)
  })

  it('keeps the first of two rows with one id, and drops rows it cannot place', () => {
    const seed = defaultProposalPricing()
    const clean = sanitizeProposalPricing({
      ...seed,
      services: [
        seed.services[0],
        { ...seed.services[0], name: 'Duplicate' },
        { ...seed.services[1], group: 'Nope' },
        { ...seed.services[2], id: 'Bad Id' },
      ],
    })
    expect(clean.services.map((row) => row.id)).toEqual(['monthly-weekly-transactions-basic'])
  })

  it('retires a row whose input is not in the catalog instead of failing the save', () => {
    const seed = defaultProposalPricing()
    const clean = sanitizeProposalPricing({
      ...seed,
      services: [{ ...seed.services[0], inputKey: 'widgets' }],
    })
    expect(clean.services[0].active).toBe(false)
  })
})
