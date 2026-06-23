import { X } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'

/**
 * Lightweight modal shell for the "+" add flows on the Clients / Contacts /
 * Plans pages. Mirrors the existing ClientChecklistModal pattern: a
 * `modal-overlay` that closes on click-outside, a `modal-panel` + `modal-body`,
 * Escape-to-close, and a header with an `icon-button` close (lucide X).
 */
export function AddModal({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: ReactNode
}) {
  // Close on Escape.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="modal-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="modal-panel" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-body">
          <div className="client-checklist-modal-head">
            <h2 className="modal-title">{title}</h2>
            <button
              type="button"
              className="icon-button"
              aria-label="Close"
              title="Close"
              onClick={onClose}
            >
              <X size={18} />
            </button>
          </div>
          {children}
        </div>
      </div>
    </div>
  )
}
