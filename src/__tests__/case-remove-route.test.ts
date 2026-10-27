import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { describeActivityAction } from '../lib/utils'

/**
 * Remove case (2026-10-27, Alex for Brittany): the route glue. The store moves
 * the rows and answers null for an unknown case (db/store-staleness.test.mjs,
 * both backends). `server.js` is not booted by tests, so the route is read as
 * source, like open-next-stage-route.test.ts.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const serverSource = readFileSync(path.join(root, 'server.js'), 'utf8').replaceAll('\r\n', '\n')

function removeCaseRoute(): string {
  const start = serverSource.indexOf('const caseRemoveMatch = normalizedPath.match(')
  expect(start).toBeGreaterThan(-1)
  const end = serverSource.indexOf('// ---- Phase 3: case timeline ----', start)
  expect(end).toBeGreaterThan(start)
  return serverSource.slice(start, end)
}

describe('POST /api/cases/:caseId/remove', () => {
  it('matches the path ahead of the case timeline GET', () => {
    const route = removeCaseRoute()
    expect(route).toContain('/^\\/api\\/cases\\/([^/]+)\\/remove$/')
    expect(serverSource.indexOf('const caseRemoveMatch')).toBeLessThan(serverSource.indexOf('const caseDetailMatch'))
  })

  it('needs a session, POST, the owner, a same-site origin and no preview - all before the store', () => {
    const route = removeCaseRoute()
    const session = route.indexOf('await requireSession(request, response)')
    const method = route.indexOf("request.method !== 'POST'")
    const owner = route.indexOf("session.user.role !== 'owner'")
    const origin = route.indexOf('isCrossSiteOrigin(request)')
    const preview = route.indexOf("request.headers['x-preview-as']")
    const store = route.indexOf('appDataStore.removeCase(')
    expect(session).toBeGreaterThan(-1)
    for (const check of [method, owner, origin, preview]) {
      expect(check).toBeGreaterThan(session)
      expect(store).toBeGreaterThan(check)
    }
    expect(route).toContain("sendJson(response, 403, { error: 'Only owners can remove a case' })")
    expect(route.indexOf('appDataStore.')).toBe(store)
  })

  it('removes by the decoded case id as the signed-in owner, and answers 404 for no live step', () => {
    const route = removeCaseRoute()
    expect(route).toContain('const caseId = decodeURIComponent(caseRemoveMatch[1])')
    expect(route).toContain('appDataStore.removeCase(caseId, { userId: session.user.id })')
    const miss = route.indexOf('if (!removal) {')
    expect(miss).toBeGreaterThan(route.indexOf('appDataStore.removeCase('))
    expect(route.slice(miss, miss + 120)).toContain("sendJson(response, 404, { error: 'Case not found' })")
  })

  it('records case_removed with the case title, client and step count, then answers the removed ids and stamp', () => {
    const route = removeCaseRoute()
    expect(route).toContain("'case_removed',")
    expect(route).toContain('`${caseTitle} · ${clientLabel} · case ${caseId} · ${stepCount} step')
    expect(route).toContain('removed: removal.removedIds,')
    expect(route).toContain('deletedAt: removal.deletedAt,')
    expect(route.indexOf("'case_removed',")).toBeLessThan(route.indexOf('sendJson(response, 200'))
    // A pending note stamped on a removed step is free again.
    expect(route).toContain('appDataStore.attachPendingClientNotes({ clientId })')
    expect(describeActivityAction('case_removed')).toBe('removed case')
  })
})
