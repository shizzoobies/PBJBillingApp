/**
 * Regression tests for `sanitizeClientPlanRefs` — the guard that runs inside
 * `appDataStore.write()` before inserting clients.
 *
 * The outage being pinned down (2026-06-16): a subscription plan was deleted
 * while a client still listed it in `plan_ids[]`. That array column has NO
 * foreign key, so the stale id lingered. On write the scalar `plan_id` is
 * re-derived from `planIds[0]`, so the dangling id hit the `clients.plan_id`
 * FK and aborted the ENTIRE bulk write — every `/api/app-data` read 500-ed and
 * the whole app showed "offline / everything gone" for every user.
 *
 * Post-fix expectation: any plan id not present in the payload's plans is
 * stripped from both the scalar `planId` and the `planIds` array, mirroring the
 * FK's `on delete set null` intent. One orphan can never wedge the write again.
 */
// @ts-expect-error - plain-JS module without type declarations
import { sanitizeClientPlanRefs } from '../../db/store.js'
import { describe, expect, it } from 'vitest'

describe('sanitizeClientPlanRefs', () => {
  const valid = new Set(['plan-keep'])

  it('strips a dangling plan id from planIds[] (the outage case)', () => {
    const result = sanitizeClientPlanRefs({ planIds: ['plan-gone'] }, valid)
    expect(result.planIds).toEqual([])
    // Scalar is derived from planIds[0]; a dangling one must NOT be emitted.
    expect(result.planId).toBeNull()
  })

  it('keeps valid plan ids and drops only the dangling ones', () => {
    const result = sanitizeClientPlanRefs({ planIds: ['plan-keep', 'plan-gone'] }, valid)
    expect(result.planIds).toEqual(['plan-keep'])
    expect(result.planId).toBe('plan-keep')
  })

  it('derives a valid scalar planId from the legacy field when planIds is empty', () => {
    const result = sanitizeClientPlanRefs({ planIds: [], planId: 'plan-keep' }, valid)
    expect(result.planId).toBe('plan-keep')
    expect(result.planIds).toEqual([])
  })

  it('nulls a dangling legacy planId', () => {
    const result = sanitizeClientPlanRefs({ planId: 'plan-gone' }, valid)
    expect(result.planId).toBeNull()
    expect(result.planIds).toEqual([])
  })

  it('handles a client with no plan references at all', () => {
    const result = sanitizeClientPlanRefs({}, valid)
    expect(result.planId).toBeNull()
    expect(result.planIds).toEqual([])
  })

  it('drops non-string / empty entries in planIds', () => {
    const result = sanitizeClientPlanRefs(
      { planIds: ['plan-keep', '', null, undefined, 5] },
      valid,
    )
    expect(result.planIds).toEqual(['plan-keep'])
  })

  it('emits an empty plan set when no plans exist in the payload', () => {
    const result = sanitizeClientPlanRefs({ planIds: ['plan-keep'] }, new Set())
    expect(result.planId).toBeNull()
    expect(result.planIds).toEqual([])
  })
})
