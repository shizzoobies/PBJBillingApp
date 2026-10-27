import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaseDetailPage } from '../pages/CaseDetailPage'
import type { CaseDetail } from '../lib/api'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist } from '../lib/types'

/**
 * Remove case (2026-10-27) from the case page header: owner only, never in
 * preview. It asks first, removes through the context (POST /api/cases/:id/remove),
 * then says where the steps went with an Undo that restores the case.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  fetchCase: () => fetchCaseMock(),
}))

let fetchCaseMock = vi.fn()
let contextValue: AppContextValue
let removeCase: ReturnType<typeof vi.fn>
let restoreChecklist: ReturnType<typeof vi.fn>

const LISA = 'emp-lisa'
const OWNER = 'emp-patrice'

const row = (id: string, stageIndex: number, done: boolean): Checklist =>
  ({
    id,
    title: 'Quarterly close',
    clientId: 'client-1',
    assigneeId: LISA,
    templateId: 'tpl-1',
    caseId: 'case-1',
    stageIndex,
    stageCount: 2,
    dueDate: '2026-10-05',
    createdAt: '2026-09-28',
    viewerIds: [],
    editorIds: [],
    items: [{ id: `i-${id}`, label: 'Gather', done }],
  }) as unknown as Checklist

const ROWS = [row('cl-1', 0, true), row('cl-2', 1, false)]

const CASE: CaseDetail = {
  caseId: 'case-1',
  template: { id: 'tpl-1', title: 'Quarterly close' },
  client: { id: 'client-1', name: 'I-95 Logistics' },
  stages: [
    { stage: { id: 'stage-1', name: 'Prep', assigneeId: LISA }, checklist: ROWS[0] },
    { stage: { id: 'stage-2', name: 'Review', assigneeId: LISA }, checklist: ROWS[1] },
  ],
  activity: [],
} as unknown as CaseDetail

function renderAs(viewerId: string, { previewMode = false } = {}) {
  fetchCaseMock = vi.fn().mockResolvedValue(CASE)
  removeCase = vi.fn().mockResolvedValue({ removed: ['cl-1', 'cl-2'], deletedAt: '2026-10-27T15:00:00.123Z' })
  restoreChecklist = vi.fn().mockResolvedValue({ ok: true })
  contextValue = {
    data: {
      employees: [{ id: LISA, name: 'Lisa Chen', role: 'Bookkeeper' }],
      timeEntries: [],
      checklists: ROWS,
    } as unknown as AppData,
    role: viewerId === OWNER ? 'owner' : 'employee',
    previewMode,
    effectiveUser: { id: viewerId, role: viewerId === OWNER ? 'owner' : 'employee' },
    openNextStageEarly: vi.fn(),
    removeCase,
    restoreChecklist,
  } as unknown as AppContextValue
  return render(
    <MemoryRouter initialEntries={['/cases/case-1']}>
      <Routes>
        <Route path="/cases/:caseId" element={<CaseDetailPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Remove case on the case page', () => {
  it('asks, removes the case, says where its steps went, and Undo restores it', async () => {
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    renderAs(OWNER)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove case' }))
    expect(confirm).toHaveBeenCalledWith(
      'Remove Quarterly close for I-95 Logistics? Its 2 steps go to the recycle bin (you can restore them there). The recipe keeps running on its next cycle.',
    )
    expect(removeCase).toHaveBeenCalledTimes(1)
    expect(removeCase).toHaveBeenCalledWith('case-1', 'client-1')
    const status = await screen.findByRole('status')
    expect(status.textContent).toMatch(/^Case removed: its 2 steps are in the\s+recycle bin\. Undo$/)
    expect(screen.queryByText('Prep')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(restoreChecklist).toHaveBeenCalledWith('cl-1')
    // The case is read again and the timeline is back.
    await waitFor(() => expect(screen.getByText('Prep')).toBeTruthy())
    expect(fetchCaseMock).toHaveBeenCalledTimes(2)
  })

  it('a failed Undo keeps the page as it is and says why; the case is not read again', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    renderAs(OWNER)
    restoreChecklist.mockResolvedValueOnce({ ok: false, message: 'Restore is not possible.' })
    fireEvent.click(await screen.findByRole('button', { name: 'Remove case' }))
    await screen.findByRole('status')
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Restore is not possible.')
    expect(screen.getByRole('status').textContent).toMatch(/^Case removed:/)
    expect(fetchCaseMock).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the owner says no', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false))
    renderAs(OWNER)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove case' }))
    expect(removeCase).not.toHaveBeenCalled()
    expect(screen.getByText('Prep')).toBeTruthy()
  })

  it('shows the refusal when the case is already gone', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    renderAs(OWNER)
    removeCase.mockRejectedValueOnce(new Error('Case not found'))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove case' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Case not found')
    expect(screen.getByText('Prep')).toBeTruthy()
  })

  it('is not offered to staff, nor to the owner in preview', async () => {
    renderAs(LISA)
    await screen.findByText('Prep')
    expect(screen.queryByRole('button', { name: 'Remove case' })).toBeNull()
    renderAs(OWNER, { previewMode: true })
    await screen.findAllByText('Prep')
    expect(screen.queryByRole('button', { name: 'Remove case' })).toBeNull()
  })
})
