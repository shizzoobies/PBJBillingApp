/**
 * Unit tests for `lib/recurring-gate.js` — the shared "will this recurring
 * checklist ever generate?" verdict.
 *
 * The gate is read by the To-100% detector and the assistant's
 * diagnose_recurring_checklist tool, while the three generators (the server
 * materializer, `ensureRecurringChecklists`, and the Board/Gantt projection)
 * apply the same rules inline. The one thing they MUST agree on is which
 * clients have stopped producing work, which is why `isInactiveClientStage` /
 * `inactiveClientIds` live here and not in each caller.
 */
import { describe, expect, it } from 'vitest'
import {
  evaluateRecurringTemplate,
  inactiveClientIds,
  isInactiveClientStage,
} from '../../lib/recurring-gate.js'

function makeTemplate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tpl-1',
    title: 'Monthly Close',
    clientId: 'client-1',
    active: true,
    frequency: 'monthly',
    nextDueDate: '2026-09-01',
    categoryId: 'cat-1',
    stages: [{ assigneeId: 'emp-1', items: [{ id: 'i1', label: 'Reconcile' }] }],
    ...overrides,
  }
}

describe('isInactiveClientStage', () => {
  it('recognizes only the retirement stage', () => {
    expect(isInactiveClientStage('inactive')).toBe(true)
    expect(isInactiveClientStage('active')).toBe(false)
    expect(isInactiveClientStage('proposal')).toBe(false)
    expect(isInactiveClientStage('onboarding')).toBe(false)
    // Absent has always meant 'active' — a client with no stage still works.
    expect(isInactiveClientStage(undefined)).toBe(false)
    expect(isInactiveClientStage(null)).toBe(false)
  })
})

describe('inactiveClientIds', () => {
  it('collects exactly the retired clients', () => {
    const ids = inactiveClientIds([
      { id: 'c1' },
      { id: 'c2', lifecycleStage: 'active' },
      { id: 'c3', lifecycleStage: 'proposal' },
      { id: 'c4', lifecycleStage: 'inactive' },
      { id: 'c5', lifecycleStage: 'inactive' },
    ])
    expect([...ids].sort()).toEqual(['c4', 'c5'])
  })

  it('is empty-safe and skips malformed records', () => {
    expect(inactiveClientIds().size).toBe(0)
    expect(inactiveClientIds([]).size).toBe(0)
    expect(inactiveClientIds([null, { lifecycleStage: 'inactive' }] as never).size).toBe(0)
  })
})

describe('evaluateRecurringTemplate — retired clients', () => {
  it('refuses a healthy template whose client has been retired', () => {
    const verdict = evaluateRecurringTemplate(makeTemplate(), { clientStage: 'inactive' })
    expect(verdict.reason).toBe('inactive-client')
    expect(verdict.skipped).toBe(false)
  })

  it('still generates for every non-retired stage', () => {
    for (const clientStage of ['active', 'proposal', 'onboarding', undefined]) {
      expect(evaluateRecurringTemplate(makeTemplate(), { clientStage }).reason).toBeNull()
    }
  })

  it('reports the retired client ahead of the template being switched off', () => {
    // Both are true. Saying "turn the template back on" would send someone to
    // flip a switch that changes nothing while the client is retired.
    const verdict = evaluateRecurringTemplate(makeTemplate({ active: false }), {
      clientStage: 'inactive',
    })
    expect(verdict.reason).toBe('inactive-client')
  })

  it('still reports a missing client first — there is no stage to look up', () => {
    const verdict = evaluateRecurringTemplate(makeTemplate({ clientId: '' }), {
      clientStage: 'inactive',
    })
    expect(verdict.reason).toBe('no-client')
  })

  it('leaves standard blueprints alone — they never belong to a client', () => {
    const verdict = evaluateRecurringTemplate(
      makeTemplate({ isStandard: true, clientId: undefined }),
      { clientStage: 'inactive' },
    )
    expect(verdict).toEqual({ skipped: true, reason: null, warnings: [] })
  })

  it('reactivating the client makes the same template generate again', () => {
    const template = makeTemplate()
    expect(evaluateRecurringTemplate(template, { clientStage: 'inactive' }).reason).toBe(
      'inactive-client',
    )
    expect(evaluateRecurringTemplate(template, { clientStage: 'active' }).reason).toBeNull()
  })
})
