import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { canAddPendingClientNote } from '../../lib/checklist-write-permission.js'
import {
  addClientNote,
  addClientPendingNoteRequest,
  deleteClientNote,
  deleteClientPendingNoteRequest,
  listClientNotes,
} from '../lib/api'
import { useClientPendingNotes, type ClientPendingNotesState } from '../hooks/useClientPendingNotes'
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
  pendingState,
}: {
  clientId: string
  ownerMode: boolean
  currentUserId: string
  /** The client's pending notes, when the page owns them (the client page
   *  keeps them so the "N waiting for a checklist" pill in the section header
   *  shows even while this box is collapsed and unmounted). Without it the box
   *  loads its own. */
  pendingState?: ClientPendingNotesState
}) {
  const { data } = useAppContext()
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

  // ---- Pending notes for future recurring checklists (featreq-b688e73c) ----
  const ownPending = useClientPendingNotes(clientId, !pendingState)
  const pending = pendingState ?? ownPending
  const pendingNotes = pending.notes
  const setPendingNotes = pending.setNotes
  // Action errors (add/delete) live here; a LOAD error comes from the hook.
  const [pendingActionError, setPendingActionError] = useState('')
  const pendingError = pendingActionError || pending.error
  const [pendingBusy, setPendingBusy] = useState(false)
  const [pendingBody, setPendingBody] = useState('')
  const [pendingTemplateId, setPendingTemplateId] = useState('')
  const [pendingKind, setPendingKind] = useState<'task' | 'note'>('task')

  const activeTemplates = useMemo(
    () =>
      data.checklistTemplates.filter(
        (template) => template.clientId === clientId && !template.isStandard && template.active,
      ),
    [data.checklistTemplates, clientId],
  )
  const liveChecklists = useMemo(
    () => data.checklists.filter((checklist) => checklist.clientId === clientId && !checklist.deletedAt),
    [data.checklists, clientId],
  )
  // `canAddPendingClientNote` only needs enough of a "user" to read `id` and
  // `role` — this page already knows the client is visible (it wouldn't have
  // loaded otherwise), so `clientVisible` is always true here.
  const gateUser = useMemo(
    () => ({ id: currentUserId, role: ownerMode ? 'owner' : undefined }),
    [currentUserId, ownerMode],
  )
  const canAddForTemplate = (template: (typeof activeTemplates)[number] | undefined) =>
    canAddPendingClientNote({
      user: gateUser,
      clientVisible: true,
      template,
      checklists: liveChecklists.filter((checklist) => checklist.templateId === template?.id),
    })
  const eligibleTemplates = useMemo(
    () => activeTemplates.filter((template) => canAddForTemplate(template)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeTemplates, gateUser, liveChecklists],
  )
  // The FORM is for people who can write; the LIST is for everyone who can see
  // the client - a teammate without write access still sees what is waiting.
  const showPendingForm = ownerMode ? activeTemplates.length > 0 : eligibleTemplates.length > 0
  const showPendingBlock = showPendingForm || pendingNotes.length > 0

  // Derived, not effect-synced: the select defaults to the first writable
  // template until the user picks one explicitly, and falls back again if the
  // chosen template drops out of the active list (e.g. it was deactivated).
  const preferredTemplateId = (ownerMode ? activeTemplates[0] : eligibleTemplates[0])?.id ?? ''
  const effectiveTemplateId =
    pendingTemplateId && activeTemplates.some((template) => template.id === pendingTemplateId)
      ? pendingTemplateId
      : preferredTemplateId

  const selectedTemplate = activeTemplates.find((template) => template.id === effectiveTemplateId)
  const canAddSelected = canAddForTemplate(selectedTemplate)

  const submitPendingNote = async () => {
    const body = pendingBody.trim()
    if (!body || !selectedTemplate || !canAddSelected || pendingBusy) return
    setPendingBusy(true)
    setPendingActionError('')
    try {
      const note = await addClientPendingNoteRequest(clientId, {
        templateId: selectedTemplate.id,
        kind: pendingKind,
        body,
      })
      setPendingNotes((current) => [note, ...current])
      setPendingBody('')
    } catch {
      setPendingActionError('Could not add that note — please try again.')
    } finally {
      setPendingBusy(false)
    }
  }

  const removePendingNote = async (noteId: string) => {
    setPendingActionError('')
    try {
      await deleteClientPendingNoteRequest(clientId, noteId)
      setPendingNotes((current) => current.filter((note) => note.id !== noteId))
    } catch {
      setPendingActionError('Could not delete that note.')
    }
  }

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
      {showPendingBlock ? (
        <div className="pending-client-notes">
          <span className="field-label-row">For an upcoming checklist</span>
          {showPendingForm ? (
            <>
              <textarea
                className="pending-note-textarea"
                value={pendingBody}
                onChange={(event) => setPendingBody(event.target.value)}
                placeholder="A note for a checklist that hasn't come up yet…"
                rows={2}
              />
              <div className="pending-note-controls">
                <select
                  aria-label="Attach to"
                  value={effectiveTemplateId}
                  onChange={(event) => setPendingTemplateId(event.target.value)}
                >
                  {activeTemplates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.title}
                    </option>
                  ))}
                </select>
                <label className="pending-note-kind">
                  <input
                    type="radio"
                    name={`pending-note-kind-${clientId}`}
                    checked={pendingKind === 'task'}
                    onChange={() => setPendingKind('task')}
                  />
                  Task
                </label>
                <label className="pending-note-kind">
                  <input
                    type="radio"
                    name={`pending-note-kind-${clientId}`}
                    checked={pendingKind === 'note'}
                    onChange={() => setPendingKind('note')}
                  />
                  Note
                </label>
                <button
                  type="button"
                  className="secondary-action"
                  disabled={pendingBusy || !pendingBody.trim() || !canAddSelected}
                  onClick={() => void submitPendingNote()}
                >
                  {pendingBusy ? 'Adding…' : 'Add'}
                </button>
              </div>
              {!canAddSelected && selectedTemplate ? (
                <p className="field-helper">
                  You don’t have write access to {selectedTemplate.title} — ask its assignee or an
                  owner to add this one.
                </p>
              ) : null}
            </>
          ) : null}
          {pendingError ? <p className="auth-error">{pendingError}</p> : null}
          {pending.loading ? (
            <p className="muted-text">Loading…</p>
          ) : pendingNotes.length === 0 ? null : (
            <ul className="pending-client-notes-list">
              {pendingNotes.map((note) => {
                const template = data.checklistTemplates.find(
                  (entry) => entry.id === note.templateId,
                )
                const attachedChecklist = note.attachedChecklistId
                  ? data.checklists.find((entry) => entry.id === note.attachedChecklistId)
                  : null
                const canDelete =
                  ownerMode || (note.authorId === currentUserId && !note.attachedChecklistId)
                return (
                  <li
                    key={note.id}
                    className={
                      note.attachedChecklistId
                        ? 'pending-client-note attached'
                        : 'pending-client-note'
                    }
                  >
                    <span className="client-note-body">{note.body}</span>
                    <span className="pending-note-meta">
                      → {template?.title ?? 'a recurring checklist'} as{' '}
                      {note.kind === 'task' ? 'Task' : 'Note'}
                    </span>
                    <strong>
                      {note.authorName || 'Unknown'}
                      {note.createdAt ? ` · ${noteStamp.format(new Date(note.createdAt))}` : ''}
                    </strong>
                    {attachedChecklist ? (
                      <span className="pending-note-attached">
                        Attached to{' '}
                        <Link to={`/checklists?focus=${encodeURIComponent(attachedChecklist.id)}`}>
                          {attachedChecklist.title}
                          {attachedChecklist.periodLabel
                            ? ` (${attachedChecklist.periodLabel})`
                            : ` (${attachedChecklist.dueDate})`}
                        </Link>
                      </span>
                    ) : null}
                    {canDelete ? (
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => void removePendingNote(note.id)}
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
      ) : null}

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
