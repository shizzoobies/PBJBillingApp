import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import App from '../App'
import { createSeedData } from '../lib/seed'
import {
  REMOVAL_WOULD_COMPLETE_WAITING_STEP,
  STEP_HAS_OPEN_WAIT_MESSAGE,
} from '../../lib/waiting-on-state.js'
import { installFetchMock, openNavLink, OWNER_SESSION } from './helpers'
import type { Checklist } from '../lib/types'

/**
 * A refused sub-step / sub-sub-step delete (409: an open wait on the node, or a
 * waiting parent the removal would finish) used to land in the generic error sync
 * state with no explanation. The Delete button is disabled ahead of this when the
 * page can see the wait, so the click only reaches the server when the page's copy
 * was stale (a wait saved elsewhere since this tab last synced). This mounts the
 * REAL `<App>` as the owner against a mocked network whose page copy has no wait,
 * and pins what she is then told: the server's sentence, once, a refetch, and no
 * "not being saved" alarm.
 */

const CHECKLIST_ID = 'cl-rec'

const checklist = (): Checklist =>
  ({
    id: CHECKLIST_ID,
    title: 'Bank rec close',
    clientId: 'client-clover',
    assigneeId: 'emp-patrice',
    dueDate: '2026-10-20',
    viewerIds: [],
    editorIds: [],
    items: [
      {
        id: 'item-rec',
        label: 'Reconcile',
        done: false,
        subItems: [
          {
            id: 'sub-1',
            title: 'Match deposits',
            done: false,
            subItems: [{ id: 'ss-1', title: 'Chase the client', done: false }],
          },
          { id: 'sub-2', title: 'Pull statements', done: false },
        ],
      },
    ],
  }) as unknown as Checklist

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function openChecklists(refusal: { error: string; message: string }) {
  window.history.pushState({}, '', '/')
  // The live-sync wiring (where the refetch request lives) needs an EventSource.
  vi.stubGlobal(
    'EventSource',
    class {
      addEventListener() {}
      close() {}
    },
  )
  const state = { appDataLoads: 0, deletes: [] as string[] }
  installFetchMock({
    sessionUser: OWNER_SESSION,
    appData: { ...createSeedData(), checklists: [checklist()] },
    extraRoutes: [
      (path, method) => {
        if (method === 'GET' && path.endsWith('/api/app-data')) state.appDataLoads += 1
        if (method === 'GET' && path.endsWith('/api/checklists/item-deletions')) return json({ requests: [] })
        if (method === 'GET' && path.endsWith('/api/checklists/pending-edits')) return json({ edits: [] })
        if (method === 'GET' && path.endsWith('/api/waiting-on-me')) return json({ items: [] })
        if (method === 'DELETE' && path.includes(`/api/checklists/${CHECKLIST_ID}/items/item-rec/sub-items/`)) {
          state.deletes.push(path)
          return json(refusal, 409)
        }
        return undefined
      },
    ],
  })
  const { container } = render(<App />)
  const page = within(container)
  await page.findByRole('navigation')
  await openNavLink(page, 'Checklists')
  for (const heading of await screen.findAllByRole('button', { name: /^(Later|Overdue|This week)/ })) {
    fireEvent.click(heading)
  }
  return { page, container, state }
}

const deleteButtonFor = (container: HTMLElement, label: string) => {
  const row = Array.from(container.querySelectorAll('.sub-item-row')).find((el) =>
    el.textContent?.includes(label),
  )
  return row?.querySelector('button[aria-label="Delete sub-step"]') as HTMLButtonElement
}

it.each([
  ['open wait', 'STEP_HAS_OPEN_WAIT', STEP_HAS_OPEN_WAIT_MESSAGE],
  ['roll-up', 'STEP_IS_WAITING', REMOVAL_WOULD_COMPLETE_WAITING_STEP],
])('a refused sub-step delete (%s) shows the server sentence once and refetches', async (_name, code, sentence) => {
  const alert = vi.fn()
  vi.stubGlobal('alert', alert)
  const { page, container, state } = await openChecklists({ error: code, message: sentence })
  const button = deleteButtonFor(container, 'Pull statements')
  expect(button).toBeTruthy()
  expect(button).not.toBeDisabled()
  const loadsBefore = state.appDataLoads

  fireEvent.click(button)

  await waitFor(() => expect(alert).toHaveBeenCalledWith(sentence))
  expect(alert).toHaveBeenCalledTimes(1)
  expect(alert).not.toHaveBeenCalledWith(code)
  expect(state.deletes).toHaveLength(1)
  await waitFor(() => expect(state.appDataLoads).toBeGreaterThan(loadsBefore), { timeout: 4000 })
  expect(page.queryByText(/something went wrong|not being saved/i)).toBeNull()
})

it('a refused sub-sub-step delete shows the server sentence once and refetches', async () => {
  const alert = vi.fn()
  vi.stubGlobal('alert', alert)
  const { page, container, state } = await openChecklists({
    error: 'STEP_HAS_OPEN_WAIT',
    message: STEP_HAS_OPEN_WAIT_MESSAGE,
  })
  const button = deleteButtonFor(container, 'Chase the client')
  expect(button).toBeTruthy()
  const loadsBefore = state.appDataLoads

  fireEvent.click(button)

  await waitFor(() => expect(alert).toHaveBeenCalledWith(STEP_HAS_OPEN_WAIT_MESSAGE))
  expect(alert).toHaveBeenCalledTimes(1)
  expect(state.deletes[0]).toContain('/sub-items/sub-1/sub-items/ss-1')
  await waitFor(() => expect(state.appDataLoads).toBeGreaterThan(loadsBefore), { timeout: 4000 })
  expect(page.queryByText(/something went wrong|not being saved/i)).toBeNull()
})
