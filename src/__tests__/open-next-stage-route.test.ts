import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { describeActivityAction } from '../lib/utils'

/**
 * Open next step now (featreq-8b54d117): the route glue. The store decides and
 * refuses (db/store-staleness.test.mjs, both backends); the sentences and the
 * case completion rule are pure (lib/open-next-stage.test.mjs). `server.js` is
 * not booted by tests, so the route is read as source, like
 * stage-advance-hardening-route.test.ts.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (file: string) => readFileSync(path.join(root, file), 'utf8').replaceAll('\r\n', '\n')
const serverSource = read('server.js')

function openNextStageRoute(): string {
  const start = serverSource.indexOf('const checklistOpenNextStageMatch = normalizedPath.match(')
  expect(start).toBeGreaterThan(-1)
  const end = serverSource.indexOf('const checklistToggleMatch = normalizedPath.match(', start)
  expect(end).toBeGreaterThan(start)
  return serverSource.slice(start, end)
}

function toggleRouteTail(): string {
  const start = serverSource.indexOf('toggleResult = await appDataStore.toggleChecklistItem(')
  const send = serverSource.indexOf('sendJson(response, 200,', start)
  return serverSource.slice(start, serverSource.indexOf('\n', send) + 1)
}

describe('POST /api/checklists/:id/open-next-stage', () => {
  it('matches the path, needs a session, POST, a same-site origin and no preview', () => {
    const route = openNextStageRoute()
    expect(route).toContain('/^\\/api\\/checklists\\/([^/]+)\\/open-next-stage$/')
    const session = route.indexOf('await requireSession(request, response)')
    const origin = route.indexOf('isCrossSiteOrigin(request)')
    const preview = route.indexOf("request.headers['x-preview-as']")
    const store = route.indexOf('appDataStore.openNextStageEarly(')
    expect(session).toBeGreaterThan(-1)
    expect(origin).toBeGreaterThan(session)
    expect(preview).toBeGreaterThan(session)
    expect(store).toBeGreaterThan(Math.max(origin, preview))
    expect(route).toContain("request.method !== 'POST'")
  })

  it('lets only the owner or the checklist assignee open it, and hides out-of-scope tasks', () => {
    const route = openNextStageRoute()
    expect(route).toContain('checklistOutOfScope(checklist, visibleClientIdSet(session, data))')
    expect(route).toContain("session.user.role === 'owner' || checklist.assigneeId === session.user.id")
    expect(route.indexOf('sendJson(response, 403')).toBeLessThan(route.indexOf('appDataStore.openNextStageEarly('))
  })

  it('answers a refusal as 409 next_stage_refused with the reason and a sentence', () => {
    const route = openNextStageRoute()
    expect(route).toContain('error instanceof NextStageRefusedError')
    expect(route).toContain("error: 'next_stage_refused'")
    expect(route).toContain('reason: error.reason')
    expect(route).toContain('message: nextStageRefusalMessage(error.reason, {')
  })

  it('records case_advanced_early, notifies the next assignee, answers { checklist, spawned }', () => {
    const route = openNextStageRoute()
    const activity = route.indexOf("'case_advanced_early'")
    expect(activity).toBeGreaterThan(route.indexOf('appDataStore.openNextStageEarly('))
    expect(route).toContain(
      '`${from.title} · case ${caseId} · stage ${fromIdx} -> stage ${fromIdx + 1} (opened while waiting)`',
    )
    const notifyAt = route.indexOf("await notify(appDataStore, nextAssigneeId, 'task_assigned', {")
    expect(notifyAt).toBeGreaterThan(activity)
    expect(route).toContain('if (nextAssigneeId && nextAssigneeId !== session.user.id)')
    expect(route).toContain('sendJson(response, 200, { checklist: from, spawned })')
  })
})

describe('case_completed waits for every stage of the case', () => {
  const completedGate = () => {
    const tail = toggleRouteTail()
    const start = tail.indexOf('} else if (\n        finishedStageWithoutSpawn &&')
    expect(start).toBeGreaterThan(-1)
    return tail.slice(start, tail.indexOf(') {', start))
  }

  it('the toggle reads the workspace ONCE for the waiting notices and the case check', () => {
    const tail = toggleRouteTail()
    expect(tail).toContain(
      'const allData = justCompleted || finishedStageWithoutSpawn ? await appDataStore.read() : null',
    )
    expect(tail.split('appDataStore.read()')).toHaveLength(2)
    expect(tail).toContain('const data = allData')
  })

  it('fires only from the final stage, or an earlier stage that finds the next one already open', () => {
    expect(completedGate()).toContain(
      '(updatedChecklist.stageIndex + 1 >= updatedChecklist.stageCount ||\n          toggleResult.spawnReason === \'already_spawned\')',
    )
  })

  it('needs every stage of the case done (caseAllDone)', () => {
    expect(completedGate()).toContain('caseAllDone(allData, updatedChecklist.caseId || updatedChecklist.id)')
  })

  it('says it once per case: an untick/retick of a finished case finds the earlier row', () => {
    const gate = completedGate()
    expect(gate).toContain(
      '!(await appDataStore.hasCaseCompletedActivity(updatedChecklist.caseId || updatedChecklist.id))',
    )
    // Checked last, so the lookup runs only when everything else says "complete".
    expect(gate.indexOf('hasCaseCompletedActivity')).toBeGreaterThan(gate.indexOf('caseAllDone('))
    const tail = toggleRouteTail()
    expect(tail.indexOf("'case_completed'")).toBeGreaterThan(tail.indexOf('hasCaseCompletedActivity'))
  })
})

describe('the skip route runs the same completion check', () => {
  const skipRoute = () => {
    const start = serverSource.indexOf('const checklistSkipMatch = normalizedPath.match(')
    expect(start).toBeGreaterThan(-1)
    const end = serverSource.indexOf('const checklistPushMatch = normalizedPath.match(', start)
    expect(end).toBeGreaterThan(start)
    return serverSource.slice(start, end)
  }

  it('after the skip is saved, reads the workspace, checks skipCompletesCase and says it once per case', () => {
    const route = skipRoute()
    const saved = route.indexOf('await appDataStore.skipChecklistInstance(')
    const check = route.indexOf('skipCompletesCase(after, skipped)')
    const once = route.indexOf('hasCaseCompletedActivity(caseId)')
    const recorded = route.indexOf("'case_completed'")
    expect(saved).toBeGreaterThan(-1)
    expect(check).toBeGreaterThan(saved)
    expect(once).toBeGreaterThan(check)
    expect(recorded).toBeGreaterThan(once)
    expect(route.indexOf('sendJson(response, 200, { checklist: skipped, skip: record })')).toBeGreaterThan(recorded)
  })

  it('checks the case is staged BEFORE the workspace read', () => {
    const route = skipRoute()
    const staged = route.indexOf("typeof skipped.stageCount === 'number' && skipped.stageCount > 1")
    const read = route.indexOf('const after = staged ? await appDataStore.read() : null')
    expect(staged).toBeGreaterThan(-1)
    expect(read).toBeGreaterThan(staged)
    expect(route).toContain('if (staged && skipCompletesCase(after, skipped)')
  })

  it('a failure in the check is logged, never a 500 for a saved skip', () => {
    expect(skipRoute()).toContain("console.error('[checklist-skip] case_completed check failed:'")
  })
})

describe('the Activity feed wording', () => {
  it('says "opened the next step early:"', () => {
    expect(describeActivityAction('case_advanced_early')).toBe('opened the next step early:')
  })
})
