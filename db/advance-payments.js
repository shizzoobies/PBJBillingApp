import { readFile, writeFile, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { AdvancePaymentError, advanceSummary, advanceCredits } from '../lib/advance-payments.js'

export const ADVANCE_PAYMENT_SCHEMA = `create table if not exists advance_payment_ledger (
  id text primary key, client_id text, kind text not null check (kind in ('request','receipt','reversal','session','settings')),
  document jsonb not null, sequence bigserial unique, created_at timestamptz not null default now()
)`

/** Append-only receipts and reversal events, isolated from workspace snapshots.
 * File operations hold the same workspace queue as credit draws; PG operations
 * take the same per-client advisory lock. Credits are derived, never double-posted.
 */
export class AdvancePaymentLedger {
  constructor({ pool, transaction, fileLock, filePath }) { Object.assign(this, { pool, transaction, fileLock, filePath }) }
  async fileRows() {
    try { return JSON.parse(await readFile(this.filePath, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  }
  async rows(clientId = null, runner = this.pool) {
    if (runner) {
      const result = await runner.query(`select id, client_id, kind, document from advance_payment_ledger${clientId ? " where client_id = $1 or kind = 'reversal'" : ''} order by sequence`, clientId ? [clientId] : [])
      return result.rows.map((row) => ({ id: row.id, clientId: row.client_id, kind: row.kind, document: row.document }))
    }
    return (await this.fileRows()).filter((row) => !clientId || row.clientId === clientId || row.kind === 'reversal')
  }
  async list(clientId = null, runner = this.pool) {
    const rows = await this.rows(clientId, runner)
    const documents = (kind) => rows.filter((row) => row.kind === kind).map((row) => row.document)
    const receipts = documents('receipt')
    return { requests: documents('request').map((row) => advanceSummary(row, receipts)), receipts, reversals: documents('reversal'), sessions: documents('session'), settings: documents('settings') }
  }
  async credits(clientId, runner = this.pool) {
    const { requests, receipts, reversals } = await this.list(clientId, runner)
    return advanceCredits(requests, receipts, reversals)
  }
  async append(kind, id, clientId, document, same = (a, b) => JSON.stringify(a) === JSON.stringify(b)) {
    const check = (existing) => {
      if (existing && (existing.kind !== kind || existing.clientId !== clientId || !same(existing.document, document))) throw new AdvancePaymentError('This reference already records a different action. Reload before continuing.')
      return existing?.document ?? document
    }
    if (this.pool) return this.transaction(async (runner) => {
      let lockClientId = clientId
      if (kind === 'receipt' || kind === 'reversal') {
        // Settle and reverse one payment in source order, including a reversal
        // delivered before its receipt. Discover the owner only AFTER this lock;
        // a preliminary lookup can miss a settlement that commits meanwhile.
        await runner.query('select pg_advisory_xact_lock(hashtext($1))', [`advance_source:${document.sourceRef}`])
        if (kind === 'reversal') {
          const found = await runner.query('select id, client_id, kind, document from advance_payment_ledger where id = $1', [`receipt:${document.sourceRef}`])
          lockClientId = found.rows[0]?.client_id ?? null
        }
      }
      if (kind === 'request') {
        // Bulk workspace deletion/reassignment locks clients first. Match that
        // order, and validate inside this transaction rather than a pre-read.
        const found = await runner.query('select id, bill_to_client_id from clients where id = $1 for key share', [clientId])
        if (!found.rows.length || found.rows[0].bill_to_client_id) throw new AdvancePaymentError('Choose an existing billing client, not a company billed through another client.')
      }
      if (lockClientId) await runner.query('select pg_advisory_xact_lock(hashtext($1))', [`account_credit:${lockClientId}`])
      const inserted = await runner.query('insert into advance_payment_ledger (id, client_id, kind, document) values ($1,$2,$3,$4::jsonb) on conflict (id) do nothing returning id', [id, clientId, kind, JSON.stringify(document)])
      if (inserted.rows.length) return document
      const found = await runner.query('select id, client_id, kind, document from advance_payment_ledger where id = $1', [id])
      const row = found.rows[0]
      if (!row) throw new Error('Advance receipt was not saved.')
      return check({ ...row, clientId: row.client_id })
    })
    return this.fileLock(async (data) => {
      if (kind === 'request') {
        const client = (data.clients ?? []).find((row) => row.id === clientId)
        if (!client || client.billToClientId) throw new AdvancePaymentError('Choose an existing billing client, not a company billed through another client.')
      }
      const rows = await this.fileRows()
      const existing = rows.find((row) => row.id === id)
      const result = check(existing)
      if (!existing) {
        rows.push({ id, clientId, kind, document })
        await this.saveFile(rows)
      }
      return { result, changed: false }
    })
  }
  async saveFile(rows) {
    const temporary = `${this.filePath}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(rows, null, 2))
    await rename(temporary, this.filePath)
  }
  async cancel(requestId, actorUserId, at) {
    const apply = (rows) => {
      const row = rows.find((item) => item.kind === 'request' && item.document.id === requestId)
      if (!row) throw new AdvancePaymentError('Advance request not found.')
      return { row, next: { ...row.document, canceledAt: row.document.canceledAt || at, canceledBy: row.document.canceledBy || actorUserId } }
    }
    if (this.pool) return this.transaction(async (runner) => {
      const initial = apply(await this.rows(null, runner))
      await runner.query('select pg_advisory_xact_lock(hashtext($1))', [`account_credit:${initial.row.clientId}`])
      const { row, next } = apply(await this.rows(initial.row.clientId, runner))
      await runner.query('update advance_payment_ledger set document = $2::jsonb where id = $1', [row.id, JSON.stringify(next)])
      return next
    })
    return this.fileLock(async () => {
      const rows = await this.fileRows()
      const { row, next } = apply(rows)
      row.document = next
      await this.saveFile(rows)
      return { result: next, changed: false }
    })
  }
}
