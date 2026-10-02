import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import App from '../App'
import { createSeedData } from '../lib/seed'
import { REMOVAL_WOULD_COMPLETE_WAITING_STEP } from '../../lib/waiting-on-state.js'
import { installFetchMock, openNavLink, OWNER_SESSION } from './helpers'
import type { Checklist } from '../lib/types'

/**
 * A deletion request whose approval would finish a WAITING step is refused by
 * the server (409 STEP_IS_WAITING with a sentence in `message`). The approver
 * used to see nothing at all: the client built its error from the code, and the
 * Approve button ignored a rejection. This mounts the REAL `<App>` against a
 * mocked network, as the owner, and pins both halves:
 *
 *   - the Approve button is disabled up front, titled with the sentence, when
 *     the page can already see the step is waiting; and
 *   - when the page cannot (a wait saved elsewhere since this tab last synced)
 *     the click reaches the server, the 409 comes back, and the owner is shown
 *     the server's sentence INLINE (never a window.alert) while the request
 *     stays in the queue, and the workspace is fetched again so the page stops
 *     offering Approve on state the server has moved past.
 */

const CHECKLIST_ID = 'cl-rec'

const checklistWith = (waiting: boolean): Checklist =>
  ({
    id: CHECKLIST_ID,
    title: 'Bank rec close',
    clientId: 'client-clover',
    assigneeId: 'emp-patrice',
    dueDate: '2026-12-31',
    viewerIds: [],
    editorIds: [],
    items: [
      {
        id: 'item-rec',
        label: 'Reconcile',
        done: false,
        ...(waiting ? { waiting: true } : {}),
        subItems: [
          { id: 'sub-1', title: 'Pull statements', done: true },
          { id: 'sub-2', title: 'Match deposits', done: false },
        ],
      },
    ],
  }) as unknown as Checklist

const REQUEST = {
  id: 'del-1',
  clientId: 'client-clover',
  checklistId: CHECKLIST_ID,
  itemId: 'item-rec',
  subItemId: 'sub-2',
  subSubItemId: null,
  label: 'Match deposits',
  requestedBy: 'emp-bob',
  requestedByName: 'Bob Staff',
  requestedAt: '2026-09-29T15:00:00.000Z',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

// Set by a test to make the request-list reload fail (after the page first loaded).
let failListReload = false

afterEach(() => {
  failListReload = false
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function openApproveButton(waitingOnPage: boolean) {
  window.history.pushState({}, '', '/')
  installFetchMock({
    sessionUser: OWNER_SESSION,
    appData: { ...createSeedData(), checklists: [checklistWith(waitingOnPage)] },
    extraRoutes: [
      (path, method) => {
        // The three endpoints the app loads together on sign-in: one failing
        // would leave the whole batch (and the deletion queue) empty.
        if (method === 'GET' && path.endsWith('/api/checklists/item-deletions')) {
          return failListReload ? json({ error: 'boom' }, 500) : json({ requests: [REQUEST] })
        }
        if (method === 'POST' && path.endsWith('/api/checklists/item-deletions/del-1/reject')) {
          return json({ ok: true })
        }
        if (method === 'GET' && path.endsWith('/api/checklists/pending-edits')) {
          return json({ edits: [] })
        }
        if (method === 'GET' && path.endsWith('/api/waiting-on-me')) {
          return json({ items: [] })
        }
        if (method === 'POST' && path.endsWith('/api/checklists/item-deletions/del-1/approve')) {
          return json(
            { error: 'STEP_IS_WAITING', message: REMOVAL_WOULD_COMPLETE_WAITING_STEP },
            409,
          )
        }
        return undefined
      },
    ],
  })

  const { container } = render(<App />)
  const page = within(container)
  await page.findByRole('navigation')
  await openNavLink(page, 'Checklists')
  const heading = await page.findByText('Item deletions')
  const row = heading.parentElement?.querySelector('.pending-deletion-item') as HTMLElement
  expect(row).toBeTruthy()
  expect(within(row).getByText('Match deposits')).toBeTruthy()
  return { page, container, approve: within(row).getByRole('button', { name: 'Approve' }) }
}

it('disables Approve, with the sentence as its title, when the step is visibly waiting', async () => {
  const { approve } = await openApproveButton(true)
  expect(approve).toBeDisabled()
  expect(approve.getAttribute('title')).toBe(REMOVAL_WOULD_COMPLETE_WAITING_STEP)
})

it('shows the owner the server sentence inline on a refused approval, keeps the request, and refetches the workspace', async () => {
  // The live refetch only exists where the browser has an EventSource.
  class FakeEventSource {
    addEventListener() {}
    close() {}
  }
  vi.stubGlobal('EventSource', FakeEventSource)
  const alert = vi.fn()
  vi.stubGlobal('alert', alert)
  const { page, approve } = await openApproveButton(false)
  expect(approve).not.toBeDisabled()
  // Count the workspace fetches from here on (the refusal must cause one more).
  const appDataGets = () =>
    (fetch as unknown as { mock: { calls: Array<[string, RequestInit?]> } }).mock.calls.filter(
      ([url, init]) => String(url).endsWith('/api/app-data') && (init?.method ?? 'GET') === 'GET',
    ).length
  const before = appDataGets()

  fireEvent.click(approve)

  const refusal = await page.findByRole('alert')
  expect(refusal).toHaveTextContent(REMOVAL_WOULD_COMPLETE_WAITING_STEP)
  expect(alert).not.toHaveBeenCalled()
  // The app's normal deferred live refetch (a short debounce), asked for by the refusal.
  await waitFor(() => expect(appDataGets()).toBeGreaterThan(before), { timeout: 4000 })
  // Nothing was removed: the request is still waiting in the queue, and the
  // sentence the owner saw is the readable one, not the machine code.
  expect(page.queryByText('STEP_IS_WAITING')).toBeNull()
  expect(page.getByText('Item deletions')).toBeTruthy()
  expect(page.getAllByText('Match deposits').length).toBeGreaterThan(0)
  expect(page.queryByText(/something went wrong|not being saved/i)).toBeNull()
})

it('a failed reload of the request list cannot stand in for the server refusal', async () => {
  const { page, approve } = await openApproveButton(false)
  failListReload = true

  fireEvent.click(approve)

  expect(await page.findByRole('alert')).toHaveTextContent(REMOVAL_WOULD_COMPLETE_WAITING_STEP)
})

it('rejecting a request clears the refusal that was showing', async () => {
  const { page, approve } = await openApproveButton(false)
  fireEvent.click(approve)
  expect(await page.findByRole('alert')).toHaveTextContent(REMOVAL_WOULD_COMPLETE_WAITING_STEP)

  const row = approve.closest('.pending-deletion-item') as HTMLElement
  fireEvent.click(within(row).getByRole('button', { name: 'Reject' }))

  await waitFor(() => expect(page.queryByRole('alert')).toBeNull())
})
