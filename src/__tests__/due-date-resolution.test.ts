import { describe, expect, it } from 'vitest'
import { resolveStageDueDate, resolveNodeDueDate } from '../lib/utils'
import type { TemplateStage } from '../lib/types'

function makeStage(overrides: Partial<TemplateStage>): TemplateStage {
  return {
    id: 'stage-1',
    name: 'Stage 1',
    assigneeId: 'emp-1',
    offsetDays: 0,
    viewerIds: [],
    editorIds: [],
    items: [],
    ...overrides,
  }
}

describe('resolveStageDueDate', () => {
  it('uses a fixed dueDate when set (wins over everything)', () => {
    const stage = makeStage({
      dueDate: '2026-03-10',
      dueDayOfMonth: 20,
      offsetDays: 5,
    })
    expect(resolveStageDueDate(stage, '2026-07-15')).toBe('2026-03-10')
  })

  it('resolves dueDayOfMonth to the Nth of the baseDate month', () => {
    const stage = makeStage({ dueDayOfMonth: 15 })
    expect(resolveStageDueDate(stage, '2026-04-30')).toBe('2026-04-15')
  })

  it('clamps dueDayOfMonth to the month length (31 -> Feb 28 in a non-leap year)', () => {
    const stage = makeStage({ dueDayOfMonth: 31 })
    expect(resolveStageDueDate(stage, '2026-02-10')).toBe('2026-02-28')
  })

  it('clamps dueDayOfMonth to Feb 29 in a leap year', () => {
    const stage = makeStage({ dueDayOfMonth: 31 })
    expect(resolveStageDueDate(stage, '2024-02-10')).toBe('2024-02-29')
  })

  it('falls back to legacy offsetDays (days BEFORE the base) when no due spec', () => {
    const stage = makeStage({ offsetDays: 3 })
    expect(resolveStageDueDate(stage, '2026-05-10')).toBe('2026-05-07')
  })

  it('dueDayOfMonth wins over a legacy offsetDays', () => {
    const stage = makeStage({ dueDayOfMonth: 5, offsetDays: 10 })
    expect(resolveStageDueDate(stage, '2026-05-20')).toBe('2026-05-05')
  })

  it('returns the baseDate when there is no due spec and no offset', () => {
    const stage = makeStage({})
    expect(resolveStageDueDate(stage, '2026-06-30')).toBe('2026-06-30')
  })
})

describe('resolveNodeDueDate', () => {
  it('uses a fixed dueDate when set (wins over dueDayOfMonth)', () => {
    expect(resolveNodeDueDate({ dueDate: '2026-01-09', dueDayOfMonth: 20 }, 2026, 5)).toBe(
      '2026-01-09',
    )
  })

  it('resolves dueDayOfMonth into the given cycle year/month', () => {
    expect(resolveNodeDueDate({ dueDayOfMonth: 15 }, 2026, 4)).toBe('2026-04-15')
  })

  it('clamps dueDayOfMonth to the cycle month length (31 -> Feb 28)', () => {
    expect(resolveNodeDueDate({ dueDayOfMonth: 31 }, 2026, 2)).toBe('2026-02-28')
  })

  it('clamps dueDayOfMonth to Feb 29 in a leap year', () => {
    expect(resolveNodeDueDate({ dueDayOfMonth: 31 }, 2024, 2)).toBe('2024-02-29')
  })

  it('pads single-digit month/day', () => {
    expect(resolveNodeDueDate({ dueDayOfMonth: 3 }, 2026, 1)).toBe('2026-01-03')
  })

  it('returns undefined when the node has no due spec', () => {
    expect(resolveNodeDueDate({}, 2026, 5)).toBeUndefined()
  })
})
