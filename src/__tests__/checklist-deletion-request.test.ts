import { describe, expect, it } from 'vitest'
import { checklistHasPendingDeletionRequest } from '../lib/utils'
import type { Checklist } from '../lib/types'

/**
 * Minimal Checklist factory — only the fields the helper reads matter, so the
 * test stays focused on the pure pending-deletion-request logic.
 */
function makeChecklist(over: Partial<Checklist>): Checklist {
  return {
    id: 'cl-1',
    title: 'Task',
    clientId: 'client-1',
    assigneeId: 'emp-1',
    dueDate: '2026-07-01',
    viewerIds: [],
    editorIds: [],
    items: [],
    ...over,
  }
}

describe('checklistHasPendingDeletionRequest', () => {
  it('is false when no request fields are set', () => {
    expect(checklistHasPendingDeletionRequest(makeChecklist({}))).toBe(false)
  })

  it('is false when deletionRequestedBy is null', () => {
    expect(
      checklistHasPendingDeletionRequest(makeChecklist({ deletionRequestedBy: null })),
    ).toBe(false)
  })

  it('is false when deletionRequestedBy is an empty string', () => {
    expect(
      checklistHasPendingDeletionRequest(makeChecklist({ deletionRequestedBy: '' })),
    ).toBe(false)
  })

  it('is true when a requester id is present', () => {
    expect(
      checklistHasPendingDeletionRequest(
        makeChecklist({ deletionRequestedBy: 'emp-2', deletionRequestedAt: '2026-06-22T10:00:00Z' }),
      ),
    ).toBe(true)
  })
})
