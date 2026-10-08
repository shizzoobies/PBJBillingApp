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
   * Group holding blocks (the multi-client timer): the members ARE the client,
   * and the task is required exactly as for a single-client entry (the owner's
   * rule, 2026-10-08): the slices cut from the block copy it, so group work
   * stops showing as "Unassigned" on reports.
   */
  describe('an unsplit group holding block', () => {
    const holding = {
      isAdministrative: false,
      clientId: '',
      groupClientIds: ['client-1', 'client-2'],
      description: 'Quarter-end review across the group.',
    }

    it('needs a task, with the same sentence a single-client entry gets', () => {
      const group = validateTimeEntryRequiredFields(holding)
      expect(group.missing).toEqual(['task'])
      const single = validateTimeEntryRequiredFields({
        isAdministrative: false,
        clientId: 'client-1',
        description: holding.description,
      })
      expect(single.missing).toEqual(['task'])
      expect(group.error).toBe(single.error)
    })

    it('is satisfied by a typed task name or a task id', () => {
      expect(validateTimeEntryRequiredFields({ ...holding, taskLabel: 'Payroll' }).error).toBeNull()
      expect(validateTimeEntryRequiredFields({ ...holding, taskId: 'task-1' }).error).toBeNull()
    })

    it('treats a blank typed task as no task', () => {
      expect(validateTimeEntryRequiredFields({ ...holding, taskLabel: '   ' }).missing).toEqual([
        'task',
      ])
    })

    it('still needs the detail, and names both when both are missing', () => {
      const result = validateTimeEntryRequiredFields({ ...holding, taskLabel: 'Payroll', description: '' })
      expect(result.missing).toEqual(['detail'])
      expect(validateTimeEntryRequiredFields({ ...holding, description: '' }).missing).toEqual([
        'task',
        'detail',
      ])
    })

    it('is not waived by a hand-built payload that also names a group id', () => {
      expect(validateTimeEntryRequiredFields({ ...holding, groupId: 'grp-1' }).missing).toEqual([
        'task',
      ])
    })

    it('keeps the administrative exemption: no members, no task, only a note', () => {
      expect(
        validateTimeEntryRequiredFields({ isAdministrative: true, groupClientIds: ['client-1'], description: 'Staff meeting' }).error,
      ).toBeNull()
    })
  })

  it('waives the task on a slice of an already-split group (groupId, no members)', () => {
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

/**
 * The route glue is not booted by the tests, so pin it by reading the source:
 * the create route must hand the validator the group members, the group id and
 * the typed task — those are what decide whether a group block needs a task.
 */
describe('POST /api/time-entries group-task glue', () => {
  const server = readFileSync(resolve('server.js'), 'utf8').split('\r\n').join('\n')
  const call = server.slice(
    server.indexOf('validateTimeEntryRequiredFields({'),
    server.indexOf('if (requiredFields.error)'),
  )

  it('passes the members, the group id and both task fields to the shared validator', () => {
    for (const key of ['groupClientIds', 'groupId', 'taskId', 'taskLabel', 'description']) {
      expect(call).toContain(key)
    }
  })

  it('keeps a typed task on a group holding block (a label is dropped only for admin time or a task id)', () => {
    expect(server).toContain(
      "!isAdministrative && !taskId && typeof payload?.taskLabel === 'string'",
    )
  })

  it('tells a stale page how to act on the refusal, and only for a group block', () => {
    // A tab loaded before the Task box existed has a running group timer and no
    // box to fill: its refusal names the way out. The current page blocks
    // before sending, so only a stale page ever sees the second sentence.
    expect(server).toContain(
      "groupClientIds.length > 0 && requiredFields.missing.includes('task')",
    )
    expect(server).toContain(
      "If you don't see a Task box, refresh the page. Your timer is kept.",
    )
    expect(server).toContain('error: requiredFields.error + staleGroupHint')
  })

  /**
   * PATCH parity, read from the route itself: an edit never runs the
   * required-fields check, and it cannot touch a typed task name at all (it
   * reads `taskId` only; `taskLabel` is a create-time field), so a group
   * block's task survives every edit just as a single entry's does. The store's
   * `updateTimeEntry` maps no `taskLabel` column either.
   */
  it('leaves PATCH task edits unguarded and cannot clear a typed task', () => {
    const patchStart = server.indexOf('// ---- Edit (PATCH) ----')
    const patchRoute = server.slice(patchStart, server.indexOf("request.method === 'DELETE'", patchStart))
    expect(patchStart).toBeGreaterThan(0)
    expect(patchRoute).toContain('patch.taskId')
    expect(patchRoute).not.toContain('validateTimeEntryRequiredFields')
    expect(patchRoute).not.toContain('taskLabel')

    const store = readFileSync(resolve('db/store.js'), 'utf8').split('\r\n').join('\n')
    const updateStart = store.indexOf('async updateTimeEntry(')
    expect(updateStart).toBeGreaterThan(0)
    const nextMethod = store.indexOf('\n  async ', updateStart + 10)
    expect(store.slice(updateStart, nextMethod)).not.toContain('taskLabel')
    expect(validateTimeEntryEdit({ description: 'x' }, { taskId: null }).error).toBeNull()
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

  /**
   * `billable` joined `isAdhoc` in the exemption with the hours panel beside the
   * invoice (featreq-8cec48db). The two flags together ARE the scope decision —
   * in scope, out of scope, ad hoc — and the panel writes it without touching
   * approval at all. A narrower rule here would mean the same decision cost an
   * entry its sign-off on the Time page and not on the invoice.
   */
  it('does NOT un-approve when an owner changes only the billable flag', () => {
    expect(editRequiresReapproval('approved', { billable: false }, true)).toBe(false)
  })

  it('does NOT un-approve when an owner sets both scope flags together', () => {
    expect(editRequiresReapproval('approved', { billable: true, isAdhoc: true }, true)).toBe(false)
  })

  it('still un-approves when an owner changes billable AND something else', () => {
    expect(editRequiresReapproval('approved', { billable: false, minutes: 45 }, true)).toBe(true)
  })

  it('still un-approves when a non-owner changes billable', () => {
    expect(editRequiresReapproval('approved', { billable: false }, false)).toBe(true)
  })
})
