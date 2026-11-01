import { describe, expect, it } from 'vitest'
import { stableStringify } from './stable-json.js'
import { jsonbLike } from './test-support/jsonb-like.mjs'
import { editChangesWhatClientSees, invoiceContentChanged } from './invoice-sent-change.js'

describe('stableStringify', () => {
  it('ignores key order at every depth and keeps array order', () => {
    expect(stableStringify({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}')
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }))
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]))
  })
  it('handles scalars, null, undefined and dates like JSON.stringify', () => {
    for (const value of [null, 0, -1.5, true, false, 'text', [], {}, [null, 'a'], { a: undefined, b: 1 }, [undefined, 1]]) {
      expect(stableStringify(value)).toBe(JSON.stringify(value))
    }
    expect(stableStringify(undefined)).toBeUndefined()
    expect(stableStringify({ at: new Date('2026-11-01T00:00:00.000Z') })).toBe('{"at":"2026-11-01T00:00:00.000Z"}')
  })
})

describe('jsonbLike (test support) reorders keys the way Postgres jsonb stores them', () => {
  it('shorter keys first, then byte order', () => {
    expect(Object.keys(jsonbLike({ asOf: 1, openingCents: 2, display: 3, appliedCents: 4, heldCents: 5 }))).toEqual(['asOf', 'display', 'heldCents', 'appliedCents', 'openingCents'])
    expect(Object.keys(jsonbLike({ b: 1, B: 2, aa: 3 }))).toEqual(['B', 'b', 'aa'])
  })
})

describe('"changed since sent" is blind to jsonb key order (1969 Beach, 2026-11-01)', () => {
  const statement = { asOf: '2026-11-01T12:00:00.000Z', openingCents: 0, appliedCents: 0, closingCents: 0, reservedCents: 0, heldCents: 0, currentChargesCents: 15375, amountDueCents: 15375, display: 'detailed' }
  const offer = { requestId: 'req-1', number: 'ADV-2026-EC609CCC', requestedCents: 17000, receivedCents: 0, outstandingCents: 17000, forPeriod: null, optional: false, collection: 'invoice', collectionMethod: null, url: 'http://localhost/advance-pay/x', preparedAt: '2026-11-01', preparedBy: 'owner' }
  const prepared = { total: 153.75, blurb: '', lineItems: [
    { kind: 'hours', label: 'Bookkeeping Services', detail: '1.5 hrs x $102.50/hr', amount: 153.75, hours: 1.5, rate: 102.5 },
    { kind: 'advance_request', label: 'Pay in advance amount', detail: '', amount: 0, advanceOffer: offer, creditStatement: statement },
  ] }
  it('the same invoice re-read from jsonb is not a change', () => {
    expect(invoiceContentChanged(prepared, jsonbLike(prepared))).toBe(false)
    expect(editChangesWhatClientSees({ lineItems: { before: prepared.lineItems, after: jsonbLike(prepared.lineItems) } })).toBe(false)
  })
  it('a real change is still a change', () => {
    const moved = jsonbLike({ ...prepared, lineItems: [prepared.lineItems[0], { ...prepared.lineItems[1], advanceOffer: { ...offer, optional: true } }] })
    expect(invoiceContentChanged(prepared, moved)).toBe(true)
    const restated = jsonbLike({ ...prepared, lineItems: [prepared.lineItems[0], { ...prepared.lineItems[1], creditStatement: { ...statement, openingCents: 100 } }] })
    expect(invoiceContentChanged(prepared, restated)).toBe(true)
  })
})
