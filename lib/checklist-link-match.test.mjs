import { describe, expect, it } from 'vitest'
import {
  linkCandidatesForPlanTemplate,
  linkableClientChecklists,
  planSetUpSteps,
} from './checklist-link-match.js'

/**
 * Which of a client's own checklists stand for a blueprint, and what Set up does
 * with each (featreq-8bdc5ec5). The browser and the server's package apply run
 * this one function, so these are the rules for both.
 */

const blueprint = (id, title) => ({ id, title, clientId: '', isStandard: true, frequency: 'monthly' })
const hers = (id, title, extra = {}) => ({
  id,
  title,
  clientId: 'c1',
  isStandard: false,
  active: true,
  frequency: 'monthly',
  ...extra,
})
const quarterly = { frequency: 'specific-months', scheduledMonths: [1, 4, 7, 10] }

describe('linkCandidatesForPlanTemplate', () => {
  it('matches a leading and a trailing cadence word, any case', () => {
    const recs = blueprint('bp-recs', 'Reconciliations with Review')
    const templates = [
      recs,
      hers('h1', 'Quarterly Reconciliations with Review - Quarterly', quarterly),
      hers('h2', 'reconciliations WITH review', quarterly),
      hers('h3', 'Reconciliations'),
    ]
    expect(linkCandidatesForPlanTemplate(recs, 'c1', templates).map((t) => t.id)).toEqual(['h1', 'h2'])
  })

  it('does not match a cadence word its own schedule contradicts, in either title', () => {
    const weekly = blueprint('bp-weekly', 'Weekly Transactions')
    expect(
      linkCandidatesForPlanTemplate(weekly, 'c1', [weekly, hers('h1', 'Monthly Transactions')]),
    ).toEqual([])
    const plain = blueprint('bp-plain', 'Transactions')
    expect(
      linkCandidatesForPlanTemplate(plain, 'c1', [plain, hers('h2', 'Weekly Transactions')]),
    ).toEqual([])
    expect(
      linkCandidatesForPlanTemplate(plain, 'c1', [plain, hers('h3', 'Transactions - Quarterly', quarterly)]).map(
        (t) => t.id,
      ),
    ).toEqual(['h3'])
  })

  it('leaves out other clients, blueprints, onboarding checklists, ones tied to a live blueprint, and switched-off ones', () => {
    const close = blueprint('bp-close', 'Close')
    const templates = [
      close,
      hers('mine', 'Close'),
      hers('other-client', 'Close', { clientId: 'c2' }),
      hers('onboarding', 'Close', { onboardingForClientId: 'c1' }),
      hers('tied', 'Close', { sourceTemplateId: 'bp-close' }),
      hers('off', 'Close', { active: false }),
      hers('stale-stamp', 'Close', { sourceTemplateId: 'someone-elses-recipe' }),
    ]
    expect(linkCandidatesForPlanTemplate(close, 'c1', templates).map((t) => t.id).sort()).toEqual([
      'mine',
      'stale-stamp',
    ])
    expect(linkableClientChecklists('c1', templates).map((t) => t.id)).toContain('off')
  })
})

describe('planSetUpSteps', () => {
  const recs = blueprint('bp-recs', 'Reconciliations with Review')
  const monthly = blueprint('bp-monthly', 'Monthly Reconciliations')

  it('links the one checklist that stands for a blueprint, creates when none does', () => {
    // The plan gives the Reconciliations copy a quarterly schedule, so hers agrees.
    const steps = planSetUpSteps(
      [recs, monthly],
      'c1',
      [hers('h1', 'Quarterly Reconciliations with Review - Quarterly', quarterly)],
      (blueprint) => (blueprint.id === 'bp-recs' ? 'quarterly' : null),
    )
    expect(steps.map((step) => step.kind)).toEqual(['link', 'create'])
    expect(steps[0].copy.id).toBe('h1')
  })

  it('leaves a lone quarterly checklist for her when the copy would run monthly', () => {
    const only = [hers('h1', 'Reconciliations with Review - Quarterly', quarterly)]
    // A monthly plan's blueprint (no plan cadence): the copy runs monthly, hers runs quarterly.
    expect(planSetUpSteps([recs], 'c1', only, () => null)[0].kind).toBe('choose')
    expect(planSetUpSteps([recs], 'c1', only, () => 'monthly')[0].kind).toBe('choose')
    // The same blueprint with no cadenceFor at all compares with its own frequency.
    expect(planSetUpSteps([recs], 'c1', only)[0].kind).toBe('choose')
    // A plan that gives it a quarterly schedule, or a blueprint that is itself quarterly, links.
    expect(planSetUpSteps([recs], 'c1', only, () => 'quarterly')[0].kind).toBe('link')
    expect(planSetUpSteps([{ ...recs, ...quarterly }], 'c1', only)[0].kind).toBe('link')
    // 'blueprint' = the blueprint's own schedule; a yearly plan reads as annually.
    expect(planSetUpSteps([recs], 'c1', [hers('h2', 'Reconciliations with Review')], () => 'blueprint')[0].kind).toBe('link')
    expect(
      planSetUpSteps([recs], 'c1', [hers('h3', 'Reconciliations with Review - Annual', { frequency: 'specific-months', scheduledMonths: [3] })], () => 'annual')[0].kind,
    ).toBe('link')
  })

  it('says why a row is left: several matches, a shared match, or a differing schedule', () => {
    const only = [hers('h1', 'Reconciliations with Review - Quarterly', quarterly)]
    expect(planSetUpSteps([recs], 'c1', only)[0]).toMatchObject({ kind: 'choose', reason: 'schedule' })
    const two = [...only, hers('h2', 'Quarterly Reconciliations with Review', quarterly)]
    expect(planSetUpSteps([recs], 'c1', two)[0]).toMatchObject({ kind: 'choose', reason: 'several' })
    const twin = { ...recs, id: 'bp-twin' }
    expect(planSetUpSteps([recs, twin], 'c1', only, () => 'quarterly')[0]).toMatchObject({
      kind: 'choose',
      reason: 'several',
    })
  })

  it('links none when several match, and leaves the row for her to choose', () => {
    const steps = planSetUpSteps(
      [recs],
      'c1',
      [hers('h1', 'Quarterly Reconciliations with Review', quarterly), hers('h2', 'Reconciliations with Review - Quarterly', quarterly)],
    )
    expect(steps).toHaveLength(1)
    expect(steps[0].kind).toBe('choose')
    expect(steps[0].candidates.map((t) => t.id).sort()).toEqual(['h1', 'h2'])
  })

  it('does not hand one checklist to two blueprints', () => {
    const twin = blueprint('bp-twin', 'Reconciliations With Review ')
    const steps = planSetUpSteps([recs, { ...twin, id: 'bp-twin' }], 'c1', [
      hers('h1', 'Quarterly Reconciliations with Review', quarterly),
    ])
    expect(steps.map((step) => step.kind)).toEqual(['choose', 'choose'])
  })

  it('creates everything when the client has nothing of its own', () => {
    expect(planSetUpSteps([recs, monthly], 'c1', [recs, monthly]).map((step) => step.kind)).toEqual([
      'create',
      'create',
    ])
    expect(planSetUpSteps([], 'c1', [])).toEqual([])
  })
})
