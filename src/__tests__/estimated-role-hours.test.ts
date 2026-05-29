/**
 * Unit tests for two pieces of pure logic added with the per-role estimated
 * hours + active-checklists work:
 *
 *   1. `normalizeClientProfile` legacy fallback — when all three new role-hour
 *      fields are absent but the deprecated `estimatedMonthlyHours` is set, the
 *      legacy value must surface as `estimatedBookkeeperHours` so existing
 *      clients' numbers aren't lost and the planned total isn't 0.
 *   2. `deriveChecklistStatus` — the rolled-up Done / Overdue / In progress /
 *      Not started label used by the client detail "Active checklists" panel.
 */
// @ts-expect-error - plain-JS module without type declarations
import { normalizeClientProfile } from '../../db/store.js'
import { describe, expect, it } from 'vitest'
import { deriveChecklistStatus } from '../lib/utils'

describe('normalizeClientProfile — estimated role hours legacy fallback', () => {
  it('surfaces legacy estimatedMonthlyHours as estimatedBookkeeperHours when all role fields absent', () => {
    const out = normalizeClientProfile({
      id: 'client-1',
      name: 'Acme',
      estimatedMonthlyHours: 12,
    })
    expect(out.estimatedBookkeeperHours).toBe(12)
    expect(out.estimatedAccountantHours).toBeUndefined()
    expect(out.estimatedCfoHours).toBeUndefined()
  })

  it('keeps explicit role hours and does NOT apply the legacy fallback', () => {
    const out = normalizeClientProfile({
      id: 'client-1',
      name: 'Acme',
      estimatedMonthlyHours: 99,
      estimatedBookkeeperHours: 5,
      estimatedAccountantHours: 2,
      estimatedCfoHours: 1,
    })
    expect(out.estimatedBookkeeperHours).toBe(5)
    expect(out.estimatedAccountantHours).toBe(2)
    expect(out.estimatedCfoHours).toBe(1)
  })

  it('does not invent hours when nothing is set', () => {
    const out = normalizeClientProfile({ id: 'client-1', name: 'Acme' })
    expect(out.estimatedBookkeeperHours).toBeUndefined()
    expect(out.estimatedAccountantHours).toBeUndefined()
    expect(out.estimatedCfoHours).toBeUndefined()
  })

  it('applies the fallback even when only one new role field is present (others still absent overall? no)', () => {
    // When ANY new role field is present the legacy value is ignored — the
    // owner has moved to the new model, so a 0/undefined accountant/cfo is a
    // deliberate value, not a missing one.
    const out = normalizeClientProfile({
      id: 'client-1',
      name: 'Acme',
      estimatedMonthlyHours: 99,
      estimatedAccountantHours: 3,
    })
    expect(out.estimatedBookkeeperHours).toBeUndefined()
    expect(out.estimatedAccountantHours).toBe(3)
  })
})

describe('deriveChecklistStatus', () => {
  const today = '2026-05-29'

  it('returns Done when every item is done', () => {
    const status = deriveChecklistStatus(
      { items: [{ done: true }, { done: true }], dueDate: '2026-01-01' },
      today,
    )
    expect(status).toBe('Done')
  })

  it('returns Overdue when not done and due date is before today', () => {
    const status = deriveChecklistStatus(
      { items: [{ done: true }, { done: false }], dueDate: '2026-05-28' },
      today,
    )
    expect(status).toBe('Overdue')
  })

  it('returns In progress when some done, not overdue', () => {
    const status = deriveChecklistStatus(
      { items: [{ done: true }, { done: false }], dueDate: '2026-06-30' },
      today,
    )
    expect(status).toBe('In progress')
  })

  it('returns Not started when nothing done and not overdue', () => {
    const status = deriveChecklistStatus(
      { items: [{ done: false }, { done: false }], dueDate: '2026-06-30' },
      today,
    )
    expect(status).toBe('Not started')
  })

  it('rolls up done via nested sub-items', () => {
    const status = deriveChecklistStatus(
      {
        items: [{ done: false, subItems: [{ done: true }, { done: true }] }],
        dueDate: '2026-01-01',
      },
      today,
    )
    expect(status).toBe('Done')
  })

  it('treats an empty checklist that is overdue as Overdue, not Done', () => {
    const status = deriveChecklistStatus({ items: [], dueDate: '2026-05-28' }, today)
    expect(status).toBe('Overdue')
  })
})
