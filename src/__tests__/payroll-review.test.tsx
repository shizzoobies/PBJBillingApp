import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLOCK_EDITED_SENTENCE, weekDates } from '../../lib/payroll-week-checks.js'
import { CLOCK_TIMES_EDITED_TITLE } from '../lib/payrollClock'
import {
  DASH_MEANS_TEXT,
  OWNERS_LEFT_OUT_TEXT,
  PAYCHECK_COUNTS_TEXT,
  PAYCHECK_FOOT_TEXT,
  RATES_FAILED_TEXT,
  RATES_LOADING_TEXT,
  REVIEW_ONLY_TEXT,
  TOTALS_COUNT_TEXT,
} from '../lib/payrollReviewText'
import { TimeApprovalsPage } from '../pages/TimeApprovalsPage'
import { ReportsPage } from '../pages/ReportsPage'
import { DEFAULT_FIRM_SETTINGS, type TimeEntry, type WeeklySubmission } from '../lib/types'
import type { AppContextValue } from '../AppContext'

/**
 * The weekly Payroll review (featreq-20b13da0, ship 1): read-only, owner only,
 * the first tab of Time Approvals. Its figures must be the payroll Hours
 * report's own, so the fixture below is read through BOTH screens and compared,
 * down to a day line and single rows, where a divergence is most likely: a
 * full-mode pair, a raise dated mid-week and a client pinned to older rates.
 *
 * "Today" is pinned to Thursday 2026-11-19, so the page opens on Nov 8 - Nov 14,
 * week 2 of the pay period Nov 1 - Nov 14. Clock times are LOCAL wall-clock
 * times (as payroll-stretches.test.tsx builds them), so the text reads the same
 * in any zone. Timer stretches carry seconds: a stretch on exact minutes is how
 * the app recognizes edited clock times.
 */

vi.mock('../lib/api', () => ({
  fetchRateVersions: vi.fn(async () => ({ billRateVersions: [], costRateVersions: [] })),
  // Ship 2's read: null = an older server, so the screen stays read-only (ship 1).
  fetchPayrollWeekRequest: vi.fn(async () => null),
}))
vi.mock('../lib/csv', () => ({ downloadCsv: vi.fn() }))
vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))

import { fetchRateVersions } from '../lib/api'

const mockFetchRateVersions = vi.mocked(fetchRateVersions)

const at = (day: number, hour: number, minute: number, second = 0) =>
  new Date(2026, 10, day, hour, minute, second).toISOString()
const iso = (day: number) => `2026-11-${String(day).padStart(2, '0')}`

const employees = [
  { id: 'emp-1', name: 'Avery Stone', role: 'Bookkeeper', billRate: 90 },
  { id: 'emp-2', name: 'Blair Nunez', role: 'Bookkeeper', billRate: 90 },
  // First cost rate starts Thursday, mid-week.
  { id: 'emp-3', name: 'Casey Ruiz', role: 'Bookkeeper', billRate: 90 },
  // No cost rate on file at all.
  { id: 'emp-4', name: 'Dana Price', role: 'Bookkeeper', billRate: 90 },
  { id: 'emp-owner', name: 'Pat Owner', role: 'Owner', billRate: 150 },
]
const inactiveEmployees = [{ id: 'emp-5', name: 'Fay Former', role: 'Bookkeeper', billRate: 90, inactiveAt: '2026-11-13T12:00:00.000Z' }]
const clients = [
  { id: 'c1', name: 'Acme Dental' },
  { id: 'c2', name: 'Bright Books' },
  // Pinned to October's bill rates.
  { id: 'c3', name: 'Cedar Cafe', billingMode: 'hourly', hourlyRatePeriod: '2026-10' },
]
const costRates = [
  { userId: 'emp-1', effectiveDate: '1970-01-01', rate: 20 },
  // Avery's raise, dated Wednesday of the reviewed week.
  { userId: 'emp-1', effectiveDate: '2026-11-11', rate: 25 },
  { userId: 'emp-2', effectiveDate: '1970-01-01', rate: 20 },
  { userId: 'emp-3', effectiveDate: '2026-11-12', rate: 30 },
  { userId: 'emp-5', effectiveDate: '1970-01-01', rate: 18 },
]
const billRates = [
  { userId: 'emp-1', effectivePeriod: '2026-10', rate: 80 },
  { userId: 'emp-1', effectivePeriod: '2026-11', rate: 90 },
]

function entry(over: Record<string, unknown>) {
  return {
    employeeId: 'emp-1',
    clientId: 'c1',
    isAdministrative: false,
    billable: true,
    taskId: null,
    taskLabel: 'Bookkeeping',
    description: 'Work',
    entryMethod: 'timer',
    approvalStatus: 'approved',
    ...over,
  } as unknown as TimeEntry
}
/** A timer entry of one stretch, its minutes the stretch's length. */
function timer(id: string, day: number, from: [number, number, number?], to: [number, number, number?], over: Record<string, unknown> = {}) {
  const startAt = at(day, from[0], from[1], from[2] ?? 13)
  const endAt = at(over.endDay ? Number(over.endDay) : day, to[0], to[1], to[2] ?? 13)
  const { endDay: _endDay, ...rest } = over
  void _endDay
  return entry({
    id,
    date: iso(day),
    minutes: (Date.parse(endAt) - Date.parse(startAt)) / 60000,
    startAt,
    endAt,
    sessions: [{ startAt, endAt }],
    ...rest,
  })
}

const EVEN_BLOCK = [{ startAt: at(12, 9, 0, 7), endAt: at(12, 9, 39, 7) }]
const FULL_BLOCK = [{ startAt: at(13, 14, 0, 9), endAt: at(13, 15, 0, 9) }]
const evenPart = (id: string, clientId: string) =>
  entry({ id, date: iso(12), clientId, minutes: 13, groupId: 'g-even', groupAllocation: 'even', startAt: EVEN_BLOCK[0].startAt, endAt: EVEN_BLOCK[0].endAt, sessions: EVEN_BLOCK })
const fullPart = (id: string, clientId: string) =>
  entry({ id, date: iso(13), clientId, minutes: 60, groupId: 'g-full', groupAllocation: 'full', startAt: FULL_BLOCK[0].startAt, endAt: FULL_BLOCK[0].endAt, sessions: FULL_BLOCK })

const avery = [
  timer('a1', 10, [8, 0], [11, 30], { description: 'Reconciled the October bank and card statements for both accounts' }),
  entry({
    id: 'a2',
    date: iso(10),
    clientId: 'c2',
    minutes: 40,
    entryMethod: 'manual',
    approvalStatus: 'pending',
    startAt: at(10, 11, 20),
    endAt: at(10, 12, 0),
    sessions: [{ startAt: at(10, 11, 20), endAt: at(10, 12, 0) }],
    description: 'Call with the client',
  }),
  entry({
    id: 'a3',
    date: iso(10),
    clientId: 'c3',
    minutes: 180,
    startAt: at(10, 13, 0, 5),
    endAt: at(10, 16, 30, 7),
    sessions: [
      { startAt: at(10, 13, 0, 5), endAt: at(10, 14, 0, 5) },
      { startAt: at(10, 14, 30, 7), endAt: at(10, 16, 30, 7) },
    ],
  }),
  entry({ id: 'a4', date: iso(10), clientId: '', isAdministrative: true, billable: false, minutes: 60, taskLabel: 'Training', description: 'Team training' }),
  entry({ id: 'a5', date: iso(12), minutes: 30, approvalStatus: 'rejected', approvalNote: 'Which client was this?' }),
  evenPart('a6a', 'c1'),
  evenPart('a6b', 'c2'),
  evenPart('a6c', 'c3'),
  fullPart('a7a', 'c1'),
  fullPart('a7b', 'c2'),
  // Saturday night, past midnight, against Sunday's entry in the NEXT week.
  timer('a8', 14, [23, 0, 11], [0, 30, 11], { endDay: 15 }),
]
const blair = [
  timer('b1', 11, [9, 0, 10], [10, 0, 10]),
  timer('b2', 11, [14, 0, 0], [14, 30, 0], { clientId: 'c2' }),
  timer('b3', 11, [15, 0, 10], [15, 30, 10], { minutes: 45, clientId: 'c3' }),
  entry({ id: 'b4', date: iso(12), minutes: 30, description: 'Payroll run' }),
  entry({ id: 'b5', date: iso(12), minutes: 30, description: 'Payroll run' }),
].map((item) => ({ ...item, employeeId: 'emp-2' }))
const casey = [
  entry({ id: 'c-tue', employeeId: 'emp-3', date: iso(10), minutes: 60 }),
  entry({ id: 'c-thu', employeeId: 'emp-3', date: iso(12), minutes: 60 }),
]
const dana = [entry({ id: 'd1', employeeId: 'emp-4', date: iso(11), minutes: 120 })]
const fay = [entry({ id: 'f1', employeeId: 'emp-5', date: iso(9), minutes: 30 })]

const OWNER_OWN = entry({ id: 'o1', employeeId: 'emp-owner', date: iso(10), minutes: 60, description: 'Owner review' })
/** Week 1 of the pay period, and the week after it. */
const AVERY_WEEK_ONE = entry({ id: 'p1', date: iso(3), minutes: 60 })
const AVERY_SUNDAY_AFTER = timer('n0', 15, [0, 10, 11], [0, 40, 11])
const AVERY_NEXT_WEEK = entry({ id: 'n1', date: iso(16), minutes: 120 })

const timeEntries = [
  ...avery,
  ...blair,
  ...casey,
  ...dana,
  ...fay,
  OWNER_OWN,
  AVERY_WEEK_ONE,
  AVERY_SUNDAY_AFTER,
  AVERY_NEXT_WEEK,
] as TimeEntry[]

const submissions: WeeklySubmission[] = [
  { id: 'ws-1', userId: 'emp-1', weekStart: '2026-11-08', submittedAt: '2026-11-15T15:00:00.000Z', status: 'pending' },
  { id: 'ws-2', userId: 'emp-3', weekStart: '2026-11-08', submittedAt: '2026-11-15T15:00:00.000Z', status: 'approved', reviewedAt: '2026-11-16T17:00:00.000Z' },
  { id: 'ws-3', userId: 'emp-4', weekStart: '2026-11-08', submittedAt: '2026-11-15T15:00:00.000Z', status: 'rejected', reviewedAt: '2026-11-16T17:00:00.000Z' },
]

let contextValue: AppContextValue

function makeContext(over: Record<string, unknown> = {}) {
  return {
    ownerMode: true,
    previewMode: false,
    billingPeriod: '2026-11',
    firmSettings: DEFAULT_FIRM_SETTINGS,
    sessionUser: { id: 'emp-owner', role: 'owner' },
    data: {
      employees,
      inactiveEmployees,
      timeEntries,
      clients,
      plans: [],
      checklists: [],
      reimbursements: [],
      recurringReimbursements: [],
      weeklySubmissions: submissions,
      timesheetLocks: [],
    },
    ...over,
  } as unknown as AppContextValue
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 19, 12, 0, 0))
  mockFetchRateVersions.mockReset()
  mockFetchRateVersions.mockResolvedValue({ billRateVersions: billRates, costRateVersions: costRates } as never)
  contextValue = makeContext()
})
afterEach(() => {
  vi.useRealTimers()
})

function renderApprovals(path = '/time-approvals') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TimeApprovalsPage />
    </MemoryRouter>,
  )
}

const text = (element: Element | null) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim()
/** A row's cells as text, joined with a space. */
const cellsText = (row: Element) => [...row.querySelectorAll('td')].map(text).filter(Boolean).join(' ')
const personBlock = (section: HTMLElement, id: string) =>
  section.querySelector(`[data-person-id="${id}"]`) as HTMLElement
const heading = (section: HTMLElement, id: string) => text(personBlock(section, id).querySelector('h3'))
const pick = (id: string) => fireEvent.change(screen.getByLabelText('Person'), { target: { value: id } })
const mainRow = (section: HTMLElement, id: string) =>
  section.querySelector(`tr.payroll-review-entry[data-entry-id="${id}"]`) as HTMLElement
const cellsOf = (row: HTMLElement) => [...row.querySelectorAll('td')].map((td) => text(td))
const lead = (value: string) => Number((value.match(/\$([\d,]+\.\d{2})/)?.[1] ?? 'NaN').replace(/,/g, ''))

/** Opens the Payroll review tab and waits for the cost rates to land. */
async function openReview() {
  const view = renderApprovals()
  fireEvent.click(screen.getByRole('tab', { name: 'Payroll review' }))
  await waitFor(() => expect(mockFetchRateVersions).toHaveBeenCalled())
  const section = await screen.findByRole('region', { name: 'Payroll review' })
  await waitFor(() => expect(screen.queryByText(RATES_LOADING_TEXT)).toBeNull())
  return { view, section }
}

/** The Hours report in its Weekly view on the same week. */
async function renderReport(member?: string) {
  const view = render(<ReportsPage />)
  fireEvent.click(screen.getByRole('button', { name: 'Weekly' }))
  fireEvent.change(screen.getByLabelText('Period start date'), { target: { value: '2026-11-08' } })
  await waitFor(() => expect(mockFetchRateVersions).toHaveBeenCalled())
  const section = view.container.querySelector('#payroll-hours') as HTMLElement
  await waitFor(() => expect(text(section.querySelector('table tfoot'))).not.toContain('$0.00'))
  if (member) {
    fireEvent.change(within(section).getByRole('combobox'), { target: { value: member } })
  }
  const tables = section.querySelectorAll('table')
  return { view, summary: tables[0] as HTMLTableElement, detail: tables[tables.length - 1] as HTMLTableElement }
}

describe('the tab', () => {
  it('is the first tab, for an owner, and the page still opens where it did', () => {
    renderApprovals()
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent?.replace(/\d+$/, ''))).toEqual([
      'Payroll review',
      'Weekly submissions',
      'Approval queue',
      'Timesheet locks',
    ])
    // Opening the page still lands on the first of the OLD tabs with pending
    // work (a week is waiting on Weekly submissions), exactly as before.
    expect(screen.getByRole('tab', { name: /Weekly submissions/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('region', { name: 'Payroll review' })).toBeNull()
    expect(mockFetchRateVersions).not.toHaveBeenCalled()
  })

  it('opens from ?section=payroll and says, in plain text at the top, that it changes nothing', async () => {
    renderApprovals('/time-approvals?section=payroll')
    const section = await screen.findByRole('region', { name: 'Payroll review' })
    const purpose = within(section).getByText(REVIEW_ONLY_TEXT)
    expect(purpose).not.toHaveClass('muted-text')
    expect(REVIEW_ONLY_TEXT).toBe(
      'Review only: nothing here approves, sends back or changes any time. Look the week over here, then approve on the Weekly submissions tab or in the Approval queue. Approving there does not lock the time, so it can still be edited.',
    )
  })

  it('is not there for a non-owner, nor while an owner previews someone', () => {
    contextValue = makeContext({ ownerMode: false })
    const first = renderApprovals('/time-approvals?section=payroll')
    expect(screen.queryByRole('tab', { name: 'Payroll review' })).toBeNull()
    first.unmount()

    contextValue = makeContext({ previewMode: true })
    renderApprovals('/time-approvals?section=payroll')
    expect(screen.queryByRole('tab', { name: 'Payroll review' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Payroll review' })).toBeNull()
    // And no pay data is asked for.
    expect(mockFetchRateVersions).not.toHaveBeenCalled()
  })

  it("the old tab's Approve week no longer claims to seal the week", () => {
    const source = readFileSync(resolve(__dirname, '../pages/TimeApprovalsPage.tsx'), 'utf8')
    expect(source).toContain(
      'title="Approve every pending entry in this week. This does not lock the time: it can still be edited."',
    )
    expect(source).not.toContain('title="Approve this week and seal every pending entry in it"')
  })
})

describe('rates', () => {
  it('says the rates are being read instead of showing dashes', async () => {
    mockFetchRateVersions.mockReturnValue(new Promise(() => {}) as never)
    renderApprovals('/time-approvals?section=payroll')
    const section = await screen.findByRole('region', { name: 'Payroll review' })
    expect(within(section).getByText(RATES_LOADING_TEXT)).toBeInTheDocument()
    expect(text(within(section).getByLabelText('Week totals'))).not.toContain('—')
    expect(heading(section, 'emp-1')).toMatch(/^Avery Stone · \d+\.\d{2} h$/)
  })

  it('says the read failed, in words', async () => {
    mockFetchRateVersions.mockRejectedValue(new Error('offline'))
    renderApprovals('/time-approvals?section=payroll')
    const section = await screen.findByRole('region', { name: 'Payroll review' })
    expect(await within(section).findByText(RATES_FAILED_TEXT)).toBeInTheDocument()
    expect(RATES_FAILED_TEXT).toBe('Rates could not be read, so pay figures are missing. Reload to try again.')
    expect(text(within(section).getByLabelText('Week totals'))).not.toContain('—')
  })
})

describe('the week', () => {
  it('opens on the last COMPLETED week with its pay period, and moves a week at a time', async () => {
    const { section } = await openReview()
    expect(within(section).getByText('Nov 8 – Nov 14, 2026')).toBeInTheDocument()
    expect(within(section).getByText('Week 2 of pay period Nov 1 – Nov 14')).toBeInTheDocument()
    fireEvent.click(within(section).getByRole('button', { name: 'Next week' }))
    expect(within(section).getByText('Nov 15 – Nov 21, 2026')).toBeInTheDocument()
    expect(within(section).getByText('Week 1 of pay period Nov 15 – Nov 28')).toBeInTheDocument()
    expect(text(personBlock(section, 'emp-1'))).toContain('Mon Nov 16 · 2.00 h')
    fireEvent.click(within(section).getByRole('button', { name: 'Previous week' }))
    fireEvent.click(within(section).getByRole('button', { name: 'Previous week' }))
    expect(within(section).getByText('Nov 1 – Nov 7, 2026')).toBeInTheDocument()
    expect(within(section).getByText('Week 1 of pay period Nov 1 – Nov 14')).toBeInTheDocument()
    fireEvent.click(within(section).getByRole('button', { name: 'Next week' }))
    fireEvent.click(within(section).getByRole('button', { name: 'Next week' }))
    fireEvent.click(within(section).getByRole('button', { name: 'Next week' }))
    // A week with nobody's time.
    expect(within(section).getByText('No time logged this week.')).toBeInTheDocument()
  })

  it('lists every entry under one of the week’s seven days, and never the neighbors it compares against', async () => {
    const { section } = await openReview()
    const days = new Set(weekDates('2026-11-08'))
    const dayLines = [...section.querySelectorAll<HTMLElement>('[data-day]')]
    expect(dayLines.length).toBeGreaterThan(0)
    for (const line of dayLines) expect(days.has(line.dataset.day as string)).toBe(true)
    for (const id of ['p1', 'n0', 'n1']) expect(section.querySelector(`[data-entry-id="${id}"]`)).toBeNull()
  })
})

describe('people', () => {
  it('Everyone leaves the owners out and says so; an owner is picked by name; one person shows alone', async () => {
    const { section } = await openReview()
    expect(within(section).getByText(OWNERS_LEFT_OUT_TEXT)).toBeInTheDocument()
    expect(personBlock(section, 'emp-owner')).toBeNull()
    // The report's order: most time first, then by name.
    const order = [...section.querySelectorAll<HTMLElement>('[data-person-id]')].map((block) => block.dataset.personId)
    expect(order).toEqual(['emp-1', 'emp-2', 'emp-3', 'emp-4', 'emp-5'])

    pick('emp-owner')
    expect(within(section).queryByText(OWNERS_LEFT_OUT_TEXT)).toBeNull()
    expect(personBlock(section, 'emp-1')).toBeNull()
    expect(text(personBlock(section, 'emp-owner'))).toContain('Owner review')
    // Owners do not submit weeks: no "submitted / not submitted" for an owner.
    const status = within(section).getByRole('list', { name: 'Who is in this week' })
    expect(text(status)).toBe('Pat Owner · 1.00 h · 0 flagged entries')

    pick('emp-2')
    expect([...section.querySelectorAll('[data-person-id]')]).toHaveLength(1)
    expect(personBlock(section, 'emp-2')).not.toBeNull()
  })

  it('has one status line per person: hours, the week’s submission and the flagged count', async () => {
    const { section } = await openReview()
    const status = within(section).getByRole('list', { name: 'Who is in this week' })
    const lines = within(status).getAllByRole('listitem').map(text)
    expect(lines).toEqual([
      'Avery Stone · 11.83 h · submitted Nov 15 · 4 flagged entries · 1 long day',
      'Blair Nunez · 3.25 h · not submitted · 3 flagged entries',
      'Casey Ruiz · 2.00 h · submitted Nov 15, approved Nov 16 (not locked) · 0 flagged entries',
      'Dana Price · 2.00 h · submitted Nov 15, week sent back · 0 flagged entries',
      'Fay Former · 0.50 h · not submitted · 0 flagged entries',
    ])
  })

  it('keeps a former member picked in the Person list after moving to a week she has no time in', async () => {
    const { section } = await openReview()
    pick('emp-5')
    fireEvent.click(within(section).getByRole('button', { name: 'Previous week' }))
    const select = screen.getByLabelText('Person') as HTMLSelectElement
    expect(select.value).toBe('emp-5')
    expect(select.selectedOptions[0].textContent).toBe('Fay Former')
  })
})

describe('the totals are the Hours report’s', () => {
  /** The Hours report's summary cells for one person. */
  async function reportRow(name: string) {
    const { view, summary } = await renderReport()
    const row = [...summary.querySelectorAll('tbody tr')].find((tr) => tr.querySelector('td')?.textContent === name)
    const cells = [...(row as Element).querySelectorAll('td')].map((td) => td.textContent ?? '')
    view.unmount()
    // Team member, Hours, Billable, Billable $, Cost.
    return { hours: cells[1].replace('h', ''), amount: cells[3], cost: cells[4] }
  }

  it('per person: the heading carries the same hours, cost and billable as the report', async () => {
    const averyRow = await reportRow('Avery Stone')
    const blairRow = await reportRow('Blair Nunez')
    const { section } = await openReview()
    expect(heading(section, 'emp-1')).toBe(
      `Avery Stone · ${averyRow.hours} h · ${averyRow.cost} cost · ${averyRow.amount} billable`,
    )
    expect(heading(section, 'emp-2')).toBe(
      `Blair Nunez · ${blairRow.hours} h · ${blairRow.cost} cost · ${blairRow.amount} billable`,
    )
    pick('emp-1')
    const totals = text(within(section).getByLabelText('Week totals'))
    expect(totals).toContain(`Hours${averyRow.hours}h`)
    expect(totals).toContain(`Pay at cost${averyRow.cost}`)
    expect(totals).toContain(`Billable $${averyRow.amount}`)
    expect(totals).toContain('4 flagged entries · 1 long day')
  })

  it('a day line and single rows match the report’s Weekly view (raise mid-week, pinned client, full-mode pair)', async () => {
    const { view, detail } = await renderReport('emp-1')
    // Without the member column: job, task, in, out, stretch, hours, billable, $, cost.
    const dayRows = new Map<string, HTMLElement[]>()
    let day = ''
    let dayHours = new Map<string, string>()
    for (const tr of detail.querySelectorAll<HTMLElement>('tbody tr')) {
      if (tr.classList.contains('payroll-day-row')) {
        day = text(tr.querySelector('td'))
        dayHours = new Map([...dayHours, [day, text(tr.querySelectorAll('td')[1])]])
        continue
      }
      dayRows.set(day, [...(dayRows.get(day) ?? []), tr])
    }
    const sumOf = (rows: HTMLElement[], index: number) =>
      Math.round(rows.reduce((sum, tr) => sum + (lead(text(tr.querySelectorAll('td')[index])) || 0), 0) * 100) / 100
    const reportCost = (id: string) => sumOf([...detail.querySelectorAll<HTMLElement>(`tbody tr[data-entry-id="${id}"]`)], 8)
    const reportAmount = (id: string) => sumOf([...detail.querySelectorAll<HTMLElement>(`tbody tr[data-entry-id="${id}"]`)], 7)
    const tue = { hours: dayHours.get('Nov 10'), cost: sumOf(dayRows.get('Nov 10') ?? [], 8), amount: sumOf(dayRows.get('Nov 10') ?? [], 7) }
    const fri = { hours: dayHours.get('Nov 13'), cost: sumOf(dayRows.get('Nov 13') ?? [], 8), amount: sumOf(dayRows.get('Nov 13') ?? [], 7) }
    const rows = Object.fromEntries(['a1', 'a3', 'a5', 'a7a', 'a7b'].map((id) => [id, { cost: reportCost(id), amount: reportAmount(id) }]))
    view.unmount()

    const { section } = await openReview()
    const money = (value: number) => `$${value.toFixed(2)}`
    expect(cellsText(section.querySelector('[data-person-id="emp-1"] [data-day="2026-11-10"]') as Element)).toBe(
      `Tue Nov 10 · ${tue.hours?.replace('h', '')} h · ${money(tue.cost)} cost · ${money(tue.amount)} billable Long day More than 8 hours logged on this day (8.17h).`,
    )
    expect(cellsText(section.querySelector('[data-person-id="emp-1"] [data-day="2026-11-13"]') as Element)).toBe(
      `Fri Nov 13 · ${fri.hours?.replace('h', '')} h · ${money(fri.cost)} cost · ${money(fri.amount)} billable`,
    )
    // a1 is before the raise (Tuesday) at Acme; a3 is at the pinned client; a5 is after the raise.
    for (const id of ['a1', 'a3', 'a5', 'a7a']) {
      const cells = cellsOf(mainRow(section, id))
      expect([lead(cells[5]), lead(cells[6])]).toEqual([rows[id].cost, rows[id].amount])
    }
    // The full-mode repeat: its cost is on the first part, its billable is its own.
    expect(cellsOf(mainRow(section, 'a7b'))[5]).toBe('on the first part')
    expect(lead(cellsOf(mainRow(section, 'a7b'))[6])).toBe(rows.a7b.amount)
    // And the pinned client really bills at its older rate here: 3.00h at $80.
    expect(cellsOf(mainRow(section, 'a3'))[6]).toBe('$240.00')
  })

  it('never looks complete when it is not: names who has no rate, counts hours before a first rate, and says what a dash is', async () => {
    const { section } = await openReview()
    const totals = text(within(section).getByLabelText('Week totals'))
    expect(totals).toMatch(
      /Pay at cost\$[\d,]+\.\d{2} \(leaves out Dana Price: no cost rate on file and 1\.00h of Casey Ruiz's time with no cost rate on that day\)/,
    )
    expect(within(section).getByText(DASH_MEANS_TEXT)).toBeInTheDocument()
    expect(DASH_MEANS_TEXT).toBe('A dash means there is no rate on file. It is not $0.')
    expect(within(section).getByText(TOTALS_COUNT_TEXT)).toBeInTheDocument()
    // Casey: her Tuesday is before her first cost rate; the day says "—" and the week says what it leaves out.
    expect(cellsText(section.querySelector('[data-person-id="emp-3"] [data-day="2026-11-10"]') as Element)).toBe(
      'Tue Nov 10 · 1.00 h · — cost · $90.00 billable',
    )
    expect(heading(section, 'emp-3')).toBe(
      'Casey Ruiz · 2.00 h · $30.00 (leaves out 1.00h with no cost rate on that day) cost · $180.00 billable',
    )
    // Dana: no cost rate at all.
    expect(heading(section, 'emp-4')).toBe('Dana Price · 2.00 h · — cost · $180.00 billable')
    pick('emp-4')
    expect(text(within(section).getByLabelText('Week totals'))).toContain('Pay at cost—')
  })
})

describe('days, entries and stretches', () => {
  it('puts a day header above its entries, and the Long day flag beside it', async () => {
    const { section } = await openReview()
    const block = personBlock(section, 'emp-1')
    const rows = [...block.querySelectorAll<HTMLElement>('tbody tr')]
    const header = rows.findIndex((tr) => tr.dataset.day === '2026-11-10')
    const first = rows.findIndex((tr) => tr.dataset.entryId === 'a1')
    expect(header).toBeGreaterThanOrEqual(0)
    expect(first).toBe(header + 1)
    expect(block.querySelector('tfoot')).toBeNull()
  })

  it('carries client, task, the FULL description, hours, pay at cost, billable $ and how it was logged on one line', async () => {
    const { section } = await openReview()
    expect([...section.querySelectorAll('[data-person-id="emp-1"] thead th')].map(text)).toEqual([
      'Time', 'Client', 'Task', 'Description', 'Hours', 'Pay at cost', 'Billable $', 'Logged', 'Flags',
    ])
    expect(cellsOf(mainRow(section, 'a1')).slice(0, 8)).toEqual([
      '8:00 AM – 11:30 AM',
      'Acme Dental',
      'Bookkeeping',
      'Reconciled the October bank and card statements for both accounts',
      '3.50h',
      '$70.00',
      '$315.00',
      'Timer',
    ])
    // Administrative, non-billable time.
    expect(cellsOf(mainRow(section, 'a4')).slice(0, 8)).toEqual([
      '—', 'Administrative', 'Training', 'Team training', '1.00h', '$20.00', 'not billable', 'Hours only (no clock times)',
    ])
    // A manual entry says so once, by its chip, not again in the Logged column.
    expect(cellsOf(mainRow(section, 'a2'))[7]).toBe('')
  })

  it('lists an entry worked in several stretches as parts of the line above, not as hours to add', async () => {
    const { section } = await openReview()
    const rows = [...section.querySelectorAll<HTMLElement>('tr[data-entry-id="a3"]')]
    expect(rows).toHaveLength(3)
    expect(cellsOf(rows[0])[0]).toBe('2 stretches')
    expect(cellsOf(rows[1])).toEqual(['1 of 2 · 1:00 PM – 2:00 PM · 1.00h of the 3.00h above'])
    expect(cellsOf(rows[2])).toEqual(['2 of 2 · 2:30 PM – 4:30 PM · 2.00h of the 3.00h above'])
  })

  it('a three-client even split: each part says it is a shared block, with payrollClock’s note on the row', async () => {
    const { section } = await openReview()
    for (const [id, client] of [['a6a', 'Acme Dental'], ['a6b', 'Bright Books'], ['a6c', 'Cedar Cafe']]) {
      const cells = cellsOf(mainRow(section, id))
      expect(cells.slice(0, 2)).toEqual(['Shared block 9:00 AM – 9:39 AM13m of a 39m block shared by 3 clients', client])
      expect(text(mainRow(section, id).querySelector('.payroll-review-block-note'))).toBe('13m of a 39m block shared by 3 clients')
      expect(cells[4]).toBe('0.22h')
    }
  })

  it('a full-mode pair: billed in full to each client, its hours and cost counted once', async () => {
    const { section } = await openReview()
    for (const id of ['a7a', 'a7b']) {
      expect(text(mainRow(section, id).querySelector('td'))).toBe(
        'Shared block 2:00 PM – 3:00 PMfull 1h block billed to each of 2 clients; hours counted once',
      )
    }
    expect(cellsText(section.querySelector('[data-person-id="emp-1"] [data-day="2026-11-13"]') as Element)).toMatch(/^Fri Nov 13 · 1\.00 h · /)
  })
})

describe('flags', () => {
  const flagsOf = (section: HTMLElement, id: string) =>
    [...mainRow(section, id).querySelectorAll('[data-flag]')].map((item) => text(item))
  const notesOf = (section: HTMLElement, id: string) =>
    [...mainRow(section, id).querySelectorAll('[data-note]')].map((item) => text(item))

  it('shows each flag that needs a look with its sentence, readable without hover', async () => {
    const { section } = await openReview()
    expect(flagsOf(section, 'a1')).toEqual([
      'Overlaps another entry Overlaps Bright Books, 11:20 AM - 12:00 PM, by 10m.',
      'Long entry More than 3 hours on one entry (3.50h).',
    ])
    expect(flagsOf(section, 'a2')).toEqual([
      'Manual entry This time was logged with Log time manually, not with the timer.',
      'Overlaps another entry Overlaps Acme Dental, 8:00 AM - 11:30 AM, by 10m.',
    ])
    // Exactly 3.00 hours is not a long entry.
    expect(flagsOf(section, 'a3')).toEqual([])
    expect(flagsOf(section, 'a5')).toEqual(['Sent back Sent back to the person to fix. The note: "Which client was this?"'])
    expect(flagsOf(section, 'b3')).toEqual([
      "Hours typed, not timed Hours typed in. This entry's stretches add up to 30m on the clock. The 0.75h shown is what is counted.",
    ])
    expect(flagsOf(section, 'b4')).toEqual([
      'Possible duplicate Another entry on this day, with no clock times, has the same client, task, hours and description.',
    ])
    // The parts of one block never overlap each other.
    expect(flagsOf(section, 'a6a')).toEqual([])
    const chip = section.querySelector('tr[data-entry-id="a1"] [data-flag="long_entry"] .payroll-flag-chip')
    expect(chip).toHaveAttribute('title', 'More than 3 hours on one entry (3.50h).')
  })

  it('compares against the day after the week: a Saturday entry past midnight overlaps Sunday’s', async () => {
    const { section } = await openReview()
    expect(flagsOf(section, 'a8')).toEqual([
      'Overlaps another entry Overlaps Acme Dental on Sun Nov 15, 12:10 AM - 12:40 AM, by 20m.',
    ])
  })

  it('clock times edited and not approved yet are notes on the row, not counted flags', async () => {
    const { section } = await openReview()
    expect(flagsOf(section, 'b2')).toEqual([])
    expect(notesOf(section, 'b2')).toEqual([`Clock times edited: ${CLOCK_TIMES_EDITED_TITLE}`])
    expect(cellsOf(mainRow(section, 'b2'))[7]).toBe(`TimerClock times edited: ${CLOCK_TIMES_EDITED_TITLE}`)
    expect(notesOf(section, 'a2')).toEqual([
      "This entry is waiting for approval. An owner approves it in the Approval queue, or by approving the person's submitted week on the Weekly submissions tab.",
    ])
  })

  it('uses the Approval queue’s own words for edited clock times', () => {
    expect(CLOCK_EDITED_SENTENCE).toBe(CLOCK_TIMES_EDITED_TITLE)
  })

  it('Show only flagged keeps what needs a look, and the totals still count every entry', async () => {
    const { section } = await openReview()
    const before = heading(section, 'emp-1')
    fireEvent.click(within(section).getByLabelText('Show only flagged'))
    // Unflagged rows on a day that is not long are hidden...
    for (const id of ['b1', 'b2', 'a6a', 'a7a']) expect(mainRow(section, id)).toBeNull()
    for (const id of ['a1', 'a2', 'a5', 'a8', 'b3', 'b4']) expect(mainRow(section, id)).not.toBeNull()
    // ...but a Long day shows ALL its rows, so she can see why it is long.
    for (const id of ['a3', 'a4']) expect(mainRow(section, id)).not.toBeNull()
    expect(heading(section, 'emp-1')).toBe(before)
    expect(text(personBlock(section, 'emp-4'))).toContain('Nothing flagged this week.')
  })
})

describe('edge cases from review', () => {
  /** A small week of its own, in place of the shared fixture. */
  function useData(over: { employees?: unknown[]; timeEntries?: unknown[]; costRates?: unknown[] }) {
    mockFetchRateVersions.mockResolvedValue({
      billRateVersions: [],
      costRateVersions: over.costRates ?? costRates,
    } as never)
    const base = makeContext()
    contextValue = {
      ...base,
      data: { ...base.data, employees: over.employees ?? employees, inactiveEmployees: [], timeEntries: over.timeEntries ?? [] },
    } as unknown as AppContextValue
  }

  it('Billable $ does not name someone with no bill rate who logged only non-billable time', async () => {
    useData({
      employees: [
        { id: 'emp-1', name: 'Avery Stone', role: 'Bookkeeper', billRate: 90 },
        { id: 'emp-6', name: 'Eli Admin', role: 'Bookkeeper' },
      ],
      costRates: [costRates[0], { userId: 'emp-6', effectiveDate: '1970-01-01', rate: 15 }],
      timeEntries: [
        entry({ id: 'x1', date: iso(10), minutes: 60 }),
        entry({ id: 'x2', employeeId: 'emp-6', date: iso(10), minutes: 60, clientId: '', isAdministrative: true, billable: false }),
      ],
    })
    const { section } = await openReview()
    const totals = text(within(section).getByLabelText('Week totals'))
    expect(totals).toContain('Billable $$90.00Needs')
    expect(totals).not.toContain('Eli Admin')
    expect(heading(section, 'emp-6')).toBe('Eli Admin · 1.00 h · $15.00 cost · — billable')
  })

  it('every hour before the first cost rate reads as a dash with its note, never $0.00', async () => {
    useData({ timeEntries: [entry({ id: 'c-only', employeeId: 'emp-3', date: iso(10), minutes: 300 })] })
    const { section } = await openReview()
    expect(heading(section, 'emp-3')).toBe(
      'Casey Ruiz · 5.00 h · — (leaves out 5.00h with no cost rate on that day) cost · $450.00 billable',
    )
    expect(cellsText(section.querySelector('[data-person-id="emp-3"] [data-day="2026-11-10"]') as Element)).toBe(
      'Tue Nov 10 · 5.00 h · — cost · $450.00 billable',
    )
    pick('emp-3')
    expect(text(within(section).getByLabelText('Week totals'))).toContain('Pay at cost— (leaves out 5.00h of Casey Ruiz')
    expect(text(within(section).getByLabelText('Week totals'))).not.toContain('$0.00')
  })

  it('a shared part resumed alone: no "Shared block" over times that are not the block’s, and its stretches are this part’s', async () => {
    const first = { startAt: at(12, 9, 0, 7), endAt: at(12, 9, 39, 7) }
    const resumed = { startAt: at(12, 15, 0, 7), endAt: at(12, 15, 20, 7) }
    const part = (id: string, clientId: string, sessions: unknown[], minutes: number) =>
      entry({ id, date: iso(12), clientId, minutes, groupId: 'g-r', groupAllocation: 'even', startAt: first.startAt, endAt: (sessions.at(-1) as { endAt: string }).endAt, sessions })
    useData({
      timeEntries: [part('r1', 'c1', [first, resumed], 33), part('r2', 'c2', [first], 13), part('r3', 'c3', [first], 13)],
    })
    const { section } = await openReview()
    const rows = [...section.querySelectorAll<HTMLElement>('tr[data-entry-id="r1"]')]
    expect(text(rows[0].querySelector('td'))).toMatch(/^2 stretches/)
    expect(cellsOf(rows[1])[0]).toMatch(/^1 of 2 · 9:00 AM – 9:39 AM · \d\.\d{2}h of this part's 0\.55h$/)
    expect(cellsOf(rows[2])[0]).toMatch(/^2 of 2 · 3:00 PM – 3:20 PM · \d\.\d{2}h of this part's 0\.55h$/)
    // The siblings no longer share one set of stretches with r1: their own times, without the words.
    const sibling = text(mainRow(section, 'r2').querySelector('td'))
    expect(sibling).not.toContain('Shared block')
    expect(sibling.startsWith('9:00 AM – 9:39 AM')).toBe(true)
    // payrollClock's own state-aware note still speaks under it.
    expect(text(mainRow(section, 'r2').querySelector('.payroll-review-block-note'))).toMatch(/block/)
  })
})

describe('Paycheck totals', () => {
  it('shows both weeks of the pay period, per person and in total, and what it counts', async () => {
    const { section } = await openReview()
    fireEvent.click(within(section).getByRole('button', { name: 'Paycheck totals' }))
    const panel = within(section).getByLabelText('Paycheck totals')
    expect(text(within(panel).getByRole('heading'))).toBe(
      'Paycheck totals: both weeks of the pay period Nov 1 – Nov 14, 2026 · Everyone',
    )
    expect(text(panel)).toContain(PAYCHECK_COUNTS_TEXT)
    expect(text(panel)).not.toContain('not finished')
    expect(within(panel).getByText(PAYCHECK_FOOT_TEXT)).toBeInTheDocument()
    expect([...panel.querySelectorAll('thead th')].map(text)).toEqual([
      'Person', 'Week 1 (Nov 1 – Nov 7)', 'Week 2 (Nov 8 – Nov 14)', 'Hours, both weeks', 'Pay at cost', 'Billable $',
    ])
    const rows = [...panel.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map(text))
    expect(rows.map((row) => row.slice(0, 4))).toContainEqual(['Avery Stone', '1.00h', '11.83h', '12.83h'])
    expect(rows.find((row) => row[0] === 'Dana Price')?.[4]).toBe('—')
    const total = [...(panel.querySelector('tfoot tr') as Element).querySelectorAll('td')].map(text)
    expect(total[0]).toBe('Total')
    expect(total[4]).toMatch(
      /^\$[\d,]+\.\d{2} \(leaves out Dana Price: no cost rate on file and 1\.00h of Casey Ruiz's time with no cost rate on that day\)$/,
    )
  })

  it('says when a week of the period is not finished yet', async () => {
    const { section } = await openReview()
    fireEvent.click(within(section).getByRole('button', { name: 'Next week' }))
    fireEvent.click(within(section).getByRole('button', { name: 'Paycheck totals' }))
    expect(text(within(section).getByLabelText('Paycheck totals'))).toContain(
      `${PAYCHECK_COUNTS_TEXT} Weeks 1 and 2 are not finished yet.`,
    )
  })
})
