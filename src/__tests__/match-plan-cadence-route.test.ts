import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * "Match plan" (featreq-acdd0c84 B3): POST /api/checklist-templates/:id/match-plan-cadence.
 *
 * The same shape as package-routes.test.ts: `server.js` listens at module scope
 * and exports nothing, so this pins the route's GLUE - owner-only, same-origin, a
 * plan id required, the targeted store method (never the bulk save), a refusal as
 * 409 with its sentence, 404 for an unknown template, and the other tabs told.
 * The behavior lives in `matchTemplateToPlanCadence`, exercised on both backends
 * in db/store-staleness.test.mjs.
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
).replaceAll('\r\n', '\n')

const block = () => {
  const at = serverSource.indexOf("    if (matchPlanCadenceMatch && request.method === 'POST') {\n")
  expect(at, 'route not found').toBeGreaterThan(-1)
  const end = serverSource.indexOf('\n    }\n', at)
  return serverSource.slice(at, end)
}

describe('POST /api/checklist-templates/:id/match-plan-cadence', () => {
  it('matches the path', () => {
    expect(serverSource).toContain(
      'const matchPlanCadenceMatch = normalizedPath.match(\n      /^\\/api\\/checklist-templates\\/([^/]+)\\/match-plan-cadence$/,\n    )',
    )
  })

  it('requires a session and refuses a non-owner with 403', () => {
    const text = block()
    expect(text).toContain('await requireSession(request, response)')
    expect(text).toMatch(/session\.user\.role !== 'owner'\) \{\s+sendJson\(response, 403,/)
  })

  it('blocks a cross-site request', () => {
    expect(block()).toContain("sendJson(response, 403, { error: 'Origin not allowed' })")
  })

  it('requires a plan id (400)', () => {
    const text = block()
    expect(text).toContain("typeof payload?.planId === 'string' ? payload.planId : ''")
    expect(text).toContain("sendJson(response, 400, { error: 'A plan is required' })")
  })

  it('goes through the targeted store method, not the bulk save', () => {
    const text = block()
    expect(text).toContain('appDataStore.matchTemplateToPlanCadence(matchPlanCadenceMatch[1], planId)')
    expect(text).not.toContain('appDataStore.write(')
  })

  it("answers a refusal as 409 with the store's reason and sentence, and re-throws anything else", () => {
    const text = block()
    expect(text).toContain('error instanceof PlanCadenceMatchError')
    expect(text).toContain('sendJson(response, 409, { error: error.reason, message: error.message })')
    expect(text).toContain('throw error')
  })

  it('answers 404 for an unknown template, and the updated template otherwise, telling the other tabs', () => {
    const text = block()
    expect(text).toContain("sendJson(response, 404, { error: 'Template not found' })")
    expect(text.indexOf('broadcastDataChanged()')).toBeLessThan(text.indexOf('sendJson(response, 200, updated)'))
  })

  it('imports the refusal class from the store', () => {
    expect(serverSource.slice(0, 3000)).toMatch(/\n {2}PlanCadenceMatchError,\n/)
  })
})
