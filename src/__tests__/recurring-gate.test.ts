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

// featreq-3e81b386: the Board column is set per step, with the recipe's as the
// default. Step 1 is what generates, so a recipe with no default whose Step 1
// names a column still lands somewhere - no warning.
describe('evaluateRecurringTemplate: stepWarnings for steps with no Board column', () => {
  const step = (name: string, categoryId?: string) => ({
    id: `st-${name}`,
    name,
    assigneeId: 'emp-1',
    ...(categoryId ? { categoryId } : {}),
    items: [{ id: `i-${name}`, label: name }],
  })

  it('one recipe step with no column and no recipe default -> one warning naming the step', () => {
    const verdict = evaluateRecurringTemplate(
      makeTemplate({ categoryId: null, stages: [step('Prep', 'cat-prep'), step('Review'), step('File', 'cat-file')] }),
    )
    expect(verdict.reason).toBeNull()
    expect(verdict.stepWarnings).toEqual([
      {
        step: 2,
        stageId: 'st-Review',
        name: 'Review',
        message: `Step 2 'Review' has no Board column - its tasks will land in "Uncategorized"`,
      },
    ])
  })

  it('an unnamed stage reads as the bare step number, not a quoted generated name', () => {
    const verdict = evaluateRecurringTemplate(
      makeTemplate({ categoryId: null, stages: [step('Stage 1'), step('')] }),
    )
    expect(verdict.stepWarnings?.map((warning) => warning.message)).toEqual([
      'Step 1 has no Board column - its tasks will land in "Uncategorized"',
      'Step 2 has no Board column - its tasks will land in "Uncategorized"',
    ])
  })

  it('every step named, or a recipe default column -> no step warnings', () => {
    const named = evaluateRecurringTemplate(
      makeTemplate({ categoryId: null, stages: [step('Prep', 'cat-a'), step('Review', 'cat-b')] }),
    )
    expect(named.stepWarnings).toEqual([])
    const defaulted = evaluateRecurringTemplate(makeTemplate({ stages: [step('Prep'), step('Review')] }))
    expect(defaulted.stepWarnings).toEqual([])
  })

  it('a recipe that will not generate carries none (it cannot land anywhere)', () => {
    const verdict = evaluateRecurringTemplate(makeTemplate({ categoryId: null, active: false, stages: [step('Prep')] }))
    expect(verdict.reason).toBe('inactive')
    expect(verdict.stepWarnings).toBeUndefined()
  })
})

describe('evaluateRecurringTemplate: no-board-column with per-step columns', () => {
  it('warns when neither the recipe nor Step 1 has a column', () => {
    const verdict = evaluateRecurringTemplate(makeTemplate({ categoryId: null }))
    expect(verdict.warnings).toContain('no-board-column')
  })
  it('does not warn when Step 1 has its own column and the recipe has none', () => {
    const verdict = evaluateRecurringTemplate(
      makeTemplate({
        categoryId: null,
        stages: [{ assigneeId: 'emp-1', categoryId: 'cat-prep', items: [{ id: 'i1', label: 'Reconcile' }] }],
      }),
    )
    expect(verdict.warnings).not.toContain('no-board-column')
  })
  it('does not warn when the recipe has a default column', () => {
    expect(evaluateRecurringTemplate(makeTemplate()).warnings).not.toContain('no-board-column')
  })
})
