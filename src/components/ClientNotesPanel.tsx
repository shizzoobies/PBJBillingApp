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
  const { data, previewMode } = useAppContext()
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
                return (
                  <li
                    key={note.id}
                    className={
                      note.attachedChecklistId
                        ? 'pending-client-note attached'
                        : 'pending-client-note'
                    }
                  >
                    <span className="client-note-body">
                      {note.body}
                      {/* A copy a repeating note left on a checklist. */}
                      {note.repeatOf ? <span className="pending-note-meta"> (repeat)</span> : null}
                    </span>
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
                    {canDelete ? (
                      <button
                        type="button"
                        className="link-button"
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
