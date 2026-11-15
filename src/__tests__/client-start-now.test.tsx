import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RecurringChecklistsBody } from '../pages/ClientDetailPage'
import { addDays, localDateOnly } from '../lib/utils'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist, ChecklistTemplate, Client } from '../lib/types'

/**
 * Start now on the client page - featreq-1e29020b. Brittany: "Need a way for
 * Lisa and Allison to start now on checklist they are on that do not populate
 * ... click under her client's checklist tab a start now on checklist in the
 * schedule area for them if it is not active."
 *
 * Nothing was failing to populate: a repeating task's checklist appears only a
 * few days before it is due. So this starts the NEXT one early, for a team
 * member as much as for the owner, and only while that repeating task has
 * nothing open.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))

const LISA = 'emp-lisa'
const OWNER = 'emp-patrice'
const CLIENT = { id: 'client-a', name: 'Associated Enterprises' } as Client
const today = localDateOnly()

const recipe = (over: Partial<ChecklistTemplate>): ChecklistTemplate =>
  ({
    clientId: CLIENT.id,
    assigneeId: LISA,
    frequency: 'weekly',
    // Ten days out: nothing has been made for it yet.
    nextDueDate: addDays(today, 10),
    active: true,
    viewerIds: [],
    editorIds: [],
    stages: [
      {
        id: 'st-1',
        name: 'Step 1',
        assigneeId: LISA,
        offsetDays: 0,
        viewerIds: [],
        editorIds: [],
        items: [{ id: 'ti-1', label: 'Enter transactions' }],
      },
    ],
    ...over,
  }) as unknown as ChecklistTemplate

const NOTHING_OPEN = recipe({ id: 'tmpl-quiet', title: 'Weekly Transactions' })
const HAS_OPEN = recipe({ id: 'tmpl-busy', title: 'Clear Client Email' })
const SWITCHED_OFF = recipe({ id: 'tmpl-off', title: 'Cash Flow', active: false })
/** A repeating task whose first step has no tasks: the schedule never makes these. */
const NO_TASKS = recipe({
  id: 'tmpl-empty',
  title: 'Client Meeting',
  stages: [
    { id: 'st-1', name: 'Step 1', assigneeId: LISA, offsetDays: 0, viewerIds: [], editorIds: [], items: [] },
  ] as unknown as ChecklistTemplate['stages'],
})

const OPEN_CHECKLIST = {
  id: 'cl-open',
  title: 'Clear Client Email',
  clientId: CLIENT.id,
  assigneeId: LISA,
  templateId: 'tmpl-busy',
  dueDate: addDays(today, 1),
  items: [{ id: 'i1', label: 'Clear it', done: false }],
} as unknown as Checklist
/** Last cycle's, finished: it does not count as something open. */
const FINISHED_CHECKLIST = {
  id: 'cl-done',
  title: 'Weekly Transactions',
  clientId: CLIENT.id,
  assigneeId: LISA,
  templateId: 'tmpl-quiet',
  dueDate: addDays(today, -4),
  items: [{ id: 'i1', label: 'Enter transactions', done: true }],
} as unknown as Checklist

let contextValue: AppContextValue
let generate: ReturnType<typeof vi.fn>

function signInAs(viewerId: string, isOwner: boolean, over: Partial<AppContextValue> = {}) {
  generate = vi.fn().mockResolvedValue({
    id: 'cl-new',
    title: 'Weekly Transactions',
    dueDate: '2026-11-20',
  })
  contextValue = {
    data: {
      clients: [CLIENT],
      employees: [
        { id: LISA, name: 'Lisa Mockabee', role: 'Bookkeeper' },
        { id: OWNER, name: 'Brittany Ferguson', role: 'Owner' },
      ],
      checklists: [OPEN_CHECKLIST, FINISHED_CHECKLIST],
      recycledChecklists: [],
      checklistTemplates: [NOTHING_OPEN, HAS_OPEN, SWITCHED_OFF, NO_TASKS],
      timeEntries: [],
    } as unknown as AppData,
    role: isOwner ? 'owner' : 'employee',
    activeEmployeeId: viewerId,
    ownerMode: isOwner,
    previewMode: false,
    addChecklistTemplate: vi.fn(),
    createChecklist: vi.fn(),
    generateChecklistFromTemplate: generate,
    updateChecklistTemplate: vi.fn(),
    applyTemplateToClient: vi.fn(),
    ...over,
  } as unknown as AppContextValue
}

const renderSection = () =>
  render(
    <MemoryRouter>
      <RecurringChecklistsBody client={CLIENT} data={contextValue.data} />
    </MemoryRouter>,
  )

/** The repeating-task row (not an Upcoming row) for a title. */
const recipeRow = (title: string) => {
  const row = screen
    .getAllByText(title)
    .map((node) => node.closest('li') as HTMLElement)
    .find((item) => item && within(item).queryByText(/^Assignee:/))
  if (!row) throw new Error(`no repeating-task row for ${title}`)
  return row
}

describe('Start now on a client’s repeating tasks', () => {
  beforeEach(() => {
    signInAs(LISA, false)
  })

  it('is offered to a team member on a repeating task with nothing open', () => {
    renderSection()
    expect(within(recipeRow('Weekly Transactions')).getByRole('button', { name: 'Start now' })).toBeInTheDocument()
  })

  it('is not offered while that repeating task already has a checklist open', () => {
    renderSection()
    expect(within(recipeRow('Clear Client Email')).queryByRole('button', { name: 'Start now' })).not.toBeInTheDocument()
  })

  it('is not offered on a repeating task that is switched off', () => {
    renderSection()
    expect(within(recipeRow('Cash Flow')).queryByRole('button', { name: 'Start now' })).not.toBeInTheDocument()
  })

  it('is not offered on a repeating task whose first step has no tasks', () => {
    renderSection()
    expect(within(recipeRow('Client Meeting')).queryByRole('button', { name: 'Start now' })).not.toBeInTheDocument()
  })

  it('is not offered on a repeating task the schedule itself would never run', () => {
    signInAs(LISA, false)
    ;(contextValue.data as AppData).checklistTemplates = [
      // A cadence with no Next due date, and a one-year schedule whose year is over.
      recipe({ id: 'tmpl-nodate', title: 'No date task', nextDueDate: '' }),
      recipe({
        id: 'tmpl-stale',
        title: 'Old one-year task',
        frequency: 'specific-months',
        scheduledMonths: [3],
        repeatAnnually: false,
        scheduleYear: 2020,
        nextDueDate: '',
      } as Partial<ChecklistTemplate>),
      recipe({ id: 'tmpl-nomonths', title: 'No months task', frequency: 'specific-months', scheduledMonths: [], nextDueDate: '' }),
    ]
    renderSection()
    expect(screen.queryByRole('button', { name: 'Start now' })).not.toBeInTheDocument()
  })

  it('asks once, and Cancel starts nothing', () => {
    renderSection()
    const row = recipeRow('Weekly Transactions')
    fireEvent.click(within(row).getByRole('button', { name: 'Start now' }))
    expect(generate).not.toHaveBeenCalled()
    const ask = within(row).getByRole('group', { name: 'Start the next checklist now' })
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }))
    expect(generate).not.toHaveBeenCalled()
    expect(within(row).getByRole('button', { name: 'Start now' })).toBeInTheDocument()
  })

  it('starts the NEXT one on the schedule and says what was started, with a way to open it', async () => {
    renderSection()
    const row = recipeRow('Weekly Transactions')
    fireEvent.click(within(row).getByRole('button', { name: 'Start now' }))
    fireEvent.click(within(row).getByRole('button', { name: 'Yes, start it' }))
    expect(generate).toHaveBeenCalledWith('tmpl-quiet', { next: true })
    const said = await screen.findByText(/Weekly Transactions is started, due Nov 20\./)
    expect(within(said).getByRole('link', { name: 'Open it' })).toHaveAttribute(
      'href',
      '/checklists?focus=cl-new',
    )
  })

  it('says why when the server refuses', async () => {
    generate.mockRejectedValueOnce(new Error('This client is not active, so its repeating tasks are not started.'))
    renderSection()
    const row = recipeRow('Weekly Transactions')
    fireEvent.click(within(row).getByRole('button', { name: 'Start now' }))
    fireEvent.click(within(row).getByRole('button', { name: 'Yes, start it' }))
    expect(
      await screen.findByText(
        'Weekly Transactions could not be started. This client is not active, so its repeating tasks are not started.',
      ),
    ).toBeInTheDocument()
  })

  it('is also on the first Upcoming row of that repeating task, and only the first', async () => {
    renderSection()
    const upcoming = screen.getByText('Upcoming (next 60 days)').parentElement as HTMLElement
    const rows = within(upcoming)
      .getAllByText('Weekly Transactions')
      .map((node) => node.closest('li') as HTMLElement)
    expect(rows.length).toBeGreaterThan(1)
    expect(within(rows[0]).getByRole('button', { name: 'Start now' })).toBeInTheDocument()
    for (const later of rows.slice(1)) {
      expect(within(later).queryByRole('button', { name: 'Start now' })).not.toBeInTheDocument()
    }
    // The repeating task with something open offers it nowhere.
    for (const node of within(upcoming).queryAllByText('Clear Client Email')) {
      expect(within(node.closest('li') as HTMLElement).queryByRole('button', { name: 'Start now' })).not.toBeInTheDocument()
    }
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Start now' }))
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Yes, start it' }))
    await waitFor(() => expect(generate).toHaveBeenCalledWith('tmpl-quiet', { next: true }))
  })

  it('is offered to the owner too', () => {
    signInAs(OWNER, true)
    renderSection()
    expect(within(recipeRow('Weekly Transactions')).getByRole('button', { name: 'Start now' })).toBeInTheDocument()
  })

  it('is not offered in preview, which is read-only', () => {
    signInAs(OWNER, true, { previewMode: true } as Partial<AppContextValue>)
    renderSection()
    expect(screen.queryByRole('button', { name: 'Start now' })).not.toBeInTheDocument()
  })
})
