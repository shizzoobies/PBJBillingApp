import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import App from '../App'
import { createSeedData } from '../lib/seed'
import { addDays, localDateOnly } from '../lib/utils'
import { installFetchMock, OWNER_SESSION } from './helpers'
import type { AppData, Checklist } from '../lib/types'

/**
 * Remove case (2026-10-27, Alex for Brittany): "Brittany needs a way to
 * manually just remove stuff from her Cases in flight; we have old stuff and
 * there is no way to get rid of it; since she is owner she should be able to
 * just remove the case."
 *
 * The REAL <App> on a mocked network: the click goes through App's removeCase
 * and its merge, so the row leaves because its steps really moved to the bin,
 * and Undo goes through App's restoreChecklist, which brings the set back.
 */

const TODAY = localDateOnly()
const REMOVE_PATH = '/api/cases/case-old/remove'
const STAMP = '2026-10-27T15:00:00.123Z'

const base = {
  clientId: 'client-clover',
  assigneeId: 'emp-jordan',
  templateId: 'tmpl-old',
  caseId: 'case-old',
  stageCount: 2,
  createdAt: new Date().toISOString(),
  viewerIds: [],
  editorIds: [],
}

/** Case in flight: step 1 finished, step 2 under way. */
const STEP_1 = {
  ...base,
  id: 'cl-old-1',
  title: 'Old close',
  stageIndex: 0,
  dueDate: addDays(TODAY, -40),
  items: [{ id: 'o1', label: 'Gather', done: true, completedAt: `${addDays(TODAY, -40)}T15:00:00.000Z` }],
} as unknown as Checklist
const STEP_2 = {
  ...base,
  id: 'cl-old-2',
  title: 'Old close review',
  stageIndex: 1,
  dueDate: addDays(TODAY, -30),
  items: [
    { id: 'o2', label: 'Review', done: true },
    { id: 'o3', label: 'Sign off', done: false },
  ],
} as unknown as Checklist

/** A stalled case: step 1 of 3 finished, step 2 never opened. */
const STALLED = {
  ...base,
  id: 'cl-stalled',
  caseId: 'case-stalled',
  templateId: 'tmpl-quarterly',
  title: 'Quarterly close',
  stageIndex: 0,
  stageCount: 3,
  dueDate: addDays(TODAY, -12),
  items: [{ id: 's1', label: 'Reconcile', done: true, completedAt: `${addDays(TODAY, -10)}T15:00:00.000Z` }],
} as unknown as Checklist

function appData(): AppData {
  const seed = createSeedData()
  return { ...seed, checklists: [...seed.checklists, STEP_1, STEP_2, STALLED] }
}

const calls: Array<{ path: string; method: string }> = []

function boot() {
  calls.length = 0
  installFetchMock({
    sessionUser: OWNER_SESSION,
    appData: appData(),
    extraRoutes: [
      (path, method) => {
        if (!path.endsWith(REMOVE_PATH)) return undefined
        calls.push({ path, method })
        return json({ ok: true, caseId: 'case-old', removed: ['cl-old-1', 'cl-old-2'], deletedAt: STAMP })
      },
      (path, method) => {
        if (!/\/api\/checklists\/[^/]+\/restore$/.test(path)) return undefined
        calls.push({ path, method })
        return json({ ...STEP_1, deletedAt: null })
      },
    ],
  })
  return render(<App />)
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** The in-flight row of the old case, found by its current step's title. */
async function oldCaseRow(container: HTMLElement) {
  const title = await within(container).findByText('Old close review', {}, { timeout: 5000 })
  return title.closest('li') as HTMLElement
}

beforeEach(() => {
  window.history.pushState({}, '', '/')
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Remove case on the Dashboard (owner)', () => {
  it('is on every case row, in flight and stalled', async () => {
    const { container } = boot()
    const row = await oldCaseRow(container)
    expect(within(row).getByRole('button', { name: 'Remove case' })).toBeTruthy()
    const stalled = within(container).getByText('Finished, next step never opened').closest('li') as HTMLElement
    expect(within(stalled).getByRole('button', { name: 'Remove case' })).toBeTruthy()
  })

  it('asks first, sends ONE POST, the row leaves without a reload, and Undo restores the case', async () => {
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    const { container } = boot()
    const row = await oldCaseRow(container)
    fireEvent.click(within(row).getByRole('button', { name: 'Remove case' }))

    expect(confirm).toHaveBeenCalledWith(
      'Remove Old close review for Clover Ridge Dental? Its 2 steps go to the recycle bin (you can restore them there). The recipe keeps running on its next cycle.',
    )
    await waitFor(() => expect(within(container).queryByText('Old close review')).toBeNull())
    expect(calls).toEqual([{ path: REMOVE_PATH, method: 'POST' }])
    const status = within(container).getByText(/^Case removed: Old close review for Clover Ridge Dental\./)
    expect(status.getAttribute('role')).toBe('status')
    // The stalled case is untouched.
    expect(within(container).getByText('Finished, next step never opened')).toBeTruthy()

    fireEvent.click(within(status).getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(within(container).getByText('Old close review')).toBeTruthy())
    expect(calls).toEqual([
      { path: REMOVE_PATH, method: 'POST' },
      { path: '/api/checklists/cl-old-1/restore', method: 'POST' },
    ])
    expect(within(container).queryByText(/^Case removed:/)).toBeNull()
  })

  it('does nothing when the owner says no', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false))
    const { container } = boot()
    const row = await oldCaseRow(container)
    fireEvent.click(within(row).getByRole('button', { name: 'Remove case' }))
    expect(calls).toEqual([])
    expect(within(container).getByText('Old close review')).toBeTruthy()
  })
})
