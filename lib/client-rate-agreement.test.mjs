import { describe, expect, it } from 'vitest'
import { clientRateOverrideAt, validateClientRateAgreement } from './client-rate-agreement.js'
import { billRateAt } from './rate-history.js'
import { buildInvoiceLines } from './invoice-lines.js'
import { estimatedMonthlyInvoice } from './hourly-estimate.js'

const agreement = (rate, effectivePeriod = '2026-11', userId = null) => ({ rate, effectivePeriod, userId })
const client = (rows) => ({ id: 'c1', billingMode: 'hourly', hourlyRate: 80, hourlyRateOverrides: rows })
describe('effective client hourly agreements', () => {
  it('supports person, role, and all-team inheritance with client-specific examples only', () => {
    const c = client([agreement(120), { ...agreement(100), role: 'CFO' }, agreement(90, '2026-11', 'brittany-test')])
    expect(billRateAt([], { id: 'brittany-test', role: 'Owner' }, null, '2026-11', c)).toBe(90)
    expect(billRateAt([], { id: 'other-owner', role: 'Owner' }, null, '2026-11', c)).toBe(100)
    expect(billRateAt([], { id: 'bookkeeper-test', role: 'Bookkeeper' }, null, '2026-11', c)).toBe(120)
    const lilacExample = client([agreement(75, '2026-11', 'brittany-test')])
    expect(billRateAt([], { id: 'brittany-test', role: 'Owner' }, null, '2026-11', lilacExample)).toBe(75)
    // November is a synthetic test month, not a configured client effective date.
    expect(billRateAt([], { id: 'brittany-test', role: 'Owner', billRate: 125 }, null, '2026-10', lilacExample)).toBe(125)
  })
  it('uses billing month even when team rates are pinned to an earlier month', () => {
    const versions = [{ userId: 'e1', effectivePeriod: '2026-06', rate: 125 }]
    const c = client([agreement(95)])
    expect(billRateAt(versions, { id: 'e1' }, '2026-06', '2026-10', c)).toBe(125)
    expect(billRateAt(versions, { id: 'e1' }, '2026-06', '2026-11', c)).toBe(95)
  })
  it('inherits independently by scope and retains a deliberate zero rate', () => {
    const c = client([agreement(95), agreement(110, '2026-11', 'e1'), agreement(null, '2026-12', 'e1'), agreement(0, '2027-01'), agreement(null, '2027-02')])
    expect(clientRateOverrideAt(c, 'e1', '2026-11')).toBe(110)
    expect(clientRateOverrideAt(c, 'e1', '2026-12')).toBe(95)
    expect(clientRateOverrideAt(c, 'e1', '2027-01')).toBe(0)
    expect(clientRateOverrideAt(c, 'e1', '2027-02')).toBeNull()
    expect(clientRateOverrideAt({ ...c, billingMode: 'plan' }, 'e1', '2026-11')).toBeNull()
  })
  it('latest correction wins only for its effective month and future months', () => {
    const c = client([agreement(90), agreement(100, '2026-12'), agreement(95)])
    expect(clientRateOverrideAt(c, 'e1', '2026-11')).toBe(95)
    expect(clientRateOverrideAt(c, 'e1', '2026-12')).toBe(100)
  })
  it('prices actual time without rewriting saved time or invoice snapshots', () => {
    const entry = { id: 't1', clientId: 'c1', employeeId: 'e1', minutes: 90, billable: true, date: '2026-11-10' }
    const built = buildInvoiceLines({ client: client([agreement(95)]), employees: [{ id: 'e1', billRate: 125 }], entries: [entry], billingPeriod: '2026-11', defaultHourlyRate: 80 })
    expect(built.lines[0].amount).toBe(142.5)
    expect(entry).not.toHaveProperty('rate')
    const saved = structuredClone(built.lines)
    buildInvoiceLines({ client: client([agreement(150)]), employees: [{ id: 'e1', billRate: 125 }], entries: [entry], billingPeriod: '2026-11', defaultHourlyRate: 80 })
    expect(saved[0].amount).toBe(142.5)
  })
  it('uses zero client defaults in estimates as a known rate', () => {
    const result = estimatedMonthlyInvoice({ client: { ...client([agreement(0)]), estimatedBookkeeperHours: 10 }, period: '2026-11' })
    expect(result.total).toBe(0)
    expect(result.unrated).toEqual([])
    expect(result.basis).toBe('client_rate')
  })
  it('rejects malformed dates, rates, and identifiers', () => {
    const input = { id: 'aaaaaaaa-bbbb-cccc-dddd', effectivePeriod: '2026-11', rate: 99.999 }
    expect(validateClientRateAgreement(input).rate).toBe(100)
    for (const patch of [{ effectivePeriod: '2026-13' }, { rate: -1 }, { rate: NaN }, { id: 'x' }, { userId: '' }]) {
      expect(() => validateClientRateAgreement({ ...input, ...patch })).toThrow()
    }
  })
})
