/**
 * Unit tests for `normalizeWaitingOns` — the pure guard that keeps structured
 * "waiting on a person" blockers intact across the JSONB / file round-trip on
 * every checklist node. It's the shared normalizer the item read-map, the
 * sub-item / sub-sub-item normalizers, and both inserts all run through, so
 * pinning it down pins down the persistence integrity of the whole feature:
 * valid entries survive, malformed ones are dropped, and ids / createdAt are
 * always present.
 *
 * Import target is `../../db/store.js` (plain JS) which vitest resolves
 * directly; the helper takes plain objects so we never touch pg.
 */
// @ts-expect-error - plain-JS module without type declarations
import { normalizeWaitingOns } from '../../db/store.js'
import { describe, expect, it } from 'vitest'

type Entry = {
  id: string
  blockerId: string
  requestedBy: string
  note?: string
  createdAt: string
}

describe('normalizeWaitingOns', () => {
  it('defaults a non-array to []', () => {
    expect(normalizeWaitingOns(undefined)).toEqual([])
    expect(normalizeWaitingOns(null)).toEqual([])
    expect(normalizeWaitingOns('nope')).toEqual([])
  })

  it('keeps a valid entry and its fields verbatim', () => {
    const input = [
      {
        id: 'wo-abcd1234',
        blockerId: 'emp-brit',
        requestedBy: 'emp-avery',
        note: 'need the Q2 file',
        createdAt: '2026-07-01T10:00:00.000Z',
      },
    ]
    const out = normalizeWaitingOns(input) as Entry[]
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual(input[0])
  })

  it('drops entries missing a blockerId or requestedBy', () => {
    const out = normalizeWaitingOns([
      { id: 'wo-1', requestedBy: 'emp-avery', createdAt: '2026-07-01T00:00:00.000Z' },
      { id: 'wo-2', blockerId: 'emp-brit', createdAt: '2026-07-01T00:00:00.000Z' },
      { blockerId: '', requestedBy: '', createdAt: '2026-07-01T00:00:00.000Z' },
    ]) as Entry[]
    expect(out).toEqual([])
  })

  it('fills a missing id and createdAt, and trims/omits a blank note', () => {
    const out = normalizeWaitingOns([
      { blockerId: 'emp-brit', requestedBy: 'emp-avery', note: '   ' },
    ]) as Entry[]
    expect(out).toHaveLength(1)
    expect(out[0].id).toMatch(/^wo-/)
    expect(typeof out[0].createdAt).toBe('string')
    expect(out[0].createdAt.length).toBeGreaterThan(0)
    expect(out[0].note).toBeUndefined()
  })
})
