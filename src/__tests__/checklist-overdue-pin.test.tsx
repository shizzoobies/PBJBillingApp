import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { ChecklistsPage } from '../pages/ChecklistsPage'
import { checklistsVisibleTo } from '../lib/checklistVisibility'
import { overdueChecklists } from '../lib/overdueChecklists'
import { isChecklistSkipped } from '../../lib/checklist-skip.js'
import { addDays, groupChecklist, localDateOnly } from '../lib/utils'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist, Client } from '../lib/types'

/**
 * The pinned "Overdue — needs attention" panel.
 *
 * The load-bearing rule is that NO view state can hide it: the reported problem
 * was that overdue tasks "can get buried", so the panel has to survive the wrong
 * tab, the filter bar and the group-by toggle all at once. The other half is
 * that it must not cry wolf — a quietly-skipped occurrence is not late, and a
 * colleague's overdue task is not a staff member's problem.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))

const LISA = 'emp-lisa'
const DANA = 'emp-dana'
const OWNER = 'emp-patrice'

const TODAY = localDateOnly()

const SHARED: Client = {
  id: 'client-shared',
  name: 'Shared Books LLC',
  assignedBookkeeperIds: [LISA],
} as unknown as Client
const OTHER: Client = {
  id: 'client-other',
  name: 'Other Co',
  assignedBookkeeperIds: [DANA],
} as unknown as Client

const checklist = (over: Partial<Checklist>): Checklist =>
  ({
    clientId: SHARED.id,
    assigneeId: LISA,
    viewerIds: [],
    editorIds: [],
    items: [{ id: `${over.id}-step`, label: 'Reconcile', done: false }],
    ...over,
  }) as Checklist

const LONG_LATE = checklist({
  id: 'cl-long-late',
  title: 'Q2 sales tax filing',
  dueDate: addDays(TODAY, -20),
})
const JUST_LATE = checklist({
  id: 'cl-just-late',
  title: 'Bank reconciliation',
  dueDate: addDays(TODAY, -3),
})
const COLLEAGUES = checklist({
  id: 'cl-colleague',
  title: "Dana's payroll run",
  clientId: OTHER.id,
  assigneeId: DANA,
  dueDate: addDays(TODAY, -30),
})
const SKIPPED = checklist({
  id: 'cl-skipped',
  title: 'Skipped month-end close',
  dueDate: addDays(TODAY, -15),
  templateId: 'tmpl-on',
  skippedAt: '2026-08-13T12:00:00.000Z',
  skippedBy: LISA,
})
const UPCOMING = checklist({
  id: 'cl-upcoming',
  title: 'Next month close',
  dueDate: addDays(TODAY, 10),
})
const FINISHED_LATE = checklist({
  id: 'cl-finished',
  title: 'Already finished cleanup',
  dueDate: addDays(TODAY, -9),
  items: [{ id: 'cl-finished-step', label: 'Reconcile', done: true }],
})

const ALL_TASKS = [LONG_LATE, JUST_LATE, COLLEAGUES, SKIPPED, UPCOMING, FINISHED_LATE]

let contextValue: AppContextValue
let setReportPeriod: ReturnType<typeof vi.fn>

function signInAs(
  viewerId: string,
  isOwner: boolean,
  checklists: Checklist[] = ALL_TASKS,
  reportPeriod = { preset: 'custom' as const, from: '2020-01-01', to: '2030-12-31' },
) {
  setReportPeriod = vi.fn()
  const data = {
    clients: [SHARED, OTHER],
    employees: [
      { id: LISA, name: 'Lisa Chen', role: 'Bookkeeper' },
      { id: DANA, name: 'Dana Reid', role: 'Bookkeeper' },
      { id: OWNER, name: 'Patrice Owner', role: 'Owner' },
    ],
    checklists,
    checklistTemplates: [],
    recycledChecklists: [],
    timeEntries: [],
    serviceCategories: [],
  } as unknown as AppData

  // Exactly what App.tsx does: skipped occurrences are filtered OUT of the
  // shared "my work" narrowing, then that list is scoped to the viewer.
  const active = checklists.filter((entry) => !isChecklistSkipped(entry))

  contextValue = {
    data,
    ownerMode: isOwner,
    role: isOwner ? 'owner' : 'employee',
    activeEmployeeId: viewerId,
    effectiveUser: { id: viewerId, role: isOwner ? 'owner' : 'employee' },
    sessionUser: { id: viewerId, role: isOwner ? 'owner' : 'employee' },
    visibleChecklists: checklistsVisibleTo(active, { viewerId, isOwner }),
    visibleClients: isOwner ? [SHARED, OTHER] : [SHARED],
    serviceCategories: [],
    checklistSkips: [],
    skipChecklistOccurrence: vi.fn(),
    reviewChecklistSkip: vi.fn(),
    pendingTaskEditChecklistIds: new Set<string>(),
    pendingItemDeletionKeys: new Set<string>(),
    pendingTaskEdits: [],
    itemDeletionRequests: [],
    reportPeriod,
    setReportPeriod,
    addChecklist: vi.fn(),
    addSeriesChecklistItem: vi.fn(),
    addSubItem: vi.fn(),
    addSubSubItem: vi.fn(),
    applyTemplateToClient: vi.fn(),
    approveChecklistDeletion: vi.fn(),
    bulkAddChecklistItems: vi.fn(),
    deleteChecklist: vi.fn(),
    deleteChecklistItem: vi.fn(),
    emptyChecklistRecycleBin: vi.fn(),
    rejectChecklistDeletion: vi.fn(),
    removeSubItem: vi.fn(),
    removeSubSubItem: vi.fn(),
    reorderChecklistItems: vi.fn(),
    restoreChecklist: vi.fn(),
    setChecklistViewers: vi.fn(),
    toggleChecklistItem: vi.fn(),
    toggleSubItem: vi.fn(),
    toggleSubSubItem: vi.fn(),
    updateChecklistItem: vi.fn(),
    updateChecklistMeta: vi.fn(),
    updateSubItemWaiting: vi.fn(),
  } as unknown as AppContextValue
}

/** Reports the live URL so a jump-to-task click can be asserted on. */
function LocationProbe() {
  const location = useLocation()
  return <output data-testid="url">{`${location.pathname}${location.search}`}</output>
}

const renderPage = (entry = '/checklists') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <ChecklistsPage />
      <LocationProbe />
    </MemoryRouter>,
  )

/** The pinned panel, or null when it isn't on the page at all. */
const pin = () => screen.queryByRole('region', { name: /^Overdue/i })

/**
 * Expand the pin if it is collapsed (the default since Alex's 2026-08-18
 * revision — the standing element is a slim bar; rows are on demand). Folded
 * into the queries below so every row assertion exercises the real path a
 * person takes: see the count, click the bar, read the rows.
 */
const expandPin = (panel: HTMLElement) => {
  const toggle = panel.querySelector('button.overdue-pin-heading') as HTMLElement
  if (toggle && toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle)
}

/** Task titles inside the pin, in render order (expands the bar first). */
const pinnedTitles = (panel: HTMLElement) => {
  expandPin(panel)
  return [...panel.querySelectorAll('.overdue-pin-title')].map((node) => node.textContent)
}

// On this page the client name leads each card and the task name sits under it
// (`.checklist-card-title-sub`); `.checklist-card-title` is the client-page
// layout. Accept either so these keep working if that flips.
const CARD_TITLE = '.checklist-card-title-sub, .checklist-card-title'

/** The task card in the In-progress list below (NOT the pin), if it rendered. */
const cardFor = (title: string) =>
  [...document.querySelectorAll('article.checklist-block')].find(
    (node) => node.querySelector(CARD_TITLE)?.textContent === title,
  )

/** Task titles filed under the list's own collapsible "Overdue" group. */
const overdueGroupTitles = () => {
  const group = [...document.querySelectorAll('.checklist-group')].find(
    (node) => node.querySelector('.checklist-group-header strong')?.textContent === 'Overdue',
  )
  return [...(group?.querySelectorAll(CARD_TITLE) ?? [])].map((node) => node.textContent)
}

const clickPinned = (title: string) => {
  expandPin(pin() as HTMLElement)
  fireEvent.click(
    within(pin() as HTMLElement).getByText(title).closest('button') as HTMLElement,
  )
}

describe('the pinned overdue panel', () => {
  it('starts as a collapsed bar: count visible, rows hidden until the bar is clicked', () => {
    signInAs(LISA, false)
    renderPage()

    const panel = pin() as HTMLElement
    expect(panel).toBeInTheDocument()
    // The count is the standing signal…
    expect(within(panel).getByText('2')).toBeInTheDocument()
    // …and the rows are on demand.
    expect(panel.querySelectorAll('.overdue-pin-title').length).toBe(0)

    const toggle = panel.querySelector('button.overdue-pin-heading') as HTMLElement
    fireEvent.click(toggle)
    expect(panel.querySelectorAll('.overdue-pin-title').length).toBe(2)
    fireEvent.click(toggle)
    expect(panel.querySelectorAll('.overdue-pin-title').length).toBe(0)
  })

  it('lists a staff member’s overdue tasks with client, title, lateness and assignee', () => {
    signInAs(LISA, false)
    renderPage()

    const panel = pin() as HTMLElement
    expect(panel).toBeInTheDocument()
    expect(within(panel).getByText('2')).toBeInTheDocument()

    expandPin(panel)
    const row = within(panel).getByText('Q2 sales tax filing').closest('button') as HTMLElement
    expect(within(row).getByText('Shared Books LLC')).toBeInTheDocument()
    expect(within(row).getByText('20 days overdue')).toBeInTheDocument()
    expect(within(row).getByText('Lisa Chen')).toBeInTheDocument()
  })

  it('puts the oldest overdue task first', () => {
    signInAs(LISA, false)
    renderPage()

    expect(pinnedTitles(pin() as HTMLElement)).toEqual([
      'Q2 sales tax filing',
      'Bank reconciliation',
    ])
  })

  // The absence assertions below EXPAND first: against a collapsed bar they
  // would pass vacuously (nothing renders collapsed, including bugs).
  it('never shows a skipped cycle — a deliberately deferred task is not late', () => {
    signInAs(LISA, false)
    renderPage()

    const panel = pin() as HTMLElement
    expandPin(panel)
    expect(within(panel).getByText('Q2 sales tax filing')).toBeInTheDocument() // non-vacuous
    expect(within(panel).queryByText('Skipped month-end close')).not.toBeInTheDocument()
  })

  it('leaves out work that is not overdue: still upcoming, or finished after its date', () => {
    signInAs(LISA, false)
    const panel = (renderPage(), pin() as HTMLElement)
    expandPin(panel)

    expect(within(panel).getByText('Q2 sales tax filing')).toBeInTheDocument() // non-vacuous
    expect(within(panel).queryByText('Next month close')).not.toBeInTheDocument()
    expect(within(panel).queryByText('Already finished cleanup')).not.toBeInTheDocument()
  })

  it('scopes to the viewer: staff see only their own overdue work', () => {
    signInAs(LISA, false)
    renderPage()

    const panel = pin() as HTMLElement
    expandPin(panel)
    expect(within(panel).getByText('Q2 sales tax filing')).toBeInTheDocument() // non-vacuous
    expect(within(panel).queryByText("Dana's payroll run")).not.toBeInTheDocument()
  })

  it('scopes to the viewer: an owner sees the whole firm’s', () => {
    signInAs(OWNER, true)
    renderPage()

    expect(pinnedTitles(pin() as HTMLElement)).toEqual([
      "Dana's payroll run",
      'Q2 sales tax filing',
      'Bank reconciliation',
    ])
  })

  it('renders nothing at all when nothing is overdue — no praise banner', () => {
    signInAs(LISA, false, [UPCOMING, FINISHED_LATE])
    renderPage()

    expect(pin()).not.toBeInTheDocument()
  })
})

describe('no view state can bury it', () => {
  it('survives another task-area tab, every filter and the group-by toggle at once', () => {
    signInAs(LISA, false)
    renderPage(
      '/checklists?area=repeating&status=completed&client=client-other&assignee=emp-dana&group=client',
    )

    expect(pinnedTitles(pin() as HTMLElement)).toEqual([
      'Q2 sales tax filing',
      'Bank reconciliation',
    ])
  })

  it('shows overdue work the report period excludes — the period is the usual burial', () => {
    // "This month" style period: it starts after both tasks went late, so
    // neither is anywhere in the list below.
    signInAs(LISA, false, ALL_TASKS, {
      preset: 'custom',
      from: addDays(TODAY, -1),
      to: addDays(TODAY, 30),
    })
    renderPage()

    expect(pinnedTitles(pin() as HTMLElement)).toEqual([
      'Q2 sales tax filing',
      'Bank reconciliation',
    ])
  })
})

describe('clicking a pinned task', () => {
  it('jumps to its card and clears the params that were hiding it', () => {
    signInAs(LISA, false)
    renderPage(
      '/checklists?area=repeating&focusTemplate=tmpl-x&status=completed&client=client-other&assignee=emp-dana',
    )

    clickPinned('Bank reconciliation')

    const url = screen.getByTestId('url').textContent ?? ''
    expect(url).toContain('focus=cl-just-late')
    expect(url).not.toContain('area=')
    // Outranks `focus` in resolveTaskArea, so a stale one would swallow the jump.
    expect(url).not.toContain('focusTemplate=')
    expect(url).not.toContain('status=')
    expect(url).not.toContain('client=')
    expect(url).not.toContain('assignee=')
  })

  it('renders the card even when the report period excludes it', () => {
    // A "this month" style period: the task went late before it starts, so the
    // card is nowhere in the list until the jump exempts it.
    signInAs(LISA, false, ALL_TASKS, {
      preset: 'custom',
      from: addDays(TODAY, -1),
      to: addDays(TODAY, 30),
    })
    renderPage()

    expect(cardFor('Q2 sales tax filing')).toBeUndefined()

    clickPinned('Q2 sales tax filing')

    expect(cardFor('Q2 sales tax filing')).toBeTruthy()
  })

  it('never touches the report period — Timesheet shares that preference', () => {
    const period = { preset: 'custom' as const, from: addDays(TODAY, -1), to: addDays(TODAY, 30) }
    signInAs(LISA, false, ALL_TASKS, period)
    renderPage()

    clickPinned('Q2 sales tax filing')

    expect(setReportPeriod).not.toHaveBeenCalled()
    expect(contextValue.reportPeriod).toEqual(period)
  })
})

describe('the pin and the list agree on what "overdue" means', () => {
  it('pins exactly what the In-progress list files under its Overdue group', () => {
    // Both sides run the real predicate through the real UI: if a future edit to
    // `groupChecklist` moved one, this splits.
    signInAs(OWNER, true)
    renderPage()

    expect(pinnedTitles(pin() as HTMLElement)).toEqual(overdueGroupTitles())
  })

  it('agrees with groupChecklist itself, task by task', () => {
    for (const task of ALL_TASKS) {
      const pinned = overdueChecklists([task], TODAY).length === 1
      expect(pinned).toBe(groupChecklist(task, TODAY) === 'overdue')
    }
  })

  it('goes by the EFFECTIVE due date: an open step late inside a task not yet due', () => {
    // The task's own deadline is ten days out, but a step was due five days ago.
    // That is late, and the panel has to say so.
    const stepLate = checklist({
      id: 'cl-step-late',
      title: 'Year-end package',
      dueDate: addDays(TODAY, 10),
      items: [
        { id: 'cl-step-late-a', label: 'Chase statements', done: false, dueDate: addDays(TODAY, -5) },
        { id: 'cl-step-late-b', label: 'File', done: false },
      ],
    } as Partial<Checklist>)

    signInAs(LISA, false, [stepLate, UPCOMING])
    renderPage()

    expandPin(pin() as HTMLElement)
    const row = within(pin() as HTMLElement)
      .getByText('Year-end package')
      .closest('button') as HTMLElement
    expect(within(row).getByText('5 days overdue')).toBeInTheDocument()
  })
})
