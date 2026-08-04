import { describe, expect, it } from 'vitest'
import {
  allocateGroupMinutes,
  classifySplitTarget,
  isGroupHoldingEntry,
  splitClientOptions,
} from '../lib/utils'

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

/**
 * `classifySplitTarget` is the one rule the store, the split endpoint and the
 * modal share for "can this entry be split, and where do its target clients
 * come from?". Any client-billed entry qualifies now — the group timer is no
 * longer the only way in.
 */
describe('classifySplitTarget', () => {
  it('calls an unsplit group block a holding entry', () => {
    expect(classifySplitTarget({ clientId: '', groupClientIds: ['a', 'b'] })).toBe('holding')
  })

  it('calls an ordinary client entry regular', () => {
    expect(classifySplitTarget({ clientId: 'client-1' })).toBe('regular')
  })

  it('calls a slice from an earlier split regular — its minutes are just minutes', () => {
    expect(classifySplitTarget({ clientId: 'client-1', groupClientIds: [] })).toBe('regular')
  })

  it('calls administrative time administrative, even with members attached', () => {
    expect(
      classifySplitTarget({ clientId: '', isAdministrative: true, groupClientIds: ['a'] }),
    ).toBe('administrative')
  })

  it('calls an entry with no client and no members unsplittable', () => {
    expect(classifySplitTarget({ clientId: '', groupClientIds: [] })).toBe('unsplittable')
  })
})

/**
 * `splitClientOptions` assembles the checkbox list a regular-entry split opens
 * with. Alphabetical, except the entry's CURRENT client is pulled to the front
 * so the client being split away from is never buried in a long list.
 */
describe('splitClientOptions', () => {
  const clients = [
    { id: 'c3', name: 'Zenith' },
    { id: 'c1', name: 'Acme' },
    { id: 'c2', name: 'Globex' },
  ]

  it('sorts by name and puts the current client first', () => {
    expect(splitClientOptions(clients, 'c2').map((option) => option.id)).toEqual(['c2', 'c1', 'c3'])
  })

  it('is plain alphabetical when the current client is not in the list', () => {
    expect(splitClientOptions(clients, 'missing').map((option) => option.id)).toEqual([
      'c1',
      'c2',
      'c3',
    ])
  })

  it('leaves an already-first current client where it is', () => {
    expect(splitClientOptions(clients, 'c1').map((option) => option.id)).toEqual(['c1', 'c2', 'c3'])
  })

  it('drops duplicates and id-less rows', () => {
    const messy = [...clients, { id: 'c1', name: 'Acme (dupe)' }, { id: '', name: 'Nameless' }]
    expect(splitClientOptions(messy, 'c1')).toEqual([
      { id: 'c1', name: 'Acme' },
      { id: 'c2', name: 'Globex' },
      { id: 'c3', name: 'Zenith' },
    ])
  })

  it('handles an empty list', () => {
    expect(splitClientOptions([], 'c1')).toEqual([])
  })
})
