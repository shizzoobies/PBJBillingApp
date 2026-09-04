import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { createSeedData } from '../lib/seed'
import type { AppData, ChecklistTemplate, SessionUser } from '../lib/types'
import { installFetchMock } from './helpers'

/**
 * What a STAFF member may pick in the time dropdowns, and count as a visible
 * client, after the 2026-09 team/visibility split.
 *
 * Before the split, being handed a task on a client silently WROTE you onto
 * that client's team (`grantClientVisibility`), so "the team list" and "what I
 * can see" were the same set and App.tsx could read `assignedBookkeeperIds`
 * for both. The split stopped those implicit writes: the team is now only what
 * an owner picked, and visibility is COMPUTED as team ∪ the clients you hold a
 * task on (`visibleClientIdsForUser`, lib/data-scope.js).
 *
 * That makes two App.tsx memos load-bearing in a way they were not before, and
 * both were wrong:
 *   - `timeTrackingClients` filtered on the TEAM alone. After the production
 *     team-list reset — where nearly every membership turns out to be
 *     task-derived — that empties the timer and manual-entry dropdowns for the
 *     staff, which is to say they cannot log time at all.
 *   - `visibleClientIds` unioned the team with the viewer's CHECKLISTS only,
 *     missing recurring templates and template STAGES. Real work is assigned
 *     at the stage level, so a staffer could be the named assignee of a stage
 *     on a client and have that client vanish from every SPA surface while the
 *     server happily served it.
 *
 * The fixture separates the three cases cleanly, and reaches the task-only
 * client through a template STAGE — the source the hand-rolled union missed,
 * and the one that accounts for most of Lisa's 35 clients in production.
 *
 * The real `<App>` is mounted, as the staff member rather than an owner
 * previewing one, because the defect was in the memo WIRING; a
 * context-mocking test would hand itself the answer.
 */

const JORDAN: SessionUser = {
  id: 'emp-jordan',
  name: 'Jordan Ellis',
  email: 'jordan@example.com',
  role: 'employee',
  staffRole: 'Bookkeeper',
  totpEnabled: false,
}

const TEAM_CLIENT = 'Clover Ridge Dental' // owner-picked team, no task
const TASK_CLIENT = 'Northstar Wellness Co.' // template stage only, NOT on the team
const STRANGER_CLIENT = 'Riverbend Market' // neither — must stay invisible

/** A client-bound template whose STAGE (not the template) is Jordan's. */
const stageOnlyTemplate = (): ChecklistTemplate =>
  ({
    id: 'tmpl-northstar-payroll',
    title: 'Northstar payroll',
    clientId: 'client-northstar',
    // The template itself belongs to someone else: the ONLY thing tying Jordan
    // to Northstar is the stage below.
    assigneeId: 'emp-avery',
    frequency: 'monthly',
    nextDueDate: '2099-01-31',
    // Switched off so the materializer generates nothing — an instance would
    // hand Jordan a CHECKLIST on Northstar, and then the old checklist-only
    // union would pass this test for the wrong reason.
    active: false,
    viewerIds: [],
    editorIds: [],
    stages: [
      {
        id: 'stage-northstar-1',
        name: 'Stage 1',
        assigneeId: 'emp-jordan',
        offsetDays: 0,
        viewerIds: [],
        editorIds: [],
        items: [{ id: 'tmpl-northstar-payroll-1', label: 'Run payroll' }],
      },
    ],
  }) as unknown as ChecklistTemplate

function buildAppData(): AppData {
  const data = createSeedData()
  data.checklists = []
  data.timeEntries = []
  data.checklistTemplates = [stageOnlyTemplate()]
  data.clients = data.clients.map((client) => {
    if (client.id === 'client-clover') return { ...client, assignedBookkeeperIds: ['emp-jordan'] }
    // Northstar and Riverbend: nobody picked Jordan for either.
    return { ...client, assignedBookkeeperIds: ['emp-avery'] }
  })
  return data
}

/** The client names offered by the topbar's Start-a-timer dialog. */
async function timePickerOptions(): Promise<string[]> {
  fireEvent.click(screen.getByRole('button', { name: /start timer/i }))
  const dialog = await screen.findByRole('dialog', { name: /start a timer/i })
  const picker = within(dialog).getByLabelText('Client')
  // The workspace arrives over fetch, so the picker fills a tick later — wait
  // for real options rather than the lone "Choose client" placeholder.
  await waitFor(() => expect(within(picker).getAllByRole('option').length).toBeGreaterThan(1))
  return within(picker)
    .getAllByRole('option')
    .map((option) => option.textContent ?? '')
}

describe('a staff member’s time picker and visible clients', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/dashboard')
    window.localStorage.clear()
    installFetchMock({ sessionUser: JORDAN, appData: buildAppData() })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    window.localStorage.clear()
  })

  it('offers the clients they can SEE — the team plus a client they only hold a task on', async () => {
    render(<App />)
    await screen.findByRole('navigation')

    const options = await timePickerOptions()

    expect(options).toContain(TEAM_CLIENT)
    // The regression: filtering on `assignedBookkeeperIds` alone drops this
    // one, and after the team-list reset it drops nearly everything.
    expect(options).toContain(TASK_CLIENT)
    expect(options).not.toContain(STRANGER_CLIENT)
  })

  it('counts a template-stage client among their visible clients', async () => {
    render(<App />)
    await screen.findByRole('navigation')

    // The summary strip on /time renders for non-owner views; its "Visible
    // clients" tile reads `visibleClients`.
    fireEvent.click(screen.getByRole('link', { name: 'Time' }))
    await screen.findByText('Visible clients')

    await waitFor(() => {
      const tile = screen.getByText('Visible clients').closest('.summary-item')
      // Clover (team) + Northstar (template stage). Riverbend is neither, and
      // the old checklist-only union counted 1.
      expect(tile?.querySelector('strong')?.textContent).toBe('2')
    })
  })
})
