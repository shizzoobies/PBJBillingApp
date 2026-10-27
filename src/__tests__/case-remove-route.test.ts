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

function restoreRoute(): string {
  const start = serverSource.indexOf('if (checklistRestoreMatch) {')
  expect(start).toBeGreaterThan(-1)
  return serverSource.slice(start, serverSource.indexOf('\n    }\n', start))
}

describe('POST /api/cases/:caseId/remove', () => {
  it('matches the path ahead of the case timeline GET', () => {
    const route = removeCaseRoute()
    expect(route).toContain('/^\\/api\\/cases\\/([^/]+)\\/remove$/')
    expect(serverSource.indexOf('const caseRemoveMatch')).toBeLessThan(serverSource.indexOf('const caseDetailMatch'))
  })

  it('needs a session, POST, the owner, a same-site origin and no preview - all before the body or the store', () => {
    const route = removeCaseRoute()
    const session = route.indexOf('await requireSession(request, response)')
    const method = route.indexOf("request.method !== 'POST'")
    const owner = route.indexOf("session.user.role !== 'owner'")
    const origin = route.indexOf('isCrossSiteOrigin(request)')
    const preview = route.indexOf("request.headers['x-preview-as']")
    const body = route.indexOf('await readJsonBody(request)')
    const store = route.indexOf('appDataStore.removeCase(')
    expect(session).toBeGreaterThan(-1)
    for (const check of [method, owner, origin, preview]) {
      expect(check).toBeGreaterThan(session)
      expect(body).toBeGreaterThan(check)
      expect(store).toBeGreaterThan(check)
    }
    expect(route).toContain("sendJson(response, 403, { error: 'Only owners can remove a case' })")
    expect(route.indexOf('appDataStore.')).toBe(store)
  })

  it('a malformed case id is a 404, and the body must name the client (400 without)', () => {
    const route = removeCaseRoute()
    const decode = route.indexOf('caseId = decodeURIComponent(caseRemoveMatch[1])')
    expect(route.slice(route.lastIndexOf('try {', decode), decode)).toContain('try {')
    expect(route.slice(decode, decode + 160)).toContain("sendJson(response, 404, { error: 'Case not found' })")
    expect(route).toContain("const clientId = typeof payload?.clientId === 'string' ? payload.clientId.trim() : ''")
    const missing = route.indexOf('if (!clientId) {')
    expect(route.slice(missing, missing + 120)).toContain('sendJson(response, 400,')
    expect(missing).toBeLessThan(route.indexOf('appDataStore.removeCase('))
  })

  it('removes that client\'s steps of the case as the signed-in owner, and answers 404 for no live step', () => {
    const route = removeCaseRoute()
    expect(route).toContain('appDataStore.removeCase(caseId, { clientId, userId: session.user.id })')
    const miss = route.indexOf('if (!removal) {')
    expect(miss).toBeGreaterThan(route.indexOf('appDataStore.removeCase('))
    expect(route.slice(miss, miss + 120)).toContain("sendJson(response, 404, { error: 'Case not found' })")
  })

  it('records case_removed (first step title, client, count) without letting bookkeeping fail a done removal', () => {
    const route = removeCaseRoute()
    expect(route).toContain("'case_removed',")
    expect(route).toContain('`${caseTitle} · ${clientLabel} · case ${caseId} · ${stepCount} step')
    expect(route).toContain("const caseTitle = first?.title || 'Case'")
    // read, the notes pass and the activity row sit inside one try; 200 after it.
    const guard = route.indexOf('try {', route.indexOf('if (!removal) {'))
    const read = route.indexOf('await appDataStore.read()')
    const activity = route.indexOf("'case_removed',")
    const caught = route.indexOf('} catch (error) {', activity)
    const answer = route.indexOf('sendJson(response, 200')
    expect(guard).toBeLessThan(read)
    expect(activity).toBeLessThan(caught)
    expect(caught).toBeLessThan(answer)
    expect(route).toContain('removed: removal.removedIds,')
    expect(route).toContain('deletedAt: removal.deletedAt,')
    // A pending note stamped on a removed step is free again (as on deletion approve).
    expect(route).toContain('appDataStore.attachPendingClientNotes({ clientId })')
    expect(describeActivityAction('case_removed')).toBe('removed case')
  })
})

describe('POST /api/checklists/:id/restore and a cycle that is live again', () => {
  it('answers 409 restore_conflict with the sentence, and rethrows anything else', () => {
    const route = restoreRoute()
    expect(route).toContain('error instanceof RestoreConflictError')
    expect(route).toContain("sendJson(response, 409, { error: 'restore_conflict', message: error.message })")
    expect(route.indexOf('throw error')).toBeGreaterThan(route.indexOf('error instanceof RestoreConflictError'))
  })
})
