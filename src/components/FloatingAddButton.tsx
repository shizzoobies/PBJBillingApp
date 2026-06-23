import { Plus } from 'lucide-react'

/**
 * Premium floating "+" action button. Stays fixed to the viewport (bottom-LEFT
 * so it never collides with the owner-only assistant launcher pinned at
 * bottom-right) and opens that page's add-in-a-modal flow when clicked.
 *
 * z-index sits above page chrome but BELOW the modal overlay (z 60), so once
 * the add modal opens the button tucks behind it.
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
      <Plus size={18} aria-hidden="true" />
      <span className="fab-label">{label}</span>
    </button>
  )
}
