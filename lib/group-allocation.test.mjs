import { describe, expect, it } from 'vitest'
import {
  minutesToSeconds,
  sliceMinutesAfterSessionEdit,
  splitClientOptions,
  splitGroupPrefill,
} from './group-allocation.js'

/**
 * The pure rules behind "adjust a split": what the modal reopens with, and what
 * an ordinary edit does to a slice's minutes.
 *
 * Both live here rather than in the component because they are the parts that
 * can silently go wrong with the UI still looking right — a prefill that loses
 * a client, or a minutes rule that quietly restores the full block.
 */

const seconds = (minutes) => minutesToSeconds(minutes)

describe('splitGroupPrefill', () => {
  const slices = [
    { clientId: 'c1', minutes: 20, groupAllocation: 'custom' },
    { clientId: 'c2', minutes: 25.5, groupAllocation: 'custom' },
    { clientId: 'c3', minutes: 15, groupAllocation: 'custom' },
  ]

  it('reopens with the split’s own clients, amounts and mode', () => {
    const prefill = splitGroupPrefill(slices)
    expect(prefill.clientIds).toEqual(['c1', 'c2', 'c3'])
    expect(prefill.customMinutes).toEqual({ c1: '20', c2: '25.5', c3: '15' })
    expect(prefill.mode).toBe('custom')
    expect(prefill.totalMinutes).toBe(60.5)
  })

  it('divides the SUM for even/custom — that is the block those parts came from', () => {
    expect(splitGroupPrefill(slices).blockMinutes).toBe(60.5)
    expect(
      splitGroupPrefill([
        { clientId: 'c1', minutes: 24.25, groupAllocation: 'even' },
        { clientId: 'c2', minutes: 24.25, groupAllocation: 'even' },
      ]).blockMinutes,
    ).toBe(48.5)
  })

  it('divides ONE slice for a full split — each client was billed the whole block', () => {
    // 'full' bills every client the entire block, so the sum is a multiple of
    // it. Reopening on the sum would triple the block on the next save.
    const prefill = splitGroupPrefill([
      { clientId: 'c1', minutes: 30, groupAllocation: 'full' },
      { clientId: 'c2', minutes: 30, groupAllocation: 'full' },
      { clientId: 'c3', minutes: 30, groupAllocation: 'full' },
    ])
    expect(prefill.blockMinutes).toBe(30)
    expect(prefill.totalMinutes).toBe(90)
  })

  it('falls back to custom when no mode was stored, so nothing is recomputed', () => {
    // Group time logged straight from the manual form shares a group id but has
    // no allocation mode; the exact amounts are the only safe thing to show.
    const prefill = splitGroupPrefill([
      { clientId: 'c1', minutes: 12 },
      { clientId: 'c2', minutes: 8 },
    ])
    expect(prefill.mode).toBe('custom')
    expect(prefill.customMinutes).toEqual({ c1: '12', c2: '8' })
  })

  it('keeps sub-minute amounts exact and folds a repeated client', () => {
    const prefill = splitGroupPrefill([
      { clientId: 'c1', minutes: 0.75, groupAllocation: 'custom' },
      { clientId: 'c1', minutes: 0.5, groupAllocation: 'custom' },
    ])
    expect(prefill.clientIds).toEqual(['c1'])
    expect(seconds(Number(prefill.customMinutes.c1))).toBe(75)
  })

  it('is empty for no slices — the modal then has nothing to adjust', () => {
    expect(splitGroupPrefill([]).clientIds).toEqual([])
    expect(splitGroupPrefill(undefined).totalMinutes).toBe(0)
  })
})

describe('splitClientOptions with an existing split’s clients', () => {
  const clients = [
    { id: 'c3', name: 'Zeta' },
    { id: 'c1', name: 'Acme' },
    { id: 'c2', name: 'Globex' },
  ]

  it('pins every client already in the split to the front, in order', () => {
    expect(splitClientOptions(clients, ['c2', 'c3']).map((option) => option.id)).toEqual([
      'c2',
      'c3',
      'c1',
    ])
  })

  it('still takes a single id, and ignores unknown ones', () => {
    expect(splitClientOptions(clients, 'c3').map((option) => option.id)).toEqual([
      'c3',
      'c1',
      'c2',
    ])
    expect(splitClientOptions(clients, ['nope']).map((option) => option.id)).toEqual([
      'c1',
      'c2',
      'c3',
    ])
  })
})

describe('sliceMinutesAfterSessionEdit', () => {
  const SESSIONS = [
    { startAt: '2026-07-01T14:00:00.000Z', endAt: '2026-07-01T14:30:00.000Z' },
    { startAt: '2026-07-01T15:00:00.000Z', endAt: '2026-07-01T15:30:00.000Z' },
  ]

  it('leaves the allocation ALONE when the clock did not change', () => {
    // The whole defect: a slice carries the 60-minute block's sessions but only
    // its own 20 minutes. Saving a description edit used to make it 60 again.
    expect(sliceMinutesAfterSessionEdit(20, SESSIONS, SESSIONS)).toBe(20)
  })

  it('moves the allocation by the time actually added', () => {
    const withMore = [
      ...SESSIONS,
      { startAt: '2026-07-01T16:00:00.000Z', endAt: '2026-07-01T16:15:00.000Z' },
    ]
    expect(sliceMinutesAfterSessionEdit(20, SESSIONS, withMore)).toBe(35)
  })

  it('moves it down when time is taken off, on the seconds grid', () => {
    const shorter = [
      SESSIONS[0],
      { startAt: '2026-07-01T15:00:00.000Z', endAt: '2026-07-01T15:29:30.000Z' },
    ]
    expect(seconds(sliceMinutesAfterSessionEdit(20, SESSIONS, shorter))).toBe(seconds(20) - 30)
  })

  it('falls back to the sessions total when there is nothing to diff against', () => {
    expect(sliceMinutesAfterSessionEdit(20, [], SESSIONS)).toBe(60)
  })

  it('falls back rather than leaving a slice at zero or below', () => {
    const tiny = [{ startAt: '2026-07-01T14:00:00.000Z', endAt: '2026-07-01T14:01:00.000Z' }]
    // 5 + (1 - 60) would be negative; the clock time is the only sane answer.
    expect(sliceMinutesAfterSessionEdit(5, SESSIONS, tiny)).toBe(1)
  })
})
