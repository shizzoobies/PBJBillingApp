import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TeamPage } from '../pages/TeamPage'
import type { AppContextValue } from '../AppContext'
import type { AppData, Client, TeamMember } from '../lib/types'

/**
 * The Team page's "Assigned clients" control — reworked 2026-09-22 so an owner
 * can rebuild a person's team without hunting for it.
 *
 * Three things are pinned here, and all three exist because of the 2026-09-04
 * team/visibility split. `assignedBookkeeperIds` is the EXPLICIT team and the
 * MONEY gate: it is what puts a client's invoices on that person's Invoice
 * Recap. The reset that came with the split left 13 of 55 clients with no team
 * at all, so re-picking them is the job:
 *
 *   1. the control LEADS the expanded panel, under the person's name, instead
 *      of sitting below the rates, the actions and the session list;
 *   2. "Suggested" offers the clients they already hold live work on
 *      (`taskClientIdsForUser`) — a SUGGESTION an owner accepts by clicking,
 *      never an automatic backfill, because writing computed visibility into
 *      the team is the leak the split closed;
 *   3. the add menu stays open across picks — one click per client.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))

vi.mock('../lib/api', () => ({
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
}))

import { setClientAssignedTeamRequest } from '../lib/api'

const LISA = 'emp-lisa'
const OTHER = 'emp-other'

const client = (over: Partial<Client>): Client =>
  ({ assignedBookkeeperIds: [], ...over }) as Client

/** On the team already, and she holds work on it — so it is never "suggested". */
const ON_TEAM = client({
  id: 'client-acme',
  name: 'Acme Books',
  assignedBookkeeperIds: [LISA],
})
/** Work via a live checklist, nobody on the team. */
const BETA = client({ id: 'client-beta', name: 'Beta Corp' })
/** Work via a recurring template's STAGE, someone else already on the team. */
const CHEMTREX = client({
  id: 'client-chem',
  name: 'Chemtrex',
  assignedBookkeeperIds: [OTHER],
})
/** No work of hers at all — addable from the menu, never suggested. */
const DELTA = client({ id: 'client-delta', name: 'Delta LLC' })
/** Work on a RETIRED client — `selectableClients` keeps it out of both lists. */
const RETIRED = client({ id: 'client-zeta', name: 'Zeta Retired', lifecycleStage: 'inactive' })

const members: TeamMember[] = [
  {
    id: LISA,
    name: 'Lisa Mockabee',
    email: 'lisa@example.com',
    role: 'employee',
    staffRole: 'Bookkeeper',
    tokenRevokedAt: null,
    lastActiveAt: null,
    createdAt: null,
    totpEnabled: false,
  } as TeamMember,
]

const data = {
  clients: [ON_TEAM, BETA, CHEMTREX, DELTA, RETIRED],
  employees: [{ id: LISA, name: 'Lisa Mockabee', role: 'Bookkeeper' }],
  checklists: [
    { id: 'cl-acme', clientId: ON_TEAM.id, assigneeId: LISA },
    { id: 'cl-beta', clientId: BETA.id, assigneeId: LISA },
    { id: 'cl-zeta', clientId: RETIRED.id, assigneeId: LISA },
    { id: 'cl-delta', clientId: DELTA.id, assigneeId: OTHER },
  ],
  checklistTemplates: [
    { id: 'tpl-chem', clientId: CHEMTREX.id, assigneeId: OTHER, stages: [{ assigneeId: LISA }] },
  ],
  timeEntries: [],
} as unknown as AppData

let contextValue: AppContextValue
let updateClient: ReturnType<typeof vi.fn>

function mountTeamPage(workspace: AppData = data) {
  updateClient = vi.fn()
  contextValue = {
    data: workspace,
    ownerMode: true,
    deleteTeamMember: vi.fn(),
    setPreviewUserId: vi.fn(),
    updateClient,
  } as unknown as AppContextValue
  return render(
    <MemoryRouter>
      <TeamPage />
    </MemoryRouter>,
  )
}

/** The panel only renders once the roster loads and the card is opened. */
async function expandLisa() {
  // By class, not by name: the reorder arrows carry her name too.
  const header = await waitFor(() => {
    const node = document.querySelector('.team-card-header')
    expect(node).not.toBeNull()
    return node as HTMLElement
  })
  fireEvent.click(header)
  await waitFor(() => expect(screen.getByText('Assigned clients')).toBeInTheDocument())
}

beforeEach(() => {
  vi.mocked(setClientAssignedTeamRequest).mockClear()
})

describe('placement', () => {
  it('puts Assigned clients first in the panel, above the 2FA line', async () => {
    const { container } = mountTeamPage()
    await expandLisa()

    const body = container.querySelector('.team-card-body')
    expect(body).not.toBeNull()
    expect(body?.firstElementChild?.classList.contains('team-assigned-clients')).toBe(true)

    const heading = screen.getByText('Assigned clients')
    const twoFactor = screen.getByText('2FA:')
    // Node.DOCUMENT_POSITION_FOLLOWING — the 2FA line comes AFTER the heading.
    expect(heading.compareDocumentPosition(twoFactor) & 4).toBeTruthy()
  })

  it('names the money it gates', async () => {
    mountTeamPage()
    await expandLisa()
    expect(screen.getByText(/whose invoices they get on the Invoice Recap/i)).toBeInTheDocument()
  })
})

describe('suggestions', () => {
  it('offers exactly the work-derived clients she is not already teamed on', async () => {
    mountTeamPage()
    await expandLisa()

    const suggested = screen.getByText(/currently has work on/).closest('div')
    expect(suggested).not.toBeNull()
    const panel = within(suggested as HTMLElement)
    // A checklist and a template STAGE both count, alphabetically.
    expect(panel.getByRole('button', { name: '+ Beta Corp' })).toBeInTheDocument()
    expect(panel.getByRole('button', { name: '+ Chemtrex' })).toBeInTheDocument()
    // Already on the team, so there is nothing to suggest about it.
    expect(panel.queryByRole('button', { name: '+ Acme Books' })).toBeNull()
    // No work of hers.
    expect(panel.queryByRole('button', { name: '+ Delta LLC' })).toBeNull()
    // Retired: nobody gets newly assigned to one.
    expect(panel.queryByRole('button', { name: '+ Zeta Retired' })).toBeNull()
    expect(screen.getByText(/The 2 clients Lisa currently has work on/)).toBeInTheDocument()
  })

  it('adds one suggested client per click, preserving who is already on it', async () => {
    mountTeamPage()
    await expandLisa()

    fireEvent.click(screen.getByRole('button', { name: '+ Chemtrex' }))
    expect(updateClient).toHaveBeenCalledWith(CHEMTREX.id, {
      assignedBookkeeperIds: [OTHER, LISA],
    })
    expect(setClientAssignedTeamRequest).toHaveBeenCalledTimes(1)
    expect(setClientAssignedTeamRequest).toHaveBeenCalledWith(CHEMTREX.id, [OTHER, LISA])
  })

  it('"Add all" saves once per suggested client and says how many landed', async () => {
    mountTeamPage()
    await expandLisa()

    fireEvent.click(screen.getByRole('button', { name: 'Add all 2' }))

    expect(setClientAssignedTeamRequest).toHaveBeenCalledTimes(2)
    expect(setClientAssignedTeamRequest).toHaveBeenNthCalledWith(1, BETA.id, [LISA])
    expect(setClientAssignedTeamRequest).toHaveBeenNthCalledWith(2, CHEMTREX.id, [OTHER, LISA])
    expect(updateClient).toHaveBeenCalledTimes(2)
    expect(updateClient).toHaveBeenNthCalledWith(1, BETA.id, { assignedBookkeeperIds: [LISA] })
    expect(updateClient).toHaveBeenNthCalledWith(2, CHEMTREX.id, {
      assignedBookkeeperIds: [OTHER, LISA],
    })
    expect(screen.getByText('Added 2 clients.')).toBeInTheDocument()
  })

  it('shows no Suggested block when she holds no work off her team', async () => {
    mountTeamPage({
      ...data,
      clients: [ON_TEAM, DELTA],
      checklists: [{ id: 'cl-acme', clientId: ON_TEAM.id, assigneeId: LISA }],
      checklistTemplates: [],
    } as unknown as AppData)
    await expandLisa()

    expect(screen.queryByText(/currently has work on/)).toBeNull()
    expect(screen.queryByRole('button', { name: /^Add all/ })).toBeNull()
    // The ordinary add menu is still there — only the shortcut is absent.
    expect(screen.getByRole('button', { name: '+ Add client' })).toBeInTheDocument()
  })
})

describe('the add menu', () => {
  it('stays open after a pick, so a dozen clients cost a dozen clicks', async () => {
    mountTeamPage()
    await expandLisa()

    fireEvent.click(screen.getByRole('button', { name: '+ Add client' }))
    const menu = screen.getByRole('menu')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delta LLC' }))

    expect(setClientAssignedTeamRequest).toHaveBeenCalledWith(DELTA.id, [LISA])
    expect(screen.getByRole('menu')).toBeInTheDocument()

    // A second pick without re-opening anything.
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Beta Corp' }))
    expect(setClientAssignedTeamRequest).toHaveBeenCalledWith(BETA.id, [LISA])
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('still closes on Escape and on the pill', async () => {
    mountTeamPage()
    await expandLisa()

    fireEvent.click(screen.getByRole('button', { name: '+ Add client' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: '+ Add client' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '+ Add client' }))
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
