import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * `DELETE /api/checklists/:id/items/:itemId?scope=series` (featreq-01464e64).
 *
 * Same shape as waiting-lock-routes.test.ts: `server.js` exports nothing, so
 * the DECISIONS (label match, later-only, open-only, one transaction) are tested
 * in db/store-staleness.test.mjs and this reads the route source to pin the glue
 * that could rot unnoticed: the owner gate, the origin check, the order of the
 * checks, and the activity + broadcast that every other tab depends on.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const serverSource = readFileSync(path.join(root, 'server.js'), 'utf8')
const appSource = readFileSync(path.join(root, 'src/App.tsx'), 'utf8')

function seriesBlock(): string {
  const at = serverSource.indexOf("requestUrl.searchParams.get('scope') === 'series'")
  expect(at, 'series branch not found').toBeGreaterThan(-1)
  return serverSource.slice(at, at + 2200)
}

describe('the series delete route', () => {
  it('runs after the shared write gate and before a non-owner can file a request', () => {
    const at = serverSource.indexOf("requestUrl.searchParams.get('scope') === 'series'")
    const denial = serverSource.lastIndexOf("error: 'You do not have permission to delete this item'", at)
    const filing = serverSource.indexOf('fileItemDeletionRequest(request, session, data, checklist', at)
    expect(denial).toBeGreaterThan(-1)
    expect(denial).toBeLessThan(at)
    expect(at).toBeLessThan(filing)
  })

  it('refuses a non-owner with a 403 instead of falling through to a request', () => {
    const block = seriesBlock()
    expect(block).toMatch(/session\.user\.role !== 'owner'\) \{\s*sendJson\(response, 403,/)
  })

  it('checks the origin and that the checklist is part of a series', () => {
    const block = seriesBlock()
    expect(block).toContain('isCrossSiteOrigin(request)')
    expect(block).toContain('!checklist.templateId')
    expect(block.indexOf('isCrossSiteOrigin(request)')).toBeLessThan(
      block.indexOf('appDataStore.deleteChecklistItemFromSeries('),
    )
  })

  it('writes through the store, logs the activity and tells the other tabs', () => {
    const block = seriesBlock()
    const store = block.indexOf('appDataStore.deleteChecklistItemFromSeries(checklistId, itemId)')
    const activity = block.indexOf("'checklist_item_removed_series'")
    const broadcast = block.indexOf('broadcastDataChanged()')
    expect(store).toBeGreaterThan(-1)
    expect(activity).toBeGreaterThan(store)
    expect(broadcast).toBeGreaterThan(activity)
  })

  it('hands back the changed checklists and the template so the tab can merge them', () => {
    const block = seriesBlock()
    expect(block).toContain('...removal')
    expect(block).toContain('checklists: fresh.checklists.filter')
    expect(block).toContain('template: fresh.checklistTemplates.find')
  })
})

describe('the tab merges the series delete as a server update', () => {
  it('uses applyServerDataUpdate for both the checklists and the template, never the dirty-marking path', () => {
    const at = appSource.indexOf('const deleteChecklistItemFromSeries = async')
    expect(at).toBeGreaterThan(-1)
    const block = appSource.slice(at, at + 1600)
    expect(block).toContain('applyServerDataUpdate(')
    expect(block).toContain('checklistTemplates: current.checklistTemplates.map')
    expect(block).not.toContain('updateWorkspaceData(')
  })
})
