import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardPage } from '../pages/DashboardPage'
import { nextStageNeverOpened, stalledCaseStages } from '../lib/stalledCase'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist } from '../lib/types'

/**
 * featreq-ed73d181: a case whose step is finished but whose next step never
 * opened has no open row anywhere (I-95 case-8b17c9df). The Dashboard lists it
 * under its stuck cases, "Finished, next step never opened", linking to the card
 * where Open next step now sits - in the owner view and in the staff view.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', () => ({
  fetchGlobalActivity: vi.fn().mockResolvedValue({ entries: [] }),
  fetchRateVersions: vi.fn().mockResolvedValue({ billRateVersions: [], costRateVersions: [] }),
  fetchTeam: vi.fn().mockResolvedValue({ users: [] }),
  fetchTeamActivity: vi.fn().mockResolvedValue({ entries: [] }),
  listInvoicesRequest: vi.fn().mockResolvedValue([]),
}))

const LISA = 'emp-lisa'
const BRITT = 'emp-brit'
const LABEL = 'Finished, next step never opened'

const stage = (over: Partial<Checklist>): Checklist =>
  ({
    clientId: 'client-acme',
    assigneeId: LISA,
    templateId: 'tmpl-q',
    dueDate: '2026-10-05',
    stageIndex: 0,
    stageCount: 3,
    viewerIds: [],
    editorIds: [],
    // Created just now, so the inactivity rule never counts a row as stuck:
    // only the never-opened rule can.
    createdAt: new Date().toISOString(),
    items: [{ id: `${over.id}-1`, label: 'TD Bank 7765', done: true }],
    ...over,
  }) as Checklist

const STALLED = stage({ id: 'cl-stalled', title: 'Quarterly stalled', caseId: 'case-stalled' })
const HANDED = stage({ id: 'cl-handed', title: 'Quarterly handed', caseId: 'case-handed' })
const HANDED_NEXT = stage({
  id: 'cl-handed-next',
  title: 'Quarterly handed review',
  caseId: 'case-handed',
  stageIndex: 1,
  items: [{ id: 'hn-1', label: 'Reconcile', done: false }],
})
const LAST = stage({ id: 'cl-last', title: 'Quarterly last', caseId: 'case-last', stageIndex: 2 })
const OPEN = stage({
  id: 'cl-open',
  title: 'Quarterly open',
  caseId: 'case-open',
  items: [{ id: 'op-1', label: 'Gather', done: false }],
})
const BEHIND_LATER = stage({ id: 'cl-behind', title: 'Quarterly behind', caseId: 'case-behind' })
const LATER = stage({ id: 'cl-later', title: 'Quarterly later', caseId: 'case-behind', stageIndex: 2, items: [] })
const BRITTS = stage({ id: 'cl-britts', title: 'Quarterly Britts', caseId: 'case-britts', assigneeId: BRITT })

const ALL = [STALLED, HANDED, HANDED_NEXT, LAST, OPEN, BEHIND_LATER, LATER, BRITTS]

describe('nextStageNeverOpened / stalledCaseStages', () => {
  it('is true only for a finished, non-last stage with no later live stage', () => {
    expect(nextStageNeverOpened(STALLED, ALL)).toBe(true)
    expect(nextStageNeverOpened(HANDED, ALL)).toBe(false)
    expect(nextStageNeverOpened(LAST, ALL)).toBe(false)
    expect(nextStageNeverOpened(OPEN, ALL)).toBe(false)
    expect(nextStageNeverOpened(BEHIND_LATER, ALL)).toBe(false)
  })

  it('reads done through the roll-up, and never a skipped, pushed, onboarding or untemplated row', () => {
    const subDone = stage({
      id: 'cl-sub',
      caseId: 'case-sub',
      items: [{ id: 's', label: 'x', done: false, subItems: [{ id: 'ss', title: 'y', done: true }] }],
    } as unknown as Partial<Checklist>)
    expect(nextStageNeverOpened(subDone, [subDone])).toBe(true)
    for (const over of [
      { skippedAt: '2026-10-07T00:00:00.000Z' },
      { pushedToChecklistId: 'cl-x' },
      { onboardingForClientId: 'client-acme' },
      { templateId: undefined },
    ]) {
      const row = { ...STALLED, ...over } as Checklist
      expect(nextStageNeverOpened(row, [row])).toBe(false)
    }
  })

  it('lists the stalled stages, soonest due first', () => {
    expect(stalledCaseStages(ALL).map((row) => row.id)).toEqual(['cl-stalled', 'cl-britts'])
  })
})

let contextValue: AppContextValue

function signIn(viewer: 'staff' | 'owner') {
  const owner = viewer === 'owner'
  const data = {
    clients: [{ id: 'client-acme', name: 'Acme LLC', assignedBookkeeperIds: [LISA] }],
    employees: [
      { id: LISA, name: 'Lisa Chen', role: 'Bookkeeper' },
      { id: BRITT, name: 'Brittany Fox', role: 'Owner' },
    ],
    checklists: ALL,
    checklistTemplates: [],
    recycledChecklists: [],
    timeEntries: [],
    inactiveEmployees: [],
    serviceCategories: [],
  } as unknown as AppData
  contextValue = {
    data,
    role: owner ? 'owner' : 'employee',
    ownerMode: owner,
    previewMode: false,
    activeEmployeeId: owner ? BRITT : LISA,
    sessionUser: owner
      ? { id: BRITT, name: 'Brittany Fox', role: 'owner' }
      : { id: LISA, name: 'Lisa Chen', role: 'employee' },
    effectiveUser: owner
      ? { id: BRITT, name: 'Brittany Fox', role: 'owner' }
      : { id: LISA, name: 'Lisa Chen', role: 'employee' },
    billingPeriod: '2026-10',
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

const rowFor = (title: string) => screen.getByText(title).closest('li') as HTMLElement
const stuckCount = () => {
  const label = screen.getAllByText(/^Stuck( cases)?$/).find((element) => element.closest('.alert-card'))
  return label?.closest('.alert-card')?.querySelector('strong')?.textContent
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the Dashboard lists a case whose next step never opened', () => {
  it('owner: every stalled case, labeled, linking to its card, and counted as stuck', () => {
    signIn('owner')
    renderDashboard()
    for (const [title, id] of [
      ['Quarterly stalled', 'cl-stalled'],
      ['Quarterly Britts', 'cl-britts'],
    ]) {
      const row = rowFor(title)
      expect(within(row).getByText(LABEL)).not.toBeNull()
      expect(within(row).getByRole('link').getAttribute('href')).toBe(`/checklists?focus=${id}`)
    }
    expect(screen.queryByText('Quarterly handed')).toBeNull()
    expect(screen.queryByText('Quarterly last')).toBeNull()
    expect(screen.queryByText('Quarterly behind')).toBeNull()
    expect(screen.getAllByText(LABEL)).toHaveLength(2)
    expect(stuckCount()).toBe('2')
  })

  it("staff: their own stalled case, labeled, linking to its card, counted as stuck; not someone else's", () => {
    signIn('staff')
    renderDashboard()
    const row = rowFor('Quarterly stalled')
    expect(within(row).getByText(LABEL)).not.toBeNull()
    expect(within(row).getByRole('link').getAttribute('href')).toBe('/checklists?focus=cl-stalled')
    expect(screen.queryByText('Quarterly Britts')).toBeNull()
    expect(screen.getAllByText(LABEL)).toHaveLength(1)
    expect(stuckCount()).toBe('1')
  })
})
