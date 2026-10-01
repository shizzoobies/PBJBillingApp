import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_FIRM_TIME_ZONE, dateOnlyInZone, firmTimeZone, firmToday } from './firm-time.js'

/**
 * The firm's calendar day, read off an instant. The server runs in UTC and the
 * firm works in US Eastern, so from 8 pm Eastern the two disagree about what
 * day (and on the last evening of a month, what month) it is.
 */

const savedTz = process.env.TZ
// Deleting TZ does not put a process back on its own zone, so the restore
// below names the zone the host started in.
const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone
const savedFirmZone = process.env.FIRM_TIME_ZONE

afterEach(() => {
  process.env.TZ = savedTz ?? hostZone
  if (savedFirmZone === undefined) delete process.env.FIRM_TIME_ZONE
  else process.env.FIRM_TIME_ZONE = savedFirmZone
  vi.useRealTimers()
  vi.restoreAllMocks()
})

beforeEach(() => {
  delete process.env.FIRM_TIME_ZONE
})

describe('firmTimeZone', () => {
  it('is US Eastern unless the server is told otherwise', () => {
    expect(DEFAULT_FIRM_TIME_ZONE).toBe('America/New_York')
    expect(firmTimeZone()).toBe('America/New_York')
  })

  it('honors FIRM_TIME_ZONE', () => {
    process.env.FIRM_TIME_ZONE = 'America/Chicago'
    expect(firmTimeZone()).toBe('America/Chicago')
  })

  it('falls back to Eastern on a zone the runtime does not know, and never throws', () => {
    // The materializer asks for today on every read. A typo in a Railway
    // variable must not turn into a 500 on every page load.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.FIRM_TIME_ZONE = 'Mars/Olympus_Mons'
    expect(firmTimeZone()).toBe('America/New_York')
    expect(firmToday(new Date('2026-10-01T01:00:00.000Z'))).toBe('2026-09-30')
    expect(warn).toHaveBeenCalled()
  })

  it('treats a blank FIRM_TIME_ZONE as unset', () => {
    process.env.FIRM_TIME_ZONE = '   '
    expect(firmTimeZone()).toBe('America/New_York')
  })
})

describe('firmToday', () => {
  it('is still September 30th at 9 pm Eastern, when UTC already says October 1st', () => {
    const ninePmEastern = new Date('2026-10-01T01:00:00.000Z')
    expect(ninePmEastern.toISOString().slice(0, 10)).toBe('2026-10-01')
    expect(firmToday(ninePmEastern)).toBe('2026-09-30')
  })

  it('rolls over at Eastern midnight, in daylight time and in standard time', () => {
    // EDT is UTC-4.
    expect(firmToday(new Date('2026-10-01T03:59:59.000Z'))).toBe('2026-09-30')
    expect(firmToday(new Date('2026-10-01T04:00:00.000Z'))).toBe('2026-10-01')
    // EST is UTC-5.
    expect(firmToday(new Date('2026-12-01T04:59:59.000Z'))).toBe('2026-11-30')
    expect(firmToday(new Date('2026-12-01T05:00:00.000Z'))).toBe('2026-12-01')
  })

  it('reads the system clock when no instant is given', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2027-01-01T02:00:00.000Z'))
    // 9 pm on New Year's Eve in the east.
    expect(firmToday()).toBe('2026-12-31')
  })

  it.each(['UTC', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo'])(
    'answers the same on a host whose own zone is %s',
    (hostZone) => {
      process.env.TZ = hostZone
      expect(firmToday(new Date('2026-10-01T01:00:00.000Z'))).toBe('2026-09-30')
      expect(firmToday(new Date('2026-10-01T04:00:00.000Z'))).toBe('2026-10-01')
    },
  )

  it('always answers with a date: a now that is not a real Date means the current instant', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-01T01:00:00.000Z'))
    expect(firmToday(new Date('not a date'))).toBe('2026-09-30')
    expect(firmToday(null)).toBe('2026-09-30')
    expect(firmToday('2026-10-01')).toBe('2026-09-30')
  })

  it('follows FIRM_TIME_ZONE', () => {
    // 04:30Z is 00:30 in New York and 23:30 the day before in Chicago.
    const instant = new Date('2026-10-01T04:30:00.000Z')
    expect(firmToday(instant)).toBe('2026-10-01')
    process.env.FIRM_TIME_ZONE = 'America/Chicago'
    expect(firmToday(instant)).toBe('2026-09-30')
  })
})

describe('dateOnlyInZone', () => {
  it('reads one instant as the calendar day of whichever zone is asked for', () => {
    const instant = new Date('2026-10-01T01:00:00.000Z')
    expect(dateOnlyInZone(instant, 'UTC')).toBe('2026-10-01')
    expect(dateOnlyInZone(instant, 'America/New_York')).toBe('2026-09-30')
    expect(dateOnlyInZone(instant, 'Asia/Tokyo')).toBe('2026-10-01')
  })

  it('defaults to the firm zone', () => {
    expect(dateOnlyInZone(new Date('2026-10-01T01:00:00.000Z'))).toBe('2026-09-30')
  })

  it('falls back to the UTC day rather than throwing on a runtime with no zone data', async () => {
    // A fresh copy of the module, so its formatter cache is empty, on a runtime
    // whose Intl rejects every named zone.
    vi.resetModules()
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => {
      throw new RangeError('Invalid time zone specified')
    })
    const fresh = await import('./firm-time.js')
    const instant = new Date('2026-10-01T01:00:00.000Z')
    expect(fresh.dateOnlyInZone(instant)).toBe('2026-10-01')
    expect(fresh.firmToday(instant)).toBe('2026-10-01')
  })

  it('says so, once, when it has to fall back to the UTC day', async () => {
    vi.resetModules()
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => {
      throw new RangeError('Invalid time zone specified')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fresh = await import('./firm-time.js')
    fresh.firmToday(new Date('2026-10-01T01:00:00.000Z'))
    fresh.firmToday(new Date('2026-10-02T01:00:00.000Z'))
    fresh.dateOnlyInZone(new Date('2026-10-03T01:00:00.000Z'))
    // (Vitest itself warns about the mocked constructor; only ours counts.)
    const ours = warn.mock.calls.filter(([message]) => String(message).startsWith('[firm-time]'))
    expect(ours).toHaveLength(1)
    expect(String(ours[0][0])).toContain('America/New_York')
  })

  it('answers null for something that is not a real instant', () => {
    expect(dateOnlyInZone(new Date('not a date'))).toBeNull()
    expect(dateOnlyInZone(null)).toBeNull()
    expect(dateOnlyInZone('2026-10-01')).toBeNull()
  })
})
