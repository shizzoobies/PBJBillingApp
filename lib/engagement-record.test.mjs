import { describe, expect, it } from 'vitest'

import { engagementIsPureRecord } from './engagement-record.js'

/**
 * A PURE RECORD is an amendment that brings nothing to the client: signing one records
 * the signature only, and the sign dialog warns on every amendment that is NOT one
 * (keeping it in force does not bring back its fee or plans).
 */
const pure = { kind: 'amendment', figures: {}, planIds: [], packageId: null, retainerAmount: null, feeMode: 'keep' }

describe('engagementIsPureRecord', () => {
  it('is true for an amendment with no figures, lines, plans, package or retainer and its fee kept', () => {
    expect(engagementIsPureRecord(pure)).toBe(true)
    expect(engagementIsPureRecord({ ...pure, figures: { totals: { monthly: 0, annual: 0 }, lines: [] } })).toBe(true)
  })

  it('is false for anything that carries money, lines, plans, a package or a retainer, or does not keep the fee', () => {
    expect(engagementIsPureRecord({ ...pure, figures: { totals: { monthly: 150 } } })).toBe(false)
    expect(engagementIsPureRecord({ ...pure, figures: { lines: [{ name: 'x' }] } })).toBe(false)
    expect(engagementIsPureRecord({ ...pure, planIds: ['plan-1'] })).toBe(false)
    expect(engagementIsPureRecord({ ...pure, packageId: 'pkg-1' })).toBe(false)
    expect(engagementIsPureRecord({ ...pure, retainerAmount: 500 })).toBe(false)
    expect(engagementIsPureRecord({ ...pure, feeMode: 'add' })).toBe(false)
    expect(engagementIsPureRecord({ ...pure, feeMode: undefined })).toBe(false)
  })

  it('is false for a letter that is not an amendment, and for nothing', () => {
    expect(engagementIsPureRecord({ ...pure, kind: 'original' })).toBe(false)
    expect(engagementIsPureRecord({ ...pure, kind: 'superseding' })).toBe(false)
    expect(engagementIsPureRecord(null)).toBe(false)
    expect(engagementIsPureRecord(undefined)).toBe(false)
  })
})
