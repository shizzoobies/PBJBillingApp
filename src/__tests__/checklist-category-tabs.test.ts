import { describe, expect, it } from 'vitest'
import {
  buildCategoryTabs,
  categoryKeyFor,
  resolveActiveCategory,
} from '../lib/checklistCategoryTabs'
import { UNCATEGORIZED_ID } from '../lib/activeBoard'
import type { Checklist, ServiceCategory } from '../lib/types'

const CATEGORIES: ServiceCategory[] = [
  { id: 'cat-payroll', name: 'Payroll', sortOrder: 2 },
  { id: 'cat-recs', name: 'Reconciliations', sortOrder: 1 },
  { id: 'cat-tax', name: 'Sales Tax', sortOrder: 3 },
]

function mk(id: string, categoryId?: string | null): Checklist {
  return {
    id,
    clientId: 'c',
    title: id,
    assigneeId: 'e',
    dueDate: '2026-07-01',
    frequency: 'monthly',
    items: [],
    categoryId,
  } as unknown as Checklist
}

describe('categoryKeyFor', () => {
  const known = new Set(CATEGORIES.map((c) => c.id))

  it('uses the category when it exists', () => {
    expect(categoryKeyFor('cat-payroll', known)).toBe('cat-payroll')
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
  ])('routes %s to Uncategorized', (_label, value) => {
    expect(categoryKeyFor(value, known)).toBe(UNCATEGORIZED_ID)
  })

  it('routes a DELETED / unknown category to Uncategorized', () => {
    // Deleting a category leaves its id behind on every checklist that
    // referenced it. Without this the checklist matches no tab and disappears.
    expect(categoryKeyFor('cat-deleted-last-month', known)).toBe(UNCATEGORIZED_ID)
  })
})

describe('buildCategoryTabs', () => {
  it('keeps a tab for every real category, even at zero', () => {
    // An empty tab is real signal — "nothing is due in Payroll this period".
    const tabs = buildCategoryTabs([], CATEGORIES)
    expect(tabs.map((t) => t.key)).toEqual(['cat-recs', 'cat-payroll', 'cat-tax'])
    expect(tabs.every((t) => t.count === 0)).toBe(true)
  })

  it('orders tabs by sortOrder, matching the Board columns', () => {
    const tabs = buildCategoryTabs([], CATEGORIES)
    expect(tabs.map((t) => t.label)).toEqual(['Reconciliations', 'Payroll', 'Sales Tax'])
  })

  it('omits Uncategorized when nothing is in it', () => {
    const tabs = buildCategoryTabs([mk('a', 'cat-payroll')], CATEGORIES)
    expect(tabs.some((t) => t.key === UNCATEGORIZED_ID)).toBe(false)
  })

  it('appends Uncategorized LAST when it has items', () => {
    const tabs = buildCategoryTabs([mk('a', null), mk('b', 'cat-payroll')], CATEGORIES)
    expect(tabs[tabs.length - 1]).toMatchObject({ key: UNCATEGORIZED_ID, count: 1 })
  })

  it('counts each tab', () => {
    const tabs = buildCategoryTabs(
      [mk('a', 'cat-payroll'), mk('b', 'cat-payroll'), mk('c', 'cat-tax'), mk('d', null)],
      CATEGORIES,
    )
    const byKey = Object.fromEntries(tabs.map((t) => [t.key, t.count]))
    expect(byKey['cat-payroll']).toBe(2)
    expect(byKey['cat-tax']).toBe(1)
    expect(byKey['cat-recs']).toBe(0)
    expect(byKey[UNCATEGORIZED_ID]).toBe(1)
  })
})

/**
 * The invariant that matters most: tabs must never be able to hide work. Every
 * checklist has to be reachable from exactly one tab, whatever state its
 * category is in. This is the guarantee the whole layout rests on — if it can
 * break, the page silently loses tasks, which is far worse than the accordion
 * it replaced.
 */
describe('no checklist can vanish', () => {
  const messy: Checklist[] = [
    mk('has-category', 'cat-payroll'),
    mk('other-category', 'cat-tax'),
    mk('null-category', null),
    mk('undefined-category', undefined),
    mk('empty-string-category', ''),
    mk('deleted-category', 'cat-that-was-deleted'),
    mk('never-existed', 'cat-typo-from-an-import'),
  ]

  it('every checklist lands in exactly one tab, and every tab exists', () => {
    const tabs = buildCategoryTabs(messy, CATEGORIES)
    const known = new Set(CATEGORIES.map((c) => c.id))
    const tabKeys = new Set(tabs.map((t) => t.key))

    const seen = new Set<string>()
    for (const checklist of messy) {
      const key = categoryKeyFor(checklist.categoryId, known)
      expect(tabKeys.has(key)).toBe(true) // the tab it needs actually exists
      seen.add(checklist.id)
    }
    expect(seen.size).toBe(messy.length)
  })

  it('the tab counts add up to the full list — nothing dropped, nothing double-counted', () => {
    const tabs = buildCategoryTabs(messy, CATEGORIES)
    const total = tabs.reduce((sum, tab) => sum + tab.count, 0)
    expect(total).toBe(messy.length)
  })

  it('sweeps everything uncategorizable into the one catch-all tab', () => {
    const tabs = buildCategoryTabs(messy, CATEGORIES)
    const catchAll = tabs.find((t) => t.key === UNCATEGORIZED_ID)
    // null + undefined + '' + two unknown ids = 5
    expect(catchAll?.count).toBe(5)
  })

  it('still holds when NO categories are configured at all', () => {
    const tabs = buildCategoryTabs(messy, [])
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toMatchObject({ key: UNCATEGORIZED_ID, count: messy.length })
  })
})

describe('resolveActiveCategory', () => {
  const tabs = [
    { key: 'cat-recs', label: 'Reconciliations', count: 2 },
    { key: 'cat-payroll', label: 'Payroll', count: 40 },
    { key: UNCATEGORIZED_ID, label: 'Uncategorized', count: 9 },
  ]

  it('defaults to the FULLEST tab, not the first', () => {
    // Production shape: the first tab in Board order holds 2 while the bulk of
    // the work sits elsewhere. Defaulting to first lands on a near-empty view.
    expect(resolveActiveCategory({ tabs })).toBe('cat-payroll')
  })

  it('honours the URL param over the default', () => {
    expect(resolveActiveCategory({ tabs, param: 'cat-recs' })).toBe('cat-recs')
  })

  it('lets a focused checklist override the URL param — deep links cross tabs', () => {
    expect(
      resolveActiveCategory({ tabs, param: 'cat-recs', focusedKey: UNCATEGORIZED_ID }),
    ).toBe(UNCATEGORIZED_ID)
  })

  it('ignores a stale param naming a tab that no longer exists', () => {
    expect(resolveActiveCategory({ tabs, param: 'cat-deleted' })).toBe('cat-payroll')
  })

  it('ignores a focus key that is not on screen', () => {
    expect(resolveActiveCategory({ tabs, focusedKey: 'cat-not-here' })).toBe('cat-payroll')
  })

  it('never returns a key with no tab, even with no tabs at all', () => {
    expect(resolveActiveCategory({ tabs: [] })).toBe(UNCATEGORIZED_ID)
  })

  it('is deterministic on a tie — first tab in order wins', () => {
    const tied = [
      { key: 'a', label: 'A', count: 5 },
      { key: 'b', label: 'B', count: 5 },
    ]
    expect(resolveActiveCategory({ tabs: tied })).toBe('a')
  })
})
