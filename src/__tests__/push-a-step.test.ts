import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  SKIP_MODE_STEP_PUSH_NOTE,
  STEP_PUSHED_SUBJECT,
  STEP_PUSH_NOT_OPENED_SUBJECT,
  buildPushNotice,
  buildSkipNotice,
  isPushNotice,
  isStepPush,
  isStepSkip,
  pushDateWords,
  skipNoticeChip,
  skipNoticeLine,
  stepPushDialogNote,
  stepPushNotOpenedMessage,
  stepPushedMessage,
  stepSkipReviewLine,
} from '../../lib/checklist-skip.js'
import { stepSkipOutcomeChecklist, stepSkipOutcomeText } from '../lib/stepSkipOutcome'
import type { Checklist } from '../lib/types'

/**
 * Push a step (featreq-78f09571), Brittany: "When a user pushes a task, the next
 * task in line does not activate. This differs from the existing skip a step
 * feature, which already moves activation to the next task." On a recipe set to
 * "Skip a step", pushing a step that has a step after it now opens the next step
 * for the next person too; the pushed step stays open on its new date. The pure
 * rules, the words, and the route glue (server.js is read as source - it is not
 * booted by tests). The store half is in db/store-staleness.test.mjs.
 */

const stepRecipe = { skipAllowed: true, skipMode: 'step' }
const stage = (stageIndex: number, stageCount = 3, over: Record<string, unknown> = {}) => ({
  stageIndex,
  stageCount,
  ...over,
})

describe('isStepPush: which pushes open the next step', () => {
  it('is the Skip a step rule, case for case', () => {
    const cases: Array<[Record<string, unknown> | null, Record<string, unknown>]> = [
      [stepRecipe, stage(0)],
      [stepRecipe, stage(1)],
      [stepRecipe, stage(2)],
      [stepRecipe, stage(0, 1)],
      [stepRecipe, stage(0, 3, { onboardingForClientId: 'c1' })],
      [{ skipAllowed: true, skipMode: 'whole' }, stage(0)],
      [{ skipAllowed: false, skipMode: 'step' }, stage(0)],
      [null, stage(0)],
    ]
    for (const [recipe, checklist] of cases) {
      expect(isStepPush(recipe, checklist)).toBe(isStepSkip(recipe, checklist))
    }
  })

  it('a step recipe with a step after this one: yes; its last step, a whole recipe, an onboarding case: no', () => {
    expect(isStepPush(stepRecipe, stage(0))).toBe(true)
    expect(isStepPush(stepRecipe, stage(1))).toBe(true)
    expect(isStepPush(stepRecipe, stage(2))).toBe(false)
    expect(isStepPush({ skipAllowed: true, skipMode: 'whole' }, stage(0))).toBe(false)
    expect(isStepPush(stepRecipe, stage(0, 3, { onboardingForClientId: 'c1' }))).toBe(false)
  })
})

describe('the words', () => {
  const notice = buildPushNotice({
    checklist: stage(0),
    stageName: 'Clear Client provided email',
    pushedBy: 'emp-lisa',
    pushedByName: 'Lisa Mockabee',
    reasonCategory: 'client',
    note: 'Waiting on the bank statement',
    at: '2026-11-12T15:00:00.000Z',
    skipId: 'skip-9',
    newDueDate: '2026-11-20',
  })

  it('the notice the next step carries is a skip notice marked as a push, with the new date', () => {
    expect(notice).toEqual({
      ...buildSkipNotice({
        checklist: stage(0),
        stageName: 'Clear Client provided email',
        skippedBy: 'emp-lisa',
        skippedByName: 'Lisa Mockabee',
        reasonCategory: 'client',
        note: 'Waiting on the bank statement',
        at: '2026-11-12T15:00:00.000Z',
        skipId: 'skip-9',
      }),
      kind: 'push',
      newDueDate: '2026-11-20',
    })
    expect(isPushNotice(notice)).toBe(true)
    expect(isPushNotice(buildSkipNotice({ checklist: stage(0) }))).toBe(false)
    expect(isPushNotice(null)).toBe(false)
  })

  it('its banner line and chip say pushed, and to when; a skip notice still says skipped', () => {
    expect(skipNoticeLine(notice)).toBe(
      'Step 1 pushed to November 20, 2026 by Lisa Mockabee (the client did not get us what we needed): Waiting on the bank statement',
    )
    expect(skipNoticeChip(notice)).toBe('Step 1 pushed')
    const skipped = buildSkipNotice({ checklist: stage(0), skippedByName: 'Lisa Mockabee', reasonCategory: 'me', note: 'Out.' })
    expect(skipNoticeLine(skipped)).toBe('Step 1 skipped by Lisa Mockabee (they could not get to it): Out.')
    expect(skipNoticeChip(skipped)).toBe('Step 1 skipped')
    // A push notice with no date still reads.
    expect(skipNoticeLine({ ...notice, newDueDate: null })).toBe(
      'Step 1 pushed by Lisa Mockabee (the client did not get us what we needed): Waiting on the bank statement',
    )
  })

  it('dates read as words, and anything that is not a date is handed back', () => {
    expect(pushDateWords('2026-11-20')).toBe('November 20, 2026')
    expect(pushDateWords('2027-01-05')).toBe('January 5, 2027')
    expect(pushDateWords('2026-11-20T05:00:00.000Z')).toBe('November 20, 2026')
    expect(pushDateWords('soon')).toBe('soon')
    expect(pushDateWords('2026-13-01')).toBe('2026-13-01')
    expect(pushDateWords(null)).toBe('')
  })

  it("the next person's notice", () => {
    const base = {
      pusherName: 'Lisa Mockabee',
      stageIndex: 0,
      stageCount: 3,
      stageName: 'Clear Client provided email',
      clientName: 'Acme',
      recipeTitle: 'Check email',
      reasonCategory: 'client',
      note: 'Waiting on the bank statement',
      newDueDate: '2026-11-20',
    }
    expect(stepPushedMessage(base)).toBe(
      'Lisa Mockabee pushed step 1 of 3 ("Clear Client provided email") on Acme\'s Check email to November 20, 2026 ' +
        '(the client did not get us what we needed): Waiting on the bank statement. Step 2 is now yours.',
    )
    expect(stepPushedMessage({ ...base, alreadyOpen: true })).toContain('Your step 2 was already open.')
    // A note that ends its own sentence keeps its stop.
    expect(stepPushedMessage({ ...base, note: 'Back Monday.' })).toContain(': Back Monday. Step 2 is now yours.')
    expect(STEP_PUSHED_SUBJECT).toBe('A step before yours was pushed')
  })

  it("the owner's notice when the next step could not open says the pushed step is still open", () => {
    const message = stepPushNotOpenedMessage({
      pusherName: 'Lisa Mockabee',
      stageIndex: 0,
      stageCount: 3,
      stageName: 'Clear Client provided email',
      clientName: 'Acme',
      recipeTitle: 'Check email',
      newDueDate: '2026-11-20',
      // The stage-advance sentence for a slot another case holds (lib/open-next-stage.js).
      why: 'Step 2 could not be created: another case of this recipe already has that step on that date.',
    })
    expect(message).toBe(
      'Lisa Mockabee pushed step 1 of 3 ("Clear Client provided email") on Acme\'s Check email to November 20, 2026, ' +
        'but step 2 was not opened: Step 2 could not be created: another case of this recipe already has that step on that date. ' +
        'Step 1 is still open on its new date; once that is sorted out, step 2 opens when step 1 is finished.',
    )
    expect(STEP_PUSH_NOT_OPENED_SUBJECT).toBe("A pushed step's next step did not open")
  })

  it('the Push form says the next step opens, or that it is already open', () => {
    expect(stepPushDialogNote({ stageNumber: 1, nextPersonName: 'Allison Lehmann' })).toBe(
      'Step 2 opens for Allison Lehmann right away, and they will see who pushed this step and why. This step stays open on its new date.',
    )
    expect(stepPushDialogNote({ stageNumber: 1, nextPersonName: '', nextAlreadyOpen: true })).toBe(
      'Step 2 is already open for the next person; they will see who pushed this step and why.',
    )
    // The next step is already finished: nothing opens, and the form does not promise anyone is told.
    expect(
      stepPushDialogNote({ stageNumber: 1, nextPersonName: 'Allison Lehmann', nextAlreadyOpen: true, nextFinished: true }),
    ).toBe('Step 2 is already finished, so nothing else opens. This step stays open on its new date.')
  })

  it('the recipe setting says the same choice decides what a push does', () => {
    expect(SKIP_MODE_STEP_PUSH_NOTE).toBe(
      'Pushing a step to a new date opens the next step the same way; the pushed step stays open.',
    )
  })

  it("the owner's review row names the step a push opened; a push that opened none says nothing", () => {
    const opened = { assigneeId: 'emp-allison', stageCount: 3, skipNotice: notice }
    const employees = [{ id: 'emp-allison', name: 'Allison Lehmann' }]
    expect(stepSkipReviewLine({ skip: { id: 'skip-9', kind: 'push' }, checklists: [opened], employees })).toBe(
      'Step 1 of 3 - next step opened for Allison Lehmann',
    )
    expect(stepSkipReviewLine({ skip: { id: 'skip-10', kind: 'push' }, checklists: [opened], employees })).toBe('')
    // A whole-cycle skip is still decided by its own record.
    expect(stepSkipReviewLine({ skip: { id: 'skip-9', kind: 'skip' }, checklists: [opened], employees })).toBe('')
  })

  it('the notice after the push saves', () => {
    const checklist = { id: 'cl-2', stageIndex: 1, items: [{ id: 'i', label: 'Review', done: false }] } as unknown as Checklist
    expect(stepSkipOutcomeText({ opened: true, checklist, assigneeName: 'Allison Lehmann', after: 'push' })).toBe(
      'Step pushed. Step 2 is open now for Allison Lehmann.',
    )
    expect(
      stepSkipOutcomeText({ opened: false, alreadyOpen: true, checklist, assigneeName: 'Allison Lehmann', after: 'push' }),
    ).toBe('Step pushed. Step 2 was already open for Allison Lehmann, who has been told.')
    // A next step that is already finished (the server says so): nothing opened, nobody told.
    expect(
      stepSkipOutcomeText({
        opened: false,
        alreadyOpen: true,
        finished: true,
        checklist,
        assigneeName: 'Allison Lehmann',
        after: 'push',
      }),
    ).toBe('Step pushed. Step 2 was already finished.')
    expect(
      stepSkipOutcomeText({ opened: false, reason: 'date_taken', message: 'Step 2 could not be created.', after: 'push' }),
    ).toBe('Step pushed, but the next step did not open: Step 2 could not be created.')
    // The row to merge is the same one a skip hands back.
    expect(stepSkipOutcomeChecklist({ opened: true, checklist, assigneeName: '', after: 'push' })).toBe(checklist)
    // A skip's sentences are unchanged.
    expect(stepSkipOutcomeText({ opened: true, checklist, assigneeName: 'Allison Lehmann' })).toBe(
      'Step skipped. Step 2 is open now for Allison Lehmann.',
    )
  })
})

/** The push route, read as source (server.js is not booted by tests). */
describe('POST /api/checklists/:id/push - the step path', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const serverSource = readFileSync(path.join(root, 'server.js'), 'utf8').replaceAll('\r\n', '\n')
  const slice = (from: string, to: string) => {
    const start = serverSource.indexOf(from)
    const end = serverSource.indexOf(to, start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    return serverSource.slice(start, end)
  }
  const pushRoute = () =>
    slice('const checklistPushMatch = normalizedPath.match(', 'const checklistMetaPatchMatch = normalizedPath.match(')
  const sharedRoutine = () =>
    slice('async function openNextStepAndTell({', 'async function notifyOwnersOfUpdateActivity(')

  it('opens the next step only on a step recipe, decided on the row that holds the open work, after the push and its record', () => {
    const route = pushRoute()
    const decided = route.indexOf('if (isStepPush(pushTemplate, pushed)) {')
    expect(decided).toBeGreaterThan(route.indexOf('await appDataStore.pushChecklistInstance('))
    expect(decided).toBeGreaterThan(route.indexOf('const pushRecord = await appDataStore.createChecklistSkip({'))
    expect(decided).toBeGreaterThan(route.indexOf("'checklist_pushed', checklist.title"))
    const opened = route.indexOf('appDataStore.openNextStageAfterPush(')
    expect(opened).toBeGreaterThan(decided)
    // The live row (the new copy, after a split) - never the done-only original.
    expect(route.slice(opened, opened + 120)).toContain('pushed.id,')
    expect(route).toContain("mode: 'push',")
    expect(route).toContain('checklist: pushed,')
  })

  it("the notice carries the push record's id and the new date", () => {
    const route = pushRoute()
    const notice = route.slice(route.indexOf('buildPushNotice({'))
    expect(notice.slice(0, 600)).toContain('skipId: pushRecord?.id ?? null,')
    expect(notice.slice(0, 600)).toContain('newDueDate: validatedPush.newDueDate,')
    expect(notice.slice(0, 600)).toContain('pushedBy: session.user.id,')
  })

  it('whoever was TOLD about their step gets the step notice only; a next person who was not told still gets the push notice', () => {
    const route = pushRoute()
    // Left out of the ordinary notice by who was actually told, not by who holds the step.
    const guard = route.indexOf('if (stepNoticeToldId && userId === stepNoticeToldId) continue')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(route.indexOf("await notify(appDataStore, userId, 'checklist_pushed', {"))
    expect(route).toContain(';({ nextStep, toldUserId: stepNoticeToldId } = await openNextStepAndTell({')
    expect(route).not.toContain('nextHolderId')
    // The shared routine names the one person it told, only after the notice went out.
    const shared = sharedRoutine()
    expect(shared).toContain('let toldUserId = null')
    expect(shared).toContain('return { nextStep, toldUserId }')
    const openedNotice = shared.indexOf("await notify(appDataStore, spawned.assigneeId, 'checklist_step_skipped', {")
    const openedTold = shared.indexOf('toldUserId = spawned.assigneeId')
    expect(openedTold).toBeGreaterThan(openedNotice)
    const existingNotice = shared.indexOf("await notify(appDataStore, existing.assigneeId, 'checklist_step_skipped', {")
    const existingTold = shared.indexOf('toldUserId = existing.assigneeId')
    expect(existingTold).toBeGreaterThan(existingNotice)
    // Nothing else sets it: the could-not-open branch tells owners, not the next person.
    expect(shared.match(/toldUserId = /g)).toHaveLength(3)
  })

  it('a saved push never answers as a failure because the next step could not be opened', () => {
    const route = pushRoute()
    const call = route.indexOf(';({ nextStep, toldUserId: stepNoticeToldId } = await openNextStepAndTell({')
    const guarded = route.lastIndexOf('try {', call)
    expect(guarded).toBeGreaterThan(route.indexOf('if (isStepPush(pushTemplate, pushed)) {'))
    const caught = route.indexOf('`[stage-advance] FAILED after push ${pushed.id}: ${error?.message || error}`', call)
    expect(caught).toBeGreaterThan(call)
    expect(route.slice(caught, caught + 200)).toContain('nextStep = null')
  })

  it('answers what happened to the next step, and a push that opens nothing answers as before', () => {
    const route = pushRoute()
    const withStep = route.indexOf('sendJson(response, 200, { checklist: pushed, completed, nextStep })')
    expect(withStep).toBeGreaterThan(-1)
    expect(route.lastIndexOf('sendJson(response, 200, { checklist: pushed, completed })')).toBeGreaterThan(withStep)
  })

  it('the shared routine words a push as a push: its own subjects, its own sentences, and the page is told which it was', () => {
    const shared = sharedRoutine()
    expect(shared).toContain("const push = mode === 'push'")
    expect(shared).toContain('const toldSubject = push ? { subject: STEP_PUSHED_SUBJECT } : {}')
    expect(shared).toContain("const after = push ? { after: 'push' } : {}")
    expect(shared).toContain('? stepPushedMessage({')
    expect(shared).toContain('? stepPushNotOpenedMessage({')
    expect(shared).toContain('subject: push ? STEP_PUSH_NOT_OPENED_SUBJECT : STEP_NOT_OPENED_SUBJECT,')
  })

  it('a second push after the next person finished tells nobody about a step, and the page is told it was finished', () => {
    const shared = sharedRoutine()
    // Decided with the roll-up every other "is this stage finished" check uses, for a push only.
    expect(shared).toContain('const existingFinished = push && (advance.finished === true || stageFinished(existing))')
    expect(shared).toContain('...(existingFinished ? { finished: true } : {}),')
    expect(shared).toContain('!existingFinished &&')
    expect(shared.indexOf('!existingFinished &&')).toBeLessThan(
      shared.indexOf("await notify(appDataStore, existing.assigneeId, 'checklist_step_skipped', {"),
    )
  })
})
