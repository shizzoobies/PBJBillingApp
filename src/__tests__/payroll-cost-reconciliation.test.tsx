import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReportsPage } from '../pages/ReportsPage'
import { DEFAULT_FIRM_SETTINGS } from '../lib/types'
import type { AppContextValue } from '../AppContext'

/**
 * The payroll report's Cost column, from the owner's side of the desk.
 *
 * She checked a period by hand and landed 16¢ under the report. Her arithmetic
 * was fine — she multiplied the 2-decimal hours the report showed her, while
 * the report divided seconds. The fix was never different math; it was making
 * the shown numbers add up to the shown total and shipping enough precision in
 * the exports to re-derive them. That is what this file pins:
 *
 *   - every Cost cell is cent-rounded per person, and the column sums to the
 *     total under it, exactly, with a calculator;
 *   - the exports carry the exact minutes and 4-decimal hours needed to
 *     reproduce a cost figure by hand;
 *   - the page says out loud how cost is computed.
 */

vi.mock('../lib/api', () => ({ fetchTeam: vi.fn() }))
vi.mock('../lib/csv', () => ({ downloadCsv: vi.fn() }))
vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))

import { fetchTeam } from '../lib/api'
import { downloadCsv } from '../lib/csv'

const mockFetchTeam = vi.mocked(fetchTeam)
const mockDownloadCsv = vi.mocked(downloadCsv)

/** A day inside the default (bi-weekly) window once the anchor is set to it. */
const DAY = '2026-08-05'

/**
 * Two people, ten minutes each, at $37/h. Chosen because it is the smallest
 * case that separates the rules: each person is $6.1666… → $6.17, so the
 * column reads 6.17 + 6.17 = $12.34, while summing the raw floats and rounding
 * once at the end gives $12.33. One of those can be checked by hand.
 */
const COST_RATE = 37
const employees = [
  { id: 'emp-1', name: 'Avery Stone', billRate: 90 },
  { id: 'emp-2', name: 'Blair Nunez', billRate: 90 },
  // No cost rate at all — the owner. Her Cost cell must read "—", not $0.00.
  { id: 'emp-owner', name: 'Owner', billRate: 0 },
]

const timeEntries = [
  entry({ id: 't1', employeeId: 'emp-1', minutes: 10 }),
  entry({ id: 't2', employeeId: 'emp-2', minutes: 10 }),
  entry({ id: 't3', employeeId: 'emp-owner', minutes: 45 }),
]

function entry(over: { id: string; employeeId: string; minutes: number }) {
  return {
    date: DAY,
    clientId: null,
    isAdministrative: true,
    billable: true,
    taskId: null,
    taskLabel: 'Bookkeeping',
    description: 'Work',
    workSessions: [],
    ...over,
  }
}

let contextValue: AppContextValue

beforeEach(() => {
  mockDownloadCsv.mockReset()
  mockFetchTeam.mockReset()
  mockFetchTeam.mockResolvedValue({
    users: [
      { id: 'emp-1', costRate: COST_RATE },
      { id: 'emp-2', costRate: COST_RATE },
      { id: 'emp-owner', costRate: null },
    ],
  } as unknown as Awaited<ReturnType<typeof fetchTeam>>)

  contextValue = {
    ownerMode: true,
    billingPeriod: '2026-08',
    firmSettings: DEFAULT_FIRM_SETTINGS,
    data: {
      employees,
      inactiveEmployees: [],
      timeEntries,
      clients: [],
      plans: [],
      checklists: [],
      reimbursements: [],
      recurringReimbursements: [],
    },
  } as unknown as AppContextValue
})

/** Renders the page and parks the payroll window on the day the entries land. */
async function renderReport() {
  const view = render(<ReportsPage />)
  fireEvent.change(screen.getByLabelText('Period start date'), { target: { value: DAY } })
  // The Cost column only fills in once /api/team resolves the pay rates.
  await waitFor(() => expect(mockFetchTeam).toHaveBeenCalled())
  await screen.findAllByText('$6.17')
  return view
}

/** The payroll summary table's body rows and footer, as plain text cells. */
function summaryTable(container: HTMLElement) {
  const table = container.querySelector('#payroll-hours table') as HTMLTableElement
  const cells = (row: Element) => [...row.querySelectorAll('td')].map((td) => td.textContent ?? '')
  return {
    body: [...table.querySelectorAll('tbody tr')].map(cells),
    footer: cells(table.querySelector('tfoot tr') as Element),
  }
}

const dollars = (text: string) => Number(text.replace(/[$,]/g, ''))

/**
 * Summary column positions. Named rather than inlined because the Minutes
 * column was inserted between Hours and Billable, and a bare `row[4]` gave no
 * hint that it had moved.
 */
const HOURS = 1
const MINUTES = 2
const COST = 5

describe('payroll Cost column reconciles by hand', () => {
  it('sums the visible Cost cells to exactly the shown total', async () => {
    const { container } = await renderReport()
    const { body, footer } = summaryTable(container)

    const costCells = body.map((row) => row[COST])
    expect(costCells).toContain('$6.17')
    // The owner has no cost rate: "—", never "$0.00".
    expect(costCells).toContain('—')

    const byHand = costCells
      .filter((cell) => cell !== '—')
      .reduce((sum, cell) => sum + dollars(cell), 0)
    expect(footer[COST]).toBe('$12.34')
    expect(byHand.toFixed(2)).toBe('12.34')
  })

  it('shows the total the per-person rule gives, not the old float sum', async () => {
    const { container } = await renderReport()
    // Summing the unrounded floats and rounding once at display showed $12.33 —
    // a figure the owner could never reproduce from the cells above it.
    expect(summaryTable(container).footer[COST]).not.toBe('$12.33')
  })

  it('states the cost basis on the page, next to the totals', async () => {
    await renderReport()
    expect(screen.getByText(/Cost comes from the exact Minutes column/i)).toBeInTheDocument()
  })
})

/**
 * ITEM 2 — the send-back. Two-decimal hours alone do NOT make cost checkable:
 * 20.22h × $16 = $323.52 where the real figure is $323.54. So the exact minutes
 * are on the screen, not only in the CSV, and `minutes ÷ 60 × rate` has to land
 * on the Cost cell for every row.
 */
describe('payroll summary shows exact minutes beside the hours', () => {
  it('prints a Minutes column between Hours and Billable', async () => {
    const { container } = await renderReport()
    const headers = [
      ...(container.querySelector('#payroll-hours table thead tr') as Element).querySelectorAll(
        'th',
      ),
    ].map((th) => th.textContent ?? '')
    expect(headers[HOURS]).toBe('Hours')
    expect(headers[MINUTES]).toBe('Minutes')
    expect(headers[3]).toBe('Billable')
  })

  it('reproduces every Cost cell from minutes ÷ 60 × rate', async () => {
    const { container } = await renderReport()
    const { body, footer } = summaryTable(container)

    for (const row of body) {
      const minutes = Number(row[MINUTES])
      expect(Number.isFinite(minutes)).toBe(true)
      // The owner has no pay rate, so there is no cost to reproduce.
      if (row[COST] === '—') continue
      const byHand = ((minutes / 60) * COST_RATE).toFixed(2)
      expect(dollars(row[COST]).toFixed(2)).toBe(byHand)
    }

    // Exact, not rounded: 10 + 10 + 45.
    expect(footer[MINUTES]).toBe('65')
  })

  it('would NOT reconcile from the 2-decimal hours alone — which is why it is there', async () => {
    const { container } = await renderReport()
    const row = summaryTable(container).body.find((cells) => cells[COST] === '$6.17') as string[]
    // "0.17h" × $37 = $6.29, nowhere near the $6.17 the report shows. The hours
    // column is for reading; the minutes column is for checking.
    expect(row[HOURS]).toBe('0.17h')
    expect((Number(row[HOURS].replace('h', '')) * COST_RATE).toFixed(2)).not.toBe('6.17')
  })
})

describe('payroll hours read as x.xx', () => {
  it('renders two decimals everywhere in the summary, never one', async () => {
    const { container } = await renderReport()
    const { body, footer } = summaryTable(container)
    for (const row of [...body, footer]) {
      for (const cell of [row[HOURS], row[3]]) {
        if (cell) expect(cell).toMatch(/^\d+\.\d{2}h$/)
      }
    }
    // 65 minutes tracked in total → 1.0833h → "1.08h", not "1.1h".
    expect(footer[HOURS]).toBe('1.08h')
  })
})

describe('payroll detail table keeps the per-person cost rule', () => {
  it('explains the penny gap between per-row cents and the detail total', async () => {
    await renderReport()
    expect(screen.getByText(/row cents may differ by a penny or two/i)).toBeInTheDocument()
  })

  it('carries the same rule into the detail table’s grand total', async () => {
    const { container } = await renderReport()
    const tables = container.querySelectorAll('#payroll-hours table')
    const detailFooter = [
      ...(tables[1].querySelector('tfoot tr') as Element).querySelectorAll('td'),
    ].map((td) => td.textContent ?? '')
    // Last column of the detail table is Cost.
    expect(detailFooter[detailFooter.length - 1]).toBe('$12.34')
  })
})

describe('payroll exports carry enough precision to re-derive a cost', () => {
  it('gives the Summary CSV exact minutes, 4dp hours and the Cost it shows', async () => {
    await renderReport()
    fireEvent.click(screen.getByRole('button', { name: /Summary CSV/i }))

    const [, headers, rows] = mockDownloadCsv.mock.calls[0]
    // The original five keep their names AND positions — the owner's own
    // spreadsheets point at them.
    expect(headers.slice(0, 5)).toEqual([
      'Employee',
      'Tracked hours',
      'Billable hours',
      'Internal hours',
      'Entries',
    ])
    expect(headers.slice(5)).toEqual([
      'Tracked minutes (exact)',
      'Tracked hours (4dp)',
      'Cost',
    ])

    const avery = rows.find((row) => row[0] === 'Avery Stone') as string[]
    expect(avery[5]).toBe('10')
    expect(avery[6]).toBe('0.1667')
    expect(avery[7]).toBe('6.17')

    // The owner's cost is blank, not "0.00": a spreadsheet must not be told she
    // was paid nothing per hour.
    expect((rows.find((row) => row[0] === 'Owner') as string[])[7]).toBe('')

    const total = rows.find((row) => row[0] === 'TOTAL') as string[]
    expect(total[5]).toBe('65') // 10 + 10 + 45, exact
    expect(total[7]).toBe('12.34')
  })

  it('gives the Raw hours CSV exact minutes and 4dp hours, appended', async () => {
    await renderReport()
    fireEvent.click(screen.getByRole('button', { name: /Raw hours/i }))

    const [, headers, rows] = mockDownloadCsv.mock.calls[0]
    // Appended, so anything already reading "Hours" at column 8 still does.
    expect(headers[7]).toBe('Hours')
    expect(headers.slice(-2)).toEqual(['Minutes (exact)', 'Hours (4dp)'])

    const row = rows[0] as string[]
    expect(row[headers.indexOf('Minutes (exact)')]).toBe('10')
    expect(row[headers.indexOf('Hours (4dp)')]).toBe('0.1667')
    // Per-entry cost is cent-rounded too, so the column is readable on its own.
    expect(row[headers.indexOf('Cost')]).toBe('6.17')
  })

  it('cent-rounds the Cost column in the employee report CSV', async () => {
    await renderReport()
    // Three sections offer a "Download CSV"; this is the Employee report's.
    const section = screen.getByRole('heading', { name: 'Employee report' }).closest('section')
    fireEvent.click(within(section as HTMLElement).getByRole('button', { name: /Download CSV/i }))

    const [, headers, rows] = mockDownloadCsv.mock.calls[0]
    const costIndex = headers.indexOf('Cost')
    const avery = rows.find((row) => row[0] === 'Avery Stone') as string[]
    expect(avery[costIndex]).toBe('6.17')
    expect((rows.find((row) => row[0] === 'Owner') as string[])[costIndex]).toBe('')
  })
})
