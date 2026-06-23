import { X } from 'lucide-react'
import { useEffect } from 'react'
import { useAppContext } from '../AppContext'
import { ActiveChecklistsBody } from '../pages/ClientDetailPage'
import type { Client } from '../lib/types'
import { ClientNotesPanel } from './ClientNotesPanel'

/**
 * Quick "Checklist + Notes" modal launched from the client LIST. Renders the
 * SAME editable active-checklists UI used on the client detail page, plus the
 * shared notes panel. Works for owners and staff alike (each sees only their
 * scoped data; the checklist + notes endpoints already authorize assignees /
 * editors).
 */
export function ClientChecklistModal({
  client,
  onClose,
}: {
  client: Client
  onClose: () => void
}) {
  const { data, ownerMode, sessionUser } = useAppContext()

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
      <div
        className="modal-panel client-checklist-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Checklist and notes for ${client.name}`}
      >
        <div className="modal-body">
          <div className="client-checklist-modal-head">
            <h2 className="modal-title">{client.name}</h2>
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

          <section className="client-checklist-modal-section">
            <h3 className="mini-heading">Active checklists</h3>
            <ActiveChecklistsBody client={client} data={data} />
          </section>

          <section className="client-checklist-modal-section">
            <h3 className="mini-heading">Notes</h3>
            <ClientNotesPanel
              clientId={client.id}
              ownerMode={ownerMode}
              currentUserId={sessionUser.id}
            />
          </section>
        </div>
      </div>
    </div>
  )
}
