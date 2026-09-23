import { describe, expect, it } from 'vitest'
import { buildInvoiceLines } from './invoice-lines.js'

const employees = [
  { id: 'emp-lisa', name: 'Lisa', billRate: 55 },
  { id: 'emp-none', name: 'Nobody' },
]

const client = (overrides = {}) => ({
  id: 'c1',
  name: 'Acme',
  billingMode: 'hourly',
  hourlyRate: 100,
  ...overrides,
})

// The date is a parameter because one case below bills a JUNE period, and an
// entry only bills in the period its own date falls in.
const entries = (clientId, date = '2026-09-10') => [
  { id: 't1', clientId, employeeId: 'emp-lisa', minutes: 60, billable: true, date },
]

const billRateVersions = [
  { userId: 'emp-lisa', effectivePeriod: '2026-06', rate: 40 },
  { userId: 'emp-lisa', effectivePeriod: '2026-09', rate: 55 },
]

describe('buildInvoiceLines with rate versions', () => {
  it('bills two clients on different pins at different rates in the SAME period', () => {
    const oldPin = buildInvoiceLines({
      client: client({ id: 'c-old' }),
      entries: entries('c-old'),
      billingPeriod: '2026-09',
      employees,
      defaultHourlyRate: 100,
      billRateVersions,
      ratePeriod: '2026-06',
    })
    const newPin = buildInvoiceLines({
      client: client({ id: 'c-new' }),
      entries: entries('c-new'),
      billingPeriod: '2026-09',
      employees,
      defaultHourlyRate: 100,
      billRateVersions,
      ratePeriod: '2026-09',
    })
    expect(oldPin.lines[0].rate).toBe(40)
    expect(oldPin.lines[0].amount).toBe(40)
    expect(newPin.lines[0].rate).toBe(55)
    expect(newPin.lines[0].amount).toBe(55)
  })

  it('falls back to the billing period when no pin is given', () => {
    const built = buildInvoiceLines({
      client: client(),
      entries: entries('c1', '2026-06-10'),
      billingPeriod: '2026-06',
      employees,
      defaultHourlyRate: 100,
      billRateVersions,
    })
    expect(built.lines[0].rate).toBe(40)
  })

  it('falls back to the employee’s own billRate when they have no version', () => {
    const built = buildInvoiceLines({
      client: client(),
      entries: entries('c1'),
      billingPeriod: '2026-09',
      employees,
      defaultHourlyRate: 100,
      billRateVersions: [],
      ratePeriod: '2026-09',
    })
    expect(built.lines[0].rate).toBe(55)
  })

  it('falls back to the client’s own rate when there is neither', () => {
    const built = buildInvoiceLines({
      client: client(),
      entries: [
        { id: 't1', clientId: 'c1', employeeId: 'emp-none', minutes: 60, billable: true, date: '2026-09-10' },
      ],
      billingPeriod: '2026-09',
      employees,
      defaultHourlyRate: 100,
    })
    expect(built.lines[0].rate).toBe(100)
  })

  it('prices ad hoc work at the pin too', () => {
    const built = buildInvoiceLines({
      client: client(),
      entries: [
        {
          id: 't1',
          clientId: 'c1',
          employeeId: 'emp-lisa',
          minutes: 60,
          billable: true,
          date: '2026-09-10',
          description: 'One-off',
          isAdhoc: true,
        },
      ],
      billingPeriod: '2026-09',
      employees,
      defaultHourlyRate: 100,
      billRateVersions,
      ratePeriod: '2026-06',
    })
    const adhoc = built.lines.find((line) => line.kind === 'adhoc')
    expect(adhoc.amount).toBe(40)
    expect(adhoc.detail).toContain('$40.00/hr')
  })

  it('holds a person’s FIRST rate until the client’s review, never their newest', () => {
    // Every production hourly client is pinned at 2026-06. Jane got her first
    // rate in October and a raise for January; her live `billRate` mirrors the
    // January raise. Sam's only version starts in 2027. Lisa has a June rate.
    const staff = [
      { id: 'emp-jane', name: 'Jane', billRate: 70 },
      { id: 'emp-sam', name: 'Sam', billRate: 80 },
      { id: 'emp-lisa', name: 'Lisa', billRate: 55 },
    ]
    const versions = [
      ...billRateVersions,
      { userId: 'emp-jane', effectivePeriod: '2026-10', rate: 60 },
      { userId: 'emp-jane', effectivePeriod: '2027-01', rate: 70 },
      { userId: 'emp-sam', effectivePeriod: '2027-02', rate: 80 },
    ]
    const built = buildInvoiceLines({
      client: client({ hourlyRatePeriod: '2026-06' }),
      entries: ['emp-jane', 'emp-sam', 'emp-lisa'].map((employeeId, index) => ({
        id: `t${index}`,
        clientId: 'c1',
        employeeId,
        minutes: 60,
        billable: true,
        date: '2026-11-10',
      })),
      billingPeriod: '2026-11',
      employees: staff,
      defaultHourlyRate: 100,
      billRateVersions: versions,
      ratePeriod: '2026-06',
    })
    const rateOf = (name) => built.lines.find((line) => line.label.includes(name))?.rate
    expect(rateOf('Jane')).toBe(60)
    expect(rateOf('Sam')).toBe(100)
    expect(rateOf('Lisa')).toBe(40)
  })

  it('leaves the pre-cutover legacy branch alone', () => {
    const built = buildInvoiceLines({
      client: client(),
      entries: [
        { id: 't1', clientId: 'c1', employeeId: 'emp-lisa', minutes: 60, billable: true, date: '2026-05-10' },
      ],
      billingPeriod: '2026-05',
      employees,
      defaultHourlyRate: 100,
      billRateVersions,
      ratePeriod: '2026-06',
    })
    expect(built.lines[0].label).toBe('Billable hours')
    expect(built.lines[0].amount).toBe(100)
  })
})
