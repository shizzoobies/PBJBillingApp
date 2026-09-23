import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TeamPage } from '../pages/TeamPage'
import type { AppContextValue } from '../AppContext'
import { ApiError, type AppData, type TeamMember } from '../lib/types'

/**
 * The Team page's rate boxes, once a rate stopped being a single number and
 * became a DATED SERIES (spec §2.1, §2.3).
 *
 * The five things pinned here are the whole contract of the change:
 *
 *   1. the Bill rate box carries an effective-from MONTH, defaulting to this
 *      month, so the common edit — a raise starting now — is still one number
 *      and one press;
 *   2. a save goes through the version endpoint, never the old set-rate call,
 *      because the old one overwrote history instead of appending to it;
 *   3. the history lists prior versions oldest-first and offers Remove on the
 *      NEWEST row only — the server refuses anything else, so the page should
 *      not draw a button that cannot work;
 *   4. when the server does refuse, its SENTENCE is what the owner reads (it
 *      names the pinned client she has to move first);
 *   5. the Cost rate box is the same idea a day at a time, defaulting to today.
 *
 * `fireEvent`, not `userEvent`: the project does not carry
 * `@testing-library/user-event`, and the sibling Team page suite drives the
 * page the same way.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))

vi.mock('../lib/api', () => ({
  deleteBillRateVersion: vi.fn(),
  deleteCostRateVersion: vi.fn(),
  fetchRateVersions: vi.fn(),
  fetchTeam: vi.fn(async () => ({ users: members })),
  fetchTeamActivity: vi.fn(async () => ({ entries: [] })),
  fetchTeamSessions: vi.fn(async () => ({ sessions: [] })),
  inviteTeamMember: vi.fn(),
  reorderTeamMembersRequest: vi.fn(),
  resendTeamSignInLink: vi.fn(),
  revokeAllTeamSessions: vi.fn(),
  revokeTeamSession: vi.fn(),
  setClientAssignedTeamRequest: vi.fn(async () => ({ ok: true })),
  setTeamMemberBillRate: vi.fn(),
  setTeamMemberCostRate: vi.fn(),
  teamTotpReset: vi.fn(),
  upsertBillRateVersion: vi.fn(),
  upsertCostRateVersion: vi.fn(),
}))

import {
  deleteBillRateVersion,
  fetchRateVersions,
  setTeamMemberBillRate,
  upsertBillRateVersion,
} from '../lib/api'

const LISA = 'emp-lisa'

/** The server hands every person's versions back OLDEST-FIRST. */
const BILL_VERSIONS = [
  { userId: LISA, effectivePeriod: '2026-06', rate: 40 },
  { userId: LISA, effectivePeriod: '2026-09', rate: 55 },
]
const COST_VERSIONS = [{ userId: LISA, effectiveDate: '1970-01-01', rate: 20 }]

const members: TeamMember[] = [
  {
    id: LISA,
    name: 'Lisa Mockabee',
    email: 'lisa@example.com',
    role: 'employee',
    staffRole: 'Bookkeeper',
    billRate: 55,
    costRate: 20,
    tokenRevokedAt: null,
    lastActiveAt: null,
    createdAt: null,
    totpEnabled: false,
  } as TeamMember,
]

const data = {
  clients: [],
  employees: [{ id: LISA, name: 'Lisa Mockabee', role: 'Bookkeeper' }],
  checklists: [],
  checklistTemplates: [],
  timeEntries: [],
} as unknown as AppData

let contextValue: AppContextValue

/** Mount the page as an owner and open Lisa's card. */
async function renderTeamPage() {
  contextValue = {
    data,
    ownerMode: true,
    deleteTeamMember: vi.fn(),
    setPreviewUserId: vi.fn(),
    updateClient: vi.fn(),
  } as unknown as AppContextValue
  const view = render(
    <MemoryRouter>
      <TeamPage />
    </MemoryRouter>,
  )
  // By class, not by name: the reorder arrows carry her name too.
  const header = await waitFor(() => {
    const node = document.querySelector('.team-card-header')
    expect(node).not.toBeNull()
    return node as HTMLElement
  })
  fireEvent.click(header)
  await waitFor(() => expect(screen.getByText('Bill rate')).toBeInTheDocument())
  // The history arrives on its own fetch, after the roster.
  await waitFor(() => expect(fetchRateVersions).toHaveBeenCalled())
  return view
}

const billInput = () => screen.getByLabelText(/Bill rate/) as HTMLInputElement
const monthInput = () =>
  screen.getByLabelText(/Effective from/i, {
    selector: 'input[type="month"]',
  }) as HTMLInputElement
const dateInput = () =>
  screen.getByLabelText(/Effective from/i, {
    selector: 'input[type="date"]',
  }) as HTMLInputElement
/**
 * The bill box leads the cost box, so its disclosure is the first one. Scoped
 * by container rather than by name because the card's own actions carry a
 * "Remove" button too — removing the person, not a rate.
 */
const billHistory = () => document.querySelectorAll('.team-rate-history')[0] as HTMLElement
const openBillHistory = async () => {
  fireEvent.click(within(billHistory()).getByRole('button', { name: /Rate history/i }))
  await waitFor(() => expect(screen.getByText('2026-06')).toBeInTheDocument())
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(fetchRateVersions).mockResolvedValue({
    billRateVersions: [...BILL_VERSIONS],
    costRateVersions: [...COST_VERSIONS],
  })
  vi.mocked(upsertBillRateVersion).mockResolvedValue({
    ok: true,
    userId: LISA,
    versions: [...BILL_VERSIONS],
  })
  vi.mocked(deleteBillRateVersion).mockResolvedValue({
    ok: true,
    userId: LISA,
    versions: [BILL_VERSIONS[0]],
  })
})

describe('Team page rate history', () => {
  it('defaults the bill rate’s effective-from to the current month', async () => {
    await renderTeamPage()
    expect(monthInput()).toHaveValue(new Date().toISOString().slice(0, 7))
  })

  it('saves the rate through the version endpoint, not the old one', async () => {
    await renderTeamPage()
    fireEvent.change(billInput(), { target: { value: '60' } })
    fireEvent.change(monthInput(), { target: { value: '2026-10' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0])

    await waitFor(() =>
      expect(upsertBillRateVersion).toHaveBeenCalledWith(LISA, '2026-10', 60),
    )
    expect(setTeamMemberBillRate).not.toHaveBeenCalled()
  })

  it('lists prior versions and offers Remove on the NEWEST only', async () => {
    await renderTeamPage()
    await openBillHistory()

    expect(screen.getByText('2026-06')).toBeInTheDocument()
    expect(screen.getByText('2026-09')).toBeInTheDocument()
    // One Remove button across both rows — the newest.
    const removes = within(billHistory()).getAllByRole('button', { name: /Remove/i })
    expect(removes).toHaveLength(1)
    fireEvent.click(removes[0])
    await waitFor(() => expect(deleteBillRateVersion).toHaveBeenCalledWith(LISA, '2026-09'))
  })

  it('prints the server’s sentence when a removal is refused', async () => {
    vi.mocked(deleteBillRateVersion).mockRejectedValueOnce(
      new ApiError(
        409,
        'A client is pinned at or after this month, so it is still billing at this rate. Move that client first.',
      ),
    )
    await renderTeamPage()
    await openBillHistory()
    fireEvent.click(within(billHistory()).getByRole('button', { name: /Remove/i }))
    expect(await screen.findByText(/Move that client first/)).toBeInTheDocument()
  })

  it('defaults the cost rate’s effective-from to today', async () => {
    await renderTeamPage()
    expect(dateInput()).toHaveValue(new Date().toISOString().slice(0, 10))
  })
})
