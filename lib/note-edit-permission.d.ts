/**
 * Types for the shared "only the writer edits a note" rule. Same convention as
 * `checklist-write-permission.d.ts`: the implementation is plain JS so the server
 * can import it directly, and this file lets the React side use it too.
 */

export type EditableNote = {
  authorId?: string | null
  attachedChecklistId?: string | null
  repeatOf?: string
}

export type NoteEditRefusal = {
  status: 400 | 403 | 404 | 409
  error: string
  message?: string
}

export const NOTE_NOT_FOUND: string
export const NOTE_BODY_REQUIRED: string
export const NOTE_EDIT_NOT_AUTHOR: string
export const PENDING_NOTE_ALREADY_ADDED: string

export function clientNoteEditRefusal(
  note: EditableNote | null | undefined,
  userId: string | null | undefined,
): NoteEditRefusal | null

export function pendingNoteEditRefusal(
  note: EditableNote | null | undefined,
  userId: string | null | undefined,
): NoteEditRefusal | null

export function noteEditOutcomeRefusal(reason: string | undefined): NoteEditRefusal

export function canEditClientNote(
  note: EditableNote | null | undefined,
  userId: string | null | undefined,
): boolean

export function canEditPendingNote(
  note: EditableNote | null | undefined,
  userId: string | null | undefined,
): boolean
