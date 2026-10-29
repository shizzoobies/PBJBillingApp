import { describe, expect, it } from 'vitest'
import { AdvancePaymentLedger, ADVANCE_PAYMENT_SCHEMA } from './advance-payments.js'
import { AppDataStore } from './store.js'

function recordingPostgres() {
  const rows = new Map(), calls = []
  const runner = { query: async (sql, values = []) => {
    calls.push({ sql, values })
    if (sql.startsWith('select id, bill_to_client_id from clients')) return { rows: [{ id: values[0], bill_to_client_id: null }] }
    if (sql.startsWith('insert into advance_payment_ledger')) {
      if (rows.has(values[0])) return { rows: [] }
      rows.set(values[0], { id: values[0], client_id: values[1], kind: values[2], document: JSON.parse(values[3]) })
      return { rows: [{ id: values[0] }] }
    }
    if (sql.startsWith('select id, client_id, kind, document')) return { rows: [...rows.values()].filter((row) => sql.includes('where id =') ? row.id === values[0] : values.length ? row.client_id === values[0] || row.kind === 'reversal' : true).map((row) => structuredClone(row)) }
    if (sql.startsWith('update advance_payment_ledger')) { rows.get(values[0]).document = JSON.parse(values[1]); return { rows: [] } }
    return { rows: [] }
  } }
  return { calls, rows, runner, ledger: new AdvancePaymentLedger({ pool: runner, transaction: async (work) => {
    calls.push({ sql: 'begin' }); const result = await work(runner); calls.push({ sql: 'commit' }); return result
  } }) }
}

describe('advance ledger Postgres adapter', () => {
  it('locks the client before a receipt insert and uses a globally unique receipt key', async () => {
    const { ledger, calls } = recordingPostgres()
    const receipt = { requestId: 'r1', sourceRef: 'stripe:pi_synthetic', clientId: 'c1', cents: 40000 }
    await ledger.append('receipt', 'receipt:stripe:pi_synthetic', 'c1', receipt)
    await ledger.append('receipt', 'receipt:stripe:pi_synthetic', 'c1', receipt)
    expect(calls[1]).toEqual({ sql: 'select pg_advisory_xact_lock(hashtext($1))', values: ['advance_source:stripe:pi_synthetic'] })
    expect(calls[2]).toEqual({ sql: 'select pg_advisory_xact_lock(hashtext($1))', values: ['account_credit:c1'] })
    expect((await ledger.list('c1')).receipts).toHaveLength(1)
    await expect(ledger.append('receipt', 'receipt:stripe:pi_synthetic', 'c2', { ...receipt, clientId: 'c2' })).rejects.toThrow('different action')
    expect(ADVANCE_PAYMENT_SCHEMA).toContain('id text primary key')
    expect(ADVANCE_PAYMENT_SCHEMA).not.toContain('references')
  })
  it('retains an early reversal across receipt discovery and cancellation keeps receipts', async () => {
    const { ledger } = recordingPostgres()
    const event = { sourceRef: 'stripe:pi_synthetic', kind: 'refund', at: '2026-11-01', cents: 10000 }
    await ledger.append('reversal', 'event:evt_synthetic', null, event)
    await ledger.append('request', 'request:r1', 'c1', { id: 'r1', clientId: 'c1', number: 'ADV-TEST', requestedCents: 100000, canceledAt: null })
    await ledger.append('receipt', 'receipt:stripe:pi_synthetic', 'c1', { requestId: 'r1', clientId: 'c1', sourceRef: 'stripe:pi_synthetic', cents: 40000, receivedOn: '2026-11-01' })
    await ledger.append('reversal', 'event:evt_synthetic', null, event, () => true)
    await ledger.cancel('r1', 'owner-test', '2026-11-02')
    expect((await ledger.list('c1')).requests[0]).toMatchObject({ canceledAt: '2026-11-02', receivedCents: 40000, outstandingCents: 0 })
    expect((await ledger.credits('c1'))[0]).toMatchObject({ amount: 400, reversal: { holds: true } })
  })
  it('re-resolves a reversal owner under the source lock when settlement follows the preliminary lookup', async () => {
    const { ledger, calls, runner, rows } = recordingPostgres()
    expect((await ledger.list()).receipts).toHaveLength(0)
    const query = runner.query
    runner.query = async (sql, values = []) => {
      if (values[0] === 'advance_source:stripe:pi_race') {
        // Settlement committed before this reversal acquired the source lock.
        rows.set('receipt:stripe:pi_race', { id: 'receipt:stripe:pi_race', client_id: 'c1', kind: 'receipt', document: { sourceRef: 'stripe:pi_race', clientId: 'c1', cents: 10000 } })
      }
      return query(sql, values)
    }
    await ledger.append('reversal', 'event:evt_race', null, { sourceRef: 'stripe:pi_race', kind: 'refund', cents: 10000 })
    const source = calls.findIndex((call) => call.values?.[0] === 'advance_source:stripe:pi_race')
    const discovery = calls.findIndex((call) => call.sql.includes('where id = $1') && call.values[0] === 'receipt:stripe:pi_race')
    const credit = calls.findIndex((call) => call.values?.[0] === 'account_credit:c1')
    const insert = calls.findIndex((call) => call.sql.startsWith('insert into advance_payment_ledger'))
    expect(source).toBeGreaterThan(0)
    expect(discovery).toBeGreaterThan(source)
    expect(credit).toBeGreaterThan(discovery)
    expect(insert).toBeGreaterThan(credit)
    expect(calls.some((call) => call.values?.[0] === 'account_credit:null')).toBe(false)
  })
  it('persists rate scope and checks a repeated request without changing historical records', async () => {
    const store = new AppDataStore()
    const rows = [], calls = []
    store.read = async () => ({ clients: [{ id: 'c1', billingMode: 'hourly' }], employees: [] })
    store.pool = { query: async (sql, values = []) => {
      calls.push(sql)
      if (sql.startsWith('insert into client_rate_agreements')) {
        if (rows.some((row) => row.id === values[0])) return { rows: [] }
        rows.push({ id: values[0], client_id: values[1], user_id: values[2], effective_period: values[3], rate: values[4], note: values[5], created_by: values[6], role: values[7], revision: rows.length + 1 })
        return { rows: [{ id: values[0] }] }
      }
      return { rows }
    } }
    const input = { id: 'aaaaaaaa-bbbb-cccc-dddd', userId: null, role: 'CFO', effectivePeriod: '2026-11', rate: 90 }
    await store.addClientRateAgreement('c1', input, 'owner-test')
    await store.addClientRateAgreement('c1', input, 'owner-test')
    expect((await store.listClientRateAgreements('c1'))[0]).toMatchObject({ role: 'CFO', rate: 90, revision: 1 })
    expect(rows).toHaveLength(1)
    expect(calls.some((sql) => /update invoices|update time_entries|delete from/.test(sql))).toBe(false)
  })
})
