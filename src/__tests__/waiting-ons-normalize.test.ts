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

  /**
   * The hand-off fields. This normalizer is the single choke point BOTH backends
   * run through, so anything it silently drops is lost on Postgres too — and
   * production is Postgres while the tests are the file backend. Dropping these
   * would resurrect the exact bug Brittany reported: the name of whoever did the
   * check disappearing once the wait finished.
   */
  it('carries the hand-off stamps through the round-trip', () => {
    const input = {
      id: 'wo-handoff1',
      blockerId: 'emp-lisa',
      requestedBy: 'emp-brit',
      createdAt: '2026-08-07T10:00:00.000Z',
      resolvedAt: '2026-08-07T11:00:00.000Z',
      resolvedBy: 'emp-lisa',
      verifiedAt: '2026-08-07T12:00:00.000Z',
      verifiedBy: 'emp-brit',
    }
    expect((normalizeWaitingOns([input]) as Entry[])[0]).toEqual(input)
  })

  it('carries a client wait through the round-trip', () => {
    const out = normalizeWaitingOns([
      {
        id: 'wo-client1',
        blockerId: 'client-clover',
        blockerType: 'client',
        requestedBy: 'emp-brit',
        createdAt: '2026-08-07T10:00:00.000Z',
      },
    ]) as Array<Entry & { blockerType?: string }>
    expect(out[0].blockerType).toBe('client')
    expect(out[0].blockerId).toBe('client-clover')
  })

  it('never invents a stage that has not happened', () => {
    const out = normalizeWaitingOns([
      { blockerId: 'emp-lisa', requestedBy: 'emp-brit' },
    ]) as Array<Entry & Record<string, unknown>>
    expect(out[0].resolvedAt).toBeUndefined()
    expect(out[0].verifiedAt).toBeUndefined()
    // Absent, not 'employee' — an untouched entry must look exactly as it did
    // before this feature existed.
    expect(out[0].blockerType).toBeUndefined()
  })

  it('ignores junk in the stage fields rather than half-resolving an entry', () => {
    const out = normalizeWaitingOns([
      {
        blockerId: 'emp-lisa',
        requestedBy: 'emp-brit',
        blockerType: 'something-else',
        resolvedAt: 12345,
        verifiedBy: null,
      },
    ]) as Array<Entry & Record<string, unknown>>
    expect(out[0].blockerType).toBeUndefined()
    expect(out[0].resolvedAt).toBeUndefined()
    expect(out[0].verifiedBy).toBeUndefined()
  })
})
