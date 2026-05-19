import { describe, expect, it } from 'vitest'
import { normalizeTimeEntryMethod } from '../../lib/time-entry.js'

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
