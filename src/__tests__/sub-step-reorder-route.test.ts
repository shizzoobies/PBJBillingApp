import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * POST /api/checklists/:id/items/:itemId/sub-items/reorder (featreq-8a01fe08).
 * Same shape as `waiting-blocks-checkoff-route.test.ts`: `server.js` listens at
 * module scope and exports nothing, so these read the route source and pin the
 * wiring - the permission, the body field and the store call.
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
)

const marker = 'const checklistSubItemsReorderMatch = normalizedPath.match('
const start = serverSource.indexOf(marker)
const block = serverSource.slice(start, start + 3600)

describe('POST /api/checklists/:id/items/:itemId/sub-items/reorder', () => {
  it('exists, matching exactly the reorder path', () => {
    expect(start).toBeGreaterThan(-1)
    expect(block).toContain(
      '/^\\/api\\/checklists\\/([^/]+)\\/items\\/([^/]+)\\/sub-items\\/reorder$/',
    )
  })

  it('is matched before the generic sub-items route, which would read "reorder" as an id', () => {
    const generic = serverSource.indexOf('const checklistSubItemMatch = normalizedPath.match(')
    expect(generic).toBeGreaterThan(start)
  })

  it('is POST only, behind a session', () => {
    expect(block).toContain('const session = await requireSession(request, response)')
    expect(block).toContain("if (request.method !== 'POST') {")
    expect(block).toContain("sendJson(response, 405, { error: 'Method not allowed' })")
  })

  it('refuses with the item-scoped write permission (canWriteChecklistItem), not the checklist one', () => {
    // `checklistWriteDenial` with an `item` is `canWriteChecklistItem`: owner,
    // the task's assignee, an editor, or the step's own assignee - the same
    // people who can add and delete sub-steps.
    expect(block).toContain('checklistWriteDenial({')
    expect(block).toContain('item: targetItem,')
    expect(block).toContain('visibleClientIds,')
    expect(block).toContain('sendJson(response, reorderSubDenial.status')
  })

  it('answers 404 for an unknown checklist or step and for a client out of scope', () => {
    expect(block).toContain("sendJson(response, 404, { error: 'Checklist not found' })")
    expect(block).toContain("sendJson(response, 404, { error: 'Checklist item not found' })")
    expect(block).toContain('checklistOutOfScope(checklist, visibleClientIds)')
  })

  it('reads the new order from { order: [subItemId] } and keeps only strings', () => {
    expect(block).toContain('Array.isArray(payload?.order)')
    expect(block).toContain("payload.order.filter((id) => typeof id === 'string')")
  })

  it('persists through reorderChecklistSubItems, after the permission check', () => {
    const denialAt = block.indexOf('if (reorderSubDenial) {')
    const writeAt = block.indexOf(
      'appDataStore.reorderChecklistSubItems(checklistId, itemId, order)',
    )
    expect(denialAt).toBeGreaterThan(-1)
    expect(writeAt).toBeGreaterThan(denialAt)
  })

  it('records the activity and returns the updated checklist', () => {
    expect(block).toContain("'checklist_items_reordered',")
    expect(block).toContain('sendJson(response, 200, updated)')
  })
})
