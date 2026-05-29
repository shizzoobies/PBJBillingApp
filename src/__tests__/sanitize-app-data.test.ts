/**
 * Unit tests for `sanitizeAppData` — the defensive, NON-REJECTING normalizer
 * that runs at the top of `appDataStore.write()` (security items L1/L2).
 *
 * The overriding contract under test: a normal save's values pass through
 * UNCHANGED, while clearly-bad data (negative/huge numbers, invalid dates,
 * non-object records, missing arrays) is clamped/dropped IN PLACE so a single
 * bad value can never reject the whole save or persist unparseable garbage.
 */
// @ts-expect-error - plain-JS module without type declarations
import { sanitizeAppData } from '../../db/store.js'
import { describe, expect, it } from 'vitest'

describe('sanitizeAppData — number clamping', () => {
  it('clamps negative client money/hours fields to 0', () => {
    const data = {
      clients: [
        {
          id: 'client-1',
          name: 'Acme',
          hourlyRate: -50,
          monthlyRate: -1,
          estimatedMonthlyHours: -8,
        },
      ],
    }
    const cleaned = sanitizeAppData(data)
    expect(cleaned.clients[0].hourlyRate).toBe(0)
    expect(cleaned.clients[0].monthlyRate).toBe(0)
    expect(cleaned.clients[0].estimatedMonthlyHours).toBe(0)
  })

  it('caps absurdly huge numbers at the sane max (1e9)', () => {
    const data = {
      clients: [{ id: 'client-1', name: 'Acme', hourlyRate: 1e15 }],
      reimbursements: [{ id: 'r-1', clientId: 'client-1', amount: 9e20 }],
    }
    const cleaned = sanitizeAppData(data)
    expect(cleaned.clients[0].hourlyRate).toBe(1e9)
    expect(cleaned.reimbursements[0].amount).toBe(1e9)
  })

  it('coerces non-finite / non-numeric money to 0', () => {
    const data = {
      clients: [{ id: 'client-1', name: 'Acme', hourlyRate: 'not-a-number' }],
      recurringReimbursements: [
        { id: 'rr-1', clientId: 'client-1', amount: Infinity },
      ],
    }
    const cleaned = sanitizeAppData(data)
    expect(cleaned.clients[0].hourlyRate).toBe(0)
    expect(cleaned.recurringReimbursements[0].amount).toBe(0)
  })

  it('coerces numeric strings to real numbers (normal save passthrough)', () => {
    const data = {
      reimbursements: [{ id: 'r-1', clientId: 'client-1', amount: '125.50' }],
    }
    const cleaned = sanitizeAppData(data)
    expect(cleaned.reimbursements[0].amount).toBe(125.5)
  })
})

describe('sanitizeAppData — time entry minutes', () => {
  it('clamps <= 0 minutes to a 1-minute floor (never drops a logged entry)', () => {
    const data = {
      timeEntries: [
        { id: 't-1', clientId: 'client-1', minutes: 0, date: '2026-04-29' },
        { id: 't-2', clientId: 'client-1', minutes: -30, date: '2026-04-29' },
      ],
    }
    const cleaned = sanitizeAppData(data)
    expect(cleaned.timeEntries[0].minutes).toBe(1)
    expect(cleaned.timeEntries[1].minutes).toBe(1)
  })

  it('rounds fractional minutes to an integer and caps the ceiling', () => {
    const data = {
      timeEntries: [
        { id: 't-1', clientId: 'client-1', minutes: 90.7, date: '2026-04-29' },
        { id: 't-2', clientId: 'client-1', minutes: 5_000_000, date: '2026-04-29' },
      ],
    }
    const cleaned = sanitizeAppData(data)
    expect(cleaned.timeEntries[0].minutes).toBe(91)
    expect(cleaned.timeEntries[1].minutes).toBe(100000)
  })

  it('leaves a normal minutes value untouched', () => {
    const data = {
      timeEntries: [{ id: 't-1', clientId: 'client-1', minutes: 135, date: '2026-04-29' }],
    }
    const cleaned = sanitizeAppData(data)
    expect(cleaned.timeEntries[0].minutes).toBe(135)
  })
})

describe('sanitizeAppData — date dropping', () => {
  it('drops an invalid date field but keeps the rest of the record', () => {
    const data = {
      timeEntries: [
        { id: 't-1', clientId: 'client-1', minutes: 60, date: 'garbage' },
      ],
      reimbursements: [
        { id: 'r-1', clientId: 'client-1', amount: 10, date: '2026-13-40' },
      ],
    }
    const cleaned = sanitizeAppData(data)
    expect('date' in cleaned.timeEntries[0]).toBe(false)
    expect(cleaned.timeEntries[0].id).toBe('t-1')
    expect(cleaned.timeEntries[0].minutes).toBe(60)
    expect('date' in cleaned.reimbursements[0]).toBe(false)
  })

  it('drops an impossible calendar date (Feb 31) and an out-of-range year', () => {
    const data = {
      checklists: [{ id: 'cl-1', clientId: 'client-1', dueDate: '2026-02-31' }],
      checklistTemplates: [{ id: 'tpl-1', nextDueDate: '1899-06-01' }],
    }
    const cleaned = sanitizeAppData(data)
    expect('dueDate' in cleaned.checklists[0]).toBe(false)
    expect('nextDueDate' in cleaned.checklistTemplates[0]).toBe(false)
  })

  it('leaves a valid YYYY-MM-DD date exactly as-is', () => {
    const data = {
      timeEntries: [{ id: 't-1', clientId: 'client-1', minutes: 60, date: '2026-04-29' }],
      recurringReimbursements: [
        { id: 'rr-1', clientId: 'client-1', amount: 50, startDate: '2026-01-01' },
      ],
    }
    const cleaned = sanitizeAppData(data)
    expect(cleaned.timeEntries[0].date).toBe('2026-04-29')
    expect(cleaned.recurringReimbursements[0].startDate).toBe('2026-01-01')
  })

  it('leaves a missing/empty date alone (nothing to clean)', () => {
    const data = {
      timeEntries: [
        { id: 't-1', clientId: 'client-1', minutes: 60 },
        { id: 't-2', clientId: 'client-1', minutes: 60, date: '' },
      ],
    }
    const cleaned = sanitizeAppData(data)
    expect('date' in cleaned.timeEntries[0]).toBe(false)
    expect(cleaned.timeEntries[1].date).toBe('')
  })
})

describe('sanitizeAppData — array & record shape', () => {
  it('coerces a missing or non-array top-level field to []', () => {
    const data = { clients: undefined, timeEntries: 'oops' }
    const cleaned = sanitizeAppData(data)
    expect(Array.isArray(cleaned.clients)).toBe(true)
    expect(cleaned.clients).toHaveLength(0)
    expect(Array.isArray(cleaned.timeEntries)).toBe(true)
    expect(cleaned.timeEntries).toHaveLength(0)
  })

  it('skips records that are not objects or lack a string id', () => {
    const data = {
      clients: [
        { id: 'client-1', name: 'Keep me', hourlyRate: 100 },
        null,
        'not-an-object',
        { name: 'No id here' },
        { id: 42 },
      ],
    }
    const cleaned = sanitizeAppData(data)
    expect(cleaned.clients).toHaveLength(1)
    expect(cleaned.clients[0].id).toBe('client-1')
  })

  it('one bad record does not affect the good records around it', () => {
    const data = {
      timeEntries: [
        { id: 't-1', clientId: 'client-1', minutes: 60, date: '2026-04-29' },
        null,
        { id: 't-2', clientId: 'client-1', minutes: -5, date: 'bad' },
      ],
    }
    const cleaned = sanitizeAppData(data)
    expect(cleaned.timeEntries).toHaveLength(2)
    expect(cleaned.timeEntries[0].date).toBe('2026-04-29')
    expect(cleaned.timeEntries[1].minutes).toBe(1)
    expect('date' in cleaned.timeEntries[1]).toBe(false)
  })
})

describe('sanitizeAppData — normal save is left untouched', () => {
  it('passes a clean, realistic blob through with values intact', () => {
    const data = {
      employees: [{ id: 'emp-1', name: 'Avery', role: 'Accountant' }],
      clients: [
        {
          id: 'client-1',
          name: 'Clover Ridge Dental',
          hourlyRate: 145,
          monthlyRate: 1850,
          estimatedMonthlyHours: 6,
        },
      ],
      plans: [{ id: 'plan-1', name: 'Essentials', notes: '' }],
      contacts: [{ id: 'contact-1', name: 'Maya', email: 'maya@example.com' }],
      timeEntries: [
        { id: 't-1', clientId: 'client-1', minutes: 135, date: '2026-04-29' },
      ],
      reimbursements: [
        { id: 'r-1', clientId: 'client-1', amount: 42.5, date: '2026-04-29' },
      ],
      recurringReimbursements: [
        { id: 'rr-1', clientId: 'client-1', amount: 19.99, startDate: '2026-01-01' },
      ],
      checklists: [{ id: 'cl-1', clientId: 'client-1', dueDate: '2026-05-15' }],
      recycledChecklists: [],
      checklistTemplates: [{ id: 'tpl-1', nextDueDate: '2026-04-28' }],
    }
    // Deep clone for an unchanged-reference comparison.
    const expected = JSON.parse(JSON.stringify(data))
    const cleaned = sanitizeAppData(data)
    expect(cleaned).toEqual(expected)
  })

  it('returns the input as-is for non-object input (never throws)', () => {
    expect(sanitizeAppData(null)).toBeNull()
    expect(sanitizeAppData(undefined)).toBeUndefined()
  })
})
