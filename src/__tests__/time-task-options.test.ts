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
      { label: 'Reconcile checking', checklistId: 'chk-1', templateId: null },
      { label: 'Chase receipts', checklistId: 'chk-2', templateId: null },
      { label: 'Monthly close', checklistId: null, templateId: null },
      { label: 'Payroll', checklistId: null, templateId: null },
      { label: 'Sales tax', checklistId: null, templateId: null },
    ])
  })

  it('only pulls STANDARD templates — client-bound repeating setups are not offered', () => {
    const options = buildTimeTaskOptions(
      [],
      [template('tpl-1', 'Payroll', true), template('tpl-2', "Someone else's weekly", false)],
    )
    expect(options).toEqual([{ label: 'Payroll', checklistId: null, templateId: null }])
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
      { label: 'Monthly Bookkeeping', checklistId: 'chk-1', templateId: null },
      { label: 'Payroll', checklistId: null, templateId: null },
    ])
  })

  it('drops blank titles and duplicate open tasks', () => {
    const options = buildTimeTaskOptions(
      [task('chk-1', 'Payroll'), task('chk-2', 'payroll'), task('chk-3', '   ')],
      [template('tpl-1', '', true)],
    )
    expect(options).toEqual([{ label: 'Payroll', checklistId: 'chk-1', templateId: null }])
  })

  it('returns nothing when there is nothing to offer', () => {
    expect(buildTimeTaskOptions([], [])).toEqual([])
  })

  it('offers upcoming recurring tasks between the open tasks and the standards', () => {
    const options = buildTimeTaskOptions(
      [task('chk-1', 'Reconcile checking')],
      [template('tpl-std', 'Payroll', true)],
      [template('tpl-q1', 'Quarterly sales tax', false), template('tpl-1099', '1099 filing', false)],
    )
    expect(options).toEqual([
      { label: 'Reconcile checking', checklistId: 'chk-1', templateId: null },
      { label: 'Quarterly sales tax (upcoming)', checklistId: null, templateId: 'tpl-q1' },
      { label: '1099 filing (upcoming)', checklistId: null, templateId: 'tpl-1099' },
      { label: 'Payroll', checklistId: null, templateId: null },
    ])
  })

  it('keeps an upcoming task distinct from an identically-named standard blueprint', () => {
    // Both are pickable and mean different things — the upcoming one generates
    // this client's instance, the standard one is just a name.
    const options = buildTimeTaskOptions(
      [],
      [template('tpl-std', 'Payroll', true)],
      [template('tpl-up', 'Payroll', false)],
    )
    expect(options).toEqual([
      { label: 'Payroll (upcoming)', checklistId: null, templateId: 'tpl-up' },
      { label: 'Payroll', checklistId: null, templateId: null },
    ])
  })

  it('drops blank and duplicate upcoming titles', () => {
    const options = buildTimeTaskOptions(
      [],
      [],
      [
        template('tpl-a', 'Payroll', false),
        template('tpl-b', ' payroll ', false),
        template('tpl-c', '  ', false),
      ],
    )
    expect(options).toEqual([
      { label: 'Payroll (upcoming)', checklistId: null, templateId: 'tpl-a' },
    ])
  })
})

describe('resolveTimeTaskChoice', () => {
  const options = buildTimeTaskOptions(
    [task('chk-1', 'Reconcile checking')],
    [template('tpl-1', 'Payroll', true)],
    [template('tpl-2', 'Quarterly sales tax', false)],
  )

  it('attaches to the real checklist when an open task is chosen', () => {
    expect(resolveTimeTaskChoice('Reconcile checking', options)).toEqual({
      taskId: 'chk-1',
      taskLabel: undefined,
      templateId: null,
    })
  })

  it('matches an open task regardless of case and surrounding space', () => {
    expect(resolveTimeTaskChoice('  reconcile CHECKING ', options)).toEqual({
      taskId: 'chk-1',
      taskLabel: undefined,
      templateId: null,
    })
  })

  it('asks the caller to generate the instance when an upcoming task is chosen', () => {
    expect(resolveTimeTaskChoice('Quarterly sales tax (upcoming)', options)).toEqual({
      taskId: null,
      taskLabel: undefined,
      templateId: 'tpl-2',
    })
  })

  it('matches an upcoming task regardless of case and surrounding space', () => {
    expect(resolveTimeTaskChoice(' quarterly SALES TAX (Upcoming) ', options)).toEqual({
      taskId: null,
      taskLabel: undefined,
      templateId: 'tpl-2',
    })
  })

  it('treats the upcoming title WITHOUT the suffix as free text, not a generate', () => {
    // Only the exact row generates a checklist — typing the bare name is just a
    // name, so nothing is created behind the user's back.
    expect(resolveTimeTaskChoice('Quarterly sales tax', options)).toEqual({
      taskId: null,
      taskLabel: 'Quarterly sales tax',
      templateId: null,
    })
  })

  it('keeps a standard blueprint as free text — it is no checklist of this client', () => {
    expect(resolveTimeTaskChoice('Payroll', options)).toEqual({
      taskId: null,
      taskLabel: 'Payroll',
      templateId: null,
    })
  })

  it('uses a custom typed value verbatim', () => {
    expect(resolveTimeTaskChoice('  Untangling the 2019 AP mess  ', options)).toEqual({
      taskId: null,
      taskLabel: 'Untangling the 2019 AP mess',
      templateId: null,
    })
  })

  it('treats empty / whitespace as no task at all', () => {
    expect(resolveTimeTaskChoice('', options)).toEqual({
      taskId: null,
      taskLabel: undefined,
      templateId: null,
    })
    expect(resolveTimeTaskChoice('   ', options)).toEqual({
      taskId: null,
      taskLabel: undefined,
      templateId: null,
    })
  })
})
