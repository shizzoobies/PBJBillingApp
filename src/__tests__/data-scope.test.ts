import { describe, expect, it } from 'vitest'
// @ts-expect-error - plain-JS module without type declarations
import { isTemplateVisibleToScope, isTimeEntryVisibleToScope } from '../../lib/data-scope.js'

/**
 * `isTemplateVisibleToScope` is the server's per-template visibility rule for a
 * non-owner session (used inside `scopeAppDataForSession`). It must let team
 * members see the firm's client-agnostic standard blueprints AND the recurring
 * templates for clients they're assigned to — but never another client's
 * client-bound templates.
 */
describe('isTemplateVisibleToScope', () => {
  const allowed = new Set(['client-1', 'client-2'])

  it('shows a standard (client-agnostic) blueprint to every team member', () => {
    expect(isTemplateVisibleToScope({ isStandard: true, clientId: '' }, allowed)).toBe(true)
    // Standard blueprints show even with no assigned clients at all.
    expect(isTemplateVisibleToScope({ isStandard: true }, new Set())).toBe(true)
  })

  it('shows a client-bound template only for an assigned client', () => {
    expect(isTemplateVisibleToScope({ isStandard: false, clientId: 'client-1' }, allowed)).toBe(true)
  })

  it('hides a client-bound template for a client the member is NOT assigned to', () => {
    expect(isTemplateVisibleToScope({ isStandard: false, clientId: 'client-9' }, allowed)).toBe(false)
    // A non-standard template with no client is not visible either.
    expect(isTemplateVisibleToScope({ clientId: '' }, allowed)).toBe(false)
  })

  it('is safe for missing input', () => {
    expect(isTemplateVisibleToScope(null, allowed)).toBe(false)
    expect(isTemplateVisibleToScope({ clientId: 'client-1' }, undefined)).toBe(false)
  })
})

/**
 * `isTimeEntryVisibleToScope` decides which of their OWN time entries a
 * non-owner sees. Regression: the rule used to be
 * `isAdministrative || allowedClientIds.has(clientId)`, which silently dropped
 * unsplit GROUP holding entries — they have no single client (the members live
 * in `groupClientIds` until the block is split) and aren't administrative. The
 * bookkeeper couldn't see, edit or split their own tracked time, and an owner's
 * totals disagreed with theirs (15 entries vs 10 for the same day).
 */
describe('isTimeEntryVisibleToScope', () => {
  const me = 'emp-1'
  const allowed = new Set(['client-1', 'client-2'])
  const group = { employeeId: me, clientId: '', groupClientIds: ['client-9', 'client-8'] }

  it('shows an unsplit group holding entry to whoever tracked it', () => {
    expect(isTimeEntryVisibleToScope(group, me, allowed)).toBe(true)
    // True even when NONE of the member clients are ones they're assigned to —
    // it's their own tracked time, and only the member COUNT is ever surfaced.
    expect(isTimeEntryVisibleToScope(group, me, new Set())).toBe(true)
  })

  it('shows their own administrative and assigned-client entries', () => {
    expect(
      isTimeEntryVisibleToScope({ employeeId: me, isAdministrative: true, clientId: '' }, me, allowed),
    ).toBe(true)
    expect(isTimeEntryVisibleToScope({ employeeId: me, clientId: 'client-1' }, me, allowed)).toBe(true)
  })

  it("hides another person's entries entirely, group time included", () => {
    expect(isTimeEntryVisibleToScope({ ...group, employeeId: 'emp-2' }, me, allowed)).toBe(false)
    expect(
      isTimeEntryVisibleToScope({ employeeId: 'emp-2', clientId: 'client-1' }, me, allowed),
    ).toBe(false)
  })

  it('hides their entry for a client they are not assigned to', () => {
    expect(isTimeEntryVisibleToScope({ employeeId: me, clientId: 'client-9' }, me, allowed)).toBe(false)
  })

  it('does not treat an empty group list as a group entry', () => {
    expect(
      isTimeEntryVisibleToScope({ employeeId: me, clientId: '', groupClientIds: [] }, me, allowed),
    ).toBe(false)
  })

  it('is safe for missing input', () => {
    expect(isTimeEntryVisibleToScope(null, me, allowed)).toBe(false)
    expect(isTimeEntryVisibleToScope({ employeeId: me, clientId: 'client-1' }, me, undefined)).toBe(
      false,
    )
  })
})
