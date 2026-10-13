import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * featreq-54bf39b6: the two owner-only Board column routes carry `groupName`.
 *
 * `server.js` calls `server.listen()` at module scope and exports nothing, so -
 * like `audit-backlog-hardening.test.ts` - this reads the route source and pins
 * the GLUE. The rule itself (what is refused, how it is cleaned) lives in
 * lib/service-category-group.js and is tested there; the store's half is in
 * db/store-staleness.test.mjs.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const serverSource = readFileSync(path.join(repoRoot, 'server.js'), 'utf8')

function routeBlock(startPattern: RegExp, length = 2500): string {
  const at = serverSource.search(startPattern)
  expect(at, `route not found: ${startPattern}`).toBeGreaterThan(-1)
  return serverSource.slice(at, at + length)
}

const POST = /if \(normalizedPath === '\/api\/service-categories' && request\.method === 'POST'\)/
const PUT = /const serviceCategoryMatch = normalizedPath\.match\(/

describe('Board column routes carry a group name', () => {
  it('imports the shared rule from lib/service-category-group.js', () => {
    expect(serverSource).toMatch(
      /import \{ serviceCategoryGroupRefusal \} from '\.\/lib\/service-category-group\.js'/,
    )
  })

  for (const [name, anchor, storeCall] of [
    ['POST /api/service-categories', POST, 'appDataStore.createServiceCategory('],
    ['PUT /api/service-categories/:id', PUT, 'appDataStore.updateServiceCategory('],
  ] as const) {
    it(`${name} refuses a bad groupName with a 400 BEFORE it reaches the store`, () => {
      const block = routeBlock(anchor)
      const checkAt = block.indexOf('serviceCategoryGroupRefusal(payload?.groupName)')
      expect(checkAt, 'no groupName check in this route').toBeGreaterThan(-1)
      expect(block.slice(checkAt, checkAt + 250)).toMatch(/sendJson\(response, 400, \{ error: groupRefusal \}\)/)
      expect(checkAt).toBeGreaterThan(block.indexOf('await readJsonBody(request)'))
      expect(checkAt).toBeLessThan(block.indexOf(storeCall))
    })

    it(`${name} hands groupName to the store`, () => {
      const block = routeBlock(anchor)
      const callAt = block.indexOf(storeCall)
      expect(block.slice(callAt, callAt + 250)).toContain('groupName: payload?.groupName')
    })
  }

  it('a create stays owner-only and a name is still required', () => {
    const block = routeBlock(POST)
    expect(block).toContain("sendJson(response, 403, { error: 'Only owners can manage board columns' })")
    expect(block).toContain("sendJson(response, 400, { error: 'A column name is required' })")
  })
})
