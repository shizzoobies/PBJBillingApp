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

function appData(withSpawned = false): AppData {
  const seed = createSeedData()
  return { ...seed, checklists: [...seed.checklists, STALLED, ...(withSpawned ? [SPAWNED] : [])] }
}

const calls: Array<{ path: string; method: string }> = []
let appDataReads = 0

/**
 * Boots the app. `openNext` answers the POST; once it has answered, a workspace
 * re-read gets the server's truth, in which the next step IS open (it was opened
 * elsewhere - the "already open" refusal's case).
 */
function boot(openNext: () => Response) {
  calls.length = 0
  appDataReads = 0
  let answered = false
  installFetchMock({
    sessionUser: OWNER_SESSION,
    extraRoutes: [
      (path, method) => {
        if (!path.endsWith(OPEN_PATH)) return undefined
        calls.push({ path, method })
        answered = true
        return openNext()
      },
      (path, method) => {
        if (!path.endsWith('/api/app-data') || method !== 'GET') return undefined
        appDataReads += 1
        return json(appData(answered))
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
    // The case is now in flight; the note sits on ITS row, not on a second one
    // beside it (review L2).
    expect(within(container).getAllByText('Step 3 opened.')).toHaveLength(1)
    const status = within(container).getByText('Step 3 opened.')
    expect(status.getAttribute('role')).toBe('status')
    const caseRow = status.closest('li') as HTMLElement
    expect(within(caseRow).getByText('Quarterly close review')).toBeTruthy()
    expect(within(caseRow).getByRole('link', { name: 'Open case →' }).getAttribute('href')).toBe('/cases/case-stalled')
    expect(within(container).queryByRole('link', { name: 'Open step 3 →' })).toBeNull()
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

  it('on "already open", re-reads the workspace: the stale row leaves and the sentence stays on the case', async () => {
    // The live refresh rides the server's event stream; jsdom has none.
    class FakeEventSource {
      addEventListener() {}
      close() {}
    }
    vi.stubGlobal('EventSource', FakeEventSource)
    const { container } = boot(() =>
      json({ error: 'next_stage_refused', reason: 'already_spawned', message: 'Step 3 is already open.' }, 409),
    )
    const row = await stalledRow(container)
    const readsBefore = appDataReads
    fireEvent.click(within(row).getByRole('button', { name: 'Open next step now' }))

    await waitFor(() => expect(within(container).queryByText('Finished, next step never opened')).toBeNull(), {
      timeout: 4000,
    })
    expect(appDataReads).toBeGreaterThan(readsBefore)
    const alert = within(container).getByText('Step 3 is already open.')
    expect(alert.getAttribute('role')).toBe('alert')
    expect(within(alert.closest('li') as HTMLElement).getByText('Quarterly close review')).toBeTruthy()
  })
})
