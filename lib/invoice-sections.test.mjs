import { describe, expect, it } from 'vitest'

import {
  buildInvoiceLines,
  clientFacingInvoiceLines,
  invoiceDetailRows,
  invoiceSections,
} from './invoice-lines.js'

/**
 * The redesigned invoice's three sections (featreq-97ae3214), from her
 * 2026-08-31 email and marked-up sample: Subscription Plan / Ad-Hoc & Billable
 * Hours grouped by role / Client Reimbursed Expenses, each with its own total.
 *
 * THE CONSTRAINT Alex attached, and what most of this file exists to prove:
 * the section totals must sum to exactly what the per-person lines already
 * bill. That is why grouping is a PRESENTATION layer over resolved lines and
 * the money is only ever read — never recomputed, never re-rounded.
 *
 * The other half is the leak: sections are built from
 * `clientFacingInvoiceLines` output, so on a billing master's invoice they see
 * only the already-collapsed combined line. Grouping stored lines instead
 * would print the per-company breakdown the client chose not to receive — the
 * blocker caught on 2026-08-28.
 */

const employees = [
  { id: 'britt', name: 'Brittany Ferguson', role: 'Owner', billRate: 150 },
  { id: 'allison', name: 'Allison Lehmann', role: 'Accountant', billRate: 135 },
  { id: 'lisa', name: 'Lisa Mockabee', role: 'Bookkeeper', billRate: 75 },
]

const entries = [
  { id: 'e1', clientId: 'c1', employeeId: 'britt', date: '2026-08-04', minutes: 90, billable: true },
  { id: 'e2', clientId: 'c1', employeeId: 'allison', date: '2026-08-05', minutes: 45, billable: true },
  { id: 'e3', clientId: 'c1', employeeId: 'lisa', date: '2026-08-06', minutes: 137, billable: true },
  {
    id: 'e4',
    clientId: 'c1',
    employeeId: 'lisa',
    date: '2026-08-07',
    minutes: 30,
    billable: true,
    isAdhoc: true,
    description: 'Chased a bank letter',
  },
]

const build = (client = {}) =>
  buildInvoiceLines({
    client: { id: 'c1', name: 'Trust', billingMode: 'hourly', hourlyRate: 125, planIds: [], ...client },
    entries,
    employees,
    billingPeriod: '2026-08',
    defaultHourlyRate: 125,
    reimbursements: [
      { id: 'r1', clientId: 'c1', date: '2026-08-09', description: 'QuickBooks Online', amount: 30 },
    ],
  })

/** What the client's document actually gets: resolved lines, then sectioned. */
const sectionsFor = (invoiceLike, client) =>
  invoiceSections(clientFacingInvoiceLines(invoiceLike, client))

describe('roleTier rides the work lines, and changes nothing about the money', () => {
  it('maps each person by the tier mapping the recap already uses', () => {
    const { lines } = build()
    const tierOf = (name) => lines.find((l) => l.label.includes(name))?.roleTier
    expect(tierOf('Brittany Ferguson')).toBe('CFO')
    expect(tierOf('Allison Lehmann')).toBe('Accountant')
    expect(tierOf('Lisa Mockabee')).toBe('Bookkeeper')
  })

  it('stamps ad hoc lines too, from the person who did the work', () => {
    const adhoc = build().lines.find((l) => l.kind === 'adhoc')
    expect(adhoc.roleTier).toBe('Bookkeeper')
  })

  // The whole safety argument in one assertion: stamping is additive. If this
  // ever fails, the redesign has started moving money.
  it('leaves every amount, hours, rate and the line ORDER untouched', () => {
    const { lines, total } = build()
    const money = lines.map(({ kind, label, detail, amount, hours, rate }) => ({
      kind,
      label,
      detail,
      amount,
      hours,
      rate,
    }))
    expect(money).toEqual([
      {
        kind: 'hourly',
        label: 'Billable hours — Allison Lehmann',
        detail: '0.75h at $135.00/hr',
        amount: 101.25,
        hours: 0.75,
        rate: 135,
      },
      {
        kind: 'hourly',
        label: 'Billable hours — Brittany Ferguson',
        detail: '1.50h at $150.00/hr',
        amount: 225,
        hours: 1.5,
        rate: 150,
      },
      {
        kind: 'hourly',
        label: 'Billable hours — Lisa Mockabee',
        detail: '2.28h at $75.00/hr',
        amount: 171,
        hours: 2.28,
        rate: 75,
      },
      {
        kind: 'adhoc',
        label: 'Adhoc — Chased a bank letter',
        detail: 'Aug 7, 2026 · Lisa Mockabee · 0.50h at $75.00/hr',
        amount: 37.5,
        hours: undefined,
        rate: undefined,
      },
      {
        kind: 'reimbursement',
        label: 'Reimbursement: QuickBooks Online',
        detail: 'Aug 9, 2026',
        amount: 30,
        hours: undefined,
        rate: undefined,
      },
    ])
    expect(total).toBe(564.75)
  })

  it('leaves the pre-cutover legacy line unstamped, so it prints ungrouped', () => {
    const { lines } = buildInvoiceLines({
      client: { id: 'c1', name: 'Trust', billingMode: 'hourly', hourlyRate: 100, planIds: [] },
      entries: [{ id: 'x', clientId: 'c1', employeeId: 'lisa', date: '2026-05-04', minutes: 60, billable: true }],
      employees,
      billingPeriod: '2026-05',
      defaultHourlyRate: 100,
    })
    const legacy = lines.find((l) => l.kind === 'hourly')
    expect(legacy.label).toBe('Billable hours')
    expect(legacy.roleTier).toBeUndefined()
  })

  // NIT: a missing employee record must render UNGROUPED, not under a
  // titled 'Other Services' heading the data does not support. `recapStaffTier`
  // returns 'Other' for an unrecognized ROLE on a real employee — that is a
  // different case from no employee at all, and the two must not collapse
  // into the same heading.
  it('stamps no roleTier at all when the employee lookup fails (hourly)', () => {
    const { lines } = buildInvoiceLines({
      client: { id: 'c1', name: 'Trust', billingMode: 'hourly', hourlyRate: 125, planIds: [] },
      entries: [
        { id: 'e9', clientId: 'c1', employeeId: 'ghost', date: '2026-08-04', minutes: 60, billable: true },
      ],
      employees, // deliberately does not include 'ghost'
      billingPeriod: '2026-08',
      defaultHourlyRate: 125,
    })
    const row = lines.find((l) => l.kind === 'hourly')
    expect(row.label).toBe('Billable hours — Unknown')
    expect(row.roleTier).toBeUndefined()
    expect('roleTier' in row).toBe(false)
  })

  it('stamps no roleTier at all when the employee lookup fails (adhoc)', () => {
    const { lines } = buildInvoiceLines({
      client: { id: 'c1', name: 'Trust', billingMode: 'hourly', hourlyRate: 125, planIds: [] },
      entries: [
        {
          id: 'e10',
          clientId: 'c1',
          employeeId: 'ghost',
          date: '2026-08-04',
          minutes: 60,
          billable: true,
          isAdhoc: true,
          description: 'Mystery work',
        },
      ],
      employees, // deliberately does not include 'ghost'
      billingPeriod: '2026-08',
      defaultHourlyRate: 125,
    })
    const row = lines.find((l) => l.kind === 'adhoc')
    expect(row.detail).toContain('Unknown')
    expect(row.roleTier).toBeUndefined()
    expect('roleTier' in row).toBe(false)
  })
})

describe('the three sections', () => {
  /**
   * GENERATION NEVER PRODUCES ALL THREE SECTIONS AT ONCE, and that is correct:
   * `buildInvoiceLines` emits a plan line on subscription/annual clients and
   * per-person hours on hourly ones — the branches are exclusive. All three
   * together is a real state, just not a generated one: a billing master's
   * consolidated invoice merges drafts from subs on different billing modes,
   * and the owner can add a line by hand. So this fixture is written out
   * directly rather than built, and the generated shapes are asserted below it.
   */
  const invoice = () => ({
    period: '2026-08',
    total: 564.75 + 400,
    lineItems: [
      { kind: 'plan', label: 'Monthly service', detail: 'Monthly service', amount: 400 },
      ...build().lines,
    ],
  })

  it('titles them her way and omits any section with no rows', () => {
    const sections = sectionsFor(invoice(), { id: 'c1' })
    expect(sections.map((s) => s.title)).toEqual([
      'Subscription Plan',
      'Ad-Hoc / Billable Hours',
      'Client Reimbursed Expenses',
    ])
    expect(sections.map((s) => s.totalLabel)).toEqual([
      'Total Subscription Plan',
      'Total Ad-Hoc/Billable Hours',
      'Total Client Reimbursed Expenses',
    ])
  })

  it('omits a section the invoice has no rows for', () => {
    // An hourly client: hours + expenses, and no Subscription Plan heading.
    const { lines, total } = build()
    expect(
      sectionsFor({ period: '2026-08', total, lineItems: lines }, { id: 'c1' }).map((s) => s.key),
    ).toEqual(['work', 'expenses'])

    // A subscription client: the plan and its expenses, and no hours heading.
    const sub = build({ billingMode: 'subscription', monthlyRate: 400 })
    expect(
      sectionsFor({ period: '2026-08', total: sub.total, lineItems: sub.lines }, { id: 'c1' }).map(
        (s) => s.key,
      ),
    ).toEqual(['plan', 'expenses'])
  })

  it('groups the hours by role, in the fixed order, never reshuffling', () => {
    const work = sectionsFor(invoice(), { id: 'c1' }).find((s) => s.key === 'work')
    expect(work.groups.map((g) => g.title)).toEqual([
      'CFO / Advisory Services',
      'Accounting Services',
      'Bookkeeping Services',
    ])
    // Lisa's scoped hours AND her ad hoc line land in her one bucket.
    const bookkeeping = work.groups.find((g) => g.title === 'Bookkeeping Services')
    expect(bookkeeping.rows).toHaveLength(2)
  })

  // S4: `roleTier` used to be looked up with `!ROLE_GROUP_TITLES[line?.roleTier]`,
  // a bracket lookup on a plain object — a value like 'constructor' is truthy
  // there via Object.prototype, so the row matched neither the untitled bucket
  // nor any named tier and vanished from the rendered rows while its money
  // stayed inside `section.total`. Partitioning off `ROLE_GROUP_ORDER.includes`
  // closes that: nothing not in the fixed tier list can hide from the untitled
  // bucket.
  it('treats a prototype-key roleTier like "constructor" as untitled, not dropped', () => {
    const lines = [
      { kind: 'hourly', label: 'Billable hours — Odd', amount: 40, roleTier: 'constructor' },
      { kind: 'hourly', label: 'Billable hours — Lisa', amount: 50, roleTier: 'Bookkeeper' },
    ]
    const work = invoiceSections(lines).find((s) => s.key === 'work')
    expect(work.groups[0].title).toBeNull()
    expect(work.groups[0].rows.map((r) => r.label)).toEqual(['Billable hours — Odd'])
    // Nothing lost from the section's own total either.
    const rowCount = work.groups.reduce((n, g) => n + g.rows.length, 0)
    expect(rowCount).toBe(2)
    expect(work.total).toBe(90)
  })

  it('puts rows with no role FIRST and untitled, rather than under a guess', () => {
    const work = invoiceSections([
      { kind: 'hourly', label: 'Billable hours', amount: 100 },
      { kind: 'hourly', label: 'Billable hours — Lisa', amount: 50, roleTier: 'Bookkeeper' },
    ]).find((s) => s.key === 'work')
    expect(work.groups[0].title).toBeNull()
    expect(work.groups[0].rows[0].label).toBe('Billable hours')
    expect(work.groups[1].title).toBe('Bookkeeping Services')
  })

  // THE constraint, stated as arithmetic.
  it('section totals sum to exactly what the lines already billed', () => {
    const inv = invoice()
    const sections = sectionsFor(inv, { id: 'c1' })
    const summed = sections.reduce((t, s) => t + (s.total ?? 0), 0)
    expect(Math.round(summed * 100) / 100).toBe(inv.total)
    // And each section's total is its own rows, nothing borrowed.
    for (const section of sections) {
      const own = section.rows.reduce((t, r) => t + r.amount, 0)
      expect(section.total).toBe(Math.round(own * 100) / 100)
    }
  })

  it('states charges and credits plainly, with no section total of their own', () => {
    const sections = invoiceSections([
      { kind: 'plan', label: 'Monthly service', amount: 400 },
      { kind: 'card-fee', label: 'Card processing fee', amount: 12.4 },
      { kind: 'adjustment', label: 'Last month true-up', amount: -25 },
    ])
    const charges = sections.find((s) => s.key === 'charges')
    expect(charges.title).toBeNull()
    expect(charges.total).toBeNull()
    expect(charges.rows.map((r) => r.kind)).toEqual(['card-fee', 'adjustment'])
  })

  it('keeps the detailed hours out of the sections — they are page 2', () => {
    const lines = [
      { kind: 'hourly', label: 'Billable hours — Lisa', amount: 50, roleTier: 'Bookkeeper' },
      { kind: 'time_detail', label: 'Lisa — Aug 6', detail: '2.28 hours', amount: 0 },
    ]
    const work = invoiceSections(lines).find((s) => s.key === 'work')
    expect(work.rows).toHaveLength(1)
    expect(invoiceDetailRows(lines)).toHaveLength(1)
  })
})

describe("a billing master's invoice still says nothing about its companies", () => {
  const masterInvoice = {
    period: '2026-08',
    total: 720,
    lineItems: [
      { kind: 'hourly', label: 'Billable hours — Lisa', amount: 500, roleTier: 'Bookkeeper', sourceClientId: 'sub-chemtrex' },
      { kind: 'plan', label: 'Chemtrex — Monthly service', amount: 185, sourceClientId: 'sub-chemtrex' },
      { kind: 'card-fee', label: 'Card processing fee', amount: 35 },
    ],
  }
  const master = { id: 'master', isBillingMaster: true }

  it('collapses to ONE untitled section with no total', () => {
    const sections = invoiceSections(clientFacingInvoiceLines(masterInvoice, master), {
      combined: true,
    })
    expect(sections).toHaveLength(1)
    expect(sections[0].title).toBeNull()
    expect(sections[0].totalLabel).toBeNull()
    expect(sections[0].total).toBeNull()
  })

  // The regression that would re-open the 2026-08-28 leak: any section title,
  // any role heading, or any per-company amount reaching a master's document.
  it('prints no section title, no role heading and no company amount', () => {
    const sections = invoiceSections(clientFacingInvoiceLines(masterInvoice, master), {
      combined: true,
    })
    const rendered = JSON.stringify(sections)
    for (const forbidden of [
      'Subscription Plan',
      'Ad-Hoc / Billable Hours',
      'Client Reimbursed Expenses',
      'Bookkeeping Services',
      'Chemtrex',
      'sub-chemtrex',
    ]) {
      expect(rendered).not.toContain(forbidden)
    }
    // 500 and 185 were the per-company amounts; only the collapsed figure and
    // the separately-stated fee may appear.
    const amounts = sections[0].rows.map((r) => r.amount)
    expect(amounts).toEqual([685, 35])
  })

  it('has no page 2 to print, because the detail never survives the collapse', () => {
    const withDetail = {
      ...masterInvoice,
      lineItems: [...masterInvoice.lineItems, { kind: 'time_detail', label: 'Lisa — Aug 6', amount: 0 }],
    }
    expect(invoiceDetailRows(clientFacingInvoiceLines(withDetail, master))).toEqual([])
  })
})

/**
 * S2: `invoiceSections` used to bucket by ALLOWLIST with no residual — a line
 * whose kind matched none of the named sets (a `combined` line handed to this
 * in the wrong mode, a kind added to `INVOICE_LINE_KINDS` after this file was
 * last touched, or no kind at all) was silently dropped from the document
 * while its money stayed inside `invoice.total`. The `charges` block is now
 * the RESIDUAL — everything not already claimed by plan/work/expenses, minus
 * a zero-amount `time_detail` row (that one is page 2, not a charge) — so
 * nothing with money on it can fall through the cracks.
 *
 * This is the one test that would have caught the 2026-08-28 blocker: every
 * kind the store recognizes, PLUS a line with no kind at all, has to land in
 * exactly one section's rows.
 */
describe('S2 — every kind of line lands in exactly one section', () => {
  // Mirrors db/store.js:844-868 (`INVOICE_LINE_KINDS`) — 11 kinds. Kept as a
  // literal list rather than an import: this lib module has no access to the
  // store's internal Set, and the point of this test is to notice the day
  // that list and this one drift.
  const ALL_INVOICE_LINE_KINDS = [
    'plan',
    'hourly',
    'reimbursement',
    'recurring',
    'adjustment',
    'custom',
    'card-fee',
    'adhoc',
    'retainer',
    'retainer_credit',
    'time_detail',
  ]

  const linesForEveryKind = () => [
    ...ALL_INVOICE_LINE_KINDS.map((kind) => ({ kind, label: `${kind} line`, amount: 5 })),
    // No `kind` at all — a hand-typed line, or one that predates this field.
    { label: 'x', amount: 5 },
  ]

  it('accounts for every row in standard mode — nothing dropped', () => {
    const lines = linesForEveryKind()
    const sections = invoiceSections(lines, { combined: false })
    const rowCount = sections.reduce((sum, section) => sum + section.rows.length, 0)
    expect(rowCount).toBe(lines.length)
  })

  it('accounts for every row in combined mode — nothing dropped', () => {
    const lines = linesForEveryKind()
    const sections = invoiceSections(lines, { combined: true })
    const rowCount = sections.reduce((sum, section) => sum + section.rows.length, 0)
    expect(rowCount).toBe(lines.length)
  })

  it('puts an unrecognized or kind-less line in the untitled charges block, not nowhere', () => {
    const sections = invoiceSections(linesForEveryKind(), { combined: false })
    const charges = sections.find((section) => section.key === 'charges')
    expect(charges.rows.map((row) => row.kind)).toEqual(
      expect.arrayContaining(['adjustment', 'custom', 'card-fee', 'retainer', 'retainer_credit']),
    )
    const kindless = charges.rows.find((row) => row.kind === undefined)
    expect(kindless?.label).toBe('x')
  })
})
