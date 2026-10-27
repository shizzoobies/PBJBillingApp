import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CaseDetailPage } from '../pages/CaseDetailPage'
import type { CaseDetail } from '../lib/api'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist } from '../lib/types'

/**
 * featreq-9c818fca: the Dashboard's stalled row links here ("Open case"). A step
 * that never opened although the step before it is finished used to read
 * "Not started · Awaiting previous stage" - wrong, nothing is left to wait for.
 * It now reads "Never opened", says what happened, and (owner or the finished
 * step's assignee, not in preview) carries Open next step now. A step whose
 * previous step is genuinely still open keeps "Awaiting previous stage".
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  fetchCase: () => fetchCaseMock(),
}))

let fetchCaseMock = vi.fn()
let contextValue: AppContextValue
let openNextStageEarly: ReturnType<typeof vi.fn>

const LISA = 'emp-lisa'
const SAM = 'emp-sam'
const OWNER = 'emp-patrice'

const step1 = (done: boolean): Checklist =>
  ({
    id: 'cl-1',
    title: 'Quarterly close',
    clientId: 'client-1',
    assigneeId: LISA,
    templateId: 'tpl-1',
    caseId: 'case-1',
    stageIndex: 0,
    stageCount: 3,
    dueDate: '2026-10-05',
    createdAt: '2026-09-28',
    viewerIds: [],
    editorIds: [],
    items: [{ id: 'i-1', label: 'Gather', done, ...(done ? { completedAt: '2026-10-05T15:00:00.000Z' } : {}) }],
  }) as unknown as Checklist

const SPAWNED = {
  ...step1(false),
  id: 'cl-2',
  title: 'Quarterly close review',
  assigneeId: SAM,
  stageIndex: 1,
  dueDate: '2026-11-05',
  items: [{ id: 'i-2', label: 'Review', done: false }],
} as unknown as Checklist

const caseWith = (first: Checklist): CaseDetail =>
  ({
    caseId: 'case-1',
    template: { id: 'tpl-1', title: 'Quarterly close' },
    client: { id: 'client-1', name: 'I-95 Logistics' },
    stages: [
      { stage: { id: 'stage-1', name: 'Prep', assigneeId: LISA }, checklist: first },
      { stage: { id: 'stage-2', name: 'Review', assigneeId: SAM }, checklist: null },
      { stage: { id: 'stage-3', name: 'Deliver', assigneeId: LISA }, checklist: null },
    ],
    activity: [],
  }) as unknown as CaseDetail

function renderAs(viewerId: string, first: Checklist, { previewMode = false } = {}) {
  fetchCaseMock = vi.fn().mockResolvedValue(caseWith(first))
  openNextStageEarly = vi.fn().mockResolvedValue(SPAWNED)
  contextValue = {
    data: {
      employees: [
        { id: LISA, name: 'Lisa Chen', role: 'Bookkeeper' },
        { id: SAM, name: 'Sam Lee', role: 'Bookkeeper' },
        { id: OWNER, name: 'Brittany Ferguson', role: 'Owner' },
      ],
      timeEntries: [],
      checklists: [first],
    } as unknown as AppData,
    role: viewerId === OWNER ? 'owner' : 'employee',
    previewMode,
    effectiveUser: { id: viewerId, role: viewerId === OWNER ? 'owner' : 'employee' },
    openNextStageEarly,
  } as unknown as AppContextValue
  return render(
    <MemoryRouter initialEntries={['/cases/case-1']}>
      <Routes>
        <Route path="/cases/:caseId" element={<CaseDetailPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

/** The timeline row of a stage, by its name. */
const rowFor = async (name: string) => (await screen.findByText(name)).closest('li') as HTMLElement
const SENTENCE =
  /^Step 1 was finished on Oct 5 but step 2 was never created\. Press Open next step now to create it\.$/

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the case page, a step that never opened (featreq-9c818fca)', () => {
  it('reads "Never opened" with the Dashboard sentence and the button for the owner', async () => {
    renderAs(OWNER, step1(true))
    const row = await rowFor('Review')
    expect(within(row).getByText('Never opened')).toBeTruthy()
    expect(within(row).queryByText(/Awaiting previous stage/)).toBeNull()
    expect(within(row).getByText(SENTENCE)).toBeTruthy()
    expect(within(row).getByRole('button', { name: 'Open next step now' })).toBeTruthy()
    // The step after it is genuinely waiting on the one that never opened.
    const deliver = await rowFor('Deliver')
    expect(within(deliver).getByText(/Awaiting previous stage/)).toBeTruthy()
    expect(within(deliver).queryByRole('button')).toBeNull()
  })

  it('keeps "Awaiting previous stage" when the previous step is still open', async () => {
    renderAs(OWNER, step1(false))
    const row = await rowFor('Review')
    expect(within(row).getByText(/Awaiting previous stage/)).toBeTruthy()
    expect(within(row).queryByText('Never opened')).toBeNull()
    expect(within(row).queryByRole('button', { name: 'Open next step now' })).toBeNull()
  })

  it('opens the next step: "Opening…", then "Step 2 opened." on the now-open step', async () => {
    renderAs(LISA, step1(true))
    const row = await rowFor('Review')
    fireEvent.click(within(row).getByRole('button', { name: 'Open next step now' }))
    expect(openNextStageEarly).toHaveBeenCalledWith('cl-1')
    expect(within(row).getByRole('button', { name: 'Opening…' })).toHaveProperty('disabled', true)
    await waitFor(() => expect(within(row).getByRole('status').textContent).toBe('Step 2 opened.'))
    expect(within(row).queryByText('Never opened')).toBeNull()
    expect(within(row).getByText('Open')).toBeTruthy()
    expect(within(row).getByRole('link', { name: 'Open checklist' }).getAttribute('href')).toBe(
      '/checklists?focus=cl-2',
    )
  })

  it("shows the server's sentence when it refuses", async () => {
    renderAs(OWNER, step1(true))
    openNextStageEarly.mockRejectedValueOnce(new Error('Step 2 is already open.'))
    const row = await rowFor('Review')
    fireEvent.click(within(row).getByRole('button', { name: 'Open next step now' }))
    await waitFor(() => expect(within(row).getByRole('alert').textContent).toBe('Step 2 is already open.'))
    expect(within(row).getByText('Never opened')).toBeTruthy()
  })

  it('offers no button to someone else, or in preview, and says who can', async () => {
    const first = renderAs(SAM, step1(true))
    let row = await rowFor('Review')
    expect(within(row).queryByRole('button', { name: 'Open next step now' })).toBeNull()
    expect(
      within(row).getByText(/The owner or the person this step is assigned to can create it with Open next step now\.$/),
    ).toBeTruthy()
    first.unmount()
    renderAs(LISA, step1(true), { previewMode: true })
    row = await rowFor('Review')
    expect(within(row).getByText('Never opened')).toBeTruthy()
    expect(within(row).queryByRole('button', { name: 'Open next step now' })).toBeNull()
  })
})
