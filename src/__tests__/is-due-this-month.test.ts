import { describe, expect, it } from 'vitest'
import { isDueThisMonth } from '../lib/utils'

/**
 * `isDueThisMonth` powers the client-detail Active checklists "Due this month"
 * toggle. It compares the YYYY-MM prefix of an effective due date against
 * "today", so it's a pure, timezone-safe string check.
 */
describe('isDueThisMonth', () => {
  const today = '2026-06-22'

  it('is true for a due date in the current calendar month', () => {
    expect(isDueThisMonth('2026-06-01', today)).toBe(true)
    expect(isDueThisMonth('2026-06-22', today)).toBe(true)
    expect(isDueThisMonth('2026-06-30', today)).toBe(true)
  })

  it('is false for the previous month', () => {
    expect(isDueThisMonth('2026-05-31', today)).toBe(false)
  })

  it('is false for the next month', () => {
    expect(isDueThisMonth('2026-07-01', today)).toBe(false)
  })

  it('is false for the same month in a different year', () => {
    expect(isDueThisMonth('2025-06-22', today)).toBe(false)
    expect(isDueThisMonth('2027-06-22', today)).toBe(false)
  })

  it('is false for empty or malformed dates', () => {
    expect(isDueThisMonth('', today)).toBe(false)
    expect(isDueThisMonth('2026', today)).toBe(false)
  })
})
