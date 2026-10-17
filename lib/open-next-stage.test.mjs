import { describe, expect, it } from 'vitest'

import {
  caseAllDone,
  nextStageRefusalMessage,
  skipCompletesCase,
  stageHasOpenWait,
} from './open-next-stage.js'

describe('stageHasOpenWait', () => {
  it('sees a waiting step or sub-step that is still open, never a done one', () => {
    expect(stageHasOpenWait({ items: [{ done: false, waiting: true }] })).toBe(true)
    expect(
      stageHasOpenWait({ items: [{ done: false, subItems: [{ done: true }, { done: false, waiting: true }] }] }),
    ).toBe(true)
    expect(stageHasOpenWait({ items: [{ done: true, waiting: true }, { done: false }] })).toBe(false)
    expect(stageHasOpenWait(undefined)).toBe(false)
  })
})

const row = (over = {}) => ({
  id: 'cl-0',
  caseId: 'case-1',
  stageIndex: 0,
  stageCount: 2,
  items: [{ done: true }],
  ...over,
})

describe('skipCompletesCase', () => {
  const finalDone = row({ id: 'cl-1', stageIndex: 1 })

  it('skipping the earlier, waiting stage after the last stage finished completes the case', () => {
    const waiting = row({ items: [{ done: false, waiting: true }], skippedAt: '2026-10-14T12:00:00.000Z' })
    expect(skipCompletesCase({ checklists: [waiting, finalDone] }, waiting)).toBe(true)
  })

  it('skipping a middle stage while the last stage is not finished completes nothing', () => {
    const middle = row({ stageIndex: 1, stageCount: 3, skippedAt: '2026-10-14T12:00:00.000Z' })
    const first = row({ id: 'cl-a', stageCount: 3 })
    const lastOpen = row({ id: 'cl-c', stageIndex: 2, stageCount: 3, items: [{ done: false }] })
    expect(skipCompletesCase({ checklists: [first, middle] }, middle)).toBe(false)
    expect(skipCompletesCase({ checklists: [first, middle, lastOpen] }, middle)).toBe(false)
  })

  it('a skipped single-stage occurrence is not a completed case', () => {
    const one = row({ stageCount: 1, skippedAt: '2026-10-14T12:00:00.000Z' })
    expect(skipCompletesCase({ checklists: [one, row({ id: 'cl-2', caseId: 'case-1', stageCount: 1 })] }, one)).toBe(false)
  })
})

describe('caseAllDone', () => {
  it('a recycled stage with open steps does not hold the case open', () => {
    const recycled = row({ id: 'cl-old', items: [{ done: false }], deletedAt: '2026-10-10T12:00:00.000Z' })
    expect(caseAllDone({ checklists: [recycled, row({ id: 'cl-1', stageIndex: 1 })] }, 'case-1')).toBe(true)
    expect(caseAllDone({ checklists: [{ ...recycled, deletedAt: null }, row({ id: 'cl-1', stageIndex: 1 })] }, 'case-1')).toBe(false)
  })

  it('the last stage done while an earlier stage is still waiting is NOT a finished case', () => {
    const data = {
      checklists: [
        row({ items: [{ done: true }, { done: false, waiting: true }] }),
        row({ id: 'cl-1', stageIndex: 1 }),
      ],
    }
    expect(caseAllDone(data, 'case-1')).toBe(false)
  })

  it('every stage done, final stage included, is a finished case', () => {
    const data = { checklists: [row(), row({ id: 'cl-1', stageIndex: 1 })] }
    expect(caseAllDone(data, 'case-1')).toBe(true)
  })

  it('a row with no steps never holds the case open', () => {
    const data = { checklists: [row({ items: [] }), row({ id: 'cl-1', stageIndex: 1 })] }
    expect(caseAllDone(data, 'case-1')).toBe(true)
    expect(caseAllDone({ checklists: [row(), row({ id: 'cl-1', stageIndex: 1, items: [] })] }, 'case-1')).toBe(true)
  })

  it('every row done but the final stage not created yet is not finished', () => {
    expect(caseAllDone({ checklists: [row()] }, 'case-1')).toBe(false)
  })

  it('a finished one-off (one stage, its own case) is finished', () => {
    const data = { checklists: [{ id: 'cl-x', items: [{ done: true }] }] }
    expect(caseAllDone(data, 'cl-x')).toBe(true)
  })

  it('a skipped occurrence does not hold the case open; other cases do not count', () => {
    const data = {
      checklists: [
        row({ skippedAt: '2026-10-10', items: [{ done: false }] }),
        row({ id: 'cl-1', stageIndex: 1 }),
        row({ id: 'cl-z', caseId: 'case-2', items: [{ done: false }] }),
      ],
    }
    expect(caseAllDone(data, 'case-1')).toBe(true)
    expect(caseAllDone(data, 'case-2')).toBe(false)
    expect(caseAllDone(data, '')).toBe(false)
  })
})

describe('nextStageRefusalMessage', () => {
  it('names the next step by number', () => {
    expect(nextStageRefusalMessage('already_spawned', { stageIndex: 1 })).toBe('Step 3 is already open.')
    expect(nextStageRefusalMessage('next_stage_empty', { stageIndex: 0, nextStageName: 'Review' })).toBe(
      'Step 2 (Review) has nothing on it, so there is nothing to open.',
    )
  })

  it('says another case holds the step on that date', () => {
    expect(nextStageRefusalMessage('date_taken', { stageIndex: 0 })).toBe(
      'Step 2 could not be created: another case of this recipe already has that step on that date.',
    )
  })

  it('says a later step of the case is already open (featreq-ed73d181)', () => {
    expect(nextStageRefusalMessage('later_stage_exists', { stageIndex: 1 })).toBe(
      'A step after Step 3 is already open, so Step 3 is not created behind it.',
    )
  })

  it('says what to do when the stage is not ready', () => {
    expect(nextStageRefusalMessage('not_ready')).toBe(
      'Nothing here is waiting - finish the steps or mark one as waiting.',
    )
    expect(nextStageRefusalMessage('not_ready', { anyWaiting: true })).toBe(
      'Some steps here are still open and not waiting - finish them or mark them as waiting.',
    )
  })

  it('has a sentence for every refusal the store gives', () => {
    for (const reason of [
      'not_found',
      'skipped',
      'pushed',
      'onboarding',
      'last_stage',
      'no_template',
      'template_not_found',
      'no_stages',
    ]) {
      expect(nextStageRefusalMessage(reason, { stageIndex: 0 })).toMatch(/\.$/)
    }
    expect(nextStageRefusalMessage('template_not_found')).toBe(
      'The recipe for this task no longer has a step 2 to open.',
    )
  })
})
