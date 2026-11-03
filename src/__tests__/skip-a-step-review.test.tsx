import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardPage } from '../pages/DashboardPage'
import type { AppContextValue } from '../AppContext'
import type { AppData, ChecklistSkip } from '../lib/types'

/**
 * Skip a step (featreq-7e1827e0) on the owner's "Skipped and pushed tasks to
 * review" panel: a step skip's row also says which step it was and who the next
 * step opened for. A whole-cycle skip's row is unchanged.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', () => ({
  fetchGlobalActivity: vi.fn().mockResolvedValue({ entries: [] }),
  fetchRateVersions: vi.fn().mockResolvedValue({ billRateVersions: [], costRateVersions: [] }),
  fetchTeam: vi.fn().mockResolvedValue({ users: [] }),
  fetchTeamActivity: vi.fn().mockResolvedValue({ entries: [] }),
  listInvoicesRequest: vi.fn().mockResolvedValue([]),
}))

const OWNER = 'emp-patrice'
const LISA = 'emp-lisa'
const ALLISON = 'emp-allison'
// The clock is pinned (below) so these August dates are always in the past.
const THIS_YEAR = 2026
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-03T15:00:00.000Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

const skip = (over: Partial<ChecklistSkip>): ChecklistSkip => ({
  id: 'skip-1',
  checklistId: 'cl-s0',
  templateId: 'tmpl-email',
  clientId: 'client-mail',
  title: 'Check email',
  skippedBy: LISA,
  skippedByName: 'Lisa Mockabee',
  skippedAt: `${THIS_YEAR}-08-10T12:00:00.000Z`,
  reasonCategory: 'me',
  reasonNote: 'Out sick today.',
  kind: 'skip',
  newDueDate: null,
  // The record says it was a step skip (decided at skip time).
  stepSkip: true,
  reviewedBy: null,
  reviewedAt: null,
  ...over,
})

const data = {
  clients: [{ id: 'client-mail', name: 'Inbox Holdings', assignedBookkeeperIds: [LISA, ALLISON] }],
  employees: [
    { id: OWNER, name: 'Brittany Owner', role: 'Owner' },
    { id: LISA, name: 'Lisa Mockabee', role: 'Bookkeeper' },
    { id: ALLISON, name: 'Allison Reed', role: 'Bookkeeper' },
  ],
  checklists: [
    {
      id: 'cl-s0',
      title: 'Check email',
      clientId: 'client-mail',
      assigneeId: LISA,
      templateId: 'tmpl-email',
      dueDate: `${THIS_YEAR}-08-31`,
      caseId: 'case-mail',
      stageIndex: 0,
      stageCount: 3,
      skippedAt: `${THIS_YEAR}-08-10T12:00:00.000Z`,
      skippedBy: LISA,
      viewerIds: [],
      editorIds: [],
      items: [{ id: 'i-0', label: 'Clear', done: false }],
    },
    {
      id: 'cl-s1',
      title: 'Check email',
      clientId: 'client-mail',
      assigneeId: ALLISON,
      templateId: 'tmpl-email',
      dueDate: `${THIS_YEAR}-08-31`,
      caseId: 'case-mail',
      stageIndex: 1,
      stageCount: 3,
      viewerIds: [],
      editorIds: [],
      items: [{ id: 'i-1', label: 'Review', done: false }],
      skipNotice: {
        skippedBy: LISA,
        skippedByName: 'Lisa Mockabee',
        stageIndex: 0,
        stageName: 'Clear',
        reasonCategory: 'me',
        note: 'Out sick today.',
        at: `${THIS_YEAR}-08-10T12:00:00.000Z`,
        skipId: 'skip-1',
      },
    },
  ],
  checklistTemplates: [],
  recycledChecklists: [],
  timeEntries: [],
  inactiveEmployees: [],
  serviceCategories: [],
} as unknown as AppData

let contextValue: AppContextValue

function signInAsOwner(skips: ChecklistSkip[]) {
  contextValue = {
    data,
    role: 'owner',
    ownerMode: true,
    previewMode: false,
    activeEmployeeId: OWNER,
    sessionUser: { id: OWNER, name: 'Brittany Owner', role: 'owner' },
    effectiveUser: { id: OWNER, name: 'Brittany Owner', role: 'owner' },
    billingPeriod: `${THIS_YEAR}-08`,
    firmSettings: { clientDefaults: { hourlyRate: 0 } },
    checklistSkips: skips,
    reviewChecklistSkip: vi.fn().mockResolvedValue(undefined),
    skipChecklistOccurrence: vi.fn(),
    toggleChecklistItem: vi.fn(),
    setPreviewUserId: vi.fn(),
    waitingOnMe: [],
  } as unknown as AppContextValue
}

const section = () => screen.getByRole('region', { name: 'Skipped and pushed tasks to review' })

describe('the review panel', () => {
  it('a record that was NOT a step skip never says next step opened, even if a row carries its id', () => {
    signInAsOwner([skip({ stepSkip: false })])
    render(
      <MemoryRouter initialEntries={['/']}>
        <DashboardPage />
      </MemoryRouter>,
    )
    expect(section().textContent).not.toContain('next step opened for')
  })

  it('a step skip names the step and who the next step opened for', () => {
    signInAsOwner([skip({})])
    render(
      <MemoryRouter initialEntries={['/']}>
        <DashboardPage />
      </MemoryRouter>,
    )
    expect(section().textContent).toContain('Step 1 of 3 - next step opened for Allison Reed')
  })

  it('a whole-cycle skip says nothing more than before', () => {
    signInAsOwner([skip({ id: 'skip-whole', checklistId: 'cl-other', stepSkip: false })])
    render(
      <MemoryRouter initialEntries={['/']}>
        <DashboardPage />
      </MemoryRouter>,
    )
    expect(section().textContent).not.toContain('next step opened for')
  })
})
