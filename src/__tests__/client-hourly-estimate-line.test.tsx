import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EstimatedRoleHours } from '../pages/ClientDetailPage'
import type { AppContextValue } from '../AppContext'
import type { AppData, Client } from '../lib/types'

/**
 * "ESTIMATED MONTHLY INVOICE" under the estimated hours (featreq-a9de307f):
 * hourly clients only, owner only, and it moves with every keystroke - the
 * hours x each role's rate, through the same helper the Client Recap uses.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', () => ({
  fetchRateVersions: (...args: unknown[]) => fetchRateVersions(...args),
  applyPackageRequest: vi.fn(),
  issueRetainerInvoiceRequest: vi.fn(),
  listPackagesRequest: vi.fn(async () => []),
  recordClientProfileActivity: vi.fn(),
  setClientAssignedTeamRequest: vi.fn(),
  setClientHourlyRatePeriod: vi.fn(),
}))

let fetchRateVersions = vi.fn()
let contextValue: AppContextValue

const employees = [
  { id: 'emp-lisa', name: 'Lisa', role: 'Bookkeeper' },
  { id: 'emp-ann', name: 'Ann', role: 'Accountant' },
]
const BILL_VERSIONS = [
  { userId: 'emp-lisa', effectivePeriod: '2026-01', rate: 95 },
  { userId: 'emp-ann', effectivePeriod: '2026-01', rate: 150 },
]

const hourly = {
  id: 'c1',
  name: 'Acme',
  billingMode: 'hourly',
  hourlyRate: 0,
  assignedBookkeeperIds: ['emp-lisa', 'emp-ann'],
  estimatedBookkeeperHours: 10,
  estimatedAccountantHours: 2,
} as unknown as Client

function renderHours(client: Client, { ownerMode = true } = {}) {
  contextValue = {
    ownerMode,
    data: { clients: [client], employees } as unknown as AppData,
  } as unknown as AppContextValue
  return render(<EstimatedRoleHours client={client} onCommit={vi.fn()} />)
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date('2026-09-22T12:00:00'))
  fetchRateVersions = vi.fn(async () => ({ billRateVersions: BILL_VERSIONS, costRateVersions: [] }))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Estimated monthly invoice (Billing tab)', () => {
  it('shows hours x rate for an hourly client, with the breakdown', async () => {
    renderHours(hourly)
    expect(await screen.findByText('Estimated monthly invoice: $1,250.00')).toBeInTheDocument()
    expect(screen.getByText('bookkeeper 10 h × $95.00 + accountant 2 h × $150.00 + CFO 0 h')).toBeInTheDocument()
    // the existing sentence stays true and stays put
    expect(screen.getByText(/For planning only/)).toBeInTheDocument()
  })

  it('is absent for a monthly and an annual client, and never asks for rates', () => {
    for (const billingMode of ['subscription', 'annual']) {
      const { unmount } = renderHours({ ...hourly, billingMode } as unknown as Client)
      expect(screen.queryByText(/Estimated monthly invoice/)).not.toBeInTheDocument()
      unmount()
    }
    expect(fetchRateVersions).not.toHaveBeenCalled()
  })

  it('moves with the hours as they are typed, before anything saves', async () => {
    renderHours(hourly)
    await screen.findByText('Estimated monthly invoice: $1,250.00')
    fireEvent.change(screen.getByLabelText('Bookkeeper'), { target: { value: '20' } })
    expect(screen.getByText('Estimated monthly invoice: $2,200.00')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Accountant'), { target: { value: '' } })
    expect(screen.getByText('Estimated monthly invoice: $1,900.00')).toBeInTheDocument()
    expect(screen.getByText('bookkeeper 20 h × $95.00 + accountant 0 h + CFO 0 h')).toBeInTheDocument()
  })

  it('is hidden from a staff session', () => {
    renderHours(hourly, { ownerMode: false })
    expect(screen.queryByText(/Estimated monthly invoice/)).not.toBeInTheDocument()
    expect(fetchRateVersions).not.toHaveBeenCalled()
  })

  it('says to set rates first instead of showing $0.00', async () => {
    fetchRateVersions = vi.fn(async () => ({ billRateVersions: [], costRateVersions: [] }))
    renderHours(hourly)
    expect(
      await screen.findByText(/Estimated monthly invoice: set hourly rates on the Team page/),
    ).toBeInTheDocument()
    expect(screen.queryByText(/\$0\.00/)).not.toBeInTheDocument()
  })
})
