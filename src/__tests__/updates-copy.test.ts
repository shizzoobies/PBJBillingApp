import { describe, expect, it } from 'vitest'
import {
  formatBacklogForClaude,
  formatRequestForClaude,
  PRIORITY_LABELS,
  PRIORITY_ORDER,
  priorityWeight,
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
    priority: overrides.priority ?? 'medium',
    priorityRank: overrides.priorityRank ?? 0,
    devNotes: overrides.devNotes ?? null,
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? null,
  }
}

describe('priorityWeight', () => {
  it('orders the levels urgent < high < medium < low', () => {
    expect(PRIORITY_ORDER).toEqual({ urgent: 0, high: 1, medium: 2, low: 3 })
    expect(priorityWeight('urgent')).toBeLessThan(priorityWeight('high'))
    expect(priorityWeight('high')).toBeLessThan(priorityWeight('medium'))
    expect(priorityWeight('medium')).toBeLessThan(priorityWeight('low'))
  })

  it('exposes display labels for each level', () => {
    expect(PRIORITY_LABELS).toEqual({
      urgent: 'Urgent',
      high: 'High',
      medium: 'Medium',
      low: 'Low',
    })
  })
})

describe('sortFeatureRequests', () => {
  it('groups by priority level first — all urgents above all highs above mediums above lows', () => {
    const items = [
      make({ id: 'low', priority: 'low', priorityRank: 0 }),
      make({ id: 'high', priority: 'high', priorityRank: 5 }),
      make({ id: 'urgent', priority: 'urgent', priorityRank: 9 }),
      make({ id: 'medium', priority: 'medium', priorityRank: 1 }),
    ]
    expect(sortFeatureRequests(items).map((i) => i.id)).toEqual([
      'urgent',
      'high',
      'medium',
      'low',
    ])
  })

  it('puts the last urgent above the first high regardless of rank', () => {
    const items = [
      make({ id: 'high-top', priority: 'high', priorityRank: 0 }),
      make({ id: 'urgent-bottom', priority: 'urgent', priorityRank: 99 }),
    ]
    expect(sortFeatureRequests(items).map((i) => i.id)).toEqual(['urgent-bottom', 'high-top'])
  })

  it('orders by priorityRank ascending WITHIN a level', () => {
    const items = [
      make({ id: 'u3', priority: 'urgent', priorityRank: 3 }),
      make({ id: 'u1', priority: 'urgent', priorityRank: 1 }),
      make({ id: 'u2', priority: 'urgent', priorityRank: 2 }),
    ]
    expect(sortFeatureRequests(items).map((i) => i.id)).toEqual(['u1', 'u2', 'u3'])
  })

  it('breaks rank ties by createdAt (ascending) within a level', () => {
    const items = [
      make({
        id: 'late',
        priority: 'high',
        priorityRank: 2,
        createdAt: '2026-03-01T00:00:00.000Z',
      }),
      make({
        id: 'early',
        priority: 'high',
        priorityRank: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    ]
    expect(sortFeatureRequests(items).map((i) => i.id)).toEqual(['early', 'late'])
  })

  it('does not mutate the input array', () => {
    const items = [
      make({ id: 'a', priority: 'low' }),
      make({ id: 'b', priority: 'urgent' }),
    ]
    const before = items.map((i) => i.id)
    sortFeatureRequests(items)
    expect(items.map((i) => i.id)).toEqual(before)
  })
})

describe('formatRequestForClaude', () => {
  it('labels a bug and shows the Urgent level, omitting empty notes', () => {
    const item = make({
      type: 'bug',
      title: 'Saving loses data',
      description: 'Edits vanish on reload.',
      priority: 'urgent',
      devNotes: '',
    })
    expect(formatRequestForClaude(item)).toBe(
      '## [Bug] Saving loses data  (priority: Urgent)\nEdits vanish on reload.',
    )
  })

  it('shows the High level for a feature', () => {
    const item = make({
      type: 'feature',
      title: 'Add dark mode',
      description: 'A toggle in settings.',
      priority: 'high',
    })
    expect(formatRequestForClaude(item)).toBe(
      '## [Feature] Add dark mode  (priority: High)\nA toggle in settings.',
    )
  })

  it('shows the Medium / Low labels', () => {
    expect(formatRequestForClaude(make({ priority: 'medium' }))).toContain('(priority: Medium)')
    expect(formatRequestForClaude(make({ priority: 'low' }))).toContain('(priority: Low)')
  })

  it('includes a Notes line when devNotes is set', () => {
    const item = make({
      title: 'T',
      description: 'D',
      priority: 'urgent',
      devNotes: 'Check edge cases',
    })
    expect(formatRequestForClaude(item)).toBe(
      '## [Feature] T  (priority: Urgent)\nD\nNotes: Check edge cases',
    )
  })
})

describe('formatBacklogForClaude', () => {
  it('excludes done and wont_do, numbers in the new level-then-rank order', () => {
    const items = [
      make({ id: 'open-2', title: 'Second', status: 'new', priority: 'high', priorityRank: 1 }),
      make({ id: 'done', title: 'Closed', status: 'done', priority: 'urgent', priorityRank: 0 }),
      make({
        id: 'urgent',
        title: 'First',
        status: 'planned',
        priority: 'urgent',
        priorityRank: 5,
      }),
      make({ id: 'wont', title: 'Nope', status: 'wont_do', priority: 'low', priorityRank: 0 }),
    ]
    const out = formatBacklogForClaude(items)
    // Urgent first (#1), then the high item (#2); closed items gone.
    expect(out).toContain('1. ## [Feature] First  (priority: Urgent)')
    expect(out).toContain('2. ## [Feature] Second  (priority: High)')
    expect(out).not.toContain('Closed')
    expect(out).not.toContain('Nope')
  })

  it('numbers a multi-level open backlog in level-then-rank order', () => {
    const items = [
      make({ id: 'low', title: 'Low item', priority: 'low', priorityRank: 0 }),
      make({ id: 'med', title: 'Medium item', priority: 'medium', priorityRank: 0 }),
      make({ id: 'urg', title: 'Urgent item', priority: 'urgent', priorityRank: 0 }),
    ]
    const out = formatBacklogForClaude(items)
    expect(out.indexOf('Urgent item')).toBeLessThan(out.indexOf('Medium item'))
    expect(out.indexOf('Medium item')).toBeLessThan(out.indexOf('Low item'))
    expect(out).toContain('1. ## [Feature] Urgent item  (priority: Urgent)')
    expect(out).toContain('3. ## [Feature] Low item  (priority: Low)')
  })

  it('returns an empty string when there are no open items', () => {
    const items = [make({ status: 'done' }), make({ status: 'wont_do' })]
    expect(formatBacklogForClaude(items)).toBe('')
  })
})
