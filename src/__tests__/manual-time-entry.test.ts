import { describe, expect, it } from 'vitest'
import {
  findBlockingWeek,
  normalizeTimeEntryMethod,
} from '../../lib/time-entry.js'

/**
 * `normalizeTimeEntryMethod` is the shared gate the server runs on every
 * `POST /api/time-entries` payload. These assertions pin the manual-entry
 * contract: a manual entry needs a reason, a timer entry never carries one.
 */

describe('normalizeTimeEntryMethod', () => {
  it('rejects a manual entry with no reason', () => {
    const result = normalizeTimeEntryMethod({ entryMethod: 'manual' })
    expect(result.error).toBeTruthy()
    expect(result.entryMethod).toBe('manual')
    expect(result.manualReason).toBeUndefined()
  })

  it('rejects a manual entry whose reason is only whitespace', () => {
    const result = normalizeTimeEntryMethod({
      entryMethod: 'manual',
      manualReason: '   ',
    })
    expect(result.error).toBeTruthy()
  })

  it('accepts a manual entry with a reason and reports entryMethod manual', () => {
    const result = normalizeTimeEntryMethod({
      entryMethod: 'manual',
      manualReason: '  Forgot to start the timer  ',
    })
    expect(result.error).toBeNull()
    expect(result.entryMethod).toBe('manual')
    // The reason is trimmed before it is persisted.
    expect(result.manualReason).toBe('Forgot to start the timer')
  })

  it('defaults to a timer entry when entryMethod is absent', () => {
    const result = normalizeTimeEntryMethod({})
    expect(result.error).toBeNull()
    expect(result.entryMethod).toBe('timer')
    expect(result.manualReason).toBeUndefined()
  })

  it('drops manualReason for a timer entry even if one was supplied', () => {
    const result = normalizeTimeEntryMethod({
      entryMethod: 'timer',
      manualReason: 'should be ignored',
    })
    expect(result.error).toBeNull()
    expect(result.entryMethod).toBe('timer')
    expect(result.manualReason).toBeUndefined()
  })
})

/**
 * `findBlockingWeek` is the weekly-submission gate. A non-owner must SUBMIT (or
 * resubmit) a prior week with time before logging a later week: an UN-SUBMITTED
 * or REJECTED prior week blocks; a submitted/pending/approved one does not.
 */
describe('findBlockingWeek', () => {
  const entryWeek = '2026-06-14'

  it('BLOCKS when a prior week with time is un-submitted (no submission row)', () => {
    expect(findBlockingWeek(entryWeek, ['2026-06-07'], [])).toEqual({
      weekStart: '2026-06-07',
      reason: 'unsubmitted',
    })
  })

  it('does not block when the prior week is submitted / pending approval', () => {
    expect(
      findBlockingWeek(entryWeek, ['2026-06-07'], [{ weekStart: '2026-06-07', status: 'pending' }]),
    ).toBeNull()
  })

  it('does not block when the prior week is approved', () => {
    expect(
      findBlockingWeek(entryWeek, ['2026-06-07'], [{ weekStart: '2026-06-07', status: 'approved' }]),
    ).toBeNull()
  })

  it('blocks on a rejected prior week and names it', () => {
    expect(
      findBlockingWeek(entryWeek, ['2026-06-07'], [{ weekStart: '2026-06-07', status: 'rejected' }]),
    ).toEqual({ weekStart: '2026-06-07', reason: 'rejected' })
  })

  it('ignores a week that has no logged time (not a prior-with-time week)', () => {
    // Entry week itself has time but no prior weeks-with-time → nothing gates.
    expect(findBlockingWeek(entryWeek, ['2026-06-14'], [])).toBeNull()
  })

  it('ignores weeks that are the entry week or later (only prior weeks gate)', () => {
    expect(findBlockingWeek(entryWeek, ['2026-06-14', '2026-06-21'], [])).toBeNull()
  })

  it('returns the earliest blocking prior week, skipping submitted ones', () => {
    // 05-24 submitted (clear) → 05-31 un-submitted (blocks first) → 06-07 rejected.
    expect(
      findBlockingWeek(entryWeek, ['2026-05-24', '2026-05-31', '2026-06-07'], [
        { weekStart: '2026-05-24', status: 'pending' },
        { weekStart: '2026-06-07', status: 'rejected' },
      ]),
    ).toEqual({ weekStart: '2026-05-31', reason: 'unsubmitted' })
  })

  it('does not block when the user has no prior weeks with time', () => {
    expect(findBlockingWeek(entryWeek, [], [])).toBeNull()
  })
})
