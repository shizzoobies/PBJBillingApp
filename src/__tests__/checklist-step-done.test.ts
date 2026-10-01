import { describe, expect, it } from 'vitest'
import { rollUpItemDone } from '../../lib/checklist-step-done.js'
import { isChecklistItemDone } from '../lib/utils'

/**
 * One rule for "is this step done?", shared by the server (which splits a push
 * by it) and the client (whose push dialog counts by it), so the dialog's
 * "N done, M open" cannot drift from what the push does.
 */
describe('the shared step-done rule', () => {
  const cases: Array<[string, { done: boolean; subItems?: unknown[] }, boolean]> = [
    ['a flat step uses its own flag (done)', { done: true }, true],
    ['a flat step uses its own flag (open)', { done: false }, false],
    [
      'a step marked done with an unchecked sub-step is OPEN',
      { done: true, subItems: [{ done: true }, { done: false }] },
      false,
    ],
    [
      'a step whose sub-steps are all done is done, whatever its own flag says',
      { done: false, subItems: [{ done: true }, { done: true }] },
      true,
    ],
    [
      'an unchecked sub-sub-step keeps the whole step open',
      { done: true, subItems: [{ done: true, subItems: [{ done: true }, { done: false }] }] },
      false,
    ],
  ]

  it.each(cases)('%s', (_label, step, expected) => {
    expect(rollUpItemDone(step as never)).toBe(expected)
    // The client's helper IS this rule, not a second copy of it.
    expect(isChecklistItemDone(step as never)).toBe(expected)
  })
})
