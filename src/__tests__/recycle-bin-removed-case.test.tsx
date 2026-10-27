import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import App from '../App'
import { createSeedData } from '../lib/seed'
import { installFetchMock, openNavLink, OWNER_SESSION } from './helpers'
import type { AppData, Checklist } from '../lib/types'

/**
 * Remove case (2026-10-27): the steps of a removed case sit in the recycle bin
 * as a set (same case, same stamp). The bin says so, and its Restore restores
 * the whole case - one request, every step of the set back - while a step
 * deleted on its own still restores on its own.
 */

const STAMP = '2026-10-27T15:00:00.123Z'
const base = {
  clientId: 'client-clover',
  assigneeId: 'emp-jordan',
  templateId: 'tmpl-old',
  caseId: 'case-old',
  stageCount: 2,
  dueDate: '2026-08-31',
  viewerIds: [],
  editorIds: [],
  items: [{ id: 'x', label: 'Do', done: false }],
}
const REMOVED_1 = { ...base, id: 'cl-old-1', title: 'Old close', stageIndex: 0, deletedAt: STAMP } as unknown as Checklist
const REMOVED_2 = { ...base, id: 'cl-old-2', title: 'Old close review', stageIndex: 1, deletedAt: STAMP } as unknown as Checklist
const ON_ITS_OWN = {
  ...base,
  id: 'cl-solo',
  caseId: 'case-solo',
  title: 'One-off cleanup',
  stageIndex: 0,
  stageCount: 1,
  deletedAt: '2026-10-01T12:00:00.000Z',
} as unknown as Checklist

const calls: string[] = []

function boot() {
  calls.length = 0
  const seed = createSeedData()
  const appData: AppData = { ...seed, recycledChecklists: [REMOVED_1, REMOVED_2, ON_ITS_OWN] }
  installFetchMock({
    sessionUser: OWNER_SESSION,
    appData,
    extraRoutes: [
      (path, method) => {
        const match = /\/api\/checklists\/([^/]+)\/restore$/.exec(path)
        if (!match || method !== 'POST') return undefined
        calls.push(match[1])
        const row = [REMOVED_1, REMOVED_2, ON_ITS_OWN].find((entry) => entry.id === match[1])
        return new Response(JSON.stringify({ ...row, deletedAt: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    ],
  })
  return render(<App />)
}

beforeEach(() => {
  window.history.pushState({}, '', '/')
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the recycle bin and a removed case', () => {
  it('labels the set, and one Restore brings every step of the case back', async () => {
    boot()
    await openNavLink(screen, 'Checklists')
    const toggle = await screen.findByRole('button', { name: /Recycle bin/ }, { timeout: 5000 })
    fireEvent.click(toggle)
    const bin = toggle.closest('section') as HTMLElement
    expect(within(bin).getByText(/restoring any one of them restores the whole case/)).toBeTruthy()

    const removedRow = within(bin).getByText('Old close review').closest('li') as HTMLElement
    expect(within(removedRow).getByText(/Removed with its case \(2 steps\)/)).toBeTruthy()
    const soloRow = within(bin).getByText('One-off cleanup').closest('li') as HTMLElement
    expect(within(soloRow).getByRole('button', { name: 'Restore' })).toBeTruthy()

    fireEvent.click(within(removedRow).getByRole('button', { name: 'Restore case (2 steps)' }))
    await waitFor(() => expect(within(bin).queryByText('Old close review')).toBeNull())
    expect(within(bin).queryByText('Old close')).toBeNull()
    expect(calls).toEqual(['cl-old-2'])
    // The step deleted on its own is still in the bin.
    expect(within(bin).getByText('One-off cleanup')).toBeTruthy()
  })
})
