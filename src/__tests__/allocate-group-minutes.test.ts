import { describe, expect, it } from 'vitest'
import { allocateGroupMinutes } from '../lib/utils'

/**
 * allocateGroupMinutes splits one block of "group time" across multiple
 * clients. The three modes give Brittany full flexibility: even split, the
 * full duration to each client, or a hand-set custom split.
 */
describe('allocateGroupMinutes', () => {
  it('splits evenly and the parts sum to exactly the total', () => {
    const result = allocateGroupMinutes(60, ['a', 'b', 'c'], 'even')
    expect(result).toEqual({ a: 20, b: 20, c: 20 })
    expect(Object.values(result).reduce((s, m) => s + m, 0)).toBe(60)
  })

  it('hands the remainder to the first clients so nothing is lost', () => {
    const result = allocateGroupMinutes(61, ['a', 'b', 'c'], 'even')
    // 61 / 3 = 20 r1 -> first client gets the extra minute
    expect(result).toEqual({ a: 21, b: 20, c: 20 })
    expect(Object.values(result).reduce((s, m) => s + m, 0)).toBe(61)
  })

  it('bills the full duration to each client in full mode', () => {
    const result = allocateGroupMinutes(45, ['a', 'b'], 'full')
    expect(result).toEqual({ a: 45, b: 45 })
  })

  it('uses the per-client custom minutes verbatim (rounded)', () => {
    const result = allocateGroupMinutes(
      120,
      ['a', 'b', 'c'],
      'custom',
      { a: 30, b: 45.4, c: 10 },
    )
    expect(result).toEqual({ a: 30, b: 45, c: 10 })
  })

  it('treats missing or non-positive custom values as 0', () => {
    const result = allocateGroupMinutes('x' as unknown as number, ['a', 'b'], 'custom', {
      a: -5,
    } as Record<string, number>)
    expect(result).toEqual({ a: 0, b: 0 })
  })

  it('ignores duplicate and empty client ids', () => {
    const result = allocateGroupMinutes(60, ['a', 'a', '', 'b'], 'even')
    expect(result).toEqual({ a: 30, b: 30 })
  })

  it('returns an empty map when there are no clients', () => {
    expect(allocateGroupMinutes(60, [], 'even')).toEqual({})
    expect(allocateGroupMinutes(60, [], 'full')).toEqual({})
  })

  it('handles a single client (gets the whole block in every mode)', () => {
    expect(allocateGroupMinutes(90, ['solo'], 'even')).toEqual({ solo: 90 })
    expect(allocateGroupMinutes(90, ['solo'], 'full')).toEqual({ solo: 90 })
    expect(allocateGroupMinutes(90, ['solo'], 'custom', { solo: 15 })).toEqual({ solo: 15 })
  })
})
