import { describe, expect, it } from 'vitest'
import {
  formatBacklogForClaude,
  formatRequestForClaude,
  sortFeatureRequests,
} from '../lib/updatesCopy'
import type { FeatureRequest } from '../lib/types'

/** Build a FeatureRequest with sensible defaults; override per test. */
function make(overrides: Partial<FeatureRequest> = {}): FeatureRequest {
  return {
    id: overrides.id ?? 'fr-1',
    userId: 'owner-1',
    title: overrides.title ?? 'Some title',
    description: overrides.description ?? 'Some description',
    type: overrides.type ?? 'feature',
    status: overrides.status ?? 'new',
    urgent: overrides.urgent ?? false,
    priorityRank: overrides.priorityRank ?? 0,
    devNotes: overrides.devNotes ?? null,
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? null,
  }
}

describe('sortFeatureRequests', () => {
  it('pins urgent items to the top regardless of rank', () => {
    const items = [
      make({ id: 'a', urgent: false, priorityRank: 0 }),
      make({ id: 'b', urgent: true, priorityRank: 9 }),
      make({ id: 'c', urgent: false, priorityRank: 1 }),
    ]
    expect(sortFeatureRequests(items).map((i) => i.id)).toEqual(['b', 'a', 'c'])
  })

  it('breaks rank ties by createdAt (ascending)', () => {
    const items = [
      make({ id: 'late', priorityRank: 2, createdAt: '2026-03-01T00:00:00.000Z' }),
      make({ id: 'early', priorityRank: 2, createdAt: '2026-01-01T00:00:00.000Z' }),
    ]
    expect(sortFeatureRequests(items).map((i) => i.id)).toEqual(['early', 'late'])
  })

  it('orders by rank ascending when no urgency', () => {
    const items = [
      make({ id: 'x', priorityRank: 3 }),
      make({ id: 'y', priorityRank: 1 }),
      make({ id: 'z', priorityRank: 2 }),
    ]
    expect(sortFeatureRequests(items).map((i) => i.id)).toEqual(['y', 'z', 'x'])
  })

  it('does not mutate the input array', () => {
    const items = [make({ id: 'a', priorityRank: 2 }), make({ id: 'b', priorityRank: 1 })]
    const before = items.map((i) => i.id)
    sortFeatureRequests(items)
    expect(items.map((i) => i.id)).toEqual(before)
  })
})

describe('formatRequestForClaude', () => {
  it('labels a bug and shows Urgent priority, omitting empty notes', () => {
    const item = make({
      type: 'bug',
      title: 'Saving loses data',
      description: 'Edits vanish on reload.',
      urgent: true,
      devNotes: '',
    })
    expect(formatRequestForClaude(item)).toBe(
      '## [Bug] Saving loses data  (priority: Urgent)\nEdits vanish on reload.',
    )
  })

  it('labels a feature and shows #rank for non-urgent items', () => {
    const item = make({
      type: 'feature',
      title: 'Add dark mode',
      description: 'A toggle in settings.',
      urgent: false,
      priorityRank: 2,
    })
    // No explicit rank → uses priorityRank + 1 (#3).
    expect(formatRequestForClaude(item)).toBe(
      '## [Feature] Add dark mode  (priority: #3)\nA toggle in settings.',
    )
  })

  it('uses the supplied display rank when provided', () => {
    const item = make({ type: 'improvement', title: 'Speed up reports', priorityRank: 7 })
    expect(formatRequestForClaude(item, 0)).toContain('(priority: #1)')
  })

  it('includes a Notes line when devNotes is set', () => {
    const item = make({ title: 'T', description: 'D', urgent: true, devNotes: 'Check edge cases' })
    expect(formatRequestForClaude(item)).toBe(
      '## [Feature] T  (priority: Urgent)\nD\nNotes: Check edge cases',
    )
  })
})

describe('formatBacklogForClaude', () => {
  it('excludes done and wont_do, numbers in sorted order', () => {
    const items = [
      make({ id: 'open-2', title: 'Second', status: 'new', priorityRank: 1 }),
      make({ id: 'done', title: 'Closed', status: 'done', priorityRank: 0 }),
      make({ id: 'urgent', title: 'First', status: 'planned', urgent: true, priorityRank: 5 }),
      make({ id: 'wont', title: 'Nope', status: 'wont_do', priorityRank: 0 }),
    ]
    const out = formatBacklogForClaude(items)
    // Urgent first (#1), then the open non-urgent item (#2); closed items gone.
    expect(out).toContain('1. ## [Feature] First  (priority: Urgent)')
    expect(out).toContain('2. ## [Feature] Second  (priority: #2)')
    expect(out).not.toContain('Closed')
    expect(out).not.toContain('Nope')
  })

  it('returns an empty string when there are no open items', () => {
    const items = [make({ status: 'done' }), make({ status: 'wont_do' })]
    expect(formatBacklogForClaude(items)).toBe('')
  })
})
