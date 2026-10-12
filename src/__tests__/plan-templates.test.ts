import { describe, expect, it } from 'vitest'
import {
  linkableClientChecklists,
  linkCandidatesForPlanTemplate,
  missingPlanTemplatesForClient,
  planTemplates,
  templatePickerLabel,
  uniqueByTitle,
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

  it('suggests her checklist whose title matches after a cadence word that agrees with its schedule', () => {
    const quarterly = hers('t-q', 'Quarterly Reconciliations with Review', { frequency: 'quarterly' })
    // Quarterly as four specific months counts as quarterly.
    const fourMonths = hers('t-4', 'Quarterly reconciliations WITH review ', {
      frequency: 'specific-months',
      scheduledMonths: [3, 6, 9, 12],
    })
    const annual = hers('t-a', 'Annual Reconciliations with Review', { frequency: 'annually' })
    const plain = hers('t-p', 'Reconciliations with Review') // no cadence word: any schedule
    const other = hers('t-x', 'Payroll run')
    expect(
      linkCandidatesForPlanTemplate(blueprint, 'c1', [quarterly, fourMonths, annual, plain, other]).map((t) => t.id),
    ).toEqual(['t-a', 't-q', 't-4', 't-p'])
  })

  it('keeps a cadence word that disagrees with the schedule, or a switched-off one, out of the suggestions (but linkable)', () => {
    const mismatched = hers('t-m', 'Quarterly Reconciliations with Review', { frequency: 'monthly' })
    const off = hers('t-off', 'Quarterly Reconciliations with Review', { frequency: 'quarterly', active: false })
    const templates = [mismatched, off]
    expect(linkCandidatesForPlanTemplate(blueprint, 'c1', templates)).toEqual([])
    expect(linkableClientChecklists('c1', templates).map((t) => t.id)).toEqual(['t-m', 't-off'])
    // The blueprint's own cadence word counts too.
    const weekly = makeTemplate({ id: 'bp-w', title: 'Weekly Transactions', isStandard: true })
    expect(linkCandidatesForPlanTemplate(weekly, 'c1', [hers('t-mt', 'Monthly Transactions')])).toEqual([])
  })

  it("never offers another client's checklist, one tied to a live blueprint, a blueprint or an onboarding checklist", () => {
    const templates = [
      makeTemplate({ id: 'bp-else', title: 'Close', isStandard: true }),
      hers('t-other-client', 'Quarterly Reconciliations with Review', { clientId: 'c2', frequency: 'quarterly' }),
      hers('t-linked', 'Quarterly Reconciliations with Review', { sourceTemplateId: 'bp-else', frequency: 'quarterly' }),
      hers('t-onboarding', 'Quarterly Reconciliations with Review', { onboardingForClientId: 'c1' }),
      makeTemplate({ id: 't-blueprint', title: 'Quarterly Reconciliations with Review', isStandard: true }),
    ]
    expect(linkCandidatesForPlanTemplate(blueprint, 'c1', templates)).toEqual([])
    expect(linkableClientChecklists('c1', templates)).toEqual([])
  })

  it('keeps a Duplicate / Copy-to-client copy linkable: its stamp names a client recipe or a deleted template', () => {
    const theirRecipe = hers('t-src', 'Quarterly Reconciliations with Review', { clientId: 'c2', frequency: 'quarterly' })
    const duplicated = hers('t-dup', 'Quarterly Reconciliations with Review', {
      sourceTemplateId: 't-src',
      frequency: 'quarterly',
    })
    const orphaned = hers('t-orphan', 'Reconciliations with Review', { sourceTemplateId: 'template-gone' })
    const templates = [theirRecipe, duplicated, orphaned]
    expect(linkCandidatesForPlanTemplate(blueprint, 'c1', templates).map((t) => t.id)).toEqual(['t-dup', 't-orphan'])
  })

  it('does not offer "Monthly Reconciliations with Review" for "Monthly Reconciliations"', () => {
    const plain = makeTemplate({ id: 'bp-plain', title: 'Monthly Reconciliations', isStandard: true })
    const withReview = hers('t-m', 'Monthly Reconciliations with Review')
    expect(linkCandidatesForPlanTemplate(plain, 'c1', [withReview])).toEqual([])
    // ...but it is still in the "choose another" list of her linkable checklists.
    expect(linkableClientChecklists('c1', [withReview]).map((t) => t.id)).toEqual(['t-m'])
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

describe('uniqueByTitle', () => {
  it('keeps the first of each title, trimmed and in any case', () => {
    const a = makeTemplate({ id: 'a', title: 'Monthly Close' })
    const b = makeTemplate({ id: 'b', title: ' monthly close ' })
    const c = makeTemplate({ id: 'c', title: 'Payroll' })
    expect(uniqueByTitle([a, b, c]).map((t) => t.id)).toEqual(['a', 'c'])
  })
})
