import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  LAST_STEP_SKIP_NOTE,
  SKIP_MODES,
  STEP_NOT_OPENED_SUBJECT,
  buildSkipNotice,
  isLastStepOfStepSkip,
  isStepSkip,
  skipButtonLabel,
  skipNoticeChip,
  skipNoticeLine,
  skipReasonThirdPerson,
  stepNotOpenedMessage,
  stepSkipDialogLead,
  stepSkipReviewLine,
  stepSkippedMessage,
  templateSkipMode,
} from '../../lib/checklist-skip.js'
import { copiedTemplateSettings } from '../../lib/checklist-template-copy.js'
import { skippedStepNeverOpened, skippedStepSentence } from '../lib/stalledCase'
import { stepSkipOutcomeChecklist, stepSkipOutcomeText } from '../lib/stepSkipOutcome'
import type { Checklist, ChecklistTemplate } from '../lib/types'

/**
 * Skip a step (featreq-7e1827e0), Brittany: "skip whole checklist" or "skip a
 * step". On the Check email recipe Lisa does step 1, Allison step 2, Brittany
 * after; with "skip a step", if Lisa skips it moves to Allison, who sees "Lisa
 * skipped" and why. The pure rules, the notice, and the route glue (server.js is
 * read as source - it is not booted by tests). The store half is in
 * db/store-staleness.test.mjs; the screens in skip-a-step-ui.test.tsx.
 */

const stepRecipe = { skipAllowed: true, skipMode: 'step' }
const wholeRecipe = { skipAllowed: true, skipMode: 'whole' }
const stage = (stageIndex: number, stageCount = 3, over: Record<string, unknown> = {}) => ({
  stageIndex,
  stageCount,
  ...over,
})

describe('the recipe setting', () => {
  it('has two modes and defaults to the whole checklist', () => {
    expect(SKIP_MODES).toEqual(['whole', 'step'])
    expect(templateSkipMode(undefined)).toBe('whole')
    expect(templateSkipMode({})).toBe('whole')
    expect(templateSkipMode({ skipMode: 'junk' })).toBe('whole')
    expect(templateSkipMode({ skipMode: 'step' })).toBe('step')
  })

  it('a copy of a recipe (Duplicate, Set up, packages) skips the way its source does', () => {
    expect(copiedTemplateSettings({ skipAllowed: true, skipMode: 'step' }).skipMode).toBe('step')
    expect(copiedTemplateSettings({ skipAllowed: true }).skipMode).toBe('whole')
  })
})

describe('isStepSkip: which skips skip only the step', () => {
  it('a step recipe, on a stage with a stage after it', () => {
    expect(isStepSkip(stepRecipe, stage(0))).toBe(true)
    expect(isStepSkip(stepRecipe, stage(1))).toBe(true)
  })

  it('never on the last stage: that skip ends the cycle, and the dialog says so', () => {
    expect(isStepSkip(stepRecipe, stage(2))).toBe(false)
    expect(isLastStepOfStepSkip(stepRecipe, stage(2))).toBe(true)
    expect(isLastStepOfStepSkip(stepRecipe, stage(1))).toBe(false)
  })

  it('never on a whole recipe, a recipe with skipping off, a one-step recipe or an onboarding case', () => {
    expect(isStepSkip(wholeRecipe, stage(0))).toBe(false)
    expect(isStepSkip({ skipAllowed: false, skipMode: 'step' }, stage(0))).toBe(false)
    expect(isStepSkip(stepRecipe, stage(0, 1))).toBe(false)
    expect(isStepSkip(stepRecipe, {})).toBe(false)
    expect(isStepSkip(stepRecipe, stage(0, 3, { onboardingForClientId: 'c1' }))).toBe(false)
    expect(isLastStepOfStepSkip(wholeRecipe, stage(2))).toBe(false)
    expect(isLastStepOfStepSkip(stepRecipe, stage(0, 1))).toBe(false)
  })
})

describe('the words', () => {
  it('the card button', () => {
    expect(skipButtonLabel(true)).toBe('Skip this step')
    expect(skipButtonLabel(false)).toBe('Skip this cycle')
  })

  it('the dialog lead names the step and the next person', () => {
    expect(
      stepSkipDialogLead({ stageNumber: 1, stageCount: 3, stageName: 'Clear Client provided email', nextPersonName: 'Allison' }),
    ).toBe(
      'Skipping step 1 of 3 (“Clear Client provided email”) for this cycle - the next step opens for Allison right away, and they will see who skipped and why.',
    )
    expect(stepSkipDialogLead({ stageNumber: 2, stageCount: 3 })).toContain('opens for the next person right away')
    expect(LAST_STEP_SKIP_NOTE).toBe('You are the last step, so skipping ends this cycle.')
  })

  it('the reason as the next person reads it', () => {
    expect(skipReasonThirdPerson('me')).toBe('they could not get to it')
    expect(skipReasonThirdPerson('colleague')).toBe('a colleague could not get to it')
    expect(skipReasonThirdPerson('client')).toBe('the client did not get us what we needed')
  })

  it('the notice the next step carries, and its banner line and chip', () => {
    const notice = buildSkipNotice({
      checklist: stage(0),
      stageName: 'Clear Client provided email',
      skippedBy: 'emp-a41095f0',
      skippedByName: 'Lisa Mockabee',
      reasonCategory: 'me',
      note: 'Out sick today.',
      at: '2026-11-03T15:00:00.000Z',
      skipId: 'skip-1',
    })
    expect(notice).toEqual({
      skippedBy: 'emp-a41095f0',
      skippedByName: 'Lisa Mockabee',
      stageIndex: 0,
      stageName: 'Clear Client provided email',
      reasonCategory: 'me',
      note: 'Out sick today.',
      at: '2026-11-03T15:00:00.000Z',
      skipId: 'skip-1',
    })
    expect(skipNoticeLine(notice)).toBe('Step 1 skipped by Lisa Mockabee (they could not get to it): Out sick today.')
    expect(skipNoticeChip(notice)).toBe('Step 1 skipped')
    expect(skipNoticeLine(null)).toBe('')
    expect(skipNoticeChip(undefined)).toBe('')
  })

  it("the next person's notice and the owner's when the next step could not open", () => {
    expect(
      stepSkippedMessage({
        skipperName: 'Lisa Mockabee',
        stageIndex: 0,
        stageCount: 3,
        stageName: 'Clear Client provided email',
        clientName: 'Acme',
        recipeTitle: 'Check email',
        reasonCategory: 'client',
        note: 'No email yet.',
      }),
    ).toBe(
      'Lisa Mockabee skipped step 1 of 3 ("Clear Client provided email") on Acme\'s Check email (the client did not get us what we needed): No email yet. Step 2 is now yours.',
    )
    // A note without its own stop gets one.
    expect(
      stepSkippedMessage({
        skipperName: 'Lisa',
        stageIndex: 1,
        stageCount: 3,
        recipeTitle: 'Check email',
        reasonCategory: 'me',
        note: 'Out sick',
      }),
    ).toBe('Lisa skipped step 2 of 3 on Check email (they could not get to it): Out sick. Step 3 is now yours.')
    // nextStageRefusalMessage('date_taken') - pinned in lib/checklist-step-skip.test.mjs.
    const why = 'Step 2 could not be created: another case of this recipe already has that step on that date.'
    expect(
      stepNotOpenedMessage({
        skipperName: 'Lisa Mockabee',
        stageIndex: 0,
        stageCount: 3,
        stageName: 'Clear',
        clientName: 'Acme',
        recipeTitle: 'Check email',
        why,
      }),
    ).toBe(
      'Lisa Mockabee skipped step 1 of 3 ("Clear") on Acme\'s Check email, but step 2 was not opened: Step 2 could not be created: another case of this recipe already has that step on that date. Open the case and press Open next step now on step 1 to open it once that is sorted out.',
    )
    // Its own subject, not the next person's "A step before yours was skipped".
    expect(STEP_NOT_OPENED_SUBJECT).toBe("A skipped step's next step did not open")
  })

  it('when the next step is already open: the dialog, the notice and the after-skip note say so', () => {
    expect(
      stepSkipDialogLead({
        stageNumber: 1,
        stageCount: 3,
        stageName: 'Clear',
        nextPersonName: 'Allison Reed',
        nextAlreadyOpen: true,
      }),
    ).toBe(
      'Skipping step 1 of 3 (“Clear”) for this cycle. Step 2 is already open for Allison Reed; they will see who skipped and why.',
    )
    expect(
      stepSkippedMessage({
        skipperName: 'Lisa',
        stageIndex: 0,
        stageCount: 3,
        recipeTitle: 'Check email',
        reasonCategory: 'me',
        note: 'Out sick.',
        alreadyOpen: true,
      }),
    ).toBe('Lisa skipped step 1 of 3 on Check email (they could not get to it): Out sick. Your step 2 was already open.')
    const checklist = { id: 'cl-2', stageIndex: 1 } as Checklist
    expect(stepSkipOutcomeText({ opened: false, alreadyOpen: true, checklist, assigneeName: 'Allison Reed' })).toBe(
      'Step skipped. Step 2 was already open for Allison Reed, who has been told.',
    )
    expect(stepSkipOutcomeChecklist({ opened: false, alreadyOpen: true, checklist, assigneeName: '' })).toBe(checklist)
    expect(stepSkipOutcomeChecklist({ opened: false, reason: 'date_taken', message: 'x' })).toBeNull()
  })

  it('a skipped step whose next step never opened is a stall the case page offers to open', () => {
    const step = { skipAllowed: true, skipMode: 'step', id: 'tmpl' } as unknown as ChecklistTemplate
    const whole = { ...step, skipMode: 'whole' } as ChecklistTemplate
    const skipped = {
      id: 'cl-0',
      templateId: 'tmpl',
      caseId: 'case-1',
      stageIndex: 0,
      stageCount: 3,
      skippedAt: '2026-08-30T15:00:00.000Z',
      items: [],
    } as unknown as Checklist
    expect(skippedStepNeverOpened(skipped, [skipped], [step])).toBe(true)
    // A later step of the case is live: nothing stalled.
    const later = { id: 'cl-1', caseId: 'case-1', stageIndex: 1 } as unknown as Checklist
    expect(skippedStepNeverOpened(skipped, [skipped, later], [step])).toBe(false)
    // A whole recipe's skip ended its cycle on purpose; an unskipped row is not this rule.
    expect(skippedStepNeverOpened(skipped, [skipped], [whole])).toBe(false)
    expect(skippedStepNeverOpened({ ...skipped, skippedAt: null }, [skipped], [step])).toBe(false)
    // The last step has nothing after it.
    expect(skippedStepNeverOpened({ ...skipped, stageIndex: 2 }, [skipped], [step])).toBe(false)
    expect(skippedStepSentence(skipped, true)).toBe(
      'Step 1 was skipped, but step 2 was never opened. Press Open next step now to open it.',
    )
    expect(skippedStepSentence(skipped, false)).toContain('The owner or the person this step is assigned to')
  })

  it("the owner's review row: which step, and who has the next one", () => {
    const opened = {
      assigneeId: 'emp-allison',
      stageCount: 3,
      skipNotice: { skipId: 'skip-1', stageIndex: 0 },
    }
    const employees = [{ id: 'emp-allison', name: 'Allison Reed' }]
    expect(stepSkipReviewLine({ skip: { id: 'skip-1' }, checklists: [opened], employees })).toBe(
      'Step 1 of 3 - next step opened for Allison Reed',
    )
    // A whole-cycle skip opened nothing: no line.
    expect(stepSkipReviewLine({ skip: { id: 'skip-2' }, checklists: [opened], employees })).toBe('')
  })

  it('the notice after the skip saves', () => {
    const checklist = { id: 'cl-2', stageIndex: 1 } as Checklist
    expect(stepSkipOutcomeText({ opened: true, checklist, assigneeName: 'Allison Reed' })).toBe(
      'Step skipped. Step 2 is open now for Allison Reed.',
    )
    expect(stepSkipOutcomeText({ opened: false, reason: 'date_taken', message: 'Step 2 could not be created.' })).toBe(
      'Step skipped, but the next step did not open: Step 2 could not be created.',
    )
  })
})

/** The skip route, read as source (server.js is not booted by tests). */
describe('POST /api/checklists/:id/skip - the step path', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const serverSource = readFileSync(path.join(root, 'server.js'), 'utf8').replaceAll('\r\n', '\n')
  const skipRoute = () => {
    const start = serverSource.indexOf('const checklistSkipMatch = normalizedPath.match(')
    const end = serverSource.indexOf('const checklistPushMatch = normalizedPath.match(', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    return serverSource.slice(start, end)
  }

  it('decides step-or-whole from the recipe BEFORE the skip is saved', () => {
    const route = skipRoute()
    const decided = route.indexOf('const stepSkip = isStepSkip(skipTemplate, checklist)')
    expect(decided).toBeGreaterThan(route.indexOf('isSkipAllowedForChecklist(checklist'))
    expect(decided).toBeLessThan(route.indexOf('await appDataStore.skipChecklistInstance('))
  })

  it('opens the next step only on a step skip, after the skip, its record, its activity and the notes pass', () => {
    const route = skipRoute()
    const opened = route.indexOf('await appDataStore.openNextStageAfterSkip(')
    expect(opened).toBeGreaterThan(route.indexOf('if (stepSkip) {'))
    expect(opened).toBeGreaterThan(route.indexOf('await appDataStore.createChecklistSkip('))
    expect(opened).toBeGreaterThan(route.indexOf("'checklist_skipped', checklist.title"))
    expect(opened).toBeGreaterThan(route.indexOf('attachPendingClientNotes({ clientId: checklist.clientId })'))
    // The notice carries the skip record's id, so the owner's review row can find the step it opened.
    expect(route).toContain('skipId: record?.id ?? null')
  })

  it('tells the next person once, with the new event, and never task_assigned for the same spawn', () => {
    const route = skipRoute()
    const notice = route.indexOf("await notify(appDataStore, spawned.assigneeId, 'checklist_step_skipped', {")
    expect(notice).toBeGreaterThan(-1)
    expect(route).toContain('if (spawned.assigneeId && spawned.assigneeId !== session.user.id) {')
    expect(route.slice(notice, notice + 900)).toContain('link: `/checklists?focus=${spawned.id}`')
    expect(route).not.toContain("'task_assigned'")
    // The case moved on: the same activity a finishing tick writes.
    expect(route).toContain("'case_advanced',")
  })

  it('when the next step cannot open: answers it in words and tells the owners, never the skipper', () => {
    const route = skipRoute()
    expect(route).toContain('nextStep = { opened: false, reason: advance.reason, message: why }')
    expect(route).toContain('nextStageRefusalMessage(advance.reason, { stageIndex, nextStageName })')
    expect(route).toContain("employee.role === 'Owner' && employee.id !== session.user.id")
    expect(route).toContain("await notify(appDataStore, owner.id, 'checklist_step_skipped', {")
    expect(route).toContain('link: `/cases/${caseId}`')
  })

  it('a spawn that throws is logged and answered, never a 500 for a saved skip', () => {
    const route = skipRoute()
    expect(route).toContain('`[stage-advance] FAILED after skip ${checklistId} case ${caseId}: ${error?.message || error}`')
    expect(route).toContain("console.error('[notify] checklist_step_skipped dispatch failed:'")
  })

  it('the owners still hear about every skip, and the whole-cycle answer is unchanged', () => {
    const route = skipRoute()
    expect(route).toContain("await notify(appDataStore, userId, 'checklist_skipped', {")
    expect(route).toContain('sendJson(response, 200, { checklist: skipped, skip: record, nextStep })')
    const last = route.lastIndexOf('sendJson(response, 200, { checklist: skipped, skip: record })')
    expect(last).toBeGreaterThan(route.indexOf('sendJson(response, 200, { checklist: skipped, skip: record, nextStep })'))
    // The case-completion check still runs for a step skip (a next step that was
    // already open and finished can make this skip the one that ends the case).
    expect(route.indexOf('skipCompletesCase(after, skipped)')).toBeLessThan(
      route.indexOf('sendJson(response, 200, { checklist: skipped, skip: record, nextStep })'),
    )
  })
})

/** Review round 1 (featreq-7e1827e0): the route glue of the five fixes. */
describe('the skip route after review round 1', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const serverSource = readFileSync(path.join(root, 'server.js'), 'utf8').replaceAll('\r\n', '\n')
  const slice = (from: string, to: string) => {
    const start = serverSource.indexOf(from)
    const end = serverSource.indexOf(to, start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    return serverSource.slice(start, end)
  }
  const skipRoute = () =>
    slice('const checklistSkipMatch = normalizedPath.match(', 'const checklistPushMatch = normalizedPath.match(')
  const openRoute = () =>
    slice('const checklistOpenNextStageMatch = normalizedPath.match(', 'const checklistToggleMatch = normalizedPath.match(')

  it('next step already open: tells THAT step person, answers alreadyOpen, and is not an owner failure', () => {
    const route = skipRoute()
    const branch = route.slice(
      route.indexOf("} else if (advance.reason === 'already_spawned' && advance.existing) {"),
      route.indexOf('const why =', route.indexOf("advance.reason === 'already_spawned' && advance.existing")),
    )
    expect(branch).toContain('alreadyOpen: true,')
    expect(branch).toContain('checklist: existing,')
    expect(branch).toContain("await notify(appDataStore, existing.assigneeId, 'checklist_step_skipped', {")
    expect(branch).toContain('alreadyOpen: true,\n                }),')
    expect(branch).toContain('if (existing.assigneeId && existing.assigneeId !== session.user.id) {')
    expect(branch).not.toContain('owner.id')
  })

  it("the owner's could-not-open notice has its own subject", () => {
    const route = skipRoute()
    const ownerNotice = route.slice(route.indexOf("await notify(appDataStore, owner.id, 'checklist_step_skipped', {"))
    expect(ownerNotice.slice(0, 300)).toContain('subject: STEP_NOT_OPENED_SUBJECT,')
  })

  it('whoever holds the next step gets the step notice only, not also the skip notice', () => {
    const route = skipRoute()
    expect(route).toContain(
      'nextStep && (nextStep.opened || nextStep.alreadyOpen) ? nextStep.checklist?.assigneeId ?? null : null',
    )
    const skipLoop = route.indexOf("await notify(appDataStore, userId, 'checklist_skipped', {")
    const guard = route.indexOf('if (nextHolderId && userId === nextHolderId) continue')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(skipLoop)
  })

  it('Open next step now on a skipped step: records the third kind and tells the next person as a step skip', () => {
    const route = openRoute()
    expect(route).toContain('const afterSkip = result.afterSkip === true')
    const branch = route.slice(route.indexOf('if (afterSkip && spawned?.skipNotice) {'))
    expect(branch.indexOf("'checklist_step_skipped'")).toBeGreaterThan(-1)
    // The step-skip branch answers before the ordinary task_assigned notice.
    expect(branch.indexOf('sendJson(response, 200, { checklist: from, spawned })')).toBeLessThan(
      branch.indexOf("'task_assigned'"),
    )
  })
})
