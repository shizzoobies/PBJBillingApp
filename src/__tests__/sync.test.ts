import { describe, expect, it } from 'vitest'
import {
  isEditableElementTag,
  shouldDeferRefetch,
  workspaceSnapshot,
  type RefetchGuard,
} from '../lib/sync'

const clean: RefetchGuard = {
  preview: false,
  syncState: 'synced',
  recentlyEdited: false,
  dirty: false,
  editingField: false,
}

describe('shouldDeferRefetch', () => {
  it('applies the refetch when nothing is in progress', () => {
    expect(shouldDeferRefetch(clean)).toBe(false)
  })

  it('defers while previewing (read-only)', () => {
    expect(shouldDeferRefetch({ ...clean, preview: true })).toBe(true)
  })

  it('defers while a save is in flight or loading', () => {
    expect(shouldDeferRefetch({ ...clean, syncState: 'saving' })).toBe(true)
    expect(shouldDeferRefetch({ ...clean, syncState: 'loading' })).toBe(true)
  })

  it('defers while a save error is pending (so a refetch never masks unsaved work)', () => {
    expect(shouldDeferRefetch({ ...clean, syncState: 'error' })).toBe(true)
  })

  it('defers right after a local edit', () => {
    expect(shouldDeferRefetch({ ...clean, recentlyEdited: true })).toBe(true)
  })

  it('defers while there are unsaved local changes', () => {
    expect(shouldDeferRefetch({ ...clean, dirty: true })).toBe(true)
  })

  it('defers while the user is mid-edit in a focused field', () => {
    expect(shouldDeferRefetch({ ...clean, editingField: true })).toBe(true)
  })
})

describe('isEditableElementTag', () => {
  it('treats inputs, textareas and selects as editable', () => {
    expect(isEditableElementTag('INPUT')).toBe(true)
    expect(isEditableElementTag('textarea')).toBe(true)
    expect(isEditableElementTag('Select')).toBe(true)
  })

  it('treats contenteditable elements as editable regardless of tag', () => {
    expect(isEditableElementTag('DIV', true)).toBe(true)
  })

  it('treats non-editable elements as not editable', () => {
    expect(isEditableElementTag('DIV')).toBe(false)
    expect(isEditableElementTag('BUTTON')).toBe(false)
    expect(isEditableElementTag(null)).toBe(false)
    expect(isEditableElementTag(undefined)).toBe(false)
  })
})

describe('workspaceSnapshot', () => {
  it('produces equal strings for equal content and differs when content changes', () => {
    const a = { clients: [{ id: 'c1', name: 'Acme' }] }
    const b = { clients: [{ id: 'c1', name: 'Acme' }] }
    expect(workspaceSnapshot(a)).toBe(workspaceSnapshot(b))
    const c = { clients: [{ id: 'c1', name: 'Acme Inc' }] }
    expect(workspaceSnapshot(a)).not.toBe(workspaceSnapshot(c))
  })
})
