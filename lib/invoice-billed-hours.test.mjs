import { describe, expect, it } from 'vitest'

import { buildInvoiceLines } from './invoice-lines.js'
import { periodDisplayHours, periodMoney } from './payroll-cost.js'

/**
 * Billing shares THE hours rule — featreq-cfb1536a, closed by Brittany's
 * revised answer (in person, 2026-09-01): **A — no automatic rounding.** An
 * invoice charges exactly the two-decimal hours it prints, times the rate; if
 * she wants a rounder number she edits the hours field and the amount follows.
 *
 * The defect this ends is the recap's "math still is not mathing": invoices
 * charged raw clock minutes under a detail reading "1.31h", so nothing on the
 * document multiplied into its own amount. Her screenshot's client printed
 * hours totalling $103.75 over a revenue line of $103.54.
 *
 * The hours are the SUM OF THE ROWS' two-decimal hours (`periodDisplayHours`) —
 * the same figure the recap's roles table and the payroll report print — never
 * a re-rounding of the raw total. Same rule, both sides of the money.
 */

const employees = [
  { id: 'lisa', name: 'Lisa', billRate: 75 },
  { id: 'britt', name: 'Brittany', billRate: 125 },
]

// Five uneven slivers for Lisa (raw 1.3050h; rows print 0.42+0.16+0.40+0.21+0.12
// = 1.31h) and one for Brittany (2.72 min → 0.05h). Shaped like the production
// case she reopened the recap over.
const entries = [
  { id: 'a', clientId: 'c1', employeeId: 'lisa', date: '2026-08-05', minutes: 25.05, billable: true },
  { id: 'b', clientId: 'c1', employeeId: 'lisa', date: '2026-08-06', minutes: 9.9, billable: true },
  { id: 'c', clientId: 'c1', employeeId: 'lisa', date: '2026-08-07', minutes: 23.87, billable: true },
  { id: 'd', clientId: 'c1', employeeId: 'lisa', date: '2026-08-08', minutes: 12.4, billable: true },
  { id: 'e', clientId: 'c1', employeeId: 'lisa', date: '2026-08-09', minutes: 7.08, billable: true },
  { id: 'f', clientId: 'c1', employeeId: 'britt', date: '2026-08-10', minutes: 2.72, billable: true },
]

const build = () =>
  buildInvoiceLines({
    client: { id: 'c1', name: 'Trust', billingMode: 'hourly', hourlyRate: 125, planIds: [] },
    entries,
    employees,
    billingPeriod: '2026-08',
    defaultHourlyRate: 125,
  })

describe('an hourly line charges the hours it prints', () => {
  it('prices each person by the rows rule, not their raw clock time', () => {
    const { lines } = build()
    const lisa = lines.find((line) => line.label.includes('Lisa'))
    const lisaRows = entries.filter((e) => e.employeeId === 'lisa').map((e) => e.minutes)
    expect(lisa.hours).toBe(periodDisplayHours(lisaRows))
    expect(lisa.amount).toBe(periodMoney(lisaRows, 75))
    // The raw pricing this replaces: 78.3 minutes at $75 was $97.88 under a
    // detail that said hours no reader could turn into $97.88.
    expect(lisa.amount).not.toBe(Math.round((78.3 / 60) * 75 * 100) / 100)
  })

  it('every hourly line multiplies by hand: amount = hours × rate, to the cent', () => {
    for (const line of build().lines.filter((l) => l.kind === 'hourly')) {
      expect(line.amount).toBe(Math.round(line.hours * line.rate * 100) / 100)
      // …and the detail says the same hours the price uses.
      expect(line.detail).toContain(`${line.hours.toFixed(2)}h`)
    }
  })

  it('the tiny line is exact: 0.05h at $125 is $6.25, not $5.66', () => {
    const britt = build().lines.find((line) => line.label.includes('Brittany'))
    expect(britt.hours).toBe(0.05)
    expect(britt.amount).toBe(6.25)
  })

  it('carries hours and rate on the line for the editor to own', () => {
    for (const line of build().lines.filter((l) => l.kind === 'hourly')) {
      expect(typeof line.hours).toBe('number')
      expect(typeof line.rate).toBe('number')
    }
  })
})

describe('an ad hoc line charges the hours it prints too', () => {
  it('prices the 2dp hours its own detail text shows', () => {
    const { lines } = buildInvoiceLines({
      client: { id: 'c1', name: 'Trust', billingMode: 'hourly', hourlyRate: 125, planIds: [] },
      entries: [
        { id: 'x', clientId: 'c1', employeeId: 'lisa', date: '2026-08-05', minutes: 50, billable: true, isAdhoc: true },
      ],
      employees,
      billingPeriod: '2026-08',
      defaultHourlyRate: 125,
    })
    const adhoc = lines.find((line) => line.kind === 'adhoc')
    // 50 minutes prints 0.83h; 0.83 × 75 = $62.25 (raw was $62.50).
    expect(adhoc.detail).toContain('0.83h')
    expect(adhoc.amount).toBe(62.25)
    expect(adhoc.adhocAmount).toBe(62.25)
  })
})
