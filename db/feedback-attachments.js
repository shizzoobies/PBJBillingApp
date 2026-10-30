import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { AttachmentError, MAX_ATTACHMENTS } from '../lib/feedback-files.js'
import { isAttachmentKey } from '../lib/feedback-storage.js'

export const FEEDBACK_ATTACHMENT_SCHEMA = `
create table if not exists feature_request_attachments (
  id text primary key, parent_id text not null, upload_id text not null,
  state text not null check (state in ('pending', 'ready')), object_key text unique not null,
  digest text not null, lease_until bigint not null, payload jsonb not null,
  unique (parent_id, upload_id)
);
create index if not exists feature_request_attachments_parent_idx on feature_request_attachments(parent_id);
create table if not exists feature_request_attachment_deletions (
  object_key text primary key, retry_at bigint not null, payload jsonb not null
);`
const queues = new Map()
const heldLocks = new AsyncLocalStorage()
const LEASE_MS = 120000
const LOCK_ID = 723191004
export const attachmentMetadata = (row) => ({ id: row.id, requestId: row.parentId, filename: row.filename,
  contentType: row.contentType, size: row.size, createdAt: row.createdAt, uploadedBy: row.uploadedBy })
export function withFeedbackLock(key, run) {
  if (heldLocks.getStore()?.has(key)) return run()
  const previous = queues.get(key) ?? Promise.resolve()
  const execute = () => heldLocks.run(new Set([...(heldLocks.getStore() ?? []), key]), run)
  const next = previous.then(execute, execute)
  const settled = next.then(() => {}, () => {})
  queues.set(key, settled)
  void settled.then(() => { if (queues.get(key) === settled) queues.delete(key) })
  return next
}

// This ledger is independent of auth-state and bulk workspace saves. File-mode
// parent tombstones are authoritative, including after a stale auth-state write.
// PostgreSQL parent removal shares the same transaction as its cleanup outbox.
export class FeedbackAttachmentLedger {
  constructor({ pool, file, getParent, deleteFileParent, paused = () => false, now = Date.now }) {
    Object.assign(this, { pool, file, getParent, deleteFileParent, paused, now })
  }
  async transaction(run) {
    if (this.pool) {
      const client = await this.pool.connect()
      try {
        await client.query('begin')
        await client.query("set local lock_timeout = '5s'")
        await client.query('select pg_advisory_xact_lock($1)', [LOCK_ID])
        const tx = {
          parent: async (id) => Boolean((await client.query('select id from feature_requests where id=$1', [id])).rowCount),
          rows: async (id) => (await client.query('select payload from feature_request_attachments where parent_id=$1', [id])).rows.map((r) => r.payload),
          expired: async (time) => (await client.query("select payload from feature_request_attachments where state='pending' and lease_until <= $1 limit 25", [time])).rows.map((r) => r.payload),
          put: async (r) => client.query(`insert into feature_request_attachments (id,parent_id,upload_id,state,object_key,digest,lease_until,payload)
            values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(id) do update set state=excluded.state,lease_until=excluded.lease_until,payload=excluded.payload`,
          [r.id,r.parentId,r.uploadId,r.state,r.objectKey,r.digest,r.leaseUntil,JSON.stringify(r)]),
          drop: async (id) => client.query('delete from feature_request_attachments where id=$1', [id]),
          enqueue: async (job) => client.query('insert into feature_request_attachment_deletions(object_key,retry_at,payload) values($1,$2,$3) on conflict(object_key) do update set retry_at=excluded.retry_at,payload=excluded.payload', [job.objectKey,job.retryAt,JSON.stringify(job)]),
          jobs: async (time) => (await client.query('select payload from feature_request_attachment_deletions where retry_at <= $1 order by retry_at limit 10', [time])).rows.map((r) => r.payload),
          referenced: async (key) => Boolean((await client.query('select id from feature_request_attachments where object_key=$1', [key])).rowCount),
          removeJob: async (key) => client.query('delete from feature_request_attachment_deletions where object_key=$1', [key]),
          removeParent: async (id) => Boolean((await client.query('delete from feature_requests where id=$1', [id])).rowCount),
        }
        const result = await run(tx)
        await client.query('commit')
        return result
      } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
    }
    return withFeedbackLock(this.file, async () => {
      let state
      try { state = JSON.parse(await readFile(this.file, 'utf8')) } catch (error) {
        if (error.code !== 'ENOENT') throw error
        state = { rows: [], jobs: [], deletedParents: [] }
      }
      let dirty = false
      const tx = {
        parent: async (id) => !state.deletedParents.includes(id) && Boolean(await this.getParent(id)),
        rows: async (id) => state.rows.filter((r) => r.parentId === id),
        expired: async (time) => state.rows.filter((r) => r.state === 'pending' && r.leaseUntil <= time).slice(0,25),
        put: async (r) => { dirty = true; state.rows = [...state.rows.filter((old) => old.id !== r.id), r] },
        drop: async (id) => { dirty = true; state.rows = state.rows.filter((r) => r.id !== id) },
        enqueue: async (job) => { dirty = true; state.jobs = [...state.jobs.filter((j) => j.objectKey !== job.objectKey), job] },
        jobs: async (time) => state.jobs.filter((j) => j.retryAt <= time).sort((a,b) => a.retryAt-b.retryAt).slice(0,10),
        referenced: async (key) => state.rows.some((r) => r.objectKey === key),
        removeJob: async (key) => { dirty = true; state.jobs = state.jobs.filter((j) => j.objectKey !== key) },
        removeParent: async (id) => { const exists = await tx.parent(id); dirty = true; if (!state.deletedParents.includes(id)) state.deletedParents.push(id); return exists },
      }
      const result = await run(tx)
      if (dirty) {
        await mkdir(path.dirname(this.file), { recursive: true })
        const temporary = `${this.file}.next`
        await writeFile(temporary, JSON.stringify(state))
        await rename(temporary, this.file)
      }
      return result
    })
  }
  assertActive() { if (this.paused()) throw new AttachmentError(503, 'Attachments are paused for maintenance. Please retry later.') }
  async requireParent(tx, parentId) { if (!await tx.parent(parentId)) throw new AttachmentError(404, 'Update not found.') }
  async queueRow(tx, row) {
    await tx.enqueue({ objectKey: row.objectKey, retryAt: Math.max(this.now(), row.state === 'pending' ? row.leaseUntil : 0), attempts: 0 })
    await tx.drop(row.id)
  }
  async parentExists(id) { return this.transaction((tx) => tx.parent(id)) }
  async list(parentId) {
    return this.transaction(async (tx) => {
      await this.requireParent(tx, parentId)
      return (await tx.rows(parentId)).filter((r) => r.state === 'ready').map(attachmentMetadata)
    })
  }
  async reserve(parentId, file, userId) {
    this.assertActive()
    return this.transaction(async (tx) => {
      this.assertActive()
      await this.requireParent(tx, parentId)
      let rows = await tx.rows(parentId)
      for (const row of rows) if (row.state === 'pending' && row.leaseUntil <= this.now()) await this.queueRow(tx, row)
      rows = await tx.rows(parentId)
      const existing = rows.find((r) => r.uploadId === file.uploadId)
      if (existing) {
        if (existing.digest !== file.digest || existing.filename !== file.filename || existing.contentType !== file.contentType) throw new AttachmentError(409, 'This upload ID already belongs to a different file.')
        if (existing.state !== 'ready') throw new AttachmentError(409, 'This file is still uploading. Please retry shortly.')
        return { row: existing, existing: true }
      }
      if (rows.length >= MAX_ATTACHMENTS) throw new AttachmentError(409, 'An update can have up to 10 attachments.')
      const id = randomUUID()
      const row = { id, parentId, uploadId: file.uploadId, filename: file.filename, contentType: file.contentType,
        size: file.size, digest: file.digest, uploadedBy: userId, createdAt: new Date(this.now()).toISOString(),
        state: 'pending', objectKey: `feedback/${id}/${randomUUID()}`, leaseUntil: this.now() + LEASE_MS }
      await tx.put(row)
      return { row, existing: false }
    })
  }
  async finish(row) {
    return this.transaction(async (tx) => {
      if (this.paused()) return null
      const current = (await tx.rows(row.parentId)).find((r) => r.id === row.id && r.objectKey === row.objectKey)
      if (current?.state === 'ready' && await tx.parent(row.parentId)) return attachmentMetadata(current)
      if (!await tx.parent(row.parentId) || !current || current.state !== 'pending' || current.leaseUntil <= this.now()) {
        await this.queueRow(tx, row)
        return null
      }
      const ready = { ...row, state: 'ready', leaseUntil: 0 }
      await tx.put(ready)
      return attachmentMetadata(ready)
    })
  }
  async fail(row) {
    return this.transaction(async (tx) => {
      if (this.paused()) return
      const current = (await tx.rows(row.parentId)).find((r) => r.id === row.id && r.objectKey === row.objectKey)
      // A lost COMMIT acknowledgement is not evidence that finalization failed.
      if (current?.state === 'ready') return
      await this.queueRow(tx, row)
    })
  }
  async get(parentId, id) {
    return this.transaction(async (tx) => {
      await this.requireParent(tx, parentId)
      const row = (await tx.rows(parentId)).find((r) => r.id === id && r.state === 'ready')
      if (!row) throw new AttachmentError(404, 'Attachment not found.')
      return row
    })
  }
  async remove(parentId, id) {
    this.assertActive()
    return this.transaction(async (tx) => {
      this.assertActive()
      await this.requireParent(tx, parentId)
      const row = (await tx.rows(parentId)).find((r) => r.id === id && r.state === 'ready')
      if (!row) throw new AttachmentError(404, 'Attachment not found.')
      await this.queueRow(tx, row)
    })
  }
  async removeParent(parentId) {
    this.assertActive()
    const removed = await this.transaction(async (tx) => {
      this.assertActive()
      for (const row of await tx.rows(parentId)) await this.queueRow(tx, row)
      return tx.removeParent(parentId)
    })
    if (!this.pool) await this.deleteFileParent?.(parentId)
    return removed
  }
  // A restore inside this runtime must use this transaction boundary. A full
  // database restore additionally requires a pause in BOTH old and new runtimes.
  async cleanup(storage) {
    if (this.paused()) return
    const started = this.now()
    await this.transaction(async (tx) => {
      if (this.paused()) return
      for (const row of await tx.expired(this.now())) await this.queueRow(tx, row)
    })
    for (let i = 0; i < 5 && this.now() - started < 30000; i++) {
      const processed = await this.transaction(async (tx) => {
        if (this.paused()) return false
        const job = (await tx.jobs(this.now()))[0]
        if (!job) return false
        if (!isAttachmentKey(job.objectKey) || await tx.referenced(job.objectKey)) {
          await tx.removeJob(job.objectKey)
          return true
        }
        try { await storage.delete(job.objectKey); await tx.removeJob(job.objectKey) }
        catch { await tx.enqueue({ ...job, attempts: job.attempts + 1, retryAt: this.now() + Math.min(86400000, 60000 * 2 ** Math.min(job.attempts, 10)) }) }
        return true
      })
      if (!processed) break
    }
  }
}
