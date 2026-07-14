import { describe, expect, it } from 'vitest'
import { addDays, weekStartOf } from '../lib/utils'

/**
 * The Payroll hours report computes its window as the Sun–Sat week of the chosen
 * date, extended to 1 week (weekly) or 2 weeks (bi-weekly). Prev/Next steps by a
 * full period, so the bi-weekly cadence is preserved once aligned to payroll.
 */
describe('payroll period window', () => {
  const windowFor = (anchor: string, type: 'weekly' | 'biweekly') => {
    const start = weekStartOf(anchor)
    const end = addDays(start, (type === 'weekly' ? 7 : 14) - 1)
    return { start, end }
  }

  it('weekly = the Sun–Sat week (7 days inclusive)', () => {
    // 2026-07-08 is a Wednesday; its week starts Sun 2026-07-05.
    expect(windowFor('2026-07-08', 'weekly')).toEqual({ start: '2026-07-05', end: '2026-07-11' })
  })

  it('bi-weekly = two consecutive Sun–Sat weeks (14 days inclusive)', () => {
    expect(windowFor('2026-07-08', 'biweekly')).toEqual({ start: '2026-07-05', end: '2026-07-18' })
  })

  it('a Sunday anchors to itself', () => {
    expect(weekStartOf('2026-07-05')).toBe('2026-07-05')
  })

  it('stepping a bi-weekly period moves by exactly 14 days (keeps cadence)', () => {
    const { start } = windowFor('2026-07-08', 'biweekly')
    expect(addDays(start, 14)).toBe('2026-07-19')
    expect(addDays(start, -14)).toBe('2026-06-21')
  })
})
