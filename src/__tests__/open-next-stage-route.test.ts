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
  it('the toggle reads the case and asks caseAllDone, no longer "the last stage finished"', () => {
    const tail = toggleRouteTail()
    expect(tail).toContain('const caseData = finishedStageWithoutSpawn ? await appDataStore.read() : null')
    expect(tail).toContain(
      '} else if (caseData && caseAllDone(caseData, updatedChecklist.caseId || updatedChecklist.id)) {',
    )
    expect(tail).not.toContain('updatedChecklist.stageIndex + 1 >= updatedChecklist.stageCount')
    expect(tail.indexOf("'case_completed'")).toBeGreaterThan(tail.indexOf('caseAllDone('))
  })
})

describe('the Activity feed wording', () => {
  it('says "opened the next step early:"', () => {
    expect(describeActivityAction('case_advanced_early')).toBe('opened the next step early:')
  })
})
