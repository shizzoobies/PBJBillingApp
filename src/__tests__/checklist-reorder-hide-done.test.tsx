import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChecklistsPage } from '../pages/ChecklistsPage'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist } from '../lib/types'

/**
 * Reorder, completed-to-bottom, hide completed (featreq-8a01fe08).
 *
 * The pure order rules are pinned in `order-steps.test.ts`; the store and route
 * in `db/store-staleness.test.mjs` and `sub-step-reorder-route.test.ts`. This is
 * the page: the display order, the "Hide completed (N)" toggle and its hidden
 * line, Move up / Move down, the drag math that is sent, and that the waiting
 * guards still hold on a reordered or hidden list.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))

const OWNER = 'emp-brit'
const CLIENT = { id: 'client-acme', name: 'Acme Dental' }

const checklist = (items: Checklist['items']): Checklist =>
  ({
    id: 'cl-1',
    clientId: CLIENT.id,
    title: 'August close',
    assigneeId: OWNER,
    // Far enough out to land in the collapsed "Later" bucket (see renderProgress).
    dueDate: '2026-12-31',
    items,
  }) as Checklist

const data = (items: Checklist['items']) =>
  ({
    clients: [CLIENT],
    employees: [{ id: OWNER, name: 'Brittany Fox', role: 'owner' }],
    checklists: [checklist(items)],
    checklistTemplates: [],
    recycledChecklists: [],
    timeEntries: [],
    serviceCategories: [],
  }) as unknown as AppData

let contextValue: AppContextValue

function signInWith(items: Checklist['items']) {
  contextValue = {
    data: data(items),
    ownerMode: true,
    role: 'owner',
    activeEmployeeId: OWNER,
    effectiveUser: { id: OWNER, role: 'owner', staffRole: 'Owner' },
    sessionUser: { id: OWNER, role: 'owner', staffRole: 'Owner' },
    visibleChecklists: data(items).checklists,
    visibleClients: [CLIENT],
    serviceCategories: [],
    pendingTaskEditChecklistIds: new Set<string>(),
    pendingItemDeletionKeys: new Set<string>(),
    pendingTaskEdits: [],
    itemDeletionRequests: [],
    reportPeriod: { from: '2026-01-01', to: '2026-12-31' },
    setReportPeriod: vi.fn(),
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
    reorderChecklistSubItems: vi.fn(),
    dataRefreshCount: 0,
    deleteChecklistItemFromSeries: vi.fn(),
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

const renderProgress = () => {
  const result = render(
    <MemoryRouter initialEntries={['/checklists?area=progress']}>
      <ChecklistsPage />
    </MemoryRouter>,
  )
  // The In-progress list buckets by due date and ships those groups collapsed.
  for (const heading of screen.queryAllByRole('button', { name: /^(Later|Overdue|This week)/ })) {
    fireEvent.click(heading)
  }
  return result
}

const item = (id: string, label: string, over: Record<string, unknown> = {}) => ({
  id,
  label,
  done: false,
  assigneeId: OWNER,
  ...over,
})

/** The top-level step rows, in the order they are on screen. */
const stepLabels = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.task-item')).map(
    (el) => el.querySelector('.task-row-title')?.textContent?.replace(/\d+\/\d+$/, '') ?? '',
  )

const taskItem = (container: HTMLElement, label: string) => {
  const found = Array.from(container.querySelectorAll('.task-item')).find((el) =>
    el.querySelector('.task-row-title')?.textContent?.includes(label),
  )
  if (!found) throw new Error(`no step "${label}"`)
  return found as HTMLElement
}

const subRow = (container: HTMLElement, title: string) => {
  const found = Array.from(container.querySelectorAll('.sub-item-row')).find((el) =>
    el.textContent?.includes(title),
  )
  if (!found) throw new Error(`no sub-step "${title}"`)
  return found as HTMLElement
}

const subTitles = (step: HTMLElement) =>
  Array.from(step.querySelectorAll('.sub-item-group > .sub-item-row .sub-item-title')).map(
    (el) => el.textContent,
  )

const dataTransfer = () => ({
  setData: vi.fn(),
  getData: vi.fn(),
  effectAllowed: '',
  dropEffect: '',
})

const dragOnto = (from: HTMLElement, to: HTMLElement) => {
  const transfer = dataTransfer()
  fireEvent.dragStart(from, { dataTransfer: transfer })
  fireEvent.dragOver(to, { dataTransfer: transfer })
  fireEvent.drop(to, { dataTransfer: transfer })
}

const stepRow = (container: HTMLElement, label: string) =>
  taskItem(container, label).querySelector('.task-row') as HTMLElement

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
})

// Saved order: Alpha (open), Bravo (done), Charlie (open), Delta (done), Echo (open)
const mixed = () =>
  signInWith([
    item('it-a', 'Alpha'),
    item('it-b', 'Bravo', { done: true }),
    item('it-c', 'Charlie'),
    item('it-d', 'Delta', { done: true }),
    item('it-e', 'Echo'),
  ] as unknown as Checklist['items'])

describe('completed steps sit at the bottom', () => {
  it('shows open steps in saved order, then done steps in saved order', () => {
    mixed()
    const { container } = renderProgress()
    expect(stepLabels(container)).toEqual(['Alpha', 'Charlie', 'Echo', 'Bravo', 'Delta'])
  })

  it('does the same for the sub-steps inside a step', () => {
    signInWith([
      item('it-1', 'Payroll', {
        subItems: [
          { id: 's1', title: 'Pull hours', done: true },
          { id: 's2', title: 'Review overtime', done: false },
          { id: 's3', title: 'Run the file', done: false },
        ],
      }),
    ] as unknown as Checklist['items'])
    const { container } = renderProgress()
    expect(subTitles(taskItem(container, 'Payroll'))).toEqual([
      'Review overtime',
      'Run the file',
      'Pull hours',
    ])
  })
})

describe('Hide completed (N)', () => {
  it('counts the done steps and shows no hidden line until it is on', () => {
    mixed()
    renderProgress()
    expect(screen.getByRole('button', { name: 'Hide completed (2)' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(screen.queryByText(/completed steps? hidden/)).toBeNull()
  })

  it('hides the done steps, says how many, and changes no data', () => {
    mixed()
    const { container } = renderProgress()
    fireEvent.click(screen.getByRole('button', { name: 'Hide completed (2)' }))

    expect(stepLabels(container)).toEqual(['Alpha', 'Charlie', 'Echo'])
    expect(screen.getByText(/2 completed steps hidden -/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hide completed (2)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    // Display only: nothing was sent anywhere.
    expect(contextValue.reorderChecklistItems).not.toHaveBeenCalled()
    expect(contextValue.toggleChecklistItem).not.toHaveBeenCalled()
    expect(contextValue.updateChecklistItem).not.toHaveBeenCalled()
  })

  it('says "1 completed step hidden" for one', () => {
    signInWith([item('it-a', 'Alpha'), item('it-b', 'Bravo', { done: true })] as unknown as Checklist['items'])
    renderProgress()
    fireEvent.click(screen.getByRole('button', { name: 'Hide completed (1)' }))
    expect(screen.getByText(/1 completed step hidden -/)).toBeInTheDocument()
  })

  it('Show brings them back, in the bottom group', () => {
    mixed()
    const { container } = renderProgress()
    fireEvent.click(screen.getByRole('button', { name: 'Hide completed (2)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show' }))

    expect(stepLabels(container)).toEqual(['Alpha', 'Charlie', 'Echo', 'Bravo', 'Delta'])
    expect(screen.queryByText(/completed steps? hidden/)).toBeNull()
  })

  it('remembers the choice per checklist in localStorage', () => {
    mixed()
    renderProgress()
    fireEvent.click(screen.getByRole('button', { name: 'Hide completed (2)' }))
    expect(window.localStorage.getItem('pbj.hideDone.v1.cl-1')).toBe('1')
    fireEvent.click(screen.getByRole('button', { name: 'Show' }))
    expect(window.localStorage.getItem('pbj.hideDone.v1.cl-1')).toBe('0')
  })

  it('starts hidden when the stored preference says so', () => {
    window.localStorage.setItem('pbj.hideDone.v1.cl-1', '1')
    mixed()
    const { container } = renderProgress()
    expect(stepLabels(container)).toEqual(['Alpha', 'Charlie', 'Echo'])
    expect(screen.getByText(/2 completed steps hidden -/)).toBeInTheDocument()
  })

  it('is not offered when nothing is done', () => {
    signInWith([item('it-a', 'Alpha'), item('it-c', 'Charlie')] as unknown as Checklist['items'])
    renderProgress()
    expect(screen.queryByRole('button', { name: /Hide completed/ })).toBeNull()
  })

  it('folds a done sub-step away inside an open step but never its open siblings', () => {
    signInWith([
      item('it-1', 'Payroll', {
        subItems: [
          { id: 's1', title: 'Pull hours', done: true },
          { id: 's2', title: 'Review overtime', done: false },
        ],
      }),
    ] as unknown as Checklist['items'])
    const { container } = renderProgress()
    fireEvent.click(screen.getByRole('button', { name: 'Hide completed (1)' }))

    expect(subTitles(taskItem(container, 'Payroll'))).toEqual(['Review overtime'])
    expect(screen.getByText(/1 completed step hidden -/)).toBeInTheDocument()
  })

  it('never hides a done step that still carries a live wait', () => {
    signInWith([
      item('it-a', 'Alpha'),
      item('it-b', 'Bravo', {
        done: true,
        waitingOns: [
          { id: 'wo-1', blockerId: 'emp-lisa', requestedBy: OWNER, createdAt: '2026-08-01T00:00:00.000Z' },
        ],
      }),
      item('it-c', 'Charlie', { done: true }),
    ] as unknown as Checklist['items'])
    const { container } = renderProgress()
    fireEvent.click(screen.getByRole('button', { name: 'Hide completed (1)' }))
    expect(stepLabels(container)).toEqual(['Alpha', 'Bravo'])
  })
})

describe('Move up and Move down', () => {
  it('moves a step within the open group, sending the open order then the done order', () => {
    mixed()
    const { container } = renderProgress()
    fireEvent.click(within(taskItem(container, 'Echo')).getAllByRole('button', { name: 'Move up' })[0])
    // Open group a, c, e -> a, e, c; done order b, d unchanged.
    expect(contextValue.reorderChecklistItems).toHaveBeenCalledWith('cl-1', [
      'it-a',
      'it-e',
      'it-c',
      'it-b',
      'it-d',
    ])
  })

  it('Move down sends the same shape the other way', () => {
    mixed()
    const { container } = renderProgress()
    fireEvent.click(
      within(stepRow(container, 'Alpha')).getByRole('button', { name: 'Move down' }),
    )
    expect(contextValue.reorderChecklistItems).toHaveBeenCalledWith('cl-1', [
      'it-c',
      'it-a',
      'it-e',
      'it-b',
      'it-d',
    ])
  })

  it('disables Move up on the first open step and Move down on the last', () => {
    mixed()
    const { container } = renderProgress()
    expect(within(stepRow(container, 'Alpha')).getByRole('button', { name: 'Move up' })).toBeDisabled()
    expect(within(stepRow(container, 'Echo')).getByRole('button', { name: 'Move down' })).toBeDisabled()
    expect(within(stepRow(container, 'Charlie')).getByRole('button', { name: 'Move up' })).toBeEnabled()
  })

  it('offers no move buttons on a done step', () => {
    mixed()
    const { container } = renderProgress()
    expect(within(stepRow(container, 'Bravo')).queryByRole('button', { name: /Move/ })).toBeNull()
  })

  it('moves a sub-step within its step, open sub-steps first', () => {
    signInWith([
      item('it-1', 'Payroll', {
        subItems: [
          { id: 's1', title: 'Pull hours', done: false },
          { id: 's2', title: 'Review overtime', done: true },
          { id: 's3', title: 'Run the file', done: false },
        ],
      }),
    ] as unknown as Checklist['items'])
    const { container } = renderProgress()
    fireEvent.click(within(subRow(container, 'Run the file')).getByRole('button', { name: 'Move up' }))
    expect(contextValue.reorderChecklistSubItems).toHaveBeenCalledWith('cl-1', 'it-1', [
      's3',
      's1',
      's2',
    ])
    expect(contextValue.reorderChecklistItems).not.toHaveBeenCalled()
  })

  it('disables Move up on the first open sub-step and Move down on the last', () => {
    signInWith([
      item('it-1', 'Payroll', {
        subItems: [
          { id: 's1', title: 'Pull hours', done: false },
          { id: 's2', title: 'Run the file', done: false },
        ],
      }),
    ] as unknown as Checklist['items'])
    const { container } = renderProgress()
    expect(within(subRow(container, 'Pull hours')).getByRole('button', { name: 'Move up' })).toBeDisabled()
    expect(within(subRow(container, 'Run the file')).getByRole('button', { name: 'Move down' })).toBeDisabled()
  })
})

describe('drag and drop', () => {
  it('shows the grip at rest with its title on open steps only', () => {
    mixed()
    const { container } = renderProgress()
    const grip = (label: string) => stepRow(container, label).querySelector('.drag-handle') as HTMLElement
    expect(grip('Alpha').title).toBe('Drag to reorder')
    expect(grip('Bravo').title).toBe('')
    expect(stepRow(container, 'Alpha').getAttribute('draggable')).toBe('true')
    expect(stepRow(container, 'Bravo').getAttribute('draggable')).toBe('false')
  })

  it('sends the new open order followed by the existing done order', () => {
    mixed()
    const { container } = renderProgress()
    dragOnto(stepRow(container, 'Echo'), stepRow(container, 'Alpha'))
    expect(contextValue.reorderChecklistItems).toHaveBeenCalledWith('cl-1', [
      'it-e',
      'it-a',
      'it-c',
      'it-b',
      'it-d',
    ])
  })

  it('sends nothing for a drop onto a done step', () => {
    mixed()
    const { container } = renderProgress()
    dragOnto(stepRow(container, 'Alpha'), stepRow(container, 'Bravo'))
    expect(contextValue.reorderChecklistItems).not.toHaveBeenCalled()
  })

  it('reorders sub-steps with the same rule, through the sub-step route', () => {
    signInWith([
      item('it-1', 'Payroll', {
        subItems: [
          { id: 's1', title: 'Pull hours', done: false },
          { id: 's2', title: 'Review overtime', done: true },
          { id: 's3', title: 'Run the file', done: false },
        ],
      }),
    ] as unknown as Checklist['items'])
    const { container } = renderProgress()
    dragOnto(subRow(container, 'Run the file'), subRow(container, 'Pull hours'))
    expect(contextValue.reorderChecklistSubItems).toHaveBeenCalledWith('cl-1', 'it-1', [
      's3',
      's1',
      's2',
    ])
    expect(contextValue.reorderChecklistItems).not.toHaveBeenCalled()
  })
})

// The check-off guards from the waiting work must survive a reordered or hidden list.
describe('the waiting guards on reordered and hidden lists', () => {
  it('never hides a waiting step - it cannot be done - and its box stays disabled', () => {
    signInWith([
      item('it-a', 'Alpha', { waiting: true }),
      item('it-b', 'Bravo', { done: true }),
    ] as unknown as Checklist['items'])
    const { container } = renderProgress()
    fireEvent.click(screen.getByRole('button', { name: 'Hide completed (1)' }))

    expect(stepLabels(container)).toEqual(['Alpha'])
    const box = taskItem(container, 'Alpha').querySelector('input[type="checkbox"]')
    expect(box).toBeDisabled()
  })

  it('still counts hidden done siblings: the last open sub-step of a waiting step stays disabled', () => {
    signInWith([
      item('it-1', 'Payroll', {
        waiting: true,
        subItems: [
          { id: 's1', title: 'Pull hours', done: true },
          { id: 's2', title: 'Run the file', done: false },
        ],
      }),
    ] as unknown as Checklist['items'])
    const { container } = renderProgress()
    fireEvent.click(screen.getByRole('button', { name: 'Hide completed (1)' }))

    expect(subTitles(taskItem(container, 'Payroll'))).toEqual(['Run the file'])
    const box = subRow(container, 'Run the file').querySelector('input[type="checkbox"]')
    expect(box).toBeDisabled()
    expect((box as HTMLInputElement).title).toBe('The step above is waiting - clear it first')
  })

  it('a done step moved to the bottom is still done and still un-tickable', () => {
    mixed()
    const { container } = renderProgress()
    const box = taskItem(container, 'Bravo').querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(box.checked).toBe(true)
    expect(box).not.toBeDisabled()
  })
})

const liveWait = {
  id: 'wo-1',
  blockerId: 'emp-lisa',
  requestedBy: OWNER,
  createdAt: '2026-08-01T00:00:00.000Z',
}

describe('Hide completed never buries a live wait, however deep it sits', () => {
  it('keeps a done step whose sub-step carries a live saved wait', () => {
    signInWith([
      item('it-a', 'Alpha'),
      item('it-b', 'Bravo', {
        done: true,
        subItems: [{ id: 's1', title: 'Chase client', done: true, waitingOns: [liveWait] }],
      }),
      item('it-c', 'Charlie', { done: true }),
    ] as unknown as Checklist['items'])
    const { container } = renderProgress()
    fireEvent.click(screen.getByRole('button', { name: 'Hide completed (1)' }))
    expect(stepLabels(container)).toEqual(['Alpha', 'Bravo'])
  })

  it('keeps a done step whose sub-sub-step carries a live saved wait', () => {
    signInWith([
      item('it-a', 'Alpha'),
      item('it-b', 'Bravo', {
        done: true,
        subItems: [
          {
            id: 's1',
            title: 'Match deposits',
            done: true,
            subItems: [{ id: 'ss1', title: 'Chase client', done: true, waitingOns: [liveWait] }],
          },
        ],
      }),
      item('it-c', 'Charlie', { done: true }),
    ] as unknown as Checklist['items'])
    const { container } = renderProgress()
    fireEvent.click(screen.getByRole('button', { name: 'Hide completed (1)' }))
    expect(stepLabels(container)).toEqual(['Alpha', 'Bravo'])
  })

  it('still hides a done step once the wait beneath it is approved', () => {
    signInWith([
      item('it-a', 'Alpha'),
      item('it-b', 'Bravo', {
        done: true,
        subItems: [
          {
            id: 's1',
            title: 'Chase client',
            done: true,
            waitingOns: [
              {
                ...liveWait,
                resolvedAt: '2026-08-02T00:00:00.000Z',
                resolvedBy: 'emp-lisa',
                verifiedAt: '2026-08-03T00:00:00.000Z',
                verifiedBy: OWNER,
              },
            ],
          },
        ],
      }),
    ] as unknown as Checklist['items'])
    const { container } = renderProgress()
    fireEvent.click(screen.getByRole('button', { name: 'Hide completed (1)' }))
    expect(stepLabels(container)).toEqual(['Alpha'])
  })
})

describe('done is the roll-up in the display order and in Hide completed', () => {
  it('sorts a step stored done with an open sub-step into the open group, and never hides it', () => {
    signInWith([
      item('it-c', 'Charlie', { done: true }),
      item('it-b', 'Bravo', {
        done: true,
        subItems: [{ id: 's1', title: 'Still open', done: false }],
      }),
      item('it-a', 'Alpha'),
    ] as unknown as Checklist['items'])
    const { container } = renderProgress()
    expect(stepLabels(container)).toEqual(['Bravo', 'Alpha', 'Charlie'])
    fireEvent.click(screen.getByRole('button', { name: 'Hide completed (1)' }))
    expect(stepLabels(container)).toEqual(['Bravo', 'Alpha'])
  })

  it('treats the step as open for its Move buttons too', () => {
    signInWith([
      item('it-b', 'Bravo', {
        done: true,
        subItems: [{ id: 's1', title: 'Still open', done: false }],
      }),
      item('it-a', 'Alpha'),
    ] as unknown as Checklist['items'])
    const { container } = renderProgress()
    const buttons = within(taskItem(container, 'Bravo')).getAllByRole('button', {
      name: /^Move (up|down)$/,
    })
    expect(buttons.length).toBeGreaterThan(0)
  })
})

describe('a fully complete checklist', () => {
  // A finished checklist lands in the collapsed Completed bucket.
  const renderCompleted = () => {
    const result = renderProgress()
    fireEvent.click(screen.getByRole('button', { name: /^Completed/ }))
    return result
  }

  it('offers no Hide completed toggle, since nothing open would remain', () => {
    signInWith([
      item('it-a', 'Alpha', { done: true }),
      item('it-b', 'Bravo', { done: true }),
    ] as unknown as Checklist['items'])
    const { container } = renderCompleted()
    expect(stepLabels(container)).toEqual(['Alpha', 'Bravo'])
    expect(screen.queryByRole('button', { name: /Hide completed/ })).toBeNull()
  })

  it('does not blank the list when a stored preference says hide', () => {
    window.localStorage.setItem('pbj.hideDone.v1.cl-1', '1')
    signInWith([
      item('it-a', 'Alpha', { done: true }),
      item('it-b', 'Bravo', { done: true }),
    ] as unknown as Checklist['items'])
    const { container } = renderCompleted()
    expect(stepLabels(container)).toEqual(['Alpha', 'Bravo'])
    expect(screen.queryByText(/completed steps? hidden/)).toBeNull()
  })
})

describe('done rows are not drop targets', () => {
  const dragOverAccepted = (from: HTMLElement, to: HTMLElement) => {
    const transfer = dataTransfer()
    fireEvent.dragStart(from, { dataTransfer: transfer })
    // fireEvent returns false when the handler called preventDefault, which is
    // how a drop is allowed.
    return !fireEvent.dragOver(to, { dataTransfer: transfer })
  }

  it('does not accept a step dragged over a done step, and shows no drop line', () => {
    mixed()
    const { container } = renderProgress()
    expect(dragOverAccepted(stepRow(container, 'Alpha'), stepRow(container, 'Bravo'))).toBe(false)
    expect(stepRow(container, 'Bravo').className).not.toContain('drop-target')
  })

  it('does accept one over an open step, with the drop line', () => {
    mixed()
    const { container } = renderProgress()
    expect(dragOverAccepted(stepRow(container, 'Alpha'), stepRow(container, 'Charlie'))).toBe(true)
    expect(stepRow(container, 'Charlie').className).toContain('drop-target')
  })

  it('does the same for sub-steps', () => {
    signInWith([
      item('it-1', 'Payroll', {
        subItems: [
          { id: 's1', title: 'Pull hours', done: false },
          { id: 's2', title: 'Review overtime', done: true },
          { id: 's3', title: 'Run the file', done: false },
        ],
      }),
    ] as unknown as Checklist['items'])
    const { container } = renderProgress()
    expect(
      dragOverAccepted(subRow(container, 'Pull hours'), subRow(container, 'Review overtime')),
    ).toBe(false)
    expect(subRow(container, 'Review overtime').className).not.toContain('drop-target')
    expect(
      dragOverAccepted(subRow(container, 'Pull hours'), subRow(container, 'Run the file')),
    ).toBe(true)
    expect(subRow(container, 'Run the file').className).toContain('drop-target')
  })
})
