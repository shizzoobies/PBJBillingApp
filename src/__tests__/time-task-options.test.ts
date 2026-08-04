import { describe, expect, it } from 'vitest'
import type { Checklist, ChecklistTemplate } from '../lib/types'
import { buildTimeTaskOptions, resolveTimeTaskChoice } from '../lib/timeTaskOptions'

function task(id: string, title: string): Checklist {
  return { id, title, clientId: 'client-a', assigneeId: '', items: [] } as unknown as Checklist
}

function template(id: string, title: string, isStandard: boolean): ChecklistTemplate {
  return { id, title, isStandard, clientId: isStandard ? '' : 'client-a' } as ChecklistTemplate
}

describe('buildTimeTaskOptions', () => {
  it("offers the client's open tasks first, then standard blueprints alphabetically", () => {
    const options = buildTimeTaskOptions(
      [task('chk-1', 'Reconcile checking'), task('chk-2', 'Chase receipts')],
      [
        template('tpl-1', 'Sales tax', true),
        template('tpl-2', 'Payroll', true),
        template('tpl-3', 'Monthly close', true),
      ],
    )
    expect(options).toEqual([
      { label: 'Reconcile checking', checklistId: 'chk-1' },
      { label: 'Chase receipts', checklistId: 'chk-2' },
      { label: 'Monthly close', checklistId: null },
      { label: 'Payroll', checklistId: null },
      { label: 'Sales tax', checklistId: null },
    ])
  })

  it('only pulls STANDARD templates — client-bound repeating setups are not offered', () => {
    const options = buildTimeTaskOptions(
      [],
      [template('tpl-1', 'Payroll', true), template('tpl-2', "Someone else's weekly", false)],
    )
    expect(options).toEqual([{ label: 'Payroll', checklistId: null }])
  })

  it('de-duplicates by title case-insensitively, keeping the real checklist', () => {
    // The client already has an open "Monthly Bookkeeping" — it must stay the
    // pickable one (it carries a taskId), and the identically-named blueprint
    // must not appear as a confusing second row.
    const options = buildTimeTaskOptions(
      [task('chk-1', 'Monthly Bookkeeping')],
      [template('tpl-1', ' monthly bookkeeping ', true), template('tpl-2', 'Payroll', true)],
    )
    expect(options).toEqual([
      { label: 'Monthly Bookkeeping', checklistId: 'chk-1' },
      { label: 'Payroll', checklistId: null },
    ])
  })

  it('drops blank titles and duplicate open tasks', () => {
    const options = buildTimeTaskOptions(
      [task('chk-1', 'Payroll'), task('chk-2', 'payroll'), task('chk-3', '   ')],
      [template('tpl-1', '', true)],
    )
    expect(options).toEqual([{ label: 'Payroll', checklistId: 'chk-1' }])
  })

  it('returns nothing when there is nothing to offer', () => {
    expect(buildTimeTaskOptions([], [])).toEqual([])
  })
})

describe('resolveTimeTaskChoice', () => {
  const options = buildTimeTaskOptions(
    [task('chk-1', 'Reconcile checking')],
    [template('tpl-1', 'Payroll', true)],
  )

  it('attaches to the real checklist when an open task is chosen', () => {
    expect(resolveTimeTaskChoice('Reconcile checking', options)).toEqual({
      taskId: 'chk-1',
      taskLabel: undefined,
    })
  })

  it('matches an open task regardless of case and surrounding space', () => {
    expect(resolveTimeTaskChoice('  reconcile CHECKING ', options)).toEqual({
      taskId: 'chk-1',
      taskLabel: undefined,
    })
  })

  it('keeps a standard blueprint as free text — it is no checklist of this client', () => {
    expect(resolveTimeTaskChoice('Payroll', options)).toEqual({
      taskId: null,
      taskLabel: 'Payroll',
    })
  })

  it('uses a custom typed value verbatim', () => {
    expect(resolveTimeTaskChoice('  Untangling the 2019 AP mess  ', options)).toEqual({
      taskId: null,
      taskLabel: 'Untangling the 2019 AP mess',
    })
  })

  it('treats empty / whitespace as no task at all', () => {
    expect(resolveTimeTaskChoice('', options)).toEqual({ taskId: null, taskLabel: undefined })
    expect(resolveTimeTaskChoice('   ', options)).toEqual({ taskId: null, taskLabel: undefined })
  })
})
