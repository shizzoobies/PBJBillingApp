import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChecklistsPage } from '../pages/ChecklistsPage'
import type { AppContextValue } from '../AppContext'
import type { AppData, Checklist } from '../lib/types'

/**
 * A waiting step cannot be checked off (featreq-cdab1605). The server is the
 * source of truth (pinned in `waiting-blocks-checkoff-route.test.ts`) and the
 * predicate itself is pinned in `lib/waiting-on-state.test.mjs`; this is the
 * remaining piece — that the Checklists tab's own checkbox actually reads
 * `waitingBlocksCompletion` and disables itself, so the 409 is never reachable
 * from a control the page still offered.
 *
 * That is the STAFF rule. The owner is the one exception (featreq-8a01fe08): her
 * checkbox on a waiting step stays enabled and says her tick clears the wait -
 * see the last describe block. Every block above it views the page as staff.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))

const OWNER = 'emp-brit'
// The person doing the work: the viewer in every staff expectation below.
const WORKER = 'emp-avery'
const CLIENT = { id: 'client-acme', name: 'Acme Dental' }

const checklist = (items: Checklist['items']): Checklist =>
  ({
    id: 'cl-1',
    clientId: CLIENT.id,
    title: 'August close',
    assigneeId: WORKER,
    // Far enough out to land in the "Later" due-date bucket, which starts
    // collapsed — the "Overdue" / "This week" buckets start OPEN, and
    // `openDueGroups` below would toggle one of those CLOSED instead.
    dueDate: '2026-12-31',
    items,
  }) as Checklist

const data = (items: Checklist['items']) =>
  ({
    clients: [CLIENT],
    employees: [
      { id: OWNER, name: 'Brittany Fox', role: 'owner' },
      { id: WORKER, name: 'Avery Lane', role: 'Bookkeeper' },
    ],
    checklists: [checklist(items)],
    checklistTemplates: [],
    recycledChecklists: [],
    timeEntries: [],
    serviceCategories: [],
  }) as unknown as AppData

let contextValue: AppContextValue

function signInWith(items: Checklist['items'], viewer: 'staff' | 'owner' = 'staff') {
  const me = viewer === 'owner' ? OWNER : WORKER
  const user =
    viewer === 'owner'
      ? { id: OWNER, role: 'owner', staffRole: 'Owner' }
      : { id: WORKER, role: 'staff', staffRole: 'Bookkeeper' }
  contextValue = {
    data: data(items),
    ownerMode: viewer === 'owner',
    role: user.role,
    activeEmployeeId: me,
    effectiveUser: user,
    sessionUser: user,
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

/** The checkbox on the `.task-item` whose title text contains `label`. */
function itemCheckbox(container: HTMLElement, label: string): HTMLInputElement {
  const rows = Array.from(container.querySelectorAll('.task-item'))
  const row = rows.find((el) => el.textContent?.includes(label))
  if (!row) throw new Error(`no task-item found for "${label}"`)
  const found = row.querySelector('input[type="checkbox"]')
  if (!found) throw new Error(`no checkbox rendered for "${label}"`)
  return found as HTMLInputElement
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('a waiting step', () => {
  it('disables the checkbox with "Clear the wait first"', () => {
    signInWith([{ id: 'it-1', label: 'Bank rec', done: false, assigneeId: WORKER, waiting: true }])
    const { container } = renderProgress()
    const box = itemCheckbox(container, 'Bank rec')
    expect(box).toBeDisabled()
    expect(box.title).toBe('Clear the wait first')
  })

  it('disables it for a live structured wait too, not just the legacy flag', () => {
    signInWith([
      {
        id: 'it-1',
        label: 'Bank rec',
        done: false,
        assigneeId: WORKER,
        waitingOns: [{ id: 'wo-1', blockerId: 'emp-lisa', requestedBy: OWNER, createdAt: '2026-08-01T00:00:00.000Z' }],
      },
    ])
    const { container } = renderProgress()
    expect(itemCheckbox(container, 'Bank rec')).toBeDisabled()
  })

  // Un-checking a done step is never blocked — only the forward move is. A
  // second, still-open item keeps the whole checklist out of the Completed
  // bucket so the card renders under In progress at all.
  it('leaves a DONE-but-still-waiting step checkable, so it can be un-checked', () => {
    signInWith([
      { id: 'it-1', label: 'Bank rec', done: true, assigneeId: WORKER, waiting: true },
      { id: 'it-2', label: 'Payroll review', done: false, assigneeId: WORKER },
    ])
    const { container } = renderProgress()
    expect(itemCheckbox(container, 'Bank rec')).not.toBeDisabled()
  })

  it('leaves an ordinary, non-waiting step alone', () => {
    signInWith([{ id: 'it-1', label: 'Bank rec', done: false, assigneeId: WORKER }])
    const { container } = renderProgress()
    const box = itemCheckbox(container, 'Bank rec')
    expect(box).not.toBeDisabled()
    expect(box.title).toBeFalsy()
  })
})

// Ticking a parent cascades `done` onto every sub-step beneath it, so a parent
// whose sub-step (or sub-sub-step) is waiting is blocked too - otherwise the
// waiting child is checked off through the parent while its own box stays
// disabled.
describe('a parent with a waiting sub-step', () => {
  const withSub = (sub: Record<string, unknown>) =>
    [
      {
        id: 'it-1',
        label: 'Bank rec',
        done: false,
        assigneeId: WORKER,
        subItems: [{ id: 'sub-1', title: 'Pull statements', done: false }, sub],
      },
    ] as unknown as Checklist['items']

  it('disables the parent checkbox and says a sub-step is waiting', () => {
    signInWith(withSub({ id: 'sub-2', title: 'Match deposits', done: false, waiting: true }))
    const { container } = renderProgress()
    const box = itemCheckbox(container, 'Bank rec')
    expect(box).toBeDisabled()
    expect(box.title).toBe('A sub-step is waiting - clear it first')
  })

  it('disables the parent when only a sub-sub-step is waiting', () => {
    signInWith(
      withSub({
        id: 'sub-2',
        title: 'Match deposits',
        done: false,
        subItems: [{ id: 'ss-1', title: 'Chase client', done: false, waiting: true }],
      }),
    )
    const { container } = renderProgress()
    expect(itemCheckbox(container, 'Bank rec')).toBeDisabled()
  })

  it('disables the sub-item whose own sub-sub-step is waiting', () => {
    signInWith(
      withSub({
        id: 'sub-2',
        title: 'Match deposits',
        done: false,
        subItems: [{ id: 'ss-1', title: 'Chase client', done: false, waiting: true }],
      }),
    )
    const { container } = renderProgress()
    const row = Array.from(container.querySelectorAll('.sub-item-row')).find((el) =>
      el.textContent?.includes('Match deposits'),
    )
    const box = row?.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(box).toBeDisabled()
    expect(box.title).toBe('A sub-step is waiting - clear it first')
  })

  it('leaves the parent checkable once the waiting sub-step is done', () => {
    signInWith(withSub({ id: 'sub-2', title: 'Match deposits', done: true, waiting: true }))
    const { container } = renderProgress()
    expect(itemCheckbox(container, 'Bank rec')).not.toBeDisabled()
  })
})

// The roll-up completes a parent when its last open child is ticked, so a step
// that is itself waiting must not be finished through that tick. The child's
// checkbox is disabled instead, with its own sentence.
describe('the last open sub-step of a waiting step', () => {
  const rowBox = (container: HTMLElement, label: string) => {
    const row = Array.from(container.querySelectorAll('.sub-item-row')).find((el) =>
      el.textContent?.includes(label),
    )
    return row?.querySelector('input[type="checkbox"]') as HTMLInputElement
  }

  const waitingParent = (subs: Array<Record<string, unknown>>) =>
    [
      { id: 'it-1', label: 'Bank rec', done: false, assigneeId: WORKER, waiting: true, subItems: subs },
    ] as unknown as Checklist['items']

  it('disables the last open sub-item with "The step above is waiting - clear it first"', () => {
    signInWith(
      waitingParent([
        { id: 'sub-1', title: 'Pull statements', done: true },
        { id: 'sub-2', title: 'Match deposits', done: false },
      ]),
    )
    const { container } = renderProgress()
    const box = rowBox(container, 'Match deposits')
    expect(box).toBeDisabled()
    expect(box.title).toBe('The step above is waiting - clear it first')
  })

  it('leaves a sub-item alone while another sub-item is still open', () => {
    signInWith(
      waitingParent([
        { id: 'sub-1', title: 'Pull statements', done: false },
        { id: 'sub-2', title: 'Match deposits', done: false },
      ]),
    )
    const { container } = renderProgress()
    expect(rowBox(container, 'Match deposits')).not.toBeDisabled()
  })

  it('leaves the last open sub-item of an ordinary step checkable', () => {
    signInWith([
      {
        id: 'it-1',
        label: 'Bank rec',
        done: false,
        assigneeId: WORKER,
        subItems: [{ id: 'sub-1', title: 'Match deposits', done: false }],
      },
    ] as unknown as Checklist['items'])
    const { container } = renderProgress()
    expect(rowBox(container, 'Match deposits')).not.toBeDisabled()
  })

  it('keeps an already-done sub-item un-checkable', () => {
    signInWith(waitingParent([{ id: 'sub-1', title: 'Pull statements', done: true }]))
    const { container } = renderProgress()
    expect(rowBox(container, 'Pull statements')).not.toBeDisabled()
  })

  it('disables the last open sub-sub-item when its sub-item is waiting', () => {
    signInWith([
      {
        id: 'it-1',
        label: 'Bank rec',
        done: false,
        assigneeId: WORKER,
        subItems: [
          {
            id: 'sub-1',
            title: 'Match deposits',
            done: false,
            waiting: true,
            subItems: [
              { id: 'ss-1', title: 'Chase client', done: true },
              { id: 'ss-2', title: 'File receipt', done: false },
            ],
          },
        ],
      },
    ] as unknown as Checklist['items'])
    const { container } = renderProgress()
    const box = rowBox(container, 'File receipt')
    expect(box).toBeDisabled()
    expect(box.title).toBe('The step above is waiting - clear it first')
  })
})

// Someone else's step: the permission sentence wins on the sub-item and
// sub-sub-item boxes just as it does on the item's own.
describe('a step assigned to someone else', () => {
  it('titles the sub-item and sub-sub-item checkboxes with the permission sentence', () => {
    signInWith([
      {
        id: 'it-1',
        label: 'Bank rec',
        done: false,
        assigneeId: 'emp-lisa',
        subItems: [
          {
            id: 'sub-1',
            title: 'Match deposits',
            done: false,
            subItems: [{ id: 'ss-1', title: 'Chase client', done: false }],
          },
        ],
      },
    ] as unknown as Checklist['items'])
    contextValue = {
      ...contextValue,
      role: 'staff',
      ownerMode: false,
      activeEmployeeId: 'emp-avery',
      effectiveUser: { id: 'emp-avery', role: 'staff', staffRole: 'Bookkeeper' },
      sessionUser: { id: 'emp-avery', role: 'staff', staffRole: 'Bookkeeper' },
    } as unknown as AppContextValue
    const { container } = renderProgress()
    const sentence = 'This step is assigned to someone else — only they can check it off.'
    for (const label of ['Match deposits', 'Chase client']) {
      const row = Array.from(container.querySelectorAll('.sub-item-row')).find((el) =>
        el.textContent?.includes(label),
      )
      const box = row?.querySelector('input[type="checkbox"]') as HTMLInputElement
      expect(box, label).toBeDisabled()
      expect(box.title, label).toBe(sentence)
    }
  })
})

// The same simulation guards a DELETE: removing the last open child rolls the
// parent up to done, so a waiting step's delete button is disabled for it, with
// the sentence the route would answer.
describe('deleting the last open sub-step of a waiting step', () => {
  const deleteButton = (container: HTMLElement, label: string) => {
    const row = Array.from(container.querySelectorAll('.sub-item-row')).find((el) =>
      el.textContent?.includes(label),
    )
    return row?.querySelector('button[aria-label="Delete sub-step"]') as HTMLButtonElement
  }

  const waitingParent = (subs: Array<Record<string, unknown>>) =>
    [
      { id: 'it-1', label: 'Bank rec', done: false, assigneeId: WORKER, waiting: true, subItems: subs },
    ] as unknown as Checklist['items']

  it('disables the sub-step delete button and says why', () => {
    signInWith(
      waitingParent([
        { id: 'sub-1', title: 'Pull statements', done: true },
        { id: 'sub-2', title: 'Match deposits', done: false },
      ]),
    )
    const { container } = renderProgress()
    const button = deleteButton(container, 'Match deposits')
    expect(button).toBeDisabled()
    expect(button.title).toBe(
      'Removing this would finish a step that is waiting. Clear its wait first.',
    )
  })

  it('leaves the delete button alone while another sub-step is open', () => {
    signInWith(
      waitingParent([
        { id: 'sub-1', title: 'Pull statements', done: false },
        { id: 'sub-2', title: 'Match deposits', done: false },
      ]),
    )
    const { container } = renderProgress()
    expect(deleteButton(container, 'Match deposits')).not.toBeDisabled()
  })

  it('disables the sub-sub-step delete button when it would finish a waiting sub-step', () => {
    signInWith([
      {
        id: 'it-1',
        label: 'Bank rec',
        done: false,
        assigneeId: WORKER,
        subItems: [
          {
            id: 'sub-1',
            title: 'Match deposits',
            done: false,
            waiting: true,
            subItems: [
              { id: 'ss-1', title: 'Chase client', done: true },
              { id: 'ss-2', title: 'File receipt', done: false },
            ],
          },
        ],
      },
    ] as unknown as Checklist['items'])
    const { container } = renderProgress()
    expect(deleteButton(container, 'File receipt')).toBeDisabled()
    expect(deleteButton(container, 'Chase client')).not.toBeDisabled()
  })
})

// The owner is usually the person being waited ON, so she may check off a
// waiting step directly and her tick closes the wait (featreq-8a01fe08). The
// checkbox stays enabled and its title says so; the server does the closing
// (pinned in waiting-blocks-checkoff-route.test.ts, db/store-staleness.test.mjs
// and lib/waiting-on-state.test.mjs). Staff above are unchanged.
describe('the owner on a waiting step', () => {
  const TITLE = 'Checking this off clears the wait'
  const rowBox = (container: HTMLElement, label: string) => {
    const row = Array.from(container.querySelectorAll('.sub-item-row')).find((el) =>
      el.textContent?.includes(label),
    )
    return row?.querySelector('input[type="checkbox"]') as HTMLInputElement
  }

  it('can tick the waiting step itself, and the title says it clears the wait', () => {
    signInWith(
      [{ id: 'it-1', label: 'Bank rec', done: false, assigneeId: WORKER, waiting: true }],
      'owner',
    )
    const { container } = renderProgress()
    const box = itemCheckbox(container, 'Bank rec')
    expect(box).not.toBeDisabled()
    expect(box.title).toBe(TITLE)
    fireEvent.click(box)
    expect(contextValue.toggleChecklistItem).toHaveBeenCalledWith('cl-1', 'it-1')
  })

  it('can tick a live structured wait too', () => {
    signInWith(
      [
        {
          id: 'it-1',
          label: 'Bank rec',
          done: false,
          assigneeId: WORKER,
          waitingOns: [
            { id: 'wo-1', blockerId: OWNER, requestedBy: WORKER, createdAt: '2026-08-01T00:00:00.000Z' },
          ],
        },
      ],
      'owner',
    )
    const { container } = renderProgress()
    const box = itemCheckbox(container, 'Bank rec')
    expect(box).not.toBeDisabled()
    expect(box.title).toBe(TITLE)
  })

  it('can tick a parent whose sub-step is waiting', () => {
    signInWith(
      [
        {
          id: 'it-1',
          label: 'Bank rec',
          done: false,
          assigneeId: WORKER,
          subItems: [
            { id: 'sub-1', title: 'Pull statements', done: false },
            { id: 'sub-2', title: 'Match deposits', done: false, waiting: true },
          ],
        },
      ] as unknown as Checklist['items'],
      'owner',
    )
    const { container } = renderProgress()
    const box = itemCheckbox(container, 'Bank rec')
    expect(box).not.toBeDisabled()
    expect(box.title).toBe(TITLE)
  })

  it('can tick a waiting sub-step and a sub-step with a waiting sub-sub-step', () => {
    signInWith(
      [
        {
          id: 'it-1',
          label: 'Bank rec',
          done: false,
          assigneeId: WORKER,
          subItems: [
            { id: 'sub-1', title: 'Pull statements', done: false, waiting: true },
            {
              id: 'sub-2',
              title: 'Match deposits',
              done: false,
              subItems: [{ id: 'ss-1', title: 'Chase client', done: false, waiting: true }],
            },
          ],
        },
      ] as unknown as Checklist['items'],
      'owner',
    )
    const { container } = renderProgress()
    for (const label of ['Pull statements', 'Match deposits', 'Chase client']) {
      expect(rowBox(container, label), label).not.toBeDisabled()
      expect(rowBox(container, label).title, label).toBe(TITLE)
    }
  })

  it('can tick the last open sub-step under a waiting step', () => {
    signInWith(
      [
        {
          id: 'it-1',
          label: 'Bank rec',
          done: false,
          assigneeId: WORKER,
          waiting: true,
          subItems: [
            { id: 'sub-1', title: 'Pull statements', done: true },
            { id: 'sub-2', title: 'Match deposits', done: false },
          ],
        },
      ] as unknown as Checklist['items'],
      'owner',
    )
    const { container } = renderProgress()
    expect(rowBox(container, 'Match deposits')).not.toBeDisabled()
    expect(rowBox(container, 'Match deposits').title).toBe(TITLE)
  })

  it('can tick the last open sub-sub-step under a waiting sub-step', () => {
    signInWith(
      [
        {
          id: 'it-1',
          label: 'Bank rec',
          done: false,
          assigneeId: WORKER,
          subItems: [
            {
              id: 'sub-1',
              title: 'Match deposits',
              done: false,
              waiting: true,
              subItems: [
                { id: 'ss-1', title: 'Chase client', done: true },
                { id: 'ss-2', title: 'File receipt', done: false },
              ],
            },
          ],
        },
      ] as unknown as Checklist['items'],
      'owner',
    )
    const { container } = renderProgress()
    expect(rowBox(container, 'File receipt')).not.toBeDisabled()
    expect(rowBox(container, 'File receipt').title).toBe(TITLE)
  })

  it('after her tick the step is done and shows no live Waiting badge', () => {
    // What the server hands back once the tick closes the wait.
    signInWith(
      [
        {
          id: 'it-1',
          label: 'Bank rec',
          done: true,
          assigneeId: WORKER,
          waiting: false,
          waitingOns: [
            {
              id: 'wo-1',
              blockerId: OWNER,
              requestedBy: WORKER,
              createdAt: '2026-08-01T00:00:00.000Z',
              resolvedAt: '2026-10-01T10:00:00.000Z',
              resolvedBy: OWNER,
              verifiedAt: '2026-10-01T10:00:00.000Z',
              verifiedBy: OWNER,
            },
          ],
        },
        { id: 'it-2', label: 'Payroll review', done: false, assigneeId: WORKER },
      ],
      'owner',
    )
    const { container } = renderProgress()
    expect(itemCheckbox(container, 'Bank rec').checked).toBe(true)
    expect(container.querySelector('.task-row-waiting')).toBeNull()
  })

  it('does not change anything in preview mode: the box stays disabled with the staff sentence', () => {
    signInWith(
      [{ id: 'it-1', label: 'Bank rec', done: false, assigneeId: WORKER, waiting: true }],
      'owner',
    )
    contextValue = { ...contextValue, previewMode: true } as unknown as AppContextValue
    const { container } = renderProgress()
    const box = itemCheckbox(container, 'Bank rec')
    expect(box).toBeDisabled()
    expect(box.title).toBe('Clear the wait first')
  })
})
