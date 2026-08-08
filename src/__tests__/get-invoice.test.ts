import { describe, expect, it } from 'vitest'
import { getInvoice } from '../lib/utils'
import type {
  Client,
  Employee,
  RecurringReimbursement,
  Reimbursement,
  SubscriptionPlan,
  TimeEntry,
} from '../lib/types'

/**
 * getInvoice billing model: a Monthly (subscription-mode) client bills its
 * OWN `monthlyRate` — there is no included-hours / overage math, and the
 * tracked billable hours must NOT change the total. The line is labeled with
 * the subscribed plan/service names (or "Monthly service" when none).
 */

const plans: SubscriptionPlan[] = [
  { id: 'plan-a', name: 'Monthly Close', notes: '' },
  { id: 'plan-b', name: 'Payroll', notes: '' },
]

function makeClient(overrides: Partial<Client>): Client {
  return {
    id: 'client-1',
    name: 'Acme',
    contact: 'A. Person',
    billingMode: 'hourly',
    hourlyRate: 100,
    planIds: [],
    contactIds: [],
    ...overrides,
  }
}

// June 2026 is on/after the per-employee billing cutover, so hourly tests here
// exercise the per-employee path. A separate describe below covers pre-cutover.
const period = '2026-06'

const entry: TimeEntry = {
  id: 'time-1',
  employeeId: 'emp-1',
  clientId: 'client-1',
  date: '2026-06-10',
  minutes: 600, // 10h — would have created overage under the old model
  description: 'Work',
  billable: true,
  approvalStatus: 'approved',
  entryMethod: 'timer',
}

describe('getInvoice — monthly billing', () => {
  it('uses the client monthlyRate verbatim and ignores tracked hours', () => {
    const client = makeClient({
      billingMode: 'subscription',
      monthlyRate: 1850,
      planIds: ['plan-a'],
    })
    const invoice = getInvoice(client, [entry], plans, period)
    expect(invoice.total).toBe(1850)
    expect(invoice.lines).toHaveLength(1)
    expect(invoice.lines[0].amount).toBe(1850)
    expect(invoice.lines[0].label).toBe('Monthly Close')
  })

  it('joins multiple plan names on the monthly line', () => {
    const client = makeClient({
      billingMode: 'subscription',
      monthlyRate: 1200,
      planIds: ['plan-a', 'plan-b'],
    })
    const invoice = getInvoice(client, [], plans, period)
    expect(invoice.lines[0].label).toBe('Monthly Close, Payroll')
    expect(invoice.total).toBe(1200)
  })

  it('labels the line "Monthly service" when no plans are selected', () => {
    const client = makeClient({ billingMode: 'subscription', monthlyRate: 500, planIds: [] })
    const invoice = getInvoice(client, [], plans, period)
    expect(invoice.lines[0].label).toBe('Monthly service')
    expect(invoice.total).toBe(500)
  })

  it('treats a missing monthlyRate as 0', () => {
    const client = makeClient({ billingMode: 'subscription', planIds: ['plan-a'] })
    const invoice = getInvoice(client, [entry], plans, period)
    expect(invoice.total).toBe(0)
  })

  it('hourly clients bill tracked billable hours at the employee bill rate', () => {
    const client = makeClient({ billingMode: 'hourly' })
    const employees: Employee[] = [{ id: 'emp-1', name: 'Alice', role: 'Bookkeeper', billRate: 100 }]
    const invoice = getInvoice(client, [entry], plans, period, [], [], employees, 0)
    // 600 minutes = 10h * $100 = $1000
    expect(invoice.total).toBe(1000)
    expect(invoice.lines).toHaveLength(1)
    expect(invoice.lines[0].label).toBe('Billable hours — Alice')
  })
})

describe('getInvoice — hourly billing (per-employee bill rate)', () => {
  const employees: Employee[] = [
    { id: 'emp-1', name: 'Alice', role: 'Bookkeeper', billRate: 100 },
    { id: 'emp-2', name: 'Bob', role: 'Accountant', billRate: 200 },
    { id: 'emp-3', name: 'Carol', role: 'Bookkeeper', billRate: null },
  ]

  const makeEntry = (overrides: Partial<TimeEntry>): TimeEntry => ({
    id: 'time-x',
    employeeId: 'emp-1',
    clientId: 'client-1',
    date: '2026-06-10',
    minutes: 60,
    description: 'Work',
    billable: true,
    approvalStatus: 'approved',
    entryMethod: 'timer',
    ...overrides,
  })

  it('bills each employee at their own bill rate with one line per employee', () => {
    const client = makeClient({ billingMode: 'hourly' })
    const entries = [
      makeEntry({ id: 'a', employeeId: 'emp-1', minutes: 120 }), // 2h * $100 = $200
      makeEntry({ id: 'b', employeeId: 'emp-2', minutes: 90 }), // 1.5h * $200 = $300
    ]
    const invoice = getInvoice(client, entries, plans, period, [], [], employees, 50)
    expect(invoice.total).toBe(500)
    expect(invoice.lines).toHaveLength(2)
    // Lines are sorted by label: Alice then Bob.
    expect(invoice.lines[0].label).toBe('Billable hours — Alice')
    expect(invoice.lines[0].amount).toBe(200)
    expect(invoice.lines[1].label).toBe('Billable hours — Bob')
    expect(invoice.lines[1].amount).toBe(300)
  })

  it('falls back to the default hourly rate for an employee with no bill rate', () => {
    const client = makeClient({ billingMode: 'hourly' })
    const entries = [makeEntry({ id: 'c', employeeId: 'emp-3', minutes: 120 })] // 2h * $75 default
    const invoice = getInvoice(client, entries, plans, period, [], [], employees, 75)
    expect(invoice.total).toBe(150)
    expect(invoice.lines[0].label).toBe('Billable hours — Carol')
    expect(invoice.lines[0].amount).toBe(150)
  })

  it('sums an employee\'s minutes across multiple entries into one line', () => {
    const client = makeClient({ billingMode: 'hourly' })
    const entries = [
      makeEntry({ id: 'd', employeeId: 'emp-1', minutes: 60 }),
      makeEntry({ id: 'e', employeeId: 'emp-1', minutes: 30 }),
    ]
    const invoice = getInvoice(client, entries, plans, period, [], [], employees, 0)
    expect(invoice.lines).toHaveLength(1)
    // 1.5h * $100 = $150
    expect(invoice.total).toBe(150)
  })

  it('subscription billing ignores employee bill rates (unaffected)', () => {
    const client = makeClient({ billingMode: 'subscription', monthlyRate: 1850, planIds: ['plan-a'] })
    const entries = [makeEntry({ employeeId: 'emp-2', minutes: 600 })]
    const invoice = getInvoice(client, entries, plans, period, [], [], employees, 999)
    expect(invoice.total).toBe(1850)
  })

  it('annual billing ignores employee bill rates (unaffected)', () => {
    const client = makeClient({ billingMode: 'annual', annualRate: 6000, annualBillingMonth: 5 })
    const entries = [makeEntry({ employeeId: 'emp-2', minutes: 600 })]
    const invoice = getInvoice(client, entries, plans, '2026-05', [], [], employees, 999)
    expect(invoice.total).toBe(6000)
  })
})

describe('getInvoice — hourly billing cutover (historical stays exact)', () => {
  // An employee with a deliberately different bill rate, to prove pre-cutover
  // months ignore it and use the per-client rate.
  const employees: Employee[] = [
    { id: 'emp-1', name: 'Alice', role: 'Bookkeeper', billRate: 999 },
  ]
  const tenHours = (date: string): TimeEntry => ({
    id: `e-${date}`,
    employeeId: 'emp-1',
    clientId: 'client-1',
    date,
    minutes: 600, // 10h
    description: 'Work',
    billable: true,
    approvalStatus: 'approved',
    entryMethod: 'timer',
  })

  it('bills a PRE-cutover month at the per-CLIENT rate, ignoring employee bill rates', () => {
    const client = makeClient({ billingMode: 'hourly', hourlyRate: 90 })
    const invoice = getInvoice(client, [tenHours('2026-05-10')], plans, '2026-05', [], [], employees, 0)
    // 10h * $90 (client's stored rate) = $900 — NOT 10h * $999 (employee rate).
    expect(invoice.total).toBe(900)
    expect(invoice.lines).toHaveLength(1)
    expect(invoice.lines[0].label).toBe('Billable hours')
    expect(invoice.lines[0].detail).toContain('$90')
  })

  it('bills the SAME client+hours per-employee on/after the cutover', () => {
    const client = makeClient({ billingMode: 'hourly', hourlyRate: 90 })
    const invoice = getInvoice(client, [tenHours('2026-06-10')], plans, '2026-06', [], [], employees, 0)
    // 10h * $999 (Alice's bill rate) = $9990.
    expect(invoice.total).toBe(9990)
    expect(invoice.lines[0].label).toBe('Billable hours — Alice')
  })
})

describe('getInvoice — annual billing', () => {
  it('charges the flat annual fee only in the chosen billing month', () => {
    const client = makeClient({
      billingMode: 'annual',
      annualRate: 6000,
      annualBillingMonth: 5, // May — matches the period
    })
    const invoice = getInvoice(client, [entry], plans, '2026-05')
    expect(invoice.total).toBe(6000)
    expect(invoice.lines).toHaveLength(1)
    expect(invoice.lines[0].amount).toBe(6000)
    expect(invoice.lines[0].detail).toContain('May')
  })

  it('shows no subscription charge in non-billing months', () => {
    const client = makeClient({
      billingMode: 'annual',
      annualRate: 6000,
      annualBillingMonth: 1, // January — period is May
    })
    const invoice = getInvoice(client, [entry], plans, '2026-05')
    expect(invoice.total).toBe(0)
    expect(invoice.lines).toHaveLength(0)
  })

  it('ignores tracked billable hours entirely (flat fee only)', () => {
    const client = makeClient({
      billingMode: 'annual',
      annualRate: 1200,
      annualBillingMonth: 5,
    })
    const invoice = getInvoice(client, [entry, entry], plans, '2026-05')
    expect(invoice.total).toBe(1200)
  })

  it('defaults to January when annualBillingMonth is unset', () => {
    const client = makeClient({ billingMode: 'annual', annualRate: 900 })
    expect(getInvoice(client, [], plans, '2026-01').total).toBe(900)
    expect(getInvoice(client, [], plans, '2026-02').total).toBe(0)
  })

  it('labels the annual line with the service tier or plan names', () => {
    const tierClient = makeClient({
      billingMode: 'annual',
      annualRate: 500,
      annualBillingMonth: 5,
      monthlyServiceTier: 'The Classic',
    })
    expect(getInvoice(tierClient, [], plans, '2026-05').lines[0].label).toBe('The Classic')

    const planClient = makeClient({
      billingMode: 'annual',
      annualRate: 500,
      annualBillingMonth: 5,
      planIds: ['plan-a'],
    })
    expect(getInvoice(planClient, [], plans, '2026-05').lines[0].label).toBe('Monthly Close')

    const bareClient = makeClient({ billingMode: 'annual', annualRate: 500, annualBillingMonth: 5 })
    expect(getInvoice(bareClient, [], plans, '2026-05').lines[0].label).toBe('Annual service')
  })

  it('treats a missing annualRate as 0 in the billing month', () => {
    const client = makeClient({ billingMode: 'annual', annualBillingMonth: 5 })
    const invoice = getInvoice(client, [], plans, '2026-05')
    expect(invoice.total).toBe(0)
    expect(invoice.lines).toHaveLength(1)
  })
})

/**
 * Reimbursement + recurring-reimbursement lines. These were the ONLY part of
 * getInvoice with no coverage, and they are money on a client-facing invoice —
 * so they are pinned here before the line builder moves into `lib/` to be
 * shared with the server-side generator (I1). The point is that extracting the
 * builder changes nothing: if these still pass afterwards, the move was safe.
 */
describe('getInvoice — reimbursements', () => {
  const reimb = (over: Partial<Reimbursement> = {}): Reimbursement => ({
    id: 'r-1',
    clientId: 'client-1',
    date: '2026-06-15',
    description: 'Filing fee',
    amount: 125,
    ...over,
  })

  const recurring = (over: Partial<RecurringReimbursement> = {}): RecurringReimbursement => ({
    id: 'rr-1',
    clientId: 'client-1',
    description: 'Software',
    amount: 40,
    frequency: 'monthly',
    startDate: '2026-01-01',
    ...over,
  })

  it('adds one line per reimbursement in the period, and to the total', () => {
    const client = makeClient({ billingMode: 'subscription', monthlyRate: 500 })
    const invoice = getInvoice(client, [], plans, period, [reimb()])
    expect(invoice.lines).toHaveLength(2)
    expect(invoice.lines[1].label).toBe('Reimbursement: Filing fee')
    expect(invoice.lines[1].amount).toBe(125)
    expect(invoice.total).toBe(625)
  })

  it('excludes reimbursements from other clients and other periods', () => {
    const client = makeClient({ billingMode: 'subscription', monthlyRate: 500 })
    const invoice = getInvoice(client, [], plans, period, [
      reimb({ id: 'r-2', clientId: 'client-other' }),
      reimb({ id: 'r-3', date: '2026-05-31' }),
      reimb({ id: 'r-4', date: '2026-07-01' }),
    ])
    expect(invoice.lines).toHaveLength(1)
    expect(invoice.total).toBe(500)
  })

  it('sorts reimbursement lines by date', () => {
    const client = makeClient({ billingMode: 'subscription', monthlyRate: 0 })
    const invoice = getInvoice(client, [], plans, period, [
      reimb({ id: 'r-b', date: '2026-06-20', description: 'Later' }),
      reimb({ id: 'r-a', date: '2026-06-02', description: 'Earlier' }),
    ])
    expect(invoice.lines.map((line) => line.label)).toEqual([
      'Monthly service',
      'Reimbursement: Earlier',
      'Reimbursement: Later',
    ])
  })

  it('adds a recurring line when its cadence lands on the period', () => {
    const client = makeClient({ billingMode: 'subscription', monthlyRate: 500 })
    const invoice = getInvoice(client, [], plans, period, [], [recurring()])
    expect(invoice.lines[1].label).toBe('Recurring: Software')
    expect(invoice.lines[1].detail).toBe('monthly')
    expect(invoice.total).toBe(540)
  })

  it('omits a quarterly recurring line on an off-cadence month', () => {
    const client = makeClient({ billingMode: 'subscription', monthlyRate: 500 })
    const quarterly = recurring({ frequency: 'quarterly', startDate: '2026-01-01' })
    // Jan + 5 months = June, which is not a quarterly boundary from January.
    expect(getInvoice(client, [], plans, '2026-06', [], [quarterly]).lines).toHaveLength(1)
    expect(getInvoice(client, [], plans, '2026-07', [], [quarterly]).lines).toHaveLength(2)
  })

  it('never bills a recurring line before its start date', () => {
    const client = makeClient({ billingMode: 'subscription', monthlyRate: 500 })
    const later = recurring({ startDate: '2026-09-01' })
    expect(getInvoice(client, [], plans, period, [], [later]).lines).toHaveLength(1)
  })

  it('carries reimbursements onto hourly and annual invoices too', () => {
    const hourly = makeClient({ billingMode: 'hourly' })
    const hourlyInvoice = getInvoice(hourly, [], plans, period, [reimb()], [recurring()])
    expect(hourlyInvoice.total).toBe(165)

    // An annual client in a NON-billing month still shows its reimbursements.
    const annual = makeClient({ billingMode: 'annual', annualRate: 1200, annualBillingMonth: 1 })
    const annualInvoice = getInvoice(annual, [], plans, period, [reimb()], [recurring()])
    expect(annualInvoice.lines.map((line) => line.label)).toEqual([
      'Reimbursement: Filing fee',
      'Recurring: Software',
    ])
    expect(annualInvoice.total).toBe(165)
  })
})
