import { describe, expect, it } from 'vitest'
import { arrayUnionAssignment } from './merge-client-sql.js'

describe('the merge-client array union (nullable package_ids)', () => {
  const sql = arrayUnionAssignment('package_ids', 'packages')

  it('keeps two nulls null instead of turning them into an empty list', () => {
    expect(sql).toMatch(/^package_ids = case when s\.package_ids is null and d\.package_ids is null then null/)
  })

  it('treats a null side as empty in the union and in the membership test', () => {
    expect(sql).toContain("coalesce(s.package_ids, '{}') || array(")
    expect(sql).toContain("unnest(coalesce(d.package_ids, '{}'))")
    expect(sql).toContain("not (e = any(coalesce(s.package_ids, '{}')))")
  })

  it('still only appends ids that exist in the validated table', () => {
    expect(sql).toContain('exists (select 1 from packages p where p.id = e)')
    expect(arrayUnionAssignment('plan_ids', 'subscription_plans')).toContain(
      'from subscription_plans p where p.id = e',
    )
  })
})
