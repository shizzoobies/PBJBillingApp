import { describe, expect, it } from 'vitest'

import {
  buildInvoiceLines,
  hoursLineLabel,
  hoursLineLabelShapes,
  invoiceSections,
  clientFacingInvoiceLines,
} from './invoice-lines.js'

/**
 * What Generate calls an hours line, and whose hours it remembers it holds.
 *
 * Each person still gets their OWN line (one rate per line, hours that add up to
 * Reports to the cent, an entry-to-line mapping the hours panel can rely on).
 * What changed is the wording the client reads: the role's title, the heading she
 * writes by hand ("Accounting Services"), instead of "Billable hours — <name>";
 * the name comes back only when two people in one role would otherwise share a
 * label. Hours, rate, amount and the invoice total are the same as they were.
 */

const client = { id: 'c1', name: 'Acme', billingMode: 'hourly', hourlyRate: 100, planIds: [] }

const staff = [
  { id: 'britt', name: 'Brittany Ferguson', role: 'Owner', billRate: 150 },
  { id: 'allison', name: 'Allison Lehmann', role: 'Accountant', billRate: 135 },
  { id: 'sam', name: 'Sam Porter', role: 'Accountant', billRate: 110 },
  { id: 'lisa', name: 'Lisa Mockabee', role: 'Bookkeeper', billRate: 75 },
]

const entry = (id, employeeId, minutes, over = {}) => ({
  id,
  clientId: 'c1',
  employeeId,
  date: '2026-08-04',
  minutes,
  billable: true,
  ...over,
})

const build = (entries, employees = staff, over = {}) =>
  buildInvoiceLines({
    client,
    entries,
    employees,
    billingPeriod: '2026-08',
    defaultHourlyRate: 100,
    ...over,
  })

const hourly = (built) => built.lines.filter((line) => line.kind === 'hourly')

describe('hoursLineLabel', () => {
  it('is the role title for the three roles, with the name only when shared', () => {
    expect(hoursLineLabel(staff[0])).toBe('CFO / Advisory Services')
    expect(hoursLineLabel(staff[1])).toBe('Accounting Services')
    expect(hoursLineLabel(staff[3])).toBe('Bookkeeping Services')
    expect(hoursLineLabel(staff[1], { shared: true })).toBe('Accounting Services — Allison Lehmann')
  })

  it('keeps "Billable hours — <name>" for Other and for a person with no record', () => {
    expect(hoursLineLabel({ name: 'Zed', role: 'Intern' })).toBe('Billable hours — Zed')
    expect(hoursLineLabel({ name: 'Zed', role: 'Intern' }, { shared: true })).toBe(
      'Billable hours — Zed',
    )
    expect(hoursLineLabel(undefined)).toBe('Billable hours — Unknown')
  })

  it('lists every shape a person’s line has carried, for the re-tag’s fallback', () => {
    expect(hoursLineLabelShapes(staff[1])).toEqual({
      old: 'Billable hours — Allison Lehmann',
      // Name-bearing only: a bare "Accounting Services" with no employeeId is a
      // hand-typed row, never matched by a re-tag.
      titled: ['Accounting Services — Allison Lehmann'],
      tier: 'Accountant',
    })
    expect(hoursLineLabelShapes({ name: 'Zed', role: 'Intern' })).toEqual({
      old: 'Billable hours — Zed',
      titled: [],
      tier: 'Other',
    })
  })
})

describe('Generate: the hours lines', () => {
  it('stamps each person’s line with their employeeId', () => {
    const built = build([entry('1', 'britt', 90), entry('2', 'lisa', 60)])
    expect(hourly(built).map((line) => line.employeeId)).toEqual(['britt', 'lisa'])
  })

  it('labels each line by its role when each role has one person', () => {
    const built = build([entry('1', 'lisa', 60), entry('2', 'britt', 90), entry('3', 'allison', 30)])
    expect(hourly(built).map((line) => [line.label, line.roleTier])).toEqual([
      ['CFO / Advisory Services', 'CFO'],
      ['Accounting Services', 'Accountant'],
      ['Bookkeeping Services', 'Bookkeeper'],
    ])
  })

  it('appends the name when two people share a role, so two rows never share a label', () => {
    const built = build([
      entry('1', 'sam', 60),
      entry('2', 'allison', 60),
      entry('3', 'lisa', 60),
    ])
    expect(hourly(built).map((line) => line.label)).toEqual([
      'Accounting Services — Allison Lehmann',
      'Accounting Services — Sam Porter',
      'Bookkeeping Services',
    ])
    const labels = hourly(built).map((line) => line.label)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('counts a role’s people on THIS invoice: one of two accountants alone is still bare', () => {
    expect(hourly(build([entry('1', 'sam', 60)]))[0].label).toBe('Accounting Services')
  })

  it('keeps "Billable hours — <name>" for Other and tier-less lines, which sort last', () => {
    const employees = [...staff, { id: 'zed', name: 'Zed', role: 'Intern', billRate: 50 }]
    const built = build(
      [entry('1', 'zed', 60), entry('2', 'ghost', 60), entry('3', 'lisa', 60)],
      employees,
    )
    const lines = hourly(built)
    expect(lines.map((line) => line.label)).toEqual([
      'Bookkeeping Services',
      'Billable hours — Zed',
      'Billable hours — Unknown',
    ])
    expect(lines[1].roleTier).toBe('Other')
    // A missing record is "unknown tier", never "Other" — as before.
    expect(lines[2]).not.toHaveProperty('roleTier')
    expect(lines[2].employeeId).toBe('ghost')
  })

  it('sorts by role, then name', () => {
    const built = build([
      entry('1', 'lisa', 60),
      entry('2', 'sam', 60),
      entry('3', 'allison', 60),
      entry('4', 'britt', 60),
    ])
    expect(hourly(built).map((line) => line.employeeId)).toEqual(['britt', 'allison', 'sam', 'lisa'])
  })

  it('leaves hours, rate and amount exactly as they were, and the total bit-for-bit', () => {
    // Zed (CFO), Bob (Accountant), Amy (Bookkeeper): sorted by NAME the lines run
    // Amy, Bob, Zed; shown by ROLE they run Zed, Bob, Amy. Float addition is not
    // associative — summed in the new display order this total would read 1.3,
    // and it has always read what the old name order adds up to.
    const employees = [
      { id: 'z', name: 'Zed', role: 'Owner', billRate: 0.1 },
      { id: 'b', name: 'Bob', role: 'Accountant', billRate: 0.1 },
      { id: 'a', name: 'Amy', role: 'Bookkeeper', billRate: 1.1 },
    ]
    const built = build([entry('1', 'z', 60), entry('2', 'b', 60), entry('3', 'a', 60)], employees)
    expect(hourly(built).map((line) => [line.hours, line.rate, line.amount])).toEqual([
      [1, 0.1, 0.1],
      [1, 0.1, 0.1],
      [1, 1.1, 1.1],
    ])
    const byName = hourly(built)
      .slice()
      .sort((a, b) => (a.employeeId < b.employeeId ? -1 : 1)) // a, b, z
    expect(built.total).toBe(byName.reduce((sum, line) => sum + line.amount, 0))
    expect(built.total).not.toBe(hourly(built).reduce((sum, line) => sum + line.amount, 0))
  })

  it('does not touch the pre-2026-06 aggregate line', () => {
    const built = buildInvoiceLines({
      client,
      entries: [entry('1', 'lisa', 120, { date: '2026-05-04' })],
      employees: staff,
      billingPeriod: '2026-05',
      defaultHourlyRate: 100,
    })
    expect(built.lines).toEqual([
      { kind: 'hourly', label: 'Billable hours', detail: '2.00h at $100.00/hr', amount: 200 },
    ])
  })

  it('still prints under the right headings on the client’s copy', () => {
    const built = build([entry('1', 'britt', 60), entry('2', 'lisa', 60)])
    const sections = invoiceSections(
      clientFacingInvoiceLines({ lineItems: built.lines, total: built.total, period: '2026-08' }, client),
    )
    expect(sections[0].groups.map((group) => [group.title, group.rows.map((row) => row.label)])).toEqual([
      ['CFO / Advisory Services', ['CFO / Advisory Services']],
      ['Bookkeeping Services', ['Bookkeeping Services']],
    ])
  })
})
