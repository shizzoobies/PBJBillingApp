import { describe, expect, it } from 'vitest'
import {
  findBlockingWeek,
  listBlockingWeeks,
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
 *
 * The gate only applies to NEW work — an entry in the CURRENT week or later.
 * These cases all log into the current week (entryWeek === today's week); the
 * past-week backfill escape is pinned in its own block below.
 */
describe('findBlockingWeek', () => {
  const entryWeek = '2026-06-14'
  const today = entryWeek

  it('BLOCKS when a prior week with time is un-submitted (no submission row)', () => {
    expect(findBlockingWeek(entryWeek, ['2026-06-07'], [], undefined, today)).toEqual({
      weekStart: '2026-06-07',
      reason: 'unsubmitted',
    })
  })

  it('does not block when the prior week is submitted / pending approval', () => {
    expect(
      findBlockingWeek(
        entryWeek,
        ['2026-06-07'],
        [{ weekStart: '2026-06-07', status: 'pending' }],
        undefined,
        today,
      ),
    ).toBeNull()
  })

  it('does not block when the prior week is approved', () => {
    expect(
      findBlockingWeek(
        entryWeek,
        ['2026-06-07'],
        [{ weekStart: '2026-06-07', status: 'approved' }],
        undefined,
        today,
      ),
    ).toBeNull()
  })

  it('blocks on a rejected prior week and names it', () => {
    expect(
      findBlockingWeek(
        entryWeek,
        ['2026-06-07'],
        [{ weekStart: '2026-06-07', status: 'rejected' }],
        undefined,
        today,
      ),
    ).toEqual({ weekStart: '2026-06-07', reason: 'rejected' })
  })

  it('ignores a week that has no logged time (not a prior-with-time week)', () => {
    // Entry week itself has time but no prior weeks-with-time → nothing gates.
    expect(findBlockingWeek(entryWeek, ['2026-06-14'], [], undefined, today)).toBeNull()
  })

  it('ignores weeks that are the entry week or later (only prior weeks gate)', () => {
    expect(
      findBlockingWeek(entryWeek, ['2026-06-14', '2026-06-21'], [], undefined, today),
    ).toBeNull()
  })

  it('returns the earliest blocking prior week, skipping submitted ones', () => {
    // 05-24 submitted (clear) → 05-31 un-submitted (blocks first) → 06-07 rejected.
    expect(
      findBlockingWeek(
        entryWeek,
        ['2026-05-24', '2026-05-31', '2026-06-07'],
        [
          { weekStart: '2026-05-24', status: 'pending' },
          { weekStart: '2026-06-07', status: 'rejected' },
        ],
        undefined,
        today,
      ),
    ).toEqual({ weekStart: '2026-05-31', reason: 'unsubmitted' })
  })

  it('does not block when the user has no prior weeks with time', () => {
    expect(findBlockingWeek(entryWeek, [], [], undefined, today)).toBeNull()
  })

  it('does NOT block on an un-submitted prior week inside a LOCKED month', () => {
    // Lisa's real incident: time in the week of 2026-06-07 with no submission
    // row, but June (2026-06) is month-locked. A sealed month must never gate.
    expect(
      findBlockingWeek('2026-07-05', ['2026-06-07'], [], ['2026-06'], '2026-07-05'),
    ).toBeNull()
  })

  it('still blocks an un-submitted prior week when its month is NOT locked', () => {
    expect(
      findBlockingWeek('2026-07-05', ['2026-06-07'], [], ['2026-05'], '2026-07-05'),
    ).toEqual({ weekStart: '2026-06-07', reason: 'unsubmitted' })
  })
})

/**
 * The past-week escape (featreq-cf658ebd). The gate exists to force the weekly
 * submission cadence on NEW work; it must never stop someone from CATCHING UP.
 * An entry dated in a week that has already ended is a backfill — always
 * allowed, which is what editing an entry (PATCH, no weekly gate) has always
 * done. Only the month lock, checked separately by each route, can stop that.
 */
describe('findBlockingWeek — past-week backfill', () => {
  it('does NOT block a backfill into a past week, even with an older week un-submitted', () => {
    // THE case: it is 2026-06-28; the entry is dated back in the week of 06-07,
    // and the even older week of 05-31 was never submitted. Logging the
    // forgotten 06-07 hour must go through.
    expect(
      findBlockingWeek('2026-06-07', ['2026-05-31'], [], undefined, '2026-06-28'),
    ).toBeNull()
  })

  it('does NOT block a backfill into a REJECTED week itself', () => {
    // Fixing the very week that was sent back is the whole point of sending it
    // back — adding the missing entry to it can never be gated.
    expect(
      findBlockingWeek(
        '2026-06-14',
        ['2026-06-07', '2026-06-14'],
        [{ weekStart: '2026-06-14', status: 'rejected' }],
        undefined,
        '2026-06-28',
      ),
    ).toBeNull()
  })

  it('STILL blocks when the entry is in the current week (unchanged behavior)', () => {
    expect(
      findBlockingWeek('2026-06-28', ['2026-06-07'], [], undefined, '2026-06-28'),
    ).toEqual({ weekStart: '2026-06-07', reason: 'unsubmitted' })
  })

  it('STILL blocks an entry dated in a FUTURE week', () => {
    expect(
      findBlockingWeek('2026-07-12', ['2026-06-28'], [], undefined, '2026-06-28'),
    ).toEqual({ weekStart: '2026-06-28', reason: 'unsubmitted' })
  })

  it('throws when todayWeekStart is omitted or not a date, rather than gating blindly', () => {
    // Deliberately loud: a caller that forgets today's week would silently
    // re-block every past-week backfill.
    expect(() =>
      // @ts-expect-error todayWeekStart is required — omitting it must not compile.
      findBlockingWeek('2026-06-07', ['2026-05-31'], [], undefined),
    ).toThrow(/todayWeekStart/)
    expect(() =>
      findBlockingWeek('2026-06-07', ['2026-05-31'], [], undefined, 'today'),
    ).toThrow(/todayWeekStart/)
  })
})

/**
 * `listBlockingWeeks` is the plural form the server uses to name EVERY prior
 * week a bookkeeper must submit — so someone who skipped several weeks (e.g.
 * Allison: two un-submitted weeks plus a pending one) is told about all of them
 * at once instead of hitting the gate one week at a time. `findBlockingWeek`
 * returns only the earliest of this list.
 */
describe('listBlockingWeeks', () => {
  const entryWeek = '2026-06-28'
  const today = entryWeek

  it('lists every un-submitted prior week, oldest → newest, skipping submitted ones', () => {
    // Allison's real shape: 05-31 + 06-14 un-submitted, 06-21 pending (clear).
    expect(
      listBlockingWeeks(
        entryWeek,
        ['2026-05-31', '2026-06-14', '2026-06-21'],
        [{ weekStart: '2026-06-21', status: 'pending' }],
        undefined,
        today,
      ),
    ).toEqual([
      { weekStart: '2026-05-31', reason: 'unsubmitted' },
      { weekStart: '2026-06-14', reason: 'unsubmitted' },
    ])
  })

  it('returns an empty list when nothing blocks', () => {
    expect(
      listBlockingWeeks(
        entryWeek,
        ['2026-06-21'],
        [{ weekStart: '2026-06-21', status: 'pending' }],
        undefined,
        today,
      ),
    ).toEqual([])
  })

  it('names no blockers at all for a past-week backfill', () => {
    // The plural form has to agree with the gate: nothing to submit is reported
    // when the entry is a catch-up, so the 423 message can't name a week either.
    expect(
      listBlockingWeeks(
        '2026-06-07',
        ['2026-05-24', '2026-05-31'],
        [],
        undefined,
        today,
      ),
    ).toEqual([])
  })

  it('agrees with findBlockingWeek on the earliest blocker', () => {
    const prior = ['2026-05-31', '2026-06-14', '2026-06-21']
    const subs = [{ weekStart: '2026-06-14', status: 'rejected' as const }]
    expect(listBlockingWeeks(entryWeek, prior, subs, undefined, today)[0]).toEqual(
      findBlockingWeek(entryWeek, prior, subs, undefined, today),
    )
  })
})
