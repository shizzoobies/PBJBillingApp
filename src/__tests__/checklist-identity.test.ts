/**
 * The shared recurring-instance identity rule (lib/checklist-identity.js).
 *
 * This tuple is the single source of truth for "is this period already
 * materialized?" across THREE callers — the server materializer in
 * `db/store.js`, the browser-side `ensureRecurringChecklists`, and the
 * on-demand generate endpoint — and it is the same tuple the Postgres UNIQUE
 * partial index `checklists_template_instance_uniq` enforces. If these
 * assertions change, that index has to change with them.
 */
import {
  CHECKLIST_INSTANCE_UNIQUE_INDEX,
  buildChecklistInstanceKeys,
  checklistInstanceKey,
  checklistMonthKey,
  findChecklistInstance,
} from '../../lib/checklist-identity.js'
import { describe, expect, it } from 'vitest'

describe('checklistInstanceKey', () => {
  it('is template + due date + stage index', () => {
    expect(checklistInstanceKey('tpl-1', '2026-07-15', 0)).toBe('tpl-1:2026-07-15:0')
    expect(checklistInstanceKey('tpl-1', '2026-07-15', 2)).toBe('tpl-1:2026-07-15:2')
  })

  it('defaults a missing stage index to stage 0', () => {
    expect(checklistInstanceKey('tpl-1', '2026-07-15')).toBe('tpl-1:2026-07-15:0')
    expect(checklistInstanceKey('tpl-1', '2026-07-15', null)).toBe('tpl-1:2026-07-15:0')
  })

  it('has no identity without a template or a due date — one-off checklists are never deduped', () => {
    expect(checklistInstanceKey(null, '2026-07-15', 0)).toBeNull()
    expect(checklistInstanceKey('tpl-1', null, 0)).toBeNull()
  })

  it('keeps separate stages of one case apart', () => {
    // A multi-stage case can have stage 1 and stage 2 due on the same day.
    expect(checklistInstanceKey('tpl-1', '2026-07-15', 0)).not.toBe(
      checklistInstanceKey('tpl-1', '2026-07-15', 1),
    )
  })
})

describe('checklistMonthKey', () => {
  it('collapses a due date to its year-month', () => {
    expect(checklistMonthKey('tpl-1', '2026-07-15')).toBe('tpl-1:2026-07')
    expect(checklistMonthKey('tpl-1', '2026-07-31')).toBe('tpl-1:2026-07')
  })

  it('is deliberately NOT the instance key — a weekly template has several per month', () => {
    expect(checklistMonthKey('tpl-1', '2026-07-06')).toBe(
      checklistMonthKey('tpl-1', '2026-07-13'),
    )
    expect(checklistInstanceKey('tpl-1', '2026-07-06', 0)).not.toBe(
      checklistInstanceKey('tpl-1', '2026-07-13', 0),
    )
  })
})

describe('buildChecklistInstanceKeys', () => {
  const active = [
    { templateId: 'tpl-1', dueDate: '2026-07-15', stageIndex: 0 },
    { templateId: null, dueDate: '2026-07-15', stageIndex: 0 }, // one-off, no identity
  ]
  const recycled = [{ templateId: 'tpl-2', dueDate: '2026-06-30', stageIndex: 0 }]

  it('folds every list into one key set', () => {
    const { instanceKeys, monthKeys } = buildChecklistInstanceKeys(active, recycled)
    expect(instanceKeys.has('tpl-1:2026-07-15:0')).toBe(true)
    // Recycled counts as "already happened" so a delete is not undone.
    expect(instanceKeys.has('tpl-2:2026-06-30:0')).toBe(true)
    expect(monthKeys.has('tpl-1:2026-07')).toBe(true)
    expect(instanceKeys.size).toBe(2) // the template-less row contributed nothing
  })

  it('tolerates missing / non-array inputs', () => {
    const { instanceKeys } = buildChecklistInstanceKeys(undefined, null, [null])
    expect(instanceKeys.size).toBe(0)
  })
})

describe('findChecklistInstance', () => {
  const checklists = [
    { id: 'a', templateId: 'tpl-1', dueDate: '2026-07-15', stageIndex: 0 },
    { id: 'b', templateId: 'tpl-1', dueDate: '2026-08-15', stageIndex: 0 },
  ]

  it('returns the existing instance so a generator can hand it back instead of duplicating', () => {
    expect(findChecklistInstance(checklists, 'tpl-1', '2026-07-15', 0)?.id).toBe('a')
  })

  it('returns undefined when the period has not been materialized', () => {
    expect(findChecklistInstance(checklists, 'tpl-1', '2026-09-15', 0)).toBeUndefined()
  })
})

describe('CHECKLIST_INSTANCE_UNIQUE_INDEX', () => {
  it('names the Postgres backstop the boot migration creates', () => {
    expect(CHECKLIST_INSTANCE_UNIQUE_INDEX).toBe('checklists_template_instance_uniq')
  })
})
