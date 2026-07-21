import { describe, expect, it } from 'vitest'
// @ts-expect-error - plain-JS module without type declarations
import { coerceTimeEntryPatchValue } from '../../db/store.js'

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
