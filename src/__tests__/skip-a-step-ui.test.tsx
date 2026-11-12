import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChecklistsPage } from '../pages/ChecklistsPage'
import { checklistsVisibleTo } from '../lib/checklistVisibility'
import { LAST_STEP_SKIP_NOTE, isChecklistSkipped } from '../../lib/checklist-skip.js'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist, ChecklistTemplate, Client } from '../lib/types'

/**
 * Skip a step (featreq-7e1827e0) on screen: the recipe setting, the card's button
 * and dialog, and the line the next person sees. The rules are pinned in
 * skip-a-step.test.ts; the store in db/store-staleness.test.mjs.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))

const LISA = 'emp-lisa'
const ALLISON = 'emp-allison'
const BRITTANY = 'emp-patrice'

const CLIENT: Client = {
  id: 'client-mail',
  name: 'Inbox Holdings',
  assignedBookkeeperIds: [LISA, ALLISON],
} as unknown as Client

const stages = [
  { id: 'st-0', name: 'Clear Client provided email', assigneeId: LISA, offsetDays: 0, viewerIds: [], editorIds: [], items: [{ id: 'ti-0', label: 'Clear' }] },
  { id: 'st-1', name: 'Review', assigneeId: ALLISON, offsetDays: 0, viewerIds: [], editorIds: [], items: [{ id: 'ti-1', label: 'Review' }] },
  { id: 'st-2', name: 'Sign off', assigneeId: BRITTANY, offsetDays: 0, viewerIds: [], editorIds: [], items: [{ id: 'ti-2', label: 'Sign off' }] },
]

const recipe = (id: string, over: Partial<ChecklistTemplate> = {}) =>
  ({
    id,
    title: id === 'tmpl-step' ? 'Check email' : 'Whole recipe',
    clientId: CLIENT.id,
    assigneeId: LISA,
    frequency: 'monthly',
    nextDueDate: '2026-09-30',
    active: true,
    skipAllowed: true,
    skipMode: 'step',
    viewerIds: [],
    editorIds: [],
    stages,
    ...over,
  }) as unknown as ChecklistTemplate

const card = (over: Partial<Checklist>): Checklist =>
  ({
    clientId: CLIENT.id,
    assigneeId: LISA,
    dueDate: '2026-08-31',
    viewerIds: [],
    editorIds: [],
    stageCount: 3,
    items: [{ id: `${over.id}-step`, label: 'Work', done: false }],
    ...over,
  }) as Checklist

const FIRST_STEP = card({ id: 'cl-first', title: 'First step close', templateId: 'tmpl-step', caseId: 'case-a', stageIndex: 0, stageId: 'st-0' })
const LAST_STEP = card({ id: 'cl-last', title: 'Last step close', templateId: 'tmpl-step', caseId: 'case-b', stageIndex: 2, stageId: 'st-2' })
const WHOLE_FIRST = card({ id: 'cl-whole', title: 'Whole first close', templateId: 'tmpl-whole', caseId: 'case-c', stageIndex: 0, stageId: 'st-0' })
const OPENED = card({
  id: 'cl-opened',
  title: 'Opened step close',
  templateId: 'tmpl-step',
  caseId: 'case-d',
  assigneeId: ALLISON,
  stageIndex: 1,
  stageId: 'st-1',
  skipNotice: {
    skippedBy: LISA,
    skippedByName: 'Lisa Mockabee',
    stageIndex: 0,
    stageName: 'Clear Client provided email',
    reasonCategory: 'me',
    note: 'Out sick today.',
    at: '2026-08-30T15:00:00.000Z',
    skipId: 'skip-1',
  },
})
const LONG_NOTE = card({
  id: 'cl-long',
  title: 'Long note close',
  templateId: 'tmpl-step',
  caseId: 'case-e',
  assigneeId: ALLISON,
  stageIndex: 1,
  stageId: 'st-1',
  skipNotice: { ...OPENED.skipNotice!, note: `Start ${'x'.repeat(300)} END-OF-NOTE` },
})

/** Case f: step 2 was opened already (Open next step now) while step 1 is still Lisa's. */
const ALREADY_FIRST = card({ id: 'cl-af', title: 'Already open first close', templateId: 'tmpl-step', caseId: 'case-f', stageIndex: 0, stageId: 'st-0' })
const ALREADY_NEXT = card({ id: 'cl-an', title: 'Already open next close', templateId: 'tmpl-step', caseId: 'case-f', stageIndex: 1, stageId: 'st-1', assigneeId: ALLISON })

const data = {
  clients: [CLIENT],
  employees: [
    { id: LISA, name: 'Lisa Mockabee', role: 'Bookkeeper' },
    { id: ALLISON, name: 'Allison Reed', role: 'Bookkeeper' },
    { id: BRITTANY, name: 'Brittany Owner', role: 'Owner' },
  ],
  checklists: [FIRST_STEP, LAST_STEP, WHOLE_FIRST, OPENED, LONG_NOTE, ALREADY_FIRST, ALREADY_NEXT],
  checklistTemplates: [recipe('tmpl-step'), recipe('tmpl-whole', { skipMode: 'whole' })],
  recycledChecklists: [],
  timeEntries: [],
  serviceCategories: [],
} as unknown as AppData

let contextValue: AppContextValue
let skipChecklistOccurrence: ReturnType<typeof vi.fn>
let pushChecklistOccurrence: ReturnType<typeof vi.fn>
let updateChecklistTemplate: ReturnType<typeof vi.fn>

function signInAs(viewerId: string, isOwner: boolean, workspace: AppData = data) {
  skipChecklistOccurrence = vi.fn().mockResolvedValue(null)
  pushChecklistOccurrence = vi.fn().mockResolvedValue(undefined)
  updateChecklistTemplate = vi.fn()
  const active = workspace.checklists.filter((entry) => !isChecklistSkipped(entry))
  contextValue = {
    data: workspace,
    ownerMode: isOwner,
    role: isOwner ? 'owner' : 'employee',
    activeEmployeeId: viewerId,
    effectiveUser: { id: viewerId, role: isOwner ? 'owner' : 'employee' },
    sessionUser: { id: viewerId, role: isOwner ? 'owner' : 'employee' },
    visibleChecklists: checklistsVisibleTo(active, { viewerId, isOwner }),
    visibleClients: [CLIENT],
    serviceCategories: [],
    checklistSkips: [],
    skipChecklistOccurrence,
    pushChecklistOccurrence,
    updateChecklistTemplate,
    patchTemplateStage: vi.fn(),
    reviewChecklistSkip: vi.fn(),
    pendingTaskEditChecklistIds: new Set<string>(),
    pendingItemDeletionKeys: new Set<string>(),
    pendingTaskEdits: [],
    itemDeletionRequests: [],
    reportPeriod: { from: '2026-01-01', to: '2026-12-31' },
    setReportPeriod: vi.fn(),
    dataRefreshCount: 0,
    reorderChecklistSubItems: vi.fn(),
    deleteChecklistItemFromSeries: vi.fn(),
  } as unknown as AppContextValue
}

const renderPage = (entry = '/checklists') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <ChecklistsPage />
    </MemoryRouter>,
  )

const cardFor = (title: string) => screen.getByText(title).closest('article, li, section') as HTMLElement

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  signInAs(BRITTANY, true)
})

describe('the card on a step recipe', () => {
  it('reads "Skip this step" on a step with a step after it, and says who the next step opens for', async () => {
    renderPage()
    const first = within(cardFor('First step close'))
    expect(first.queryByText('Skip this cycle')).not.toBeInTheDocument()
    fireEvent.click(first.getByText('Skip this step'))

    const dialog = screen.getByRole('group', { name: 'Skip this step of First step close' })
    expect(dialog.textContent).toContain(
      'Skipping step 1 of 3 (“Clear Client provided email”) for this cycle - the next step opens for Allison Reed right away, and they will see who skipped and why.',
    )
    // The same reason list and required note as a whole skip.
    const confirm = within(dialog).getByRole('button', { name: 'Skip this step' })
    expect(confirm).toBeDisabled()
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'me' } })
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Out sick today.' } })
    fireEvent.click(confirm)
    await waitFor(() =>
      expect(skipChecklistOccurrence).toHaveBeenCalledWith('cl-first', { category: 'me', explanation: 'Out sick today.' }),
    )
  })

  it('the last step reads "Skip this cycle" and says the skip ends the cycle', () => {
    renderPage()
    fireEvent.click(within(cardFor('Last step close')).getByText('Skip this cycle'))
    const dialog = screen.getByRole('group', { name: /Skip Last step close this cycle/i })
    expect(dialog.textContent).toContain(LAST_STEP_SKIP_NOTE)
    expect(within(dialog).getByRole('button', { name: 'Skip this cycle' })).toBeInTheDocument()
  })

  it('a whole recipe is unchanged: "Skip this cycle", the old sentence, no last-step note', () => {
    renderPage()
    fireEvent.click(within(cardFor('Whole first close')).getByText('Skip this cycle'))
    const dialog = screen.getByRole('group', { name: /Skip Whole first close this cycle/i })
    expect(dialog.textContent).toContain('It leaves your list now and the next occurrence still')
    expect(dialog.textContent).not.toContain(LAST_STEP_SKIP_NOTE)
    expect(dialog.textContent).not.toContain('the next step opens')
  })
})

describe('when the next step is already open', () => {
  it('the dialog says it is already open for its person, who will see who skipped and why', () => {
    renderPage()
    fireEvent.click(within(cardFor('Already open first close')).getByText('Skip this step'))
    const dialog = screen.getByRole('group', { name: 'Skip this step of Already open first close' })
    expect(dialog.textContent).toContain(
      'Skipping step 1 of 3 (“Clear Client provided email”) for this cycle. Step 2 is already open for Allison Reed; they will see who skipped and why.',
    )
    expect(dialog.textContent).not.toContain('right away')
  })
})

describe('what the next person sees', () => {
  it('a line on the opened step: who skipped the step before, and why', () => {
    signInAs(ALLISON, false)
    renderPage()
    const opened = cardFor('Opened step close')
    expect(within(opened).getByRole('note').textContent).toBe(
      'Step 1 skipped by Lisa Mockabee (they could not get to it): Out sick today.',
    )
  })

  it('a long note is clamped with Show more', () => {
    signInAs(ALLISON, false)
    renderPage()
    const note = within(cardFor('Long note close')).getByRole('note')
    expect(note.textContent).not.toContain('END-OF-NOTE')
    fireEvent.click(within(note).getByRole('button', { name: 'Show more' }))
    expect(note.textContent).toContain('END-OF-NOTE')
    expect(within(note).getByRole('button', { name: 'Show less' })).toBeInTheDocument()
  })

  it('a card nobody skipped before says nothing', () => {
    renderPage()
    expect(within(cardFor('First step close')).queryByRole('note')).not.toBeInTheDocument()
  })
})

describe('the recipe editor', () => {
  const editorWorkspace = (template: ChecklistTemplate) =>
    ({ ...data, checklists: [], checklistTemplates: [template] }) as unknown as AppData

  function openEditor(template: ChecklistTemplate) {
    signInAs(BRITTANY, true, editorWorkspace(template))
    renderPage('/checklists?area=repeating')
    fireEvent.click(screen.getByRole('button', { name: new RegExp(CLIENT.name) }))
    const row = screen
      .getAllByRole('button')
      .find((button) => button.querySelector('.repeating-task-title')?.textContent === template.title)
    if (!row) throw new Error('No repeating-task row')
    fireEvent.click(row)
  }

  it('offers the two ways under "Skipping allowed" and saves a choice on the recipe', () => {
    const template = recipe('tmpl-step', { skipMode: 'whole' })
    openEditor(template)
    const whole = screen.getByRole('radio', { name: 'Skip the whole checklist for that cycle' }) as HTMLInputElement
    const step = screen.getByRole('radio', {
      name: 'Skip a step - the next step opens for the next person, who sees who skipped and why',
    }) as HTMLInputElement
    expect(whole.checked).toBe(true)
    expect(step).toBeEnabled()
    fireEvent.click(step)
    expect(updateChecklistTemplate).toHaveBeenCalledWith('tmpl-step', expect.any(Function))
    const updater = updateChecklistTemplate.mock.calls.at(-1)?.[1] as (current: ChecklistTemplate) => ChecklistTemplate
    expect(updater(template).skipMode).toBe('step')
  })

  it('is hidden while skipping is off', () => {
    openEditor(recipe('tmpl-step', { skipAllowed: false }))
    expect(screen.queryByRole('radio', { name: 'Skip the whole checklist for that cycle' })).not.toBeInTheDocument()
  })

  it('a one-step recipe shows it disabled, as a whole skip, and says why', () => {
    openEditor(recipe('tmpl-step', { stages: [stages[0]] as ChecklistTemplate['stages'] }))
    const whole = screen.getByRole('radio', { name: 'Skip the whole checklist for that cycle' }) as HTMLInputElement
    expect(whole.checked).toBe(true)
    expect(whole).toBeDisabled()
    expect(screen.getByText('This recipe has one step, so a skip is the whole cycle.')).toBeInTheDocument()
  })
})

/**
 * Push a step (featreq-78f09571) on screen: on the same recipes and steps a step
 * skip applies to, the Push form says the next step opens too, and the step it
 * opened says who pushed and to when.
 */
describe('pushing a step of a step recipe', () => {
  const STEP_OPENS =
    'Step 2 opens for Allison Reed right away, and they will see who pushed this step and why. This step stays open on its new date.'

  it('the Push form says the next step opens for the next person, and pushes as before', async () => {
    renderPage()
    fireEvent.click(within(cardFor('First step close')).getByText('Push to a new date'))
    const dialog = screen.getByRole('group', { name: 'Push First step close to a new date' })
    expect(dialog.textContent).toContain(STEP_OPENS)
    // The push's own sentence is still there.
    expect(dialog.textContent).toContain('Nothing is completed.')
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'client' } })
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Waiting on the bank statement' } })
    fireEvent.change(within(dialog).getByLabelText('New due date'), { target: { value: '2026-09-10' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Push to this date' }))
    await waitFor(() =>
      expect(pushChecklistOccurrence).toHaveBeenCalledWith('cl-first', {
        category: 'client',
        explanation: 'Waiting on the bank statement',
        newDueDate: '2026-09-10',
      }),
    )
  })

  it('the last step and a whole recipe push exactly as before: nothing about a next step', () => {
    renderPage()
    fireEvent.click(within(cardFor('Last step close')).getByText('Push to a new date'))
    expect(screen.getByRole('group', { name: 'Push Last step close to a new date' }).textContent).not.toContain('opens for')
    fireEvent.click(within(cardFor('Whole first close')).getByText('Push to a new date'))
    const whole = screen.getByRole('group', { name: 'Push Whole first close to a new date' })
    expect(whole.textContent).not.toContain('opens for')
    expect(whole.textContent).not.toContain('who pushed this step')
  })

  it('when the next step is already open, the form says its person will see who pushed and why', () => {
    renderPage()
    fireEvent.click(within(cardFor('Already open first close')).getByText('Push to a new date'))
    const dialog = screen.getByRole('group', { name: 'Push Already open first close to a new date' })
    expect(dialog.textContent).toContain(
      'Step 2 is already open for Allison Reed; they will see who pushed this step and why.',
    )
    expect(dialog.textContent).not.toContain('right away')
  })

  it('when the next step is already finished, the form says nothing else opens and promises nobody is told', () => {
    const finishedNext = { ...ALREADY_NEXT, items: [{ id: 'cl-an-step', label: 'Work', done: true }] } as Checklist
    signInAs(BRITTANY, true, {
      ...data,
      checklists: [ALREADY_FIRST, finishedNext],
    } as unknown as AppData)
    renderPage()
    fireEvent.click(within(cardFor('Already open first close')).getByText('Push to a new date'))
    const dialog = screen.getByRole('group', { name: 'Push Already open first close to a new date' })
    expect(dialog.textContent).toContain(
      'Step 2 is already finished, so nothing else opens. This step stays open on its new date.',
    )
    expect(dialog.textContent).not.toContain('they will see who pushed')
  })

  it('the step a push opened says who pushed the step before, to when, and why', () => {
    const pushedOpen = card({
      id: 'cl-pushed-open',
      title: 'Pushed open close',
      templateId: 'tmpl-step',
      caseId: 'case-p',
      assigneeId: ALLISON,
      stageIndex: 1,
      stageId: 'st-1',
      skipNotice: { ...OPENED.skipNotice!, kind: 'push', newDueDate: '2026-09-10', reasonCategory: 'client', note: 'Waiting on the bank statement' },
    })
    signInAs(BRITTANY, true, { ...data, checklists: [pushedOpen] } as unknown as AppData)
    renderPage()
    expect(
      within(cardFor('Pushed open close')).getByText(
        'Step 1 pushed to September 10, 2026 by Lisa Mockabee (the client did not get us what we needed): Waiting on the bank statement',
      ),
    ).toBeInTheDocument()
  })
})

describe('the recipe editor says the choice covers a push too', () => {
  const NOTE = 'Pushing a step to a new date opens the next step the same way; the pushed step stays open.'
  function openEditor(template: ChecklistTemplate) {
    signInAs(BRITTANY, true, { ...data, checklists: [], checklistTemplates: [template] } as unknown as AppData)
    renderPage('/checklists?area=repeating')
    fireEvent.click(screen.getByRole('button', { name: new RegExp(CLIENT.name) }))
    const row = screen
      .getAllByRole('button')
      .find((button) => button.querySelector('.repeating-task-title')?.textContent === template.title)
    if (!row) throw new Error('No repeating-task row')
    fireEvent.click(row)
  }

  it('under "Skip a step", and not under the whole-checklist choice or on a one-step recipe', () => {
    openEditor(recipe('tmpl-step'))
    expect(screen.getByText(NOTE)).toBeInTheDocument()
  })

  it('not under the whole-checklist choice', () => {
    openEditor(recipe('tmpl-step', { skipMode: 'whole' }))
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument()
  })

  it('not on a one-step recipe', () => {
    openEditor(recipe('tmpl-step', { stages: [stages[0]] as ChecklistTemplate['stages'] }))
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument()
  })
})
