import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CaseDetailPage } from '../pages/CaseDetailPage'
import type { CaseDetail } from '../lib/api'
import type { AppContextValue } from '../AppContext'
import type { AppData } from '../lib/types'

/**
 * A checklist's `createdAt` is a full ISO timestamp in file/dev mode and a bare
 * date elsewhere. The "Case opened" line must read the date part either way,
 * never build `new Date('2026-09-14T08:30:00.000ZT12:00:00')` (Invalid Date).
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  fetchCase: (...args: unknown[]) => fetchCaseMock(...args),
}))

let fetchCaseMock = vi.fn()
let contextValue: AppContextValue

const caseWith = (createdAt: string): CaseDetail =>
  ({
    caseId: 'case-1',
    template: { id: 'tpl-1', title: 'Onboarding' },
    client: { id: 'client-1', name: 'Acme Books' },
    stages: [
      {
        stage: { id: 'stage-1', name: 'Kickoff', assigneeId: 'emp-1' },
        checklist: {
          id: 'cl-1',
          createdAt,
          dueDate: '2026-09-20',
          items: [{ id: 'i-1', label: 'Call', done: false }],
        },
      },
    ],
    activity: [],
  }) as unknown as CaseDetail

function renderPage() {
  contextValue = {
    data: { employees: [{ id: 'emp-1', name: 'Pat', role: 'Owner' }], timeEntries: [] } as unknown as AppData,
  } as unknown as AppContextValue
  return render(
    <MemoryRouter initialEntries={['/cases/case-1']}>
      <Routes>
        <Route path="/cases/:caseId" element={<CaseDetailPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('CaseDetailPage opened date', () => {
  beforeEach(() => {
    fetchCaseMock = vi.fn()
  })

  it('reads the date of a full ISO createdAt', async () => {
    fetchCaseMock.mockResolvedValue(caseWith('2026-09-14T08:30:00.000Z'))
    renderPage()
    expect(await screen.findByText(/Case opened Sep 14/)).toBeTruthy()
    expect(screen.queryByText(/Invalid Date/)).toBeNull()
  })

  it('still reads a bare date createdAt', async () => {
    fetchCaseMock.mockResolvedValue(caseWith('2026-09-14'))
    renderPage()
    expect(await screen.findByText(/Case opened Sep 14/)).toBeTruthy()
  })
})
