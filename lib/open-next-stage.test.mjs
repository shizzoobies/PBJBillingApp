import { describe, expect, it } from 'vitest'

import { caseAllDone, nextStageRefusalMessage, stageHasOpenWait } from './open-next-stage.js'

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

describe('caseAllDone', () => {
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
