import { describe, expect, it } from 'vitest'
import { timesheetDays } from '../lib/timesheetDays'
import type { TimeEntry } from '../lib/types'

/**
 * The timesheet bills `entry.minutes`, never the clock spans.
 *
 * Reported by the firm owner: "the timesheet shows total time for entire split
 * clients and not what the split amount per client is — Lisa is showing 9+ hours
 * today and she did not work that." The page was reading each row's duration off
 * its session span, and a SPLIT SLICE deliberately inherits the whole source
 * block's `sessions` verbatim (that is how clock-in/out survives a split) while
 * billing only its allocated share. Her Aug 14 had one 25-minute block split 20
 * ways: the page drew ~25 minutes against each of the 20 clients — 8.3 invented
 * hours on top of her real day.
 *
 * The rule these tests pin: session spans say WHEN the work happened, never HOW
 * MUCH is billed. Same principle as `minutesAfterEntryEdit` in
 * `lib/group-allocation.js`, so an entry whose duration was hand-corrected has
 * to come out right here too.
 */

const BASE: TimeEntry = {
  id: 'time-1',
  employeeId: 'emp-lisa',
  clientId: 'client-1',
  date: '2026-08-14',
  minutes: 25,
  description: 'Bank reconciliation.',
  billable: true,
  approvalStatus: 'pending',
  entryMethod: 'timer',
}

/** The one 25-minute block, 9:00 → 9:25. */
const BLOCK_SESSIONS = [{ startAt: '2026-08-14T13:00:00.000Z', endAt: '2026-08-14T13:25:00.000Z' }]

/** Whole seconds, so a comparison can't trip over float dust in fractional minutes. */
const seconds = (minutes: number) => Math.round(minutes * 60)

const totalSeconds = (values: number[]) => values.reduce((sum, value) => sum + seconds(value), 0)

describe('timesheet durations come from entry.minutes, not the clock spans', () => {
  it("shows each slice's own share of a 25-minute block split 20 ways, not the whole block", () => {
    // The real shape: 20 slices sharing one groupId, each carrying the FULL
    // block's sessions, each with its own allocated minutes (1500s / 20 = 75s).
    const slices: TimeEntry[] = Array.from({ length: 20 }, (_, index) => ({
      ...BASE,
      id: `slice-${index}`,
      clientId: `client-${index}`,
      minutes: 1.25,
      groupId: 'group-1',
      groupAllocation: 'even',
      sessions: BLOCK_SESSIONS.map((session) => ({ ...session })),
    }))

    const [day] = timesheetDays(slices)

    expect(day.segments).toHaveLength(20)
    for (const segment of day.segments) expect(segment.minutes).toBe(1.25)
    // 25 minutes of work, not 500 (20 × the whole block) — and not 8.3 hours.
    expect(day.total).toBe(25)
  })

  it('still renders the clock-in/out of the block each slice came from', () => {
    const slice: TimeEntry = {
      ...BASE,
      minutes: 1.25,
      groupId: 'group-1',
      sessions: BLOCK_SESSIONS.map((session) => ({ ...session })),
    }

    const [segment] = timesheetDays([slice])[0].segments

    expect(segment.startAt).toBe(BLOCK_SESSIONS[0].startAt)
    expect(segment.endAt).toBe(BLOCK_SESSIONS[0].endAt)
  })

  it("splits a multi-session entry's minutes across its spans, summing to exactly its minutes", () => {
    const entry: TimeEntry = {
      ...BASE,
      minutes: 30,
      sessions: [
        // 10 minutes, then 20 — a third and two thirds of the entry.
        { startAt: '2026-08-14T13:00:00.000Z', endAt: '2026-08-14T13:10:00.000Z' },
        { startAt: '2026-08-14T15:00:00.000Z', endAt: '2026-08-14T15:20:00.000Z' },
      ],
    }

    const [day] = timesheetDays([entry])

    expect(day.segments.map((segment) => segment.minutes)).toEqual([10, 20])
    expect(totalSeconds(day.segments.map((segment) => segment.minutes))).toBe(seconds(30))
    expect(seconds(day.total)).toBe(seconds(30))
  })

  it('hands the leftover second out rather than losing or inventing it', () => {
    // 75 seconds across two equal spans is 37.5s each; the halves can't both
    // stand, so one span gets 38s and the other 37 — 75 in total, never 74 or 76.
    const entry: TimeEntry = {
      ...BASE,
      minutes: 1.25,
      groupId: 'group-1',
      sessions: [
        { startAt: '2026-08-14T13:00:00.000Z', endAt: '2026-08-14T13:10:00.000Z' },
        { startAt: '2026-08-14T15:00:00.000Z', endAt: '2026-08-14T15:10:00.000Z' },
      ],
    }

    const [day] = timesheetDays([entry])

    expect(day.segments.map((segment) => seconds(segment.minutes))).toEqual([38, 37])
    expect(seconds(day.total)).toBe(75)
  })

  it('reports a typed duration that differs from the spans, not the spans', () => {
    // An hour on the clock, 45 minutes billed because someone corrected it.
    // `minutesAfterEntryEdit` keeps the spans verbatim as the audit trail.
    const single: TimeEntry = {
      ...BASE,
      minutes: 45,
      sessions: [{ startAt: '2026-08-14T13:00:00.000Z', endAt: '2026-08-14T14:00:00.000Z' }],
    }
    const multi: TimeEntry = {
      ...BASE,
      id: 'time-2',
      minutes: 45,
      sessions: [
        { startAt: '2026-08-14T13:00:00.000Z', endAt: '2026-08-14T13:30:00.000Z' },
        { startAt: '2026-08-14T15:00:00.000Z', endAt: '2026-08-14T15:30:00.000Z' },
      ],
    }

    expect(timesheetDays([single])[0].segments[0].minutes).toBe(45)

    const multiSegments = timesheetDays([multi])[0].segments.map((segment) => segment.minutes)
    expect(multiSegments).toEqual([22.5, 22.5])
    expect(totalSeconds(multiSegments)).toBe(seconds(45))
  })

  it('leaves a plain single-session entry exactly as it was', () => {
    const entry: TimeEntry = { ...BASE, sessions: BLOCK_SESSIONS.map((session) => ({ ...session })) }

    const [day] = timesheetDays([entry])

    expect(day.segments).toEqual([
      {
        entry,
        startAt: BLOCK_SESSIONS[0].startAt,
        endAt: BLOCK_SESSIONS[0].endAt,
        minutes: 25,
      },
    ])
    expect(day.total).toBe(25)
  })

  it('falls back to the envelope for a minutes-only entry with no sessions', () => {
    const entry: TimeEntry = { ...BASE, minutes: 90 }

    const [day] = timesheetDays([entry])

    expect(day.segments).toHaveLength(1)
    expect(day.segments[0].minutes).toBe(90)
    expect(day.total).toBe(90)
  })

  it("totals a whole day of split slices plus real work at what she actually worked", () => {
    // Lisa's Aug 14: the split block (25 minutes across 20 clients) alongside a
    // real 2.05-hour stretch. The day is 2h 28m, not 10+ hours.
    const slices: TimeEntry[] = Array.from({ length: 20 }, (_, index) => ({
      ...BASE,
      id: `slice-${index}`,
      clientId: `client-${index}`,
      minutes: 1.25,
      groupId: 'group-1',
      groupAllocation: 'even',
      sessions: BLOCK_SESSIONS.map((session) => ({ ...session })),
    }))
    const realWork: TimeEntry = {
      ...BASE,
      id: 'time-real',
      minutes: 123,
      sessions: [{ startAt: '2026-08-14T16:00:00.000Z', endAt: '2026-08-14T18:03:00.000Z' }],
    }

    const [day] = timesheetDays([...slices, realWork])

    expect(seconds(day.total)).toBe(seconds(25 + 123))
  })
})
