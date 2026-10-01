import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import App from '../App'
import { createSeedData } from '../lib/seed'
import { LAST_RECURRING_STEP_MESSAGE } from '../../lib/series-step-delete.js'
import { installFetchMock, OWNER_SESSION } from './helpers'
import type { Checklist, ChecklistTemplate, ItemDeletionRequest, SessionUser } from '../lib/types'

/**
 * A team member can ask for "This + all future" when deleting a step, and the
 * owner approves it (featreq-01464e64 rework). This mounts the REAL `<App>`
 * against a mocked network and pins the whole round trip from both seats:
 *
 *   - staff: the delete prompt offers both choices; each files the right
 *     request (the series one is DELETE ...?scope=series) and says so;
 *   - owner: each pending request names its scope; approving a series request
 *     shows the same result sentence the owner's own series delete shows and the
 *     request leaves the list; a refused approval shows the server's sentence
 *     and the request stays.
 */

const STAFF_SESSION: SessionUser = {
  id: 'emp-jordan',
  name: 'Jordan Ellis',
  email: 'jordan@example.com',
  role: 'employee',
  staffRole: 'Bookkeeper',
  totpEnabled: false,
}

// Due today, so the page's default report period (this month) always includes both checklists.
const today = new Date()
const TODAY = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0')].join('-')

const step = (id: string, label: string) => ({ id, label, done: false })
const checklistOf = (id: string, title: string, dueDate: string, over: Partial<Checklist> = {}): Checklist =>
  ({
    id,
    title,
    clientId: 'client-clover',
    assigneeId: 'emp-jordan',
    dueDate,
    viewerIds: [],
    editorIds: [],
    items: [step(`${id}-rec`, 'Reconcile'), step(`${id}-rep`, 'Send report')],
    ...over,
  }) as unknown as Checklist

const RECURRING = checklistOf('cl-sep', 'Monthly close', TODAY, { templateId: 'tmpl-1' })
const ONE_OFF = checklistOf('cl-one', 'One off cleanup', TODAY)
const TEMPLATE = {
  id: 'tmpl-1',
  title: 'Monthly close',
  clientId: 'client-clover',
  assigneeId: 'emp-jordan',
  frequency: 'monthly',
  nextDueDate: '2027-01-31',
  active: true,
  viewerIds: [],
  editorIds: [],
  stages: [
    {
      id: 'stage-a',
      name: 'Prep',
      assigneeId: 'emp-jordan',
      offsetDays: 0,
      items: [
        { id: 'ti-0', label: 'Reconcile' },
        { id: 'ti-1', label: 'Send report' },
      ],
    },
  ],
} as unknown as ChecklistTemplate

const request = (over: Partial<ItemDeletionRequest> = {}): ItemDeletionRequest => ({
  id: 'del-1',
  clientId: 'client-clover',
  checklistId: 'cl-sep',
  itemId: 'cl-sep-rec',
  subItemId: null,
  subSubItemId: null,
  label: 'Reconcile',
  requestedBy: 'emp-jordan',
  requestedByName: 'Jordan Ellis',
  requestedAt: '2026-09-30T15:00:00.000Z',
  scope: 'series',
  ...over,
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

type Seen = { method: string; url: string }

/** Boot the app as `session`, with `pending` as the queue the server answers (it shrinks when the test says so). */
function boot(session: SessionUser, opts: {
  pending?: ItemDeletionRequest[]
  onWrite?: (path: string, method: string) => Response | undefined
  queue?: { current: ItemDeletionRequest[] }
} = {}) {
  const queue = opts.queue ?? { current: opts.pending ?? [] }
  const seen: Seen[] = []
  window.history.pushState({}, '', '/')
  installFetchMock({
    sessionUser: session,
    appData: {
      ...createSeedData(),
      checklists: [RECURRING, ONE_OFF],
      checklistTemplates: [TEMPLATE],
    },
    extraRoutes: [
      (path, method) => {
        if (method === 'GET' && path.endsWith('/api/checklists/item-deletions')) return json({ requests: queue.current })
        if (method === 'GET' && path.endsWith('/api/checklists/pending-edits')) return json({ edits: [] })
        if (method === 'GET' && path.endsWith('/api/waiting-on-me')) return json({ items: [] })
        if (method !== 'GET') {
          seen.push({ method, url: path })
          return opts.onWrite?.(path, method)
        }
        return undefined
      },
    ],
  })
  return { queue, seen }
}

const openChecklists = async () => {
  const { container } = render(<App />)
  const page = within(container)
  await page.findByRole('navigation')
  fireEvent.click(page.getByRole('link', { name: 'Checklists' }))
  return page
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('as a team member', () => {
  const seriesSeen = vi.fn()
  const openPrompt = async (title: string) => {
    const page = await openChecklists()
    const card = (await page.findByText(title)).closest('article, li, section') as HTMLElement
    fireEvent.click(within(card).getAllByRole('button', { name: 'Delete item' })[0])
    return { page, card, prompt: within(card).getByRole('group', { name: 'Where to delete this step' }) }
  }
  const filed = (queue: { current: ItemDeletionRequest[] }, scope: 'series' | 'checklist') => (path: string, method: string) => {
    if (method !== 'DELETE') return undefined
    seriesSeen(path)
    const created = request({ scope })
    queue.current = [created]
    return json({ request: created, checklist: RECURRING })
  }

  it('is offered both choices and Cancel on a recurring checklist', async () => {
    boot(STAFF_SESSION)
    const { prompt } = await openPrompt('Monthly close')
    expect(within(prompt).getByRole('button', { name: 'This checklist only' })).toBeInTheDocument()
    expect(within(prompt).getByRole('button', { name: 'This + all future' })).toBeInTheDocument()
    expect(within(prompt).getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('"This + all future" files a series request, deletes nothing, and says it was sent', async () => {
    const queue = { current: [] as ItemDeletionRequest[] }
    const { seen } = boot(STAFF_SESSION, { queue, onWrite: filed(queue, 'series') })
    const { page, prompt } = await openPrompt('Monthly close')

    fireEvent.click(within(prompt).getByRole('button', { name: 'This + all future' }))

    expect(await page.findByText('Sent to the owner for approval - this checklist and all future ones.')).toBeInTheDocument()
    expect(seen).toEqual([{ method: 'DELETE', url: '/api/checklists/cl-sep/items/cl-sep-rec' }])
    // Nothing was removed: the step is still on the card.
    expect(page.getAllByText('Reconcile').length).toBeGreaterThan(0)
    expect(page.queryByRole('group', { name: 'Where to delete this step' })).not.toBeInTheDocument()
  })

  it('sends the series choice as ?scope=series and the other choice without it', async () => {
    const queue = { current: [] as ItemDeletionRequest[] }
    boot(STAFF_SESSION, { queue, onWrite: filed(queue, 'series') })
    const urls: string[] = []
    const real = globalThis.fetch
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') urls.push(String(input))
      return real(input, init)
    })
    const { prompt } = await openPrompt('Monthly close')
    fireEvent.click(within(prompt).getByRole('button', { name: 'This + all future' }))
    await waitFor(() => expect(urls).toHaveLength(1))
    expect(urls[0]).toMatch(/\/api\/checklists\/cl-sep\/items\/cl-sep-rec\?scope=series$/)
  })

  it('"This checklist only" files a plain request and says it was sent', async () => {
    const queue = { current: [] as ItemDeletionRequest[] }
    const urls: string[] = []
    boot(STAFF_SESSION, { queue, onWrite: filed(queue, 'checklist') })
    const real = globalThis.fetch
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') urls.push(String(input))
      return real(input, init)
    })
    const { page, prompt } = await openPrompt('Monthly close')

    fireEvent.click(within(prompt).getByRole('button', { name: 'This checklist only' }))

    expect(await page.findByText('Sent to the owner for approval.')).toBeInTheDocument()
    expect(urls).toHaveLength(1)
    expect(urls[0]).not.toContain('scope=')
  })

  it('shows no "sent" notice when the server refused', async () => {
    boot(STAFF_SESSION, {
      onWrite: (_path, method) => (method === 'DELETE' ? json({ error: 'nope' }, 500) : undefined),
    })
    const { page, prompt } = await openPrompt('Monthly close')
    fireEvent.click(within(prompt).getByRole('button', { name: 'This + all future' }))
    await waitFor(() => expect(page.queryByRole('group', { name: 'Where to delete this step' })).not.toBeInTheDocument())
    expect(page.queryByText(/Sent to the owner for approval/)).not.toBeInTheDocument()
  })

  it('keeps the plain confirm on a one-off checklist', async () => {
    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    boot(STAFF_SESSION)
    const page = await openChecklists()
    const card = (await page.findByText('One off cleanup')).closest('article, li, section') as HTMLElement
    fireEvent.click(within(card).getAllByRole('button', { name: 'Delete item' })[0])
    expect(confirm).toHaveBeenCalledWith('Delete this step?')
    expect(within(card).queryByRole('group', { name: 'Where to delete this step' })).not.toBeInTheDocument()
  })
})

describe('as the owner', () => {
  const rowFor = async (page: ReturnType<typeof within>, label: string) => {
    const heading = await page.findByText('Item deletions')
    const rows = Array.from(heading.parentElement?.querySelectorAll('.pending-deletion-item') ?? []) as HTMLElement[]
    const row = rows.find((entry) => within(entry).queryByText(label))
    expect(row, `row for ${label}`).toBeTruthy()
    return row as HTMLElement
  }

  it('shows each pending request\'s scope in words next to the step name', async () => {
    boot(OWNER_SESSION, {
      pending: [
        request({ id: 'del-series', scope: 'series', label: 'Reconcile' }),
        request({ id: 'del-one', scope: 'checklist', itemId: 'cl-sep-rep', label: 'Send report' }),
        // A request filed before the choice existed carries no scope at all.
        request({ id: 'del-old', scope: undefined, itemId: 'cl-one-rec', checklistId: 'cl-one', label: 'Old request' }),
      ],
    })
    const page = await openChecklists()
    expect(within(await rowFor(page, 'Reconcile')).getByText('This + all future')).toBeInTheDocument()
    expect(within(await rowFor(page, 'Send report')).getByText('This checklist only')).toBeInTheDocument()
    expect(within(await rowFor(page, 'Old request')).getByText('This checklist only')).toBeInTheDocument()
  })

  it('approving a series request shows the series result sentence and the request leaves the list', async () => {
    const queue = { current: [request()] }
    const { seen } = boot(OWNER_SESSION, {
      queue,
      onWrite: (path, method) => {
        if (method === 'POST' && path.endsWith('/api/checklists/item-deletions/del-1/approve')) {
          queue.current = []
          return json({
            removedFromTemplate: true,
            removedFromChecklists: ['cl-oct', 'cl-nov'],
            keptOnChecklists: ['cl-dec'],
            checklists: [{ ...RECURRING, items: [step('cl-sep-rep', 'Send report')] }],
            template: {
              ...TEMPLATE,
              stages: [{ id: 'stage-a', name: 'Prep', assigneeId: 'emp-jordan', offsetDays: 0, items: [{ id: 'ti-1', label: 'Send report' }] }],
            },
          })
        }
        return undefined
      },
    })
    const page = await openChecklists()
    const row = await rowFor(page, 'Reconcile')

    fireEvent.click(within(row).getByRole('button', { name: 'Approve' }))

    expect(
      await page.findByText('Removed from the recurring checklist and 2 upcoming checklists. Kept on 1 where work had started.'),
    ).toBeInTheDocument()
    expect(seen).toEqual([{ method: 'POST', url: '/api/checklists/item-deletions/del-1/approve' }])
    await waitFor(() => expect(page.queryByText('Item deletions')).not.toBeInTheDocument())
  })

  it('approving a one-checklist request still shows no series sentence', async () => {
    const queue = { current: [request({ scope: 'checklist' })] }
    boot(OWNER_SESSION, {
      queue,
      onWrite: (path, method) => {
        if (method === 'POST' && path.endsWith('/approve')) {
          queue.current = []
          return json({ ...RECURRING, items: [step('cl-sep-rep', 'Send report')] })
        }
        return undefined
      },
    })
    const page = await openChecklists()
    fireEvent.click(within(await rowFor(page, 'Reconcile')).getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(page.queryByText('Item deletions')).not.toBeInTheDocument())
    expect(page.queryByText(/Removed from the recurring checklist/)).not.toBeInTheDocument()
  })

  it('shows the server sentence for a refused approval and keeps the request', async () => {
    const alert = vi.fn()
    vi.stubGlobal('alert', alert)
    boot(OWNER_SESSION, {
      pending: [request()],
      onWrite: (path, method) =>
        method === 'POST' && path.endsWith('/approve')
          ? json({ error: 'last_recurring_step', message: LAST_RECURRING_STEP_MESSAGE }, 409)
          : undefined,
    })
    const page = await openChecklists()
    fireEvent.click(within(await rowFor(page, 'Reconcile')).getByRole('button', { name: 'Approve' }))

    await waitFor(() => expect(alert).toHaveBeenCalledWith(LAST_RECURRING_STEP_MESSAGE))
    expect(page.getByText('Item deletions')).toBeInTheDocument()
    expect(within(await rowFor(page, 'Reconcile')).getByText('This + all future')).toBeInTheDocument()
    expect(page.queryByText(/Removed from the recurring checklist/)).not.toBeInTheDocument()
  })
})
