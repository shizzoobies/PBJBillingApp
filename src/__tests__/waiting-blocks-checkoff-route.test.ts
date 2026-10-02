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
 * exactly the wiring: the server is the SOURCE OF TRUTH, and the toggle's refusal
 * is decided inside the store (`StepIsWaitingError`), on the row it is about to
 * write, with the one shared helper the checkboxes use.
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

const storeSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db/store.js'),
  'utf8',
).replaceAll('\r\n', '\n')

describe('POST /api/checklists/:id/items/:itemId/toggle refuses a waiting step', () => {
  // ONE decision, in ONE place: the store runs the toggle's own math on the row
  // it is about to write and refuses when a waiting, not-yet-done node would come
  // out done. The route used to ask first, against a copy of the checklist read
  // before the store's read-modify-write, so a wait added in between was not seen.
  it('no longer asks the simulation itself - the copy it would ask about can be out of date', () => {
    const block = toggleBlock()
    expect(block).not.toContain('waitingToggleRefusal(')
    expect(block).not.toContain('toggleRefusal')
    expect(serverSource).not.toContain('waitingToggleRefusal')
  })

  it('no longer carries the three hand-written guards', () => {
    const block = toggleBlock()
    expect(block).not.toContain('waitingBlocksCascadedCompletion')
    expect(block).not.toContain('waitingAncestorBlocksCompletion')
    expect(block).not.toContain('waitingBlocksCompletion(')
  })

  it('answers 409 STEP_IS_WAITING with the sentence the store carried', () => {
    const block = toggleBlock()
    const at = block.indexOf('if (error instanceof StepIsWaitingError) {')
    expect(at).toBeGreaterThan(-1)
    const guard = block.slice(at, at + 400)
    expect(guard).toContain('sendJson(response, error.refusal.status, {')
    expect(guard).toContain('error: error.refusal.error,')
    expect(guard).toContain('message: error.refusal.message,')
    // Anything else is not this route's to swallow.
    expect(block.slice(at, at + 600)).toContain('throw error')
    expect(serverSource).toContain('StepIsWaitingError,')
  })

  // A refusal that lands after the write is not a refusal: the store throws
  // before its UPDATE / file write, in both backends.
  it('the store decides on the row it is about to write, before it writes', () => {
    const start = storeSource.indexOf('async toggleChecklistItem(')
    const end = storeSource.indexOf('async maybeSpawnNextStage(', start)
    expect(start).toBeGreaterThan(-1)
    const method = storeSource.slice(start, end)
    const guard = 'const refusal = waitingToggleRefusal('
    // Postgres: inside the transaction, on the row read `for update`.
    const select = method.indexOf('where checklist_id = $1 and id = $2 for update')
    const pgGuard = method.indexOf(guard)
    const pgWrite = method.indexOf('update checklist_items', pgGuard)
    expect(select).toBeGreaterThan(-1)
    expect(pgGuard).toBeGreaterThan(select)
    expect(pgWrite).toBeGreaterThan(pgGuard)
    expect(method.slice(pgGuard, pgGuard + 300)).toContain('throw new StepIsWaitingError(refusal)')
    // File backend: inside the queue slot, on the fresh read, before the write.
    const slot = method.indexOf('return enqueueFileOperation(localDataPath, async () => {')
    const fileGuard = method.indexOf(guard, pgGuard + 1)
    const fileWrite = method.indexOf('await fsWriteFile(localDataPath', fileGuard)
    expect(slot).toBeGreaterThan(pgWrite)
    expect(fileGuard).toBeGreaterThan(slot)
    expect(fileWrite).toBeGreaterThan(fileGuard)
    expect(method.slice(fileGuard, fileGuard + 300)).toContain('throw new StepIsWaitingError(refusal)')
  })

  // The sub-item / sub-sub-item lookups still answer their 404s first, ahead of
  // the store call.
  it('still resolves the sub-item and sub-sub-item before it asks the store', () => {
    const block = toggleBlock()
    const writeAt = block.indexOf('appDataStore.toggleChecklistItem(')
    expect(writeAt).toBeGreaterThan(-1)
    expect(block.indexOf("error: 'Sub-item not found'")).toBeLessThan(writeAt)
    expect(block.indexOf("error: 'Sub-sub-item not found'")).toBeLessThan(writeAt)
  })

  // The shared helper is imported by the store, not re-implemented - the whole
  // point is that the UI's disabled checkboxes and this refusal can never drift apart.
  it('the store imports the helper from the shared module rather than inlining it', () => {
    expect(storeSource).toContain('waitingToggleRefusal,')
    expect(storeSource).toContain("from '../lib/waiting-on-state.js'")
  })
})

/**
 * The owner is the exception (featreq-8a01fe08): she is usually the person being
 * waited on, so her tick is not refused. The same simulation decides there is a
 * wait to close, and the store closes it in the SAME write as the toggle when it
 * is handed her id. What a closed wait looks like is pinned in
 * `lib/waiting-on-state.test.mjs` (the pure function) and
 * `db/store-staleness.test.mjs` (both backends); this is the route glue.
 */
describe('POST /api/checklists/:id/items/:itemId/toggle lets the owner tick a waiting step', () => {
  // The loop that records the closed waits sits past the default slice.
  const longToggleBlock = () =>
    routeBlock(/const checklistToggleMatch = normalizedPath\.match\(/, 9000)

  it('exempts only a signed-in owner: staff get the store\'s refusal, the very same 409 as before', () => {
    const block = longToggleBlock()
    const call = block.slice(block.indexOf('appDataStore.toggleChecklistItem('))
    expect(call.slice(0, 400)).toContain(
      "session.user.role === 'owner' ? { closeWaitsBy: session.user.id } : undefined,",
    )
    expect(block).toContain('if (error instanceof StepIsWaitingError) {')
  })

  it('hands the store the owner id so the wait closes in the same write, and nothing otherwise', () => {
    const block = longToggleBlock()
    const call = block.slice(block.indexOf('appDataStore.toggleChecklistItem('))
    expect(call.slice(0, 400)).toContain(
      "session.user.role === 'owner' ? { closeWaitsBy: session.user.id } : undefined,",
    )
  })

  it('records one waiting_on_verified per wait the tick closed, worded like the verify route', () => {
    const block = longToggleBlock()
    const at = block.indexOf('for (const closed of toggleResult.closedWaits ?? []) {')
    expect(at).toBeGreaterThan(-1)
    const loop = block.slice(at, at + 400)
    expect(loop).toContain("'waiting_on_verified',")
    expect(loop).toContain('`${updatedChecklist.title}: ${closed.label}`')
    // After the normal checked-off entry, which is still recorded.
    expect(block.indexOf('checklist_item_checked')).toBeLessThan(at)
  })

  // Preview-as stays read-only: the write is rejected for the previewing owner
  // before any route runs, so the exemption above can never fire under it.
  it('is still behind the preview-mode write refusal', () => {
    const gateAt = serverSource.indexOf("sendJson(response, 403, { error: 'Preview mode is read-only' })")
    const routeAt = serverSource.search(/const checklistToggleMatch = normalizedPath\.match\(/)
    expect(gateAt).toBeGreaterThan(-1)
    expect(gateAt).toBeLessThan(routeAt)
  })

  it('does not widen the one place it must stay narrow: a non-owner never carries the option', () => {
    // The only caller of closeWaitsBy in the server is this route, behind the owner gate.
    expect(serverSource.match(/closeWaitsBy:/g)).toHaveLength(1)
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
    // The window is wide enough to reach the approve branch's drop of the request
    // past the early open-wait check and the store-refusal catch.
    const block = routeBlock(/const itemDeletionDecisionMatch = normalizedPath\.match\(/, 7500)
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

/**
 * A sub-step or sub-sub-step with an open saved wait cannot be deleted
 * (featreq-1f352c4f). The decision is the store's, on the row as it is now
 * (`StepHasOpenWaitError`, pinned in `db/store-staleness.test.mjs`); the routes
 * also ask early from their own copy so a staff member's request is never filed
 * for a node that can never be approved, and an approval is refused with the
 * request left in place. Same glue-reading shape as the block above.
 */
describe('a step with an open wait cannot be deleted', () => {
  const GUARD_BODY = `sendJson(response, openWaitRefusal.status, {
            error: openWaitRefusal.error,
            message: openWaitRefusal.message,
          })`

  it('refuses the sub-step DELETE for owners and staff alike, before any request is filed or anything removed', () => {
    const block = routeBlock(/--- DELETE: remove a sub-item ---/, 3500)
    const guardAt = block.indexOf('const openWaitRefusal = removalOpenWaitRefusal(targetItem, subItemId)')
    expect(guardAt).toBeGreaterThan(-1)
    expect(block).toContain(GUARD_BODY)
    expect(guardAt).toBeLessThan(block.indexOf('removalWouldCompleteWaitingStep('))
    expect(guardAt).toBeLessThan(block.indexOf("session.user.role !== 'owner'"))
    expect(guardAt).toBeLessThan(block.indexOf('fileItemDeletionRequest('))
    expect(guardAt).toBeLessThan(block.indexOf('appDataStore.removeChecklistSubItem('))
  })

  it('refuses the sub-sub-step DELETE the same way', () => {
    const block = routeBlock(/--- DELETE: remove a sub-sub-item ---/, 3500)
    const guardAt = block.indexOf(
      'const openWaitRefusal = removalOpenWaitRefusal(targetItem, subItemId, subSubItemId)',
    )
    expect(guardAt).toBeGreaterThan(-1)
    expect(block).toContain(GUARD_BODY)
    expect(guardAt).toBeLessThan(block.indexOf('removalWouldCompleteWaitingStep('))
    expect(guardAt).toBeLessThan(block.indexOf("session.user.role !== 'owner'"))
    expect(guardAt).toBeLessThan(block.indexOf('fileItemDeletionRequest('))
    expect(guardAt).toBeLessThan(block.indexOf('appDataStore.removeChecklistSubSubItem('))
  })

  it('refuses an approval, before it removes anything, and keeps the request', () => {
    const block = routeBlock(/const itemDeletionDecisionMatch = normalizedPath\.match\(/, 7500)
    const guardAt = block.indexOf(
      'const approvalOpenWait = removalOpenWaitRefusal(approvalItem, req.subItemId, req.subSubItemId)',
    )
    expect(guardAt).toBeGreaterThan(-1)
    expect(block.slice(guardAt, guardAt + 400)).toContain('sendJson(response, approvalOpenWait.status, {')
    expect(guardAt).toBeLessThan(block.indexOf('removalWouldCompleteWaitingStep(approvalItem'))
    expect(guardAt).toBeLessThan(block.indexOf('appDataStore.removeChecklistSubSubItem('))
    expect(guardAt).toBeLessThan(block.indexOf('appDataStore.removeChecklistSubItem('))
    // The refusal returns before the request is dropped.
    const refusalReturnAt = block.indexOf('return', guardAt)
    expect(block.slice(guardAt, refusalReturnAt)).not.toContain('deleteItemDeletionRequest')
  })

  it('answers the store\'s own refusal as the same 409 on all three paths, and leaves the request in place', () => {
    expect(serverSource).toContain('StepHasOpenWaitError,')
    expect(serverSource).toContain('removalOpenWaitRefusal,')
    const helper = serverSource.slice(serverSource.indexOf('function removalRefusalBody(error) {'))
    expect(helper.slice(0, 400)).toContain(
      'if (error instanceof StepHasOpenWaitError || error instanceof StepIsWaitingError) {',
    )
    // Three callers: the two DELETE routes and the approval.
    expect(serverSource.split('const refusalBody = removalRefusalBody(error)').length - 1).toBe(3)
    expect(serverSource.split('if (!refusalBody) throw error').length - 1).toBe(3)
    const approval = routeBlock(/const itemDeletionDecisionMatch = normalizedPath\.match\(/, 7500)
    const catchAt = approval.indexOf('const refusalBody = removalRefusalBody(error)')
    const dropAt = approval.indexOf('await appDataStore.deleteItemDeletionRequest(requestId)', catchAt)
    expect(catchAt).toBeGreaterThan(-1)
    expect(dropAt).toBeGreaterThan(catchAt)
    expect(approval.slice(catchAt, dropAt)).toContain('sendJson(response, 409, refusalBody)')
    expect(approval.slice(catchAt, dropAt)).toContain('return')
  })

  it('the store decides inside the locked row / queue slot, before it writes (both backends)', () => {
    for (const method of ['async removeChecklistSubItem(', 'async removeChecklistSubSubItem(']) {
      const start = storeSource.indexOf(method)
      const end = storeSource.indexOf('// ---- Structured', start)
      expect(start).toBeGreaterThan(-1)
      const body = storeSource.slice(start, method.includes('SubSub') ? end : storeSource.indexOf('async reorderChecklistSubItems(', start))
      // Postgres: inside the callback `_withLockedChecklistItem` runs on the locked row.
      const pgGuard = body.indexOf('assertRemovalAllowed(mapped,')
      expect(pgGuard).toBeGreaterThan(body.indexOf('_withLockedChecklistItem('))
      expect(pgGuard).toBeLessThan(body.indexOf('update checklist_items'))
      // File: inside the queue slot's edit callback, before the removal math.
      const fileGuard = body.indexOf('assertRemovalAllowed(item,')
      expect(fileGuard).toBeGreaterThan(body.indexOf('_withFileChecklistItem('))
    }
    expect(storeSource).toContain('removalOpenWaitRefusal,')
  })

  // Top-level steps are NOT covered by this rule: `deleteChecklistItem` and the
  // series delete are different writers (they delete the whole row), and the
  // owner's answer was about sub-steps.
  it('leaves the top-level step DELETE and the series delete alone', () => {
    const block = routeBlock(/--- DELETE \/api\/checklists\/:id\/items\/:itemId ---/, 4500)
    expect(block).not.toContain('removalOpenWaitRefusal')
  })
})
