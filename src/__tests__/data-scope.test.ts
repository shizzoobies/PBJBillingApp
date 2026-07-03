import { describe, expect, it } from 'vitest'
// @ts-expect-error - plain-JS module without type declarations
import { isTemplateVisibleToScope } from '../../lib/data-scope.js'

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
