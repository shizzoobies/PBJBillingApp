import { describe, expect, it } from 'vitest'

import { caseKeyOf, removeCaseConfirmText, removedCaseSet, rowsOfCase, stepCountLabel } from './case-removal.js'

/** Remove case (2026-10-27): the pure rules shared by the store, the workspace merge and the bin. */

const STAMP = '2026-10-27T15:00:00.123Z'

describe('caseKeyOf / rowsOfCase', () => {
  it('reads caseId, and a legacy row without one is its own case', () => {
    expect(caseKeyOf({ id: 'cl-1', caseId: 'case-a' })).toBe('case-a')
    expect(caseKeyOf({ id: 'cl-legacy' })).toBe('cl-legacy')
    expect(caseKeyOf(null)).toBeNull()
  })

  it('lists exactly the rows of the case', () => {
    const rows = [
      { id: 'a-0', caseId: 'case-a' },
      { id: 'a-1', caseId: 'case-a' },
      { id: 'b-0', caseId: 'case-b' },
      { id: 'case-a' },
      null,
    ]
    expect(rowsOfCase(rows, 'case-a').map((row) => row.id)).toEqual(['a-0', 'a-1', 'case-a'])
    expect(rowsOfCase(rows, '')).toEqual([])
  })
})

describe('removedCaseSet', () => {
  const recycled = [
    { id: 'a-0', caseId: 'case-a', deletedAt: STAMP },
    { id: 'a-1', caseId: 'case-a', deletedAt: STAMP },
    // Deleted on its own, earlier: not part of the removal.
    { id: 'a-old', caseId: 'case-a', deletedAt: '2026-01-01T00:00:00.000Z' },
    // Another case removed at the same instant is still another case.
    { id: 'b-0', caseId: 'case-b', deletedAt: STAMP },
  ]

  it('is the rows of the case removed with it, the target first', () => {
    expect(removedCaseSet(recycled[1], recycled).map((row) => row.id)).toEqual(['a-1', 'a-0'])
  })

  it('a row deleted on its own is a set of one', () => {
    expect(removedCaseSet(recycled[2], recycled).map((row) => row.id)).toEqual(['a-old'])
    expect(removedCaseSet({ id: 'x', caseId: 'case-x', deletedAt: null }, recycled).map((row) => row.id)).toEqual(['x'])
    expect(removedCaseSet(null, recycled)).toEqual([])
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
