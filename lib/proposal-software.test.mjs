import { describe, expect, it } from 'vitest'
import {
  MONTHLY_GROUPS,
  PROPOSAL_GROUPS,
  PROPOSAL_PRICING_KINDS,
  SOFTWARE_GROUP,
  defaultProposalPricing,
  isNoChargeLine,
  priceProposal,
  proposalSelectionDefaults,
  sanitizeProposalPricing,
  softwareLocksOf,
} from './proposal-pricing.js'

/**
 * The Software section (featreq-a69a3cc0): QuickBooks plans billed at her cost,
 * a pass-through that is never part of the monthly fee.
 */
const rates = { bookkeeper: 75, accountant: 115, controller: 125 }
const catalog = defaultProposalPricing()
const price = (selections, inputs = {}, extra = {}) =>
  priceProposal({ catalog, rates, inputs, selections, ...extra })
const one = (selection, inputs, extra) => price([selection], inputs, extra).lines[0]
const row = (id) => catalog.services.find((service) => service.id === id)

describe('the groups', () => {
  it('Software is the last group, and the monthly fee names its eight groups explicitly', () => {
    expect(PROPOSAL_GROUPS.at(-1)).toBe('Software')
    expect(SOFTWARE_GROUP).toBe('Software')
    // The old `PROPOSAL_GROUPS.slice(0, 8)` would have swallowed nothing new
    // today, but this pin is what keeps a future group from joining the fee.
    expect([...MONTHLY_GROUPS]).toEqual([
      'Monthly',
      'Reconciliations',
      'AR',
      'AP',
      'Payroll',
      'Sales tax',
      'Reports',
      'Additional reports',
    ])
    expect(MONTHLY_GROUPS).not.toContain('Software')
    expect(PROPOSAL_PRICING_KINDS).toContain('software')
  })
})

describe('software lines price at cost', () => {
  it('a plain plan is its base price, with no markup and no role rate', () => {
    const line = one({ serviceId: 'software-qbo-plus' })
    expect(line.amount).toBe(98)
    expect(line.flag).toBeNull()
    expect(line.formula).toBe('$98.00 per month, at cost')
    // Not touched by the proposal's role rates.
    expect(one({ serviceId: 'software-qbo-plus' }, {}, { rates: { bookkeeper: 0, accountant: 0, controller: 0 } }).amount).toBe(98)
  })

  it('an employee plan adds the per-employee amount: $98 style example from her list', () => {
    const line = one({ serviceId: 'software-workforce-elite' }, { employees: 3 })
    expect(line.amount).toBe(137.15)
    expect(line.formula).toBe('$93.80 + 3 employees x $14.45 = $137.15, at cost')
  })

  it('reads the typed quantity before the proposal employee count', () => {
    const line = one({ serviceId: 'software-qb-time-elite', quantity: 2 }, { employees: 10 })
    expect(line.amount).toBe(60.4)
    expect(line.formula).toBe('$40.00 + 2 employees x $10.20 = $60.40, at cost')
  })

  it('an employee plan with no employee count is its base price', () => {
    const line = one({ serviceId: 'software-workforce-payroll' })
    expect(line.amount).toBe(35)
    expect(line.formula).toBe('$35.00 + 0 employees x $5.95 = $35.00, at cost')
  })

  it('contractor payments: 20 are included, only the additional ones are charged', () => {
    expect(one({ serviceId: 'software-contractor-payments', quantity: 20 }).amount).toBe(17.5)
    expect(one({ serviceId: 'software-contractor-payments', quantity: 5 }).amount).toBe(17.5)
    const line = one({ serviceId: 'software-contractor-payments', quantity: 25 })
    expect(line.amount).toBe(26)
    expect(line.formula).toBe('$17.50 + 5 additional contractors x $1.70 = $26.00, at cost')
  })

  it('contractors read ONLY the typed quantity - inputs.employees never leaks in', () => {
    const line = one({ serviceId: 'software-contractor-payments' }, { employees: 50 })
    expect(line.amount).toBe(17.5)
  })

  it('an override still replaces the amount', () => {
    const line = one({ serviceId: 'software-qbo-plus', override: 90 })
    expect(line.amount).toBe(90)
    expect(line.computedAmount).toBe(98)
  })

  it('a $0 plan (Bill Pay Basic) is a real $0 line, not a flagged one', () => {
    const line = one({ serviceId: 'software-bill-pay-basic' })
    expect(line.amount).toBe(0)
    expect(line.flag).toBeNull()
    expect(isNoChargeLine(line)).toBe(true)
  })

  it('isNoChargeLine is only for an unflagged $0 Software line', () => {
    expect(isNoChargeLine(one({ serviceId: 'software-qbo-plus' }))).toBe(false)
    // A formula row at $0 is still "not yet priced".
    expect(isNoChargeLine(one({ serviceId: 'reconciliations' }, {}, { rates: {} }))).toBe(false)
    // A retired software row is not "no charge".
    const retired = { ...catalog, services: catalog.services.map((s) => (s.id === 'software-qbo-plus' ? { ...s, active: false } : s)) }
    const line = priceProposal({ catalog: retired, rates, inputs: {}, selections: [{ serviceId: 'software-qbo-plus' }] }).lines[0]
    expect(line.flag).toBe('retired')
    expect(isNoChargeLine(line)).toBe(false)
    expect(isNoChargeLine(null)).toBe(false)
  })

  it('the line carries the figures it was priced with', () => {
    const line = one({ serviceId: 'software-qb-time-premium', quantity: 4 })
    expect(line).toMatchObject({ basePrice: 20, unitPrice: 8.5, unitsIncluded: 0, unit: 'employee' })
    expect(line.amount).toBe(54)
  })
})

describe('software never joins the monthly fee', () => {
  it('goes to totals.software and nowhere else', () => {
    const { totals } = price(
      [{ serviceId: 'reconciliations' }, { serviceId: 'software-qbo-plus' }, { serviceId: 'software-qb-time-elite', quantity: 1 }],
      { balanceSheetAccounts: 20 },
    )
    expect(totals).toEqual({ monthly: 375, annual: 0, oneTime: 0, cleanup: 0, software: 148.2 })
  })

  it('a proposal with no software has software: 0', () => {
    expect(price([{ serviceId: 'reconciliations' }], { balanceSheetAccounts: 20 }).totals.software).toBe(0)
  })
})

describe('a sent proposal keeps the software prices it was sent with', () => {
  it('locks override the catalog row for the figures they name', () => {
    const sent = price([{ serviceId: 'software-workforce-elite', quantity: 2 }])
    const locks = softwareLocksOf(sent.lines)
    expect(locks['software-workforce-elite']).toEqual({ basePrice: 93.8, unitPrice: 14.45, unitsIncluded: 0 })
    // QuickBooks raises the price in the catalog.
    const raised = {
      ...catalog,
      services: catalog.services.map((s) =>
        s.id === 'software-workforce-elite' ? { ...s, basePrice: 120, unitPrice: 20 } : s,
      ),
    }
    const repriced = priceProposal({
      catalog: raised,
      rates,
      inputs: {},
      selections: [{ serviceId: 'software-workforce-elite', quantity: 3 }],
      softwareLocks: locks,
    })
    expect(repriced.lines[0].amount).toBe(137.15)
    // Without the locks it follows the catalog.
    const open = priceProposal({
      catalog: raised,
      rates,
      inputs: {},
      selections: [{ serviceId: 'software-workforce-elite', quantity: 3 }],
    })
    expect(open.lines[0].amount).toBe(180)
  })

  it('a line added after sending (no lock) uses the catalog', () => {
    expect(softwareLocksOf([{ serviceId: 'reconciliations', group: 'Monthly' }])).toEqual({})
    expect(softwareLocksOf(undefined)).toEqual({})
  })
})

describe('the seed software rows', () => {
  const software = catalog.services.filter((service) => service.group === 'Software')

  it('are her list, at her prices, all active', () => {
    expect(software.map((s) => [s.name, s.basePrice, s.unitPrice, s.unitsIncluded, s.unit])).toEqual([
      ['QBO Advanced', 238, 0, 0, 'none'],
      ['QBO Plus', 98, 0, 0, 'none'],
      ['QBO Essentials', 59.5, 0, 0, 'none'],
      ['QBO Simple Start', 26.6, 0, 0, 'none'],
      ['QBO Ledger', 10, 0, 0, 'none'],
      ['QBO Workforce Elite', 93.8, 14.45, 0, 'employee'],
      ['QBO Workforce Premium', 61.6, 11.05, 0, 'employee'],
      ['QBO Workforce Payroll', 35, 5.95, 0, 'employee'],
      ['Contractor Payments & 1099 filing', 17.5, 1.7, 20, 'contractor'],
      ['QB Time Elite', 40, 10.2, 0, 'employee'],
      ['QB Time Premium', 20, 8.5, 0, 'employee'],
      ['QB Bill Pay Elite', 31.5, 0, 0, 'none'],
      ['QB Bill Pay Premium', 10.5, 0, 0, 'none'],
      ['QB Bill Pay Basic', 0, 0, 0, 'none'],
    ])
    expect(software.every((s) => s.active && s.pricing === 'software' && s.tier === null && s.inputKey === null)).toBe(true)
    expect(catalog.softwareSeeded).toBe(true)
  })

  it('sort after the 41 existing rows', () => {
    const others = catalog.services.filter((service) => service.group !== 'Software')
    expect(others).toHaveLength(41)
    expect(Math.min(...software.map((s) => s.sortOrder))).toBeGreaterThan(Math.max(...others.map((s) => s.sortOrder)))
  })

  it('prices every software row without a flag', () => {
    for (const service of software) {
      expect(one({ serviceId: service.id, quantity: 25 }, { employees: 25 }).flag).toBeNull()
    }
  })

  it('gives a software row no standard value (the price is its standard)', () => {
    expect(proposalSelectionDefaults(row('software-qbo-plus'))).toEqual({})
  })
})

describe('a stored catalog that predates Software', () => {
  const stored = () => {
    const seed = defaultProposalPricing()
    const { softwareSeeded: _drop, ...rest } = seed
    return { ...rest, services: seed.services.filter((s) => s.group !== 'Software') }
  }

  it('gets the seed software rows appended on read, after its own rows', () => {
    const clean = sanitizeProposalPricing(stored())
    expect(clean.services).toHaveLength(55)
    expect(clean.softwareSeeded).toBe(true)
    expect(clean.services.filter((s) => s.group === 'Software')).toHaveLength(14)
    expect(clean.services.slice(0, 41).every((s) => s.group !== 'Software')).toBe(true)
  })

  it('once flagged, a row she deleted or retired stays that way', () => {
    const flagged = sanitizeProposalPricing(stored())
    const without = {
      ...flagged,
      services: flagged.services.filter((s) => s.id !== 'software-qbo-ledger').map((s) =>
        s.id === 'software-qbo-plus' ? { ...s, active: false } : s,
      ),
    }
    const again = sanitizeProposalPricing(without)
    expect(again.services.some((s) => s.id === 'software-qbo-ledger')).toBe(false)
    expect(again.services.find((s) => s.id === 'software-qbo-plus').active).toBe(false)
    expect(again.services).toHaveLength(54)
  })

  it('does not duplicate a software row the stored catalog already has, and keeps her price', () => {
    const base = stored()
    base.services.push({ ...defaultProposalPricing().services.find((s) => s.id === 'software-qbo-plus'), basePrice: 120 })
    const clean = sanitizeProposalPricing(base)
    const plus = clean.services.filter((s) => s.id === 'software-qbo-plus')
    expect(plus).toHaveLength(1)
    expect(plus[0].basePrice).toBe(120)
    expect(clean.services).toHaveLength(55)
  })

  it('the appended rows never collide with her sort order', () => {
    const base = stored()
    base.services[base.services.length - 1].sortOrder = 900
    const clean = sanitizeProposalPricing(base)
    const appended = clean.services.filter((s) => s.group === 'Software')
    expect(Math.min(...appended.map((s) => s.sortOrder))).toBeGreaterThan(900)
  })
})

describe('sanitizeProposalPricing and software rows', () => {
  const plus = () => ({ ...defaultProposalPricing().services.find((s) => s.id === 'software-qbo-plus') })
  const clean = (service) =>
    sanitizeProposalPricing({ ...defaultProposalPricing(), services: [service] }).services.find((s) => s.id === service.id)

  it('keeps the figures and clamps them to [0, 1e6] (included to a whole count)', () => {
    expect(clean({ ...plus(), basePrice: 150.5, unitPrice: 4, unitsIncluded: 3.7, unit: 'employee' })).toMatchObject({
      basePrice: 150.5,
      unitPrice: 4,
      unitsIncluded: 3,
      unit: 'employee',
    })
    expect(clean({ ...plus(), basePrice: -4, unitPrice: 5e9, unitsIncluded: 'x' })).toMatchObject({
      basePrice: 0,
      unitPrice: 1e6,
      unitsIncluded: 0,
    })
    expect(clean({ ...plus(), unit: 'lightyear' }).unit).toBe('none')
  })

  it('a software row needs no input and stays active', () => {
    expect(clean({ ...plus(), inputKey: 'widgets' })).toMatchObject({ inputKey: null, active: true })
  })

  it('a row in the Software group is always the software kind, and the software kind always lives there', () => {
    expect(clean({ ...plus(), pricing: 'formula' }).pricing).toBe('software')
    const moved = clean({ ...plus(), group: 'Monthly' })
    expect(moved).toMatchObject({ group: 'Software', pricing: 'software' })
  })

  it('a non-software row carries no software figures', () => {
    const seed = defaultProposalPricing()
    const reconciliations = sanitizeProposalPricing(seed).services.find((s) => s.id === 'reconciliations')
    expect(reconciliations).not.toHaveProperty('basePrice')
    expect(reconciliations).not.toHaveProperty('unit')
  })

  it('the seed passes through unchanged', () => {
    expect(sanitizeProposalPricing(defaultProposalPricing())).toEqual(defaultProposalPricing())
  })
})
