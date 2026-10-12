import { describe, expect, it } from 'vitest'
import { ensureTemplateStages } from '../lib/utils'
import type { ChecklistTemplate } from '../lib/types'

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
