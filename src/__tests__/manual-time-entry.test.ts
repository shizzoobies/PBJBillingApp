import { describe, expect, it } from 'vitest'
import {
  findBlockingRejectedWeek,
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
 * `findBlockingRejectedWeek` is the weekly-submission gate. Only a REJECTED
 * prior week (owner sent it back) blocks logging new time; un-submitted and
 * pending prior weeks never block.
 */
describe('findBlockingRejectedWeek', () => {
  const entryWeek = '2026-06-14'

  it('does not block when a prior week is un-submitted (no submission row)', () => {
    // This is the real-world case that was 423-ing staff: a prior week with
    // logged time but no submission.
    expect(findBlockingRejectedWeek(entryWeek, ['2026-06-07'], [])).toBeNull()
  })

  it('does not block when the prior week is still pending approval', () => {
    expect(
      findBlockingRejectedWeek(entryWeek, ['2026-06-07'], [
        { weekStart: '2026-06-07', status: 'pending' },
      ]),
    ).toBeNull()
  })

  it('does not block when the prior week is approved', () => {
    expect(
      findBlockingRejectedWeek(entryWeek, ['2026-06-07'], [
        { weekStart: '2026-06-07', status: 'approved' },
      ]),
    ).toBeNull()
  })

  it('blocks on a rejected prior week and names it', () => {
    expect(
      findBlockingRejectedWeek(entryWeek, ['2026-06-07'], [
        { weekStart: '2026-06-07', status: 'rejected' },
      ]),
    ).toBe('2026-06-07')
  })

  it('ignores a rejected week that has no logged time (not a prior-with-time week)', () => {
    expect(
      findBlockingRejectedWeek(entryWeek, ['2026-05-31'], [
        { weekStart: '2026-06-07', status: 'rejected' },
      ]),
    ).toBeNull()
  })

  it('ignores a rejected week that is the entry week or later (only prior weeks gate)', () => {
    expect(
      findBlockingRejectedWeek(entryWeek, ['2026-06-14', '2026-06-21'], [
        { weekStart: '2026-06-14', status: 'rejected' },
        { weekStart: '2026-06-21', status: 'rejected' },
      ]),
    ).toBeNull()
  })

  it('returns the earliest rejected prior week when several are rejected', () => {
    expect(
      findBlockingRejectedWeek(
        entryWeek,
        ['2026-05-24', '2026-05-31', '2026-06-07'],
        [
          { weekStart: '2026-06-07', status: 'rejected' },
          { weekStart: '2026-05-24', status: 'rejected' },
          { weekStart: '2026-05-31', status: 'pending' },
        ],
      ),
    ).toBe('2026-05-24')
  })

  it('does not block when the user has no prior weeks with time', () => {
    expect(findBlockingRejectedWeek(entryWeek, [], [])).toBeNull()
  })
})
