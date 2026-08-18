import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  TIME_ENTRY_FIELD_PROMPTS,
  adhocAfterEntryEdit,
  editRequiresReapproval,
  validateTimeEntryEdit,
  validateTimeEntryRequiredFields,
} from '../../lib/time-entry.js'

/**
 * The firm owner's rule: "remove the auto-generated description, and require
 * Client, Task and Detail before time can be logged." Starting a timer stays
 * free — these pin the SAVE side, which the server enforces and the Time page
 * mirrors field-by-field.
 */

/** A complete, loggable non-administrative entry. */
const complete = {
  isAdministrative: false,
  clientId: 'client-1',
  taskId: 'task-1',
  description: 'Reconciled the operating account.',
}

describe('validateTimeEntryRequiredFields', () => {
  it('accepts a complete client entry', () => {
    const result = validateTimeEntryRequiredFields(complete)
    expect(result.error).toBeNull()
    expect(result.missing).toEqual([])
  })

  it('names the missing detail', () => {
    const result = validateTimeEntryRequiredFields({ ...complete, description: '   ' })
    expect(result.missing).toEqual(['detail'])
    expect(result.error).toMatch(/detail/i)
  })

  it('names the missing task', () => {
    const result = validateTimeEntryRequiredFields({ ...complete, taskId: '' })
    expect(result.missing).toEqual(['task'])
    expect(result.error).toMatch(/task/i)
  })

  it('names the missing client', () => {
    const result = validateTimeEntryRequiredFields({ ...complete, clientId: '' })
    expect(result.missing).toEqual(['client'])
    expect(result.error).toMatch(/client/i)
  })

  it('names EVERY missing field in one message', () => {
    const result = validateTimeEntryRequiredFields({ isAdministrative: false })
    expect(result.missing).toEqual(['client', 'task', 'detail'])
    expect(result.error).toMatch(/client/i)
    expect(result.error).toMatch(/task/i)
    expect(result.error).toMatch(/detail/i)
  })

  it('counts a TYPED task name as the task (the pick-or-type box)', () => {
    const typed = validateTimeEntryRequiredFields({
      ...complete,
      taskId: '',
      taskLabel: 'Catch-up bookkeeping',
    })
    expect(typed.error).toBeNull()
    // Whitespace is not a task name.
    expect(validateTimeEntryRequiredFields({ ...complete, taskId: '', taskLabel: '  ' }).missing)
      .toEqual(['task'])
  })

  it('requires ONLY a detail on administrative time', () => {
    const withNote = validateTimeEntryRequiredFields({
      isAdministrative: true,
      description: 'Company meeting.',
    })
    expect(withNote.error).toBeNull()

    const withoutNote = validateTimeEntryRequiredFields({ isAdministrative: true })
    expect(withoutNote.missing).toEqual(['detail'])
    // Long-standing wording for admin time, unchanged.
    expect(withoutNote.error).toBe('Administrative time needs a note describing the work.')
  })

  /**
   * Group blocks: the members ARE the client, and the timer form never offers a
   * task for a block spanning several clients — tasks are settled when it is
   * split. So the task is waived and the detail is not.
   */
  it('waives the task on an unsplit group holding block, but not the detail', () => {
    const holding = {
      isAdministrative: false,
      clientId: '',
      groupClientIds: ['client-1', 'client-2'],
      description: 'Quarter-end review across the group.',
    }
    expect(validateTimeEntryRequiredFields(holding).error).toBeNull()
    expect(validateTimeEntryRequiredFields({ ...holding, description: '' }).missing).toEqual([
      'detail',
    ])
  })

  it('waives the task on a slice of an already-split group', () => {
    const slice = { ...complete, taskId: '', groupId: 'grp-1' }
    expect(validateTimeEntryRequiredFields(slice).error).toBeNull()
    expect(validateTimeEntryRequiredFields({ ...slice, description: '' }).missing).toEqual([
      'detail',
    ])
  })
})

describe('validateTimeEntryEdit', () => {
  const stored = { description: 'Reconciled the operating account.' }

  it('refuses to blank a detail that was filled in', () => {
    expect(validateTimeEntryEdit(stored, { description: '' }).error).toMatch(/detail/i)
    expect(validateTimeEntryEdit(stored, { description: '   ' }).error).toMatch(/detail/i)
  })

  it('allows a real detail edit', () => {
    expect(validateTimeEntryEdit(stored, { description: 'Fixed the payroll split.' }).error)
      .toBeNull()
  })

  it('leaves an edit that does not touch the detail alone', () => {
    expect(validateTimeEntryEdit(stored, { minutes: 45 }).error).toBeNull()
  })

  /**
   * Legacy rows saved before details were mandatory keep loading AND stay
   * editable — fixing their minutes or client must not be blocked by a blank
   * description they never had a chance to fill in.
   */
  it('lets a legacy blank-detail entry be edited', () => {
    const legacy = { description: '' }
    expect(validateTimeEntryEdit(legacy, { minutes: 45 }).error).toBeNull()
    expect(validateTimeEntryEdit(legacy, { minutes: 45, description: '' }).error).toBeNull()
    expect(validateTimeEntryEdit(legacy, { clientId: 'client-2', description: '' }).error)
      .toBeNull()
  })
})

describe('no auto-generated description survives', () => {
  it('the Time page invents no description at start or stop', () => {
    // Vitest runs from the project root; read the real source off disk.
    const source = readFileSync(resolve('src/pages/TimePage.tsx'), 'utf8')
    // The exact defaults that used to be injected — a pre-filled "standard"
    // note in the timer form, and three fallbacks on the way to the entry.
    for (const removed of [
      'Reviewed transactions and added client notes.',
      "'Group time'",
      "'Timed bookkeeping work'",
      "'Administrative time'",
    ]) {
      expect(source).not.toContain(removed)
    }
  })

  it('stopping a timer sends only what was typed', () => {
    const source = readFileSync(resolve('src/App.tsx'), 'utf8')
    expect(source).not.toContain('Timed bookkeeping work')
  })
})

describe('TIME_ENTRY_FIELD_PROMPTS', () => {
  it('has one prompt per required field', () => {
    expect(TIME_ENTRY_FIELD_PROMPTS.detail).toMatch(/detail/i)
    expect(TIME_ENTRY_FIELD_PROMPTS.task).toMatch(/task/i)
    expect(TIME_ENTRY_FIELD_PROMPTS.client).toMatch(/client/i)
  })
})

/**
 * Where the ad hoc flag ends up after an edit. The rule has to be read against
 * where the entry ENDS UP, not where it started — one save can both re-file an
 * administrative entry onto a client and tick the ad hoc box, and resolving the
 * flag first threw the tick away without saying so.
 */
describe('adhocAfterEntryEdit', () => {
  // The regression. The Time page's edit form sends exactly this body when
  // someone un-ticks "Administrative", picks a client, and ticks "Ad hoc" in
  // one save. Resolved against the entry's OLD state it read as administrative
  // time and forced the flag off.
  it('keeps the flag when the same save re-files admin time onto a client', () => {
    expect(
      adhocAfterEntryEdit({
        payload: { isAdministrative: false, clientId: 'client-1', isAdhoc: true },
        effectiveIsAdministrative: false,
        becameAdministrative: false,
      }),
    ).toBe(true)
  })

  it('forces the flag off when the same save moves a client entry to admin', () => {
    expect(
      adhocAfterEntryEdit({
        payload: { isAdministrative: true, isAdhoc: true },
        effectiveIsAdministrative: true,
        becameAdministrative: true,
      }),
    ).toBe(false)
  })

  // Administrative time has no client to be outside the scope of, so a caller
  // asking for the flag on one that stays administrative is refused.
  it('refuses the flag on an entry that stays administrative', () => {
    expect(
      adhocAfterEntryEdit({ payload: { isAdhoc: true }, effectiveIsAdministrative: true }),
    ).toBe(false)
  })

  it('clears a flag the entry was carrying when an edit makes it administrative', () => {
    expect(
      adhocAfterEntryEdit({
        payload: { isAdministrative: true },
        effectiveIsAdministrative: true,
        becameAdministrative: true,
      }),
    ).toBe(false)
  })

  it('takes the person’s answer on ordinary client time, both ways', () => {
    expect(
      adhocAfterEntryEdit({ payload: { isAdhoc: true }, effectiveIsAdministrative: false }),
    ).toBe(true)
    expect(
      adhocAfterEntryEdit({ payload: { isAdhoc: false }, effectiveIsAdministrative: false }),
    ).toBe(false)
  })

  // Writing a key nobody asked for is what would make a no-op save look like a
  // change — and `editRequiresReapproval` counts keys.
  it('writes nothing when nobody asked and nothing forced it', () => {
    expect(
      adhocAfterEntryEdit({ payload: { description: 'x' }, effectiveIsAdministrative: false }),
    ).toBeUndefined()
    expect(
      adhocAfterEntryEdit({ payload: { description: 'x' }, effectiveIsAdministrative: true }),
    ).toBeUndefined()
    expect(adhocAfterEntryEdit({ payload: null, effectiveIsAdministrative: false })).toBeUndefined()
  })

  it('ignores a non-boolean flag rather than coercing it', () => {
    expect(
      adhocAfterEntryEdit({ payload: { isAdhoc: 'yes' }, effectiveIsAdministrative: false }),
    ).toBeUndefined()
  })
})

/**
 * What costs an entry its sign-off. Money-adjacent in both directions: too
 * eager and an owner's own review correction silently un-approves the row she
 * is looking at; too lax and a changed client or duration keeps an approval
 * that was given for different facts.
 */
describe('editRequiresReapproval', () => {
  it('sends a changed approved entry back through approval', () => {
    expect(editRequiresReapproval('approved', { minutes: 90 }, true)).toBe(true)
    expect(editRequiresReapproval('rejected', { clientId: 'c2' }, false)).toBe(true)
  })

  it('leaves a pending entry alone — there is nothing to revoke', () => {
    expect(editRequiresReapproval('pending', { minutes: 90 }, false)).toBe(false)
  })

  it('ignores a patch that changes nothing, so a no-op save cannot churn the queue', () => {
    expect(editRequiresReapproval('approved', {}, false)).toBe(false)
  })

  // The owner IS the approver, and the review surface is where she is meant to
  // set this. Re-queueing would pull the row out of the list she is working
  // through, which is the opposite of a backstop.
  it('does NOT un-approve when an owner flips only the ad hoc flag', () => {
    expect(editRequiresReapproval('approved', { isAdhoc: true }, true)).toBe(false)
  })

  it('still un-approves when an owner changes the flag AND something else', () => {
    expect(editRequiresReapproval('approved', { isAdhoc: true, minutes: 45 }, true)).toBe(true)
  })

  // A bookkeeper re-flagging their own approved time changes what it bills;
  // that has to go back past an owner.
  it('still un-approves when a non-owner changes the flag', () => {
    expect(editRequiresReapproval('approved', { isAdhoc: true }, false)).toBe(true)
  })
})
