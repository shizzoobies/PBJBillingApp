/**
 * Who may EDIT a saved note (featreq-da3801ab): a client notes-log entry or a
 * pending note for an upcoming checklist.
 *
 * Brittany's words: "Only the original creator can edit a note. Other users can
 * still view it but cannot edit it. Any attempt by a non-creator to edit a note
 * is also rejected on the server side."
 *
 *   - Only the writer (`authorId`) may edit, the OWNER included: she may delete
 *     anyone's note, but changing what someone else wrote is not hers to do.
 *   - A note with no recorded writer can be edited by nobody.
 *   - A pending note can be edited only while it still waits for a checklist.
 *     Once it is on one (or it is the copy a repeating note left there), the
 *     checklist holds it: a task became a step, a note shows on the card. The
 *     repeating note itself is never attached, so its writer can still edit it
 *     (later months' copies take the new words).
 *
 * The server answers with these refusals; the notes box asks `canEdit*` so a
 * person who may not edit never sees the control. The store re-checks the
 * writer in its own guarded write, so a race cannot slip past either.
 */

export const NOTE_NOT_FOUND = 'Note not found'
export const NOTE_EDIT_NOT_AUTHOR = 'Only the person who wrote this note can edit it.'
export const PENDING_NOTE_ALREADY_ADDED =
  'This note was already added to a checklist - edit it there.'

function isWriter(note, userId) {
  return Boolean(userId) && Boolean(note?.authorId) && note.authorId === userId
}

/** Why `userId` may not edit this client note, or null when they may. */
export function clientNoteEditRefusal(note, userId) {
  if (!note) return { status: 404, error: NOTE_NOT_FOUND }
  if (!isWriter(note, userId)) return { status: 403, error: NOTE_EDIT_NOT_AUTHOR }
  return null
}

/** Why `userId` may not edit this pending note, or null when they may. */
export function pendingNoteEditRefusal(note, userId) {
  if (!note) return { status: 404, error: NOTE_NOT_FOUND }
  if (!isWriter(note, userId)) return { status: 403, error: NOTE_EDIT_NOT_AUTHOR }
  if (note.attachedChecklistId || note.repeatOf) {
    return { status: 409, error: 'pending_note_attached', message: PENDING_NOTE_ALREADY_ADDED }
  }
  return null
}

export function canEditClientNote(note, userId) {
  return clientNoteEditRefusal(note, userId) === null
}

export function canEditPendingNote(note, userId) {
  return pendingNoteEditRefusal(note, userId) === null
}
