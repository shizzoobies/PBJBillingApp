/**
 * featreq-8b54d117 - "Start the first one now" starts the recipe's REAL Step 1.
 *
 * It used to create a plain one-off checklist (due today, no recipe, no step
 * fields), so ticking it ended at the last step, Step 2 never followed, and the
 * recipe later made its real Step 1 as well. Now it waits for the new recipe
 * to be saved, then asks the server's idempotent generate endpoint for Step 1
 * of the cycle the owner entered.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  firstCycleForNewRecipe,
  START_FIRST_NOT_SAVED,
  startFirstRecipeStep,
  startFirstStepBlocker,
  upsertChecklistById,
} from '../lib/recipeFirstStep'
import { settleWorkspaceSaveWaiters } from '../lib/workspaceSaveWaiters'
import type { AppData, Checklist, ChecklistTemplate, TemplateStage } from '../lib/types'

const stage = (id: string, labels: string[]): TemplateStage => ({
  id,
  name: id,
  assigneeId: 'emp-1',
  offsetDays: 0,
  viewerIds: [],
  editorIds: [],
  items: labels.map((label, index) => ({ id: `${id}-i${index}`, label })),
})

const recipe = (
  stages: TemplateStage[],
): Pick<ChecklistTemplate, 'stages' | 'nextDueDate' | 'frequency' | 'createdAt'> => ({
  stages,
  nextDueDate: '2026-10-31',
  frequency: 'monthly',
  createdAt: '2026-10-12T15:00:00.000Z',
})

const checklist = (id: string, title = 'Close'): Checklist =>
  ({ id, title, items: [] }) as unknown as Checklist

describe('startFirstStepBlocker', () => {
  it('lets a recipe whose Step 1 has steps start', () => {
    expect(startFirstStepBlocker(recipe([stage('s1', ['Reconcile'])]))).toBeNull()
  })

  it('says so for a multi-step recipe whose Step 1 is empty', () => {
    expect(startFirstStepBlocker(recipe([stage('s1', []), stage('s2', ['Review'])]))).toMatch(
      /^Step 1 has no steps yet/,
    )
  })

  it('says so for a one-step recipe with no steps', () => {
    expect(startFirstStepBlocker(recipe([stage('s1', [])]))).toMatch(/^This recipe has no steps yet/)
  })
})

describe('startFirstRecipeStep', () => {
  it('waits for the save, then generates Step 1 for the Next due date the owner entered', async () => {
    const order: string[] = []
    let resolveSaved: (value: boolean) => void = () => {}
    const saved = new Promise<boolean>((resolve) => {
      resolveSaved = resolve
    })
    const generate = vi.fn(async () => {
      order.push('generate')
      return checklist('check-1')
    })
    const pending = startFirstRecipeStep({
      template: recipe([stage('s1', ['Reconcile']), stage('s2', ['Review'])]),
      templateId: 'template-new',
      saved,
      generate,
    })
    await Promise.resolve()
    expect(generate).not.toHaveBeenCalled()
    order.push('saved')
    resolveSaved(true)
    const result = await pending
    expect(order).toEqual(['saved', 'generate'])
    expect(generate).toHaveBeenCalledWith('template-new', { dueDate: '2026-10-31' })
    expect(result).toEqual({ started: checklist('check-1') })
  })

  it('does not generate when the recipe could not be saved', async () => {
    const generate = vi.fn()
    const result = await startFirstRecipeStep({
      template: recipe([stage('s1', ['Reconcile'])]),
      templateId: 'template-new',
      saved: Promise.resolve(false),
      generate,
    })
    expect(generate).not.toHaveBeenCalled()
    expect(result).toEqual({ note: START_FIRST_NOT_SAVED })
  })

  it('never creates an empty task: an empty Step 1 is reported instead', async () => {
    const generate = vi.fn()
    const result = await startFirstRecipeStep({
      template: recipe([stage('s1', []), stage('s2', ['Review'])]),
      templateId: 'template-new',
      saved: Promise.resolve(true),
      generate,
    })
    expect(generate).not.toHaveBeenCalled()
    expect(result && 'note' in result ? result.note : '').toMatch(/^Step 1 has no steps yet/)
  })

  it('reports a failed generate in a sentence', async () => {
    const result = await startFirstRecipeStep({
      template: recipe([stage('s1', ['Reconcile'])]),
      templateId: 'template-new',
      saved: Promise.resolve(true),
      generate: async () => {
        throw new Error('Template not found')
      },
    })
    expect(result).toEqual({
      note: 'The recipe was saved, but its first checklist could not be started (Template not found). Use Generate a task now on the recipe.',
    })
  })

  it('says nothing and starts nothing in preview (saved is null), even for an empty Step 1', async () => {
    const generate = vi.fn()
    const result = await startFirstRecipeStep({
      template: recipe([stage('s1', [])]),
      templateId: 'template-new',
      saved: null,
      generate,
    })
    expect(result).toBeNull()
    expect(generate).not.toHaveBeenCalled()
  })

  it('gives up on a save that never lands, and says so', async () => {
    const generate = vi.fn()
    const result = await startFirstRecipeStep({
      template: recipe([stage('s1', ['Reconcile'])]),
      templateId: 'template-new',
      saved: new Promise<boolean>(() => {}),
      generate,
      saveTimeoutMs: 5,
    })
    expect(generate).not.toHaveBeenCalled()
    expect(result).toEqual({ note: START_FIRST_NOT_SAVED })
  })

  it('asks for the floored cycle when the typed Next due is two or more cycles back', async () => {
    const generate = vi.fn(async () => checklist('check-1'))
    await startFirstRecipeStep({
      template: {
        ...recipe([stage('s1', ['Reconcile'])]),
        nextDueDate: '2026-08-15',
        createdAt: '2026-10-12T15:00:00.000Z',
      },
      templateId: 'template-new',
      saved: Promise.resolve(true),
      generate,
    })
    expect(generate).toHaveBeenCalledWith('template-new', { dueDate: '2026-10-15' })
  })

  it('stays quiet when the app declined (generate returned nothing)', async () => {
    const result = await startFirstRecipeStep({
      template: recipe([stage('s1', ['Reconcile'])]),
      templateId: 'template-new',
      saved: Promise.resolve(true),
      generate: async () => null,
    })
    expect(result).toBeNull()
  })
})

describe('firstCycleForNewRecipe (the materializers floor)', () => {
  const base = { frequency: 'monthly' as const, createdAt: '2026-10-12T15:00:00.000Z' }
  it('keeps a future or current Next due', () => {
    expect(firstCycleForNewRecipe({ ...base, nextDueDate: '2026-10-31' })).toBe('2026-10-31')
  })
  it('keeps ONE overdue cycle, as the schedule does', () => {
    expect(firstCycleForNewRecipe({ ...base, nextDueDate: '2026-09-15' })).toBe('2026-09-15')
  })
  it('walks two or more cycles back forward to the first cycle on or after the set-up day', () => {
    expect(firstCycleForNewRecipe({ ...base, nextDueDate: '2026-07-15' })).toBe('2026-10-15')
  })
  it('has no floor without a creation stamp', () => {
    expect(
      firstCycleForNewRecipe({ frequency: 'monthly', createdAt: undefined, nextDueDate: '2026-07-15' }),
    ).toBe('2026-07-15')
  })
})

describe('upsertChecklistById', () => {
  it('appends a new checklist', () => {
    expect(upsertChecklistById([checklist('a')], checklist('b')).map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('replaces, never duplicates, a checklist the tab already has', () => {
    const merged = upsertChecklistById([checklist('a'), checklist('b', 'Old')], checklist('b', 'New'))
    expect(merged.map((c) => [c.id, c.title])).toEqual([
      ['a', 'Close'],
      ['b', 'New'],
    ])
  })
})

describe('settleWorkspaceSaveWaiters', () => {
  const saved = (templateIds: string[]) =>
    ({ checklistTemplates: templateIds.map((id) => ({ id })) }) as unknown as AppData
  const waiterFor = (id: string) => {
    const settle = vi.fn()
    return {
      settle,
      waiter: {
        covers: (data: AppData) => data.checklistTemplates.some((t) => t.id === id),
        settle,
      },
    }
  }

  it('settles a waiter once a save carries its edit, and keeps the others waiting', () => {
    const a = waiterFor('template-a')
    const b = waiterFor('template-b')
    const left = settleWorkspaceSaveWaiters([a.waiter, b.waiter], saved(['template-a']))
    expect(a.settle).toHaveBeenCalledWith(true)
    expect(b.settle).not.toHaveBeenCalled()
    expect(left).toEqual([b.waiter])
  })

  it('does not settle on a save that was already in flight without the edit', () => {
    const a = waiterFor('template-a')
    const left = settleWorkspaceSaveWaiters([a.waiter], saved([]))
    expect(a.settle).not.toHaveBeenCalled()
    expect(left).toHaveLength(1)
  })

  it('tells every waiter false when saving has stopped for good', () => {
    const a = waiterFor('template-a')
    const b = waiterFor('template-b')
    expect(settleWorkspaceSaveWaiters([a.waiter, b.waiter], null)).toEqual([])
    expect(a.settle).toHaveBeenCalledWith(false)
    expect(b.settle).toHaveBeenCalledWith(false)
  })
})

describe('the pages and the app use the real Step 1 (source pins)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const read = (relative: string) => readFileSync(path.resolve(here, relative), 'utf8')
  const handlerBody = (source: string) => {
    const start = source.indexOf('const handleCreateRepeating = async (')
    expect(start).toBeGreaterThan(-1)
    return source.slice(start, start + 1600)
  }

  it.each(['../pages/ChecklistsPage.tsx', '../pages/ClientDetailPage.tsx'])(
    '%s starts Step 1 through the generate path, never a one-off checklist',
    (file) => {
      const body = handlerBody(read(file))
      expect(body).toContain('startFirstRecipeStep(')
      expect(body).toContain('generate: generateChecklistFromTemplate')
      expect(body).not.toContain('createChecklist(')
    },
  )

  it('App merges a generated checklist by id and settles save waiters from the save loop', () => {
    const app = read('../App.tsx')
    const generate = app.slice(app.indexOf('const generateChecklistFromTemplate = async ('))
    expect(generate.slice(0, 900)).toContain('upsertChecklistById(current.checklists, created)')
    const saveNow = app.slice(app.indexOf('const saveNow = useCallback('))
    expect(saveNow.slice(0, 5000)).toContain(
      'settleWorkspaceSaveWaiters(saveWaitersRef.current, payload)',
    )
  })
})
