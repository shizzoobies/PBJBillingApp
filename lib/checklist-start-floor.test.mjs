import { afterEach, describe, expect, it } from 'vitest'
import { templateStartFloor } from './checklist-start-floor.js'

/**
 * The day a recipe was set up, read in the FIRM's zone.
 *
 * `createdAt` is an instant. Slicing its first ten characters reads it as a UTC
 * day, and from 8 pm Eastern that is tomorrow: a recipe set up on the last
 * evening of September was dated October, so September — the month it was
 * created in — fell below its own floor and never generated.
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
})

describe('templateStartFloor', () => {
  it('floors a recipe created at 8:30 pm Eastern on September 30th at September 30th', () => {
    expect(templateStartFloor({ createdAt: '2026-10-01T00:30:00.000Z' })).toBe('2026-09-30')
  })

  it('floors at the next day once it is past midnight in the east', () => {
    expect(templateStartFloor({ createdAt: '2026-10-01T03:59:59.999Z' })).toBe('2026-09-30')
    expect(templateStartFloor({ createdAt: '2026-10-01T04:00:00.001Z' })).toBe('2026-10-01')
  })

  it('leaves a daytime stamp on the day it reads as', () => {
    expect(templateStartFloor({ createdAt: '2026-09-15T16:00:00.000Z' })).toBe('2026-09-15')
  })

  it.each(['UTC', 'America/New_York', 'Asia/Tokyo'])(
    'answers the same on a host whose own zone is %s',
    (hostZone) => {
      process.env.TZ = hostZone
      expect(templateStartFloor({ createdAt: '2026-10-01T00:30:00.000Z' })).toBe('2026-09-30')
    },
  )

  it('reads a stamp with an offset as the instant it names', () => {
    // 9 pm Eastern written with its own offset is the same instant as 01:00Z.
    expect(templateStartFloor({ createdAt: '2026-09-30T21:00:00-04:00' })).toBe('2026-09-30')
  })

  /**
   * A stamp with no time of day is a calendar date somebody CHOSE, not an
   * instant: `copyTemplateToClient` dates a recipe to an owner's explicit first
   * due date as `<date>T00:00:00.000Z`, and a bare date round-trips through a
   * Postgres timestamptz as exactly that. Reading it as 8 pm Eastern the day
   * before would move a recipe dated July 1st into June, and a specific-months
   * recipe would then generate a June occurrence nobody asked for.
   */
  it('keeps a date-only stamp on the date it names', () => {
    expect(templateStartFloor({ createdAt: '2026-07-01' })).toBe('2026-07-01')
    expect(templateStartFloor({ createdAt: '2026-07-01T00:00:00.000Z' })).toBe('2026-07-01')
    expect(templateStartFloor({ createdAt: '2026-07-01T00:00:00Z' })).toBe('2026-07-01')
  })

  /**
   * A stamp that names no zone is not an instant at all: `new Date()` would
   * read it in the HOST's zone, so the same stored string would floor on
   * different days on the server and in a browser. Nothing writes these today,
   * but an old file-backend row could carry one — it keeps the date it starts
   * with, on every host.
   */
  it.each(['UTC', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo'])(
    'keeps a stamp with no zone on the date it starts with — host zone %s',
    (hostZone) => {
      process.env.TZ = hostZone
      expect(templateStartFloor({ createdAt: '2026-09-30T23:30:00' })).toBe('2026-09-30')
      expect(templateStartFloor({ createdAt: '2026-09-30T23:30:00.000' })).toBe('2026-09-30')
      expect(templateStartFloor({ createdAt: '2026-09-30 23:30:00' })).toBe('2026-09-30')
    },
  )

  it('follows an explicit zone, and FIRM_TIME_ZONE when none is passed', () => {
    const template = { createdAt: '2026-10-01T04:30:00.000Z' }
    expect(templateStartFloor(template)).toBe('2026-10-01')
    expect(templateStartFloor(template, 'America/Chicago')).toBe('2026-09-30')
    expect(templateStartFloor(template, 'UTC')).toBe('2026-10-01')
    process.env.FIRM_TIME_ZONE = 'America/Chicago'
    expect(templateStartFloor(template)).toBe('2026-09-30')
  })

  it('is no floor at all without a usable stamp', () => {
    expect(templateStartFloor({})).toBeNull()
    expect(templateStartFloor({ createdAt: null })).toBeNull()
    expect(templateStartFloor(null)).toBeNull()
    expect(templateStartFloor({ createdAt: 'last Tuesday' })).toBeNull()
    expect(templateStartFloor({ createdAt: 1790000000000 })).toBeNull()
  })
})
