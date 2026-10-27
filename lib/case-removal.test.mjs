import { describe, expect, it } from 'vitest'

import {
  RESTORE_CONFLICT_MESSAGE,
  caseKeyOf,
  caseTitleOf,
  removeCaseConfirmText,
  removedCaseSet,
  restoreConflicts,
  rowsOfCase,
  stepCountLabel,
} from './case-removal.js'

/** Remove case (2026-10-27): the pure rules shared by the store, the workspace merge and the bin. */

const STAMP = '2026-10-27T15:00:00.123Z'

describe('caseKeyOf / rowsOfCase / caseTitleOf', () => {
  it('reads caseId, and a legacy row without one (or an empty one) is its own case', () => {
    expect(caseKeyOf({ id: 'cl-1', caseId: 'case-a' })).toBe('case-a')
    expect(caseKeyOf({ id: 'cl-legacy' })).toBe('cl-legacy')
    expect(caseKeyOf({ id: 'cl-empty', caseId: '' })).toBe('cl-empty')
    expect(caseKeyOf(null)).toBeNull()
  })

  it('lists exactly the rows of the case, on the client when one is named', () => {
    const rows = [
      { id: 'a-0', caseId: 'case-a', clientId: 'c1' },
      { id: 'a-1', caseId: 'case-a', clientId: 'c1' },
      // An imported recipe copy kept the case id on another client.
      { id: 'o-0', caseId: 'case-a', clientId: 'c2' },
      { id: 'b-0', caseId: 'case-b', clientId: 'c1' },
      null,
    ]
    expect(rowsOfCase(rows, 'case-a').map((row) => row.id)).toEqual(['a-0', 'a-1', 'o-0'])
    expect(rowsOfCase(rows, 'case-a', 'c1').map((row) => row.id)).toEqual(['a-0', 'a-1'])
    expect(rowsOfCase(rows, '')).toEqual([])
  })

  it("names a case by its first step's title", () => {
    expect(
      caseTitleOf([
        { title: 'Review', stageIndex: 1 },
        { title: 'Prep', stageIndex: 0 },
      ]),
    ).toBe('Prep')
    expect(caseTitleOf([], 'Fallback')).toBe('Fallback')
  })
})

describe('removedCaseSet', () => {
  const recycled = [
    { id: 'a-0', caseId: 'case-a', clientId: 'c1', deletedAt: STAMP },
    { id: 'a-1', caseId: 'case-a', clientId: 'c1', deletedAt: STAMP },
    // Deleted on its own, earlier: not part of the removal.
    { id: 'a-old', caseId: 'case-a', clientId: 'c1', deletedAt: '2026-01-01T00:00:00.000Z' },
    // Another case removed at the same instant is still another case.
    { id: 'b-0', caseId: 'case-b', clientId: 'c1', deletedAt: STAMP },
    // The same case id on another client is another case too.
    { id: 'o-0', caseId: 'case-a', clientId: 'c2', deletedAt: STAMP },
  ]

  it('is the rows of the case on the same client removed with it, the target first', () => {
    expect(removedCaseSet(recycled[1], recycled).map((row) => row.id)).toEqual(['a-1', 'a-0'])
    expect(removedCaseSet(recycled[4], recycled).map((row) => row.id)).toEqual(['o-0'])
  })

  it('a row deleted on its own is a set of one', () => {
    expect(removedCaseSet(recycled[2], recycled).map((row) => row.id)).toEqual(['a-old'])
    expect(removedCaseSet({ id: 'x', caseId: 'case-x', deletedAt: null }, recycled).map((row) => row.id)).toEqual(['x'])
    expect(removedCaseSet(null, recycled)).toEqual([])
  })
})

describe('restoreConflicts', () => {
  const removed = [
    { id: 'a-0', templateId: 't', dueDate: '2026-09-30', stageIndex: 0 },
    { id: 'a-1', templateId: 't', dueDate: '2026-10-05', stageIndex: 1 },
  ]

  it('names the removed steps whose cycle a live step holds again (the instance index key)', () => {
    const live = [{ id: 'new-0', templateId: 't', dueDate: '2026-09-30', stageIndex: 0 }]
    expect(restoreConflicts(removed, live).map((row) => row.id)).toEqual(['a-0'])
  })

  it('reads the cycle date of a pushed occurrence, and ignores rows the index does not cover', () => {
    const live = [
      // Pushed away from its cycle: still identified by the cycle date.
      { id: 'moved', templateId: 't', cycleDueDate: '2026-10-05', dueDate: '2026-11-05', stageIndex: 1 },
      // A pushed-from row and a one-off are outside the index.
      { id: 'pushed', templateId: 't', dueDate: '2026-09-30', stageIndex: 0, pushedToChecklistId: 'moved' },
      { id: 'one-off', dueDate: '2026-09-30', stageIndex: 0 },
    ]
    expect(restoreConflicts(removed, live).map((row) => row.id)).toEqual(['a-1'])
    expect(restoreConflicts(removed, [])).toEqual([])
    expect(RESTORE_CONFLICT_MESSAGE).toMatch(/remove the newer one first\.$/)
  })
})

describe('the confirm sentence', () => {
  it('says what Alex asked for, plural and singular', () => {
    expect(removeCaseConfirmText({ title: 'Monthly close', clientName: 'Acme', stepCount: 3 })).toBe(
      'Remove Monthly close for Acme? Its 3 steps go to the recycle bin (you can restore them there). The recipe keeps running on its next cycle.',
    )
    expect(removeCaseConfirmText({ title: 'Monthly close', clientName: 'Acme', stepCount: 1 })).toBe(
      'Remove Monthly close for Acme? Its 1 step goes to the recycle bin (you can restore it there). The recipe keeps running on its next cycle.',
    )
    expect(stepCountLabel(2)).toBe('2 steps')
  })
})
