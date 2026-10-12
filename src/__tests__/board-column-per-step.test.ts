import { describe, expect, it } from 'vitest'
import { dateOffset, ensureRecurringChecklists, ensureTemplateStages, localDateOnly } from '../lib/utils'
import { projectUpcomingChecklists } from '../lib/projectRecurring'
import { buildActiveBoard, UNCATEGORIZED_ID } from '../lib/activeBoard'
import type { AppData, Checklist, ChecklistTemplate } from '../lib/types'

/**
 * Board column per step (featreq-3e81b386). Each step may name its own Board
 * column (`stage.categoryId`); a step without one uses the recipe's. The
 * browser's stage normalizer is an explicit field list - the trap that once
 * dropped `dueDayOfMonth` on save - so it must carry the new field too.
 */
const template = (stages: ChecklistTemplate['stages']): ChecklistTemplate => ({
  id: 'tpl-1',
  title: 'Monthly close',
  clientId: 'client-1',
  assigneeId: 'emp-1',
  frequency: 'monthly',
  nextDueDate: '2026-10-31',
  active: true,
  viewerIds: [],
  editorIds: [],
  categoryId: 'cat-recipe',
  stages,
})

describe('ensureTemplateStages (browser) carries the step board column', () => {
  it('keeps a step own column and leaves a step without one without', () => {
    const migrated = ensureTemplateStages(
      template([
        { id: 's1', name: 'Prepare', assigneeId: 'emp-1', offsetDays: 0, viewerIds: [], editorIds: [], items: [] },
        { id: 's2', name: 'Review', assigneeId: 'emp-1', offsetDays: 0, categoryId: 'cat-review', viewerIds: [], editorIds: [], items: [] },
      ]),
    )
    expect(migrated.stages[0]).not.toHaveProperty('categoryId')
    expect(migrated.stages[1].categoryId).toBe('cat-review')
  })

  it('drops an empty or null step column so the step falls back to the recipe', () => {
    const migrated = ensureTemplateStages(
      template([
        { id: 's1', name: 'Prepare', assigneeId: 'emp-1', offsetDays: 0, categoryId: null, viewerIds: [], editorIds: [], items: [] },
        { id: 's2', name: 'Review', assigneeId: 'emp-1', offsetDays: 0, categoryId: '', viewerIds: [], editorIds: [], items: [] },
      ]),
    )
    expect(migrated.stages[0]).not.toHaveProperty('categoryId')
    expect(migrated.stages[1]).not.toHaveProperty('categoryId')
  })
})

const workspace = (templates: ChecklistTemplate[]): AppData =>
  ({
    employees: [{ id: 'emp-1', name: 'Avery', role: 'Bookkeeper' }],
    clients: [
      { id: 'client-1', name: 'Acme', contact: 'A', billingMode: 'hourly', hourlyRate: 100, planIds: [], contactIds: [] },
    ],
    plans: [],
    contacts: [],
    timeEntries: [],
    checklistTemplates: templates,
    checklists: [],
    recycledChecklists: [],
    timesheetLocks: [],
    weeklySubmissions: [],
    reimbursements: [],
    recurringReimbursements: [],
    inactiveEmployees: [],
  }) as unknown as AppData

const stepOne = (categoryId?: string | null) => ({
  id: 's1',
  name: 'Prepare',
  assigneeId: 'emp-1',
  offsetDays: 0,
  ...(categoryId !== undefined ? { categoryId } : {}),
  viewerIds: [],
  editorIds: [],
  items: [{ id: 'ti-1', label: 'Reconcile' }],
})

describe('generated tasks copy the step column, falling back to the recipe', () => {
  it('the browser materializer files Step 1 under its own column', () => {
    const { data } = ensureRecurringChecklists(
      workspace([{ ...template([stepOne('cat-prep')]), nextDueDate: localDateOnly() }]),
    )
    expect(data.checklists.length).toBeGreaterThan(0)
    for (const checklist of data.checklists) expect(checklist.categoryId).toBe('cat-prep')
  })

  it('the browser materializer uses the recipe column for a step without one', () => {
    const { data } = ensureRecurringChecklists(
      workspace([{ ...template([stepOne()]), nextDueDate: localDateOnly() }]),
    )
    expect(data.checklists.length).toBeGreaterThan(0)
    for (const checklist of data.checklists) expect(checklist.categoryId).toBe('cat-recipe')
  })

  it('an upcoming (projected) task shows in Step 1 column', () => {
    const ghosts = projectUpcomingChecklists(
      workspace([{ ...template([stepOne('cat-prep')]), nextDueDate: dateOffset(10) }]),
      { fromDateOnly: localDateOnly(), horizonEndDateOnly: dateOffset(40) },
    )
    expect(ghosts.length).toBeGreaterThan(0)
    for (const ghost of ghosts) expect(ghost.categoryId).toBe('cat-prep')
    const fallback = projectUpcomingChecklists(
      workspace([{ ...template([stepOne()]), nextDueDate: dateOffset(10) }]),
      { fromDateOnly: localDateOnly(), horizonEndDateOnly: dateOffset(40) },
    )
    for (const ghost of fallback) expect(ghost.categoryId).toBe('cat-recipe')
  })
})

describe('the Board resolves a task column: its own, then its step, then the recipe', () => {
  const categories = [
    { id: 'cat-recipe', name: 'Monthly Bookkeeping', sortOrder: 0 },
    { id: 'cat-review', name: 'Review', sortOrder: 1 },
    { id: 'cat-own', name: 'Moved by hand', sortOrder: 2 },
  ]
  const recipe = template([
    stepOne(),
    { id: 's2', name: 'Review', assigneeId: 'emp-1', offsetDays: 0, categoryId: 'cat-review', viewerIds: [], editorIds: [], items: [] },
  ])
  const task = (over: Partial<Checklist>): Checklist =>
    ({
      id: 'x',
      title: 't',
      clientId: 'client-1',
      assigneeId: 'emp-1',
      dueDate: '2026-10-20',
      viewerIds: [],
      editorIds: [],
      templateId: 'tpl-1',
      items: [{ id: 'i', label: 'l', done: false }],
      ...over,
    }) as Checklist
  const columnOf = (checklist: Checklist) => {
    const board = buildActiveBoard({
      checklists: [checklist],
      categories,
      templates: [recipe],
      periodType: 'month',
      today: '2026-10-12',
      clientNameById: { 'client-1': 'Acme' },
    })
    return board.columns.find((column) => column.openClientCount > 0)?.id
  }

  it('a task with its own column stays there, whatever its step says (existing tasks do not move)', () => {
    expect(columnOf(task({ stageId: 's2', categoryId: 'cat-own' }))).toBe('cat-own')
  })
  it('a task without one goes to its step column', () => {
    expect(columnOf(task({ stageId: 's2', categoryId: null }))).toBe('cat-review')
  })
  it('a task whose step has no column goes to the recipe column', () => {
    expect(columnOf(task({ stageId: 's1', categoryId: null }))).toBe('cat-recipe')
  })
  it('a task whose step is gone from the recipe goes to the recipe column', () => {
    expect(columnOf(task({ stageId: 'gone', categoryId: null }))).toBe('cat-recipe')
  })
  it('a step pointing at a deleted column lands in Uncategorized', () => {
    const board = buildActiveBoard({
      checklists: [task({ stageId: 's2', categoryId: null })],
      categories: categories.filter((category) => category.id !== 'cat-review'),
      templates: [recipe],
      periodType: 'month',
      today: '2026-10-12',
      clientNameById: { 'client-1': 'Acme' },
    })
    expect(board.columns.find((column) => column.id === UNCATEGORIZED_ID)?.openClientCount).toBe(1)
  })
})
