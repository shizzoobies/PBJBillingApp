import { describe, expect, it } from 'vitest'
import { allocateGroupMinutes, isGroupHoldingEntry } from '../lib/utils'

/**
 * allocateGroupMinutes splits one block of "group time" across multiple
 * clients. The three modes give Brittany full flexibility: even split, the
 * full duration to each client, or a hand-set custom split.
 *
 * The math lives in `lib/group-allocation.js` and runs on BOTH sides — the
 * server performs the split, the modal draws the preview — so these cases pin
 * the one shared contract. Everything works in whole SECONDS: entries are
 * seconds-precise, and rounding an allocation to whole minutes used to throw
 * away real tracked time.
 */
const sum = (result: Record<string, number>) =>
  Object.values(result).reduce((total, minutes) => total + minutes, 0)

/** Compare on the seconds grid — 14.55 min is 873s, not a float to eyeball. */
const seconds = (result: Record<string, number>) =>
  Object.fromEntries(Object.entries(result).map(([id, m]) => [id, Math.round(m * 60)]))

describe('allocateGroupMinutes', () => {
  it('splits evenly and the parts sum to exactly the total', () => {
    const result = allocateGroupMinutes(60, ['a', 'b', 'c'], 'even')
    expect(result).toEqual({ a: 20, b: 20, c: 20 })
    expect(sum(result)).toBe(60)
  })

  it('hands the remainder to the first clients so nothing is lost', () => {
    const result = allocateGroupMinutes(61, ['a', 'b', 'c'], 'even')
    // 61m = 3660s; 3660 / 3 = 1220s each, no remainder.
    expect(seconds(result)).toEqual({ a: 1220, b: 1220, c: 1220 })
    expect(sum(result)).toBeCloseTo(61, 10)
  })

  it('spreads leftover SECONDS, not minutes, so a fractional block is exact', () => {
    // 14.55 min = 873s. 873 / 4 = 218 r1 -> the first client gets one extra second.
    const result = allocateGroupMinutes(14.55, ['a', 'b', 'c', 'd'], 'even')
    expect(seconds(result)).toEqual({ a: 219, b: 218, c: 218, d: 218 })
    expect(Object.values(seconds(result)).reduce((t, s) => t + s, 0)).toBe(873)
  })

  it('is exact for a block that does not divide into whole minutes', () => {
    // 48m 30s = 2910s across 3 clients = 970s each (16m 10s).
    const result = allocateGroupMinutes(48.5, ['a', 'b', 'c'], 'even')
    expect(seconds(result)).toEqual({ a: 970, b: 970, c: 970 })
  })

  it('never invents time: a sub-minute block still sums to itself', () => {
    // 45s = 0.75 min across 2 clients -> 23s + 22s.
    const result = allocateGroupMinutes(0.75, ['a', 'b'], 'even')
    expect(seconds(result)).toEqual({ a: 23, b: 22 })
  })

  it('bills the full duration to each client in full mode', () => {
    const result = allocateGroupMinutes(45, ['a', 'b'], 'full')
    expect(result).toEqual({ a: 45, b: 45 })
  })

  it('keeps the exact seconds in full mode (deliberately more than the block)', () => {
    const result = allocateGroupMinutes(14.55, ['a', 'b'], 'full')
    expect(seconds(result)).toEqual({ a: 873, b: 873 })
  })

  it('uses the per-client custom minutes, snapped to the second', () => {
    const result = allocateGroupMinutes(120, ['a', 'b', 'c'], 'custom', {
      a: 30,
      b: 45.5,
      c: 10,
    })
    expect(seconds(result)).toEqual({ a: 1800, b: 2730, c: 600 })
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

describe('isGroupHoldingEntry', () => {
  it('is true only for an unsplit group entry (no client, has members)', () => {
    expect(isGroupHoldingEntry({ clientId: '', groupClientIds: ['a', 'b'] })).toBe(true)
  })

  it('is false for an ordinary client entry', () => {
    expect(isGroupHoldingEntry({ clientId: 'client-1' })).toBe(false)
  })

  it('is false for administrative time', () => {
    expect(
      isGroupHoldingEntry({ clientId: '', isAdministrative: true, groupClientIds: [] }),
    ).toBe(false)
  })

  it('is false for an already-split per-client entry (has a client + no members)', () => {
    expect(isGroupHoldingEntry({ clientId: 'client-1', groupClientIds: [] })).toBe(false)
  })

  it('is false when there are no members', () => {
    expect(isGroupHoldingEntry({ clientId: '', groupClientIds: [] })).toBe(false)
  })
})
