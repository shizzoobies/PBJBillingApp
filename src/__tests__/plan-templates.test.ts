import { describe, expect, it } from 'vitest'
import {
  linkCandidatesForPlanTemplate,
  missingPlanTemplatesForClient,
  planTemplates,
  templatePickerLabel,
  unstampedClientChecklists,
} from '../lib/utils'
import type { ChecklistTemplate, SubscriptionPlan } from '../lib/types'

/**
 * Minimal ChecklistTemplate factory — only the fields the plan↔template
 * helpers read are required, so the tests stay focused on the pure logic.
 */
function makeTemplate(
  over: Partial<ChecklistTemplate> & { id: string },
): ChecklistTemplate {
  return {
    title: over.id,
    clientId: '',
    assigneeId: '',
    frequency: 'monthly',
    nextDueDate: '2026-01-01',
    active: true,
    viewerIds: [],
    editorIds: [],
    stages: [],
    ...over,
  }
}

function makePlan(over: Partial<SubscriptionPlan> & { id: string }): SubscriptionPlan {
  return { name: over.id, notes: '', ...over }
}

describe('planTemplates', () => {
  it('resolves the plan templateIds against the template list, in order', () => {
    const t1 = makeTemplate({ id: 't1' })
    const t2 = makeTemplate({ id: 't2' })
    const t3 = makeTemplate({ id: 't3' })
    const plan = makePlan({ id: 'p1', templateIds: ['t3', 't1'] })
    expect(planTemplates(plan, [t1, t2, t3])).toEqual([t3, t1])
  })

  it('drops ids that no longer resolve to a template (deleted since linked)', () => {
    const t1 = makeTemplate({ id: 't1' })
    const plan = makePlan({ id: 'p1', templateIds: ['t1', 'gone'] })
    expect(planTemplates(plan, [t1])).toEqual([t1])
  })

  it('de-duplicates repeated ids and returns [] for a plan with no templates', () => {
    const t1 = makeTemplate({ id: 't1' })
    expect(planTemplates(makePlan({ id: 'p1', templateIds: ['t1', 't1'] }), [t1])).toEqual([t1])
    expect(planTemplates(makePlan({ id: 'p2' }), [t1])).toEqual([])
  })
})

describe('missingPlanTemplatesForClient', () => {
  const blueprint = makeTemplate({ id: 'bp1', title: 'Monthly Bookkeeping', isStandard: true })
  const plan = makePlan({ id: 'p1', templateIds: ['bp1'] })

  it('reports a plan template as missing when the client has no matching copy', () => {
    const otherClientCopy = makeTemplate({
      id: 'c2-copy',
      title: 'Monthly Bookkeeping',
      clientId: 'client-2',
      sourceTemplateId: 'bp1',
    })
    const missing = missingPlanTemplatesForClient(plan, [blueprint, otherClientCopy], 'client-1', [
      blueprint,
      otherClientCopy,
    ])
    expect(missing.map((t) => t.id)).toEqual(['bp1'])
  })

  it('treats a template as already set up when an origin stamp matches', () => {
    const copy = makeTemplate({
      id: 'c1-copy',
      title: 'Renamed locally',
      clientId: 'client-1',
      sourceTemplateId: 'bp1',
    })
    const missing = missingPlanTemplatesForClient(plan, [blueprint, copy], 'client-1', [
      blueprint,
      copy,
    ])
    expect(missing).toEqual([])
  })

  it('falls back to a title match for legacy copies without an origin stamp', () => {
    const legacyCopy = makeTemplate({
      id: 'c1-legacy',
      title: '  monthly bookkeeping ',
      clientId: 'client-1',
    })
    const missing = missingPlanTemplatesForClient(plan, [blueprint, legacyCopy], 'client-1', [
      blueprint,
      legacyCopy,
    ])
    expect(missing).toEqual([])
  })

  it('does not count a copy belonging to a different client', () => {
    const copy = makeTemplate({
      id: 'c2-copy',
      title: 'Monthly Bookkeeping',
      clientId: 'client-2',
      sourceTemplateId: 'bp1',
    })
    const missing = missingPlanTemplatesForClient(plan, [blueprint, copy], 'client-1', [
      blueprint,
      copy,
    ])
    expect(missing.map((t) => t.id)).toEqual(['bp1'])
  })
})

describe('templatePickerLabel', () => {
  it('formats title · frequency and tags standard blueprints', () => {
    expect(
      templatePickerLabel(makeTemplate({ id: 't1', title: 'Payroll', frequency: 'weekly' })),
    ).toBe('Payroll · Weekly')
    expect(
      templatePickerLabel(
        makeTemplate({ id: 't2', title: 'Close', frequency: 'monthly', isStandard: true }),
      ),
    ).toBe('Close · Monthly (blueprint)')
  })
})

/**
 * "Link existing" (featreq-2b067744): Brittany's own checklists are titled
 * "Quarterly Reconciliations with Review" while the blueprint is
 * "Reconciliations with Review", so the strict title rule never matches. The
 * candidate rule is looser (a leading cadence word is ignored) but only ever
 * SUGGESTS - the automatic "Set up" match stays exact.
 */
describe('linkCandidatesForPlanTemplate', () => {
  const blueprint = makeTemplate({ id: 'bp-rec', title: 'Reconciliations with Review', isStandard: true })
  const hers = (id: string, title: string, over: Partial<ChecklistTemplate> = {}) =>
    makeTemplate({ id, title, clientId: 'c1', ...over })

  it('offers her checklist whose title matches after a leading cadence word', () => {
    const quarterly = hers('t-q', 'Quarterly Reconciliations with Review')
    const monthly = hers('t-m', '  monthly reconciliations WITH review ')
    const annual = hers('t-a', 'Annually Reconciliations with Review')
    const other = hers('t-x', 'Payroll run')
    expect(linkCandidatesForPlanTemplate(blueprint, 'c1', [quarterly, monthly, annual, other]).map((t) => t.id)).toEqual([
      't-a',
      't-m',
      't-q',
    ])
  })

  it("never offers another client's checklist, a stamped one, a blueprint or an onboarding checklist", () => {
    const templates = [
      hers('t-other-client', 'Quarterly Reconciliations with Review', { clientId: 'c2' }),
      hers('t-stamped', 'Quarterly Reconciliations with Review', { sourceTemplateId: 'bp-else' }),
      hers('t-onboarding', 'Quarterly Reconciliations with Review', { onboardingForClientId: 'c1' }),
      makeTemplate({ id: 't-blueprint', title: 'Quarterly Reconciliations with Review', isStandard: true }),
    ]
    expect(linkCandidatesForPlanTemplate(blueprint, 'c1', templates)).toEqual([])
    expect(unstampedClientChecklists('c1', templates)).toEqual([])
  })

  it('does not offer "Monthly Reconciliations with Review" for "Monthly Reconciliations"', () => {
    const plain = makeTemplate({ id: 'bp-plain', title: 'Monthly Reconciliations', isStandard: true })
    const withReview = hers('t-m', 'Monthly Reconciliations with Review')
    expect(linkCandidatesForPlanTemplate(plain, 'c1', [withReview])).toEqual([])
    // ...but it is still in the "choose another" list of her unstamped checklists.
    expect(unstampedClientChecklists('c1', [withReview]).map((t) => t.id)).toEqual(['t-m'])
  })

  it('leaves the automatic Set up match strict: a cadence-word variant is still Not set up', () => {
    const weekly = makeTemplate({ id: 'bp-weekly', title: 'Weekly Transactions', isStandard: true })
    const monthlyCopy = hers('t-mt', 'Monthly Transactions')
    expect(
      missingPlanTemplatesForClient({ templateIds: ['bp-weekly'] }, [weekly, monthlyCopy], 'c1', [weekly, monthlyCopy]),
    ).toEqual([weekly])
    // A LINKED checklist (stamped with the blueprint) counts as set up.
    const linked = { ...monthlyCopy, sourceTemplateId: 'bp-weekly' }
    expect(
      missingPlanTemplatesForClient({ templateIds: ['bp-weekly'] }, [weekly, linked], 'c1', [weekly, linked]),
    ).toEqual([])
  })
})
