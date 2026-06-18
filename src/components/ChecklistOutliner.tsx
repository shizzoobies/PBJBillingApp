import { ChevronLeft, ChevronRight, CornerDownRight, Plus } from 'lucide-react'
import { useRef, type KeyboardEvent } from 'react'
import { SaveBadge } from './SectionKit'
import { useSaveFlash } from '../lib/useSaveFlash'
import {
  flattenOutline,
  indentItem,
  makeTemplateItem,
  makeTemplateSubItem,
  makeTemplateSubSubItem,
  outdentItem,
  type OutlineRow,
} from '../lib/checklistTree'
import { localDateOnly } from '../lib/utils'
import type {
  ChecklistTemplateItem,
  SubChecklistTemplateItem,
} from '../lib/types'

/**
 * Outliner-style editor for a nested checklist (item → sub-step → sub-sub-step).
 *
 * Two complementary ways to build the hierarchy, per the client's brief:
 *
 *  A. Keyboard — Enter adds a sibling step (and keeps focus for rapid entry),
 *     Tab indents a step under the one above it, Shift+Tab outdents it.
 *  B. Buttons — every row carries a "+ Add sub-step" control plus indent (→)
 *     and outdent (←) arrows; arrows disable when the move is not allowed.
 *
 * It is a controlled component: `items` is the current forest, `onChange`
 * receives the next forest. The indent/outdent restructure is the pure
 * `indentItem` / `outdentItem` from `lib/checklistTree`.
 */

type ChecklistOutlinerProps = {
  items: ChecklistTemplateItem[]
  onChange: (next: ChecklistTemplateItem[]) => void
  /** Placeholder for the always-present "add a step" input at the bottom. */
  addPlaceholder?: string
  /** Optional aria-label prefix so multiple outliners on a page stay distinct. */
  ariaLabel?: string
}

/** Per-depth text-node helpers — keeps the depth → constructor mapping in one place. */
function setRowText(
  items: ChecklistTemplateItem[],
  id: string,
  text: string,
): ChecklistTemplateItem[] {
  return items.map((item) => {
    if (item.id === id) return { ...item, label: text }
    const subItems = item.subItems ?? []
    if (subItems.length === 0) return item
    let subChanged = false
    const nextSubItems = subItems.map((sub) => {
      if (sub.id === id) {
        subChanged = true
        return { ...sub, title: text }
      }
      const subSubItems = sub.subItems ?? []
      if (subSubItems.length === 0) return sub
      let subSubChanged = false
      const nextSubSub = subSubItems.map((subSub) => {
        if (subSub.id === id) {
          subSubChanged = true
          return { ...subSub, title: text }
        }
        return subSub
      })
      if (!subSubChanged) return sub
      subChanged = true
      return { ...sub, subItems: nextSubSub }
    })
    if (!subChanged) return item
    return { ...item, subItems: nextSubItems }
  })
}

/**
 * Patch the per-node due spec (`dueDate` / `dueDayOfMonth`) on the node `id` at
 * any of the three levels. The patch is shallow-merged; pass `undefined` to
 * clear a field. Mirrors `setRowText`'s level-walking shape.
 */
function setRowDue(
  items: ChecklistTemplateItem[],
  id: string,
  patch: { dueDate?: string; dueDayOfMonth?: number },
): ChecklistTemplateItem[] {
  return items.map((item) => {
    if (item.id === id) return { ...item, ...patch }
    const subItems = item.subItems ?? []
    if (subItems.length === 0) return item
    let subChanged = false
    const nextSubItems = subItems.map((sub) => {
      if (sub.id === id) {
        subChanged = true
        return { ...sub, ...patch }
      }
      const subSubItems = sub.subItems ?? []
      if (subSubItems.length === 0) return sub
      let subSubChanged = false
      const nextSubSub = subSubItems.map((subSub) => {
        if (subSub.id === id) {
          subSubChanged = true
          return { ...subSub, ...patch }
        }
        return subSub
      })
      if (!subSubChanged) return sub
      subChanged = true
      return { ...sub, subItems: nextSubSub }
    })
    if (!subChanged) return item
    return { ...item, subItems: nextSubItems }
  })
}

/** Remove the node `id` from the forest at any of the three levels. */
function removeRow(
  items: ChecklistTemplateItem[],
  id: string,
): ChecklistTemplateItem[] {
  return items
    .filter((item) => item.id !== id)
    .map((item) => {
      const subItems = item.subItems ?? []
      if (subItems.length === 0) return item
      const nextSubItems = subItems
        .filter((sub) => sub.id !== id)
        .map((sub) => {
          const subSubItems = sub.subItems ?? []
          if (subSubItems.length === 0) return sub
          return { ...sub, subItems: subSubItems.filter((s) => s.id !== id) }
        })
      return { ...item, subItems: nextSubItems }
    })
}

/**
 * Insert a fresh sibling immediately after the row `afterId`, at the same
 * depth. Returns the next forest and the new node's id (so the caller can
 * move focus to it). When `afterId` is omitted the new node is appended as a
 * top-level item.
 */
function insertSiblingAfter(
  items: ChecklistTemplateItem[],
  afterId: string | null,
): { next: ChecklistTemplateItem[]; newId: string } {
  // Top-level append (no anchor row).
  if (!afterId) {
    const node = makeTemplateItem('')
    return { next: [...items, node], newId: node.id }
  }

  // Depth 1 sibling: a new item right after the anchor item.
  const anchorItemIndex = items.findIndex((item) => item.id === afterId)
  if (anchorItemIndex !== -1) {
    const node = makeTemplateItem('')
    const next = [...items]
    next.splice(anchorItemIndex + 1, 0, node)
    return { next, newId: node.id }
  }

  // Depth 2 sibling: a new sub-step right after the anchor sub-step.
  for (let i = 0; i < items.length; i += 1) {
    const subItems = items[i].subItems ?? []
    const subIndex = subItems.findIndex((sub) => sub.id === afterId)
    if (subIndex !== -1) {
      const node = makeTemplateSubItem('')
      const nextSub = [...subItems]
      nextSub.splice(subIndex + 1, 0, node)
      const next = items.map((item, idx) =>
        idx === i ? { ...item, subItems: nextSub } : item,
      )
      return { next, newId: node.id }
    }
  }

  // Depth 3 sibling: a new sub-sub-step right after the anchor sub-sub-step.
  for (let i = 0; i < items.length; i += 1) {
    const subItems = items[i].subItems ?? []
    for (let j = 0; j < subItems.length; j += 1) {
      const subSubItems = subItems[j].subItems ?? []
      const subSubIndex = subSubItems.findIndex((s) => s.id === afterId)
      if (subSubIndex !== -1) {
        const node = makeTemplateSubSubItem('')
        const nextSubSub = [...subSubItems]
        nextSubSub.splice(subSubIndex + 1, 0, node)
        const nextSub = subItems.map((sub, idx) =>
          idx === j ? { ...sub, subItems: nextSubSub } : sub,
        )
        const next = items.map((item, idx) =>
          idx === i ? { ...item, subItems: nextSub } : item,
        )
        return { next, newId: node.id }
      }
    }
  }

  // Fallback — anchor not found: append a top-level item.
  const node = makeTemplateItem('')
  return { next: [...items, node], newId: node.id }
}

/**
 * Add a child one level below the row `parentId`. A top-level item gains a
 * sub-step; a sub-step gains a sub-sub-step. A sub-sub-step has no deeper
 * level, so the caller must not invoke this for depth-3 rows.
 */
function addChildOf(
  items: ChecklistTemplateItem[],
  parentId: string,
): { next: ChecklistTemplateItem[]; newId: string } | null {
  // Top-level item → append a sub-step.
  const itemIndex = items.findIndex((item) => item.id === parentId)
  if (itemIndex !== -1) {
    const node = makeTemplateSubItem('')
    const parent = items[itemIndex]
    const next = items.map((item, idx) =>
      idx === itemIndex
        ? { ...item, subItems: [...(parent.subItems ?? []), node] }
        : item,
    )
    return { next, newId: node.id }
  }

  // Sub-step → append a sub-sub-step.
  for (let i = 0; i < items.length; i += 1) {
    const subItems = items[i].subItems ?? []
    const subIndex = subItems.findIndex((sub) => sub.id === parentId)
    if (subIndex !== -1) {
      const node = makeTemplateSubSubItem('')
      const parentSub = subItems[subIndex]
      const nextSub: SubChecklistTemplateItem[] = subItems.map((sub, idx) =>
        idx === subIndex
          ? { ...sub, subItems: [...(parentSub.subItems ?? []), node] }
          : sub,
      )
      const next = items.map((item, idx) =>
        idx === i ? { ...item, subItems: nextSub } : item,
      )
      return { next, newId: node.id }
    }
  }

  return null
}

const DEPTH_LABEL: Record<1 | 2 | 3, string> = {
  1: 'step',
  2: 'sub-step',
  3: 'sub-sub-step',
}

export function ChecklistOutliner({
  items,
  onChange,
  addPlaceholder = 'Add a step, then press Enter',
  ariaLabel = 'Checklist steps',
}: ChecklistOutlinerProps) {
  // Map row id → its text input, so keyboard ops can move focus to the right
  // row after a structural change.
  const rowInputs = useRef(new Map<string, HTMLInputElement>())
  // The id of a row that should receive focus on the next render (set by Enter
  // / indent / outdent). Read-and-cleared in the input's ref callback.
  const focusTarget = useRef<string | null>(null)
  // The most recent step added from the trailing "add a step" field. Tab /
  // Shift+Tab pressed in that field re-targets THIS row, so a user can type a
  // step, press Enter, then Tab — exactly the standard outliner rhythm —
  // without first clicking into the row.
  const lastAddedId = useRef<string | null>(null)

  const rows = flattenOutline(items)

  const registerInput = (id: string) => (el: HTMLInputElement | null) => {
    if (el) {
      rowInputs.current.set(id, el)
      if (focusTarget.current === id) {
        focusTarget.current = null
        el.focus()
      }
    } else {
      rowInputs.current.delete(id)
    }
  }

  const focusRow = (id: string) => {
    const existing = rowInputs.current.get(id)
    if (existing) {
      existing.focus()
    } else {
      // Row not mounted yet (just created) — defer to the ref callback.
      focusTarget.current = id
    }
  }

  const handleIndent = (id: string) => {
    const next = indentItem(items, id)
    if (next === items) return
    onChange(next)
    focusRow(id)
  }

  const handleOutdent = (id: string) => {
    const next = outdentItem(items, id)
    if (next === items) return
    onChange(next)
    focusRow(id)
  }

  const handleAddChild = (id: string) => {
    const result = addChildOf(items, id)
    if (!result) return
    onChange(result.next)
    focusRow(result.newId)
  }

  const handleDelete = (id: string) => {
    onChange(removeRow(items, id))
  }

  const handleSetDue = (
    id: string,
    patch: { dueDate?: string; dueDayOfMonth?: number },
  ) => {
    onChange(setRowDue(items, id, patch))
  }

  const handleRowKeyDown = (event: KeyboardEvent<HTMLInputElement>, row: OutlineRow) => {
    if (event.key === 'Enter') {
      // Enter adds a sibling step right after this row, at the same level, and
      // moves focus to it — rapid entry without reaching for the mouse.
      event.preventDefault()
      const { next, newId } = insertSiblingAfter(items, row.id)
      onChange(next)
      focusRow(newId)
      return
    }
    if (event.key === 'Tab') {
      // preventDefault so Tab restructures the outline instead of moving focus.
      event.preventDefault()
      if (event.shiftKey) {
        handleOutdent(row.id)
      } else {
        handleIndent(row.id)
      }
    }
  }

  const handleAddKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      const value = event.currentTarget.value.trim()
      if (!value) return
      const node = makeTemplateItem(value)
      lastAddedId.current = node.id
      onChange([...items, node])
      // Clear the add field and keep focus there for rapid top-level entry.
      event.currentTarget.value = ''
      return
    }
    if (event.key === 'Tab') {
      // Tab in the add field indents / outdents the step just added via Enter,
      // so the type → Enter → Tab outliner rhythm works without a mouse.
      const targetId = lastAddedId.current
      if (!targetId) return
      event.preventDefault()
      if (event.shiftKey) {
        const next = outdentItem(items, targetId)
        if (next !== items) onChange(next)
      } else {
        const next = indentItem(items, targetId)
        if (next !== items) onChange(next)
      }
    }
  }

  return (
    <div className="checklist-outliner" aria-label={ariaLabel}>
      {rows.length > 0 ? (
        <ul className="outliner-rows">
          {rows.map((row) => (
            <li
              key={row.id}
              className={`outliner-row outliner-depth-${row.depth}`}
              data-depth={row.depth}
            >
              <div className="outliner-row-main">
                <span className="outliner-row-guide" aria-hidden="true" />
                <span className="outliner-row-bullet" aria-hidden="true" />
                <input
                  ref={registerInput(row.id)}
                  className="outliner-row-input"
                  value={row.text}
                  aria-label={`${DEPTH_LABEL[row.depth]} text`}
                  placeholder={`${DEPTH_LABEL[row.depth]}…`}
                  onChange={(event) =>
                    onChange(setRowText(items, row.id, event.target.value))
                  }
                  onKeyDown={(event) => handleRowKeyDown(event, row)}
                  type="text"
                />
              </div>
              <div className="outliner-row-controls">
                <button
                  type="button"
                  className="outliner-arrow-btn"
                  aria-label={`Outdent ${DEPTH_LABEL[row.depth]}`}
                  title="Outdent (Shift+Tab)"
                  disabled={!row.canOutdent}
                  onClick={() => handleOutdent(row.id)}
                >
                  <ChevronLeft size={13} />
                </button>
                <button
                  type="button"
                  className="outliner-arrow-btn"
                  aria-label={`Indent ${DEPTH_LABEL[row.depth]}`}
                  title="Indent (Tab)"
                  disabled={!row.canIndent}
                  onClick={() => handleIndent(row.id)}
                >
                  <ChevronRight size={13} />
                </button>
                {row.depth < 3 ? (
                  <button
                    type="button"
                    className="outliner-add-sub-btn"
                    title="Add a step nested under this one"
                    onClick={() => handleAddChild(row.id)}
                  >
                    <CornerDownRight size={12} />
                    Add sub-step
                  </button>
                ) : null}
                <OutlinerDueControl
                  depthLabel={DEPTH_LABEL[row.depth]}
                  dueDate={row.dueDate}
                  dueDayOfMonth={row.dueDayOfMonth}
                  onChange={(patch) => handleSetDue(row.id, patch)}
                />
                <button
                  type="button"
                  className="item-delete-btn outliner-delete-btn"
                  aria-label={`Delete ${DEPTH_LABEL[row.depth]}`}
                  title={`Delete ${DEPTH_LABEL[row.depth]}`}
                  onClick={() => handleDelete(row.id)}
                >
                  ×
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="outliner-add-row">
        <Plus size={14} aria-hidden="true" className="outliner-add-row-icon" />
        <input
          className="outliner-add-input"
          aria-label="Add a step"
          placeholder={addPlaceholder}
          onKeyDown={handleAddKeyDown}
          type="text"
        />
      </div>
      <p className="outliner-hint">
        Tip: press <kbd>Tab</kbd> to make a step a sub-step, <kbd>Shift</kbd>+
        <kbd>Tab</kbd> to move it back out. <kbd>Enter</kbd> adds the next step.
      </p>
    </div>
  )
}

/**
 * Compact per-row due control for the outliner: a small select
 * [No due date | Day of month | Specific date] plus the matching input. Setting
 * one of `dueDate` / `dueDayOfMonth` clears the other; "No due date" clears both.
 */
function OutlinerDueControl({
  depthLabel,
  dueDate,
  dueDayOfMonth,
  onChange,
}: {
  depthLabel: string
  dueDate?: string
  dueDayOfMonth?: number
  onChange: (patch: { dueDate?: string; dueDayOfMonth?: number }) => void
}) {
  const { state, flash } = useSaveFlash()
  const emit = (patch: { dueDate?: string; dueDayOfMonth?: number }) => {
    onChange(patch)
    flash()
  }
  const mode: 'none' | 'day' | 'date' = dueDate
    ? 'date'
    : typeof dueDayOfMonth === 'number'
      ? 'day'
      : 'none'
  return (
    <span className="outliner-due">
      <select
        className="outliner-due-select"
        aria-label={`Due for ${depthLabel}`}
        value={mode}
        onChange={(event) => {
          const next = event.target.value
          if (next === 'day') {
            emit({ dueDate: undefined, dueDayOfMonth: dueDayOfMonth ?? 1 })
          } else if (next === 'date') {
            emit({
              dueDate: dueDate || localDateOnly(),
              dueDayOfMonth: undefined,
            })
          } else {
            emit({ dueDate: undefined, dueDayOfMonth: undefined })
          }
        }}
      >
        <option value="none">No due date</option>
        <option value="day">Day of month</option>
        <option value="date">Specific date</option>
      </select>
      {mode === 'day' ? (
        <input
          className="compact-input outliner-due-day"
          type="number"
          min={1}
          max={31}
          aria-label={`Day of month for ${depthLabel}`}
          value={dueDayOfMonth ?? 1}
          onChange={(event) => {
            const value = Math.min(Math.max(Number(event.target.value) || 1, 1), 31)
            emit({ dueDate: undefined, dueDayOfMonth: value })
          }}
        />
      ) : null}
      {mode === 'date' ? (
        <input
          className="compact-input outliner-due-date"
          type="date"
          aria-label={`Due date for ${depthLabel}`}
          value={dueDate ?? ''}
          onChange={(event) =>
            emit({ dueDate: event.target.value || undefined, dueDayOfMonth: undefined })
          }
        />
      ) : null}
      <SaveBadge state={state} />
    </span>
  )
}
