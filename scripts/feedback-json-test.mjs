// Run only in the isolated local checkout with no API server or Vitest running.
// Creates fictional records; does not load any environment or production files.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { AppDataStore } from '../db/store.js'
import { validateAttachment } from '../lib/feedback-files.js'
if (process.env.DATABASE_URL) throw new Error('This drill requires the local JSON backend')
const store = new AppDataStore()
await store.initialize()
const parent = await store.createFeatureRequest('emp-patrice', 'LOCAL TEST: attachment lifecycle', 'Fictional local test', { type: 'feature' })
const rawAuth = await readFile(new URL('../tmp/auth-state.json', import.meta.url), 'utf8')
const [created] = await Promise.all([
  store.createFeatureRequest('emp-patrice', 'LOCAL TEST: concurrent creation', 'Fictional local test', { type: 'feature' }),
  store.deleteFeatureRequest(parent.id),
  store.createSessionForUser('emp-patrice'),
])
assert.equal(await store.getFeatureRequest(parent.id), null)
assert.equal((await store.getFeatureRequest(created.id)).id, created.id)
const file = await validateAttachment({ filename: 'fixture.txt', bytes: Buffer.from('Fictional private attachment'), uploadId: randomUUID() })
const reservation = await store.feedbackAttachments().reserve(created.id, file, 'emp-patrice')
await store.feedbackAttachments().finish(reservation.row)
// Simulate an unrelated auth writer holding a stale snapshot. Tracker storage
// is independent, so this cannot undo a creation, removal or attachment intent.
await writeFile(new URL('../tmp/auth-state.json', import.meta.url), rawAuth)
assert.equal(await store.getFeatureRequest(parent.id), null)
assert.equal((await store.getFeatureRequest(created.id)).id, created.id)
const workspace = await store.read()
await store.write(workspace)
const reload = new AppDataStore()
assert.equal((await reload.feedbackAttachments().list(created.id)).length, 1)
assert.equal((await reload.getFeatureRequest(created.id)).id, created.id)
const bulk = await readFile(new URL('../tmp/app-data.json', import.meta.url), 'utf8')
assert.equal(bulk.includes(reservation.row.objectKey), false)
assert.equal(bulk.includes(file.bytes.toString('base64')), false)
await store.deleteFeatureRequest(created.id)
assert.equal(await store.updateFeatureRequest(created.id, { title: 'must stay deleted' }), null)
assert.equal(await store.setFeatureRequestWalkthrough(created.id, 'must stay deleted'), null)
console.log('PASS: concurrent tracker CRUD, stale auth writes, workspace save, reload, and deletion guards')
