import { describe, expect, it } from 'vitest'

import {
  carriedForwardTitle,
  carriedLinesFromRolledInvoice,
  hasBillableContent,
  insertCarriedLines,
  isCarriedLine,
  moneyOfLines,
  nextPeriod,
  rollForwardConfirmText,
  rollForwardRefusal,
  rollUndoRefusal,
  rolledAdvanceOffer,
  rolledIntoLabel,
  withCarriedLines,
  withoutCarriedLinesFrom,
} from './invoice-rollforward.js'
import { invoiceSections } from './invoice-lines.js'
import { unaccountedScopeEntries, hourlyInsertIndex } from './invoice-scope-retag.js'

/**
 * Push to next month (featreq-40697310): the pure rules. The store and the
 * editor both read these, so a kind that moves, a refusal or a sentence cannot
 * mean one thing on the server and another on the page.
 */

const october = (over = {}) => ({
  id: 'inv-oct',
  clientId: 'c1',
  period: '2026-10',
  number: 'INV-2026-10-007',
  kind: 'monthly',
  status: 'draft',
  sentAt: null,
  lineItems: [
    { kind: 'plan', label: 'Monthly bookkeeping', detail: '', amount: 300 },
    {
      kind: 'hourly',
      label: 'Bookkeeping Services',
      detail: '3.25h at $125.00/hr',
      amount: 406.25,
      hours: 3.25,
      rate: 125,
      employeeId: 'emp-1',
      roleTier: 'Bookkeeper',
      rateManual: true,
    },
    { kind: 'hourly', label: 'Accounting Services', detail: '', amount: 0, hours: 0, rate: 150, roleTier: 'Accountant' },
    { kind: 'adhoc', label: 'Adhoc — Cleanup', detail: 'x', amount: 0, adhocMode: 'courtesy', adhocAmount: 90, entryId: 'te-9' },
    { kind: 'reimbursement', label: 'Postage', detail: 'Oct 3', amount: 12.5 },
    {
      kind: 'recurring',
      label: 'QuickBooks Online (covers Oct 1 – Oct 31)',
      detail: 'monthly',
      amount: 90,
      recurringId: 'rr-1',
      coverageStart: '2026-10-01',
      coverageEnd: '2026-10-31',
      needsCoverageConfirmation: false,
      section: 'software',
    },
    { kind: 'time_detail', label: 'Oct 2 · Pat', detail: '1.00h', amount: 0 },
    { kind: 'adjustment', label: 'Adjustment — 2026-09', detail: 'Credit carried from last month', amount: -25 },
    { kind: 'custom', label: 'Rush fee', detail: '', amount: 40 },
    { kind: 'account_credit', label: 'Credit on account', detail: '', amount: -50, draws: [{ creditId: 'cr-1', amount: 50 }] },
    { kind: 'retainer_credit', label: 'Retainer', detail: '', amount: -100, retainerInvoiceId: 'ret-1' },
    { kind: 'card-fee', label: 'Card fee', detail: '', amount: 9 },
    {
      kind: 'advance_request',
      label: 'Pay in advance amount',
      detail: '',
      amount: 0,
      advanceOffer: { requestId: 'adv-1', number: 'ADV-0004', collection: 'invoice', optional: false, url: 'https://app.example.test/advance-pay/tok' },
    },
  ],
  ...over,
})

describe('nextPeriod', () => {
  it('steps one month, across the year end', () => {
    expect(nextPeriod('2026-10')).toBe('2026-11')
    expect(nextPeriod('2026-12')).toBe('2027-01')
    expect(nextPeriod('2026-13')).toBeNull()
    expect(nextPeriod('')).toBeNull()
  })
})

describe('carriedLinesFromRolledInvoice', () => {
  const carried = carriedLinesFromRolledInvoice(october())

  it('keeps the work and charge kinds and drops the document kinds', () => {
    expect(carried.map((line) => line.kind)).toEqual([
      'plan',
      'hourly',
      'adhoc',
      'reimbursement',
      'recurring',
      'time_detail',
      'adjustment',
      'custom',
    ])
    for (const dropped of ['account_credit', 'retainer_credit', 'card-fee', 'advance_request', 'prepayment']) {
      expect(carried.some((line) => line.kind === dropped)).toBe(false)
    }
  })

  it('leaves an empty hours row behind', () => {
    expect(carried.some((line) => line.label.includes('Accounting Services'))).toBe(false)
  })

  it('prefixes every label with the month the client reads, and stamps the month and the source', () => {
    expect(carried[1]).toMatchObject({
      label: 'October 2026: Bookkeeping Services',
      detail: '3.25h at $125.00/hr',
      amount: 406.25,
      hours: 3.25,
      rate: 125,
      rateManual: true,
      carriedFromPeriod: '2026-10',
      carriedFromInvoiceId: 'inv-oct',
    })
    expect(carried.every((line) => line.label.startsWith('October 2026: '))).toBe(true)
    expect(carried.every((line) => line.carriedFromPeriod === '2026-10')).toBe(true)
  })

  it('drops the hooks that would tie the line to next month: covered-date ledger, hours panel, role heading', () => {
    const hourly = carried[1]
    expect(hourly.employeeId).toBeUndefined()
    expect(hourly.roleTier).toBeUndefined()
    const recurring = carried.find((line) => line.kind === 'recurring')
    expect(recurring.recurringId).toBeUndefined()
    expect(recurring.coverageStart).toBeUndefined()
    expect(recurring.needsCoverageConfirmation).toBeUndefined()
    // The covered dates stay in the words, as October's invoice said them.
    expect(recurring.label).toBe('October 2026: QuickBooks Online (covers Oct 1 – Oct 31)')
    expect(recurring.section).toBe('software')
    const adhoc = carried.find((line) => line.kind === 'adhoc')
    expect(adhoc.entryId).toBeUndefined()
    expect(adhoc).toMatchObject({ adhocMode: 'courtesy', adhocAmount: 90, amount: 0 })
  })

  it('keeps the true-up as a line (it was on the invoice of record)', () => {
    expect(carried.find((line) => line.kind === 'adjustment')).toMatchObject({
      label: 'October 2026: Adjustment — 2026-09',
      amount: -25,
    })
  })

  it('in a chain of two pushes keeps October as the month and names November as the source', () => {
    const november = {
      id: 'inv-nov',
      period: '2026-11',
      lineItems: [{ kind: 'plan', label: 'Monthly bookkeeping', detail: '', amount: 300 }, ...carried],
    }
    const again = carriedLinesFromRolledInvoice(november)
    expect(again[0]).toMatchObject({ label: 'November 2026: Monthly bookkeeping', carriedFromPeriod: '2026-11' })
    const octoberHours = again.find((line) => line.kind === 'hourly')
    expect(octoberHours).toMatchObject({
      label: 'October 2026: Bookkeeping Services',
      carriedFromPeriod: '2026-10',
      carriedFromInvoiceId: 'inv-nov',
    })
  })

  it('carries nothing from an invoice with no billing month', () => {
    expect(carriedLinesFromRolledInvoice({ id: 'x', period: 'nope', lineItems: [{ kind: 'plan', label: 'a', amount: 1 }] })).toEqual([])
  })
})

describe('placing carried lines', () => {
  const carried = carriedLinesFromRolledInvoice(october())
  const nov = [
    { kind: 'plan', label: 'Monthly bookkeeping', detail: '', amount: 300 },
    { kind: 'account_credit', label: 'Credit on account', detail: '', amount: -50, draws: [] },
    { kind: 'advance_request', label: 'Pay in advance amount', detail: '', amount: 0 },
  ]

  it('puts the carried block above the credits and the advance section', () => {
    const merged = insertCarriedLines(nov, carried)
    expect(merged[0].label).toBe('Monthly bookkeeping')
    expect(merged.slice(1, 1 + carried.length)).toEqual(carried)
    expect(merged.at(-2).kind).toBe('account_credit')
    expect(merged.at(-1).kind).toBe('advance_request')
  })

  it('is idempotent for the same source invoice, and Undo takes exactly those lines off', () => {
    const once = insertCarriedLines(nov, carried)
    expect(insertCarriedLines(once, carried)).toEqual(once)
    expect(withoutCarriedLinesFrom(once, 'inv-oct')).toEqual(nov)
  })

  it('adds the carried money: the true-up outside the subtotal, everything else inside', () => {
    const draft = { lineItems: [nov[0]], subtotal: 300, total: 300 }
    const withCarry = withCarriedLines(draft, carried)
    const carriedTotal = carried.reduce((sum, line) => sum + line.amount, 0)
    expect(withCarry.total).toBe(Math.round((300 + carriedTotal) * 100) / 100)
    expect(withCarry.subtotal).toBe(Math.round((300 + carriedTotal + 25) * 100) / 100)
    expect(moneyOfLines(withCarry.lineItems)).toEqual({ subtotal: withCarry.subtotal, total: withCarry.total })
    expect(withCarriedLines(draft, [])).toBe(draft)
  })

  it('knows when a draft held nothing but pushed lines', () => {
    expect(hasBillableContent([{ kind: 'account_credit', amount: -5 }, { kind: 'advance_request', amount: 0 }])).toBe(false)
    expect(hasBillableContent([{ kind: 'time_detail', label: 'x', amount: 0 }])).toBe(false)
    expect(hasBillableContent([{ kind: 'custom', label: 'x', amount: 5 }])).toBe(true)
  })
})

describe('rollForwardRefusal', () => {
  const ok = { invoice: october(), client: { billingPeriodMonths: 1 }, nextInvoices: [] }

  it('allows an unsent monthly draft, or a reviewed one, with nothing in next month', () => {
    expect(rollForwardRefusal(ok)).toBeNull()
    expect(rollForwardRefusal({ ...ok, invoice: october({ status: 'reviewed' }) })).toBeNull()
    expect(rollForwardRefusal({ ...ok, client: null })).toBeNull()
  })

  it('allows it onto a next-month draft or reviewed invoice', () => {
    expect(rollForwardRefusal({ ...ok, nextInvoices: [{ id: 'n', kind: 'monthly', status: 'reviewed' }] })).toBeNull()
  })

  it.each([
    ['a retainer', { invoice: october({ kind: 'retainer' }) }, 'not_monthly'],
    ['a sent invoice', { invoice: october({ status: 'sent' }) }, 'not_unsent'],
    ['a processing invoice', { invoice: october({ status: 'processing' }) }, 'not_unsent'],
    ['a draft once emailed', { invoice: october({ sentAt: '2026-11-01T00:00:00Z' }) }, 'sent_once'],
    ['a billing-period client', { client: { billingPeriodMonths: 3 } }, 'billing_period'],
    ['an autopay charge in flight', { autopayActive: true }, 'autopay_in_flight'],
    [
      'unconfirmed covered dates',
      { invoice: october({ lineItems: [{ kind: 'recurring', label: 'x', amount: 1, recurringId: 'r', needsCoverageConfirmation: true }] }) },
      'coverage_unconfirmed',
    ],
    ['next month already sent', { nextInvoices: [{ id: 'n', number: 'INV-2026-11-002', kind: 'monthly', status: 'sent' }] }, 'next_invoice_sent'],
    ['next month paid', { nextInvoices: [{ id: 'n', kind: 'monthly', status: 'paid' }] }, 'next_invoice_sent'],
    [
      'next month itself pushed on',
      { nextInvoices: [{ id: 'n', kind: 'monthly', status: 'void', rolledIntoPeriod: '2026-12' }] },
      'next_invoice_rolled',
    ],
    ['already pushed', { invoice: october({ status: 'void', rolledIntoPeriod: '2026-11' }) }, 'already_rolled'],
  ])('refuses %s', (_name, over, code) => {
    expect(rollForwardRefusal({ ...ok, ...over })?.code).toBe(code)
  })

  it('says it in her words', () => {
    expect(
      rollForwardRefusal({ ...ok, nextInvoices: [{ id: 'n', number: 'INV-2026-11-002', kind: 'monthly', status: 'sent' }] })
        .message,
    ).toBe("November 2026's invoice (INV-2026-11-002) already went out, so this cannot be pushed onto it.")
  })

  it('ignores a retainer or a plain void in next month', () => {
    expect(
      rollForwardRefusal({
        ...ok,
        nextInvoices: [
          { id: 'r', kind: 'retainer', status: 'sent' },
          { id: 'v', kind: 'monthly', status: 'void', rolledIntoPeriod: null },
        ].filter((row) => row.kind === 'monthly'),
      }),
    ).toBeNull()
  })
})

describe('rollUndoRefusal', () => {
  const rolled = october({ status: 'void', rolledIntoPeriod: '2026-11' })

  it('allows it while next month is unsent or not built', () => {
    expect(rollUndoRefusal({ invoice: rolled })).toBeNull()
    expect(rollUndoRefusal({ invoice: rolled, nextInvoices: [{ id: 'n', kind: 'monthly', status: 'draft', lineItems: [] }] })).toBeNull()
  })

  it.each([
    ['an invoice that was not pushed', { invoice: october({ status: 'void' }) }, 'not_rolled'],
    ['next month sent', { nextInvoices: [{ id: 'n', kind: 'monthly', status: 'sent' }] }, 'next_invoice_sent'],
    ['next month processing', { nextInvoices: [{ id: 'n', kind: 'monthly', status: 'processing' }] }, 'next_invoice_sent'],
    ['next month pushed on', { nextInvoices: [{ id: 'n', kind: 'monthly', status: 'void', rolledIntoPeriod: '2026-12' }] }, 'next_invoice_rolled'],
    [
      'a credit on next month',
      { nextInvoices: [{ id: 'n', kind: 'monthly', status: 'draft', lineItems: [{ kind: 'account_credit', amount: -5 }] }] },
      'next_invoice_credit',
    ],
    ['a live invoice already in the month', { periodInvoices: [{ id: 'x', kind: 'monthly', status: 'draft' }] }, 'period_has_invoice'],
  ])('refuses %s', (_name, over, code) => {
    expect(rollUndoRefusal({ invoice: rolled, ...over })?.code).toBe(code)
  })
})

describe('words', () => {
  it('labels the heading and the voided row', () => {
    expect(carriedForwardTitle('2026-10')).toBe('Carried forward from October 2026')
    expect(rolledIntoLabel('2026-11')).toBe('Rolled into November 2026')
  })

  it('the confirm sheet says what moves, what closes, the chain, and the advance', () => {
    expect(rollForwardConfirmText(october())).toBe(
      "Everything on this October 2026 invoice moves onto November 2026's invoice as its own lines, listed as October work. " +
        'This invoice closes as rolled into November. You can push again from November if it is still too small. ' +
        "The advance request ADV-0004 on this invoice moves with it and is collected on November 2026's payment link.",
    )
    const separate = october({
      lineItems: [{ kind: 'advance_request', amount: 0, advanceOffer: { requestId: 'a', number: 'ADV-1', collection: 'separate' } }],
    })
    expect(rollForwardConfirmText(separate)).toContain('ADV-1 stays on its own payment page')
    expect(rollForwardConfirmText(october({ lineItems: [] }))).not.toContain('advance')
  })

  it('finds the advance section', () => {
    expect(rolledAdvanceOffer(october())).toMatchObject({ requestId: 'adv-1', collection: 'invoice' })
    expect(rolledAdvanceOffer(october({ lineItems: [] }))).toBeNull()
  })
})

describe('the client copy prints carried lines under their own heading', () => {
  const carried = carriedLinesFromRolledInvoice(october())
  const lines = [{ kind: 'plan', label: 'Monthly bookkeeping', detail: '', amount: 300 }, ...carried]
  const sections = invoiceSections(lines.filter((line) => line.adhocMode !== 'omitted'))

  it('one section per month, titled and totaled, and nothing carried in the ordinary sections', () => {
    const block = sections.find((section) => section.key === 'carried-2026-10')
    expect(block.title).toBe('Carried forward from October 2026')
    expect(block.totalLabel).toBe('Total carried forward from October 2026')
    expect(block.rows.every(isCarriedLine)).toBe(true)
    expect(block.rows.map((line) => line.kind)).toEqual(['plan', 'hourly', 'adhoc', 'reimbursement', 'recurring', 'custom'])
    expect(block.total).toBe(
      Math.round(block.rows.reduce((sum, line) => sum + line.amount, 0) * 100) / 100,
    )
    for (const section of sections.filter((entry) => !entry.key.startsWith('carried-'))) {
      for (const row of section.rows) {
        if (row.kind !== 'adjustment') expect(isCarriedLine(row)).toBe(false)
      }
    }
  })

  it('keeps a carried true-up in the untitled charges and the $0 detail row off the body', () => {
    const charges = sections.find((section) => section.key === 'charges')
    expect(charges.rows.map((line) => line.kind)).toEqual(['adjustment'])
    expect(sections.flatMap((section) => section.rows).some((line) => line.kind === 'time_detail')).toBe(false)
  })

  it('every row lands in exactly one section', () => {
    const shown = sections.flatMap((section) => section.rows)
    const expected = lines.filter((line) => !(line.kind === 'time_detail' && line.amount === 0))
    expect(shown).toHaveLength(expected.length)
  })
})

describe('the hours panel leaves carried lines alone', () => {
  const carried = carriedLinesFromRolledInvoice(october())

  it('a new hours row goes above the carried block', () => {
    const lines = [{ kind: 'hourly', label: 'Bookkeeping Services', amount: 10, hours: 1, rate: 10, employeeId: 'e' }, ...carried]
    expect(hourlyInsertIndex(lines)).toBe(1)
    expect(hourlyInsertIndex([{ kind: 'plan', label: 'x', amount: 1 }, ...carried])).toBe(1)
  })

  it('a carried hours line is not a renamed aggregate of this month', () => {
    const client = { id: 'c1', billingMode: 'hourly' }
    const entries = [{ id: 'te-1', clientId: 'c1', employeeId: 'e1', date: '2026-11-03', minutes: 60, billable: false, isAdhoc: false }]
    const employees = [{ id: 'e1', name: 'Pat', role: 'Bookkeeper' }]
    const lines = [
      { kind: 'hourly', label: 'Bookkeeping Services', amount: 0, hours: 0, rate: 100, employeeId: 'e1', roleTier: 'Bookkeeper' },
      ...carried,
    ]
    expect(unaccountedScopeEntries({ lines, entries, employees, client, period: '2026-11' })).toEqual([])
  })
})
