import type {
  ChecklistTemplateItem,
  SubChecklistTemplateItem,
  SubSubChecklistTemplateItem,
} from './types'
import { makeId } from './utils'

/**
 * Outliner tree-restructure helpers for the nested-checklist creation surfaces
 * (the NewTaskForm create form and the repeating-task template editor).
 *
 * A checklist template is a forest of up to three levels:
 *   item (`ChecklistTemplateItem`)
 *     → sub-step (`SubChecklistTemplateItem`)
 *       → sub-sub-step (`SubSubChecklistTemplateItem`)
 *
 * The two operations here — `indentItem` and `outdentItem` — are PURE tree
 * restructures used by the outliner's Tab / Shift+Tab and the indent/outdent
 * arrow buttons. They never mutate their input; they return a fresh forest.
 *
 *   indent  — a step becomes the LAST child of the sibling immediately above
 *             it at its own level.
 *   outdent — a step becomes a sibling of its parent, inserted immediately
 *             AFTER the parent.
 *
 * Caps: a step cannot indent past level 3, cannot outdent past level 1, and
 * cannot indent when it has no preceding sibling at its level (nothing to nest
 * under). When an operation is not allowed the input forest is returned
 * unchanged (referential-equality preserved) so callers can no-op cheaply.
 */

/** Deepest level a checklist node may live at (item → sub → sub-sub). */
export const MAX_CHECKLIST_DEPTH = 3

/** A flattened outliner row — one visible line in the outliner UI. */
export type OutlineRow = {
  id: string
  /** The node's display text (`label` for items, `title` for nested nodes). */
  text: string
  /** 1 = top-level item, 2 = sub-step, 3 = sub-sub-step. */
  depth: 1 | 2 | 3
  /** Index of this row's id within its own level's sibling list. */
  siblingIndex: number
  /** True when there is a preceding sibling at this row's level. */
  hasSiblingAbove: boolean
  /** True when the row may indent (a sibling above exists and depth < 3). */
  canIndent: boolean
  /** True when the row may outdent (depth > 1). */
  canOutdent: boolean
}

/* -------------------------------------------------------------------------- */
/* Node constructors                                                          */
/* -------------------------------------------------------------------------- */

export function makeTemplateItem(label: string): ChecklistTemplateItem {
  return { id: makeId('template-item'), label }
}

export function makeTemplateSubItem(title: string): SubChecklistTemplateItem {
  return { id: makeId('subitem'), title }
}

export function makeTemplateSubSubItem(title: string): SubSubChecklistTemplateItem {
  return { id: makeId('subsubitem'), title }
}

/* -------------------------------------------------------------------------- */
/* Flattening — produce the visible row list with per-row capability flags     */
/* -------------------------------------------------------------------------- */

/**
 * Flatten a template item forest into the ordered list of visible outliner
 * rows, each annotated with whether it can indent / outdent. Pure.
 *
 * `canIndent` accounts for BOTH the level cap and the node's own descendants:
 * a top-level item with grand-children (its sub-steps already carry sub-sub-
 * steps) cannot indent, because pushing it to depth 2 would shove those
 * grand-children to a non-existent depth 4. Likewise a sub-step that already
 * has sub-sub-steps cannot indent.
 */
export function flattenOutline(items: ChecklistTemplateItem[]): OutlineRow[] {
  const rows: OutlineRow[] = []
  items.forEach((item, itemIndex) => {
    const itemHasGrandChildren = (item.subItems ?? []).some(
      (sub) => (sub.subItems ?? []).length > 0,
    )
    rows.push({
      id: item.id,
      text: item.label,
      depth: 1,
      siblingIndex: itemIndex,
      hasSiblingAbove: itemIndex > 0,
      // A top-level item indents under the item above it — unless it has
      // grand-children that would overflow the 3-level cap.
      canIndent: itemIndex > 0 && !itemHasGrandChildren,
      canOutdent: false,
    })
    const subItems = item.subItems ?? []
    subItems.forEach((sub, subIndex) => {
      const subHasChildren = (sub.subItems ?? []).length > 0
      rows.push({
        id: sub.id,
        text: sub.title,
        depth: 2,
        siblingIndex: subIndex,
        hasSiblingAbove: subIndex > 0,
        // A sub-step indents under the sub-step above it (depth 2 → 3) — unless
        // it already has sub-sub-steps that would overflow the cap.
        canIndent: subIndex > 0 && !subHasChildren,
        canOutdent: true,
      })
      const subSubItems = sub.subItems ?? []
      subSubItems.forEach((subSub, subSubIndex) => {
        rows.push({
          id: subSub.id,
          text: subSub.title,
          depth: 3,
          siblingIndex: subSubIndex,
          hasSiblingAbove: subSubIndex > 0,
          // Already at the deepest level — cannot indent further.
          canIndent: false,
          canOutdent: true,
        })
      })
    })
  })
  return rows
}

/* -------------------------------------------------------------------------- */
/* Lookup — locate a node anywhere in the three-level forest                   */
/* -------------------------------------------------------------------------- */

type NodeLocation =
  | { depth: 1; itemIndex: number }
  | { depth: 2; itemIndex: number; subIndex: number }
  | { depth: 3; itemIndex: number; subIndex: number; subSubIndex: number }

function locate(items: ChecklistTemplateItem[], id: string): NodeLocation | null {
  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    const item = items[itemIndex]
    if (item.id === id) {
      return { depth: 1, itemIndex }
    }
    const subItems = item.subItems ?? []
    for (let subIndex = 0; subIndex < subItems.length; subIndex += 1) {
      const sub = subItems[subIndex]
      if (sub.id === id) {
        return { depth: 2, itemIndex, subIndex }
      }
      const subSubItems = sub.subItems ?? []
      for (let subSubIndex = 0; subSubIndex < subSubItems.length; subSubIndex += 1) {
        if (subSubItems[subSubIndex].id === id) {
          return { depth: 3, itemIndex, subIndex, subSubIndex }
        }
      }
    }
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* Indent / outdent — the core pure tree restructures                          */
/* -------------------------------------------------------------------------- */

/**
 * Indent the node `id` one level deeper: it becomes the last child of the
 * sibling immediately above it. Returns the input forest unchanged when the
 * node is unknown, already at level 3, has no preceding sibling, or has
 * descendants that would overflow the 3-level cap.
 */
export function indentItem(
  items: ChecklistTemplateItem[],
  id: string,
): ChecklistTemplateItem[] {
  const loc = locate(items, id)
  if (!loc) return items

  // Level 1 → 2: item becomes the last sub-step of the item above it. An item
  // whose own sub-steps already carry sub-sub-steps cannot indent — that would
  // push the grand-children to a non-existent depth 4.
  if (loc.depth === 1) {
    if (loc.itemIndex === 0) return items
    const moving = items[loc.itemIndex]
    const movingSubItems = moving.subItems ?? []
    if (movingSubItems.some((sub) => (sub.subItems ?? []).length > 0)) {
      return items
    }
    const movedSub: SubChecklistTemplateItem = {
      id: moving.id,
      title: moving.label,
      ...(movingSubItems.length > 0
        ? { subItems: movingSubItems.map((sub) => ({ id: sub.id, title: sub.title })) }
        : {}),
    }
    const next = items.map((item) => ({ ...item }))
    const target = next[loc.itemIndex - 1]
    target.subItems = [...(target.subItems ?? []), movedSub]
    next.splice(loc.itemIndex, 1)
    return next
  }

  // Level 2 → 3: sub-step becomes the last sub-sub-step of the sub-step above.
  if (loc.depth === 2) {
    if (loc.subIndex === 0) return items
    const next = items.map((item) => ({ ...item }))
    const parentItem = next[loc.itemIndex]
    const subItems = (parentItem.subItems ?? []).map((sub) => ({ ...sub }))
    const moving = subItems[loc.subIndex]
    // A depth-2 node with its own sub-sub children cannot indent — indenting
    // would push those children to a non-existent depth 4. Guard it.
    if (moving.subItems && moving.subItems.length > 0) return items
    const movedSubSub: SubSubChecklistTemplateItem = {
      id: moving.id,
      title: moving.title,
    }
    const target = subItems[loc.subIndex - 1]
    target.subItems = [...(target.subItems ?? []), movedSubSub]
    subItems.splice(loc.subIndex, 1)
    parentItem.subItems = subItems
    return next
  }

  // Level 3 is the deepest level — nothing to indent into.
  return items
}

/**
 * Outdent the node `id` one level shallower: it becomes a sibling of its
 * parent, inserted immediately after the parent. Returns the input forest
 * unchanged when the node is unknown or already at the top level.
 */
export function outdentItem(
  items: ChecklistTemplateItem[],
  id: string,
): ChecklistTemplateItem[] {
  const loc = locate(items, id)
  if (!loc) return items

  // Level 1 cannot outdent.
  if (loc.depth === 1) return items

  // Level 2 → 1: sub-step becomes a top-level item right after its parent item.
  if (loc.depth === 2) {
    const next = items.map((item) => ({ ...item }))
    const parentItem = next[loc.itemIndex]
    const subItems = (parentItem.subItems ?? []).map((sub) => ({ ...sub }))
    const moving = subItems[loc.subIndex]
    subItems.splice(loc.subIndex, 1)
    parentItem.subItems = subItems
    const promoted: ChecklistTemplateItem = {
      id: moving.id,
      label: moving.title,
      ...(moving.subItems && moving.subItems.length > 0
        ? { subItems: moving.subItems.map((subSub) => ({ ...subSub })) }
        : {}),
    }
    next.splice(loc.itemIndex + 1, 0, promoted)
    return next
  }

  // Level 3 → 2: sub-sub-step becomes a sub-step right after its parent sub.
  const next = items.map((item) => ({ ...item }))
  const parentItem = next[loc.itemIndex]
  const subItems = (parentItem.subItems ?? []).map((sub) => ({ ...sub }))
  const parentSub = subItems[loc.subIndex]
  const subSubItems = (parentSub.subItems ?? []).map((s) => ({ ...s }))
  const moving = subSubItems[loc.subSubIndex]
  subSubItems.splice(loc.subSubIndex, 1)
  parentSub.subItems = subSubItems
  const promoted: SubChecklistTemplateItem = {
    id: moving.id,
    title: moving.title,
  }
  subItems.splice(loc.subIndex + 1, 0, promoted)
  parentItem.subItems = subItems
  return next
}

/* -------------------------------------------------------------------------- */
/* Pruning — drop blank rows before a forest is submitted                      */
/* -------------------------------------------------------------------------- */

/**
 * Remove blank-text rows from a template item forest. The outliner lets a user
 * leave an empty row mid-edit (e.g. a fresh row they never typed into); this
 * trims text at every level and drops any node whose text is empty AND has no
 * surviving children. Returns a fresh forest; never mutates the input.
 */
export function pruneEmptyOutlineItems(
  items: ChecklistTemplateItem[],
): ChecklistTemplateItem[] {
  const result: ChecklistTemplateItem[] = []
  for (const item of items) {
    const label = item.label.trim()
    const subItems: SubChecklistTemplateItem[] = []
    for (const sub of item.subItems ?? []) {
      const title = sub.title.trim()
      const subSubItems = (sub.subItems ?? [])
        .map((subSub) => ({ ...subSub, title: subSub.title.trim() }))
        .filter((subSub) => subSub.title.length > 0)
      if (title.length === 0 && subSubItems.length === 0) continue
      subItems.push({
        id: sub.id,
        title,
        ...(subSubItems.length > 0 ? { subItems: subSubItems } : {}),
      })
    }
    if (label.length === 0 && subItems.length === 0) continue
    result.push({
      ...item,
      label,
      ...(subItems.length > 0 ? { subItems } : {}),
    })
  }
  return result
}
