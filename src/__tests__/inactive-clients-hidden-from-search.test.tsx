/**
 * featreq-60f24838 — "Exclude inactive clients from search bar results by
 * default so that only active clients are shown... This behavior is
 * consistent across every search bar in the app."
 *
 * The rule (see the header comment in lib/clientLifecycle.ts): typing a
 * search query must not RETURN rows belonging to a retired client, but with
 * an EMPTY query base lists are unchanged — history stays visible. This file
 * covers the shared helper plus the two surfaces reachable as pure functions
 * (filterInProgressChecklists) and, for a page whose filter is inline-only, a
 * light render mirroring the existing pattern already used for that page.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { FilterBar } from '../components/FilterBar'
import { inactiveClientIdSet } from '../lib/clientLifecycle'
import { filterInProgressChecklists } from '../lib/inProgressFilter'
import { DelayedPage } from '../pages/DelayedPage'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist, Client } from '../lib/types'

describe('inactiveClientIdSet', () => {
  it('collects only the retired clients', () => {
    const clients = [
      { id: 'c1', lifecycleStage: undefined },
      { id: 'c2', lifecycleStage: 'active' as const },
      { id: 'c3', lifecycleStage: 'inactive' as const },
      { id: 'c4', lifecycleStage: 'proposal' as const },
    ]
    expect(inactiveClientIdSet(clients)).toEqual(new Set(['c3']))
  })

  it('is empty-safe', () => {
    expect(inactiveClientIdSet([])).toEqual(new Set())
  })
})

describe('filterInProgressChecklists — inactive clients (featreq-60f24838)', () => {
  const TODAY = '2026-09-02'
  const wide = { preset: 'custom', from: '2026-01-01', to: '2026-12-31' } as never

  const CLIENTS = [
    { id: 'c-active', name: 'Acme Bakery' },
    { id: 'c-gone', name: 'Zenith Dental', lifecycleStage: 'inactive' },
  ] as unknown as Client[]

  const mk = (id: string, clientId: string, title: string): Checklist =>
    ({
      id,
      clientId,
      title,
      assigneeId: 'e1',
      dueDate: '2026-07-14',
      frequency: 'monthly',
      items: [],
    }) as unknown as Checklist

  const all = [
    mk('a', 'c-active', 'Monthly close'),
    mk('b', 'c-gone', 'Payroll run'),
  ]

  it('a query naming a retired client returns nothing', () => {
    const out = filterInProgressChecklists(all, {
      reportPeriod: wide,
      today: TODAY,
      clients: CLIENTS,
      query: 'zenith',
    })
    expect(out).toHaveLength(0)
  })

  it('an empty query still returns the retired client\'s checklists — history stays visible', () => {
    const out = filterInProgressChecklists(all, {
      reportPeriod: wide,
      today: TODAY,
      clients: CLIENTS,
      query: '',
    })
    expect(out.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('searching an ACTIVE client still works', () => {
    const out = filterInProgressChecklists(all, {
      reportPeriod: wide,
      today: TODAY,
      clients: CLIENTS,
      query: 'acme',
    })
    expect(out.map((c) => c.id)).toEqual(['a'])
  })
})

/**
 * DelayedPage's client-group search is inline (not an exported pure
 * function). contact-helpers.test.ts / activeBoard.test.ts don't demonstrate
 * a page-render pattern for a "search hides retired clients" case, but
 * delayed-tabs.test.tsx already renders this exact page — mirrored here.
 */
vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))

const A = 'emp-brit'
const ACTIVE_CLIENT = { id: 'client-acme', name: 'Acme Dental' }
const RETIRED_CLIENT = { id: 'client-gone', name: 'Gone Co', lifecycleStage: 'inactive' }

const checklistFor = (clientId: string, id: string): Checklist =>
  ({
    id,
    clientId,
    title: 'August close',
    dueDate: '2026-08-31',
    items: [
      {
        id: 'it-1',
        label: 'Bank rec',
        done: false,
        assigneeId: A,
        subItems: [],
        waitingOns: [
          {
            id: `wo-${id}`,
            blockerId: A,
            requestedBy: A,
            note: 'the bank statements',
            createdAt: '2026-08-05T15:00:00.000Z',
          },
        ],
      },
    ],
  }) as unknown as Checklist

let contextValue: AppContextValue

function signInAs(checklists: Checklist[]) {
  contextValue = {
    data: {
      clients: [ACTIVE_CLIENT, RETIRED_CLIENT],
      employees: [{ id: A, name: 'Brittany Fox', role: 'owner' }],
      checklists,
    } as unknown as AppData,
    activeEmployeeId: A,
    toggleChecklistItem: vi.fn(),
    toggleSubItem: vi.fn(),
    waitingOnDone: vi.fn(),
    waitingOnVerify: vi.fn(),
    waitingOnSendBack: vi.fn(),
    waitingOnQuestion: vi.fn(),
  } as unknown as AppContextValue
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/delayed']}>
      <DelayedPage />
    </MemoryRouter>,
  )

describe('DelayedPage search — inactive clients (featreq-60f24838)', () => {
  it('an empty query shows the retired client\'s delayed group', () => {
    signInAs([checklistFor(ACTIVE_CLIENT.id, 'cl-active'), checklistFor(RETIRED_CLIENT.id, 'cl-gone')])
    renderPage()

    expect(screen.getByText('Gone Co')).toBeInTheDocument()
    expect(screen.getByText('Acme Dental')).toBeInTheDocument()
  })

  it('typing the retired client\'s name hides its group', () => {
    signInAs([checklistFor(ACTIVE_CLIENT.id, 'cl-active'), checklistFor(RETIRED_CLIENT.id, 'cl-gone')])
    renderPage()

    const search = screen.getByRole('searchbox', { name: /Search delayed/i })
    fireEvent.change(search, { target: { value: 'gone co' } })

    expect(screen.queryByText('Gone Co')).not.toBeInTheDocument()
  })
})

/**
 * featreq-60f24838, sent back: the two retired clients were still in the
 * Checklists "Client" filter, "17 Signature" sitting at the top of it.
 *
 * `FilterBar` is the shared dropdown behind the Checklists and Gantt pages and
 * it mapped the raw `clients` prop. It is a filter, which normally means the
 * raw list — but what it filters is work still outstanding, and a client the
 * firm no longer works for has none. See the header of lib/clientLifecycle.ts.
 */
describe('FilterBar client dropdown — inactive clients (featreq-60f24838)', () => {
  const CLIENTS = [ACTIVE_CLIENT, RETIRED_CLIENT] as unknown as Client[]

  const renderBar = (search = '') =>
    render(
      <MemoryRouter initialEntries={[`/checklists${search}`]}>
        <FilterBar clients={CLIENTS} employees={[]} />
      </MemoryRouter>,
    )

  it('offers the active client and leaves the retired one out', () => {
    renderBar()
    const select = screen.getByLabelText('Client')
    const names = [...select.querySelectorAll('option')].map((option) => option.textContent)
    expect(names).toContain('Acme Dental')
    expect(names).not.toContain('Gone Co')
  })

  it('keeps a retired client that the filter is CURRENTLY set to', () => {
    // A bookmarked or shared `?client=<retired id>` URL. Dropping the option
    // would render a select whose value matches nothing — blank, and silently
    // re-pointing the filter on the next change.
    renderBar(`?client=${RETIRED_CLIENT.id}`)
    const select = screen.getByLabelText('Client') as HTMLSelectElement
    expect(select.value).toBe(RETIRED_CLIENT.id)
    expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toContain('Gone Co')
  })
})

/**
 * The two repeating-task lists dropped a retired client's setups only while
 * something was typed, so the names came straight back when the search box was
 * cleared. Both are inline inside unexported components of ChecklistsPage, so
 * the filter is pinned at its source — the same arrangement the server-route
 * suites use.
 */
describe('repeating-task lists hide retired clients with an EMPTY query too', () => {
  const pageSource = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../pages/ChecklistsPage.tsx'),
    'utf8',
  )

  it('the staff view narrows its base list, not just the search result', () => {
    // `liveGroups` is the inactive-free base; the query branch and the header
    // count both read it, so the count can never promise rows the list hides.
    expect(pageSource).toContain('const liveGroups = useMemo(()')
    expect(pageSource).toContain('if (!q) return liveGroups')
    expect(pageSource).toContain('if (liveGroups.length === 0) return null')
    expect(pageSource).toContain('const totalTemplates = liveGroups.reduce(')
  })

  it('the owner’s Repeating tasks manager narrows before the query, not inside it', () => {
    expect(pageSource).toContain('const liveRegularTemplates = allRegularTemplates.filter(')
    expect(pageSource).toContain('? liveRegularTemplates.filter(')
    expect(pageSource).toContain(': liveRegularTemplates')
  })
})
