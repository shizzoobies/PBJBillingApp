import { useEffect, useState } from 'react'
import { addClientNote, deleteClientNote, listClientNotes } from '../lib/api'
import { renderRichNote } from '../lib/richText'
import type { ClientNote } from '../lib/types'
import { RichNoteEditor } from './RichNoteEditor'

const noteStamp = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

/**
 * Per-client notes: load / add / delete against the existing notes endpoints.
 * The add field is a lightweight rich-text editor; each saved note renders its
 * body through `renderRichNote` (safe markdown subset, no HTML injection).
 *
 * Shared between the client detail page and the client-list checklist modal.
 */
export function ClientNotesPanel({
  clientId,
  ownerMode,
  currentUserId,
}: {
  clientId: string
  ownerMode: boolean
  currentUserId: string
}) {
  const [notes, setNotes] = useState<ClientNote[]>([])
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError('')
      try {
        const list = await listClientNotes(clientId)
        if (!cancelled) setNotes(list)
      } catch {
        if (!cancelled) setError('Could not load notes.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [clientId])

  const submit = async () => {
    const body = draft.trim()
    if (!body || busy) return
    setBusy(true)
    setError('')
    try {
      const note = await addClientNote(clientId, body)
      setNotes((current) => [note, ...current])
      setDraft('')
    } catch {
      setError('Could not add that note — please try again.')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (noteId: string) => {
    setError('')
    try {
      await deleteClientNote(clientId, noteId)
      setNotes((current) => current.filter((note) => note.id !== noteId))
    } catch {
      setError('Could not delete that note.')
    }
  }

  return (
    <div className="client-notes">
      <div className="field full-row">
        <span className="field-label-row">Add a note</span>
        <RichNoteEditor
          value={draft}
          onChange={setDraft}
          placeholder="Jot a note for this client… (supports **bold**, *italic*, lists, links)"
        />
        <div className="button-row">
          <button
            type="button"
            className="primary-action"
            disabled={busy || !draft.trim()}
            onClick={() => void submit()}
          >
            {busy ? 'Adding…' : 'Add note'}
          </button>
        </div>
      </div>

      {error ? <p className="auth-error">{error}</p> : null}

      {loading ? (
        <p className="muted-text">Loading notes…</p>
      ) : notes.length === 0 ? (
        <p className="muted-text">No notes yet.</p>
      ) : (
        <ul className="activity-list">
          {notes.map((note) => {
            const canDelete = ownerMode || note.authorId === currentUserId
            return (
              <li key={note.id}>
                <strong>
                  {note.authorName || 'Unknown'}
                  {note.createdAt ? ` · ${noteStamp.format(new Date(note.createdAt))}` : ''}
                </strong>
                <span className="client-note-body">{renderRichNote(note.body)}</span>
                {canDelete ? (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => void remove(note.id)}
                  >
                    Delete
                  </button>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
