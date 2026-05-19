import { describe, expect, it } from 'vitest'
import {
  flattenOutline,
  indentItem,
  outdentItem,
  pruneEmptyOutlineItems,
} from '../lib/checklistTree'
import type { ChecklistTemplateItem } from '../lib/types'

/**
 * Unit tests for the outliner tree-restructure pure functions
 * (`src/lib/checklistTree.ts`). These back the Tab / Shift+Tab keyboard flow
 * and the indent/outdent arrow buttons in the nested-checklist creation
 * surfaces. Stable, fixed ids are used so structure assertions are exact.
 */

/** A small forest builder — items with optional sub / sub-sub children. */
function item(
  id: string,
  label: string,
  subItems?: ChecklistTemplateItem['subItems'],
): ChecklistTemplateItem {
  return { id, label, ...(subItems ? { subItems } : {}) }
}

describe('indentItem — depth 1 → 2', () => {
  it('indents a top-level item under the item immediately above it', () => {
    const items = [item('a', 'First'), item('b', 'Second')]
    const next = indentItem(items, 'b')

    // "Second" is now the sole sub-step of "First".
    expect(next).toHaveLength(1)
    expect(next[0].id).toBe('a')
    expect(next[0].subItems).toHaveLength(1)
    expect(next[0].subItems![0]).toMatchObject({ id: 'b', title: 'Second' })
  })

  it('appends the indented item AFTER any existing sub-steps of the target', () => {
    const items = [
      item('a', 'First', [{ id: 's1', title: 'Existing sub' }]),
      item('b', 'Second'),
    ]
    const next = indentItem(items, 'b')

    expect(next[0].subItems!.map((s) => s.id)).toEqual(['s1', 'b'])
  })

  it('does nothing when the item has no sibling above it (nothing to nest under)', () => {
    const items = [item('a', 'First'), item('b', 'Second')]
    // "a" is the very first row — Tab must be a no-op.
    expect(indentItem(items, 'a')).toBe(items)
  })

  it('does nothing for an unknown id', () => {
    const items = [item('a', 'First')]
    expect(indentItem(items, 'missing')).toBe(items)
  })

  it('refuses to indent an item whose children already have sub-sub-steps', () => {
    // Indenting "b" to depth 2 would push its grand-children to depth 4.
    const items = [
      item('a', 'First'),
      item('b', 'Second', [
        { id: 's1', title: 'Sub', subItems: [{ id: 'ss1', title: 'Sub-sub' }] },
      ]),
    ]
    expect(indentItem(items, 'b')).toBe(items)
  })

  it('carries an indented item\'s own (childless) sub-steps down with it', () => {
    const items = [
      item('a', 'First'),
      item('b', 'Second', [{ id: 's1', title: 'Sub of second' }]),
    ]
    const next = indentItem(items, 'b')

    // "Second" became a sub-step; its sub-step became a sub-sub-step.
    const movedSub = next[0].subItems!.find((s) => s.id === 'b')
    expect(movedSub).toBeDefined()
    expect(movedSub!.subItems).toHaveLength(1)
    expect(movedSub!.subItems![0]).toMatchObject({ id: 's1', title: 'Sub of second' })
  })
})

describe('indentItem — depth 2 → 3', () => {
  it('indents a sub-step into a sub-sub-step under the sub-step above it', () => {
    const items = [
      item('a', 'Item', [
        { id: 's1', title: 'Sub one' },
        { id: 's2', title: 'Sub two' },
      ]),
    ]
    const next = indentItem(items, 's2')

    const subItems = next[0].subItems!
    expect(subItems).toHaveLength(1)
    expect(subItems[0].id).toBe('s1')
    expect(subItems[0].subItems).toHaveLength(1)
    expect(subItems[0].subItems![0]).toMatchObject({ id: 's2', title: 'Sub two' })
  })

  it('does nothing for the first sub-step (no sub-step sibling above it)', () => {
    const items = [
      item('a', 'Item', [
        { id: 's1', title: 'Sub one' },
        { id: 's2', title: 'Sub two' },
      ]),
    ]
    expect(indentItem(items, 's1')).toBe(items)
  })

  it('refuses to indent a sub-step that already has sub-sub-steps (cap is 3)', () => {
    const items = [
      item('a', 'Item', [
        { id: 's1', title: 'Sub one' },
        { id: 's2', title: 'Sub two', subItems: [{ id: 'ss1', title: 'Deep' }] },
      ]),
    ]
    expect(indentItem(items, 's2')).toBe(items)
  })
})

describe('indentItem — depth cap', () => {
  it('does nothing when indenting a sub-sub-step (already the deepest level)', () => {
    const items = [
      item('a', 'Item', [
        {
          id: 's1',
          title: 'Sub',
          subItems: [
            { id: 'ss1', title: 'Sub-sub one' },
            { id: 'ss2', title: 'Sub-sub two' },
          ],
        },
      ]),
    ]
    // A sub-sub-step cannot indent past level 3 even with a sibling above it.
    expect(indentItem(items, 'ss2')).toBe(items)
  })
})

describe('outdentItem — depth 2 → 1', () => {
  it('outdents a sub-step back to a top-level item right after its parent', () => {
    const items = [
      item('a', 'First', [
        { id: 's1', title: 'Sub one' },
        { id: 's2', title: 'Sub two' },
      ]),
      item('b', 'Second'),
    ]
    const next = outdentItem(items, 's1')

    // "Sub one" is promoted to a top-level item, inserted right after "First".
    expect(next.map((i) => i.id)).toEqual(['a', 's1', 'b'])
    const promoted = next.find((i) => i.id === 's1')!
    expect(promoted.label).toBe('Sub one')
    // It left its parent's sub-item list.
    expect(next[0].subItems!.map((s) => s.id)).toEqual(['s2'])
  })

  it('promotes a sub-step\'s own sub-sub-steps to sub-steps as it outdents', () => {
    const items = [
      item('a', 'Item', [
        {
          id: 's1',
          title: 'Sub',
          subItems: [{ id: 'ss1', title: 'Deep one' }],
        },
      ]),
    ]
    const next = outdentItem(items, 's1')

    const promoted = next.find((i) => i.id === 's1')!
    expect(promoted.subItems).toHaveLength(1)
    expect(promoted.subItems![0]).toMatchObject({ id: 'ss1', title: 'Deep one' })
  })

  it('does nothing when outdenting a top-level item (already at the top)', () => {
    const items = [item('a', 'First'), item('b', 'Second')]
    expect(outdentItem(items, 'a')).toBe(items)
  })

  it('does nothing for an unknown id', () => {
    const items = [item('a', 'First')]
    expect(outdentItem(items, 'missing')).toBe(items)
  })
})

describe('outdentItem — depth 3 → 2', () => {
  it('outdents a sub-sub-step back to a sub-step right after its parent', () => {
    const items = [
      item('a', 'Item', [
        {
          id: 's1',
          title: 'Sub one',
          subItems: [
            { id: 'ss1', title: 'Deep one' },
            { id: 'ss2', title: 'Deep two' },
          ],
        },
        { id: 's2', title: 'Sub two' },
      ]),
    ]
    const next = outdentItem(items, 'ss1')

    // "Deep one" becomes a sub-step inserted right after its parent "Sub one".
    expect(next[0].subItems!.map((s) => s.id)).toEqual(['s1', 'ss1', 's2'])
    const promoted = next[0].subItems!.find((s) => s.id === 'ss1')!
    expect(promoted.title).toBe('Deep one')
    // It left its parent sub-step's sub-sub list.
    const parentSub = next[0].subItems!.find((s) => s.id === 's1')!
    expect(parentSub.subItems!.map((s) => s.id)).toEqual(['ss2'])
  })
})

describe('indent / outdent — round trip and immutability', () => {
  it('indent then outdent returns an equivalent structure', () => {
    const items = [item('a', 'First'), item('b', 'Second')]
    const indented = indentItem(items, 'b')
    const restored = outdentItem(indented, 'b')

    expect(restored.map((i) => i.id)).toEqual(['a', 'b'])
    expect(restored.map((i) => i.label)).toEqual(['First', 'Second'])
  })

  it('never mutates the input forest', () => {
    const items = [item('a', 'First'), item('b', 'Second')]
    const snapshot = JSON.stringify(items)
    indentItem(items, 'b')
    expect(JSON.stringify(items)).toBe(snapshot)
  })
})

describe('flattenOutline — visible rows with capability flags', () => {
  it('flattens three levels into ordered rows with the right depth', () => {
    const items = [
      item('a', 'Item', [
        { id: 's1', title: 'Sub', subItems: [{ id: 'ss1', title: 'Sub-sub' }] },
      ]),
      item('b', 'Second'),
    ]
    const rows = flattenOutline(items)

    expect(rows.map((r) => [r.id, r.depth])).toEqual([
      ['a', 1],
      ['s1', 2],
      ['ss1', 3],
      ['b', 1], // 'b' is a second top-level item
    ])
  })

  it('marks canIndent false for a first sibling and true once it has a sibling above', () => {
    const items = [item('a', 'First'), item('b', 'Second')]
    const rows = flattenOutline(items)

    expect(rows.find((r) => r.id === 'a')!.canIndent).toBe(false)
    expect(rows.find((r) => r.id === 'b')!.canIndent).toBe(true)
  })

  it('marks canIndent false for a depth-3 row (cannot go deeper)', () => {
    const items = [
      item('a', 'Item', [
        {
          id: 's1',
          title: 'Sub',
          subItems: [
            { id: 'ss1', title: 'Deep one' },
            { id: 'ss2', title: 'Deep two' },
          ],
        },
      ]),
    ]
    const rows = flattenOutline(items)
    expect(rows.find((r) => r.id === 'ss2')!.canIndent).toBe(false)
  })

  it('marks canIndent false for an item whose descendants would overflow the cap', () => {
    const items = [
      item('a', 'First'),
      item('b', 'Second', [
        { id: 's1', title: 'Sub', subItems: [{ id: 'ss1', title: 'Deep' }] },
      ]),
    ]
    const rows = flattenOutline(items)
    // "b" has a sibling above but indenting would push 'ss1' to depth 4.
    expect(rows.find((r) => r.id === 'b')!.canIndent).toBe(false)
  })

  it('marks canOutdent true for nested rows and false for top-level items', () => {
    const items = [
      item('a', 'Item', [
        { id: 's1', title: 'Sub', subItems: [{ id: 'ss1', title: 'Deep' }] },
      ]),
    ]
    const rows = flattenOutline(items)
    expect(rows.find((r) => r.id === 'a')!.canOutdent).toBe(false)
    expect(rows.find((r) => r.id === 's1')!.canOutdent).toBe(true)
    expect(rows.find((r) => r.id === 'ss1')!.canOutdent).toBe(true)
  })
})

describe('pruneEmptyOutlineItems', () => {
  it('drops blank rows and trims surviving text at every level', () => {
    const items = [
      item('a', '  Real item  ', [
        { id: 's1', title: '' },
        { id: 's2', title: ' Real sub ' },
      ]),
      item('b', ''),
    ]
    const pruned = pruneEmptyOutlineItems(items)

    expect(pruned).toHaveLength(1)
    expect(pruned[0]).toMatchObject({ id: 'a', label: 'Real item' })
    expect(pruned[0].subItems).toHaveLength(1)
    expect(pruned[0].subItems![0]).toMatchObject({ id: 's2', title: 'Real sub' })
  })

  it('keeps a blank-text parent when it still has surviving children', () => {
    const items = [item('a', '', [{ id: 's1', title: 'Real sub' }])]
    const pruned = pruneEmptyOutlineItems(items)
    expect(pruned).toHaveLength(1)
    expect(pruned[0].subItems).toHaveLength(1)
  })

  it('returns an empty forest when every row is blank', () => {
    const items = [item('a', '   '), item('b', '')]
    expect(pruneEmptyOutlineItems(items)).toEqual([])
  })
})
