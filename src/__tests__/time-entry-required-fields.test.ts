import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  TIME_ENTRY_FIELD_PROMPTS,
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
