import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReportsPage } from '../pages/ReportsPage'
import { DEFAULT_FIRM_SETTINGS, type TimeEntry } from '../lib/types'
import { formatAuditStamp } from '../lib/utils'
import {
  CLOCK_EDITS_READABLE_FROM,
  CLOCK_EDITS_READABLE_FROM_TEXT,
  CLOCK_TIMES_EDITED_CHIP,
  CLOCK_TIMES_EDITED_TITLE,
  HOW_LOGGED_LABEL,
  HOW_LOGGED_NOTE,
  buildSplitBlocks,
  clockMismatchNote,
  clockMismatchShortNote,
  clockSpansOf,
  entryFigures,
  howLogged,
  howLoggedNote,
  largestRemainder,
  splitNote,
  splitShortNote,
  stretchRows,
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
  // Ship 2's read: null = an older server, so the screen stays read-only (ship 1).
  fetchPayrollWeekRequest: vi.fn(async () => null),
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
  /** The stretch rows (not the day sub-headers) whose job cell reads `job`. */
  const rowsOf = (job: string) =>
    [...detail.querySelectorAll<HTMLElement>('tbody tr:not(.payroll-day-row)')].filter(
      (row) => row.querySelector('td')?.textContent === job,
    )
  /** The rows of one entry, by its id. */
  const entryRows = (id: string) => [...detail.querySelectorAll<HTMLElement>(`tbody tr[data-entry-id="${id}"]`)]
  return { view, section, detail, rowsOf, rowOf: (job: string) => rowsOf(job)[0], entryRows }
}

/**
 * A row's cells as text, without the note lines under a figure. With every
 * member shown: job, member, task, in, out, stretch, hours, billable, $, cost.
 */
const cellsOf = (row: HTMLElement) =>
  [...row.querySelectorAll('td')].map((td) => {
    const copy = td.cloneNode(true) as HTMLElement
    copy.querySelectorAll('div').forEach((line) => line.remove())
    return copy.textContent ?? ''
  })
const IN = 3
const OUT = 4
const STRETCH = 5
const HOURS = 6
const BILLABLE = 7
const AMOUNT = 8
const COST = 9
/** The figure at the start of a cell ("0.22h13m share of ..." -> 0.22, "$19.80" -> 19.8). */
const lead = (text: string) => Number((text.match(/^\$?([\d,]+\.\d{2})/)?.[1] ?? 'NaN').replace(/,/g, ''))
/** Adds two-decimal figures in whole hundredths, as the report does. */
const sum2 = (values: number[]) => (values.reduce((total, value) => total + Math.round(value * 100), 0) / 100).toFixed(2)

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
    expect(splitNote(shares[0], blocks)).toBe('This entry: 13m of a 39m block shared by 3 clients')
    expect(clockMismatchNote(shares[0], blocks, clockSpansOf(shares[0]))).toBe('')
    expect(splitNote(fourStretch, blocks)).toBe('')
  })

  // The app lets one share be changed on its own. Whatever was done, the
  // sentence states what the rows hold, and says when that is not the clock time.
  it('stays true after an Adjust split that no longer adds up to the block', () => {
    const shares = [share('a', 'c1', 'custom', 10), share('b', 'c2', 'custom', 10), share('c', 'c3', 'custom', 10)]
    const blocks = buildSplitBlocks(shares)
    expect(splitNote(shares[0], blocks)).toBe('This entry: 10m part of a block shared by 3 clients (the parts total 30m)')
    expect(clockMismatchNote(shares[0], blocks, clockSpansOf(shares[0]))).toBe(
      "The clients' parts of this block do not add up to the time on the clock (39m).",
    )
  })

  it('stays true when time was added to one share only', () => {
    const grown = share('a', 'c1', 'even', 23, { sessions: [...BLOCK, stretch([18, 0], [18, 10])], endAt: at(18, 10) })
    const shares = [grown, share('b', 'c2'), share('c', 'c3')]
    const blocks = buildSplitBlocks(shares)
    // The grown share's own stretches (49m) are what its shares total.
    expect(splitNote(grown, blocks)).toBe('This entry: 23m of a 49m block shared by 3 clients')
    expect(clockMismatchNote(grown, blocks, clockSpansOf(grown))).toBe('')
    // Its siblings still list 39m of stretches, and say the totals differ.
    expect(clockMismatchNote(shares[1], blocks, clockSpansOf(shares[1]))).toBe(
      "The clients' parts of this block do not add up to the time on the clock (39m).",
    )
  })

  it('counts clients, not rows, and says "shares" when the shares are no longer different clients', () => {
    const twoOnOne = [share('a', 'c1'), share('b', 'c1'), share('c', 'c3')]
    expect(splitNote(twoOnOne[0], buildSplitBlocks(twoOnOne))).toBe(
      'This entry: 13m of a 39m block shared by 2 clients',
    )
    const allOnOne = [share('a', 'c1'), share('b', 'c1')]
    expect(splitNote(allOnOne[0], buildSplitBlocks(allOnOne))).toBe(
      'This entry: 13m part of a block split into 2 parts (the parts total 26m)',
    )
  })

  it('a full-mode share repeats the block; an older share with no recorded mode claims nothing it cannot know', () => {
    const full = [share('a', 'c1', 'full', 39), share('b', 'c2', 'full', 39)]
    const blocks = buildSplitBlocks(full)
    expect(splitNote(full[0], blocks)).toBe('This entry: full 39m block billed to each of 2 clients')
    expect(splitNote(full[0], blocks, { forExport: true })).toBe(
      'This entry: full 39m block billed to each of 2 clients; hours counted once',
    )
    expect(clockMismatchNote(full[0], blocks, clockSpansOf(full[0]))).toBe('')

    const legacy = [share('a', 'c1', null), share('b', 'c2', null)]
    const none = buildSplitBlocks(legacy)
    expect(none.size).toBe(0)
    expect(splitNote(legacy[0], none)).toBe('This entry: part of a block shared by several clients')
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
    expect(splitNote(grown, blocks)).toBe('This entry: 49m billed in full to this client, one of 2 parts of one block')
    expect(splitNote(shares[1], blocks)).toBe('This entry: 39m billed in full to this client, one of 2 parts of one block')
    expect(splitNote(shares[1], blocks, { forExport: true })).toBe(
      'This entry: 39m billed in full to this client, one of 2 parts of one block; hours counted once',
    )
    // A full share retyped to 20m: one line says what it holds, the other that it was typed. They agree.
    const retyped = [share('a', 'c1', 'full', 20), share('b', 'c2', 'full', 39)]
    const after = buildSplitBlocks(retyped)
    expect(splitNote(retyped[0], after)).toBe('This entry: 20m billed in full to this client, one of 2 parts of one block')
    expect(clockMismatchNote(retyped[0], after, clockSpansOf(retyped[0]))).toBe("Hours typed in. This entry's stretches add up to 39m on the clock.")
  })

  // An owner can move one share to administrative time: it keeps its group but has no client.
  it('a share moved to administrative time is not counted as a client', () => {
    const admin = share('c', '', 'even', 13, { isAdministrative: true, billable: false })
    const shares = [share('a', 'c1'), share('b', 'c2'), admin]
    const blocks = buildSplitBlocks(shares)
    expect(blocks.get('grp-1')).toMatchObject({ shares: 3, clients: 2 })
    expect(splitNote(shares[0], blocks)).toBe('This entry: 13m of a 39m block shared by 2 clients')
    expect(splitNote(admin, blocks)).toBe('This entry: 13m part of a shared block, moved to administrative time')
    // Full mode: "billed to each of 2 clients" would name a client that is not billed.
    const full = [share('a', 'c1', 'full', 39), share('b', '', 'full', 39, { isAdministrative: true })]
    expect(splitNote(full[0], buildSplitBlocks(full))).toBe(
      'This entry: 39m billed in full to this client, one of 2 parts of one block',
    )
  })

  it('the last share standing says so', () => {
    const alone = [share('a', 'c1')]
    expect(splitNote(alone[0], buildSplitBlocks(alone))).toBe('This entry: 13m, the one remaining part of a shared block')
    const fullAlone = [share('a', 'c1', 'full', 39)]
    expect(splitNote(fullAlone[0], buildSplitBlocks(fullAlone))).toBe('This entry: 39m, the one remaining part of a shared block')
  })

  it('a group whose shares disagree about the mode, or where one has none, is not described at all', () => {
    const mixed = [share('a', 'c1', 'even'), share('b', 'c2', 'full', 39)]
    expect(buildSplitBlocks(mixed).size).toBe(0)
    const partly = [share('a', 'c1', 'even'), share('b', 'c2', null), share('c', 'c3', 'even')]
    const blocks = buildSplitBlocks(partly)
    expect(blocks.size).toBe(0)
    // No "the shares total 26m" over three rows, and no false "do not add up".
    expect(splitNote(partly[0], blocks)).toBe('This entry: part of a block shared by several clients')
    expect(clockMismatchNote(partly[0], blocks, clockSpansOf(partly[0]))).toBe('')
  })

  it('says when an ordinary entry’s Hours were typed, and stays quiet inside a minute', () => {
    const none = new Map()
    const typed = entry({ id: 't', minutes: 90, sessions: FOUR })
    expect(clockMismatchNote(typed, none, clockSpansOf(typed))).toBe("Hours typed in. This entry's stretches add up to 1h 55m on the clock.")
    // One stretch, hours typed down: the two clock times alone would read as an hour.
    const half = entry({ id: 'h', minutes: 30, sessions: [stretch([9, 0], [10, 0])] })
    expect(clockMismatchNote(half, none, clockSpansOf(half))).toBe("Hours typed in. This entry's stretches add up to 1h on the clock.")
    // Clocks and durations round a little; that is not "typed".
    const close = entry({ id: 'c', minutes: 115.6, sessions: FOUR })
    expect(clockMismatchNote(close, none, clockSpansOf(close))).toBe('')
    // Exactly a minute is still quiet; just past it is said.
    const atEdge = entry({ id: 'e', minutes: 116, sessions: FOUR })
    expect(clockMismatchNote(atEdge, none, clockSpansOf(atEdge))).toBe('')
    const past = entry({ id: 'p', minutes: 116.1, sessions: FOUR })
    expect(clockMismatchNote(past, none, clockSpansOf(past))).toBe("Hours typed in. This entry's stretches add up to 1h 55m on the clock.")
    expect(clockMismatchNote(fourStretch, none, clockSpansOf(fourStretch))).toBe('')
    // No clock times, nothing to compare.
    const bare = entry({ id: 'b', minutes: 30 })
    expect(clockMismatchNote(bare, none, clockSpansOf(bare))).toBe('')
  })
})

/**
 * Sent back 2026-11-18: "the report needs to show each entry too it is still
 * showing as one line - on both the screen and the download report", then
 * "Allison's 9:08-9:10 AM and 5:05-5:42 PM as two rows". One row per stretch,
 * and the pieces add back EXACTLY to the entry's one row.
 */
describe('stretchRows: one row per stretch, adding back exactly', () => {
  const hundredths = (values: number[]) => values.reduce((total, value) => total + Math.round(value * 100), 0)
  const cents = (values: Array<number | null>) =>
    values.reduce<number>((total, value) => total + (value === null ? 0 : Math.round(value * 100)), 0)
  /** Every figure of the pieces adds back to the entry's. */
  const addsBack = (pieces: ReturnType<typeof stretchRows>, figures: ReturnType<typeof entryFigures>) => {
    expect(hundredths(pieces.map((piece) => piece.hours))).toBe(Math.round(figures.hours * 100))
    expect(hundredths(pieces.map((piece) => piece.billableHours))).toBe(Math.round(figures.billableHours * 100))
    if (figures.amount === null) expect(pieces.every((piece) => piece.amount === null)).toBe(true)
    else expect(cents(pieces.map((piece) => piece.amount))).toBe(Math.round(figures.amount * 100))
    if (figures.cost === null) expect(pieces.every((piece) => piece.cost === null)).toBe(true)
    else expect(cents(pieces.map((piece) => piece.cost))).toBe(Math.round(figures.cost * 100))
    for (const piece of pieces) {
      for (const value of [piece.hours, piece.billableHours, piece.amount ?? 0, piece.cost ?? 0]) {
        expect(value).toBeGreaterThanOrEqual(0)
        // Exactly two decimals: no float dust reaches a cell.
        expect(Math.round(value * 100) / 100).toBe(value)
      }
    }
  }

  it("Allison's four-stretch entry is four rows totaling 1.92h", () => {
    const figures = entryFigures(fourStretch, 172.8, 71.04)
    expect(figures).toEqual({ hours: 1.92, billableHours: 1.92, amount: 172.8, cost: 71.04 })
    const pieces = stretchRows(clockSpansOf(fourStretch).spans, figures)
    expect(pieces.map((piece) => [piece.startAt, piece.endAt])).toEqual(FOUR.map((span) => [span.startAt, span.endAt]))
    expect(pieces.map((piece) => piece.label)).toEqual(['1 of 4', '2 of 4', '3 of 4', '4 of 4'])
    // 8, 48, 50 and 9 minutes. Each on its own rounds to 0.13 + 0.80 + 0.83 + 0.15 = 1.91;
    // the hundredth that makes them add to 1.92 goes to the largest remainder.
    expect(pieces.map((piece) => piece.hours)).toEqual([0.13, 0.8, 0.84, 0.15])
    // Money follows each row's hours, so every row multiplies out by hand: 0.84h x $90 = $75.60.
    expect(pieces.map((piece) => piece.amount)).toEqual([11.7, 72, 75.6, 13.5])
    expect(pieces.map((piece) => piece.cost)).toEqual([4.81, 29.6, 31.08, 5.55])
    for (const piece of pieces) {
      expect(piece.amount).toBe(Math.round(piece.hours * 90 * 100) / 100)
      expect(piece.cost).toBe(Math.round(piece.hours * 37 * 100) / 100)
    }
    addsBack(pieces, figures)
  })

  it('the stored order does not matter: rows run earliest first', () => {
    const jumbled = entry({ id: 'j', minutes: 115, sessions: [FOUR[2], FOUR[0], FOUR[3], FOUR[1]] })
    const pieces = stretchRows(clockSpansOf(jumbled).spans, entryFigures(jumbled, null, null))
    expect(pieces.map((piece) => piece.startAt)).toEqual(FOUR.map((span) => span.startAt))
  })

  it("a 13-minute share of Allison's 39-minute block: its 0.22h over the block's two stretches", () => {
    const one = share('a', 'c1')
    const figures = entryFigures(one, 19.8, 8.14)
    const pieces = stretchRows(clockSpansOf(one).spans, figures)
    expect(pieces.map((piece) => piece.label)).toEqual(['1 of 2', '2 of 2'])
    // 2 and 37 minutes of the block's 39: 22 hundredths split 1.13 / 20.87.
    expect(pieces.map((piece) => piece.hours)).toEqual([0.01, 0.21])
    expect(pieces.map((piece) => piece.amount)).toEqual([0.9, 18.9])
    expect(pieces.map((piece) => piece.cost)).toEqual([0.37, 7.77])
    addsBack(pieces, figures)
    // Three shares, six rows, and the three entries still total 0.66h.
    const all = [share('a', 'c1'), share('b', 'c2'), share('c', 'c3')].flatMap((s) =>
      stretchRows(clockSpansOf(s).spans, entryFigures(s, null, null)),
    )
    expect(all).toHaveLength(6)
    expect(hundredths(all.map((piece) => piece.hours))).toBe(66)
  })

  it('typed hours are spread over the stretches by their length', () => {
    const typed = entry({ id: 't', minutes: 90, sessions: FOUR })
    const figures = entryFigures(typed, 135, 55.5)
    const pieces = stretchRows(clockSpansOf(typed).spans, figures)
    expect(pieces).toHaveLength(4)
    addsBack(pieces, figures)
    // The longest stretch holds the most.
    expect(Math.max(...pieces.map((piece) => piece.hours))).toBe(pieces[2].hours)
  })

  it('one stretch, or minutes only, is one row exactly as before, with no Stretch label', () => {
    const figures = entryFigures(single, 19.5, 8.14)
    expect(stretchRows(clockSpansOf(single).spans, figures)).toEqual([
      { ...figures, index: 1, of: 1, label: '', startAt: at(13, 0), endAt: at(13, 13) },
    ])
    const bare = entry({ id: 'bare', minutes: 30, billable: false })
    const bareFigures = entryFigures(bare, null, 18.5)
    expect(bareFigures).toEqual({ hours: 0.5, billableHours: 0, amount: null, cost: 18.5 })
    expect(stretchRows(clockSpansOf(bare).spans, bareFigures)).toEqual([
      { ...bareFigures, index: 1, of: 1, label: '', startAt: undefined, endAt: undefined },
    ])
  })

  it('a full-mode repeat (no cost) keeps no cost on any of its rows; no rate stays no rate', () => {
    const repeat = share('b', 'c2', 'full', 39)
    const figures = entryFigures(repeat, null, null)
    const pieces = stretchRows(clockSpansOf(repeat).spans, figures)
    expect(pieces.map((piece) => piece.cost)).toEqual([null, null])
    expect(pieces.map((piece) => piece.amount)).toEqual([null, null])
    addsBack(pieces, figures)
  })

  it('odd cents and odd hundredths still add back exactly', () => {
    const odd = entry({
      id: 'odd',
      minutes: 61.18,
      sessions: [stretch([9, 0], [9, 7]), stretch([9, 30], [9, 37]), stretch([10, 0], [10, 7])],
    })
    // Three equal stretches: 1.02h, $91.81 and $37.73 do not divide by three.
    const figures = entryFigures(odd, 91.81, 37.73)
    const pieces = stretchRows(clockSpansOf(odd).spans, figures)
    expect(pieces.map((piece) => piece.hours)).toEqual([0.34, 0.34, 0.34])
    expect(pieces.map((piece) => piece.amount)).toEqual([30.61, 30.6, 30.6])
    expect(pieces.map((piece) => piece.cost)).toEqual([12.58, 12.58, 12.57])
    addsBack(pieces, figures)
    // A non-billable entry: no billable hours on any row.
    const internal = entry({ ...odd, id: 'internal', billable: false })
    const internalPieces = stretchRows(clockSpansOf(internal).spans, entryFigures(internal, null, 37.73))
    expect(internalPieces.map((piece) => piece.billableHours)).toEqual([0, 0, 0])
  })
})

describe('largestRemainder: exact, the earlier stretch on every tie', () => {
  it('a three-way tie goes to the earlier stretches, whatever float noise says', () => {
    // 4 x 3/40, 4 x 13/40, 4 x 23/40 all leave 12/40: the earlier two win.
    expect(largestRemainder(4, [3, 13, 23, 1])).toEqual([1, 1, 2, 0])
  })

  it('more stretches than hundredths: five 1-minute stretches of a 0.02h entry', () => {
    expect(largestRemainder(2, [1, 1, 1, 1, 1])).toEqual([1, 1, 0, 0, 0])
    const tiny = entry({
      id: 'tiny',
      minutes: 1.2,
      sessions: [9, 10, 11, 12, 13].map((hour) => stretch([hour, 0], [hour, 1])),
    })
    const pieces = stretchRows(clockSpansOf(tiny).spans, entryFigures(tiny, null, null))
    expect(pieces.map((piece) => piece.hours)).toEqual([0.01, 0.01, 0, 0, 0])
  })

  it('a zero-minute entry with stretches is zero on every row', () => {
    const zero = entry({ id: 'zero', minutes: 0, sessions: BLOCK })
    const pieces = stretchRows(clockSpansOf(zero).spans, entryFigures(zero, 0, 0))
    expect(pieces.map((piece) => [piece.hours, piece.billableHours, piece.amount, piece.cost])).toEqual([
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ])
  })

  it('negative minutes split as their size, handed back negative, adding back exactly', () => {
    expect(largestRemainder(-4, [3, 13, 23, 1])).toEqual([-1, -1, -2, 0])
    const negative = entry({ id: 'neg', minutes: -13, sessions: BLOCK })
    const pieces = stretchRows(clockSpansOf(negative).spans, entryFigures(negative, -19.8, -8.14))
    expect(pieces.map((piece) => piece.hours)).toEqual([-0.01, -0.21])
    expect(pieces.reduce((sum, piece) => sum + Math.round(piece.hours * 100), 0)).toBe(-22)
    expect(pieces.reduce((sum, piece) => sum + Math.round((piece.amount ?? 0) * 100), 0)).toBe(-1980)
    expect(pieces.reduce((sum, piece) => sum + Math.round((piece.cost ?? 0) * 100), 0)).toBe(-814)
  })

  it('no weight at all: everything on the first', () => {
    expect(largestRemainder(5, [0, 0])).toEqual([5, 0])
  })
})

describe('the short lines on an entry’s later rows, and the edit mark', () => {
  it('a share’s later rows say it is this client’s part; full mode and administrative time say what they hold', () => {
    const shares = [share('a', 'c1'), share('b', 'c2'), share('c', '', 'even', 13, { isAdministrative: true })]
    const blocks = buildSplitBlocks(shares)
    expect(splitShortNote(shares[0], blocks)).toBe("This client's part of a shared block")
    expect(splitShortNote(shares[2], blocks)).toBe('Part of a shared block, now administrative time')
    const full = [share('a', 'c1', 'full', 39), share('b', 'c2', 'full', 39)]
    expect(splitShortNote(full[0], buildSplitBlocks(full))).toBe('Billed in full to this client')
    // A group whose mode is not known still says only that it is a part.
    expect(splitShortNote(share('x', 'c1', null), new Map())).toBe("This client's part of a shared block")
    expect(splitShortNote(fourStretch, blocks)).toBe('')
  })

  it('a typed entry’s later rows say so briefly; a share’s parts mismatch has no short form (its split line covers it)', () => {
    const none = new Map()
    const typed = entry({ id: 't', minutes: 90, sessions: FOUR })
    expect(clockMismatchShortNote(typed, none, clockSpansOf(typed))).toBe('Hours typed in for this entry')
    expect(clockMismatchShortNote(fourStretch, none, clockSpansOf(fourStretch))).toBe('')
    const custom = [share('a', 'c1', 'custom', 10), share('b', 'c2', 'custom', 10)]
    expect(clockMismatchShortNote(custom[0], buildSplitBlocks(custom), clockSpansOf(custom[0]))).toBe('')
    // A full-mode part retyped to 20m is typed hours, and says so.
    const retyped = [share('a', 'c1', 'full', 20), share('b', 'c2', 'full', 39)]
    expect(clockMismatchShortNote(retyped[0], buildSplitBlocks(retyped), clockSpansOf(retyped[0]))).toBe(
      'Hours typed in for this entry',
    )
  })

  it('the edit mark says it covers the entry when the entry has more than one stretch', () => {
    expect(howLoggedNote('timer_edited', 4)).toBe('Clock times edited (this entry)')
    expect(howLoggedNote('manual', 2)).toBe('Manual entry (this entry)')
    expect(howLoggedNote('timer_edited', 1)).toBe('Clock times edited')
    expect(howLoggedNote('manual', 0)).toBe('Manual entry')
    expect(howLoggedNote('timer', 4)).toBe('')
    expect(howLoggedNote('timer_unread', 4)).toBe('')
  })

  it('the one remaining part of a block says it in the singular, and claims no reason', () => {
    const alone = [share('a', 'c1')]
    const blocks = buildSplitBlocks(alone)
    expect(splitNote(alone[0], blocks)).toBe('This entry: 13m, the one remaining part of a shared block')
    expect(clockMismatchNote(alone[0], blocks, clockSpansOf(alone[0]))).toBe(
      "This part's 13m is not the whole time on the clock (39m).",
    )
    // Retyped to the whole clock time, it is the whole time again: nothing to say.
    const whole = [share('a', 'c1', 'custom', 39)]
    expect(clockMismatchNote(whole[0], buildSplitBlocks(whole), clockSpansOf(whole[0]))).toBe('')
  })

  it('"This entry: " only on an entry with more than one stretch', () => {
    const oneStretch = [
      share('a', 'c1', 'even', 13, { sessions: [stretch([9, 0], [9, 39])], startAt: at(9, 0), endAt: at(9, 39) }),
      share('b', 'c2', 'even', 13, { sessions: [stretch([9, 0], [9, 39])], startAt: at(9, 0), endAt: at(9, 39) }),
      share('c', 'c3', 'even', 13, { sessions: [stretch([9, 0], [9, 39])], startAt: at(9, 0), endAt: at(9, 39) }),
    ]
    expect(splitNote(oneStretch[0], buildSplitBlocks(oneStretch))).toBe('13m of a 39m block shared by 3 clients')
    // No clock times at all: no stretch rows to tell apart either.
    const bare = [share('a', 'c1', 'even', 13, { sessions: [], startAt: undefined, endAt: undefined })]
    expect(splitNote(bare[0], buildSplitBlocks(bare))).toBe('13m, the one remaining part of a shared block')
  })

  it('the parts mismatch says "The parts" once the parts no longer sit one per client', () => {
    const twoOnOne = [share('a', 'c1', 'custom', 10), share('b', 'c1', 'custom', 10), share('c', 'c3', 'custom', 10)]
    expect(clockMismatchNote(twoOnOne[0], buildSplitBlocks(twoOnOne), clockSpansOf(twoOnOne[0]))).toBe(
      'The parts of this block do not add up to the time on the clock (39m).',
    )
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
    // Four stretches: the mark says it covers the entry. One stretch: it is that stretch's entry anyway.
    expect(lineOf('Bright Books')).toBe('Clock times edited (this entry)')
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

describe('Time by day and job: one row per stretch', () => {
  it('says what the rows are, rounding first, on the page and in the column heads', async () => {
    const { section, detail } = await renderDetail()
    // The rounding leads, in plain words.
    const rounding = within(section).getByText(/^Each row is one stretch of work \(/)
    expect(rounding).toHaveTextContent(
      "Each row is one stretch of work (an entry logged without clock times is a single row). When an entry has several stretches, their hours are rounded so they add up exactly to the entry's total, so a 50-minute stretch can show 0.84h instead of 0.83h and a very short stretch can show 0.00h. Rounding never moves a total. The Stretch column marks the rows of one entry \"1 of 3\", \"2 of 3\" and so on.",
    )
    // Its own paragraph: the two kinds of row whose hours are not their clock times.
    const parts = within(section).getByText(/^Some rows' hours are not the time between their clock in and clock out\./)
    // "only that client's time" is true of an even, a custom and a full split alike; "can" because
    // Resume on one part, or a part moved, leaves the parts on different stretches.
    expect(parts).toHaveTextContent(
      "Some rows' hours are not the time between their clock in and clock out. When a block of time is shared by several clients, each client has its own rows for it, holding only that client's time. When hours were typed in, the typed hours are spread over the entry's stretches by their length. The line under the hours on each of those rows says which, and the rows of one shared block can show the same clock times on purpose.",
    )
    for (const note of [rounding, parts]) {
      expect(note).not.toHaveTextContent(/first start|Sessions|\bshares?\b|remainder|proportion/i)
    }
    // The edit mark covers the entry, not one stretch.
    expect(within(section).getByText(/"Clock times edited" means/)).toHaveTextContent(
      'On an entry worked in several stretches the line is on its first row and says "(this entry)": it covers the whole entry, and the app cannot say which stretch was edited.',
    )
    expect(within(section).getByText(/Each row’s Cost is that person’s pay/)).toHaveTextContent(
      'split across their entries and each entry’s stretches',
    )
    const heads = [...detail.querySelectorAll('th')].map((th) => th.textContent)
    expect(heads).toEqual([
      'Day / job',
      'Team member',
      'Task',
      'Clock in',
      'Clock out',
      'Stretch',
      'Hours',
      'Billable',
      'Billable $',
      'Cost',
    ])
  })

  it("Allison's four-stretch entry is four rows, each with its own clock in, clock out and hours", async () => {
    const { entryRows } = await renderDetail()
    const rows = entryRows('four')
    expect(rows).toHaveLength(4)
    const cells = rows.map(cellsOf)
    expect(cells.map((row) => row[IN])).toEqual(FOUR.map((span) => formatAuditStamp(span.startAt)))
    expect(cells.map((row) => row[OUT])).toEqual(FOUR.map((span) => formatAuditStamp(span.endAt)))
    expect(cells.map((row) => row[STRETCH])).toEqual(['1 of 4', '2 of 4', '3 of 4', '4 of 4'])
    expect(cells.map((row) => row[HOURS])).toEqual(['0.13h', '0.80h', '0.84h', '0.15h'])
    expect(sum2(cells.map((row) => lead(row[HOURS])))).toBe('1.92')
    expect(sum2(cells.map((row) => lead(row[BILLABLE])))).toBe('1.92')
    // The edit mark, once, on its first row, saying it covers the entry.
    expect(rows[0].querySelector('.payroll-how-logged')?.textContent).toBe('Clock times edited (this entry)')
    for (const row of rows.slice(1)) expect(row.querySelector('.payroll-how-logged')).toBeNull()
    // An ordinary entry: each row's hours are its stretch, and nothing needs saying.
    for (const row of rows) expect(row.querySelector('.payroll-hours-note')).toBeNull()
  })

  it("Allison's 39-minute block split three ways is six rows: every client, every stretch", async () => {
    const { entryRows, rowsOf } = await renderDetail()
    for (const [id, job] of [
      ['share-a', 'Acme Dental'],
      ['share-b', 'Bright Books'],
      ['share-c', 'Cedar Cafe'],
    ]) {
      const rows = entryRows(id)
      expect(rowsOf(job)).toEqual(rows)
      const cells = rows.map(cellsOf)
      expect(cells.map((row) => [row[IN], row[OUT]])).toEqual(
        BLOCK.map((span) => [formatAuditStamp(span.startAt), formatAuditStamp(span.endAt)]),
      )
      expect(cells.map((row) => row[STRETCH])).toEqual(['1 of 2', '2 of 2'])
      // 13m is 0.22h, spread over the 2- and 37-minute stretches.
      expect(cells.map((row) => lead(row[HOURS]))).toEqual([0.01, 0.21])
      // Every row explains its own hours: the whole line on the first, a short form after it.
      const notes = rows.map((row) => [...row.querySelectorAll('.payroll-hours-note')].map((line) => line.textContent))
      expect(notes).toEqual([['This entry: 13m of a 39m block shared by 3 clients'], ["This client's part of a shared block"]])
    }
  })

  // Resume on one part only: that part grows a stretch, the others do not. Every
  // line still states only what the rows hold.
  it('stays true after Resume on one part, and for a part moved to administrative time', async () => {
    const grown = share('grown', 'c1', 'even', 23, { sessions: [...BLOCK, stretch([18, 0], [18, 10])], endAt: at(18, 10) })
    const admin = share('admin', '', 'even', 13, { isAdministrative: true, billable: false })
    timeEntries = [grown, share('kept', 'c2'), admin]
    const { entryRows } = await renderDetail()
    const notesOf = (id: string) =>
      entryRows(id).map((row) => [...row.querySelectorAll('.payroll-hours-note')].map((line) => line.textContent))
    expect(notesOf('grown')).toEqual([
      ['This entry: 23m of a 49m block shared by 2 clients'],
      ["This client's part of a shared block"],
      ["This client's part of a shared block"],
    ])
    // Its parts add to 49m, its own clock to 39m: the block's size is no longer one figure.
    expect(notesOf('kept')).toEqual([
      [
        'This entry: 13m part of a block shared by 2 clients (the parts total 49m)',
        'The parts of this block do not add up to the time on the clock (39m).',
      ],
      ["This client's part of a shared block"],
    ])
    expect(notesOf('admin')).toEqual([
      ['This entry: 13m part of a shared block, moved to administrative time', 'The parts of this block do not add up to the time on the clock (39m).'],
      ['Part of a shared block, now administrative time'],
    ])
  })

  it('an entry worked in one stretch, or with no clock times, is one row with a blank Stretch', async () => {
    const { entryRows } = await renderDetail()
    for (const id of ['single', 'bare', 'other']) {
      const rows = entryRows(id)
      expect(rows).toHaveLength(1)
      expect(cellsOf(rows[0])[STRETCH]).toBe('')
    }
    expect(cellsOf(entryRows('single')[0]).slice(IN, OUT + 1)).toEqual([formatAuditStamp(at(13, 0)), formatAuditStamp(at(13, 13))])
    expect(cellsOf(entryRows('single')[0])[HOURS]).toBe('0.22h')
    expect(cellsOf(entryRows('bare')[0]).slice(IN, OUT + 1)).toEqual(['—', '—'])
    expect(cellsOf(entryRows('bare')[0])[HOURS]).toBe('0.50h')
  })

  it('the day subtotal and the totals are what one row per entry gave', async () => {
    const { detail } = await renderDetail()
    // One row per entry: 3 x 0.22 + 1.92 + 0.22 + 0.50 + 0.33 = 3.63h.
    const expected = sum2(
      day3.map((e) => Math.round((e.minutes / 60) * 100) / 100),
    )
    expect(expected).toBe('3.63')
    const day = detail.querySelector('tbody tr.payroll-day-row') as HTMLElement
    expect(cellsOf(day)[1]).toBe(`${expected}h`)
    const rows = [...detail.querySelectorAll<HTMLElement>('tbody tr:not(.payroll-day-row)')]
    expect(rows).toHaveLength(4 + 6 + 3)
    expect(sum2(rows.map((row) => lead(cellsOf(row)[HOURS])))).toBe(expected)
    const footer = [...(detail.querySelector('tfoot tr') as HTMLElement).querySelectorAll('td')].map((td) => td.textContent ?? '')
    expect(footer[1]).toBe(`${expected}h`)
    expect(footer[2]).toBe(`${sum2(rows.map((row) => lead(cellsOf(row)[BILLABLE])))}h`)
  })

  it('Billable $ and Cost rows add to the totals under them, to the cent', async () => {
    mockFetchRateVersions.mockResolvedValue({
      billRateVersions: [
        { userId: 'emp-1', effectivePeriod: '2026-01', rate: 90 },
        { userId: 'emp-2', effectivePeriod: '2026-01', rate: 90 },
      ],
      costRateVersions: [
        { userId: 'emp-1', effectiveDate: '1970-01-01', rate: 37 },
        { userId: 'emp-2', effectiveDate: '1970-01-01', rate: 37 },
      ],
    } as never)
    const { detail, entryRows } = await renderDetail()
    await waitFor(() => expect(cellsOf(entryRows('four')[0])[COST]).toMatch(/^\$/))
    const rows = [...detail.querySelectorAll<HTMLElement>('tbody tr:not(.payroll-day-row)')]
    const footer = [...(detail.querySelector('tfoot tr') as HTMLElement).querySelectorAll('td')].map((td) => td.textContent ?? '')
    const dollars = (column: number) =>
      sum2(rows.map((row) => cellsOf(row)[column]).filter((cell) => cell.startsWith('$')).map(lead))
    expect(`$${dollars(AMOUNT)}`).toBe(footer[footer.length - 2])
    expect(`$${dollars(COST)}`).toBe(footer[footer.length - 1])
    // And entry by entry: the four rows add to what the entry's one row priced (1.92h).
    const four = entryRows('four').map(cellsOf)
    expect(sum2(four.map((row) => lead(row[AMOUNT])))).toBe('172.80')
    expect(sum2(four.map((row) => lead(row[COST])))).toBe((1.92 * 37).toFixed(2))
  })

  it('the clock times are in time order even when the stretches were stored out of order', async () => {
    timeEntries = [entry({ id: 'jumbled', minutes: 115, sessions: [FOUR[2], FOUR[0], FOUR[3], FOUR[1]] })]
    const { entryRows } = await renderDetail()
    const rows = entryRows('jumbled')
    const cells = rows.map(cellsOf)
    expect(cells.map((row) => row[IN])).toEqual(FOUR.map((span) => formatAuditStamp(span.startAt)))
    // The Clock in cell of the first row also carries the edit line (this fixture's times are on exact minutes).
    expect(rows[0].querySelector('td:nth-child(4)')?.textContent).toBe(
      `${formatAuditStamp(FOUR[0].startAt)}Clock times edited (this entry)`,
    )
    expect(cells.map((row) => row[OUT])).toEqual(FOUR.map((span) => formatAuditStamp(span.endAt)))
  })

  it('says on the first row that the Hours were typed, a short form on the others; the rows add to the typed figure', async () => {
    timeEntries = [
      entry({ id: 'typed', minutes: 90, sessions: FOUR }),
      entry({ id: 'half', clientId: 'c1', minutes: 30, sessions: [stretch([14, 0], [15, 0])] }),
    ]
    const { entryRows } = await renderDetail()
    const typed = entryRows('typed')
    expect(typed).toHaveLength(4)
    expect(sum2(typed.map((row) => lead(cellsOf(row)[HOURS])))).toBe('1.50')
    expect(within(typed[0]).getByText("Hours typed in. This entry's stretches add up to 1h 55m on the clock.")).toBeInTheDocument()
    for (const row of typed.slice(1)) {
      expect([...row.querySelectorAll('.payroll-hours-note')].map((line) => line.textContent)).toEqual([
        'Hours typed in for this entry',
      ])
    }
    expect(cellsOf(entryRows('half')[0])[HOURS]).toBe('0.50h')
    expect(within(entryRows('half')[0]).getByText("Hours typed in. This entry's stretches add up to 1h on the clock.")).toBeInTheDocument()
  })

  // A share can be moved to another day. The ones left behind are still shares
  // of a three-way split, and so is the one that moved: the note reads the
  // whole block, not the period on screen.
  it('a share whose sibling is dated outside the period still says what it is a share of', async () => {
    timeEntries = [share('share-a', 'c1'), share('share-b', 'c2'), share('share-c', 'c3', 'even', 13, { date: '2026-12-20' })]
    const { rowOf, rowsOf } = await renderDetail()
    expect(rowsOf('Cedar Cafe')).toHaveLength(0)
    expect(within(rowOf('Acme Dental')).getByText('This entry: 13m of a 39m block shared by 3 clients')).toBeInTheDocument()
  })

  it('reads the same when the detail is filtered to one person', async () => {
    const { rowOf, rowsOf, entryRows } = await renderDetail()
    fireEvent.change(screen.getByLabelText('Team member'), { target: { value: 'emp-1' } })
    // The four-stretch entry, the single one and the minutes-only one; the other person's is gone.
    await waitFor(() => expect(rowsOf('(Admin)').length + rowsOf('Delta Design').length).toBe(6))
    const row = rowOf('Acme Dental')
    expect(within(row).getByText('This entry: 13m of a 39m block shared by 3 clients')).toBeInTheDocument()
    expect(entryRows('share-a')).toHaveLength(2)
  })

  it('a custom split says each share’s own time; a full-mode split keeps the repeat’s cost off every row', async () => {
    timeEntries = [share('custom-a', 'c1', 'custom', 30), share('custom-b', 'c2', 'custom', 9)]
    const custom = await renderDetail()
    expect(within(custom.rowOf('Acme Dental')).getByText('This entry: 30m of a 39m block shared by 2 clients')).toBeInTheDocument()
    expect(within(custom.rowOf('Bright Books')).getByText('This entry: 9m of a 39m block shared by 2 clients')).toBeInTheDocument()
    expect(sum2(custom.entryRows('custom-a').map((row) => lead(cellsOf(row)[HOURS])))).toBe('0.50')
    custom.view.unmount()

    timeEntries = [share('full-a', 'c1', 'full', 39), share('full-b', 'c2', 'full', 39)]
    const full = await renderDetail()
    // Once per share, on its first row.
    expect(within(full.detail).getAllByText('This entry: full 39m block billed to each of 2 clients')).toHaveLength(2)
    expect(within(full.detail).getAllByText('full block · counted once')).toHaveLength(1)
    expect(full.entryRows('full-a')).toHaveLength(2)
    expect(full.entryRows('full-b')).toHaveLength(2)
    // The later row of each says what it holds; the repeat's later row says it counts once.
    const notesOf = (id: string) =>
      full.entryRows(id).map((row) => [...row.querySelectorAll('.payroll-hours-note')].map((line) => line.textContent))
    expect(notesOf('full-a')).toEqual([['This entry: full 39m block billed to each of 2 clients'], ['Billed in full to this client']])
    expect(notesOf('full-b')).toEqual([
      ['This entry: full 39m block billed to each of 2 clients', 'full block · counted once'],
      ['Billed in full to this client', 'counted once'],
    ])
    for (const row of full.entryRows('full-b')) expect(cellsOf(row)[COST]).toBe('—')
    // The block counts once in the day: 0.65h, not 1.30h.
    expect(cellsOf(full.detail.querySelector('tbody tr.payroll-day-row') as HTMLElement)[1]).toBe('0.65h')
  })
})

describe('the downloads: one row per stretch too', () => {
  const TAIL = ['Split across clients', 'Hours note', 'Logged']
  type Sheet = { headers: string[]; rows: Array<Array<string | number>> }
  const sheet = (button: RegExp): Sheet => {
    mockDownloadCsv.mockReset()
    fireEvent.click(screen.getByRole('button', { name: button }))
    const [, headers, rows] = mockDownloadCsv.mock.calls[0] as unknown as [string, string[], Array<Array<string | number>>]
    return { headers, rows }
  }
  const columnSum = ({ headers, rows }: Sheet, name: string, only?: (row: Array<string | number>) => boolean) =>
    sum2(
      rows
        .filter((row) => (only ? only(row) : true))
        .map((row) => row[headers.indexOf(name)])
        .filter((cell) => cell !== '')
        .map(Number),
    )

  it('Raw hours: Stretch, Entry # and Split block # where Sessions was, no Worked stretches column, notes on every row', async () => {
    await renderDetail()
    const raw = sheet(/Raw hours/i)
    expect(raw.headers).toEqual([
      'Date',
      'Team member',
      'Client',
      'Task',
      'Clock in',
      'Clock out',
      'Stretch',
      'Entry #',
      'Split block #',
      'Hours',
      'Billable',
      'Billable hours',
      'Billable $',
      'Cost',
      'Description',
      ...TAIL,
    ])
    const col = (name: string) => raw.headers.indexOf(name)
    for (const row of raw.rows) expect(row).toHaveLength(raw.headers.length)
    expect(raw.rows).toHaveLength(4 + 6 + 3)

    // The four-stretch entry: four self-contained rows.
    const four = raw.rows.filter((row) => String(row[col('Stretch')]).endsWith('of 4'))
    expect(four.map((row) => [row[col('Clock in')], row[col('Clock out')], row[col('Stretch')], row[col('Hours')]])).toEqual(
      FOUR.map((span, i) => [formatAuditStamp(span.startAt), formatAuditStamp(span.endAt), `${i + 1} of 4`, ['0.13', '0.80', '0.84', '0.15'][i]]),
    )
    for (const row of four) {
      expect(row.slice(0, 4)).toEqual([DAY, 'Avery Stone', 'Delta Design', 'Bookkeeping'])
      expect(row[col('Description')]).toBe('Work')
      expect(row[col('Logged')]).toBe('Timer, clock times edited')
    }

    // A share: two rows, the split line on BOTH (a sorted sheet has no first row).
    const acme = raw.rows.filter((row) => row[col('Client')] === 'Acme Dental')
    expect(acme.map((row) => [row[col('Stretch')], row[col('Hours')], row[col('Billable hours')]])).toEqual([
      ['1 of 2', '0.01', '0.01'],
      ['2 of 2', '0.21', '0.21'],
    ])
    for (const row of acme) {
      expect(row[col('Split across clients')]).toBe('This entry: 13m of a 39m block shared by 3 clients')
      expect(row[col('Hours note')]).toBe('')
    }

    // A minutes-only entry: one row, clock times and Stretch blank.
    const bare = raw.rows.filter((row) => row[col('Logged')] === 'Hours only (no clock times)')
    expect(bare).toHaveLength(1)
    expect([bare[0][col('Clock in')], bare[0][col('Clock out')], bare[0][col('Stretch')], bare[0][col('Hours')]]).toEqual(['', '', '', '0.50'])
    // One stretch: "1 of 1" in a sheet, so a sorted sheet has no blank that reads as "no clock times".
    const singleRow = raw.rows.filter((row) => row[col('Clock in')] === formatAuditStamp(at(13, 0)))
    expect(singleRow.map((row) => row[col('Stretch')])).toEqual(['1 of 1'])

    // Entry #: one short number per entry, the same on each of its rows, in the sheet's order.
    const entryNumbers = raw.rows.map((row) => row[col('Entry #')])
    expect(new Set(entryNumbers)).toEqual(new Set([1, 2, 3, 4, 5, 6, 7]))
    expect(new Set(four.map((row) => row[col('Entry #')])).size).toBe(1)
    expect(new Set(acme.map((row) => row[col('Entry #')])).size).toBe(1)
    let previous = 0
    for (const value of entryNumbers) {
      expect(Number(value) === previous || Number(value) === previous + 1).toBe(true)
      previous = Number(value)
    }
    // Split block #: the same on every row of all three clients' parts, blank on every other row.
    const shared = raw.rows.filter((row) => ['Acme Dental', 'Bright Books', 'Cedar Cafe'].includes(String(row[col('Client')])))
    expect(shared).toHaveLength(6)
    expect(new Set(shared.map((row) => row[col('Split block #')]))).toEqual(new Set([1]))
    for (const row of raw.rows.filter((r) => !shared.includes(r))) expect(row[col('Split block #')]).toBe('')

    // The columns sum to exactly what one row per entry gave.
    expect(columnSum(raw, 'Hours')).toBe('3.63')
    expect(columnSum(raw, 'Billable hours')).toBe('3.63')
  })

  it('Raw hours money columns add to the screen’s totals; a full-mode repeat has no Cost on any row', async () => {
    mockFetchRateVersions.mockResolvedValue({
      billRateVersions: [{ userId: 'emp-1', effectivePeriod: '2026-01', rate: 90 }],
      costRateVersions: [{ userId: 'emp-1', effectiveDate: '1970-01-01', rate: 37 }],
    } as never)
    timeEntries = [
      entry({ id: 'typed', minutes: 90, sessions: FOUR }),
      share('full-a', 'c1', 'full', 39),
      share('full-b', 'c2', 'full', 39),
      fourStretch,
    ]
    const { detail, entryRows } = await renderDetail()
    await waitFor(() => expect(cellsOf(entryRows('four')[0])[COST]).toMatch(/^\$/))
    const footer = [...(detail.querySelector('tfoot tr') as HTMLElement).querySelectorAll('td')].map((td) => td.textContent ?? '')
    const raw = sheet(/Raw hours/i)
    const col = (name: string) => raw.headers.indexOf(name)
    expect(`$${columnSum(raw, 'Billable $')}`).toBe(footer[footer.length - 2])
    expect(`$${columnSum(raw, 'Cost')}`).toBe(footer[footer.length - 1])
    // Hours: the repeat's rows carry its hours, as its one row did; without them the column is the screen's total.
    expect(columnSum(raw, 'Hours', (row) => row[col('Client')] !== 'Bright Books')).toBe(footer[1].replace('h', ''))

    // The repeated full-mode share: both rows billed, neither costed.
    const fullRows = raw.rows.filter((row) => row[col('Client')] === 'Bright Books')
    expect(fullRows).toHaveLength(2)
    for (const row of fullRows) {
      expect(row[col('Cost')]).toBe('')
      expect(row[col('Split across clients')]).toBe('This entry: full 39m block billed to each of 2 clients; hours counted once')
    }
    // Each entry's rows add to that entry's cells on screen, column by column.
    const sheetRowsOf: Record<string, (row: Array<string | number>) => boolean> = {
      typed: (row) => row[col('Hours note')] !== '' && row[col('Client')] === 'Delta Design',
      four: (row) => row[col('Hours note')] === '' && row[col('Client')] === 'Delta Design',
      'full-a': (row) => row[col('Client')] === 'Acme Dental',
      'full-b': (row) => row[col('Client')] === 'Bright Books',
    }
    for (const [id, belongs] of Object.entries(sheetRowsOf)) {
      const screenRows = entryRows(id).map(cellsOf)
      const onScreen = (column: number) =>
        sum2(screenRows.map((row) => row[column]).filter((cell) => cell.startsWith('$')).map(lead))
      const sheetRows = raw.rows.filter(belongs)
      expect(sheetRows).toHaveLength(screenRows.length)
      expect(sheetRows.map((row) => row[col('Hours')])).toEqual(screenRows.map((row) => row[HOURS].slice(0, -1)))
      expect(columnSum(raw, 'Billable $', belongs)).toBe(onScreen(AMOUNT))
      expect(columnSum(raw, 'Cost', belongs)).toBe(onScreen(COST))
    }
    // The typed entry's note is on each of its four rows.
    const typedRows = raw.rows.filter((row) => row[col('Hours note')] === "Hours typed in. This entry's stretches add up to 1h 55m on the clock.")
    expect(typedRows).toHaveLength(4)
    expect(sum2(typedRows.map((row) => Number(row[col('Hours')])))).toBe('1.50')
  })

  it('Hours by month: the same rows and columns, with no Cost', async () => {
    mockFetchRateVersions.mockResolvedValue({
      billRateVersions: [{ userId: 'emp-1', effectivePeriod: '2026-01', rate: 90 }],
      costRateVersions: [],
    } as never)
    await renderDetail()
    const month = sheet(/Hours by month \(CSV\)/i)
    expect(month.headers.slice(0, 10)).toEqual([
      'Date',
      'Employee',
      'Client',
      'Task',
      'Clock in',
      'Clock out',
      'Stretch',
      'Entry #',
      'Split block #',
      'Hours',
    ])
    expect(month.headers.slice(-4)).toEqual(['Description', ...TAIL])
    expect(month.headers).not.toContain('Worked stretches')
    expect(month.headers).not.toContain('Sessions')
    expect(month.headers).not.toContain('Cost')
    for (const row of month.rows) expect(row).toHaveLength(month.headers.length)
    const col = (name: string) => month.headers.indexOf(name)
    expect(month.rows).toHaveLength(4 + 6 + 3)
    const four = month.rows.filter((row) => String(row[col('Stretch')]).endsWith('of 4'))
    expect(four.map((row) => row[col('Hours')])).toEqual(['0.13', '0.80', '0.84', '0.15'])
    // 115 minutes at $90 is $172.50, as the one row printed it; its rows add to that.
    expect(sum2(four.map((row) => Number(row[col('Billable $')])))).toBe('172.50')
    const acme = month.rows.filter((row) => row[2] === 'Acme Dental')
    expect(acme).toHaveLength(2)
    // 13 minutes at $90 is $19.50.
    expect(sum2(acme.map((row) => Number(row[col('Billable $')])))).toBe('19.50')
    for (const row of acme) {
      expect(row[col('Split across clients')]).toBe('This entry: 13m of a 39m block shared by 3 clients')
    }
    expect(columnSum(month, 'Hours')).toBe('3.63')
    // The same regrouping columns as Raw hours.
    expect(new Set(month.rows.map((row) => row[col('Entry #')]))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7]))
    expect(new Set(four.map((row) => row[col('Entry #')])).size).toBe(1)
    const shared = month.rows.filter((row) => row[col('Split block #')] !== '')
    expect(shared.map((row) => row[2]).sort()).toEqual(
      ['Acme Dental', 'Acme Dental', 'Bright Books', 'Bright Books', 'Cedar Cafe', 'Cedar Cafe'],
    )
    expect(new Set(shared.map((row) => row[col('Split block #')]))).toEqual(new Set([1]))
    expect(month.rows.filter((row) => row[col('Stretch')] === '1 of 1')).toHaveLength(2)
    expect(month.rows.filter((row) => row[col('Stretch')] === '')).toHaveLength(1)
  })

  it('the one remaining part of a block: the singular line on screen and on every row of both sheets', async () => {
    timeEntries = [share('alone', 'c1')]
    const { entryRows } = await renderDetail()
    const notes = entryRows('alone').map((row) =>
      [...row.querySelectorAll('.payroll-hours-note')].map((line) => line.textContent),
    )
    expect(notes).toEqual([
      ['This entry: 13m, the one remaining part of a shared block', "This part's 13m is not the whole time on the clock (39m)."],
      ["This client's part of a shared block"],
    ])
    for (const button of [/Raw hours/i, /Hours by month \(CSV\)/i]) {
      const { headers, rows } = sheet(button)
      expect(rows).toHaveLength(2)
      for (const row of rows) {
        expect(row[headers.indexOf('Hours note')]).toBe("This part's 13m is not the whole time on the clock (39m).")
        expect(row[headers.indexOf('Split across clients')]).toBe('This entry: 13m, the one remaining part of a shared block')
      }
    }
  })

  it('Hours by month reads a block whole even when one share is dated in another month', async () => {
    timeEntries = [share('share-a', 'c1'), share('share-b', 'c2'), share('share-c', 'c3', 'even', 13, { date: '2026-12-20' })]
    await renderDetail()
    const month = sheet(/Hours by month \(CSV\)/i)
    // Two shares in November, two stretches each.
    expect(month.rows).toHaveLength(4)
    for (const row of month.rows) {
      expect(row[month.headers.indexOf('Split across clients')]).toBe(
        'This entry: 13m of a 39m block shared by 3 clients',
      )
    }
  })
})
