import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { DashboardPage } from '../pages/DashboardPage'
import type { AppContextValue } from '../AppContext'
import type { AppData, ChecklistSkip } from '../lib/types'

/**
 * The owner's skip-review section on the dashboard.
 *
 * Two things matter here and they pull in opposite directions: it must be
 * owner-only (a bookkeeper has no business reading the firm's skips), and
 * "Reviewed" must clear the row from the dashboard WITHOUT destroying it — the
 * records are an audit trail, like the completed-tasks history.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', () => ({
  // Shaped like the real responses: the owner view reads `.entries` off these
  // two, and an array would hand React `Array.prototype.entries` as a state
  // updater and take the whole view down.
  fetchGlobalActivity: vi.fn().mockResolvedValue({ entries: [] }),
  fetchRateVersions: vi.fn().mockResolvedValue({ billRateVersions: [], costRateVersions: [] }),
  fetchTeam: vi.fn().mockResolvedValue({ users: [] }),
  fetchTeamActivity: vi.fn().mockResolvedValue({ entries: [] }),
  // The owner dashboard also asks for the past-due invoices; that section has
  // its own suite (dashboard-past-due.test.tsx) and simply renders nothing here.
  listInvoicesRequest: vi.fn().mockResolvedValue([]),
}))

const OWNER = 'emp-patrice'
const LISA = 'emp-lisa'
const THIS_YEAR = new Date().getFullYear()

const skip = (over: Partial<ChecklistSkip>): ChecklistSkip => ({
  id: 'skip-1',
  checklistId: 'cl-1',
  templateId: 'tmpl-1',
  clientId: 'client-shared',
  title: 'Monthly close',
  skippedBy: LISA,
  skippedByName: 'Lisa Chen',
  skippedAt: `${THIS_YEAR}-08-10T12:00:00.000Z`,
  reasonCategory: 'client',
  reasonNote: 'Statements never arrived from the client.',
  kind: 'skip',
  newDueDate: null,
  reviewedBy: null,
  reviewedAt: null,
  ...over,
})

const data = {
  clients: [{ id: 'client-shared', name: 'Shared Books LLC', assignedBookkeeperIds: [LISA] }],
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
let reviewChecklistSkip: ReturnType<typeof vi.fn>

function signInAs(viewerId: string, isOwner: boolean, skips: ChecklistSkip[]) {
  reviewChecklistSkip = vi.fn().mockResolvedValue(undefined)
  contextValue = {
    data,
    role: isOwner ? 'owner' : 'employee',
    ownerMode: isOwner,
    previewMode: false,
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
    checklistSkips: skips,
    reviewChecklistSkip,
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

const section = () =>
  screen.queryByRole('region', { name: 'Skipped and pushed tasks to review' })

describe('scoping', () => {
  it('never renders for a bookkeeper', () => {
    // Even if the array somehow arrived populated, the role check refuses it —
    // and in practice the endpoint 403s so it is empty anyway.
    signInAs(LISA, false, [skip({})])
    renderDashboard()
    expect(section()).not.toBeInTheDocument()
    expect(screen.queryByText('Monthly close')).not.toBeInTheDocument()
  })

  it('renders for the owner', () => {
    signInAs(OWNER, true, [skip({})])
    renderDashboard()
    expect(section()).toBeInTheDocument()
  })
})

describe('what the owner sees', () => {
  it('names the task, the client, who skipped it, the category and the explanation', () => {
    signInAs(OWNER, true, [skip({})])
    renderDashboard()
    const text = section()?.textContent ?? ''

    expect(text).toContain('Monthly close')
    expect(text).toContain('Shared Books LLC')
    expect(text).toContain('Lisa Chen')
    expect(text).toContain('The client')
    expect(text).toContain('Statements never arrived from the client.')
  })

  it('counts them so it reads at a glance', () => {
    signInAs(OWNER, true, [skip({ id: 'a' }), skip({ id: 'b' })])
    renderDashboard()
    expect(
      screen.getByRole('heading', { name: 'Skipped and pushed tasks to review (2)' }),
    ).toBeInTheDocument()
  })

  it('lists newest first', () => {
    signInAs(OWNER, true, [
      skip({ id: 'old', title: 'Older skip', skippedAt: `${THIS_YEAR}-01-05T12:00:00.000Z` }),
      skip({ id: 'new', title: 'Newer skip', skippedAt: `${THIS_YEAR}-08-05T12:00:00.000Z` }),
    ])
    renderDashboard()
    const text = section()?.textContent ?? ''
    expect(text.indexOf('Newer skip')).toBeLessThan(text.indexOf('Older skip'))
  })

  it('hides a skip that has already been reviewed', () => {
    signInAs(OWNER, true, [
      skip({ id: 'handled', reviewedAt: `${THIS_YEAR}-08-12T09:00:00.000Z`, reviewedBy: OWNER }),
    ])
    renderDashboard()
    // The record still exists in the context — it is simply not on the
    // dashboard any more. Nothing was deleted.
    expect(section()).not.toBeInTheDocument()
    expect(contextValue.checklistSkips).toHaveLength(1)
  })

  it('shows nothing at all when there is nothing to review', () => {
    signInAs(OWNER, true, [])
    renderDashboard()
    expect(section()).not.toBeInTheDocument()
  })
})

describe('reviewing', () => {
  it('sends the review and never a delete', async () => {
    signInAs(OWNER, true, [skip({ id: 'skip-42' })])
    renderDashboard()

    fireEvent.click(screen.getByRole('button', { name: 'Reviewed' }))
    await waitFor(() => expect(reviewChecklistSkip).toHaveBeenCalledWith('skip-42'))
  })
})

/**
 * Pushes land on the SAME queue (featreq-68638ed2). They are one question to
 * the owner — "this recurring task did not happen as scheduled, here is who and
 * why" — so they share the section, the sort and the Reviewed button. The only
 * difference she should see is what happened to the task.
 */
describe('a pushed task on the same queue', () => {
  const push = (over: Partial<ChecklistSkip> = {}) =>
    skip({
      id: 'push-1',
      kind: 'push',
      newDueDate: `${THIS_YEAR}-10-31`,
      reasonNote: 'Client is closing their old bank account first.',
      ...over,
    })

  it('says where the task went, where a skip just says it was skipped', () => {
    signInAs(OWNER, true, [push()])
    renderDashboard()
    const text = section()?.textContent ?? ''

    expect(text).toContain(`Pushed to Oct 31, ${THIS_YEAR}`)
    expect(text).not.toContain('Skipped ·')
  })

  it('still names the task, the client, the person and the reason', () => {
    signInAs(OWNER, true, [push()])
    renderDashboard()
    const text = section()?.textContent ?? ''

    expect(text).toContain('Monthly close')
    expect(text).toContain('Shared Books LLC')
    expect(text).toContain('Lisa Chen')
    expect(text).toContain('The client')
    expect(text).toContain('Client is closing their old bank account first.')
  })

  it('counts alongside skips under one heading', () => {
    signInAs(OWNER, true, [skip({ id: 'a' }), push({ id: 'b' })])
    renderDashboard()
    expect(
      screen.getByRole('heading', { name: 'Skipped and pushed tasks to review (2)' }),
    ).toBeInTheDocument()
  })

  it('is cleared by the same Reviewed button', async () => {
    signInAs(OWNER, true, [push({ id: 'push-42' })])
    renderDashboard()

    fireEvent.click(screen.getByRole('button', { name: 'Reviewed' }))
    await waitFor(() => expect(reviewChecklistSkip).toHaveBeenCalledWith('push-42'))
  })
})
