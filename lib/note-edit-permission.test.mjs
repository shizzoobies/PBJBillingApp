import { describe, expect, it } from 'vitest'

import {
  NOTE_EDIT_NOT_AUTHOR,
  NOTE_NOT_FOUND,
  PENDING_NOTE_ALREADY_ADDED,
  canEditClientNote,
  canEditPendingNote,
  clientNoteEditRefusal,
  pendingNoteEditRefusal,
} from './note-edit-permission.js'

/**
 * Who may edit a note (featreq-da3801ab). Brittany's words: "Only the original
 * creator can edit a note. Other users can still view it but cannot edit it."
 * The owner is NOT an exception: she may delete anyone's note, but editing is
 * the writer's alone.
 */

const note = (over = {}) => ({ id: 'cnote-1', clientId: 'c1', authorId: 'emp-a', ...over })
const pending = (over = {}) => ({
  id: 'pnote-1',
  clientId: 'c1',
  authorId: 'emp-a',
  attachedChecklistId: null,
  ...over,
})

describe('clientNoteEditRefusal', () => {
  it('lets the writer edit their own note', () => {
    expect(clientNoteEditRefusal(note(), 'emp-a')).toBeNull()
    expect(canEditClientNote(note(), 'emp-a')).toBe(true)
  })

  it('refuses anyone else with a 403, the owner included', () => {
    expect(clientNoteEditRefusal(note(), 'emp-patrice')).toEqual({ status: 403, error: NOTE_EDIT_NOT_AUTHOR })
    expect(canEditClientNote(note(), 'emp-patrice')).toBe(false)
  })

  it('refuses a note with no recorded writer, and a caller with no id', () => {
    expect(clientNoteEditRefusal(note({ authorId: null }), 'emp-a')?.status).toBe(403)
    expect(clientNoteEditRefusal(note({ authorId: null }), null)?.status).toBe(403)
    expect(clientNoteEditRefusal(note(), '')?.status).toBe(403)
    expect(clientNoteEditRefusal(note(), undefined)?.status).toBe(403)
  })

  it('answers 404 for a missing note', () => {
    expect(clientNoteEditRefusal(null, 'emp-a')).toEqual({ status: 404, error: NOTE_NOT_FOUND })
  })
})

describe('pendingNoteEditRefusal', () => {
  it('lets the writer edit their own note while it waits for a checklist', () => {
    expect(pendingNoteEditRefusal(pending(), 'emp-a')).toBeNull()
    expect(canEditPendingNote(pending(), 'emp-a')).toBe(true)
  })

  it('lets the writer edit a repeating note (it is never attached itself)', () => {
    expect(pendingNoteEditRefusal(pending({ repeats: true }), 'emp-a')).toBeNull()
  })

  it('refuses anyone else with a 403, the owner included, attached or not', () => {
    expect(pendingNoteEditRefusal(pending(), 'emp-patrice')).toEqual({ status: 403, error: NOTE_EDIT_NOT_AUTHOR })
    expect(pendingNoteEditRefusal(pending({ attachedChecklistId: 'chk-1' }), 'emp-b')?.status).toBe(403)
    expect(canEditPendingNote(pending(), 'emp-b')).toBe(false)
  })

  it('refuses the writer with a 409 once the note is on a checklist', () => {
    expect(pendingNoteEditRefusal(pending({ attachedChecklistId: 'chk-1' }), 'emp-a')).toEqual({
      status: 409,
      error: 'pending_note_attached',
      message: PENDING_NOTE_ALREADY_ADDED,
    })
    expect(canEditPendingNote(pending({ attachedChecklistId: 'chk-1' }), 'emp-a')).toBe(false)
  })

  it('refuses a copy a repeating note left on a checklist, even with no checklist id', () => {
    expect(pendingNoteEditRefusal(pending({ repeatOf: 'pnote-0', attachedChecklistId: 'chk-1' }), 'emp-a')?.status).toBe(409)
    expect(pendingNoteEditRefusal(pending({ repeatOf: 'pnote-0' }), 'emp-a')?.status).toBe(409)
  })

  it('answers 404 for a missing note', () => {
    expect(pendingNoteEditRefusal(undefined, 'emp-a')).toEqual({ status: 404, error: NOTE_NOT_FOUND })
  })

  it('says where to edit it, in plain words', () => {
    expect(PENDING_NOTE_ALREADY_ADDED).toMatch(/already added to a checklist/i)
    expect(PENDING_NOTE_ALREADY_ADDED).toMatch(/edit it there/i)
  })
})
