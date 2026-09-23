import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HourlyRatesField } from '../pages/ClientDetailPage'
import type { AppContextValue } from '../AppContext'
import { ApiError, type AppData, type Client } from '../lib/types'

/**
 * THE "HOURLY RATES" BLOCK on the Client page (spec §2.2, §5).
 *
 * The block answers one question the owner could not ask anywhere before:
 * *what is this client actually being billed for each person's hour, and how
 * stale is that?* Three things are pinned here:
 *
 *   1. the rates shown are the ones AT THE CLIENT'S PIN, resolved through
 *      `billRateFor` — the same function the invoice prices with. Showing
 *      today's rate next to a June-pinned client is the exact confusion this
 *      whole build exists to end;
 *   2. the age line ("Rates from June 2026 — 3 months ago") is the yearly
 *      review prompt Brittany asked for;
 *   3. the move defaults to NEXT month, because moving the current month would
 *      reprice work already done at the old rate.
 *
 * And two absences: the block says nothing on a Monthly/Annual client (they
 * bill a fee, so a person's rate says nothing about them) and nothing at all
 * in a staff session (rates are owner-only).
 *
 * `fireEvent`, not `userEvent`: the project does not carry
 * `@testing-library/user-event`, and the sibling page suites drive the DOM the
 * same way.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', () => ({
  fetchRateVersions: (...args: unknown[]) => fetchRateVersions(...args),
  setClientHourlyRatePeriod: (...args: unknown[]) => setClientHourlyRatePeriod(...args),
  // ClientDetailPage imports these from the same module; the component under
  // test never reaches them.
  applyPackageRequest: vi.fn(),
  issueRetainerInvoiceRequest: vi.fn(),
  listPackagesRequest: vi.fn(async () => []),
  recordClientProfileActivity: vi.fn(),
  setClientAssignedTeamRequest: vi.fn(),
}))

let fetchRateVersions = vi.fn()
let setClientHourlyRatePeriod = vi.fn()

const LISA = 'emp-lisa'

/** Lisa was raised from $40 to $55 in September; Acme is still pinned to June. */
const BILL_VERSIONS = [
  { userId: LISA, effectivePeriod: '2026-06', rate: 40 },
  { userId: LISA, effectivePeriod: '2026-09', rate: 55 },
]

const hourly = {
  id: 'c1',
  name: 'Acme',
  billingMode: 'hourly',
  hourlyRate: 100,
  hourlyRatePeriod: '2026-06',
  hourlyRateHistory: [
    { from: null, to: '2026-06', changedAt: '2026-06-01T00:00:00.000Z', changedBy: 'emp-patrice' },
  ],
} as unknown as Client

const TODAY = '2026-09-22'

let contextValue: AppContextValue

async function renderBilling(
  client: Client,
  { today = TODAY, ownerMode = true }: { today?: string; ownerMode?: boolean } = {},
) {
  vi.setSystemTime(new Date(`${today}T12:00:00`))
  contextValue = {
    ownerMode,
    data: {
      clients: [client],
      employees: [{ id: LISA, name: 'Lisa', role: 'Bookkeeper' }],
    } as unknown as AppData,
  } as unknown as AppContextValue
  return render(<HourlyRatesField client={client} />)
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date(`${TODAY}T12:00:00`))
  fetchRateVersions = vi.fn(async () => ({
    billRateVersions: BILL_VERSIONS,
    costRateVersions: [],
  }))
  setClientHourlyRatePeriod = vi.fn(async (_id: string, period: string) => ({
    ...hourly,
    hourlyRatePeriod: period,
  }))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the Hourly rates block', () => {
  it('shows each member’s rate AT THE PIN, not today’s', async () => {
    await renderBilling(hourly)
    expect(await screen.findByText('Lisa')).toBeInTheDocument()
    expect(screen.getByText('$40.00/hr')).toBeInTheDocument()
    expect(screen.queryByText('$55.00/hr')).not.toBeInTheDocument()
  })

  it('says which month the rates date from, and how old that is', async () => {
    await renderBilling(hourly, { today: '2026-09-22' })
    expect(await screen.findByText(/Rates from June 2026/i)).toBeInTheDocument()
    expect(screen.getByText(/3 months/i)).toBeInTheDocument()
  })

  it('moves the client on press, defaulting to next month', async () => {
    await renderBilling(hourly)
    const month = await screen.findByLabelText(/Move to current rates from/i)
    expect(month).toHaveValue('2026-10')
    fireEvent.click(screen.getByRole('button', { name: /Move to current rates/i }))
    expect(setClientHourlyRatePeriod).toHaveBeenCalledWith('c1', '2026-10')
  })

  it('lists the moves', async () => {
    await renderBilling(hourly)
    fireEvent.click(await screen.findByText(/Rate month history/i))
    expect(screen.getByText('2026-06')).toBeInTheDocument()
  })

  it('shows the server’s own sentence when the move is refused', async () => {
    setClientHourlyRatePeriod = vi.fn(async () => {
      throw new ApiError(409, 'Lisa has no bill rate on file for October 2026.')
    })
    await renderBilling(hourly)
    fireEvent.click(await screen.findByRole('button', { name: /Move to current rates/i }))
    expect(
      await screen.findByText('Lisa has no bill rate on file for October 2026.'),
    ).toBeInTheDocument()
  })

  it('renders nothing for a MONTHLY client', async () => {
    await renderBilling({ ...hourly, billingMode: 'subscription' } as Client)
    expect(screen.queryByText(/Hourly rates/i)).not.toBeInTheDocument()
    expect(fetchRateVersions).not.toHaveBeenCalled()
  })

  it('renders nothing for a staff session', async () => {
    await renderBilling(hourly, { ownerMode: false })
    expect(screen.queryByText(/Hourly rates/i)).not.toBeInTheDocument()
    expect(fetchRateVersions).not.toHaveBeenCalled()
  })
})
