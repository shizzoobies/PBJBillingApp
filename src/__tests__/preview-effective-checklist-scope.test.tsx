import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import App from '../App'
import { installFetchMock, OWNER_SESSION } from './helpers'
import { createSeedData } from '../lib/seed'
import { localDateOnly } from '../lib/utils'
import type { Checklist, TimeEntry } from '../lib/types'

/**
 * Preview mode must show the PREVIEWED person's work, not the owner's.
 *
 * The featreq-9b47ab5b leak: `visibleChecklists` (and its sibling visibility
 * memos) keyed off the SESSION role/id, which stays "owner" while an owner
 * previews a staff member — so every consumer (the Checklists In-progress
 * list, the overdue pin, the summary strip) still rendered the owner-wide
 * feed. "Reviewing as Lisa" showed the owner's board.
 *
 * These tests mount the REAL `<App>` (the same harness as app-boot.test.tsx)
 * because the bug was in App.tsx's memo WIRING, not in `checklistsVisibleTo`
 * itself — a context-mocking test would have passed right through it. They
 * drive preview exactly as the owner does: the Dashboard's "Viewing as"
 * picker.
 */

const OWNER_ID = OWNER_SESSION.id // emp-patrice in the seed
const JORDAN_ID = 'emp-jordan'

function localOffset(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return localDateOnly(date)
}

const checklist = (over: Partial<Checklist>): Checklist =>
  ({
    clientId: 'client-clover',
    items: [{ id: 'it-1', label: 'Step', done: false }],
    ...over,
  }) as Checklist

const entry = (over: { id: string; employeeId: string; clientId: string }): TimeEntry =>
  ({
    date: localOffset(0),
    minutes: 60,
    description: 'Test work',
    billable: true,
    approvalStatus: 'approved',
    entryMethod: 'timer',
    ...over,
  }) as TimeEntry

function buildAppData() {
  const data = createSeedData()
  // The seed's recurring templates would materialize fresh instances on boot
  // (App runs ensureRecurringChecklists over the fetched workspace), handing
  // Jordan real overdue work and muddying the assertions. Drop them — this
  // test is about scoping the fixed set below.
  data.checklistTemplates = []
  // Pinned rather than inherited from the seed: `visibleClientIds` unions the
  // assigned team, the viewer's checklists AND the viewer's time entries'
  // clients, and the billable-time tile counts entries in the CURRENT billing
  // month — so both assertions below depend on exactly who logged what, where,
  // and when. Jordan's entries stay on his team clients (clover, riverbend) so
  // the visible-clients count stays 2; dates are "today" so every entry falls
  // inside the current billing month on whatever day this runs.
  data.timeEntries = [
    entry({ id: 'time-o1', employeeId: OWNER_ID, clientId: 'client-northstar' }),
    entry({ id: 'time-o2', employeeId: 'emp-avery', clientId: 'client-northstar' }),
    entry({ id: 'time-j1', employeeId: JORDAN_ID, clientId: 'client-clover' }),
    entry({ id: 'time-j2', employeeId: JORDAN_ID, clientId: 'client-riverbend' }),
  ]
  data.checklists = [
    // The owner's own work — overdue, so the pin has something to show her.
    checklist({
      id: 'cl-owner-overdue',
      title: 'Owner overdue payroll',
      assigneeId: OWNER_ID,
      dueDate: localOffset(-1),
    }),
    // Jordan's work — due today, in progress, not overdue.
    checklist({
      id: 'cl-jordan',
      title: 'Jordan monthly close',
      assigneeId: JORDAN_ID,
      dueDate: localOffset(0),
    }),
  ]
  return data
}

// No group-expansion helper on purpose: both fixture tasks land in groups the
// In-progress list ships OPEN ("Overdue" and "Due this week" are
// defaultOpen) — and clicking those headings would collapse them. Presence
// assertions use findAllByText so they wait out the mocked app-data fetch.

const navTo = (name: string) => {
  fireEvent.click(screen.getByRole('link', { name }))
}

describe('owner previewing a staff member: checklist surfaces scope to them', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/')
    installFetchMock({ sessionUser: OWNER_SESSION, appData: buildAppData() })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  async function bootAndEnterPreview() {
    render(<App />)
    await screen.findByRole('navigation')
    // Let the boot redirect ('/' → /dashboard) LAND before navigating: it
    // commits asynchronously, and a link clicked in the gap gets yanked right
    // back to the dashboard (the original flake in this file). The "Viewing
    // as" picker only renders once the dashboard is actually on screen.
    await screen.findByLabelText(/viewing as/i)

    // Sanity: outside preview the owner sees everything — both tasks in the
    // In-progress list and her overdue task pinned.
    navTo('Checklists')
    expect(await screen.findAllByText('Owner overdue payroll')).not.toHaveLength(0)
    expect(await screen.findAllByText('Jordan monthly close')).not.toHaveLength(0)
    expect(document.querySelector('.overdue-pin')).not.toBeNull()

    // Enter preview the way the owner does: Dashboard → "Viewing as" picker.
    navTo('Dashboard')
    const picker = await screen.findByLabelText(/viewing as/i)
    fireEvent.change(picker, { target: { value: JORDAN_ID } })
    await screen.findByText(/Viewing as Jordan Ellis/)
  }

  it('the In-progress list and overdue pin show exactly the previewed person’s work', async () => {
    await bootAndEnterPreview()

    navTo('Checklists')

    // Jordan's task is there; the owner's is gone from every surface.
    expect(await screen.findAllByText('Jordan monthly close')).not.toHaveLength(0)
    expect(screen.queryAllByText('Owner overdue payroll')).toHaveLength(0)

    // Jordan has nothing overdue, so the pinned Overdue panel must be absent —
    // before the fix it stayed up showing the OWNER's overdue count.
    expect(document.querySelector('.overdue-pin')).toBeNull()
  })

  it('the summary strip scopes clients, entries and checklists to the previewed person', async () => {
    await bootAndEnterPreview()

    // The strip renders on /time for non-owner views — which preview now is.
    navTo('Time')
    // Sanity, not a leak guard: this tile re-filters by the (already
    // effective) `effectiveUser.id`, so it read 1 even before the fix.
    expect(await screen.findByText('1 assigned checklists')).toBeInTheDocument()

    // "Visible clients" reads `visibleClients` — a memo that leaked. Jordan
    // resolves to 2 of the seed's 3 clients (team + his checklists + his time
    // entries, all on clover/riverbend); before the fix this tile said 3, the
    // owner's count.
    const clientsTile = screen.getByText('Visible clients').closest('.summary-item')
    expect(clientsTile).not.toBeNull()
    expect(clientsTile?.querySelector('strong')?.textContent).toBe('2')

    // "My billable time" reads `visibleEntries` — the third memo that leaked.
    // Jordan logged 2 of the fixture's 4 current-month entries; before the fix
    // this detail line counted all 4.
    const timeTile = screen.getByText('My billable time').closest('.summary-item')
    expect(timeTile).not.toBeNull()
    expect(timeTile?.querySelector('small')?.textContent).toMatch(/^2 in /)
  })

  it('exiting preview restores the owner-wide feed', async () => {
    await bootAndEnterPreview()

    fireEvent.click(screen.getByRole('button', { name: 'Exit preview' }))
    await screen.findByRole('link', { name: 'Checklists' })
    expect(screen.queryByText(/Viewing as Jordan Ellis/)).not.toBeInTheDocument()

    navTo('Checklists')
    expect(await screen.findAllByText('Owner overdue payroll')).not.toHaveLength(0)
    expect(await screen.findAllByText('Jordan monthly close')).not.toHaveLength(0)
    expect(document.querySelector('.overdue-pin')).not.toBeNull()
  })
})
