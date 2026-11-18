import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReportsPage } from '../pages/ReportsPage'
import { DEFAULT_FIRM_SETTINGS, type TimeEntry } from '../lib/types'
import { formatWorkStretches } from '../lib/utils'
import {
  CLOCK_EDITS_READABLE_FROM,
  CLOCK_EDITS_READABLE_FROM_TEXT,
  CLOCK_TIMES_EDITED_CHIP,
  CLOCK_TIMES_EDITED_TITLE,
  HOW_LOGGED_LABEL,
  HOW_LOGGED_NOTE,
  buildSplitBlocks,
  clockMismatchNote,
  clockSpansOf,
  howLogged,
  splitNote,
} from '../lib/payrollClock'
import type { AppContextValue } from '../AppContext'

/**
 * The payroll report says WHEN the time was worked, not just first start and
 * last stop, and says so in sentences that are true of every row
 * (featreq-2da633de).
 *
 * Brittany: "Allison's November 3rd time sheet shows clocking in at 9:08am and
 * clocking out at 5:42PM but only .22 hours 3x. then she has a clock in at 11/3
 * at 8:59AM and out at 12:59 ... so that overlaps the other 3."
 *
 * Every figure was right. The 3 x 0.22h was ONE 39-minute block (2 minutes at
 * 9:08, 37 minutes from 5:05 pm) shared evenly by three clients, and the other
 * entry was worked in four stretches. The report printed only the first start
 * and the last stop of each, which reads like two overlapping shifts with
 * almost no hours on them. The fixture below is that day (times only: the
 * people, clients and tasks are made up).
 */

vi.mock('../lib/api', () => ({
  fetchRateVersions: vi.fn(async () => ({ billRateVersions: [], costRateVersions: [] })),
}))
vi.mock('../lib/csv', () => ({ downloadCsv: vi.fn() }))
vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))

import { fetchRateVersions } from '../lib/api'
import { downloadCsv } from '../lib/csv'

const mockFetchRateVersions = vi.mocked(fetchRateVersions)
const mockDownloadCsv = vi.mocked(downloadCsv)

const DAY = '2026-11-03'
/** A local wall-clock time, as the stored ISO stamp. Local, so the text reads the same in any time zone. */
const at = (hour: number, minute: number, day = 3) => new Date(2026, 10, day, hour, minute).toISOString()
const stretch = (from: [number, number], to: [number, number]) => ({ startAt: at(...from), endAt: at(...to) })

const BLOCK = [stretch([9, 8], [9, 10]), stretch([17, 5], [17, 42])]
const FOUR = [
  stretch([8, 59], [9, 7]),
  stretch([10, 14], [11, 2]),
  stretch([11, 12], [12, 2]),
  stretch([12, 50], [12, 59]),
]
const BLOCK_TEXT = ['9:08 AM – 9:10 AM (2m)', '5:05 PM – 5:42 PM (37m)']
const FOUR_TEXT = [
  '8:59 AM – 9:07 AM (8m)',
  '10:14 AM – 11:02 AM (48m)',
  '11:12 AM – 12:02 PM (50m)',
  '12:50 PM – 12:59 PM (9m)',
]

const employees = [
  { id: 'emp-1', name: 'Avery Stone', billRate: 90 },
  { id: 'emp-2', name: 'Blair Nunez', billRate: 90 },
]
const clients = [
  { id: 'c1', name: 'Acme Dental' },
  { id: 'c2', name: 'Bright Books' },
  { id: 'c3', name: 'Cedar Cafe' },
  { id: 'c4', name: 'Delta Design' },
]

function entry(over: Record<string, unknown>) {
  return {
    date: DAY,
    employeeId: 'emp-1',
    clientId: 'c4',
    isAdministrative: false,
    billable: true,
    taskId: null,
    taskLabel: 'Bookkeeping',
    description: 'Work',
    ...over,
  } as unknown as TimeEntry
}
const share = (
  id: string,
  clientId: string,
  /** null: an older share, saved before the split mode was recorded. */
  allocation: 'even' | 'full' | 'custom' | null = 'even',
  minutes = 13,
  over: Record<string, unknown> = {},
) =>
  entry({
    id,
    clientId,
    minutes,
    groupId: 'grp-1',
    ...(allocation ? { groupAllocation: allocation } : {}),
    startAt: BLOCK[0].startAt,
    endAt: BLOCK[1].endAt,
    sessions: BLOCK,
    ...over,
  })
const fourStretch = entry({ id: 'four', minutes: 115, startAt: FOUR[0].startAt, endAt: FOUR[3].endAt, sessions: FOUR })
const single = entry({
  id: 'single',
  minutes: 13,
  startAt: at(13, 0),
  endAt: at(13, 13),
  sessions: [stretch([13, 0], [13, 13])],
})

const day3 = [
  share('share-a', 'c1'),
  share('share-b', 'c2'),
  share('share-c', 'c3'),
  fourStretch,
  single,
  // Logged as minutes only: no clock times at all.
  entry({ id: 'bare', minutes: 30 }),
  // Another person's ordinary entry.
  entry({ id: 'other', employeeId: 'emp-2', minutes: 20, startAt: at(14, 0), endAt: at(14, 20), sessions: [stretch([14, 0], [14, 20])] }),
]

let contextValue: AppContextValue
let timeEntries: TimeEntry[]

beforeEach(() => {
  mockDownloadCsv.mockReset()
  mockFetchRateVersions.mockReset()
  mockFetchRateVersions.mockResolvedValue({ billRateVersions: [], costRateVersions: [] })
  timeEntries = day3
  // A getter, so a test can swap the entries before it renders.
  contextValue = {
    ownerMode: true,
    billingPeriod: '2026-11',
    firmSettings: DEFAULT_FIRM_SETTINGS,
    get data() {
      return {
        employees,
        inactiveEmployees: [],
        timeEntries,
        clients,
        plans: [],
        checklists: [],
        reimbursements: [],
        recurringReimbursements: [],
      }
    },
  } as unknown as AppContextValue
})

/** Renders the page with the payroll window on the day, and hands back the day-and-job table. */
async function renderDetail() {
  const view = render(<ReportsPage />)
  fireEvent.change(screen.getByLabelText('Period start date'), { target: { value: DAY } })
  await waitFor(() => expect(mockFetchRateVersions).toHaveBeenCalled())
  const heading = await screen.findByRole('heading', { name: 'Time by day and job' })
  const section = heading.closest('section') as HTMLElement
  const tables = section.querySelectorAll('table')
  const detail = tables[tables.length - 1] as HTMLTableElement
  /** The entry rows (not the day sub-headers) whose job cell reads `job`. */
  const rowsOf = (job: string) =>
    [...detail.querySelectorAll<HTMLElement>('tbody tr:not(.payroll-day-row)')].filter(
      (row) => row.querySelector('td')?.textContent === job,
    )
  const stretchesOf = (row: HTMLElement) =>
    [...row.querySelectorAll('.payroll-stretches > div')].map((line) => line.textContent)
  return { view, section, detail, rowsOf, rowOf: (job: string) => rowsOf(job)[0], stretchesOf }
}

describe('formatWorkStretches', () => {
  it('lists each stretch with its own length', () => {
    expect(formatWorkStretches(BLOCK)).toEqual(BLOCK_TEXT)
    expect(formatWorkStretches(FOUR)).toEqual(FOUR_TEXT)
  })

  // Stretches are stored in the order they were typed or added: a forgotten
  // 8:59 stretch added afterwards is stored last.
  it('lists them earliest first, whatever order they are stored in', () => {
    expect(formatWorkStretches([FOUR[2], FOUR[0], FOUR[3], FOUR[1]])).toEqual(FOUR_TEXT)
  })

  it('adds the date only where it is needed', () => {
    // A stretch on a later day than the row's.
    const twoDays = [stretch([9, 0], [9, 30]), { startAt: at(8, 0, 4), endAt: at(8, 15, 4) }]
    expect(formatWorkStretches(twoDays, DAY)).toEqual(['9:00 AM – 9:30 AM (30m)', 'Nov 4, 8:00 AM – 8:15 AM (15m)'])
    // Without the row's day, the first stretch's day is the reference.
    expect(formatWorkStretches(twoDays)).toEqual(['9:00 AM – 9:30 AM (30m)', 'Nov 4, 8:00 AM – 8:15 AM (15m)'])
    // An entry filed under Nov 3 whose work was all on Nov 4: every stretch says so.
    expect(formatWorkStretches([{ startAt: at(8, 0, 4), endAt: at(8, 15, 4) }], DAY)).toEqual([
      'Nov 4, 8:00 AM – 8:15 AM (15m)',
    ])
    // A stretch that runs past midnight.
    expect(formatWorkStretches([{ startAt: at(23, 30), endAt: at(0, 15, 4) }], DAY)).toEqual([
      '11:30 PM – Nov 4, 12:15 AM (45m)',
    ])
  })

  it('gives exact lengths, and leaves out what is not a stretch', () => {
    expect(
      formatWorkStretches([
        { startAt: new Date(2026, 10, 3, 11, 2, 42).toISOString(), endAt: new Date(2026, 10, 3, 11, 5, 11).toISOString() },
      ]),
    ).toEqual(['11:02 AM – 11:05 AM (2m 29s)'])
    expect(
      formatWorkStretches([
        { startAt: 'nope', endAt: at(9, 0) },
        // Stops before it starts.
        { startAt: at(9, 10), endAt: at(9, 8) },
        stretch([9, 8], [9, 10]),
      ]),
    ).toEqual(['9:08 AM – 9:10 AM (2m)'])
    expect(formatWorkStretches([])).toEqual([])
  })
})

describe('the rules (src/lib/payrollClock.ts)', () => {
  it('Clock in is the EARLIEST start and Clock out the LATEST stop, whatever the stored order', () => {
    const clock = clockSpansOf({ sessions: [FOUR[2], FOUR[0], FOUR[3], FOUR[1]] })
    expect(clock.firstStart).toBe(FOUR[0].startAt)
    expect(clock.lastStop).toBe(FOUR[3].endAt)
    expect(clock.spans.map((span) => span.startAt)).toEqual(FOUR.map((span) => span.startAt))
    expect(clock.clockMinutes).toBe(115)
    // A long stretch that outlasts a later, shorter one: the last stop is the latest stop.
    const nested = clockSpansOf({ sessions: [stretch([9, 0], [17, 0]), stretch([10, 0], [10, 30])] })
    expect(nested.lastStop).toBe(at(17, 0))
  })

  it('an older entry with only a start and a stop is one stretch; minutes only is none', () => {
    expect(clockSpansOf({ startAt: at(9, 0), endAt: at(9, 30) })).toMatchObject({ clockMinutes: 30, firstStart: at(9, 0) })
    expect(clockSpansOf({})).toEqual({ spans: [], clockMinutes: 0 })
    expect(clockSpansOf({ sessions: [{ startAt: 'x', endAt: 'y' }] }).spans).toHaveLength(0)
  })

  it('a share says its own time first, then what the shares total', () => {
    const shares = [share('a', 'c1'), share('b', 'c2'), share('c', 'c3')]
    const blocks = buildSplitBlocks(shares)
    expect(blocks.get('grp-1')).toEqual({ mode: 'even', shares: 3, clients: 3, minutes: 39, uniform: true })
    expect(splitNote(shares[0], blocks)).toBe('13m share of a block split across 3 clients (the shares total 39m)')
    expect(clockMismatchNote(shares[0], blocks, clockSpansOf(shares[0]))).toBe('')
    expect(splitNote(fourStretch, blocks)).toBe('')
  })

  // The app lets one share be changed on its own. Whatever was done, the
  // sentence states what the rows hold, and says when that is not the clock time.
  it('stays true after an Adjust split that no longer adds up to the block', () => {
    const shares = [share('a', 'c1', 'custom', 10), share('b', 'c2', 'custom', 10), share('c', 'c3', 'custom', 10)]
    const blocks = buildSplitBlocks(shares)
    expect(splitNote(shares[0], blocks)).toBe('10m share of a block split across 3 clients (the shares total 30m)')
    expect(clockMismatchNote(shares[0], blocks, clockSpansOf(shares[0]))).toBe(
      "The shares do not add up to this row's clock time (39m)",
    )
  })

  it('stays true when time was added to one share only', () => {
    const grown = share('a', 'c1', 'even', 23, { sessions: [...BLOCK, stretch([18, 0], [18, 10])], endAt: at(18, 10) })
    const shares = [grown, share('b', 'c2'), share('c', 'c3')]
    const blocks = buildSplitBlocks(shares)
    // The grown share's own stretches (49m) are what its shares total.
    expect(splitNote(grown, blocks)).toBe('23m share of a block split across 3 clients (the shares total 49m)')
    expect(clockMismatchNote(grown, blocks, clockSpansOf(grown))).toBe('')
    // Its siblings still list 39m of stretches, and say the totals differ.
    expect(clockMismatchNote(shares[1], blocks, clockSpansOf(shares[1]))).toBe(
      "The shares do not add up to this row's clock time (39m)",
    )
  })

  it('counts clients, not rows, and says "shares" when the shares are no longer different clients', () => {
    const twoOnOne = [share('a', 'c1'), share('b', 'c1'), share('c', 'c3')]
    expect(splitNote(twoOnOne[0], buildSplitBlocks(twoOnOne))).toBe(
      '13m share of a block split across 2 clients (the shares total 39m)',
    )
    const allOnOne = [share('a', 'c1'), share('b', 'c1')]
    expect(splitNote(allOnOne[0], buildSplitBlocks(allOnOne))).toBe(
      '13m share of a block split into 2 shares (the shares total 26m)',
    )
  })

  it('a full-mode share repeats the block; an older share with no recorded mode claims nothing it cannot know', () => {
    const full = [share('a', 'c1', 'full', 39), share('b', 'c2', 'full', 39)]
    const blocks = buildSplitBlocks(full)
    expect(splitNote(full[0], blocks)).toBe('full 39m block billed to each of 2 clients')
    expect(splitNote(full[0], blocks, { forExport: true })).toBe(
      'full 39m block billed to each of 2 clients; hours counted once',
    )
    expect(clockMismatchNote(full[0], blocks, clockSpansOf(full[0]))).toBe('')

    const legacy = [share('a', 'c1', null), share('b', 'c2', null)]
    const none = buildSplitBlocks(legacy)
    expect(none.size).toBe(0)
    expect(splitNote(legacy[0], none)).toBe('share of a block split across clients')
    expect(clockMismatchNote(legacy[0], none, clockSpansOf(legacy[0]))).toBe('')
  })

  // A full-mode split repeats the block on every share. Once one share was
  // changed on its own, "full 49m block billed to each" would be false on the
  // row that holds 39m: each row then states only its own time.
  it('a full-mode split whose shares no longer match states each row’s own time', () => {
    const grown = share('a', 'c1', 'full', 49, { sessions: [...BLOCK, stretch([18, 0], [18, 10])], endAt: at(18, 10) })
    const shares = [grown, share('b', 'c2', 'full', 39)]
    const blocks = buildSplitBlocks(shares)
    expect(blocks.get('grp-1')).toMatchObject({ uniform: false })
    expect(splitNote(grown, blocks)).toBe('49m billed in full to this client, one of 2 shares of one block')
    expect(splitNote(shares[1], blocks)).toBe('39m billed in full to this client, one of 2 shares of one block')
    expect(splitNote(shares[1], blocks, { forExport: true })).toBe(
      '39m billed in full to this client, one of 2 shares of one block; hours counted once',
    )
    // A full share retyped to 20m: one line says what it holds, the other that it was typed. They agree.
    const retyped = [share('a', 'c1', 'full', 20), share('b', 'c2', 'full', 39)]
    const after = buildSplitBlocks(retyped)
    expect(splitNote(retyped[0], after)).toBe('20m billed in full to this client, one of 2 shares of one block')
    expect(clockMismatchNote(retyped[0], after, clockSpansOf(retyped[0]))).toBe('Hours typed in (clock time 39m)')
  })

  // An owner can move one share to administrative time: it keeps its group but has no client.
  it('a share moved to administrative time is not counted as a client', () => {
    const admin = share('c', '', 'even', 13, { isAdministrative: true, billable: false })
    const shares = [share('a', 'c1'), share('b', 'c2'), admin]
    const blocks = buildSplitBlocks(shares)
    expect(blocks.get('grp-1')).toMatchObject({ shares: 3, clients: 2 })
    expect(splitNote(shares[0], blocks)).toBe('13m share of a block split across 2 clients (the shares total 39m)')
    expect(splitNote(admin, blocks)).toBe('13m share of a split block, moved to administrative time')
    // Full mode: "billed to each of 2 clients" would name a client that is not billed.
    const full = [share('a', 'c1', 'full', 39), share('b', '', 'full', 39, { isAdministrative: true })]
    expect(splitNote(full[0], buildSplitBlocks(full))).toBe(
      '39m billed in full to this client, one of 2 shares of one block',
    )
  })

  it('the last share standing says so', () => {
    const alone = [share('a', 'c1')]
    expect(splitNote(alone[0], buildSplitBlocks(alone))).toBe('13m, the one remaining share of a split block')
    const fullAlone = [share('a', 'c1', 'full', 39)]
    expect(splitNote(fullAlone[0], buildSplitBlocks(fullAlone))).toBe('39m, the one remaining share of a split block')
  })

  it('a group whose shares disagree about the mode, or where one has none, is not described at all', () => {
    const mixed = [share('a', 'c1', 'even'), share('b', 'c2', 'full', 39)]
    expect(buildSplitBlocks(mixed).size).toBe(0)
    const partly = [share('a', 'c1', 'even'), share('b', 'c2', null), share('c', 'c3', 'even')]
    const blocks = buildSplitBlocks(partly)
    expect(blocks.size).toBe(0)
    // No "the shares total 26m" over three rows, and no false "do not add up".
    expect(splitNote(partly[0], blocks)).toBe('share of a block split across clients')
    expect(clockMismatchNote(partly[0], blocks, clockSpansOf(partly[0]))).toBe('')
  })

  it('says when an ordinary entry’s Hours were typed, and stays quiet inside a minute', () => {
    const none = new Map()
    const typed = entry({ id: 't', minutes: 90, sessions: FOUR })
    expect(clockMismatchNote(typed, none, clockSpansOf(typed))).toBe('Hours typed in (clock time 1h 55m)')
    // One stretch, hours typed down: the two clock times alone would read as an hour.
    const half = entry({ id: 'h', minutes: 30, sessions: [stretch([9, 0], [10, 0])] })
    expect(clockMismatchNote(half, none, clockSpansOf(half))).toBe('Hours typed in (clock time 1h)')
    // Clocks and durations round a little; that is not "typed".
    const close = entry({ id: 'c', minutes: 115.6, sessions: FOUR })
    expect(clockMismatchNote(close, none, clockSpansOf(close))).toBe('')
    // Exactly a minute is still quiet; just past it is said.
    const atEdge = entry({ id: 'e', minutes: 116, sessions: FOUR })
    expect(clockMismatchNote(atEdge, none, clockSpansOf(atEdge))).toBe('')
    const past = entry({ id: 'p', minutes: 116.1, sessions: FOUR })
    expect(clockMismatchNote(past, none, clockSpansOf(past))).toBe('Hours typed in (clock time 1h 55m)')
    expect(clockMismatchNote(fourStretch, none, clockSpansOf(fourStretch))).toBe('')
    // No clock times, nothing to compare.
    const bare = entry({ id: 'b', minutes: 30 })
    expect(clockMismatchNote(bare, none, clockSpansOf(bare))).toBe('')
  })
})

/**
 * Who set the clock times: the timer, or a person. A timer entry whose times
 * were typed or moved afterwards still says "timer", and nothing recorded the
 * edit; it is read off the times themselves. The timer keeps the second it
 * started and stopped; the edit form works in whole minutes.
 */
describe('how an entry was logged (howLogged)', () => {
  /** A stamp with seconds, as the timer stores it. */
  const clocked = (hour: number, minute: number, second: number, ms = 250) =>
    new Date(2026, 10, 3, hour, minute, second, ms).toISOString()
  const timerStretch = { startAt: clocked(9, 12, 43), endAt: clocked(10, 13, 53) }
  const of = (over: Record<string, unknown>) => {
    const e = entry({ id: 'x', minutes: 10, ...over })
    return howLogged(e, clockSpansOf(e))
  }

  it('a clocked entry is a timer entry', () => {
    expect(of({ entryMethod: 'timer', sessions: [timerStretch] })).toBe('timer')
    expect(of({ sessions: [timerStretch, { startAt: clocked(11, 2, 42), endAt: clocked(11, 5, 11) }] })).toBe('timer')
  })

  it('a timer entry whose clock times sit on exact minutes had them edited', () => {
    expect(of({ entryMethod: 'timer', sessions: BLOCK })).toBe('timer_edited')
    expect(of({ entryMethod: 'timer', sessions: FOUR })).toBe('timer_edited')
    // One typed stretch among clocked ones is enough: that stretch was not clocked.
    expect(of({ entryMethod: 'timer', sessions: [timerStretch, stretch([14, 0], [14, 30])] })).toBe('timer_edited')
  })

  // Both ends, on the minute to the millisecond: one end by chance (1 in 60,000) is not an edit.
  it('one end on the minute, or a start with zero seconds but not zero milliseconds, is still clocked', () => {
    expect(of({ sessions: [{ startAt: at(9, 12), endAt: clocked(10, 13, 53) }] })).toBe('timer')
    expect(of({ sessions: [{ startAt: clocked(16, 4, 0, 253), endAt: clocked(17, 15, 0, 1) }] })).toBe('timer')
  })

  it('a manual entry is manual whatever its times; no clock times at all is its own answer', () => {
    expect(of({ entryMethod: 'manual', sessions: BLOCK })).toBe('manual')
    expect(of({ entryMethod: 'manual' })).toBe('manual')
    expect(of({ entryMethod: 'timer' })).toBe('no_clock')
    expect(of({})).toBe('no_clock')
  })

  it('reads the same in any time zone (seconds are seconds everywhere)', () => {
    // 05:30 offsets shift the minute, never the seconds.
    expect(of({ sessions: [{ startAt: '2026-11-03T09:08:00.000+05:30', endAt: '2026-11-03T09:10:00.000+05:30' }] })).toBe(
      'timer_edited',
    )
    expect(of({ sessions: [{ startAt: '2026-11-03T09:08:07.000+05:30', endAt: '2026-11-03T09:10:00.000+05:30' }] })).toBe(
      'timer',
    )
  })

  // Until 2026-08-05 the edit form sent the stretches on every save, so a typo
  // fixed in the note put every clock time on whole minutes. For a stretch
  // older than that the data cannot tell a note edit from a time edit, and
  // saying "edited" about it would be a false statement about a person.
  it('never calls a stretch edited from before the edit form stopped rewriting them', () => {
    const july = (hour: number, minute: number) => new Date(2026, 6, 10, hour, minute).toISOString()
    // Not known either way: neither "edited" nor a plain "Timer".
    expect(of({ entryMethod: 'timer', sessions: [{ startAt: july(9, 0), endAt: july(10, 0) }] })).toBe('timer_unread')
    // The envelope-only shape of an older entry reads the same way.
    expect(of({ entryMethod: 'timer', sessions: [], startAt: july(9, 0), endAt: july(10, 0) })).toBe('timer_unread')
    // An old entry that still has its seconds was never saved through the form: it IS a plain timer entry.
    const julyClocked = (second: number) => new Date(2026, 6, 10, 9, 0, second, 250).toISOString()
    expect(of({ sessions: [{ startAt: julyClocked(7), endAt: julyClocked(41) }] })).toBe('timer')
    // The days just after the fix are not read either: a tab loaded before it kept the old form.
    const aug7 = (hour: number) => new Date(2026, 7, 7, hour, 0).toISOString()
    expect(of({ sessions: [{ startAt: aug7(9), endAt: aug7(10) }] })).toBe('timer_unread')
    // The boundary: the first readable moment is, the millisecond before it is not.
    const from = Date.parse(CLOCK_EDITS_READABLE_FROM)
    const minute = 60_000
    expect(from % minute).toBe(0)
    expect(of({ sessions: [{ startAt: new Date(from).toISOString(), endAt: new Date(from + 5 * minute).toISOString() }] })).toBe(
      'timer_edited',
    )
    expect(
      of({ sessions: [{ startAt: new Date(from - minute).toISOString(), endAt: new Date(from + 5 * minute).toISOString() }] }),
    ).toBe('timer_unread')
    // The day in words is the day in the constant, as the firm's clock reads it.
    expect(
      new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' }).format(
        new Date(from),
      ),
    ).toBe(CLOCK_EDITS_READABLE_FROM_TEXT)
    // An old entry picked up again later and edited then IS readable, by its later stretch.
    expect(of({ sessions: [{ startAt: july(9, 0), endAt: july(10, 0) }, stretch([14, 0], [14, 30])] })).toBe('timer_edited')
  })

  it('an entry with only a start and a stop is read like one stretch', () => {
    expect(of({ sessions: [], startAt: at(9, 0), endAt: at(9, 30) })).toBe('timer_edited')
    expect(of({ sessions: [], startAt: clocked(9, 0, 7), endAt: clocked(9, 30, 41) })).toBe('timer')
  })

  it('has words for each, and none of them accuses', () => {
    expect(HOW_LOGGED_LABEL).toEqual({
      manual: 'Manual entry',
      timer_edited: 'Timer, clock times edited',
      timer: 'Timer',
      timer_unread: 'Timer (before Aug 17, 2026: edits cannot be read)',
      no_clock: 'Hours only (no clock times)',
    })
    expect(HOW_LOGGED_NOTE).toEqual({
      manual: 'Manual entry',
      timer_edited: 'Clock times edited',
      timer: '',
      // Nothing on screen: there is nothing to say about it.
      timer_unread: '',
      no_clock: '',
    })
    expect(CLOCK_TIMES_EDITED_CHIP).toBe('Clock times edited')
    // Who and when are not known, and editing is allowed: the hover text says both.
    expect(CLOCK_TIMES_EDITED_TITLE).toMatch(/by the person or by an owner/)
    expect(CLOCK_TIMES_EDITED_TITLE).toMatch(/Editing is allowed; this does not say who or when\./)
    for (const text of [...Object.values(HOW_LOGGED_LABEL), ...Object.values(HOW_LOGGED_NOTE), CLOCK_TIMES_EDITED_TITLE]) {
      expect(text).not.toMatch(/by hand|typed|changed|manual(?!ly)(?! entry)/i)
    }
  })

  // THE WHOLE READING RESTS ON THIS: the edit form sends the stretches only
  // when the stretch list itself was touched. If it ever sends them on every
  // save again, every timer entry whose note is fixed would read "edited".
  it('the edit form sends the stretches only when they were touched (read from TimePage.tsx)', () => {
    const page = readFileSync(resolve(__dirname, '../pages/TimePage.tsx'), 'utf8').replace(/\r\n/g, '\n')
    expect(page).toContain('...(spansTouched ? { sessions: built } : {}),')
    expect(page.split('sessions: built').length - 1).toBe(1)
    // It starts false, and opening the editor sets it only for "Add time" (which adds a stretch).
    expect(page).toContain('const [spansTouched, setSpansTouched] = useState(false)')
    expect(page).toContain('setSpansTouched(withExtraSession)')
    // Only the three stretch-list actions set it to true, one each.
    expect(page.split('setSpansTouched(true)').length - 1).toBe(3)
    expect(page.split('setSpansTouched(').length - 1).toBe(4)
    const handlers = ['const updateSessionRow = ', 'const addSessionRow = ', 'const removeSessionRow = ']
    for (const handler of handlers) {
      const from = page.indexOf(handler)
      expect(from).toBeGreaterThan(-1)
      // This handler's own body: up to the next `const` at its indentation.
      const body = page.slice(from, page.indexOf('\n  const ', from + handler.length))
      expect(body.split('setSpansTouched(true)').length - 1).toBe(1)
    }
  })
})

describe('Time by day and job: who set the clock times', () => {
  const clocked = (hour: number, minute: number, second: number) =>
    new Date(2026, 10, 3, hour, minute, second, 250).toISOString()

  it('says so under Clock in, only where a person set them', async () => {
    timeEntries = [
      entry({ id: 'clocked', clientId: 'c1', minutes: 61.18, sessions: [{ startAt: clocked(9, 12, 43), endAt: clocked(10, 13, 53) }] }),
      entry({ id: 'edited', clientId: 'c2', minutes: 115, entryMethod: 'timer', sessions: FOUR }),
      entry({ id: 'manual', clientId: 'c3', minutes: 30, entryMethod: 'manual', manualReason: 'forgot', sessions: [stretch([14, 0], [14, 30])] }),
      entry({ id: 'bare', clientId: 'c4', minutes: 30 }),
    ]
    const { rowOf, section } = await renderDetail()
    const lineOf = (job: string) => rowOf(job).querySelector('.payroll-how-logged')?.textContent ?? null
    expect(lineOf('Acme Dental')).toBeNull()
    expect(lineOf('Bright Books')).toBe('Clock times edited')
    expect(lineOf('Cedar Cafe')).toBe('Manual entry')
    expect(lineOf('Delta Design')).toBeNull()
    // What it means, that it is allowed, and what the app does not know.
    const note = within(section).getByText(/"Clock times edited" means the clock times of a timer entry were edited after the timer ran/)
    expect(note).toHaveTextContent('(a stretch added, moved or removed), by the person or by an owner')
    // The LINE changes nothing. Editing itself does change the Hours, so the sentence must not say otherwise.
    expect(note).toHaveTextContent(
      'Editing is allowed. The line is only a note: it changes nothing in the Hours or the pay, and the app does not record who edited, when, or what the times were before.',
    )
    expect(note).not.toHaveTextContent('Editing is allowed and changes nothing')
  })

  it('both exports end with a Logged column', async () => {
    timeEntries = [
      entry({ id: 'clocked', clientId: 'c1', minutes: 61.18, sessions: [{ startAt: clocked(9, 12, 43), endAt: clocked(10, 13, 53) }] }),
      entry({ id: 'edited', clientId: 'c2', minutes: 115, sessions: FOUR }),
      entry({ id: 'manual', clientId: 'c3', minutes: 30, entryMethod: 'manual', sessions: [stretch([14, 0], [14, 30])] }),
      entry({ id: 'bare', clientId: 'c4', minutes: 30 }),
    ]
    await renderDetail()
    const expected = {
      'Acme Dental': 'Timer',
      'Bright Books': 'Timer, clock times edited',
      'Cedar Cafe': 'Manual entry',
      'Delta Design': 'Hours only (no clock times)',
    }
    for (const button of [/Raw hours/i, /Hours by month \(CSV\)/i]) {
      mockDownloadCsv.mockReset()
      fireEvent.click(screen.getByRole('button', { name: button }))
      const [, headers, rows] = mockDownloadCsv.mock.calls[0] as unknown as [string, string[], Array<Array<string | number>>]
      expect(headers[headers.length - 1]).toBe('Logged')
      expect(Object.fromEntries(rows.map((row) => [row[2], row[row.length - 1]]))).toEqual(expected)
      for (const row of rows) expect(row).toHaveLength(headers.length)
    }
  })

  // The approval screens are where time is signed off: the same reading, in
  // the entry's Method line and as a chip beside "Manual".
  it('Time Approvals shows it too (read from TimeApprovalsPage.tsx)', () => {
    const source = readFileSync(resolve(__dirname, '../pages/TimeApprovalsPage.tsx'), 'utf8').replace(/\r\n/g, '\n')
    expect(source).toContain(
      "{entry.entryMethod === 'manual' ? 'Manual' : HOW_LOGGED_LABEL[howLogged(entry, clockSpansOf(entry))]}",
    )
    expect(source).toContain("{howLogged(entry, clockSpansOf(entry)) === 'timer_edited' ? (")
    // Its own quiet chip, never the Manual badge's look: an edit is not an exception.
    expect(source).toContain('<span className="clock-edited-chip" title={CLOCK_TIMES_EDITED_TITLE}>')
    expect(source).toContain('{CLOCK_TIMES_EDITED_CHIP}')
    const css = readFileSync(resolve(__dirname, '../App.css'), 'utf8')
    const chip = css.slice(css.indexOf('.clock-edited-chip {'), css.indexOf('}', css.indexOf('.clock-edited-chip {')))
    expect(chip).toContain('color: var(--muted);')
    expect(chip).not.toMatch(/background|font-weight|berry/)
  })
})

describe('Time by day and job: when the time was worked', () => {
  it('says what the clock times are, on the page and in the column heads', async () => {
    const { section, detail } = await renderDetail()
    const note = within(section).getByText(/Clock in and Clock out are the first start and the last stop of an entry, not a shift\./)
    // True of every row: "normally", since a share and a typed duration differ and say so themselves.
    expect(note).toHaveTextContent('each stretch is listed under Sessions, and Hours is normally the time worked in them')
    // True of an even, a custom and a full split alike: the row says what part it holds.
    expect(note).toHaveTextContent("the line under each share's Hours says what part of the block that row holds")
    // Her second question: the 8:59 entry "overlaps the other 3". One person's
    // rows; two people's time overlaps all day.
    expect(note).toHaveTextContent(
      'Two rows of the same person whose clock times overlap are not counted twice unless their listed stretches overlap; the shares of one block list the same stretches on purpose.',
    )
    const heads = [...detail.querySelectorAll('th')].map((th) => th.textContent)
    expect(heads).toContain('Clock in (first start)')
    expect(heads).toContain('Clock out (last stop)')
  })

  it('a share of a block shows the block’s stretches, its own time, and what the shares total', async () => {
    const { rowOf, stretchesOf } = await renderDetail()
    for (const job of ['Acme Dental', 'Bright Books', 'Cedar Cafe']) {
      const row = rowOf(job)
      // The two clock times alone are what read as "a whole day, 0.22 hours".
      expect(row).toHaveTextContent('9:08 AM')
      expect(row).toHaveTextContent('5:42 PM')
      expect(stretchesOf(row)).toEqual(BLOCK_TEXT)
      // 13m is 0.22h: the bridge from the row's Hours to the block is on the row.
      expect(within(row).getByText('13m share of a block split across 3 clients (the shares total 39m)')).toBeInTheDocument()
      expect(row).toHaveTextContent('0.22h')
      expect(within(row).queryByText(/do not add up|typed in/)).not.toBeInTheDocument()
    }
  })

  it('an entry worked in four stretches lists all four; its hours are their sum', async () => {
    const { rowsOf, stretchesOf } = await renderDetail()
    const four = rowsOf('Delta Design').find((row) => row.querySelector('.payroll-stretches')) as HTMLElement
    expect(stretchesOf(four)).toEqual(FOUR_TEXT)
    // 8 + 48 + 50 + 9 = 115 minutes.
    expect(four).toHaveTextContent('1.92h')
    expect(within(four).queryByText(/share of|typed in/)).not.toBeInTheDocument()
  })

  it('an entry worked in one stretch, or with no clock times, gets nothing extra', async () => {
    const { rowsOf, detail } = await renderDetail()
    const plain = [...rowsOf('Delta Design'), ...rowsOf('(Admin)')].filter((row) => !row.querySelector('.payroll-stretches'))
    // The single-stretch entry, the minutes-only entry and the other person's.
    expect(plain).toHaveLength(3)
    for (const row of plain) expect(within(row).queryByText(/share of|typed in|do not add up/)).not.toBeInTheDocument()
    // Three shares and the four-stretch entry.
    expect(detail.querySelectorAll('.payroll-stretches')).toHaveLength(4)
  })

  it('the clock times and the list are in time order even when the stretches were stored out of order', async () => {
    timeEntries = [entry({ id: 'jumbled', minutes: 115, sessions: [FOUR[2], FOUR[0], FOUR[3], FOUR[1]] })]
    const { rowOf, stretchesOf } = await renderDetail()
    const row = rowOf('Delta Design')
    const cells = [...row.querySelectorAll('td')].map((td) => td.textContent)
    // The Clock in cell also carries the edit line (this fixture's times are on exact minutes).
    expect(cells).toContain('Nov 3, 8:59 AMClock times edited')
    expect(cells).toContain('Nov 3, 12:59 PM')
    expect(stretchesOf(row)).toEqual(FOUR_TEXT)
  })

  it('says when the Hours were typed and are not the clock time', async () => {
    timeEntries = [
      entry({ id: 'typed', minutes: 90, sessions: FOUR }),
      entry({ id: 'half', clientId: 'c1', minutes: 30, sessions: [stretch([14, 0], [15, 0])] }),
    ]
    const { rowOf } = await renderDetail()
    expect(rowOf('Delta Design')).toHaveTextContent('1.50h')
    expect(within(rowOf('Delta Design')).getByText('Hours typed in (clock time 1h 55m)')).toBeInTheDocument()
    expect(rowOf('Acme Dental')).toHaveTextContent('0.50h')
    expect(within(rowOf('Acme Dental')).getByText('Hours typed in (clock time 1h)')).toBeInTheDocument()
  })

  // A share can be moved to another day. The ones left behind are still shares
  // of a three-way split, and so is the one that moved: the note reads the
  // whole block, not the period on screen.
  it('a share whose sibling is dated outside the period still says what it is a share of', async () => {
    timeEntries = [share('share-a', 'c1'), share('share-b', 'c2'), share('share-c', 'c3', 'even', 13, { date: '2026-12-20' })]
    const { rowOf, rowsOf } = await renderDetail()
    expect(rowsOf('Cedar Cafe')).toHaveLength(0)
    expect(within(rowOf('Acme Dental')).getByText('13m share of a block split across 3 clients (the shares total 39m)')).toBeInTheDocument()
  })

  it('reads the same when the detail is filtered to one person', async () => {
    const { rowOf, rowsOf, stretchesOf } = await renderDetail()
    fireEvent.change(screen.getByLabelText('Team member'), { target: { value: 'emp-1' } })
    await waitFor(() => expect(rowsOf('(Admin)').length + rowsOf('Delta Design').length).toBe(3))
    const row = rowOf('Acme Dental')
    expect(within(row).getByText('13m share of a block split across 3 clients (the shares total 39m)')).toBeInTheDocument()
    expect(stretchesOf(row)).toEqual(BLOCK_TEXT)
  })

  it('a custom split says each share’s own time; a full-mode split says the block is billed in full', async () => {
    timeEntries = [share('custom-a', 'c1', 'custom', 30), share('custom-b', 'c2', 'custom', 9)]
    const custom = await renderDetail()
    expect(within(custom.rowOf('Acme Dental')).getByText('30m share of a block split across 2 clients (the shares total 39m)')).toBeInTheDocument()
    expect(within(custom.rowOf('Bright Books')).getByText('9m share of a block split across 2 clients (the shares total 39m)')).toBeInTheDocument()
    expect(custom.rowOf('Acme Dental')).toHaveTextContent('0.50h')
    custom.view.unmount()

    timeEntries = [share('full-a', 'c1', 'full', 39), share('full-b', 'c2', 'full', 39)]
    const full = await renderDetail()
    expect(within(full.detail).getAllByText('full 39m block billed to each of 2 clients')).toHaveLength(2)
    // The repeat still carries the older note: its hours are counted once.
    expect(within(full.detail).getAllByText('full block · counted once')).toHaveLength(1)
    expect(full.detail.querySelectorAll('.payroll-stretches')).toHaveLength(2)
  })
})

describe('the exports carry it too, in columns added at the end', () => {
  const NEW = ['Worked stretches', 'Split across clients', 'Hours note', 'Logged']

  it('Raw hours: every earlier column keeps its place', async () => {
    await renderDetail()
    fireEvent.click(screen.getByRole('button', { name: /Raw hours/i }))
    const [, headers, rows] = mockDownloadCsv.mock.calls[0] as unknown as [string, string[], Array<Array<string | number>>]
    expect(headers).toEqual([
      'Date',
      'Team member',
      'Client',
      'Task',
      'Clock in',
      'Clock out',
      'Sessions',
      'Hours',
      'Billable',
      'Billable hours',
      'Billable $',
      'Cost',
      'Description',
      ...NEW,
    ])
    const col = (name: string) => headers.indexOf(name)
    const byClient = (name: string) => rows.filter((row) => row[col('Client')] === name)

    const acme = byClient('Acme Dental')[0]
    expect(acme[col('Sessions')]).toBe(2)
    expect(acme[col('Hours')]).toBe('0.22')
    expect(acme[col('Worked stretches')]).toBe(BLOCK_TEXT.join('; '))
    expect(acme[col('Split across clients')]).toBe('13m share of a block split across 3 clients (the shares total 39m)')
    expect(acme[col('Hours note')]).toBe('')

    // In a sorted sheet a blank reads as "no time worked": one stretch is listed
    // too, and only an entry logged as minutes is blank.
    const delta = byClient('Delta Design')
    expect(delta.map((row) => row[col('Worked stretches')]).sort()).toEqual(
      ['', '1:00 PM – 1:13 PM (13m)', '2:00 PM – 2:20 PM (20m)', FOUR_TEXT.join('; ')].sort(),
    )
    for (const row of delta) expect(row[col('Split across clients')]).toBe('')
    for (const row of rows) expect(row).toHaveLength(headers.length)
  })

  it('Raw hours says when Hours were typed, and that a full block counts once', async () => {
    timeEntries = [
      entry({ id: 'typed', minutes: 90, sessions: FOUR }),
      share('full-a', 'c1', 'full', 39),
      share('full-b', 'c2', 'full', 39),
    ]
    await renderDetail()
    fireEvent.click(screen.getByRole('button', { name: /Raw hours/i }))
    const [, headers, rows] = mockDownloadCsv.mock.calls[0] as unknown as [string, string[], Array<Array<string | number>>]
    const col = (name: string) => headers.indexOf(name)
    const typed = rows.find((row) => row[col('Client')] === 'Delta Design') as Array<string | number>
    expect(typed[col('Hours')]).toBe('1.50')
    expect(typed[col('Hours note')]).toBe('Hours typed in (clock time 1h 55m)')
    const full = rows.filter((row) => row[col('Client')] !== 'Delta Design')
    expect(full.map((row) => row[col('Split across clients')])).toEqual([
      'full 39m block billed to each of 2 clients; hours counted once',
      'full 39m block billed to each of 2 clients; hours counted once',
    ])
  })

  it('Hours by month reads a block whole even when one share is dated in another month', async () => {
    timeEntries = [share('share-a', 'c1'), share('share-b', 'c2'), share('share-c', 'c3', 'even', 13, { date: '2026-12-20' })]
    await renderDetail()
    fireEvent.click(screen.getByRole('button', { name: /Hours by month \(CSV\)/i }))
    const [, headers, rows] = mockDownloadCsv.mock.calls[0] as unknown as [string, string[], Array<Array<string | number>>]
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row[headers.indexOf('Split across clients')]).toBe(
        '13m share of a block split across 3 clients (the shares total 39m)',
      )
    }
  })

  it('Hours by month: the same three columns at the end, so a share is explained there too', async () => {
    await renderDetail()
    fireEvent.click(screen.getByRole('button', { name: /Hours by month \(CSV\)/i }))
    const [, headers, rows] = mockDownloadCsv.mock.calls[0] as unknown as [string, string[], Array<Array<string | number>>]
    expect(headers.slice(-5)).toEqual(['Description', ...NEW])
    expect(headers.indexOf('Hours')).toBe(7)
    const col = (name: string) => headers.indexOf(name)
    const acme = rows.find((row) => row[2] === 'Acme Dental') as Array<string | number>
    expect(acme[col('Worked stretches')]).toBe(BLOCK_TEXT.join('; '))
    expect(acme[col('Split across clients')]).toBe('13m share of a block split across 3 clients (the shares total 39m)')
    for (const row of rows) expect(row).toHaveLength(headers.length)
  })
})
