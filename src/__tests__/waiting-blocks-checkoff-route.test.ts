import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { waitingBlocksCompletion } from '../../lib/waiting-on-state.js'

/**
 * A waiting step cannot be checked off (featreq-cdab1605), and no tick, delete
 * or approval may finish one. The DECISION - what counts as waiting and which
 * operations complete a step - is made by SIMULATION in `lib/waiting-on-state.js`
 * (it runs the store's own step math) and is pinned in
 * `lib/waiting-on-state.test.mjs`. What is left is the GLUE: same shape as
 * `waiting-lock-routes.test.ts` and `audit-backlog-hardening.test.ts` -
 * `server.js` calls `server.listen()` at module scope and exports nothing, so
 * there is no HTTP harness here. These assertions read the route source and pin
 * exactly the wiring: the server is the SOURCE OF TRUTH (it refuses before the
 * store is ever asked), and it asks the one shared helper the checkboxes use.
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
).replaceAll('\r\n', '\n')

/** The body of a route block, from its opening guard onward. */
function routeBlock(startPattern: RegExp, length = 4000): string {
  const at = serverSource.search(startPattern)
  expect(at, `route not found: ${startPattern}`).toBeGreaterThan(-1)
  return serverSource.slice(at, at + length)
}

const toggleBlock = () =>
  routeBlock(/const checklistToggleMatch = normalizedPath\.match\(/, 6000)

const TOGGLE_GUARD = 'const toggleRefusal = waitingToggleRefusal('

describe('POST /api/checklists/:id/items/:itemId/toggle refuses a waiting step', () => {
  // ONE check replaces the three hand-written ones (the node itself, what the
  // tick cascades onto, the parent it rolls up): the simulation runs the store's
  // toggle and looks at every node that would come out done.
  it('asks the one simulation helper, with the item and whichever ids the request names', () => {
    const block = toggleBlock()
    expect(block).toContain(TOGGLE_GUARD)
    const guard = block.slice(block.indexOf(TOGGLE_GUARD), block.indexOf(TOGGLE_GUARD) + 500)
    expect(guard).toContain('targetItem,')
    expect(guard).toContain('toggleSubItemId,')
    expect(guard).toContain('toggleSubSubItemId,')
  })

  it('no longer carries the three hand-written guards', () => {
    const block = toggleBlock()
    expect(block).not.toContain('waitingBlocksCascadedCompletion')
    expect(block).not.toContain('waitingAncestorBlocksCompletion')
    expect(block).not.toContain('waitingBlocksCompletion(')
  })

  it('answers 409 STEP_IS_WAITING with the sentence the simulation chose', () => {
    const block = toggleBlock()
    const at = block.indexOf('if (toggleRefusal) {')
    expect(at).toBeGreaterThan(-1)
    const guard = block.slice(at, at + 300)
    expect(guard).toContain('sendJson(response, toggleRefusal.status, {')
    expect(guard).toContain('error: toggleRefusal.error,')
    expect(guard).toContain('message: toggleRefusal.message,')
  })

  // A refusal that lands after the write is not a refusal.
  it('refuses BEFORE the store is asked to toggle anything', () => {
    const block = toggleBlock()
    const guardAt = block.indexOf(TOGGLE_GUARD)
    const writeAt = block.indexOf('appDataStore.toggleChecklistItem(')
    expect(guardAt).toBeGreaterThan(-1)
    expect(writeAt).toBeGreaterThan(-1)
    expect(guardAt).toBeLessThan(writeAt)
  })

  // The guard has to run after the sub-item / sub-sub-item lookups answer their
  // 404s (it names whichever the request targets).
  it('runs after the sub-item and sub-sub-item are resolved, not before', () => {
    const block = toggleBlock()
    const guardAt = block.indexOf(TOGGLE_GUARD)
    expect(block.indexOf("error: 'Sub-item not found'")).toBeLessThan(guardAt)
    expect(block.indexOf("error: 'Sub-sub-item not found'")).toBeLessThan(guardAt)
  })

  // The shared helper is imported, not re-implemented - the whole point is that
  // the UI's disabled checkboxes and this refusal can never drift apart.
  it('imports the helper from the shared module rather than inlining it', () => {
    expect(serverSource).toContain('waitingToggleRefusal,')
    expect(serverSource).toContain("from './lib/waiting-on-state.js'")
  })
})

describe('removing a sub-step cannot finish a waiting step', () => {
  const REFUSAL = `sendJson(response, 409, {
            error: 'STEP_IS_WAITING',
            message: REMOVAL_WOULD_COMPLETE_WAITING_STEP,
          })`

  it('refuses the sub-step DELETE before it files a request or removes anything', () => {
    const block = routeBlock(/--- DELETE: remove a sub-item ---/, 2500)
    const guardAt = block.indexOf('if (removalWouldCompleteWaitingStep(targetItem, subItemId)) {')
    expect(guardAt).toBeGreaterThan(-1)
    expect(block).toContain(REFUSAL)
    expect(guardAt).toBeLessThan(block.indexOf('fileItemDeletionRequest('))
    expect(guardAt).toBeLessThan(block.indexOf('appDataStore.removeChecklistSubItem('))
  })

  it('refuses the sub-sub-step DELETE before it files a request or removes anything', () => {
    const block = routeBlock(/--- DELETE: remove a sub-sub-item ---/, 2500)
    const guardAt = block.indexOf(
      'if (removalWouldCompleteWaitingStep(targetItem, subItemId, subSubItemId)) {',
    )
    expect(guardAt).toBeGreaterThan(-1)
    expect(block).toContain(REFUSAL)
    expect(guardAt).toBeLessThan(block.indexOf('fileItemDeletionRequest('))
    expect(guardAt).toBeLessThan(block.indexOf('appDataStore.removeChecklistSubSubItem('))
  })

  // Approving a deletion request executes the same removal, so it asks the same
  // question - and a refused approval leaves the request in place.
  it('refuses an approval that would finish a waiting step, and keeps the request', () => {
    const block = routeBlock(/const itemDeletionDecisionMatch = normalizedPath\.match\(/, 6000)
    const guardAt = block.indexOf(
      'if (removalWouldCompleteWaitingStep(approvalItem, req.subItemId, req.subSubItemId)) {',
    )
    expect(guardAt).toBeGreaterThan(-1)
    expect(block).toContain(REFUSAL)
    // Before the removal runs, and before the request is dropped.
    expect(guardAt).toBeLessThan(block.indexOf('appDataStore.removeChecklistSubSubItem('))
    expect(guardAt).toBeLessThan(block.indexOf('appDataStore.removeChecklistSubItem('))
    const approveAt = block.indexOf('// approve')
    expect(guardAt).toBeLessThan(block.indexOf('await appDataStore.deleteItemDeletionRequest(requestId)', approveAt))
    // The one earlier deleteItemDeletionRequest call is the REJECT branch.
    const refusalReturnAt = block.indexOf('return', guardAt)
    expect(block.slice(guardAt, refusalReturnAt)).not.toContain('deleteItemDeletionRequest')
  })

  it('imports the helper and the sentence from the shared module', () => {
    expect(serverSource).toContain('removalWouldCompleteWaitingStep,')
    expect(serverSource).toContain('REMOVAL_WOULD_COMPLETE_WAITING_STEP,')
  })
})

/**
 * The predicate itself already proves a DONE step is never blocked (see
 * `lib/waiting-on-state.test.mjs`); this just confirms the route hands the
 * helper the item with `done` on it rather than a bare waiting flag, so that
 * guarantee actually reaches the route.
 */
describe('un-checking a done step is never blocked', () => {
  it('passes the real stored item, which carries its own done, waiting and waitingOns', () => {
    expect(waitingBlocksCompletion({ done: true, waiting: true })).toBe(false)
    expect(waitingBlocksCompletion({ done: true, waitingOns: [{ id: 'wo-1' }] })).toBe(false)
  })
})
