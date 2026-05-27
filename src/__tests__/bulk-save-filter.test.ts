/**
 * Regression tests for `filterBulkSaveOrphans` — the orphan filter that
 * runs inside `appDataStore.write()` to prevent FK violations on the
 * bulk wipe-and-reinsert path.
 *
 * The bug being pinned down: the filter used to drop checklists (active
 * AND recycled) whose `templateId` didn't match a post-filter template.
 * But `checklists.template_id` has NO foreign-key constraint in the
 * schema — it's a plain nullable text column. The filter was over-zealous,
 * silently nuking recycled-bin tombstones whenever a checklist's template
 * was filtered out. With the tombstone gone, the next read's materializer
 * saw no record of the deleted instance for the current period and
 * respawned it. That's the "checklist comes back after delete" symptom.
 *
 * Post-fix expectation: pass `getRefs` that returns only `clientId` for
 * checklist rows (since client_id IS a real FK with NOT NULL). Recycled
 * tombstones with stale templateIds must survive.
 */
// @ts-expect-error - plain-JS module without type declarations
import { filterBulkSaveOrphans } from '../../db/store.js'
import { describe, expect, it, vi } from 'vitest'

type ChecklistRow = {
  id: string
  clientId: string
  templateId?: string | null
  deletedAt?: string | null
}

function makeChecklist(overrides: Partial<ChecklistRow>): ChecklistRow {
  return {
    id: 'cl-1',
    clientId: 'client-1',
    templateId: 'tpl-1',
    deletedAt: null,
    ...overrides,
  }
}

describe('filterBulkSaveOrphans — clientId enforcement', () => {
  it('keeps a checklist whose clientId is valid', () => {
    const kept = filterBulkSaveOrphans(
      [makeChecklist({ id: 'cl-1', clientId: 'client-1' })],
      {
        validClientIds: new Set(['client-1']),
        validTemplateIds: new Set(),
        label: 'checklists',
        getRefs: (c: ChecklistRow) => ({ clientId: c?.clientId }),
      },
    )
    expect(kept).toHaveLength(1)
    expect(kept[0].id).toBe('cl-1')
  })

  it('drops a checklist whose clientId is missing from validClientIds', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const kept = filterBulkSaveOrphans(
      [makeChecklist({ id: 'cl-orphan', clientId: 'client-deleted' })],
      {
        validClientIds: new Set(['client-1']),
        validTemplateIds: new Set(),
        label: 'checklists',
        getRefs: (c: ChecklistRow) => ({ clientId: c?.clientId }),
      },
    )
    expect(kept).toHaveLength(0)
    expect(consoleSpy).toHaveBeenCalled()
    consoleSpy.mockRestore()
  })
})

describe('filterBulkSaveOrphans — recycled-bin tombstone survival (the bug)', () => {
  it('PRESERVES a recycled checklist whose templateId references a missing template (no FK check)', () => {
    // The exact production scenario: a recycled (soft-deleted) checklist
    // was originally spawned from a recurring template. Later, the
    // template got filtered out of the bulk-save batch (e.g., because
    // the template's clientId went missing). The recycled checklist
    // itself still has a valid clientId. Pre-fix, the filter dropped
    // this row because its templateId wasn't in safeTemplates. Post-fix,
    // we don't check templateId (it has no FK) so the row survives.
    const recycled = makeChecklist({
      id: 'cl-recycled',
      clientId: 'client-1',
      templateId: 'tpl-deleted-from-batch',
      deletedAt: new Date().toISOString(),
    })
    const kept = filterBulkSaveOrphans([recycled], {
      validClientIds: new Set(['client-1']),
      // templateId 'tpl-deleted-from-batch' is NOT in here — but the
      // caller's getRefs only returns clientId, so it doesn't matter.
      validTemplateIds: new Set(['tpl-something-else']),
      label: 'recycledChecklists',
      getRefs: (c: ChecklistRow) => ({ clientId: c?.clientId }),
    })
    expect(kept).toHaveLength(1)
    expect(kept[0].id).toBe('cl-recycled')
  })

  it('drops a recycled checklist only when its clientId is missing (real FK)', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const kept = filterBulkSaveOrphans(
      [
        makeChecklist({
          id: 'cl-recycled-orphan',
          clientId: 'client-deleted',
          templateId: 'tpl-1',
        }),
      ],
      {
        validClientIds: new Set(['client-1']),
        validTemplateIds: new Set(['tpl-1']),
        label: 'recycledChecklists',
        getRefs: (c: ChecklistRow) => ({ clientId: c?.clientId }),
      },
    )
    expect(kept).toHaveLength(0)
    consoleSpy.mockRestore()
  })
})

describe('filterBulkSaveOrphans — backward-compat for callers that DO check templateId', () => {
  // Other callers (none currently in use, but the helper supports it)
  // can opt into templateId checks by including templateId in their
  // getRefs return. We keep that behavior so future tables with a real
  // template_id FK can use the same helper.
  it('drops when caller asks for templateId check AND templateId is missing', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const kept = filterBulkSaveOrphans(
      [{ id: 'something', templateId: 'tpl-missing' }],
      {
        validClientIds: new Set(),
        validTemplateIds: new Set(['tpl-real']),
        label: 'some_future_table',
        getRefs: (r: { templateId?: string }) => ({ templateId: r?.templateId }),
      },
    )
    expect(kept).toHaveLength(0)
    consoleSpy.mockRestore()
  })
})

describe('filterBulkSaveOrphans — edge cases', () => {
  it('returns [] for null/undefined input', () => {
    expect(filterBulkSaveOrphans(null, {
      validClientIds: new Set(),
      validTemplateIds: new Set(),
      label: 'x',
      getRefs: () => ({}),
    })).toEqual([])
    expect(filterBulkSaveOrphans(undefined, {
      validClientIds: new Set(),
      validTemplateIds: new Set(),
      label: 'x',
      getRefs: () => ({}),
    })).toEqual([])
  })

  it('keeps a row with no refs at all (nothing to validate)', () => {
    const kept = filterBulkSaveOrphans([{ id: 'standalone' }], {
      validClientIds: new Set(),
      validTemplateIds: new Set(),
      label: 'standalone',
      getRefs: () => ({}),
    })
    expect(kept).toHaveLength(1)
  })
})
