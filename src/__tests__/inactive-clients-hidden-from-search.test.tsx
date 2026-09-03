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
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
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
