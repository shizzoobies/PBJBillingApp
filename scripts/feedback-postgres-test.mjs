// Explicit local-only integration drill. Does not load any environment files.
import assert from 'node:assert/strict'
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { FeedbackAttachmentLedger, FEEDBACK_ATTACHMENT_SCHEMA } from '../db/feedback-attachments.js'
import { validateAttachment } from '../lib/feedback-files.js'

const value = process.env.PBJ_FEEDBACK_TEST_DATABASE_URL
if (!value) throw new Error('Set PBJ_FEEDBACK_TEST_DATABASE_URL to an isolated local feedback_test database')
const url = new URL(value)
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/feedback_test') throw new Error('Only a local feedback_test database is allowed')
const schema = `feedback_drill_${randomUUID().replaceAll('-', '')}`
const pool = new pg.Pool({ connectionString: value, max: 12, options: `-c search_path=${schema}` })
let paused = false
let time = Date.now()
const ledger = new FeedbackAttachmentLedger({ pool, now: () => time, paused: () => paused })
const makeFile = async (uploadId = randomUUID()) => validateAttachment({ filename: 'fixture.txt', bytes: Buffer.from('fictional fixture'), uploadId })
const objects = new Map()
const storage = { delete: async (key) => objects.delete(key) }
try {
  await pool.query(`create schema ${schema}`)
  await pool.query('create table feature_requests (id text primary key)')
  await pool.query(FEEDBACK_ATTACHMENT_SCHEMA)
  await pool.query(FEEDBACK_ATTACHMENT_SCHEMA)
  await pool.query("insert into feature_requests(id) values ('quota'),('duplicate'),('delete'),('restore'),('crash')")
  const quota = await Promise.allSettled(Array.from({ length: 12 }, async () => ledger.reserve('quota', await makeFile(), 'owner')))
  assert.equal(quota.filter((r) => r.status === 'fulfilled').length, 10)
  assert.equal(quota.filter((r) => r.status === 'rejected' && r.reason.status === 409).length, 2)
  console.log('PASS: concurrent quota reservations on real PostgreSQL')
  const duplicateFile = await makeFile()
  const duplicates = await Promise.allSettled(Array.from({ length: 8 }, () => ledger.reserve('duplicate', duplicateFile, 'owner')))
  assert.equal(duplicates.filter((r) => r.status === 'fulfilled').length, 1)
  const duplicate = duplicates.find((r) => r.status === 'fulfilled').value.row
  await ledger.finish(duplicate)
  assert.equal((await ledger.reserve('duplicate', duplicateFile, 'owner')).existing, true)
  console.log('PASS: in-flight exclusion and completed retry idempotency')
  const parent = (await ledger.reserve('delete', await makeFile(), 'owner')).row
  objects.set(parent.objectKey, Buffer.from('fixture'))
  await ledger.finish(parent)
  assert.equal(await ledger.removeParent('delete'), true)
  assert.equal((await pool.query("select id from feature_requests where id='delete'")).rowCount, 0)
  assert.equal((await pool.query('select object_key from feature_request_attachment_deletions where object_key=$1', [parent.objectKey])).rowCount, 1)
  await ledger.cleanup(storage)
  assert.equal(objects.size, 0)
  console.log('PASS: atomic parent removal and durable outbox cleanup')
  const crashed = (await ledger.reserve('crash', await makeFile(), 'owner')).row
  objects.set(crashed.objectKey, Buffer.from('fixture'))
  time += 120001
  // Cleanup intentionally processes at most five objects per pass. Quota
  // fixtures also expired, so drain bounded passes rather than widening it.
  for (let i = 0; i < 4; i++) await ledger.cleanup(storage)
  assert.equal(objects.size, 0)
  assert.equal(await ledger.finish(crashed), null)
  console.log('PASS: expired-intent recovery and stale completion rejection')
  const restored = (await ledger.reserve('restore', await makeFile(), 'owner')).row
  await ledger.finish(restored); objects.set(restored.objectKey, Buffer.from('fixture'))
  await ledger.remove('restore', restored.id)
  paused = true; await ledger.cleanup(storage)
  assert.equal(objects.size, 1)
  await assert.rejects(ledger.reserve('restore', await makeFile(), 'owner'), { status: 503 })
  await ledger.transaction((tx) => tx.put({ ...restored, state: 'ready', leaseUntil: 0 }))
  paused = false; await ledger.cleanup(storage)
  assert.equal(objects.size, 1)
  assert.equal((await pool.query('select object_key from feature_request_attachment_deletions where object_key=$1', [restored.objectKey])).rowCount, 0)
  console.log('PASS: maintenance pause and reconciliation of restored live references')
  console.log(`Local test schema retained for inspection: ${schema}`)
} finally { await pool.end() }
