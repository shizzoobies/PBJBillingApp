import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  defaultProposalPricing,
  hoursByRoleOf,
  priceProposal,
  roundCents,
  snapshotHoursByRole,
} from './proposal-pricing.js'

/**
 * Who does each priced line's work and how many hours a month it takes
 * (docs/plans/engagements-2026-10.md 2A): `role` and `hours` on every line and
 * `hoursByRole` beside the totals, so a signed engagement can set the client's
 * estimated hours by team. Additive: the money is untouched.
 */

const catalog = defaultProposalPricing()
const inputs = {
  transactions: 200,
  balanceSheetAccounts: 20,
  totalAccounts: 40,
  plAccounts: 30,
  invoicesPerWeekAR: 10,
  employees: 10,
  salesTaxReviewAmount: 25,
  states: 2,
  cleanupMonths: 6,
  clientCallHours: 2,
}
const price = (selections, over = {}) =>
  priceProposal({ catalog, rates: catalog.rates, inputs: { ...inputs, ...over }, selections })
const one = (selection, over) => price([selection], over).lines[0]

describe('role and hours on each priced line', () => {
  it('formula kind: the row role, hours = count x factor x multiplier', () => {
    expect(one({ serviceId: 'reconciliations' })).toMatchObject({ role: 'bookkeeper', hours: 5, amount: 375 })
    expect(one({ serviceId: 'ar-prepare-invoices' })).toMatchObject({ role: 'accountant', hours: 1.3 })
    expect(one({ serviceId: 'cash-flow-weekly' })).toMatchObject({ role: 'controller', hours: 8 })
    expect(one({ serviceId: 'reports-quarterly-basic' })).toMatchObject({ role: 'accountant', hours: 0.4 })
    expect(one({ serviceId: 'client-call' })).toMatchObject({ role: 'controller', hours: 2, amount: 250 })
    expect(one({ serviceId: 'cleanup-transactions-basic' })).toMatchObject({ role: 'bookkeeper', hours: 36 })
    expect(one({ serviceId: 'budget', quantity: 4 })).toMatchObject({ role: 'controller', hours: 6 })
    expect(one({ serviceId: 'budget' })).toMatchObject({ hours: 0, flag: 'needs-count' })
  })

  it('a formula line prices its hours at the role rate (hours are rounded to two decimals)', () => {
    const { lines } = price(
      catalog.services
        .filter((service) => service.pricing === 'formula' && service.multiplier !== 'per-count')
        .map((service) => ({ serviceId: service.id })),
    )
    expect(lines.length).toBeGreaterThan(20)
    for (const line of lines) {
      const rate = catalog.rates[line.role]
      // A third of an hour is 0.33 h, so the dollars can differ by half a cent of an hour.
      expect(Math.abs(line.amount - line.hours * rate), line.serviceId).toBeLessThanOrEqual(rate * 0.005 + 0.005)
    }
    const exact = lines.find((line) => line.serviceId === 'reconciliations')
    expect(exact.amount).toBe(roundCents(exact.hours * catalog.rates.bookkeeper))
  })

  it('payroll: factor x employees x runs plus the taxes half hour; the bonus adds no hours', () => {
    expect(one({ serviceId: 'payroll' })).toMatchObject({ role: 'accountant', hours: 1 })
    expect(one({ serviceId: 'payroll', payrollRun: 'biweekly' })).toMatchObject({ hours: 1.5 })
    expect(one({ serviceId: 'payroll', payrollRun: 'weekly', includeBonus: true })).toMatchObject({ hours: 2.5 })
    expect(one({ serviceId: 'payroll' }, { employees: 0 })).toMatchObject({ hours: 0.5 })
  })

  it('sales tax keeps its row role but has no hours (it is priced in dollars)', () => {
    expect(one({ serviceId: 'sales-tax-monthly' })).toMatchObject({ role: null, hours: null, amount: 50 })
    const withRole = {
      ...catalog,
      services: catalog.services.map((service) =>
        service.id === 'sales-tax-quarterly' ? { ...service, role: 'accountant' } : service,
      ),
    }
    const line = priceProposal({
      catalog: withRole,
      rates: catalog.rates,
      inputs,
      selections: [{ serviceId: 'sales-tax-quarterly' }],
    }).lines[0]
    expect(line).toMatchObject({ role: 'accountant', hours: null })
  })

  it('flat, software and retired lines have no role and no hours', () => {
    expect(one({ serviceId: 'payroll-setup', flatAmount: 400 })).toMatchObject({ role: null, hours: null })
    expect(one({ serviceId: 'software-qbo-plus' })).toMatchObject({ role: null, hours: null })
    expect(one({ serviceId: 'no-such-row' })).toMatchObject({ flag: 'retired', role: null, hours: null })
  })

  it('an override moves the price, not the hours; a missing rate does not hide the hours', () => {
    expect(one({ serviceId: 'reconciliations', override: 500 })).toMatchObject({ amount: 500, hours: 5 })
    const unpriced = priceProposal({
      catalog,
      rates: { bookkeeper: 0, accountant: 0, controller: 0 },
      inputs,
      selections: [{ serviceId: 'reconciliations' }],
    }).lines[0]
    expect(unpriced).toMatchObject({ flag: 'no-rate', amount: 0, role: 'bookkeeper', hours: 5 })
  })

  it('a row whose input the catalog lacks has no hours', () => {
    const broken = {
      ...catalog,
      inputs: catalog.inputs.filter((input) => input.key !== 'balanceSheetAccounts'),
    }
    const line = priceProposal({ catalog: broken, rates: catalog.rates, inputs, selections: [{ serviceId: 'reconciliations' }] })
      .lines[0]
    expect(line).toMatchObject({ flag: 'unknown-input', role: 'bookkeeper', hours: null })
  })
})

describe('count: the number a line is priced per', () => {
  it('per-* multipliers carry their count; payroll its employees; sales tax its states', () => {
    expect(one({ serviceId: 'cleanup-transactions-basic' }).count).toBe(6)
    expect(one({ serviceId: 'cleanup-reconciliations', quantity: 2 }).count).toBe(2)
    expect(one({ serviceId: 'reports-needed-basic' }, { reportsNeeded: 3 }).count).toBe(3)
    expect(one({ serviceId: 'individual-return-multiple-forms', flatAmount: 50 }, { forms: 4 }).count).toBe(4)
    expect(one({ serviceId: 'budget', quantity: 4 }).count).toBe(4)
    expect(one({ serviceId: 'budget' }).count).toBeNull()
    expect(one({ serviceId: 'payroll' }).count).toBe(10)
    expect(one({ serviceId: 'sales-tax-quarterly' }).count).toBe(2)
    expect(one({ serviceId: 'cleanup-transactions-basic' }, { cleanupMonths: 0 }).count).toBe(0)
  })

  it('null where the line is not priced per anything', () => {
    for (const selection of [
      { serviceId: 'reconciliations' },
      { serviceId: 'cash-flow-weekly' },
      { serviceId: 'reports-quarterly-basic' },
      { serviceId: 'cleanup-chart-of-accounts' },
      { serviceId: 'payroll-setup', flatAmount: 400 },
      { serviceId: 'software-qb-time-elite', quantity: 3 },
      { serviceId: 'no-such-row' },
    ]) {
      expect(one(selection).count, selection.serviceId).toBeNull()
    }
  })

  it('a line not yet priced (no rate) still says its count', () => {
    const line = priceProposal({
      catalog,
      rates: { bookkeeper: 0, accountant: 0, controller: 0 },
      inputs,
      selections: [{ serviceId: 'cleanup-transactions-basic' }],
    }).lines[0]
    expect(line).toMatchObject({ flag: 'no-rate', count: 6 })
  })
})

describe('the money is unchanged (golden output of 8e52181, before role/hours/count)', () => {
  const golden = JSON.parse(readFileSync('lib/proposal-pricing.golden.json', 'utf8'))

  it('covers every catalog row', () => {
    const priced = new Set(golden.results.flatMap((result) => result.lines.map((line) => line.serviceId)))
    for (const service of catalog.services) expect(priced.has(service.id), service.id).toBe(true)
  })

  for (const [index, scenario] of golden.scenarios.entries()) {
    it(scenario.name, () => {
      const base = scenario.dropInput
        ? { ...catalog, inputs: catalog.inputs.filter((input) => input.key !== scenario.dropInput) }
        : catalog
      const now = priceProposal({
        catalog: base,
        rates: scenario.rates,
        inputs: scenario.inputs,
        selections: scenario.selections,
      })
      const before = golden.results[index]
      expect(now.totals).toEqual(before.totals)
      expect(now.lines.map(({ role: _r, hours: _h, count: _c, ...line }) => line)).toEqual(before.lines)
    })
  }
})

describe('hoursByRole', () => {
  it('sums the monthly lines per role, beside the totals (which stay money only)', () => {
    const result = price([
      { serviceId: 'reconciliations' }, // bookkeeper 5
      { serviceId: 'ar-prepare-invoices' }, // accountant 1.3
      { serviceId: 'reports-quarterly-basic' }, // accountant 0.4
      { serviceId: 'payroll', payrollRun: 'biweekly' }, // accountant 1.5
      { serviceId: 'cash-flow-weekly' }, // controller 8
      { serviceId: 'client-call' }, // controller 2
      { serviceId: 'sales-tax-monthly' }, // no hours
      { serviceId: 'cleanup-transactions-basic' }, // clean-up: not monthly
      { serviceId: 'budget', quantity: 4 }, // annual: not monthly
      { serviceId: 'software-qbo-plus' },
    ])
    expect(result.hoursByRole).toEqual({ bookkeeper: 5, accountant: 3.2, controller: 10 })
    expect(Object.keys(result.totals)).toEqual(['monthly', 'annual', 'oneTime', 'cleanup', 'software'])
  })

  it('is all zeros with nothing selected', () => {
    expect(price([]).hoursByRole).toEqual({ bookkeeper: 0, accountant: 0, controller: 0 })
    expect(priceProposal().hoursByRole).toEqual({ bookkeeper: 0, accountant: 0, controller: 0 })
  })

  it('hoursByRoleOf reads lines defensively', () => {
    expect(
      hoursByRoleOf([
        { group: 'Monthly', role: 'bookkeeper', hours: 1.111 },
        { group: 'Monthly', role: 'bookkeeper', hours: 2.222 },
        { group: 'Monthly', role: 'owner', hours: 5 },
        { group: 'Monthly', role: 'accountant', hours: '4' },
        { group: 'Monthly', role: 'accountant', hours: Number.NaN },
        { group: 'Clean-up', role: 'controller', hours: 9 },
        null,
      ]),
    ).toEqual({ bookkeeper: 3.33, accountant: 0, controller: 0 })
    expect(hoursByRoleOf('junk')).toEqual({ bookkeeper: 0, accountant: 0, controller: 0 })
  })
})

describe('snapshotHoursByRole (stored snapshots, old and new)', () => {
  it('reads a new snapshot priced through priceProposal', () => {
    const { lines, totals, hoursByRole } = price([{ serviceId: 'reconciliations' }, { serviceId: 'client-call' }])
    const snapshot = { rates: catalog.rates, lines, totals, hoursByRole, catalogAt: '2026-10-11T12:00:00.000Z' }
    expect(snapshotHoursByRole(JSON.parse(JSON.stringify(snapshot)))).toEqual({
      bookkeeper: 5,
      accountant: 0,
      controller: 2,
    })
  })

  it('an old snapshot without hours reads as zeros, never throws', () => {
    const old = {
      lines: [{ serviceId: 'reconciliations', group: 'Reconciliations', amount: 375, flag: null }],
      totals: { monthly: 375, annual: 0, oneTime: 0, cleanup: 0 },
    }
    expect(snapshotHoursByRole(old)).toEqual({ bookkeeper: 0, accountant: 0, controller: 0 })
    for (const junk of [null, undefined, 7, 'x', {}, { lines: 'x' }, { hoursByRole: [1] }]) {
      expect(snapshotHoursByRole(junk)).toEqual({ bookkeeper: 0, accountant: 0, controller: 0 })
    }
  })

  it('cleans a stored hoursByRole, and also accepts one kept under totals', () => {
    expect(snapshotHoursByRole({ hoursByRole: { bookkeeper: '4.567', accountant: -2, controller: 'x' } })).toEqual({
      bookkeeper: 4.57,
      accountant: 0,
      controller: 0,
    })
    expect(snapshotHoursByRole({ totals: { monthly: 1, hoursByRole: { controller: 3 } } })).toEqual({
      bookkeeper: 0,
      accountant: 0,
      controller: 3,
    })
  })

  it('sums the lines when only they carry hours', () => {
    expect(
      snapshotHoursByRole({ lines: [{ group: 'AP', role: 'controller', hours: 1.5 }, { group: 'AR', role: 'bookkeeper', hours: 2 }] }),
    ).toEqual({ bookkeeper: 2, accountant: 0, controller: 1.5 })
  })
})
