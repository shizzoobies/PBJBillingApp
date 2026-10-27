import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import App from '../App'
import { createSeedData } from '../lib/seed'
import { addDays, localDateOnly } from '../lib/utils'
import { installFetchMock, OWNER_SESSION } from './helpers'
import type { AppData, Checklist } from '../lib/types'

/**
 * featreq-9c818fca: "Dashboard - Cases in Flight section - still does nothing
 * when clicking open step ... if it to let me know when there is a problem I am
 * unable to fix it or not sure what to do to fix it."
 *
 * A stalled row (a finished step whose next step never opened) now says what
 * happened and carries Open next step now itself. This mounts the REAL <App>
 * on a mocked network, so the click goes through App's openNextStageEarly and
 * its merge: the row leaves because the new step is really in the data.
 */

const TODAY = localDateOnly()
const OPEN_PATH = '/api/checklists/cl-stalled/open-next-stage'

const STALLED: Checklist = {
  id: 'cl-stalled',
  title: 'Quarterly close',
  clientId: 'client-clover',
  assigneeId: 'emp-jordan',
  templateId: 'tmpl-quarterly',
  caseId: 'case-stalled',
  stageIndex: 1,
  stageCount: 3,
  dueDate: addDays(TODAY, -12),
  createdAt: new Date().toISOString(),
  viewerIds: [],
  editorIds: [],
  items: [{ id: 'st-1', label: 'Reconcile', done: true, completedAt: `${addDays(TODAY, -10)}T15:00:00.000Z` }],
} as unknown as Checklist

const SPAWNED: Checklist = {
  ...STALLED,
  id: 'cl-spawned',
  title: 'Quarterly close review',
  stageIndex: 2,
  dueDate: addDays(TODAY, 5),
  items: [{ id: 'sp-1', label: 'Review', done: false }],
} as unknown as Checklist

function appData(): AppData {
  const seed = createSeedData()
  return { ...seed, checklists: [...seed.checklists, STALLED] }
}

const calls: Array<{ path: string; method: string }> = []

function boot(openNext: () => Response) {
  calls.length = 0
  installFetchMock({
    sessionUser: OWNER_SESSION,
    appData: appData(),
    extraRoutes: [
      (path, method) => {
        if (!path.endsWith(OPEN_PATH)) return undefined
        calls.push({ path, method })
        return openNext()
      },
    ],
  })
  return render(<App />)
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** The stalled row, found by its pill once the Dashboard has loaded. */
async function stalledRow(container: HTMLElement) {
  const pill = await within(container).findByText('Finished, next step never opened', {}, { timeout: 5000 })
  return pill.closest('li') as HTMLElement
}

beforeEach(() => {
  window.history.pushState({}, '', '/')
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the Dashboard stalled row (featreq-9c818fca)', () => {
  it('says what happened, links to the case, and opens the next step from the row', async () => {
    const { container } = boot(() => json({ checklist: STALLED, spawned: SPAWNED }))
    const row = await stalledRow(container)

    const sentence = within(row).getByText(/was never created/)
    expect(sentence.textContent).toMatch(
      /^Step 2 was finished on [A-Z][a-z]{2} \d{1,2} but step 3 was never created\. Press Open next step now to create it\.$/,
    )
    expect(within(row).getByRole('link', { name: 'Open case →' }).getAttribute('href')).toBe('/cases/case-stalled')
    // The caption says what the section is for.
    expect(within(container).getByText(/a red row needs a hand and says what to do\.$/)).toBeTruthy()

    fireEvent.click(within(row).getByRole('button', { name: 'Open next step now' }))
    expect(within(row).getByRole('button', { name: 'Opening…' })).toHaveProperty('disabled', true)

    await waitFor(() => expect(within(container).queryByText('Finished, next step never opened')).toBeNull())
    expect(calls).toEqual([{ path: OPEN_PATH, method: 'POST' }])
    const status = within(container).getByRole('status')
    expect(status.textContent).toBe('Step 3 opened.')
    const confirmation = status.closest('li') as HTMLElement
    expect(within(confirmation).getByRole('link', { name: 'Open step 3 →' }).getAttribute('href')).toBe(
      '/checklists?focus=cl-spawned',
    )
  })

  it("shows the server's sentence when it refuses, and keeps the row", async () => {
    const { container } = boot(() =>
      json(
        {
          error: 'next_stage_refused',
          reason: 'already_spawned',
          message: 'Step 3 is already open.',
        },
        409,
      ),
    )
    const row = await stalledRow(container)
    fireEvent.click(within(row).getByRole('button', { name: 'Open next step now' }))

    await waitFor(() => expect(within(row).getByRole('alert').textContent).toBe('Step 3 is already open.'))
    expect(calls).toHaveLength(1)
    expect(within(container).getByText('Finished, next step never opened')).toBeTruthy()
    expect(within(row).getByRole('button', { name: 'Open next step now' })).toHaveProperty('disabled', false)
  })
})
