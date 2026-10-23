import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The writer of a note can edit it (featreq-da3801ab) - the ROUTE wiring.
 * `server.js` calls `listen()` at module scope and exports nothing, so (same
 * reasoning as pending-client-notes-routes.test.ts) this reads route source.
 * The decisions themselves are tested as behavior: who may edit and every
 * refusal's status (200 own / 403 anyone else, the owner included / 404 / 409
 * attached) in lib/note-edit-permission.test.mjs, and the store's guarded write
 * on both backends in db/store-staleness.test.mjs. A failure here means "the
 * route moved, go look".
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const serverSource = readFileSync(path.join(repoRoot, 'server.js'), 'utf8')

function routeBlock(startPattern: RegExp, length: number): string {
  const at = serverSource.search(startPattern)
  expect(at, `route not found: ${startPattern}`).toBeGreaterThan(-1)
  return serverSource.slice(at, at + length)
}

/** Positions of `needles` in `text`, each required to be present. */
function positions(text: string, ...needles: string[]): number[] {
  return needles.map((needle) => {
    const at = text.indexOf(needle)
    expect(at, `missing: ${needle}`).toBeGreaterThan(-1)
    return at
  })
}

it('server.js imports the shared rule', () => {
  expect(serverSource).toMatch(
    /import \{[^}]*\bclientNoteEditRefusal\b[^}]*\bnoteEditOutcomeRefusal\b[^}]*\bpendingNoteEditRefusal\b[^}]*\} from '\.\/lib\/note-edit-permission\.js'/,
  )
})

describe('PATCH /api/clients/:clientId/notes/:noteId', () => {
  const block = () => routeBlock(/if \(clientNoteDeleteMatch && request\.method === 'PATCH'\) \{/, 2600)

  it('gates like its siblings before touching the store: session, JSON, same-site, client visible', () => {
    const text = block()
    const [session, json, origin, visible, lookup] = positions(
      text,
      'requireSession(request, response)',
      'isJsonContentType(request)',
      'isCrossSiteOrigin(request)',
      'if (!visibleClientIdSet(session, data).has(clientId)) {',
      'appDataStore.getClientNote(noteId)',
    )
    expect(session).toBeLessThan(json)
    expect(json).toBeLessThan(origin)
    expect(origin).toBeLessThan(visible)
    expect(visible).toBeLessThan(lookup)
  })

  it('asks the writer rule with the real session (no owner exception), the note scoped to the path client', () => {
    const text = block()
    expect(text).toContain(
      'clientNoteEditRefusal(existing?.clientId === clientId ? existing : null, session.user.id)',
    )
    // Unlike the DELETE beside it, nothing here reads the role.
    expect(text).not.toContain("role !== 'owner'")
    expect(text).not.toContain("role === 'owner'")
    const [refusal, write] = positions(text, 'clientNoteEditRefusal(', 'appDataStore.updateClientNote(')
    expect(refusal).toBeLessThan(write)
  })

  it('passes the session as the editor, so the store re-checks the writer in its own write', () => {
    expect(block()).toContain(
      'appDataStore.updateClientNote(noteId, { body: payload?.body, editorId: session.user.id })',
    )
  })

  it('answers a store refusal through noteEditOutcomeRefusal, then logs and answers 200 with the note', () => {
    const text = block()
    const [write, outcome, log, reply] = positions(
      text,
      'appDataStore.updateClientNote(',
      'noteEditOutcomeRefusal(outcome.reason)',
      "recordActivity(session.user.id, 'client_note_edited', clientId)",
      'sendJson(response, 200, { note: outcome.note })',
    )
    expect(write).toBeLessThan(outcome)
    expect(outcome).toBeLessThan(log)
    expect(log).toBeLessThan(reply)
  })
})

describe('PATCH /api/clients/:clientId/pending-notes/:noteId', () => {
  const block = () => routeBlock(/if \(clientPendingNoteDeleteMatch && request\.method === 'PATCH'\) \{/, 2800)

  it('gates like the DELETE beside it: session, JSON, same-site, then 404 for a client you cannot see', () => {
    const text = block()
    const [session, json, origin, visible, lookup] = positions(
      text,
      'requireSession(request, response)',
      'isJsonContentType(request)',
      'isCrossSiteOrigin(request)',
      'if (!visibleClientIdSet(session, data).has(clientId)) {',
      'appDataStore.getClientPendingNote(noteId)',
    )
    expect(session).toBeLessThan(json)
    expect(json).toBeLessThan(origin)
    expect(origin).toBeLessThan(visible)
    expect(visible).toBeLessThan(lookup)
    expect(text.slice(visible, visible + 140)).toContain("sendJson(response, 404, { error: 'Note not found' })")
  })

  it('asks the writer rule (403 anyone else, 409 attached) with the real session, scoped to the path client', () => {
    const text = block()
    expect(text).toContain(
      'pendingNoteEditRefusal(existing?.clientId === clientId ? existing : null, session.user.id)',
    )
    expect(text).not.toContain("role !== 'owner'")
    expect(text).not.toContain("role === 'owner'")
  })

  it('sends a refusal with its message, so the 409 tells her to edit it on the checklist', () => {
    const text = block()
    const at = text.indexOf('pendingNoteEditRefusal(')
    expect(text.slice(at, at + 300)).toContain('sendNoteEditRefusal(response, refusal)')
    const helper = routeBlock(/function sendNoteEditRefusal\(response, refusal\) \{/, 400)
    expect(helper).toContain('refusal.message ? { error: refusal.error, message: refusal.message } : { error: refusal.error }')
  })

  it('writes through the store with the session as the editor, then logs, broadcasts and answers 200', () => {
    const text = block()
    const [write, outcome, log, broadcast, reply] = positions(
      text,
      'appDataStore.updateClientPendingNote(noteId, { body: payload?.body, editorId: session.user.id })',
      'noteEditOutcomeRefusal(outcome.reason)',
      "'pending_note_edited',",
      'broadcastDataChanged()',
      'sendJson(response, 200, { note: outcome.note })',
    )
    expect(write).toBeLessThan(outcome)
    expect(outcome).toBeLessThan(log)
    expect(log).toBeLessThan(broadcast)
    expect(broadcast).toBeLessThan(reply)
  })
})
