import { describe, expect, it } from 'vitest'
import { getInvoice } from '../lib/utils'
import type { Client, SubscriptionPlan, TimeEntry } from '../lib/types'

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

const period = '2026-05'

const entry: TimeEntry = {
  id: 'time-1',
  employeeId: 'emp-1',
  clientId: 'client-1',
  date: '2026-05-10',
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

  it('hourly clients still bill tracked billable hours at the hourly rate', () => {
    const client = makeClient({ billingMode: 'hourly', hourlyRate: 100 })
    const invoice = getInvoice(client, [entry], plans, period)
    // 600 minutes = 10h * $100 = $1000
    expect(invoice.total).toBe(1000)
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
