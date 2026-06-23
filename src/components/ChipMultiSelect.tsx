import { useState } from 'react'
import { X } from 'lucide-react'

/**
 * Generic chip multi-select. Mirrors the SharingControl / AssignedTeamControl
 * visual language (sharing-chips + add-person-pill) so plan and contact
 * pickers on clients stay consistent with the rest of the app. The caller
 * supplies the option list (id + label) and the currently-selected ids.
 */
export function ChipMultiSelect({
  selectedIds,
  options,
  onChange,
  addLabel,
  emptyHelper,
}: {
  selectedIds: string[]
  options: Array<{ id: string; label: string }>
  onChange: (nextIds: string[]) => void
  addLabel: string
  emptyHelper: string
}) {
  const [adderOpen, setAdderOpen] = useState(false)
  const [query, setQuery] = useState('')

  const labelById = new Map(options.map((option) => [option.id, option.label]))
  const onList = new Set(selectedIds)
  const addable = options.filter((option) => !onList.has(option.id))

  // Show a search box once the list is long enough to be unwieldy (e.g. the
  // firm has ~130 checklist templates) so picking one doesn't mean scrolling a
  // giant menu.
  const showSearch = addable.length > 7
  const q = query.trim().toLowerCase()
  const filtered = q ? addable.filter((option) => option.label.toLowerCase().includes(q)) : addable

  const toggleAdder = () => {
    setQuery('')
    setAdderOpen((open) => !open)
  }

  const addOne = (id: string) => {
    if (selectedIds.includes(id)) return
    onChange([...selectedIds, id])
    setAdderOpen(false)
    setQuery('')
  }

  const removeOne = (id: string) => {
    onChange(selectedIds.filter((entry) => entry !== id))
  }

  return (
    <div className="sharing-control">
      <div className="sharing-chips">
        {selectedIds.length === 0 ? (
          <span className="sharing-helper">{emptyHelper}</span>
        ) : null}
        {selectedIds.map((id) => (
          <span className="sharing-chip" key={id}>
            <strong>{labelById.get(id) ?? id}</strong>
            <button
              type="button"
              className="chip-remove"
              onClick={() => removeOne(id)}
              aria-label={`Remove ${labelById.get(id) ?? id}`}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        {addable.length > 0 ? (
          <div className="sharing-add">
            <button type="button" className="add-person-pill" onClick={toggleAdder}>
              {addLabel}
            </button>
            {adderOpen ? (
              <div className="sharing-add-menu" role="menu">
                {showSearch ? (
                  <input
                    className="sharing-add-search"
                    type="text"
                    autoFocus
                    placeholder="Search…"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    aria-label="Search options"
                  />
                ) : null}
                {filtered.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="menuitem"
                    onClick={() => addOne(option.id)}
                  >
                    {option.label}
                  </button>
                ))}
                {filtered.length === 0 ? <p className="sharing-add-empty">No matches.</p> : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
