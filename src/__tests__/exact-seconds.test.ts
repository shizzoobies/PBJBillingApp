import { describe, expect, it } from 'vitest'
import { normalizeWorkSessions } from '../../lib/time-entry.js'
import { formatHoursMinutes, sessionMinutes } from '../lib/utils'

/**
 * Sub-minute / exact-seconds time logging: a timer stopped under a minute must
 * record the real duration (fractional minutes), not get rounded up to 1 min
 * or away to 0. Minutes can be fractional (45s = 0.75); displays show seconds.
 */
describe('exact-seconds time logging', () => {
  it('records a sub-minute span as fractional minutes', () => {
    const result = normalizeWorkSessions([
      { startAt: '2026-06-01T09:00:00.000Z', endAt: '2026-06-01T09:00:45.000Z' },
    ])
    expect(result.error).toBeNull()
    expect(result.minutes).toBeCloseTo(0.75, 5) // 45s
  })

  it('keeps whole-minute spans whole', () => {
    const result = normalizeWorkSessions([
      { startAt: '2026-06-01T09:00:00.000Z', endAt: '2026-06-01T10:00:00.000Z' },
    ])
    expect(result.minutes).toBe(60)
  })

  it('sums multiple sub-minute sessions to seconds precision', () => {
    const result = normalizeWorkSessions([
      { startAt: '2026-06-01T09:00:00.000Z', endAt: '2026-06-01T09:00:30.000Z' }, // 30s
      { startAt: '2026-06-01T09:05:00.000Z', endAt: '2026-06-01T09:05:30.000Z' }, // 30s
    ])
    expect(result.minutes).toBeCloseTo(1, 5) // 60s total
  })

  it('sessionMinutes is seconds-precise', () => {
    expect(
      sessionMinutes({
        startAt: '2026-06-01T09:00:00.000Z',
        endAt: '2026-06-01T09:00:30.000Z',
      }),
    ).toBeCloseTo(0.5, 5)
  })

  it('formats sub-minute and mixed durations with seconds, keeping legacy whole values', () => {
    expect(formatHoursMinutes(0.75)).toBe('45s')
    expect(formatHoursMinutes(1.5)).toBe('1m 30s')
    expect(formatHoursMinutes(45)).toBe('45m')
    expect(formatHoursMinutes(80)).toBe('1h 20m')
    expect(formatHoursMinutes(120)).toBe('2h')
    expect(formatHoursMinutes(0)).toBe('0s')
  })
})
