import { describe, expect, it } from 'vitest'
import { localDateOnly } from '../lib/utils'

/**
 * `localDateOnly` must return the LOCAL calendar day, not the UTC day — the bug
 * was that timer entries used `new Date(ms).toISOString().slice(0,10)` (UTC),
 * so evening work in US time zones logged on the next day / week.
 *
 * These assertions are timezone-independent: a Date built with local
 * components (new Date(y, m, d, h, ...)) is, by definition, that local day, and
 * localDateOnly reads it back with local getters.
 */
describe('localDateOnly', () => {
  it('formats a Date as its local YYYY-MM-DD', () => {
    expect(localDateOnly(new Date(2026, 5, 17, 9, 0))).toBe('2026-06-17')
  })

  it('uses the local day for a late-evening time (the timer-rollover case)', () => {
    // 11:30pm local on June 17 stays June 17, even though it may be June 18 UTC.
    expect(localDateOnly(new Date(2026, 5, 17, 23, 30))).toBe('2026-06-17')
  })

  it('zero-pads month and day', () => {
    expect(localDateOnly(new Date(2026, 0, 5, 12, 0))).toBe('2026-01-05')
  })

  it('accepts a millisecond timestamp', () => {
    const ms = new Date(2026, 11, 31, 8, 0).getTime()
    expect(localDateOnly(ms)).toBe('2026-12-31')
  })

  it('matches the wall-clock day across a year boundary', () => {
    expect(localDateOnly(new Date(2027, 0, 1, 0, 1))).toBe('2027-01-01')
  })
})
