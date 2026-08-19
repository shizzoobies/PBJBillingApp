import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SAVED_WAIT_FIELDS_ARE_LOCKED } from '../../lib/waiting-on-state.js'

/**
 * The server half of the waiting-on lifecycle: the lock that makes a saved wait
 * final, and the question that lets the person being waited on speak without
 * finishing (featreq-8b7d06d7 / featreq-b05a2f3a).
 *
 * WHAT THIS IS AND IS NOT — same shape as invoice-coverage-routes.test.ts, for
 * the same reason: `server.js` calls `server.listen()` at module scope and
 * exports nothing, so there is no HTTP harness here. The DECISIONS are unit
 * tested where they live — the predicates in lib/waiting-on-state.test.mjs, the
 * persistence in db/store-staleness.test.mjs. What is left is the GLUE, and one
 * specific way it rots: someone drops the guard or renames the store call, and
 * every unit test still passes. These assertions read the route source and pin
 * exactly that. Treat a failure here as "the route changed, go look."
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

describe('the locked fields are refused on a step carrying a live wait', () => {
  // The UI stops offering the note box, the task picker and Clear the moment a
  // wait is saved — but every one of those was a plain PATCH, and the route is
  // still reachable directly (and by any tab left open from before the rule).
  it('asks the shared rule on the ITEM patch, and answers with what it says', () => {
    const block = routeBlock(/const itemLockRefusal = waitingLockRefusal\(targetItem, patch\)/, 400)
    expect(block).toContain('sendJson(response, itemLockRefusal.status, { error: itemLockRefusal.error })')
  })

  it('asks it on the SUB-ITEM patch too, against the sub-step and not its parent', () => {
    const block = routeBlock(/const targetSubItem = \(targetItem\.subItems \?\? \[\]\)/, 600)
    expect(block).toContain('.find((sub) => sub.id === subItemId)')
    expect(block).toContain('waitingLockRefusal(targetSubItem, patch)')
    expect(block).toContain('sendJson(response, subLockRefusal.status, { error: subLockRefusal.error })')
  })

  // A refusal that lands after the write is not a refusal.
  it('refuses BEFORE the store is asked to update anything', () => {
    for (const [guard, update] of [
      ['const itemLockRefusal', 'appDataStore.updateChecklistItem(checklistId, itemId, patch)'],
      ['const subLockRefusal', 'appDataStore.updateChecklistSubItem('],
    ]) {
      expect(serverSource.indexOf(guard)).toBeGreaterThan(-1)
      expect(serverSource.indexOf(guard)).toBeLessThan(serverSource.indexOf(update))
    }
  })

  // The one sentence everybody gets, whoever they are — the refusal is a fact
  // about the record, not about the caller.
  it('says it in the plain-sentence style the rest of the flow uses', () => {
    expect(SAVED_WAIT_FIELDS_ARE_LOCKED).not.toMatch(/error|forbidden|invalid/i)
    expect(SAVED_WAIT_FIELDS_ARE_LOCKED).toMatch(/\.$/)
  })
})

describe('the question action', () => {
  const block = () => routeBlock(/if \(action === 'question'\) \{/, 2000)

  it('is routed, beside the three stage moves', () => {
    expect(serverSource).toContain("(done|verify|send-back|question|")
  })

  it('asks the shared predicate who may send one', () => {
    expect(block()).toContain('canAskWaitingOnQuestion(permissionArgs)')
  })

  it('refuses an empty message with a 400, the way send-back does', () => {
    expect(block()).toMatch(/sendJson\(response, 400, \{ error: 'Say what you need to know/)
  })

  it('appends through the store rather than touching a stage field', () => {
    const dispatch = routeBlock(/const resolved =\s*\n\s*action === 'done'/, 1200)
    expect(dispatch).toContain('appDataStore.addWaitingOnQuestion(checklistId, waitingOnId, {')
    // The three stage-moving calls stay exactly three.
    expect(dispatch).toContain('markWaitingOnDone')
    expect(dispatch).toContain('markWaitingOnVerified')
    expect(dispatch).toContain('markWaitingOnSentBack')
  })

  it('tells the person who is waiting, on its own event', () => {
    const notifyBlock = routeBlock(/\} else if \(action === 'question'\) \{/, 1200)
    expect(notifyBlock).toContain("'waiting_on_question'")
    // Same recipients as `done`: whoever asked, plus the assignee actually held
    // up, minus the person who just pressed it.
    expect(notifyBlock).toContain('recipients.delete(session.user.id)')
  })
})

describe('creating a wait is one atomic write', () => {
  const block = () => routeBlock(/POST \/api\/checklists\/:id\/waiting-ons — flag a step/, 8000)

  it('accepts the waited-for task alongside the person and the note', () => {
    expect(block()).toContain("'waitingForChecklistId' in (payload ?? {})")
  })

  /**
   * The back door the lock had: composing a SECOND wait re-opened the editor, so
   * a create could carry a new value for the very field the first wait froze —
   * the exact write the PATCH route answers 409 to. Only a CHANGE is refused,
   * or adding a second wait to a locked step would be impossible.
   */
  it('refuses a create that would CHANGE a locked task link', () => {
    const text = block()
    expect(text).toContain('const createLockRefusal = waitingLockRefusal(')
    const at = text.indexOf('const createLockRefusal')
    const guard = text.slice(at, at + 400)
    expect(guard).toContain("waitingForChecklistId !== (targetNode.waitingForChecklistId ?? '')")
    expect(guard).toContain('? { waitingForChecklistId }')
    expect(guard).toContain(': {}')
  })

  it('validates the link itself, against actives AND the recycle bin', () => {
    const text = block()
    const at = text.indexOf('waitForTaskLinkDenial({')
    expect(at).toBeGreaterThan(-1)
    const call = text.slice(at, at + 400)
    expect(call).toContain('...(data.checklists ?? []), ...(data.recycledChecklists ?? [])')
    expect(call).toContain('current: targetNode.waitingForChecklistId')
  })

  // Both guards read the node, so both must run before the store is asked to
  // write anything.
  it('runs both guards before the store call', () => {
    const text = block()
    expect(text.indexOf('const createLockRefusal')).toBeLessThan(
      text.indexOf('appDataStore.addWaitingOn('),
    )
    expect(text.indexOf('waitForTaskLinkDenial({')).toBeLessThan(
      text.indexOf('appDataStore.addWaitingOn('),
    )
  })

  it('hands all three to the store in the same call', () => {
    const text = block()
    const at = text.indexOf('appDataStore.addWaitingOn(')
    expect(at).toBeGreaterThan(-1)
    const call = text.slice(at, at + 500)
    expect(call).toContain('note,')
    expect(call).toContain('waitingForChecklistId,')
  })

  // Nothing else may write it during creation: a second PATCH could land after
  // the wait is saved, which the lock above would then refuse.
  it('never follows the create with a patch of its own', () => {
    expect(block()).not.toContain('updateChecklistItem')
  })
})

describe('the waited-for task is validated on the PATCH routes too', () => {
  it('checks the ITEM patch against the same shared rule', () => {
    const block = routeBlock(/const itemLockRefusal = waitingLockRefusal\(targetItem, patch\)/, 900)
    expect(block).toContain('waitForTaskLinkDenial({')
    expect(block).toContain('current: targetItem.waitingForChecklistId')
  })

  it('checks the SUB-ITEM patch the same way, against the sub-step', () => {
    const block = routeBlock(/const subLockRefusal = waitingLockRefusal\(targetSubItem, patch\)/, 900)
    expect(block).toContain('waitForTaskLinkDenial({')
    expect(block).toContain('current: targetSubItem?.waitingForChecklistId')
  })

  // The lock is about WHO may change the field; this is about whether the value
  // is one a step could honestly wait for. Both, in that order.
  it('runs after the lock, so a locked step gets the lock’s answer', () => {
    for (const [lock, link] of [
      ['const itemLockRefusal', 'appDataStore.updateChecklistItem(checklistId, itemId, patch)'],
      ['const subLockRefusal', 'appDataStore.updateChecklistSubItem('],
    ]) {
      const from = serverSource.indexOf(lock)
      const to = serverSource.indexOf(link, from)
      expect(serverSource.slice(from, to)).toContain('waitForTaskLinkDenial({')
    }
  })
})

describe('the free-text messages a wait carries are bounded', () => {
  it('caps both the send-back note and the question at the same length', () => {
    expect(serverSource).toMatch(/const WAIT_MESSAGE_MAX_CHARS = \d+/)
    const capped = serverSource.match(/\.slice\(0, WAIT_MESSAGE_MAX_CHARS\)/g) ?? []
    expect(capped).toHaveLength(2)
  })
})

describe('who hears about a question', () => {
  const block = () => routeBlock(/\} else if \(action === 'question'\) \{/, 1500)

  // An owner may ask on the blocker's behalf, and the person actually being
  // waited on has to see a question sent in their name.
  it('includes the person being waited on, not just the side that is waiting', () => {
    const text = block()
    expect(text).toContain('recipients.add(resolved.entry.blockerId)')
    expect(text).toContain('recipients.add(resolved.entry.requestedBy)')
    expect(text).toContain('recipients.add(resolved.assigneeId)')
  })

  it('still never notifies whoever pressed it', () => {
    expect(block()).toContain('recipients.delete(session.user.id)')
  })
})
