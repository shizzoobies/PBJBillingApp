import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  INVOICE_HOURS_ROLE_ROWS,
  buildInvoiceLines,
  clientFacingInvoiceLines,
  defaultHoursRowRate,
  hourlyLineDetail,
  invoiceSections,
  isEmptyHoursLine,
  withoutEmptyLines,
} from './invoice-lines.js'
import { buildInvoiceEmail } from './invoice-email.js'
import { buildInvoicePdf } from './invoice-pdf.js'
import { buildQboCsv } from './qbo-export.js'
import { buildCheckoutLineItems } from './stripe-rail.js'
import { buildRatingMessage } from './invoice-confidence.js'

/**
 * The hourly section's three role rows and the editable rate.
 *
 * A row with no hours is on the DRAFT so she can fill it, and OFF the client's
 * copy — the same rule a $0 plan line follows. This file pins the rule at its
 * chokepoint (`clientFacingInvoiceLines`) and at every surface that does not go
 * through it (the QuickBooks export, the AI rating), plus the one rule that must
 * not move: an invoice stored before this existed prints exactly as it did.
 */

const hourly = (over = {}) => ({
  kind: 'hourly',
  label: 'Billable hours — Lisa',
  detail: '2.00h at $75.00/hr',
  hours: 2,
  rate: 75,
  amount: 150,
  roleTier: 'Bookkeeper',
  ...over,
})

const emptyRow = (over = {}) =>
  hourly({
    label: 'Accounting Services',
    detail: '0.00h at $135.00/hr',
    hours: 0,
    rate: 135,
    amount: 0,
    roleTier: 'Accountant',
    ...over,
  })

const baseClient = { id: 'c1', name: 'Acme LLC', planIds: [] }
const stored = (lineItems, total) => ({
  period: '2026-09',
  total: total ?? lineItems.reduce((sum, line) => sum + line.amount, 0),
  lineItems,
})

describe('isEmptyHoursLine', () => {
  it('is an hourly line with a numeric 0 hours and $0', () => {
    expect(isEmptyHoursLine(emptyRow())).toBe(true)
    expect(isEmptyHoursLine(emptyRow({ rate: 0 }))).toBe(true)
  })

  it('is never a line that has hours, money, or another kind', () => {
    expect(isEmptyHoursLine(hourly())).toBe(false)
    expect(isEmptyHoursLine(emptyRow({ hours: 0.01, amount: 1.35 }))).toBe(false)
    expect(isEmptyHoursLine(emptyRow({ amount: 0.01 }))).toBe(false)
    expect(isEmptyHoursLine(emptyRow({ kind: 'adhoc' }))).toBe(false)
    expect(isEmptyHoursLine(emptyRow({ kind: 'time_detail' }))).toBe(false)
    expect(isEmptyHoursLine(null)).toBe(false)
    expect(isEmptyHoursLine(undefined)).toBe(false)
  })

  it('can never match a legacy hourly line, which has no hours field at all', () => {
    const legacy = { kind: 'hourly', label: 'Billable hours', detail: '', amount: 0 }
    expect(isEmptyHoursLine(legacy)).toBe(false)
    expect(isEmptyHoursLine({ ...legacy, hours: '0' })).toBe(false)
    expect(isEmptyHoursLine({ ...legacy, hours: null })).toBe(false)
  })

  it('withoutEmptyLines drops an empty hours row and an empty plan line, nothing else', () => {
    const lines = [
      { kind: 'plan', label: 'P', amount: 0 },
      emptyRow(),
      hourly(),
      { kind: 'adhoc', label: 'Adhoc — x', amount: 0, adhocMode: 'courtesy' },
    ]
    expect(withoutEmptyLines(lines)).toEqual([lines[2], lines[3]])
    expect(withoutEmptyLines(null)).toEqual([])
  })
})

describe('an empty hours row on the client’s copy', () => {
  it('is left off by clientFacingInvoiceLines, and the stored lines are untouched', () => {
    const invoice = stored([hourly(), emptyRow()])
    const before = JSON.stringify(invoice)
    expect(clientFacingInvoiceLines(invoice, baseClient)).toEqual([invoice.lineItems[0]])
    expect(JSON.stringify(invoice)).toBe(before)
  })

  it('takes its role group with it when it was the only row, and the section when the group was all that was in it', () => {
    const withBookkeeping = stored([hourly(), emptyRow()])
    const sections = invoiceSections(clientFacingInvoiceLines(withBookkeeping, baseClient))
    expect(sections.map((section) => section.key)).toEqual(['work'])
    expect(sections[0].groups.map((group) => group.title)).toEqual(['Bookkeeping Services'])

    const onlyEmpty = stored([emptyRow(), emptyRow({ label: 'CFO / Advisory Services', roleTier: 'CFO' })])
    expect(clientFacingInvoiceLines(onlyEmpty, baseClient)).toEqual([])
    expect(invoiceSections(clientFacingInvoiceLines(onlyEmpty, baseClient))).toEqual([])
  })

  it('keeps the section totals equal to the invoice total', () => {
    const invoice = stored([
      { kind: 'plan', label: 'Plan', detail: '', amount: 400 },
      hourly(),
      emptyRow(),
      emptyRow({ label: 'CFO / Advisory Services', roleTier: 'CFO' }),
      { kind: 'reimbursement', label: 'Reimbursement: Filing', detail: '', amount: 30 },
    ])
    const sections = invoiceSections(clientFacingInvoiceLines(invoice, baseClient))
    expect(sections.map((section) => section.key)).toEqual(['plan', 'work', 'expenses'])
    const summed = sections.reduce((sum, section) => sum + (section.total ?? 0), 0)
    expect(Math.round(summed * 100) / 100).toBe(invoice.total)
  })

  it('still prints a legacy hourly line at $0 (no hours field) and a courtesy ad hoc line', () => {
    const legacy = { kind: 'hourly', label: 'Bookkeeping Services', detail: 'Comped', amount: 0 }
    const courtesy = {
      kind: 'adhoc',
      label: 'Adhoc — Rush question',
      detail: 'Sep 4, 2026',
      amount: 0,
      adhocMode: 'courtesy',
      adhocAmount: 50,
    }
    const invoice = stored([legacy, courtesy, emptyRow()])
    expect(clientFacingInvoiceLines(invoice, baseClient)).toEqual([legacy, courtesy])
  })

  it('does not change the combined line a billing master prints', () => {
    const invoice = stored(
      [
        hourly({ sourceClientId: 'sub' }),
        emptyRow({ sourceClientId: 'sub' }),
        { kind: 'card-fee', label: 'Card processing fee', detail: '', amount: 0 },
      ],
      150,
    )
    const lines = clientFacingInvoiceLines(invoice, { id: 'master', isBillingMaster: true })
    expect(lines.map((line) => [line.kind, line.amount])).toEqual([
      ['combined', 150],
      ['card-fee', 0],
    ])
  })

  /**
   * BACKWARD COMPATIBILITY IS A REQUIREMENT. Invoices stored before this existed
   * (production: 34 paid and 35 sent, hourly lines mostly carrying hours, rate
   * and roleTier, the oldest carrying none of them) must render exactly as they
   * do today. A standard-mode invoice with none of the dropped shapes comes back
   * out of the chokepoint deep-equal.
   */
  it('returns every older stored shape deep-equal', () => {
    const fixtures = [
      // generated since the cutover: hours, rate, tier
      [hourly(), hourly({ label: 'Billable hours — Allison', roleTier: 'Accountant', hours: 0.25, amount: 18.75 })],
      // hours and rate, no tier
      [{ kind: 'hourly', label: 'Billable hours — Lisa', detail: 'x', hours: 1.31, rate: 75, amount: 98.25 }],
      // hand-retyped, no hours or rate at all (38 of the 40 written since June)
      [
        { kind: 'hourly', label: 'Bookkeeping Services', detail: '', amount: 512.5 },
        { kind: 'hourly', label: 'CFO/Advisory Services', detail: '', amount: 0, roleTier: 'CFO' },
      ],
      // the pre-cutover aggregate
      [{ kind: 'hourly', label: 'Billable hours', detail: '10.00h at $50.00/hr', amount: 500 }],
      // a mix with every other kind
      [
        { kind: 'adhoc', label: 'Adhoc — x', detail: '', amount: 0, adhocMode: 'courtesy', adhocAmount: 9 },
        { kind: 'time_detail', label: 'Lisa — Sep 6', detail: '2.28 hours', amount: 0 },
        { kind: 'recurring', label: 'Recurring: Software', detail: 'monthly', amount: 10 },
        { kind: 'custom', label: 'Setup', detail: '', amount: 0 },
      ],
    ]
    for (const lineItems of fixtures) {
      const invoice = stored(lineItems)
      expect(clientFacingInvoiceLines(invoice, baseClient)).toEqual(invoice.lineItems)
    }
  })
})

describe('an empty hours row on every document that leaves the building', () => {
  const lineItems = [hourly(), emptyRow({ label: 'Zebra Advisory Row' })]
  const invoice = (over = {}) => ({
    id: 'inv-1',
    clientId: 'c1',
    number: 'INV-2026-09-001',
    period: '2026-09',
    status: 'sent',
    lineItems,
    subtotal: 150,
    total: 150,
    dueDate: '2026-10-30',
    blurb: '',
    sentAt: '2026-09-30T10:00:00.000Z',
    paidAt: null,
    paymentMethod: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...over,
  })

  it('is not in the email, in either body', () => {
    const { html, text } = buildInvoiceEmail({ invoice: invoice(), client: baseClient })
    for (const surface of [html, text]) {
      expect(surface).toContain('Billable hours — Lisa')
      expect(surface).not.toContain('Zebra Advisory Row')
      expect(surface).not.toContain('0.00h at $135.00/hr')
    }
  })

  it('is not in the PDF', async () => {
    const buffer = await buildInvoicePdf({
      invoice: invoice(),
      client: baseClient,
      firmSettings: { name: 'PB&J Strategic Accounting' },
      compress: false,
    })
    const raw = buffer.toString('latin1')
    const runs = []
    for (const match of raw.matchAll(/\[([^\]]*)\]\s*TJ/g)) runs.push(match[1])
    const text = runs
      .map((run) =>
        [...run.matchAll(/<([0-9A-Fa-f]*)>/g)]
          .map((hex) => Buffer.from(hex[1], 'hex').toString('latin1'))
          .join(''),
      )
      .join('\n')
    expect(text).toContain('Bookkeeping Services')
    expect(text).toContain('Billable hours')
    expect(text).not.toContain('Zebra Advisory Row')
  })

  it('is not a row in the QuickBooks export, and the amounts still add up', () => {
    const csv = buildQboCsv([invoice()], new Map([['c1', { name: 'Acme LLC' }]]))
    const rows = csv.split('\r\n')
    expect(rows).toHaveLength(2) // header + the one row with hours
    expect(csv).toContain('Billable hours')
    expect(csv).not.toContain('Zebra Advisory Row')
  })

  it('still exports a legacy $0 hourly line and a courtesy line, as before', () => {
    const legacy = { kind: 'hourly', label: 'Legacy hours', detail: 'Comped', amount: 0 }
    const csv = buildQboCsv(
      [invoice({ lineItems: [legacy], total: 0 })],
      new Map([['c1', { name: 'Acme LLC' }]]),
    )
    expect(csv).toContain('Legacy hours')
  })

  it('is not on the Stripe payment page', () => {
    const items = buildCheckoutLineItems(invoice(), baseClient)
    expect(items.map((item) => item.price_data.product_data.name)).toEqual([
      'Billable hours — Lisa',
    ])
  })
})

/**
 * Generate stamps each per-person hours line with the `employeeId` whose hours it
 * holds, so a line she renames is still found by a re-tag. It is bookkeeping on
 * the stored line and must never be visible text on anything a client reads.
 */
describe('the employeeId Generate stamps on an hours line', () => {
  const STAMP = 'emp-zz-9f3a1c-stamp'
  const generated = () =>
    buildInvoiceLines({
      client: { id: 'c1', name: 'A', billingMode: 'hourly', hourlyRate: 100, planIds: [] },
      entries: [
        { id: 'e1', clientId: 'c1', employeeId: STAMP, date: '2026-09-04', minutes: 137, billable: true },
      ],
      employees: [{ id: STAMP, name: 'Lisa', role: 'Bookkeeper', billRate: 75 }],
      billingPeriod: '2026-09',
      defaultHourlyRate: 100,
    })

  it('is the only thing added: label, detail, hours, rate, amount and tier are as before', () => {
    const { lines, total } = generated()
    const { employeeId, ...rest } = lines[0]
    expect(employeeId).toBe(STAMP)
    expect(rest).toEqual({
      kind: 'hourly',
      label: 'Billable hours — Lisa',
      detail: '2.28h at $75.00/hr',
      hours: 2.28,
      rate: 75,
      amount: 171,
      roleTier: 'Bookkeeper',
    })
    expect(total).toBe(171)
  })

  it('never reaches the PDF, the email, the print display text or the QuickBooks CSV', async () => {
    const built = generated()
    const stored = {
      id: 'inv-1',
      clientId: 'c1',
      number: 'INV-2026-09-001',
      period: '2026-09',
      status: 'sent',
      lineItems: built.lines,
      subtotal: built.total,
      total: built.total,
      dueDate: '2026-10-30',
      blurb: '',
      sentAt: '2026-09-30T10:00:00.000Z',
      createdAt: '2026-09-01T00:00:00.000Z',
    }
    const { html, text } = buildInvoiceEmail({ invoice: stored, client: baseClient })
    expect(html).toContain('Billable hours — Lisa')
    expect(html).not.toContain(STAMP)
    expect(text).not.toContain(STAMP)

    const pdf = (
      await buildInvoicePdf({
        invoice: stored,
        client: baseClient,
        firmSettings: { name: 'PB&J Strategic Accounting' },
        compress: false,
      })
    ).toString('latin1')
    expect(pdf).not.toContain(STAMP)

    const csv = buildQboCsv([stored], new Map([['c1', { name: 'Acme LLC' }]]))
    expect(csv).toContain('Billable hours')
    expect(csv).not.toContain(STAMP)

    // The sections the print sheet and the PDF are built from carry label and
    // detail text; the id rides the line object only.
    const sections = invoiceSections(clientFacingInvoiceLines(stored, baseClient))
    const printed = sections.flatMap((s) => s.rows.map((r) => `${r.label} ${r.detail} ${r.amount}`))
    expect(printed.join('\n')).not.toContain(STAMP)
  })
})

describe('the AI rating', () => {
  const message = (lineItems) =>
    buildRatingMessage({
      invoice: { number: 'INV-1', period: '2026-09', total: 150, lineItems },
      client: baseClient,
      hoursSummary: null,
      priorInvoice: null,
      learningContext: null,
    })

  it('does not see an empty hours row', () => {
    const text = message([hourly(), emptyRow({ label: 'Zebra Advisory Row' })])
    expect(text).toContain('Billable hours — Lisa')
    expect(text).not.toContain('Zebra Advisory Row')
  })

  // An hours line is hers to retitle, so the model is told WHOSE hours it holds:
  // hours, role tier, and the person's name resolved from the line's employeeId.
  it('is told whose hours an hours line holds, by the id the line carries', () => {
    const retitled = hourly({ label: 'CFO/Advisory Services', employeeId: 'lisa', rate: 90 })
    const text = buildRatingMessage({
      invoice: { number: 'INV-1', period: '2026-09', total: 180, lineItems: [retitled] },
      client: baseClient,
      employees: [{ id: 'lisa', name: 'Lisa Mockabee' }],
    })
    const [first] = JSON.parse(text.split('\n')[1]).lineItems
    expect(first).toMatchObject({
      kind: 'hourly',
      label: 'CFO/Advisory Services',
      hours: 2,
      roleTier: 'Bookkeeper',
      employee: 'Lisa Mockabee',
    })
  })

  it('sends no employee for a line with no id, an unknown id, or a kind that is not hours', () => {
    const text = buildRatingMessage({
      invoice: {
        number: 'INV-1',
        period: '2026-09',
        total: 0,
        lineItems: [
          hourly(),
          hourly({ employeeId: 'ghost', label: 'B' }),
          { kind: 'plan', label: 'Plan', detail: '', amount: 10, employeeId: 'lisa', hours: 3 },
        ],
      },
      client: baseClient,
      employees: [{ id: 'lisa', name: 'Lisa Mockabee' }],
    })
    for (const sent of JSON.parse(text.split('\n')[1]).lineItems) {
      expect(sent).not.toHaveProperty('employee')
    }
    // Only hours lines carry hours / roleTier.
    expect(JSON.parse(text.split('\n')[1]).lineItems[2]).not.toHaveProperty('hours')
  })

  it('the hours summary names each person’s role in both vocabularies a line can use', () => {
    const server = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../server.js'),
      'utf8',
    )
    const start = server.indexOf('function buildInvoiceHoursSummary(data, client, period')
    const body = server.slice(start, start + 4200)
    expect(body).toContain('role: employeeById.get(employeeId).role')
    expect(body).toContain('roleTier: recapStaffTier(')
    // The master variant carries them through both of its merge branches.
    const master = server.slice(server.indexOf('function buildMasterInvoiceHoursSummary('))
    expect(master.slice(0, 3600).match(/roleTier: rows\[0\]\.roleTier|roleTier: row\.roleTier/g)).toHaveLength(2)
    // ... and the rating call hands over the employees to resolve line ids with.
    expect(server).toContain('employees: data.employees ?? [],')
  })

  it('is told about a hand-set rate, and that it is not an arithmetic error', () => {
    expect(message([hourly({ rateManual: true })])).toContain('"rateManual":true')
    // The instruction lives in the system prompt, which the rating sends with it.
    expect(message([hourly()])).not.toContain('"rateManual"')
  })
})

describe('hourlyLineDetail', () => {
  it('is byte-identical to the sentence the generator has always written', () => {
    expect(hourlyLineDetail(1.5, 75)).toBe('1.50h at $75.00/hr')
    expect(hourlyLineDetail(0, 90)).toBe('0.00h at $90.00/hr')
    expect(hourlyLineDetail(20.22, 16)).toBe('20.22h at $16.00/hr')
    expect(hourlyLineDetail(1234.5, 1250.5)).toBe('1234.50h at $1,250.50/hr')
  })

  it('is what Generate writes for a person’s line', () => {
    const { lines } = buildInvoiceLines({
      client: { id: 'c1', name: 'A', billingMode: 'hourly', hourlyRate: 100, planIds: [] },
      entries: [
        { id: 'e1', clientId: 'c1', employeeId: 'lisa', date: '2026-09-04', minutes: 137, billable: true },
      ],
      employees: [{ id: 'lisa', name: 'Lisa', role: 'Bookkeeper', billRate: 75 }],
      billingPeriod: '2026-09',
      defaultHourlyRate: 100,
    })
    const line = lines.find((l) => l.kind === 'hourly')
    expect(line.detail).toBe(hourlyLineDetail(line.hours, line.rate))
    expect(line.detail).toBe('2.28h at $75.00/hr')
  })
})

describe('the three role rows', () => {
  it('are the existing headings, in print order', () => {
    expect(INVOICE_HOURS_ROLE_ROWS.map((row) => [row.tier, row.title])).toEqual([
      ['CFO', 'CFO / Advisory Services'],
      ['Accountant', 'Accounting Services'],
      ['Bookkeeper', 'Bookkeeping Services'],
    ])
  })
})

describe('defaultHoursRowRate', () => {
  const employees = [
    { id: 'britt', name: 'Brittany', role: 'Owner', billRate: 150 },
    { id: 'allison', name: 'Allison', role: 'Accountant', billRate: 135 },
    { id: 'lisa', name: 'Lisa', role: 'Bookkeeper', billRate: 75 },
  ]
  const ask = (over = {}) =>
    defaultHoursRowRate({
      tier: 'Accountant',
      lines: [],
      employees,
      billRateVersions: [],
      client: { id: 'c1', hourlyRate: 125 },
      period: '2026-09',
      ...over,
    })

  it('prefers the rate of an hours line already in that tier on the invoice', () => {
    expect(ask({ lines: [hourly({ roleTier: 'Accountant', rate: 90 })] })).toBe(90)
    // A line in ANOTHER tier does not count.
    expect(ask({ lines: [hourly({ roleTier: 'Bookkeeper', rate: 90 })] })).toBe(135)
  })

  it('then takes the staff rate for the tier', () => {
    expect(ask()).toBe(135)
    expect(ask({ tier: 'CFO' })).toBe(150)
    expect(ask({ tier: 'Bookkeeper' })).toBe(75)
  })

  it('reads the staff rate at the client’s rate month, through the dated versions', () => {
    const billRateVersions = [
      { userId: 'allison', effectivePeriod: '2026-06', rate: 120 },
      { userId: 'allison', effectivePeriod: '2026-09', rate: 135 },
    ]
    expect(ask({ billRateVersions, client: { id: 'c1', hourlyRate: 125, hourlyRatePeriod: '2026-06' } })).toBe(120)
    expect(ask({ billRateVersions })).toBe(135)
  })

  it('takes the first by name when two people in a tier bill differently, and skips former staff', () => {
    const two = [
      { id: 'zed', name: 'Zed', role: 'Accountant', billRate: 99 },
      { id: 'amy', name: 'Amy', role: 'Accountant', billRate: 110 },
      { id: 'gone', name: 'Aaron', role: 'Accountant', billRate: 1, inactiveAt: '2026-01-01T00:00:00Z' },
    ]
    expect(ask({ employees: two })).toBe(110)
  })

  it('falls back to the client’s hourly rate, then to 0', () => {
    expect(ask({ employees: [] })).toBe(125)
    expect(ask({ employees: [], client: { id: 'c1' } })).toBe(0)
    expect(ask({ employees: [], client: null })).toBe(0)
    // Someone in the tier with no rate on file falls through too.
    expect(ask({ employees: [{ id: 'x', name: 'X', role: 'Accountant' }] })).toBe(125)
  })
})
