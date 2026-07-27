import { describe, expect, it } from 'vitest'
import { TASK_AREA_KEYS, resolveTaskArea } from '../lib/taskAreas'

describe('resolveTaskArea', () => {
  it('defaults to In progress', () => {
    expect(resolveTaskArea({})).toBe('progress')
  })

  it('honours ?area=', () => {
    expect(resolveTaskArea({ areaParam: 'repeating' })).toBe('repeating')
    expect(resolveTaskArea({ areaParam: 'standard' })).toBe('standard')
  })

  it('ignores a nonsense ?area= rather than showing nothing', () => {
    expect(resolveTaskArea({ areaParam: 'nope' })).toBe('progress')
    expect(resolveTaskArea({ areaParam: '' })).toBe('progress')
  })

  /**
   * The silent-breakage case. RepeatingTasksManager is not mounted unless its
   * tab is open, so if a ?focusTemplate= link didn't switch the area, the Plans
   * page's "set up checklists" card would look like a dead button.
   */
  it('a ?focusTemplate= deep link opens Repeating, even from another area', () => {
    expect(resolveTaskArea({ focusTemplate: 'tpl-1' })).toBe('repeating')
    expect(resolveTaskArea({ areaParam: 'standard', focusTemplate: 'tpl-1' })).toBe('repeating')
  })

  it('a ?focus= deep link opens In progress, even from another area', () => {
    expect(resolveTaskArea({ focusChecklist: 'chk-1' })).toBe('progress')
    expect(resolveTaskArea({ areaParam: 'repeating', focusChecklist: 'chk-1' })).toBe('progress')
  })

  it('a focused template outranks a focused checklist', () => {
    // Both present is not expected, but it must resolve deterministically
    // rather than depending on param order.
    expect(resolveTaskArea({ focusChecklist: 'chk-1', focusTemplate: 'tpl-1' })).toBe(
      'repeating',
    )
  })

  it('always returns a real area', () => {
    const cases = [
      {},
      { areaParam: 'garbage' },
      { areaParam: null, focusChecklist: null, focusTemplate: null },
      { focusTemplate: 'x' },
      { focusChecklist: 'y' },
    ]
    for (const input of cases) {
      expect(TASK_AREA_KEYS).toContain(resolveTaskArea(input))
    }
  })
})
