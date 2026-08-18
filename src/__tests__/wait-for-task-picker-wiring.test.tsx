import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChecklistsPage } from '../pages/ChecklistsPage'
import { checklistsVisibleTo } from '../lib/checklistVisibility'
import { isChecklistSkipped } from '../../lib/checklist-skip.js'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist, Client } from '../lib/types'

/**
 * The waiting-for-a-task picker, wired through the real page (featreq-5dd514b8).
 *
 * `src/lib/waitForTaskOptions.ts` is unit-tested on its own; what only a page
 * render can catch is the hand-off, because the picker is mounted TWICE — once
 * on a step and once on a sub-step — and each must pass ITS OWN saved link. A
 * copy-paste slip there (the sub-step handing over the parent item's link) type
 * checks perfectly and silently shows the wrong task. So the fixture gives the
 * step and the sub-step DIFFERENT cross-client links, which no slip can satisfy.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))

const OWNER = 'emp-patrice'

const ACME: Client = { id: 'client-acme', name: 'Acme Dental' } as Client
const GLOBEX: Client = { id: 'client-globex', name: 'Globex Freight' } as Client

const checklist = (over: Partial<Checklist>): Checklist =>
  ({
    clientId: ACME.id,
    assigneeId: OWNER,
    dueDate: '2026-08-31',
    viewerIds: [],
    editorIds: [],
    items: [],
    ...over,
  }) as Checklist

const GLOBEX_CLOSE = checklist({
  id: 'cl-globex-1',
  title: 'Globex close',
  clientId: GLOBEX.id,
})
const GLOBEX_PAYROLL = checklist({
  id: 'cl-globex-2',
  title: 'Globex payroll',
  clientId: GLOBEX.id,
})
const ACME_BANK_REC = checklist({ id: 'cl-acme-2', title: 'Acme bank rec' })
const ACME_SKIPPED = checklist({
  id: 'cl-acme-3',
  title: 'Acme skipped close',
  skippedAt: '2026-08-13T12:00:00.000Z',
  skippedBy: OWNER,
})

/** The task under edit: a waiting STEP and a waiting SUB-STEP, linked apart. */
const ACME_PAYROLL = checklist({
  id: 'cl-acme-1',
  title: 'Acme payroll',
  items: [
    {
      id: 'i1',
      label: 'Step with its own link',
      done: false,
      waiting: true,
      waitingForChecklistId: GLOBEX_CLOSE.id,
    },
    {
      id: 'i2',
      label: 'Step that is not waiting',
      done: false,
      subItems: [
        {
          id: 's1',
          title: 'Sub-step with a different link',
          done: false,
          waiting: true,
          waitingForChecklistId: GLOBEX_PAYROLL.id,
        },
      ],
    },
  ],
})

const data = {
  clients: [ACME, GLOBEX],
  employees: [{ id: OWNER, name: 'Patrice Owner', role: 'Owner' }],
  checklists: [ACME_PAYROLL, ACME_BANK_REC, ACME_SKIPPED, GLOBEX_CLOSE, GLOBEX_PAYROLL],
  checklistTemplates: [],
  recycledChecklists: [],
  timeEntries: [],
  serviceCategories: [],
} as unknown as AppData

let contextValue: AppContextValue

function signIn() {
  // Exactly what App.tsx does to build `visibleChecklists`.
  const active = data.checklists.filter((entry) => !isChecklistSkipped(entry))
  contextValue = {
    data,
    ownerMode: true,
    role: 'owner',
    dataSyncState: 'idle',
    activeEmployeeId: OWNER,
    effectiveUser: { id: OWNER, role: 'owner' },
    sessionUser: { id: OWNER, role: 'owner' },
    visibleChecklists: checklistsVisibleTo(active, { viewerId: OWNER, isOwner: true }),
    visibleClients: [ACME, GLOBEX],
    serviceCategories: [],
    checklistSkips: [],
    skipChecklistOccurrence: vi.fn(),
    reviewChecklistSkip: vi.fn(),
    pendingTaskEditChecklistIds: new Set<string>(),
    pendingItemDeletionKeys: new Set<string>(),
    pendingTaskEdits: [],
    itemDeletionRequests: [],
    reportPeriod: { from: '2026-01-01', to: '2026-12-31' },
    setReportPeriod: vi.fn(),
    addChecklist: vi.fn(),
    addSeriesChecklistItem: vi.fn(),
    addSubItem: vi.fn(),
    addSubSubItem: vi.fn(),
    addWaitingOn: vi.fn(),
    applyTemplateToClient: vi.fn(),
    approveChecklistDeletion: vi.fn(),
    bulkAddChecklistItems: vi.fn(),
    deleteChecklist: vi.fn(),
    deleteChecklistItem: vi.fn(),
    emptyChecklistRecycleBin: vi.fn(),
    rejectChecklistDeletion: vi.fn(),
    removeSubItem: vi.fn(),
    removeSubSubItem: vi.fn(),
    reorderChecklistItems: vi.fn(),
    restoreChecklist: vi.fn(),
    setChecklistViewers: vi.fn(),
    toggleChecklistItem: vi.fn(),
    toggleSubItem: vi.fn(),
    toggleSubSubItem: vi.fn(),
    updateChecklistItem: vi.fn(),
    updateChecklistMeta: vi.fn(),
    updateSubItemWaiting: vi.fn(),
    waitingOnDone: vi.fn(),
    waitingOnSendBack: vi.fn(),
    waitingOnVerify: vi.fn(),
  } as unknown as AppContextValue
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/checklists']}>
      <ChecklistsPage />
    </MemoryRouter>,
  )

/**
 * The two task pickers on the page, in DOM order: the step's editor renders
 * above its sub-step list, so [0] is the step and [1] is the sub-step.
 */
const pickers = () =>
  screen.getAllByRole('combobox', {
    name: /Waiting for another task/i,
  }) as HTMLSelectElement[]

const optionNames = (select: HTMLSelectElement) =>
  within(select)
    .getAllByRole('option')
    .map((option) => option.textContent)

beforeEach(() => {
  signIn()
})

describe('the picker on a real checklist page', () => {
  it('mounts one picker per waiting node', () => {
    renderPage()
    expect(pickers()).toHaveLength(2)
  })

  it("offers only this client's other tasks, skipped ones excluded", () => {
    renderPage()
    const names = optionNames(pickers()[0])
    expect(names).toContain('Acme bank rec')
    expect(names).not.toContain('Acme skipped close')
    expect(names).not.toContain('Globex payroll (Globex Freight)')
    // …and never the task the step belongs to.
    expect(names).not.toContain('Acme payroll')
  })

  it("keeps the STEP's own cross-client link, named by its client", () => {
    renderPage()
    const step = pickers()[0]
    expect(step.value).toBe(GLOBEX_CLOSE.id)
    expect(optionNames(step)).toContain('Globex close (Globex Freight)')
  })

  it("keeps the SUB-STEP's own link — not the parent item's", () => {
    renderPage()
    const sub = pickers()[1]
    expect(sub.value).toBe(GLOBEX_PAYROLL.id)
    expect(optionNames(sub)).toContain('Globex payroll (Globex Freight)')
    // The parent step's link must not have leaked down here.
    expect(optionNames(sub)).not.toContain('Globex close (Globex Freight)')
  })
})
