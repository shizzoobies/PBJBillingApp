import { describe, expect, it } from 'vitest'
// @ts-expect-error - plain-JS module without type declarations
import { coerceEntryMinutes, coerceTimeEntryPatchValue } from '../../db/store.js'

/**
 * Regression: editing a time entry can now change its client, including
 * switching it to administrative time (which clears the client). Postgres'
 * `time_entries.client_id` FK rejects '' — an empty client MUST persist as NULL,
 * exactly like the create path's `clientId || null`. This was caught by a
 * rolled-back production write that failed with
 * "violates foreign key constraint time_entries_client_id_fkey".
 */
describe('coerceTimeEntryPatchValue', () => {
  it('turns an empty clientId into NULL (administrative time)', () => {
    expect(coerceTimeEntryPatchValue('clientId', '')).toBeNull()
    expect(coerceTimeEntryPatchValue('clientId', undefined)).toBeNull()
  })

  it('keeps a real clientId untouched', () => {
    expect(coerceTimeEntryPatchValue('clientId', 'client-123')).toBe('client-123')
  })

  it('nulls the other optional reference/timestamp fields when empty', () => {
    for (const field of ['taskId', 'approvalNote', 'approvedBy', 'approvedAt', 'startAt', 'endAt']) {
      expect(coerceTimeEntryPatchValue(field, '')).toBeNull()
    }
  })

  it('leaves non-nullable fields alone, including falsy values', () => {
    // minutes/billable/description are plain columns — '' or false must survive
    // as-is rather than being turned into NULL.
    expect(coerceTimeEntryPatchValue('description', '')).toBe('')
    expect(coerceTimeEntryPatchValue('billable', false)).toBe(false)
    expect(coerceTimeEntryPatchValue('minutes', 0)).toBe(0)
    expect(coerceTimeEntryPatchValue('isAdministrative', false)).toBe(false)
  })
})

/**
 * `coerceEntryMinutes` is the ONE rule both write paths apply: the PATCH
 * /api/time-entries/:id minutes edit in server.js and `sanitizeAppData`'s
 * per-entry pass (which the owner-tab bulk save runs over every row). It used
 * to be `Math.round(...)` in both places, which destroyed the seconds-exact
 * duration that `normalizeWorkSessions` computes from an entry's `sessions`.
 */
describe('coerceEntryMinutes', () => {
  it('keeps a PATCHed fractional value second-precise', () => {
    // 14m 32s. Must survive as 872 seconds, not collapse to 15 minutes.
    expect(coerceEntryMinutes(14.533333333333333)).toBe(872 / 60)
    expect(coerceEntryMinutes(14.55)).toBe(14.55)
    expect(coerceEntryMinutes(0.75)).toBe(0.75) // 45s
  })

  it('accepts a numeric string (PATCH payloads may send one)', () => {
    expect(coerceEntryMinutes('14.55')).toBe(14.55)
  })

  it('snaps sub-second float noise to the nearest whole second', () => {
    expect(coerceEntryMinutes(30.0000004)).toBe(30)
    expect(coerceEntryMinutes(1 / 3)).toBe(20 / 60) // 20.0s
  })

  it('leaves whole minutes exactly whole', () => {
    expect(coerceEntryMinutes(135)).toBe(135)
    expect(coerceEntryMinutes(60)).toBe(60)
  })

  it('floors zero / negative / non-numeric at 1 minute (never drop an entry)', () => {
    expect(coerceEntryMinutes(0)).toBe(1)
    expect(coerceEntryMinutes(-30)).toBe(1)
    expect(coerceEntryMinutes(-0.5)).toBe(1)
    expect(coerceEntryMinutes('not-a-number')).toBe(1)
    expect(coerceEntryMinutes(null)).toBe(1)
    expect(coerceEntryMinutes(undefined)).toBe(1)
    expect(coerceEntryMinutes(Infinity)).toBe(1)
  })

  it('clamps values past the ceiling', () => {
    expect(coerceEntryMinutes(5_000_000)).toBe(100000)
    expect(coerceEntryMinutes(100000.5)).toBe(100000)
    expect(coerceEntryMinutes(100000)).toBe(100000)
  })
})
