import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReportsPage } from '../pages/ReportsPage'
import { DEFAULT_FIRM_SETTINGS } from '../lib/types'
import type { AppContextValue } from '../AppContext'

/**
 * The payroll report's Cost column, from the owner's side of the desk.
 *
 * She checked a period by hand and landed under the report. Her arithmetic was
 * fine — she multiplied the 2-decimal hours the report showed her, while the
 * report divided seconds. Two rounds of "fixing the rounding" were rejected,
 * because the disagreement was policy, not arithmetic. She settled it:
 *
 *   "I pay by the minute so if someone works 20 hours and 13.4 minutes rounded
 *    to the 2nd decimal then I would pay 20.22 times her cost..."
 *
 * So the printed Hours ARE the costing input. This file pins what that buys:
 *
 *   - every Cost cell is the Hours cell beside it × the pay rate, on screen and
 *     in the exports;
 *   - the column of Cost cells sums to the total under it, exactly;
 *   - the exact-minutes reconciliation column is gone, because the thing it
 *     existed to explain no longer happens.
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
 * case that separates the rules: ten minutes reads "0.17h", so her rule pays
 * 0.17 × 37 = $6.29 each and $12.58 in total, where dividing seconds paid
 * $6.17 each and $12.33 in total. Only one of those can be checked by hand
 * against the report, and it is hers.
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
  await screen.findAllByText('$6.29')
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
const hours = (text: string) => Number(text.replace('h', ''))

/** Summary column positions, named so a future insertion is obvious. */
const HOURS = 1
const BILLABLE = 2
const COST = 4

describe('payroll Cost column reconciles by hand', () => {
  it('is the Hours cell times the pay rate, on every row', async () => {
    const { container } = await renderReport()
    const { body } = summaryTable(container)

    for (const row of body) {
      // The owner has no pay rate, so there is no cost to reproduce.
      if (row[COST] === '—') continue
      const byHand = (hours(row[HOURS]) * COST_RATE).toFixed(2)
      expect(dollars(row[COST]).toFixed(2)).toBe(byHand)
    }
    // Spelled out for the reader: 0.17h × $37 = $6.29.
    const avery = body.find((cells) => cells[0] === 'Avery Stone') as string[]
    expect(avery[HOURS]).toBe('0.17h')
    expect(avery[COST]).toBe('$6.29')
  })

  it('sums the visible Cost cells to exactly the shown total', async () => {
    const { container } = await renderReport()
    const { body, footer } = summaryTable(container)

    const costCells = body.map((row) => row[COST])
    expect(costCells).toContain('$6.29')
    // The owner has no cost rate: "—", never "$0.00".
    expect(costCells).toContain('—')

    const byHand = costCells
      .filter((cell) => cell !== '—')
      .reduce((sum, cell) => sum + dollars(cell), 0)
    expect(footer[COST]).toBe('$12.58')
    expect(byHand.toFixed(2)).toBe('12.58')
  })

  it('shows HER number, not the exact-seconds one the send-backs were about', async () => {
    const { container } = await renderReport()
    // Dividing seconds paid $6.17 a head and $12.33 in total — figures that
    // could not be reproduced from anything printed on the page.
    const { body, footer } = summaryTable(container)
    expect(body.map((row) => row[COST])).not.toContain('$6.17')
    expect(footer[COST]).not.toBe('$12.33')
  })

  it('states the cost basis under the payroll table AND the employee report', async () => {
    await renderReport()
    // Both tables get printed, so both carry the sentence.
    expect(screen.getAllByText(/Cost is the Hours shown times the pay rate/i)).toHaveLength(2)
  })
})

/**
 * The exact "Minutes" column is GONE. It sat between Hours and Billable for one
 * reason — to explain why the printed hours would not multiply out — and that
 * reason has been retired along with the exact-seconds rule.
 */
describe('payroll summary drops the exact-minutes reconciliation column', () => {
  it('runs Team member, Hours, Billable — with no Minutes between them', async () => {
    const { container } = await renderReport()
    const headers = [
      ...(container.querySelector('#payroll-hours table thead tr') as Element).querySelectorAll(
        'th',
      ),
    ].map((th) => th.textContent ?? '')
    expect(headers[HOURS]).toBe('Hours')
    expect(headers[BILLABLE]).toBe('Billable')
    expect(headers).not.toContain('Minutes')
  })
})

describe('payroll hours read as x.xx', () => {
  it('renders two decimals everywhere in the summary, never one', async () => {
    const { container } = await renderReport()
    const { body, footer } = summaryTable(container)
    for (const row of [...body, footer]) {
      for (const cell of [row[HOURS], row[BILLABLE]]) {
        if (cell) expect(cell).toMatch(/^\d+\.\d{2}h$/)
      }
    }
  })
})

/**
 * The Hours TOTAL is the sum of the Hours COLUMN, not the rounding of the
 * minutes behind it. This fixture is the case that separates them: 0.17h +
 * 0.17h + 0.75h = 1.09h, while 10 + 10 + 45 minutes round to 1.08h.
 *
 * 1.08 was pinned here until 2026-08-19 and was the honest answer while Hours
 * sat beside an exact Minutes column and cost came from the minutes. Deleting
 * that column made Hours the only time figure on the report AND the figure cost
 * is priced from, and a total that contradicts its own column is not something
 * to explain to someone who adds the column — so the displayed sum wins.
 */
describe('hours totals are the sum of the displayed rows', () => {
  it('adds the Hours column, not the minutes behind it', async () => {
    const { container } = await renderReport()
    const { body, footer } = summaryTable(container)
    const byHand = body.reduce((sum, row) => sum + hours(row[HOURS]), 0)
    expect(byHand.toFixed(2)).toBe('1.09')
    expect(footer[HOURS]).toBe('1.09h')
    // What rounding the raw 65 minutes would have said.
    expect(footer[HOURS]).not.toBe('1.08h')
  })

  it('adds the Billable column the same way', async () => {
    const { container } = await renderReport()
    const { body, footer } = summaryTable(container)
    const byHand = body.reduce((sum, row) => sum + hours(row[BILLABLE]), 0)
    expect(footer[BILLABLE]).toBe(`${byHand.toFixed(2)}h`)
  })

  it('composes in the detail table: rows add to the day, days add to the total', async () => {
    const { container } = await renderReport()
    const table = container.querySelectorAll('#payroll-hours table')[1]
    const dayTotals = [...table.querySelectorAll('tbody tr.payroll-day-row')].map((row) =>
      hours([...row.querySelectorAll('td')].map((td) => td.textContent ?? '')[1]),
    )
    const footer = [...(table.querySelector('tfoot tr') as Element).querySelectorAll('td')].map(
      (td) => td.textContent ?? '',
    )
    // One day in this fixture, and its subtotal is the sum of its three rows.
    expect(dayTotals).toEqual([1.09])
    expect(footer[1]).toBe(`${dayTotals.reduce((s, h) => s + h, 0).toFixed(2)}h`)
  })
})

/**
 * The per-entry Cost column (featreq-55212377) at the person-period rule.
 *
 * A row cannot be priced on its own AND add up to what the person is paid for
 * the period. Pricing rows independently put the column DOLLARS away from the
 * total over a real month — the same "her arithmetic doesn't match the page"
 * shape that got this item sent back twice. So each person's period cost is
 * split across their rows and the column sums exactly.
 */
describe('payroll detail Cost column adds up to its own total', () => {
  it('sums the visible per-entry Cost cells to the printed grand total', async () => {
    const { container } = await renderReport()
    const table = container.querySelectorAll('#payroll-hours table')[1]
    const entryRows = [...table.querySelectorAll('tbody tr:not(.payroll-day-row)')]
    const costCells = entryRows.map((row) => {
      const cells = [...row.querySelectorAll('td')].map((td) => td.textContent ?? '')
      return cells[cells.length - 1]
    })
    const byHand = costCells
      .filter((cell) => cell !== '—')
      .reduce((sum, cell) => sum + dollars(cell), 0)
    const footer = [...(table.querySelector('tfoot tr') as Element).querySelectorAll('td')].map(
      (td) => td.textContent ?? '',
    )
    expect(byHand.toFixed(2)).toBe('12.58')
    // Last column of the detail table is Cost, and it agrees with the summary.
    expect(footer[footer.length - 1]).toBe('$12.58')
  })

  it('says on the page that rows are a split of the person’s period pay', async () => {
    await renderReport()
    expect(
      screen.getByText(/split across their entries, so the column adds up to the total exactly/i),
    ).toBeInTheDocument()
  })
})

describe('payroll exports price off the hours they print', () => {
  it('gives the Summary CSV its five original columns plus Cost, and nothing else', async () => {
    await renderReport()
    fireEvent.click(screen.getByRole('button', { name: /Summary CSV/i }))

    const [, headers, rows] = mockDownloadCsv.mock.calls[0]
    // The original five keep their names AND positions — the owner's own
    // spreadsheets point at them. The exact-minutes and 4dp-hours columns that
    // used to follow are gone; Tracked hours × rate reproduces Cost on its own.
    expect(headers).toEqual([
      'Employee',
      'Tracked hours',
      'Billable hours',
      'Internal hours',
      'Entries',
      'Cost',
    ])

    const avery = rows.find((row) => row[0] === 'Avery Stone') as string[]
    expect(avery[1]).toBe('0.17')
    expect(avery[5]).toBe('6.29')
    expect((Number(avery[1]) * COST_RATE).toFixed(2)).toBe(avery[5])

    // The owner's cost is blank, not "0.00": a spreadsheet must not be told she
    // was paid nothing per hour.
    expect((rows.find((row) => row[0] === 'Owner') as string[])[5]).toBe('')

    // The summed-rows total, matching the on-screen footer: 0.17 + 0.17 + 0.75.
    const total = rows.find((row) => row[0] === 'TOTAL') as string[]
    expect(total[1]).toBe('1.09')
    expect(total[5]).toBe('12.58')
  })

  it('gives the Raw hours CSV a Cost that its own Hours cell reproduces', async () => {
    await renderReport()
    fireEvent.click(screen.getByRole('button', { name: /Raw hours/i }))

    const [, headers, rows] = mockDownloadCsv.mock.calls[0]
    // Hours stays at column 8 — anything already reading it still does.
    expect(headers[7]).toBe('Hours')
    expect(headers).not.toContain('Minutes (exact)')
    expect(headers).not.toContain('Hours (4dp)')

    const row = rows[0] as string[]
    expect(row[headers.indexOf('Hours')]).toBe('0.17')
    expect(row[headers.indexOf('Cost')]).toBe('6.29')
  })

  it('prices the Cost column in the employee report CSV the same way', async () => {
    await renderReport()
    // Three sections offer a "Download CSV"; this is the Employee report's.
    const section = screen.getByRole('heading', { name: 'Employee report' }).closest('section')
    fireEvent.click(within(section as HTMLElement).getByRole('button', { name: /Download CSV/i }))

    const [, headers, rows] = mockDownloadCsv.mock.calls[0]
    const costIndex = headers.indexOf('Cost')
    const hoursIndex = headers.indexOf('Tracked hours')
    const avery = rows.find((row) => row[0] === 'Avery Stone') as string[]
    expect(avery[costIndex]).toBe('6.29')
    expect((Number(avery[hoursIndex]) * COST_RATE).toFixed(2)).toBe(avery[costIndex])
    expect((rows.find((row) => row[0] === 'Owner') as string[])[costIndex]).toBe('')
  })
})
