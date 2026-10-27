import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { canAddPendingClientNote } from '../../lib/checklist-write-permission.js'
import { canEditClientNote, canEditPendingNote } from '../../lib/note-edit-permission.js'
import {
  addClientNote,
  addClientPendingNoteRequest,
  deleteClientNote,
  deleteClientPendingNoteRequest,
  listClientNotes,
  updateClientNoteRequest,
  updateClientPendingNoteRequest,
} from '../lib/api'
import { useClientPendingNotes, type ClientPendingNotesState } from '../hooks/useClientPendingNotes'
import { renderRichNote } from '../lib/richText'
import { ApiError, type ClientNote } from '../lib/types'
import { RichNoteEditor } from './RichNoteEditor'

const noteStamp = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

// A checklist's due date (YYYY-MM-DD), read at noon so no timezone moves the day.
const dueStamp = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

// The quiet "edited Oct 23, 2026" after a note its writer changed (featreq-da3801ab).
const editedStamp = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

/** Which note's words are open for editing: one at a time, in either list. */
type EditTarget = { kind: 'note' | 'pending'; id: string }

/**
 * Per-client notes: load / add / delete against the existing notes endpoints.
 * The add field is a lightweight rich-text editor; each saved note renders its
 * body through `renderRichNote` (safe markdown subset, no HTML injection).
 *
 * Shared between the client detail page and the client-list checklist modal.
 *
 * WHO is looking comes from the app context, never from the caller: the
 * EFFECTIVE user and role, so an owner previewing a teammate sees exactly the
 * controls that teammate sees. The callers once passed the session (owner) id
 * next to the effective `ownerMode`, and an owner previewing Lisa saw no Edit
 * and no Delete on Lisa's own notes (featreq-da3801ab send-back). In preview
 * every control that would write stays visible but switched off - the server
 * refuses preview writes anyway, and a preview never acts as someone else.
 */
export function ClientNotesPanel({
  clientId,
  pendingState,
}: {
  clientId: string
  /** The client's pending notes, when the page owns them (the client page
   *  keeps them so the "N waiting for a checklist" pill in the section header
   *  shows even while this box is collapsed and unmounted). Without it the box
   *  loads its own. */
  pendingState?: ClientPendingNotesState
}) {
  const { data, previewMode, ownerMode, effectiveUser } = useAppContext()
  const currentUserId = effectiveUser?.id ?? ''
  const previewName = effectiveUser?.name || 'the person you are previewing'
  // Tooltips on the switched-off controls while previewing. Edit names the
  // writer (only they may edit); Delete and Stop repeating do not, since the
  // owner may remove anyone's note.
  const previewEditTitle = `Preview: only ${previewName} can edit this note`
  const previewOffTitle = 'Preview: buttons are off'
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
  // Off by default: a note goes on the next checklist only, unless she opts in.
  const [pendingRepeats, setPendingRepeats] = useState(false)

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
    if (previewMode) return
    const body = pendingBody.trim()
    if (!body || !selectedTemplate || !canAddSelected || pendingBusy) return
    setPendingBusy(true)
    setPendingActionError('')
    try {
      const note = await addClientPendingNoteRequest(clientId, {
        templateId: selectedTemplate.id,
        kind: pendingKind,
        body,
        // Sent only when it is on, so a one-time note's request is what it always was.
        ...(pendingRepeats ? { repeats: true } : {}),
      })
      setPendingNotes((current) => [note, ...current])
      setPendingBody('')
      setPendingRepeats(false)
    } catch (err) {
      // The cap (100 notes waiting) carries its own sentence; anything else is generic.
      setPendingActionError(
        err instanceof ApiError && err.code === 'too_many_pending_notes'
          ? err.message
          : 'Could not add that note — please try again.',
      )
    } finally {
      setPendingBusy(false)
    }
  }

  const removePendingNote = async (noteId: string) => {
    if (previewMode) return
    setPendingActionError('')
    try {
      await deleteClientPendingNoteRequest(clientId, noteId)
      setPendingNotes((current) => current.filter((note) => note.id !== noteId))
    } catch {
      setPendingActionError('Could not delete that note.')
    }
  }

  const submit = async () => {
    if (previewMode) return
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
    if (previewMode) return
    setError('')
    try {
      await deleteClientNote(clientId, noteId)
      setNotes((current) => current.filter((note) => note.id !== noteId))
    } catch {
      setError('Could not delete that note.')
    }
  }

  // ---- The writer edits their own note (featreq-da3801ab) ----
  // Only the writer sees Edit (the owner is no exception); the server refuses
  // everyone else anyway. One note open at a time; Cancel or Esc drops the draft.
  const [editing, setEditing] = useState<EditTarget | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [editBusy, setEditBusy] = useState(false)
  const [editError, setEditError] = useState('')

  const startEdit = (kind: EditTarget['kind'], note: { id: string; body: string }) => {
    setEditing({ kind, id: note.id })
    setEditDraft(note.body)
    setEditError('')
  }

  const cancelEdit = () => {
    if (editBusy) return
    setEditing(null)
    setEditDraft('')
    setEditError('')
  }

  const saveEdit = async () => {
    if (previewMode) return
    const body = editDraft.trim()
    if (!editing || !body || editBusy) return
    setEditBusy(true)
    setEditError('')
    try {
      if (editing.kind === 'note') {
        const saved = await updateClientNoteRequest(clientId, editing.id, body)
        setNotes((current) => current.map((note) => (note.id === saved.id ? saved : note)))
      } else {
        const saved = await updateClientPendingNoteRequest(clientId, editing.id, body)
        setPendingNotes((current) => current.map((note) => (note.id === saved.id ? saved : note)))
      }
      setEditing(null)
      setEditDraft('')
    } catch (err) {
      // A refusal (not yours, already on a checklist) carries the server's sentence.
      setEditError(
        err instanceof ApiError && err.message ? err.message : 'Could not save that note — please try again.',
      )
    } finally {
      setEditBusy(false)
    }
  }

  const isEditing = (kind: EditTarget['kind'], noteId: string) =>
    editing?.kind === kind && editing.id === noteId

  // Each kind is edited with the box it was written in: a notes-log entry with the
  // same rich-text editor as "Add a note" (toolbar; the saved body renders through
  // `renderRichNote`), a pending note with the plain box of "For an upcoming
  // checklist" (it shows as plain text). Esc anywhere in the box cancels.
  const editBox = (kind: EditTarget['kind']) => (
    <div
      className="client-note-edit"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          cancelEdit()
        }
      }}
    >
      {kind === 'note' ? (
        <RichNoteEditor value={editDraft} onChange={setEditDraft} ariaLabel="Edit note" autoFocus />
      ) : (
        <textarea
          aria-label="Edit note"
          className="pending-note-textarea"
          value={editDraft}
          onChange={(event) => setEditDraft(event.target.value)}
          rows={3}
          autoFocus
        />
      )}
      <div className="pending-note-controls">
        <button
          type="button"
          className="secondary-action"
          disabled={editBusy || !editDraft.trim()}
          onClick={() => void saveEdit()}
        >
          {editBusy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="link-button" disabled={editBusy} onClick={cancelEdit}>
          Cancel
        </button>
      </div>
      {editError ? <p className="auth-error">{editError}</p> : null}
    </div>
  )

  const editButton = (kind: EditTarget['kind'], note: { id: string; body: string }) => (
    <button
      type="button"
      className="link-button"
      disabled={Boolean(previewMode) || editBusy}
      title={previewMode ? previewEditTitle : undefined}
      onClick={() => startEdit(kind, note)}
    >
      Edit
    </button>
  )

  const editedMarker = (editedAt: string | undefined, className: string) =>
    editedAt ? (
      <span className={className} title={noteStamp.format(new Date(editedAt))}>
        edited {editedStamp.format(new Date(editedAt))}
      </span>
    ) : null

  return (
    <div className="client-notes">
      {showPendingBlock ? (
        <div className="pending-client-notes">
          <span className="field-label-row">For an upcoming checklist</span>
          {showPendingForm ? (
            <>
              <textarea
                aria-label="Note for an upcoming checklist"
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
                <fieldset className="pending-note-kind-group">
                  <legend className="visually-hidden">Add as</legend>
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
                </fieldset>
                <label className="pending-note-kind">
                  <input
                    type="checkbox"
                    checked={pendingRepeats}
                    onChange={(event) => setPendingRepeats(event.target.checked)}
                  />
                  Repeat on every checklist from now on
                </label>
                <button
                  type="button"
                  className="secondary-action"
                  disabled={Boolean(previewMode) || pendingBusy || !pendingBody.trim() || !canAddSelected}
                  title={previewMode ? 'Disabled in preview mode' : undefined}
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
                // A copy a repeating note left on a checklist is removed by removing its
                // step there, or by stopping the repeating note: the server refuses it here.
                const canDelete =
                  !note.repeatOf &&
                  (ownerMode || (note.authorId === currentUserId && !note.attachedChecklistId))
                // Only its writer, and only while it still waits for a checklist.
                const canEdit = canEditPendingNote(note, currentUserId)
                const editingThis = canEdit && isEditing('pending', note.id)
                return (
                  <li
                    key={note.id}
                    className={
                      note.attachedChecklistId
                        ? 'pending-client-note attached'
                        : 'pending-client-note'
                    }
                  >
                    {editingThis ? (
                      editBox('pending')
                    ) : (
                      <span className="client-note-body">
                        {note.body}
                        {/* A copy a repeating note left on a checklist. */}
                        {note.repeatOf ? <span className="pending-note-meta"> (repeat)</span> : null}
                      </span>
                    )}
                    {editingThis ? null : editedMarker(note.editedAt, 'pending-note-meta')}
                    <span className="pending-note-meta">
                      → {template?.title ?? 'a recurring checklist'} as{' '}
                      {note.kind === 'task' ? 'Task' : 'Note'}
                    </span>
                    {note.repeats ? (
                      <span className="pending-note-meta">
                        Repeats on every checklist
                        {note.lastAttachedDueDate
                          ? ` · last added to the ${dueStamp.format(new Date(`${note.lastAttachedDueDate}T12:00:00`))} checklist`
                          : ''}
                      </span>
                    ) : null}
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
                    {canEdit && !editingThis ? editButton('pending', note) : null}
                    {canDelete ? (
                      <button
                        type="button"
                        className="link-button"
                        disabled={Boolean(previewMode)}
                        title={previewMode ? previewOffTitle : undefined}
                        onClick={() => void removePendingNote(note.id)}
                      >
                        {note.repeats ? 'Stop repeating' : 'Delete'}
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
            disabled={Boolean(previewMode) || busy || !draft.trim()}
            title={previewMode ? 'Disabled in preview mode' : undefined}
            onClick={() => void submit()}
          >
            {busy ? 'Adding…' : 'Add note'}
          </button>
        </div>
      </div>

      {error ? <p className="auth-error">{error}</p> : null}

      {previewMode ? (
        <p className="field-helper">
          Preview: these are the notes and buttons {previewName} sees. The buttons are off here;
          only {previewName} can edit their own notes.
        </p>
      ) : null}

      {loading ? (
        <p className="muted-text">Loading notes…</p>
      ) : notes.length === 0 ? (
        <p className="muted-text">No notes yet.</p>
      ) : (
        <ul className="activity-list">
          {notes.map((note) => {
            const canDelete = ownerMode || note.authorId === currentUserId
            // Only its writer - the owner is no exception (featreq-da3801ab).
            const canEdit = canEditClientNote(note, currentUserId)
            const editingThis = canEdit && isEditing('note', note.id)
            return (
              <li key={note.id}>
                <strong>
                  {note.authorName || 'Unknown'}
                  {note.createdAt ? ` · ${noteStamp.format(new Date(note.createdAt))}` : ''}
                </strong>
                {editingThis ? (
                  editBox('note')
                ) : (
                  <>
                    <span className="client-note-body">{renderRichNote(note.body)}</span>
                    {editedMarker(note.editedAt, 'client-note-edited')}
                  </>
                )}
                {canEdit && !editingThis ? editButton('note', note) : null}
                {canDelete ? (
                  <button
                    type="button"
                    className="link-button"
                    disabled={Boolean(previewMode)}
                    title={previewMode ? previewOffTitle : undefined}
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
