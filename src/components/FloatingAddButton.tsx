import { Plus } from 'lucide-react'

/**
 * Premium "+" add button. Lives in the top-right of a page header (opposite the
 * page title, above the search bar) — either as the right-hand child of a
 * `section-heading` flex row or inside a CollapsibleSection header-action slot —
 * so it never covers list content. Opens that page's add-in-a-modal flow.
 */
export function FloatingAddButton({
  label,
  onClick,
}: {
  label: string
  onClick: () => void
}) {
  return (
    <button type="button" className="fab" aria-label={label} title={label} onClick={onClick}>
      <Plus size={16} aria-hidden="true" />
      <span className="fab-label">{label}</span>
    </button>
  )
}
