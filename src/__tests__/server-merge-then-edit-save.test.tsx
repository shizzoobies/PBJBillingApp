import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import App from '../App'
import { createSeedData } from '../lib/seed'
import { localDateOnly } from '../lib/utils'
import { installFetchMock, OWNER_SESSION } from './helpers'
import type { AppData, Checklist, ChecklistTemplate } from '../lib/types'

/**
 * The page-level combined test: what the NEXT bulk save carries after a
 * server-authoritative checklist action.
 *
 * Both a "this + all future" step delete and a split push change rows the tab
 * does not own: the delete rewrites the recurring template, and the split adds a
 * second row. Each is merged into the tab through the server-update path, so the
 * owner's next autosave (here, a plan added on another page) writes the SERVER's
 * workspace back - the template without the removed step, both rows of the
 * split - instead of re-adding what the server just took away.
 *
 * The checklist under test is recurring, has a waiting step, and has "Hide
 * completed" on, because those are the states the new controls interact with.
 */

const CHECKLIST_ID = 'cl-rec'
const LIVE_ID = 'cl-rec-live'
const TODAY = localDateOnly()

const template = (withReconcile: boolean): ChecklistTemplate =>
  ({
    id: 'tmpl-1',
    title: 'Bank rec close',
    clientId: 'client-clover',
    assigneeId: 'emp-patrice',
    frequency: 'monthly',
    nextDueDate: '2099-01-31',
    active: true,
    isStandard: false,
    viewerIds: [],
    editorIds: [],
    stages: [
      {
        id: 'stage-a',
        name: 'Prep',
        assigneeId: 'emp-patrice',
        offsetDays: 0,
        viewerIds: [],
        editorIds: [],
        items: [
          ...(withReconcile ? [{ id: 'ti-0', label: 'Reconcile' }] : []),
          { id: 'ti-1', label: 'Send report' },
        ],
      },
    ],
  }) as unknown as ChecklistTemplate

const row = (id: string, items: unknown[], over: Record<string, unknown> = {}): Checklist =>
  ({
    id,
    title: 'Bank rec close',
    clientId: 'client-clover',
    assigneeId: 'emp-patrice',
    templateId: 'tmpl-1',
    stageId: 'stage-a',
    stageIndex: 0,
    stageCount: 1,
    dueDate: TODAY,
    viewerIds: [],
    editorIds: [],
    items,
    ...over,
  }) as unknown as Checklist

const RECONCILE = { id: 'item-r1', label: 'Reconcile', done: false }
const SEND_REPORT = { id: 'item-r2', label: 'Send report', done: false, waiting: true }
const ARCHIVE = { id: 'item-r3', label: 'Archive', done: true }

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let savedBodies: AppData[]

function boot(extraRoutes: Array<(path: string, method: string, body: unknown) => Response | undefined>) {
  window.history.pushState({}, '', '/checklists')
  savedBodies = []
  installFetchMock({
    sessionUser: OWNER_SESSION,
    appData: {
      ...createSeedData(),
      checklists: [row(CHECKLIST_ID, [RECONCILE, SEND_REPORT, ARCHIVE])],
      checklistTemplates: [template(true)],
    },
    extraRoutes: [
      (path, method, body) => {
        if (method === 'PUT' && path.endsWith('/api/app-data')) {
          savedBodies.push(body as AppData)
          return json({ ok: true })
        }
        if (method === 'GET' && path.endsWith('/api/checklists/item-deletions')) return json({ requests: [] })
        if (method === 'GET' && path.endsWith('/api/checklists/pending-edits')) return json({ edits: [] })
        if (method === 'GET' && path.endsWith('/api/waiting-on-me')) return json({ items: [] })
        if (method === 'GET' && path.endsWith('/api/checklists/skips')) return json({ skips: [] })
        if (method === 'GET' && path.endsWith('/api/pending-notes/attached')) return json({ notes: [] })
        return undefined
      },
      ...extraRoutes,
    ],
  })
}

/** A local edit the bulk autosave carries: add a plan on the Plans page. */
async function makeALocalEdit(page: ReturnType<typeof within>) {
  const plansBefore = createSeedData().plans.length
  fireEvent.click(page.getByRole('link', { name: 'Plans' }))
  fireEvent.click(await page.findByRole('button', { name: 'Add plan' }))
  const submit = page.getAllByRole('button', { name: 'Add plan' }).at(-1) as HTMLElement
  fireEvent.click(submit)
  // Wait for the save that carries the edit, not merely the first save.
  await waitFor(
    () => expect(savedBodies.some((body) => body.plans.length === plansBefore + 1)).toBe(true),
    { timeout: 4000 },
  )
  const saved = savedBodies.filter((body) => body.plans.length === plansBefore + 1).at(-1) as AppData
  expect(saved.plans.length).toBe(plansBefore + 1)
  return saved
}

beforeEach(() => {
  window.localStorage.clear()
  // Hide completed ON for this checklist.
  window.localStorage.setItem(`pbj.hideDone.v1.${CHECKLIST_ID}`, '1')
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function openCard() {
  const { container } = render(<App />)
  const page = within(container)
  const title = await page.findByText('Bank rec close', { selector: '.checklist-card-title-sub' })
  const card = title.closest('article') as HTMLElement
  expect(card).toBeTruthy()
  return { page, card: within(card) }
}

describe('after a "this + all future" step delete, the next autosave carries the server template', () => {
  it('writes the template without the removed step and keeps the waiting step', async () => {
    boot([
      (path, method) => {
        if (method === 'DELETE' && path.endsWith(`/api/checklists/${CHECKLIST_ID}/items/item-r1`)) {
          return json({
            removedFromTemplate: true,
            removedFromChecklists: [],
            keptOnChecklists: [],
            checklists: [row(CHECKLIST_ID, [SEND_REPORT, ARCHIVE])],
            template: template(false),
          })
        }
        return undefined
      },
    ])
    const { page, card } = await openCard()

    // Hide completed is on: the done step is folded away, the waiting one shows.
    expect(card.queryByText('Archive', { selector: '.task-row-title' })).toBeNull()
    const reconcile = card.getByText('Reconcile', { selector: '.task-row-title' }).closest('.task-item') as HTMLElement
    fireEvent.click(within(reconcile).getAllByRole('button', { name: 'Delete item' })[0])
    fireEvent.click(within(reconcile).getByRole('button', { name: 'This + all future' }))
    await card.findByText(/Removed from the recurring checklist/)

    const saved = await makeALocalEdit(page)
    const savedTemplate = saved.checklistTemplates.find((entry) => entry.id === 'tmpl-1')
    expect(savedTemplate?.stages[0].items.map((entry) => entry.label)).toEqual(['Send report'])
    const savedRow = saved.checklists.find((entry) => entry.id === CHECKLIST_ID)
    expect(savedRow?.items.map((entry) => entry.id)).toEqual(['item-r2', 'item-r3'])
    // The waiting step is still waiting, and nothing came back.
    expect(savedRow?.items.find((entry) => entry.id === 'item-r2')?.waiting).toBe(true)
  })

  it('a second click on the same button is a clean refusal, not a "not saved" alarm', async () => {
    let calls = 0
    boot([
      (path, method) => {
        if (method === 'DELETE' && path.endsWith(`/api/checklists/${CHECKLIST_ID}/items/item-r1`)) {
          calls += 1
          return calls === 1
            ? json({
                removedFromTemplate: true,
                removedFromChecklists: [],
                keptOnChecklists: [],
                checklists: [row(CHECKLIST_ID, [SEND_REPORT, ARCHIVE])],
                template: template(false),
              })
            : json({ error: 'Checklist item not found' }, 404)
        }
        return undefined
      },
    ])
    const { page, card } = await openCard()
    const reconcile = card.getByText('Reconcile', { selector: '.task-row-title' }).closest('.task-item') as HTMLElement
    fireEvent.click(within(reconcile).getAllByRole('button', { name: 'Delete item' })[0])
    const seriesButton = within(reconcile).getByRole('button', { name: 'This + all future' })
    fireEvent.click(seriesButton)
    fireEvent.click(seriesButton)
    await card.findByText(/Removed from the recurring checklist/)
    // The buttons were disabled while the request ran, so the second click never reached the server.
    expect(calls).toBe(1)
    expect(page.queryByText(/not being saved|not saved/i)).toBeNull()
  })

  it('a 404 from the server shows its sentence in the prompt and never trips the sync alarm', async () => {
    boot([
      (path, method) => {
        if (method === 'DELETE' && path.endsWith(`/api/checklists/${CHECKLIST_ID}/items/item-r1`)) {
          return json({ error: 'Checklist item not found' }, 404)
        }
        return undefined
      },
    ])
    const { page, card } = await openCard()
    const reconcile = card.getByText('Reconcile', { selector: '.task-row-title' }).closest('.task-item') as HTMLElement
    fireEvent.click(within(reconcile).getAllByRole('button', { name: 'Delete item' })[0])
    fireEvent.click(within(reconcile).getByRole('button', { name: 'This + all future' }))
    expect(await within(reconcile).findByRole('alert')).toHaveTextContent('Checklist item not found')
    expect(within(reconcile).getByRole('group', { name: 'Where to delete this step' })).toBeTruthy()
    expect(page.queryByText(/not being saved|not saved/i)).toBeNull()
  })
})

describe('after a split push, the next autosave carries both rows', () => {
  it('writes the done record and the live copy with its waiting step', async () => {
    boot([
      (path, method) => {
        if (method === 'POST' && path.endsWith(`/api/checklists/${CHECKLIST_ID}/push`)) {
          return json({
            checklist: row(LIVE_ID, [RECONCILE, SEND_REPORT], {
              dueDate: '2099-02-15',
              cycleDueDate: TODAY,
              pushedFromChecklistId: CHECKLIST_ID,
            }),
            completed: row(CHECKLIST_ID, [ARCHIVE], { pushedToChecklistId: LIVE_ID }),
          })
        }
        return undefined
      },
    ])
    const { page, card } = await openCard()

    fireEvent.click(card.getByRole('button', { name: 'Push to a new date' }))
    const dialog = within(card.getByRole('group', { name: /Push Bank rec close to a new date/i }))
    // One done step, two open ones: the split case.
    expect(dialog.getByText(/1 done step stays here as a completed record; 2 open steps move to /)).toBeTruthy()
    fireEvent.change(dialog.getByRole('combobox'), { target: { value: 'client' } })
    fireEvent.change(dialog.getByRole('textbox'), { target: { value: 'Statements are late.' } })
    fireEvent.change(dialog.getByLabelText('New due date'), { target: { value: '2099-02-15' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Push to this date' }))
    // The record moves to another group, so the card is looked for on the page, not in the old element.
    await waitFor(() => expect(page.queryByRole('group', { name: /Push Bank rec close/i })).toBeNull())

    const saved = await makeALocalEdit(page)
    const ids = saved.checklists.map((entry) => entry.id).sort()
    expect(ids).toEqual([LIVE_ID, CHECKLIST_ID].sort())
    const record = saved.checklists.find((entry) => entry.id === CHECKLIST_ID)
    const live = saved.checklists.find((entry) => entry.id === LIVE_ID)
    expect(record?.pushedToChecklistId).toBe(LIVE_ID)
    expect(live?.pushedFromChecklistId).toBe(CHECKLIST_ID)
    expect(live?.items.find((entry) => entry.id === 'item-r2')?.waiting).toBe(true)
    // The template is untouched by a push.
    expect(saved.checklistTemplates.find((entry) => entry.id === 'tmpl-1')?.stages[0].items).toHaveLength(2)
  })
})

describe('a 409 on a checkbox pulls the fresh workspace', () => {
  it('shows the server sentence and then refetches, so the tab shows the wait it was told about', async () => {
    const listeners: Record<string, () => void> = {}
    class FakeEventSource {
      addEventListener(name: string, handler: () => void) {
        listeners[name] = handler
      }
      close() {}
    }
    vi.stubGlobal('EventSource', FakeEventSource)
    const alert = vi.fn()
    vi.stubGlobal('alert', alert)
    boot([
      (path, method) => {
        if (method === 'POST' && path.endsWith(`/api/checklists/${CHECKLIST_ID}/items/item-r1/toggle`)) {
          return json({ error: 'STEP_IS_WAITING', message: 'Clear the wait first' }, 409)
        }
        return undefined
      },
    ])
    const { card } = await openCard()
    const appDataGets = () =>
      (fetch as unknown as { mock: { calls: Array<[string, RequestInit?]> } }).mock.calls.filter(
        ([url, init]) => String(url).endsWith('/api/app-data') && (init?.method ?? 'GET') === 'GET',
      ).length
    const before = appDataGets()

    const reconcile = card.getByText('Reconcile', { selector: '.task-row-title' }).closest('.task-item') as HTMLElement
    fireEvent.click(within(reconcile).getAllByRole('checkbox')[0])

    await waitFor(() => expect(alert).toHaveBeenCalledWith('Clear the wait first'))
    // The refetch is the app's normal deferred live refetch (a short debounce), asked for by the 409.
    await waitFor(() => expect(appDataGets()).toBeGreaterThan(before), { timeout: 4000 })
  })
})
