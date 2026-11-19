/**
 * The owner's estimate of the month's invoices (featreq-a5e14899).
 *
 * Pinned here: sent clients are their invoice as stored; everyone else is the
 * Client Recap projection; an unusable estimate is never a $0.00 service figure;
 * a billing master is its subs added up; and "left to invoice" ignores clients
 * with nothing to bill.
 */
import { describe, expect, it } from 'vitest'
import { buildInvoiceEstimate, clientsLeftToInvoice, isInvoiceRunClient } from './invoice-estimate.js'

const PERIOD = '2026-10'
// Today inside PERIOD: PERIOD is the current month.
const TODAY = '2026-10-15'
// Today before PERIOD: PERIOD is a future month, where nothing can be logged yet.
const BEFORE = '2026-09-20'

const client = (id, name, over = {}) => ({
  id,
  name,
  billingMode: 'hourly',
  hourlyRate: 100,
  planIds: [],
  lifecycleStage: 'active',
  ...over,
})

const lisa = { id: 'lisa', name: 'Lisa', role: 'Bookkeeper', billRate: 120 }

const baseData = (clients, extra = {}) => ({
  clients,
  plans: [],
  employees: [lisa],
  timeEntries: [],
  reimbursements: [],
  recurringReimbursements: [],
  ...extra,
})

const rateVersions = [{ userId: 'lisa', effectiveDate: '1970-01-01', rate: 120 }]

const sentInvoice = (id, clientId, over = {}) => ({
  id,
  clientId,
  period: PERIOD,
  kind: 'monthly',
  status: 'sent',
  number: `INV-${id}`,
  total: 700,
  lineItems: [
    { kind: 'plan', label: 'Monthly', detail: '', amount: 600 },
    { kind: 'reimbursement', label: 'Filing fee', detail: '', amount: 100 },
  ],
  ...over,
})

const estimate = (data, invoices = [], today = TODAY) =>
  buildInvoiceEstimate({ period: PERIOD, data, invoices, billRateVersions: rateVersions, today })

const row = (result, id) => result.clients.find((entry) => entry.clientId === id)

describe('buildInvoiceEstimate', () => {
  it('uses the stored invoice for a client that has been sent, with its service and reimbursed split', () => {
    const result = estimate(baseData([client('c1', 'Acme')]), [sentInvoice('a', 'c1')])
    expect(row(result, 'c1')).toMatchObject({
      basis: 'sent',
      service: 600,
      reimburse: 100,
      total: 700,
      invoiceNumber: 'INV-a',
    })
    expect(result).toMatchObject({ monthTotal: 700, serviceTotal: 600, reimburseTotal: 100 })
  })

  it('does not count a draft, a reviewed invoice or a void as sent', () => {
    for (const status of ['draft', 'reviewed', 'void']) {
      const result = estimate(baseData([client('c1', 'Acme')]), [sentInvoice('a', 'c1', { status })])
      expect(row(result, 'c1').basis).not.toBe('sent')
    }
  })

  it('projects an hourly client in a FUTURE month at estimated hours x rate, with the word "estimate"', () => {
    const data = baseData([
      client('c1', 'Acme', { assignedBookkeeperIds: ['lisa'], estimatedBookkeeperHours: 10 }),
    ])
    expect(row(estimate(data, [], BEFORE), 'c1')).toMatchObject({
      basis: 'projected',
      detail: 'estimate',
      service: 1200,
      reimburse: 0,
      total: 1200,
    })
  })

  it('projects a plan client at its fixed amount plus the reimbursements recorded', () => {
    const data = baseData(
      [client('c1', 'Acme', { billingMode: 'subscription', monthlyRate: 500 })],
      { reimbursements: [{ id: 'r1', clientId: 'c1', date: '2026-10-03', amount: 50, description: 'Fee' }] },
    )
    expect(row(estimate(data), 'c1')).toMatchObject({
      basis: 'projected',
      detail: 'plan',
      service: 500,
      reimburse: 50,
      total: 550,
    })
  })

  it('never turns an unusable estimate into a $0.00 service figure (a future month)', () => {
    const noEstimate = estimate(baseData([client('c1', 'Acme')]), [], BEFORE)
    expect(row(noEstimate, 'c1')).toMatchObject({
      basis: 'too_early',
      detail: 'too early',
      service: null,
      reimburse: 0,
      total: null,
    })
    expect(noEstimate.serviceTotal).toBe(0)

    // Estimated hours but nobody has a rate: say so, still no made-up service figure.
    const noRates = buildInvoiceEstimate({
      period: PERIOD,
      data: baseData([client('c1', 'Acme', { hourlyRate: 0, estimatedBookkeeperHours: 10 })], {
        employees: [{ id: 'lisa', name: 'Lisa', role: 'Bookkeeper' }],
      }),
      invoices: [],
      billRateVersions: [],
      today: BEFORE,
    })
    expect(row(noRates, 'c1')).toMatchObject({ basis: 'too_early', detail: 'no rates', service: null })
  })

  it('still counts reimbursements already recorded on a too-early client', () => {
    const data = baseData([client('c1', 'Acme')], {
      reimbursements: [{ id: 'r1', clientId: 'c1', date: '2026-10-03', amount: 75, description: 'Fee' }],
    })
    const result = estimate(data)
    expect(row(result, 'c1')).toMatchObject({ basis: 'too_early', service: null, reimburse: 75, total: 75 })
    expect(result.reimburseTotal).toBe(75)
    expect(result.monthTotal).toBe(75)
  })

  it('sums sent and projected rows into the totals, A to Z', () => {
    const data = baseData([
      client('c2', 'Zed', { billingMode: 'subscription', monthlyRate: 500 }),
      client('c1', 'Acme'),
    ])
    const result = estimate(data, [sentInvoice('a', 'c1')])
    expect(result.clients.map((entry) => entry.clientName)).toEqual(['Acme', 'Zed'])
    expect(result.monthTotal).toBe(1200)
    expect(result.serviceTotal).toBe(1100)
    expect(result.reimburseTotal).toBe(100)
  })

  it('leaves out retired, prospect, opted-out and billed-through-a-master clients', () => {
    const data = baseData([
      client('retired', 'Retired', { lifecycleStage: 'inactive' }),
      client('prospect', 'Prospect', { lifecycleStage: 'onboarding' }),
      client('outside', 'Outside', { platformInvoicingOptOut: true }),
      client('sub', 'Sub', { billToClientId: 'm' }),
      client('c1', 'Acme'),
    ])
    expect(estimate(data).clients.map((entry) => entry.clientId)).toEqual(['c1'])
    expect(isInvoiceRunClient(data.clients[3])).toBe(false)
  })

  it('keeps a retired client that already has a sent invoice, so the month total is true', () => {
    const data = baseData([client('old', 'Old Co', { lifecycleStage: 'inactive' })])
    const result = estimate(data, [sentInvoice('a', 'old')])
    expect(row(result, 'old').basis).toBe('sent')
    expect(result.monthTotal).toBe(700)
  })

  it('makes a billing master the sum of its eligible subs, and gives the subs no rows', () => {
    const data = baseData([
      client('m', 'Master', { isBillingMaster: true, billingMode: 'subscription' }),
      client('s1', 'Sub One', {
        billToClientId: 'm',
        billingMode: 'subscription',
        monthlyRate: 300,
      }),
      client('s2', 'Sub Two', {
        billToClientId: 'm',
        billingMode: 'subscription',
        monthlyRate: 200,
      }),
      client('s3', 'Sub Out', {
        billToClientId: 'm',
        billingMode: 'subscription',
        monthlyRate: 999,
        platformInvoicingOptOut: true,
      }),
    ])
    const result = estimate(data)
    expect(result.clients.map((entry) => entry.clientId)).toEqual(['m'])
    expect(row(result, 'm')).toMatchObject({ basis: 'projected', detail: 'combined', service: 500, total: 500 })
  })
})

describe('buildInvoiceEstimate: billing masters', () => {
  const subOf = (id, name, rate, over = {}) =>
    client(id, name, { billToClientId: 'm', billingMode: 'subscription', monthlyRate: rate, ...over })
  const master = client('m', 'Master', { isBillingMaster: true, billingMode: 'subscription' })

  it('does not add a sub that already holds its own live monthly invoice (the migration month)', () => {
    const data = baseData([master, subOf('s1', 'Sub One', 300), subOf('s2', 'Sub Two', 200)])
    // s1 has its own sent invoice: it is its own row, and the master's projection leaves it out.
    const result = estimate(data, [sentInvoice('a', 's1', { total: 300, lineItems: [] })])
    expect(row(result, 's1')).toMatchObject({ basis: 'sent', total: 300 })
    expect(row(result, 'm')).toMatchObject({ basis: 'projected', service: 200 })
    expect(result.monthTotal).toBe(500)
  })

  it('leaves out a sub with a live draft of its own, but not one with only a void', () => {
    const data = baseData([master, subOf('s1', 'Sub One', 300), subOf('s2', 'Sub Two', 200)])
    const result = estimate(data, [
      sentInvoice('d', 's1', { status: 'draft' }),
      sentInvoice('v', 's2', { status: 'void' }),
    ])
    expect(row(result, 'm')).toMatchObject({ service: 200 })
  })

  it('never hides a partial sum: it says how many companies the figure covers and why (a future month)', () => {
    const data = baseData([
      master,
      subOf('s1', 'Sub One', 300),
      subOf('s2', 'Sub Two', 200),
      client('s3', 'Sub Three', { billToClientId: 'm' }),
      client('s4', 'Sub Four', { billToClientId: 'm', hourlyRate: 0, estimatedBookkeeperHours: 10 }),
    ])
    data.employees = [{ id: 'lisa', name: 'Lisa', role: 'Bookkeeper' }]
    const result = buildInvoiceEstimate({
      period: PERIOD,
      data,
      invoices: [],
      billRateVersions: [],
      today: BEFORE,
    })
    expect(row(result, 'm')).toMatchObject({
      basis: 'projected',
      service: 500,
      detail: 'combined, 2 of 4 companies (1 too early, 1 no rates)',
    })
  })

  it('gives a sub with only its own draft a row of its own, so it does not vanish', () => {
    const data = baseData([master, subOf('s1', 'Sub One', 300), subOf('s2', 'Sub Two', 200)])
    const result = estimate(data, [sentInvoice('d', 's1', { status: 'draft' })])
    expect(row(result, 's1')).toMatchObject({
      basis: 'projected',
      detail: 'own invoice (draft)',
      service: 300,
    })
    // ...and the master carries only the other company, saying one is on its own invoice.
    expect(row(result, 'm')).toMatchObject({
      service: 200,
      detail: 'combined (1 on own invoice)',
    })
    expect(result.monthTotal).toBe(500)
  })

  it('does not call a master "no companies yet" when every sub is on its own invoice', () => {
    const data = baseData([master, subOf('s1', 'Sub One', 300), subOf('s2', 'Sub Two', 200)])
    const result = estimate(data, [
      sentInvoice('a', 's1', { total: 300, lineItems: [] }),
      sentInvoice('b', 's2', { total: 200, lineItems: [] }),
    ])
    expect(row(result, 'm')).toMatchObject({
      basis: 'too_early',
      detail: 'companies on their own invoices',
      service: null,
    })
    expect(result.monthTotal).toBe(500)
  })

  it('still says "no companies yet" for a master nobody points at', () => {
    const result = estimate(baseData([master]))
    expect(row(result, 'm').detail).toBe('no companies yet')
  })

  it('adds the own-invoice count to the partial-sum detail', () => {
    const data = baseData([
      master,
      subOf('s1', 'Sub One', 300),
      client('s2', 'Sub Two', { billToClientId: 'm' }),
      subOf('s3', 'Sub Three', 100),
    ])
    const result = estimate(data, [sentInvoice('a', 's3', { total: 100, lineItems: [] })])
    // Sub Two is hourly with nothing logged in the current month.
    expect(row(result, 'm').detail).toBe('combined, 1 of 2 companies (1 no hours yet, 1 on own invoice)')
    const future = estimate(data, [sentInvoice('a', 's3', { total: 100, lineItems: [] })], BEFORE)
    expect(row(future, 'm').detail).toBe('combined, 1 of 2 companies (1 too early, 1 on own invoice)')
  })

  it('says plain "combined" when every company is covered', () => {
    const data = baseData([master, subOf('s1', 'Sub One', 300), subOf('s2', 'Sub Two', 200)])
    expect(row(estimate(data), 'm').detail).toBe('combined')
  })
})

/**
 * featreq-abd4b683 (her ask): "On the current month while in estimate mode for
 * clients on hourly it should estimate based on actual hours worked times
 * billable rate." Every test pins today explicitly.
 */
describe('buildInvoiceEstimate: an hourly client in the current month is its hours so far', () => {
  const hourly = (id, name, over = {}) =>
    client(id, name, { assignedBookkeeperIds: ['lisa'], estimatedBookkeeperHours: 10, ...over })
  const hoursFor = (clientId, minutes) => ({
    id: `t-${clientId}`,
    employeeId: 'lisa',
    clientId,
    date: '2026-10-06',
    minutes,
    billable: true,
  })

  it('prices the hours logged so far at the bill rate, not the estimate', () => {
    // 10 estimated hours ($1,200); 5 worked at Lisa's $120 = $600.
    const data = baseData([hourly('c1', 'Acme')], { timeEntries: [hoursFor('c1', 300)] })
    const result = estimate(data, [], TODAY)
    expect(row(result, 'c1')).toMatchObject({
      basis: 'projected',
      detail: 'hours so far',
      service: 600,
      reimburse: 0,
      total: 600,
    })
    expect(result.serviceTotal).toBe(600)
  })

  it('quotes the same figure as before once the hours so far pass the estimate', () => {
    // 12 worked = $1,440 against a $1,200 estimate: the Client Recap quotes $1,440 too.
    const data = baseData([hourly('c1', 'Acme')], { timeEntries: [hoursFor('c1', 720)] })
    expect(row(estimate(data, [], TODAY), 'c1')).toMatchObject({ service: 1440, detail: 'hours so far' })
  })

  it('does not count a client with nothing logged yet, and never as $0.00', () => {
    const data = baseData([hourly('c1', 'Acme'), client('c2', 'Bare')], {
      reimbursements: [{ id: 'r1', clientId: 'c2', date: '2026-10-03', amount: 75, description: 'Fee' }],
    })
    const result = estimate(data, [], TODAY)
    expect(row(result, 'c1')).toMatchObject({
      basis: 'too_early',
      detail: 'no hours yet',
      service: null,
      reimburse: 0,
      total: null,
    })
    // A recorded reimbursement is still real money on a no-hours-yet row.
    expect(row(result, 'c2')).toMatchObject({ basis: 'too_early', detail: 'no hours yet', reimburse: 75, total: 75 })
    expect(result.serviceTotal).toBe(0)
    expect(result.monthTotal).toBe(75)
  })

  it('says "no rates" when hours are logged but nobody has a rate for them', () => {
    const data = baseData([hourly('c1', 'Acme', { hourlyRate: 0 })], {
      employees: [{ id: 'lisa', name: 'Lisa', role: 'Bookkeeper' }],
      timeEntries: [hoursFor('c1', 300)],
    })
    const result = buildInvoiceEstimate({ period: PERIOD, data, invoices: [], billRateVersions: [], today: TODAY })
    expect(row(result, 'c1')).toMatchObject({ basis: 'too_early', detail: 'no rates', service: null })
  })

  it('keeps the estimate for the same client in a FUTURE month', () => {
    const data = baseData([hourly('c1', 'Acme')])
    expect(row(estimate(data, [], BEFORE), 'c1')).toMatchObject({ detail: 'estimate', service: 1200 })
  })

  it('keeps "as it stands" for a month that is over', () => {
    const data = baseData([hourly('c1', 'Acme')], { timeEntries: [hoursFor('c1', 300)] })
    expect(row(estimate(data, [], '2026-11-05'), 'c1')).toMatchObject({
      basis: 'projected',
      detail: 'as it stands',
      service: 600,
    })
  })

  it('leaves a plan client unchanged', () => {
    const data = baseData([client('c1', 'Acme', { billingMode: 'subscription', monthlyRate: 500 })], {
      timeEntries: [hoursFor('c1', 300)],
    })
    expect(row(estimate(data, [], TODAY), 'c1')).toMatchObject({ detail: 'plan', service: 500 })
  })

  it('still uses a sent invoice as it stands', () => {
    const data = baseData([hourly('c1', 'Acme')], { timeEntries: [hoursFor('c1', 300)] })
    expect(row(estimate(data, [sentInvoice('a', 'c1')], TODAY), 'c1')).toMatchObject({
      basis: 'sent',
      service: 600,
      total: 700,
    })
  })

  it('makes a billing master the sum of its subs under the same rule', () => {
    const master = client('m', 'Master', { isBillingMaster: true, billingMode: 'subscription' })
    const data = baseData(
      [
        master,
        hourly('s1', 'Sub One', { billToClientId: 'm' }),
        hourly('s2', 'Sub Two', { billToClientId: 'm' }),
        hourly('s3', 'Sub Three', { billToClientId: 'm' }),
      ],
      { timeEntries: [hoursFor('s1', 300), hoursFor('s2', 150)] },
    )
    // $600 + $300 so far; Sub Three has nothing logged. Not 3 x $1,200 of estimates.
    expect(row(estimate(data, [], TODAY), 'm')).toMatchObject({
      basis: 'projected',
      service: 900,
      total: 900,
      detail: 'combined, 2 of 3 companies (1 no hours yet)',
    })
    // A future month: the subs' estimates.
    expect(row(estimate({ ...data, timeEntries: [] }, [], BEFORE), 'm')).toMatchObject({
      service: 3600,
      detail: 'combined',
    })
    // Nothing logged by any company yet: the master says so, with no figure.
    expect(row(estimate({ ...data, timeEntries: [] }, [], TODAY), 'm')).toMatchObject({
      basis: 'too_early',
      detail: 'no hours yet',
      service: null,
    })
  })

  it('lists the causes when no company on a master is counted', () => {
    const master = client('m', 'Master', { isBillingMaster: true, billingMode: 'subscription' })
    const bob = { id: 'bob', name: 'Bob', role: 'Bookkeeper' }
    const data = baseData(
      [
        master,
        // Hours logged, but nobody has a rate for them.
        hourly('s1', 'Sub One', { billToClientId: 'm', hourlyRate: 0, assignedBookkeeperIds: ['bob'] }),
        hourly('s2', 'Sub Two', { billToClientId: 'm' }),
      ],
      { employees: [lisa, bob], timeEntries: [{ ...hoursFor('s1', 120), employeeId: 'bob' }] },
    )
    expect(row(estimate(data, [], TODAY), 'm')).toMatchObject({
      basis: 'too_early',
      detail: '1 no rates, 1 no hours yet',
      service: null,
    })
  })

  it('says so when some of the hours so far have no rate', () => {
    const bob = { id: 'bob', name: 'Bob', role: 'Bookkeeper' }
    const data = baseData([hourly('c1', 'Acme', { hourlyRate: 0, assignedBookkeeperIds: ['lisa', 'bob'] })], {
      employees: [lisa, bob],
      timeEntries: [hoursFor('c1', 300), { ...hoursFor('c1', 120), id: 't-bob', employeeId: 'bob' }],
    })
    // Lisa's 5 hours at $120; Bob's 2 hours have no rate and are not in the figure.
    expect(row(estimate(data, [], TODAY), 'c1')).toMatchObject({
      basis: 'projected',
      detail: 'hours so far (some hours have no rate)',
      service: 600,
    })
  })

  it('makes a no-hours-yet row that carries pushed work a counted, projected row that says so', () => {
    // Production shape (2026-11): an hourly client with estimated hours, nothing
    // logged this month, and last month's work pushed into it.
    const pushedIn = {
      id: 'inv-sep',
      clientId: 'c1',
      period: '2026-09',
      kind: 'monthly',
      status: 'void',
      rolledIntoPeriod: PERIOD,
      total: 26.25,
      lineItems: [{ kind: 'hourly', label: 'Bookkeeping Services', amount: 26.25, hours: 0.25, rate: 105 }],
    }
    const data = baseData([hourly('c1', 'Acme')])
    const result = buildInvoiceEstimate({
      period: PERIOD,
      data,
      invoices: [],
      priorInvoices: [pushedIn],
      billRateVersions: rateVersions,
      today: TODAY,
    })
    expect(row(result, 'c1')).toMatchObject({
      basis: 'projected',
      detail: 'no hours yet, incl. September 2026 pushed work',
      service: 26.25,
      reimburse: 0,
      total: 26.25,
      pushedInWaiting: '2026-09',
    })
    expect(result.serviceTotal).toBe(26.25)
    expect(clientsLeftToInvoice(result.clients)).toEqual([{ id: 'c1', name: 'Acme' }])
  })
})

describe('clientsLeftToInvoice', () => {
  it('names projected clients with something to bill, not sent ones and not clients with nothing to bill', () => {
    const data = baseData([
      client('sent', 'Sent Co', { billingMode: 'subscription', monthlyRate: 500 }),
      client('todo', 'To Do', { billingMode: 'subscription', monthlyRate: 500 }),
      client('zero', 'Zero Plan', { billingMode: 'subscription', monthlyRate: 0 }),
      client('empty', 'No Hours'),
      client('reimb', 'Fee Only'),
    ])
    data.reimbursements = [
      { id: 'r1', clientId: 'reimb', date: '2026-10-03', amount: 40, description: 'Fee' },
    ]
    const result = estimate(data, [sentInvoice('a', 'sent')])
    expect(clientsLeftToInvoice(result.clients)).toEqual([
      { id: 'reimb', name: 'Fee Only' },
      { id: 'todo', name: 'To Do' },
    ])
  })
})

/**
 * featreq-8dffdff7 round 2: clients now carry a real createdAt, and the Client
 * Recap's active-month rule makes a month before a client's first activity "not
 * active" (no projection). A client created in August that was nonetheless
 * billed (a draft) or reimbursed in July must keep its July row.
 */
describe('a client created after the month it was billed or reimbursed in', () => {
  const JULY = '2026-07'
  const augustClient = client('late', 'Late Co', {
    billingMode: 'subscription',
    monthlyRate: 600,
    createdAt: '2026-08-14T16:00:00.000Z',
  })
  const julyEstimate = (data, extra = {}) =>
    buildInvoiceEstimate({
      period: JULY,
      data,
      invoices: [],
      billRateVersions: rateVersions,
      today: '2026-08-20',
      ...extra,
    })

  it('keeps its July row when a July draft exists (evidence from the store)', () => {
    const result = julyEstimate(baseData([augustClient]), {
      activityInvoices: [{ clientId: 'late', period: JULY, kind: 'monthly', status: 'draft', sourceClientIds: [] }],
    })
    expect(row(result, 'late')).toBeTruthy()
    expect(row(result, 'late').service).toBe(600)
  })

  it('keeps its July row when the July draft is among the month’s own invoices', () => {
    const draft = sentInvoice('d', 'late', { period: JULY, status: 'draft' })
    const result = julyEstimate(baseData([augustClient]), { invoices: [draft] })
    expect(row(result, 'late')).toBeTruthy()
  })

  it('keeps its July row, and its reimbursement in the total, with only a July reimbursement', () => {
    const data = baseData([augustClient], {
      reimbursements: [{ id: 'r1', clientId: 'late', date: '2026-07-22', description: 'Filing fee', amount: 45 }],
    })
    const result = julyEstimate(data)
    expect(row(result, 'late')).toBeTruthy()
    expect(row(result, 'late').reimburse).toBe(45)
    expect(result.reimburseTotal).toBe(45)
  })

  it('still has no row for July with no July activity at all', () => {
    expect(row(julyEstimate(baseData([augustClient])), 'late')).toBeUndefined()
  })
})
