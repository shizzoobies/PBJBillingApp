import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import {
  canAddPendingClientNote,
  canWriteChecklist,
  canWriteChecklistItem,
  checklistWriteDenial,
  pendingNoteWriteDenial,
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

/**
 * Pending notes for future recurring checklists (featreq-b688e73c): the write
 * boundary is the CLIENT, not the checklist. Any teammate the client is visible
 * to may flag a note for any of its active recurring checklists - Brittany's
 * send-back of 2026-10-06 ("Allison & Lisa are not able to do this"): the first
 * cut also required being the assignee or an editor of the template or one of
 * its live checklists, which left teammates without the controls she has.
 * There may be no live checklist of the template yet (that is the whole point
 * of a pending note), so nothing here looks at the checklists.
 */
describe('canAddPendingClientNote', () => {
  const payrollTemplate = { assigneeId: 'emp-lisa', editorIds: [] }

  it('allows the owner regardless of the template or client visibility', () => {
    assert.equal(
      canAddPendingClientNote({
        user: owner,
        clientVisible: false,
        template: payrollTemplate,
        checklists: [],
      }),
      true,
    )
  })

  it('refuses a staff user the client is not visible to, even as the template’s assignee', () => {
    assert.equal(
      canAddPendingClientNote({
        user: lisa,
        clientVisible: false,
        template: payrollTemplate,
        checklists: [],
      }),
      false,
    )
  })

  it('allows the template’s own assignee with no live checklist yet', () => {
    assert.equal(
      canAddPendingClientNote({
        user: lisa,
        clientVisible: true,
        template: payrollTemplate,
        checklists: [],
      }),
      true,
    )
  })

  it('allows a named editor of the template', () => {
    const withEditor = { ...payrollTemplate, editorIds: ['emp-brit'] }
    assert.equal(
      canAddPendingClientNote({
        user: brittany,
        clientVisible: true,
        template: withEditor,
        checklists: [],
      }),
      true,
    )
  })

  it('allows the assignee of one of the template’s LIVE checklists, even without template access', () => {
    assert.equal(
      canAddPendingClientNote({
        user: brittany,
        clientVisible: true,
        template: payrollTemplate,
        checklists: [{ assigneeId: 'emp-brit', editorIds: [] }],
      }),
      true,
    )
  })

  it('allows a named editor of one of the template’s live checklists', () => {
    assert.equal(
      canAddPendingClientNote({
        user: brittany,
        clientVisible: true,
        template: payrollTemplate,
        checklists: [{ assigneeId: 'emp-lisa', editorIds: ['emp-brit'] }],
      }),
      true,
    )
  })

  it('allows a teammate the client is visible to, even on neither the template nor any live checklist of it', () => {
    // The send-back of 2026-10-06: Allison and Lisa are on the client's team but
    // not on the recurring checklist; they get the same controls as the owner.
    assert.equal(
      canAddPendingClientNote({
        user: stranger,
        clientVisible: true,
        template: payrollTemplate,
        checklists: [{ assigneeId: 'emp-lisa', editorIds: [] }],
      }),
      true,
    )
  })

  it('refuses when there is no template at all (an unknown/mistyped templateId)', () => {
    assert.equal(
      canAddPendingClientNote({
        user: lisa,
        clientVisible: true,
        template: undefined,
        checklists: [],
      }),
      false,
    )
  })
})

describe('pendingNoteWriteDenial', () => {
  it('returns null when allowed', () => {
    assert.equal(
      pendingNoteWriteDenial({
        user: lisa,
        clientVisible: true,
        template: { assigneeId: 'emp-lisa', editorIds: [] },
        checklists: [],
      }),
      null,
    )
  })

  it('returns a 403 with the caller’s message when refused', () => {
    // Refused because the client is not visible to them; a visible client's
    // teammate is allowed since the 2026-10-06 send-back.
    const denial = pendingNoteWriteDenial({
      user: stranger,
      clientVisible: false,
      template: { assigneeId: 'emp-lisa', editorIds: [] },
      checklists: [],
      error: 'custom denial',
    })
    assert.deepEqual(denial, { status: 403, error: 'custom denial' })
  })

  it('falls back to a human default message', () => {
    const denial = pendingNoteWriteDenial({
      user: stranger,
      clientVisible: false,
      template: { assigneeId: 'emp-lisa', editorIds: [] },
      checklists: [],
    })
    assert.equal(denial?.status, 403)
    assert.match(denial?.error ?? '', /owner.*teammate who can see this client/)
  })
})
