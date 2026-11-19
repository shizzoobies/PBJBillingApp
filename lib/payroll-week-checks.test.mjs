import { describe, expect, it } from 'vitest'
import {
  LONG_DAY_HOURS,
  LONG_ENTRY_HOURS,
  PAY_PERIOD_ANCHOR,
  addDaysIso,
  dayFlags,
  entryFlags,
  findLoggedTwice,
  findOverlaps,
  formatMinutes,
  formatOverlap,
  lookFlags,
  lastCompletedWeekStart,
  payPeriodOf,
  stretchesOf,
  sundayOf,
  weekDates,
} from './payroll-week-checks.js'

/**
 * The weekly payroll review's rules (featreq-20b13da0). Clock times are built in
 * LOCAL time, the way payroll-stretches.test.tsx builds them, so nothing here
 * depends on the zone the run is in; dates are calendar dates, never an instant
 * sliced to a UTC day.
 */
const at = (day, hour, minute) => new Date(2026, 10, day, hour, minute).toISOString()
const span = (day, from, to) => ({ startAt: at(day, ...from), endAt: at(day, ...to) })

let nextId = 0
function entry(over = {}) {
  nextId += 1
  return {
    id: `e${nextId}`,
    employeeId: 'emp-1',
    date: '2026-11-10',
    clientId: 'c1',
    minutes: 60,
    billable: true,
    taskLabel: 'Bookkeeping',
    description: 'Work',
    entryMethod: 'timer',
    approvalStatus: 'approved',
    ...over,
  }
}
const timed = (day, from, to, over = {}) => {
  const s = span(day, from, to)
  const minutes = (Date.parse(s.endAt) - Date.parse(s.startAt)) / 60000
  return entry({ date: `2026-11-${String(day).padStart(2, '0')}`, minutes, startAt: s.startAt, endAt: s.endAt, sessions: [s], ...over })
}

describe('weeks: always Sunday to Saturday', () => {
  it('finds the Sunday of any day, including across a month and a year', () => {
    expect(sundayOf('2026-11-08')).toBe('2026-11-08') // a Sunday is its own week
    expect(sundayOf('2026-11-14')).toBe('2026-11-08') // Saturday
    expect(sundayOf('2026-12-03')).toBe('2026-11-29') // the week straddles two months
    expect(sundayOf('2027-01-01')).toBe('2026-12-27') // and two years
    expect(weekDates('2026-11-08')).toEqual([
      '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14',
    ])
    expect(weekDates('2026-12-27').at(-1)).toBe('2027-01-02')
  })

  it('opens on the most recent COMPLETED week', () => {
    expect(lastCompletedWeekStart('2026-11-19')).toBe('2026-11-08') // a Thursday: last week
    expect(lastCompletedWeekStart('2026-11-15')).toBe('2026-11-08') // Sunday: the week that ended yesterday
    expect(lastCompletedWeekStart('2026-11-14')).toBe('2026-11-01') // Saturday: this week has not ended
    expect(lastCompletedWeekStart('2027-01-03')).toBe('2026-12-27')
  })

  it('steps whole days with no time-zone or daylight-saving drift', () => {
    expect(addDaysIso('2026-11-01', 7)).toBe('2026-11-08') // across the November clock change
    expect(addDaysIso('2026-03-08', -7)).toBe('2026-03-01') // and the March one
    expect(addDaysIso('2026-12-27', 7)).toBe('2027-01-03')
  })
})

describe('pay periods: two weeks counted from the anchor', () => {
  it('starts at the anchor and runs 14 days', () => {
    expect(PAY_PERIOD_ANCHOR).toBe('2026-11-01')
    expect(payPeriodOf('2026-11-01')).toEqual({
      start: '2026-11-01', end: '2026-11-14', weekNumber: 1, weekStarts: ['2026-11-01', '2026-11-08'],
    })
    expect(payPeriodOf('2026-11-12')).toMatchObject({ start: '2026-11-01', end: '2026-11-14', weekNumber: 2 })
    expect(payPeriodOf('2026-11-15')).toMatchObject({ start: '2026-11-15', end: '2026-11-28', weekNumber: 1 })
    expect(payPeriodOf('2026-12-05')).toMatchObject({ start: '2026-11-29', end: '2026-12-12', weekNumber: 1 })
  })

  it('gives a week BEFORE the anchor a period by stepping back 14 days at a time', () => {
    expect(payPeriodOf('2026-10-31')).toMatchObject({ start: '2026-10-18', end: '2026-10-31', weekNumber: 2 })
    expect(payPeriodOf('2026-10-18')).toMatchObject({ start: '2026-10-18', weekNumber: 1 })
    expect(payPeriodOf('2026-10-17')).toMatchObject({ start: '2026-10-04', end: '2026-10-17', weekNumber: 2 })
  })

  it('crosses the year boundary', () => {
    expect(payPeriodOf('2026-12-31')).toMatchObject({ start: '2026-12-27', end: '2027-01-09', weekNumber: 1 })
    expect(payPeriodOf('2027-01-05')).toMatchObject({ start: '2026-12-27', weekNumber: 2 })
  })
})

describe('overlaps', () => {
  it('flags two entries of one person sharing more than a minute, both ways, naming the other', () => {
    const a = timed(10, [10, 0], [11, 0], { id: 'a' })
    const b = timed(10, [10, 48], [11, 30], { id: 'b', clientId: 'c2' })
    const found = findOverlaps([a, b])
    expect(found.get('a')).toEqual([{ otherId: 'b', startAt: b.startAt, endAt: b.endAt, minutes: 12 }])
    expect(found.get('b')).toEqual([{ otherId: 'a', startAt: a.startAt, endAt: a.endAt, minutes: 12 }])
  })

  it('does not flag exactly one minute, and does flag just over it', () => {
    const a = timed(10, [10, 0], [11, 0], { id: 'a' })
    const oneMinute = timed(10, [10, 59], [11, 30], { id: 'b' })
    expect(findOverlaps([a, oneMinute]).size).toBe(0)
    const justOver = entry({
      id: 'c',
      sessions: [{ startAt: new Date(Date.parse(at(10, 10, 59)) - 1000).toISOString(), endAt: at(10, 11, 30) }],
    })
    expect(findOverlaps([a, justOver]).get('a')).toHaveLength(1)
  })

  it('never calls the parts of one split block an overlap of each other', () => {
    const block = [span(10, [9, 0], [10, 0])]
    const parts = ['c1', 'c2', 'c3'].map((clientId, index) =>
      entry({ id: `part-${index}`, clientId, minutes: 20, groupId: 'grp-1', groupAllocation: 'even', sessions: block }),
    )
    expect(findOverlaps(parts).size).toBe(0)
    expect(findLoggedTwice(parts).size).toBe(0)
    // ...but another entry over the block overlaps every part.
    const other = timed(10, [9, 30], [10, 30], { id: 'other' })
    const found = findOverlaps([...parts, other])
    expect(found.get('other')).toHaveLength(3)
    expect(found.get('part-0')).toHaveLength(1)
  })

  it('never overlaps two people', () => {
    const a = timed(10, [10, 0], [11, 0], { id: 'a' })
    const b = timed(10, [10, 0], [11, 0], { id: 'b', employeeId: 'emp-2' })
    expect(findOverlaps([a, b]).size).toBe(0)
    expect(findLoggedTwice([a, b]).size).toBe(0)
  })

  it("reports an entry whose own stretches overlap", () => {
    const self = entry({ id: 'self', sessions: [span(10, [9, 0], [10, 0]), span(10, [9, 30], [10, 30])] })
    expect(findOverlaps([self]).get('self')).toMatchObject([{ otherId: 'self', minutes: 30 }])
  })

  it('reads the start/stop pair when an entry has no stretches, and nothing for hours only', () => {
    expect(stretchesOf(entry({ startAt: at(10, 9, 0), endAt: at(10, 9, 30) }))).toHaveLength(1)
    expect(stretchesOf(entry({}))).toEqual([])
  })
})

describe('logged twice', () => {
  it('same start: two entries holding a stretch that starts at the same instant (the findAlreadyLoggedTimer rule)', () => {
    const a = timed(10, [9, 0], [9, 45], { id: 'a' })
    const b = timed(10, [9, 0], [9, 45], { id: 'b' })
    const twice = findLoggedTwice([a, b])
    expect(twice.get('a')).toEqual([{ otherId: 'b', rule: 'same_start', startAt: a.startAt }])
    expect(twice.get('b')).toEqual([{ otherId: 'a', rule: 'same_start', startAt: a.startAt }])
  })

  it('same hours: two hours-only entries on one day with the same client, task, minutes and description', () => {
    const a = entry({ id: 'a', minutes: 90 })
    const b = entry({ id: 'b', minutes: 90, description: ' Work ' })
    expect(findLoggedTwice([a, b]).get('a')).toEqual([{ otherId: 'b', rule: 'same_hours' }])
    // Any one of them different: not twice.
    for (const change of [{ minutes: 60 }, { clientId: 'c2' }, { taskLabel: 'Payroll' }, { description: 'Other' }, { date: '2026-11-11' }]) {
      expect(findLoggedTwice([a, entry({ id: 'x', minutes: 90, ...change })]).size).toBe(0)
    }
    // An hours-only entry is never "twice" a clocked one.
    expect(findLoggedTwice([a, timed(10, [9, 0], [10, 30], { id: 'c' })]).size).toBe(0)
  })
})

describe('the flags', () => {
  const nameOf = (e) => ({ c1: 'Acme Dental', c2: 'Bright Books' })[e.clientId] ?? 'Administrative'
  const formatTime = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

  it('long entry: exactly 3.00h is not flagged, just over is', () => {
    expect(LONG_ENTRY_HOURS).toBe(3)
    const exactly = entry({ id: 'three', minutes: 180 })
    const over = entry({ id: 'over', minutes: 181, description: 'More' })
    const flags = entryFlags([exactly, over])
    expect(flags.has('three')).toBe(false)
    expect(flags.get('over')).toEqual([
      { kind: 'long_entry', tier: 'look', label: 'Long entry', sentence: 'More than 3 hours on one entry (3.02h).' },
    ])
  })

  it('long day: exactly 8.00h is not flagged, just over is', () => {
    expect(LONG_DAY_HOURS).toBe(8)
    expect(dayFlags(8)).toEqual([])
    expect(dayFlags(8.01)).toEqual([
      { kind: 'long_day', tier: 'look', label: 'Long day', sentence: 'More than 8 hours logged on this day (8.01h).' },
    ])
  })

  it('names the other entry in an overlap, and does not ALSO call a possible duplicate an overlap', () => {
    const a = timed(10, [10, 0], [11, 0], { id: 'a' })
    const b = timed(10, [10, 48], [11, 30], { id: 'b', clientId: 'c2' })
    const flags = entryFlags([a, b], { nameOf, formatTime })
    expect(flags.get('a')).toEqual([
      {
        kind: 'overlap',
        tier: 'look',
        label: 'Overlaps another entry',
        sentence: `Overlaps Bright Books, ${formatTime(b.startAt)} - ${formatTime(b.endAt)}, by 12m.`,
      },
    ])
    const c = timed(10, [9, 0], [9, 45], { id: 'c' })
    const d = timed(10, [9, 0], [9, 45], { id: 'd' })
    expect(entryFlags([c, d], { nameOf, formatTime }).get('c')?.map((flag) => flag.kind)).toEqual(['possible_duplicate'])
  })

  it('carries every flag an entry has, in one order, with the facts the page hands in', () => {
    const busy = entry({
      id: 'busy',
      minutes: 200,
      entryMethod: 'manual',
      approvalStatus: 'rejected',
      approvalNote: 'Wrong client',
      startAt: at(10, 9, 0),
      endAt: at(10, 12, 0),
      sessions: [span(10, [9, 0], [12, 0])],
    })
    const other = timed(10, [11, 0], [12, 30], { id: 'other' })
    const flags = entryFlags([busy, other], {
      nameOf,
      formatTime,
      factsOf: (e) =>
        e.id === 'busy'
          ? { logged: 'manual', mismatchNote: "Hours typed in. This entry's stretches add up to 3h on the clock.", typedHours: true }
          : { logged: 'timer' },
    })
    expect(flags.get('busy')?.map((flag) => flag.kind)).toEqual(['manual', 'overlap', 'typed_hours', 'sent_back', 'long_entry'])
    expect(flags.get('busy')?.find((flag) => flag.kind === 'sent_back')?.sentence).toBe(
      'Sent back to the person to fix. The note: "Wrong client"',
    )
    expect(flags.get('busy')?.find((flag) => flag.kind === 'typed_hours')?.sentence).toBe(
      "Hours typed in. This entry's stretches add up to 3h on the clock. The 3.33h shown is what is counted.",
    )
  })

  it('clock times edited and not approved yet are NOTES, not flags that need a look', () => {
    const edited = entry({ id: 'edited', approvalStatus: 'pending' })
    const flags = entryFlags([edited], { factsOf: () => ({ logged: 'timer_edited' }) })
    expect(flags.get('edited')?.map((flag) => [flag.tier, flag.label, flag.sentence])).toEqual([
      [
        'note',
        'Clock times edited',
        'The clock times on this timer entry were edited after the timer ran, by the person or by an owner. Editing is allowed; this does not say who or when.',
      ],
      ['note', 'Not approved yet', "This entry is waiting for approval. An owner approves it in the Approval queue, or by approving the person's submitted week on the Weekly submissions tab."],
    ])
  })

  it('formats minutes in words', () => {
    expect(formatMinutes(12)).toBe('12m')
    expect(formatMinutes(65)).toBe('1h 5m')
    expect(formatMinutes(120)).toBe('2h')
    // Under two minutes an overlap is said to the second, so 61 seconds never reads "1m" beside "more than a minute".
    expect(formatOverlap(61 / 60)).toBe('1m 1s')
    expect(formatOverlap(89 / 60)).toBe('1m 29s')
    expect(formatOverlap(2)).toBe('2m')
    expect(formatOverlap(12.4)).toBe('12m')
  })

  it('says an overlap just over the minute to the second', () => {
    const a = timed(10, [10, 0], [11, 0], { id: 'a' })
    const b = entry({ id: 'b', clientId: 'c2', sessions: [{ startAt: new Date(Date.parse(at(10, 11, 0)) - 61000).toISOString(), endAt: at(10, 11, 30) }] })
    expect(entryFlags([a, b], { nameOf, formatTime }).get('a')?.[0].sentence).toMatch(/, by 1m 1s.$/)
  })

  it("the possible-duplicate sentence is about ANOTHER entry's stretch, never this entry's start", () => {
    const a = entry({ id: 'a', sessions: [span(10, [8, 0], [8, 30]), span(10, [9, 0], [9, 45])] })
    const b = timed(10, [9, 0], [9, 20], { id: 'b', clientId: 'c2' })
    expect(entryFlags([a, b], { nameOf, formatTime }).get('a')).toEqual([
      {
        kind: 'possible_duplicate',
        tier: 'look',
        label: 'Possible duplicate',
        sentence: `Another entry has a stretch that starts at the same moment (${formatTime(b.startAt)}): Bright Books. Check it is not a repeat.`,
      },
    ])
  })

  it("a split block whose parts do not add up keeps payrollClock's own sentence, under its own label", () => {
    const part = entry({ id: 'part', groupId: 'g' })
    const flags = entryFlags([part], { factsOf: () => ({ logged: 'timer', mismatchNote: 'The parts of this block do not add up to the time on the clock (39m).', typedHours: false }) })
    expect(flags.get('part')).toEqual([
      { kind: 'block_parts', tier: 'look', label: 'Block parts differ from clock', sentence: 'The parts of this block do not add up to the time on the clock (39m).' },
    ])
  })

  it('lookFlags keeps only what needs a look', () => {
    const flags = entryFlags([entry({ id: 'x', approvalStatus: 'pending', minutes: 200 })], { factsOf: () => ({ logged: 'timer_edited' }) }).get('x')
    expect(lookFlags(flags).map((flag) => flag.kind)).toEqual(['long_entry'])
  })
})
