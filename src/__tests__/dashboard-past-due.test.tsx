import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardPage } from '../pages/DashboardPage'
import type { AppContextValue } from '../AppContext'
import type { AppData, PersistedInvoice } from '../lib/types'
import { localDateOnly } from '../lib/utils'

/**
 * The owner's "Invoices past due" section on the dashboard.
 *
 * Same rule as the month run's Past due tab (`pastDueInvoice`), read from the
 * same place, so the dashboard can never name a different set of invoices than
 * the page she goes to next. It is here rather than only there because the
 * dashboard is what she opens first, and "who owes us money" is the question
 * she opens it with.
 *
 * Invoices are fetched, not read off AppContext: they are deliberately outside
 * the workspace bulk save, and one owner-only GET with no period is cheaper
 * than putting every invoice in the app's shared state for this.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', () => ({
  // Shaped like the real responses: the owner view reads `.entries` off this
  // one, and an array would hand React `Array.prototype.entries` as a state
  // updater and take the whole view down.
  fetchGlobalActivity: vi.fn().mockResolvedValue({ entries: [] }),
  fetchRateVersions: vi.fn().mockResolvedValue({ billRateVersions: [], costRateVersions: [] }),
  fetchTeam: vi.fn().mockResolvedValue({ users: [] }),
  fetchTeamActivity: vi.fn().mockResolvedValue({ entries: [] }),
  listInvoicesRequest: vi.fn(),
}))

import { listInvoicesRequest } from '../lib/api'

const mockList = vi.mocked(listInvoicesRequest)

const OWNER = 'emp-patrice'
const LISA = 'emp-lisa'
const THIS_YEAR = new Date().getFullYear()

/** A due date `days` from today, in the YYYY-MM-DD the rule compares against. */
const dayFromToday = (days: number) => {
  const base = new Date(`${localDateOnly()}T00:00:00Z`)
  base.setUTCDate(base.getUTCDate() + days)
  return base.toISOString().slice(0, 10)
}

const invoice = (over: Partial<PersistedInvoice> = {}): PersistedInvoice =>
  ({
    id: 'inv-1',
    clientId: 'client-shared',
    period: '2026-08',
    kind: 'monthly',
    number: 'INV-2026-08-031',
    status: 'sent',
    lineItems: [],
    subtotal: 400,
    total: 400,
    dueDate: dayFromToday(-40),
    blurb: '',
    scopeFlags: [],
    sentAt: '2026-08-01T12:00:00.000Z',
    paidAt: null,
    paymentMethod: null,
    appliedToInvoiceId: null,
    createdAt: null,
    updatedAt: null,
    emailLog: [],
    ...over,
  }) as PersistedInvoice

const data = {
  clients: [
    { id: 'client-shared', name: 'Shared Books LLC', assignedBookkeeperIds: [LISA] },
    { id: 'client-acme', name: 'Acme LLC', assignedBookkeeperIds: [] },
  ],
  employees: [
    { id: OWNER, name: 'Patrice Owner', role: 'Owner' },
    { id: LISA, name: 'Lisa Chen', role: 'Bookkeeper' },
  ],
  checklists: [],
  checklistTemplates: [],
  recycledChecklists: [],
  timeEntries: [],
  inactiveEmployees: [],
  serviceCategories: [],
} as unknown as AppData

let contextValue: AppContextValue

function signInAs(viewerId: string, isOwner: boolean, previewMode = false) {
  contextValue = {
    data,
    role: isOwner ? 'owner' : 'employee',
    ownerMode: isOwner,
    previewMode,
    activeEmployeeId: viewerId,
    sessionUser: {
      id: viewerId,
      name: isOwner ? 'Patrice Owner' : 'Lisa Chen',
      role: isOwner ? 'owner' : 'employee',
    },
    effectiveUser: {
      id: viewerId,
      name: isOwner ? 'Patrice Owner' : 'Lisa Chen',
      role: isOwner ? 'owner' : 'employee',
    },
    billingPeriod: `${THIS_YEAR}-08`,
    firmSettings: { clientDefaults: { hourlyRate: 0 } },
    checklistSkips: [],
    reviewChecklistSkip: vi.fn(),
    skipChecklistOccurrence: vi.fn(),
    toggleChecklistItem: vi.fn(),
    setPreviewUserId: vi.fn(),
    waitingOnMe: [],
  } as unknown as AppContextValue
}

const renderDashboard = () =>
  render(
    <MemoryRouter initialEntries={['/']}>
      <DashboardPage />
    </MemoryRouter>,
  )

const section = () => screen.queryByRole('region', { name: 'Invoices past due' })

beforeEach(() => {
  mockList.mockReset()
  mockList.mockResolvedValue([])
})

describe('scoping', () => {
  it('never renders for a bookkeeper, and asks the server for nothing', async () => {
    mockList.mockResolvedValue([invoice()])
    signInAs(LISA, false)
    renderDashboard()

    await waitFor(() => expect(section()).not.toBeInTheDocument())
    expect(mockList).not.toHaveBeenCalled()
  })

  // Previewing as somebody else must show what THEY see, and they see none of
  // this — the endpoint is owner-only anyway.
  it('never renders while an owner is previewing as a bookkeeper', async () => {
    mockList.mockResolvedValue([invoice()])
    signInAs(LISA, true, true)
    renderDashboard()

    await waitFor(() => expect(section()).not.toBeInTheDocument())
    expect(mockList).not.toHaveBeenCalled()
  })

  it('renders for the owner', async () => {
    mockList.mockResolvedValue([invoice()])
    signInAs(OWNER, true)
    renderDashboard()

    expect(await screen.findByRole('region', { name: 'Invoices past due' })).toBeInTheDocument()
    // No period: past due is a question about every month, not the one on the
    // top bar. And `pastDue` — without it this asked for every invoice the firm
    // has ever written, lines and email logs included, to render these rows.
    expect(mockList).toHaveBeenCalledWith(undefined, { pastDue: true })
  })
})

describe('what the owner sees', () => {
  it('counts them in the heading', async () => {
    mockList.mockResolvedValue([
      invoice(),
      invoice({ id: 'inv-2', number: 'INV-2026-08-032', clientId: 'client-acme' }),
    ])
    signInAs(OWNER, true)
    renderDashboard()

    expect(
      await screen.findByRole('heading', { name: 'Invoices past due (2)' }),
    ).toBeInTheDocument()
  })

  it('names the invoice, the client, when it went out, how late it is and the total', async () => {
    mockList.mockResolvedValue([invoice()])
    signInAs(OWNER, true)
    renderDashboard()

    await screen.findByRole('region', { name: 'Invoices past due' })
    const text = section()?.textContent ?? ''
    expect(text).toContain('INV-2026-08-031')
    expect(text).toContain('Shared Books LLC')
    expect(text).toContain('sent Aug 1')
    expect(text).toContain('40 days past due')
    expect(text).toContain('$400.00')
  })

  // Oldest line first: the money that has been owed longest is the call to make.
  it('lists the oldest due date first', async () => {
    mockList.mockResolvedValue([
      invoice({ id: 'recent', number: 'INV-RECENT', dueDate: dayFromToday(-3) }),
      invoice({ id: 'ancient', number: 'INV-ANCIENT', dueDate: dayFromToday(-90) }),
    ])
    signInAs(OWNER, true)
    renderDashboard()

    await screen.findByRole('region', { name: 'Invoices past due' })
    const text = section()?.textContent ?? ''
    expect(text.indexOf('INV-ANCIENT')).toBeLessThan(text.indexOf('INV-RECENT'))
  })

  it('shows nothing at all when nothing is past due', async () => {
    mockList.mockResolvedValue([
      invoice({ dueDate: dayFromToday(5) }),
      invoice({ id: 'inv-paid', status: 'paid' }),
    ])
    signInAs(OWNER, true)
    renderDashboard()

    await waitFor(() => expect(mockList).toHaveBeenCalled())
    expect(section()).not.toBeInTheDocument()
  })

  // The failure is the more actionable signal and has its own place in the
  // month run; an invoice must not be chased from two lists.
  it('leaves out an invoice whose payment failed', async () => {
    mockList.mockResolvedValue([
      invoice({
        emailLog: [
          { at: '2026-08-01T12:00:00.000Z', to: ['a@b.c'], subject: 's', ok: true },
          { kind: 'payment', event: 'failed', at: '2026-08-20T12:00:00.000Z', paymentIntentId: 'pi_1' },
        ],
      }),
    ])
    signInAs(OWNER, true)
    renderDashboard()

    await waitFor(() => expect(mockList).toHaveBeenCalled())
    expect(section()).not.toBeInTheDocument()
  })

  // The rest of the dashboard is not allowed to go down with it.
  it('renders nothing and does not throw when the fetch fails', async () => {
    mockList.mockRejectedValue(new Error('403'))
    signInAs(OWNER, true)
    renderDashboard()

    await waitFor(() => expect(mockList).toHaveBeenCalled())
    expect(section()).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Recent activity' })).toBeInTheDocument()
  })
})
