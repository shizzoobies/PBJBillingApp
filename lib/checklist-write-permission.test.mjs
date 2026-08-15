import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import {
  canWriteChecklist,
  canWriteChecklistItem,
  checklistWriteDenial,
} from './checklist-write-permission.js'

/**
 * The bug this pins: Brittany, signed in as a bookkeeper, could open a client
 * she shares with Lisa and edit LISA's active checklist — because every write
 * endpoint treated "the client is in my visible set" as sufficient. It is not.
 * Visibility is a read scope; writing needs assignee/editor.
 */

const owner = { id: 'emp-patrice', role: 'owner' }
const lisa = { id: 'emp-lisa', role: 'employee' }
const brittany = { id: 'emp-brit', role: 'employee' }
const stranger = { id: 'emp-nobody', role: 'employee' }

const shared = new Set(['client-shared'])

/** Lisa's active checklist on a client she and Brittany both work. */
const lisasChecklist = {
  clientId: 'client-shared',
  assigneeId: 'emp-lisa',
  editorIds: [],
}

describe('canWriteChecklist', () => {
  it('refuses a colleague who only shares the client', () => {
    assert.equal(
      canWriteChecklist({ user: brittany, checklist: lisasChecklist, visibleClientIds: shared }),
      false,
    )
  })

  it('allows the assignee', () => {
    assert.equal(
      canWriteChecklist({ user: lisa, checklist: lisasChecklist, visibleClientIds: shared }),
      true,
    )
  })

  it('allows a named editor', () => {
    const withEditor = { ...lisasChecklist, editorIds: ['emp-brit'] }
    assert.equal(
      canWriteChecklist({ user: brittany, checklist: withEditor, visibleClientIds: shared }),
      true,
    )
  })

  it('allows the owner regardless of assignment or visibility', () => {
    assert.equal(
      canWriteChecklist({ user: owner, checklist: lisasChecklist, visibleClientIds: new Set() }),
      true,
    )
  })

  it('refuses an assignee who has lost visibility of the client', () => {
    assert.equal(
      canWriteChecklist({ user: lisa, checklist: lisasChecklist, visibleClientIds: new Set() }),
      false,
    )
  })

  it('refuses someone with no relationship to the client at all', () => {
    assert.equal(
      canWriteChecklist({ user: stranger, checklist: lisasChecklist, visibleClientIds: new Set() }),
      false,
    )
  })

  it('refuses when the session or checklist is missing', () => {
    assert.equal(
      canWriteChecklist({ user: undefined, checklist: lisasChecklist, visibleClientIds: shared }),
      false,
    )
    assert.equal(
      canWriteChecklist({ user: lisa, checklist: undefined, visibleClientIds: shared }),
      false,
    )
  })
})

describe('canWriteChecklistItem', () => {
  it('allows the step-level assignee even when the task is someone else’s', () => {
    assert.equal(
      canWriteChecklistItem({
        user: brittany,
        checklist: lisasChecklist,
        item: { assigneeId: 'emp-brit' },
        visibleClientIds: shared,
      }),
      true,
    )
  })

  it('still refuses a colleague when the step belongs to someone else', () => {
    assert.equal(
      canWriteChecklistItem({
        user: brittany,
        checklist: lisasChecklist,
        item: { assigneeId: 'emp-lisa' },
        visibleClientIds: shared,
      }),
      false,
    )
  })

  it('still refuses a colleague when the step has no assignee of its own', () => {
    assert.equal(
      canWriteChecklistItem({
        user: brittany,
        checklist: lisasChecklist,
        item: {},
        visibleClientIds: shared,
      }),
      false,
    )
  })

  it('does not let a step assignee reach a client they cannot see', () => {
    assert.equal(
      canWriteChecklistItem({
        user: brittany,
        checklist: lisasChecklist,
        item: { assigneeId: 'emp-brit' },
        visibleClientIds: new Set(),
      }),
      false,
    )
  })
})

describe('checklistWriteDenial', () => {
  it('returns null when allowed', () => {
    assert.equal(
      checklistWriteDenial({
        user: lisa,
        checklist: lisasChecklist,
        visibleClientIds: shared,
      }),
      null,
    )
  })

  it('returns a 403 with the caller’s message when refused', () => {
    const denial = checklistWriteDenial({
      user: brittany,
      checklist: lisasChecklist,
      visibleClientIds: shared,
      error: 'You do not have permission to reorder items',
    })
    assert.deepEqual(denial, {
      status: 403,
      error: 'You do not have permission to reorder items',
    })
  })

  it('falls back to a human default message', () => {
    const denial = checklistWriteDenial({
      user: brittany,
      checklist: lisasChecklist,
      visibleClientIds: shared,
    })
    assert.equal(denial?.status, 403)
    assert.match(denial?.error ?? '', /only its assignee or an editor/)
  })

  it('uses the item rule when an item is supplied', () => {
    assert.equal(
      checklistWriteDenial({
        user: brittany,
        checklist: lisasChecklist,
        item: { assigneeId: 'emp-brit' },
        visibleClientIds: shared,
      }),
      null,
    )
  })
})
