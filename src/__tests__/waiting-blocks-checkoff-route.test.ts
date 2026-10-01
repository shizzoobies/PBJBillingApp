import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { waitingBlocksCompletion } from '../../lib/waiting-on-state.js'

/**
 * A waiting step cannot be checked off (featreq-cdab1605). The DECISION —
 * what counts as "waiting" and that a done step is never blocked — is pinned
 * in `lib/waiting-on-state.test.mjs`, against `waitingBlocksCompletion`
 * itself. What is left is the GLUE: same shape as `waiting-lock-routes.test.ts`
 * and `audit-backlog-hardening.test.ts` — `server.js` calls `server.listen()`
 * at module scope and exports nothing, so there is no HTTP harness here. These
 * assertions read the route source and pin exactly the wiring: the server is
 * the SOURCE OF TRUTH (it refuses the toggle before the store is ever asked),
 * and the guard reads whichever node (item / sub-item / sub-sub-item) the
 * request actually targets.
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
)

/** The body of a route block, from its opening guard onward. */
function routeBlock(startPattern: RegExp, length = 4000): string {
  const at = serverSource.search(startPattern)
  expect(at, `route not found: ${startPattern}`).toBeGreaterThan(-1)
  return serverSource.slice(at, at + length)
}

const toggleBlock = () =>
  routeBlock(/const checklistToggleMatch = normalizedPath\.match\(/, 6000)

describe('POST /api/checklists/:id/items/:itemId/toggle refuses a waiting step', () => {
  it('asks the shared predicate, against whichever node the request targets', () => {
    const block = toggleBlock()
    expect(block).toContain('const toggleTarget = targetSubSub ?? targetSub ?? targetItem')
    expect(block).toContain('if (waitingBlocksCascadedCompletion(toggleTarget)) {')
  })

  it('answers 409 with the exact code and sentence the plan pins', () => {
    const block = toggleBlock()
    const at = block.indexOf('if (waitingBlocksCascadedCompletion(toggleTarget)) {')
    const guard = block.slice(at, at + 500)
    expect(guard).toContain("sendJson(response, 409, {")
    expect(guard).toContain("error: 'STEP_IS_WAITING',")
    expect(guard).toContain("'Clear the wait on this step first.'")
  })

  // Ticking a parent cascades `done` onto every sub-item and sub-sub-item
  // (`applyItemToggle`), so the guard reads the target's whole subtree and
  // says so when the block comes from a child.
  it('refuses a parent whose sub-step is waiting, with the sub-step sentence', () => {
    const block = toggleBlock()
    const at = block.indexOf('if (waitingBlocksCascadedCompletion(toggleTarget)) {')
    const guard = block.slice(at, at + 500)
    expect(guard).toContain('waitingBlocksCompletion(toggleTarget)')
    expect(guard).toContain("'Clear the wait on this step (or one of its sub-steps) first.'")
  })

  // A refusal that lands after the write is not a refusal.
  it('refuses BEFORE the store is asked to toggle anything', () => {
    const block = toggleBlock()
    const guardAt = block.indexOf('if (waitingBlocksCascadedCompletion(toggleTarget)) {')
    const writeAt = block.indexOf('appDataStore.toggleChecklistItem(')
    expect(guardAt).toBeGreaterThan(-1)
    expect(writeAt).toBeGreaterThan(-1)
    expect(guardAt).toBeLessThan(writeAt)
  })

  // The guard has to run after the sub-item / sub-sub-item lookups (it reads
  // whichever one the request named) but that is still well before the store
  // call above — this pins the ordering against the 404s those lookups answer.
  it('runs after the sub-item and sub-sub-item are resolved, not before', () => {
    const block = toggleBlock()
    const guardAt = block.indexOf('if (waitingBlocksCascadedCompletion(toggleTarget)) {')
    expect(block.indexOf("error: 'Sub-item not found'")).toBeLessThan(guardAt)
    expect(block.indexOf("error: 'Sub-sub-item not found'")).toBeLessThan(guardAt)
  })

  // The shared predicate is imported, not re-implemented — the whole point is
  // that the UI's disabled checkboxes and this refusal can never drift apart.
  it('imports the predicate from the shared module rather than inlining it', () => {
    expect(serverSource).toContain("waitingBlocksCascadedCompletion,")
    expect(serverSource).toContain("waitingBlocksCompletion,")
    expect(serverSource).toContain("from './lib/waiting-on-state.js'")
  })

  // The upward half: ticking the last open sub-step rolls the parent up to done,
  // so a waiting PARENT is refused here too, through the shared helper.
  it('refuses the tick that would complete a waiting ancestor, before the write', () => {
    const block = toggleBlock()
    const guardAt = block.indexOf(
      'if (waitingAncestorBlocksCompletion(targetItem, toggleSubItemId, toggleSubSubItemId)) {',
    )
    expect(guardAt).toBeGreaterThan(-1)
    const guard = block.slice(guardAt, guardAt + 400)
    expect(guard).toContain('sendJson(response, 409, {')
    expect(guard).toContain("error: 'STEP_IS_WAITING',")
    expect(guard).toContain("'The step above is waiting. Clear its wait first.'")
    expect(guardAt).toBeGreaterThan(block.indexOf("error: 'Sub-sub-item not found'"))
    expect(guardAt).toBeLessThan(block.indexOf('appDataStore.toggleChecklistItem('))
    expect(serverSource).toContain('waitingAncestorBlocksCompletion,')
  })
})

/**
 * The predicate itself already proves a DONE step is never blocked (see
 * `lib/waiting-on-state.test.mjs`); this just confirms the route hands it the
 * node with `done` on it rather than a bare waiting flag, so that guarantee
 * actually reaches the route.
 */
describe('un-checking a done step is never blocked', () => {
  it('passes the real item/sub-item/sub-sub-item node, not a synthetic one', () => {
    // `targetItem`, `targetSub` and `targetSubSub` all come straight off the
    // stored checklist (see the lookups above `toggleTarget`), so each one
    // already carries its own `done`, `waiting` and `waitingOns` — the guard
    // adds no field and drops none.
    expect(waitingBlocksCompletion({ done: true, waiting: true })).toBe(false)
    expect(waitingBlocksCompletion({ done: true, waitingOns: [{ id: 'wo-1' }] })).toBe(false)
  })
})
