import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppDataStore, mapInvoiceRow } from './store.js'
import { sendInvoiceEmail } from '../lib/notify.js'

function fixture({ status = 'draft', commitFails = false } = {}) {
  let row = { id: 'invoice-synthetic', client_id: 'client-synthetic', status, kind: 'monthly', period: '2026-11', number: 'SYNTHETIC', total: 300, subtotal: 300,
    line_items: [{ kind: 'plan', label: 'Services', detail: '', amount: 300 }], email_log: [], blurb: '', sent_at: null }
  const events = [], store = new AppDataStore()
  const connection = { release: vi.fn(), query: vi.fn(async (sql, params = []) => {
    const normalized = sql.trim().replace(/\s+/g, ' ')
    events.push(normalized)
    if (normalized === 'COMMIT' && commitFails) throw new Error('Synthetic commit failure')
    if (/^select .* from invoices where id = \$1 for update$/i.test(normalized)) return { rows: [structuredClone(row)], rowCount: 1 }
    if (normalized.startsWith('select payment_terms')) return { rows: [{ payment_terms: 'Net 45' }] }
    if (normalized.startsWith('update invoices')) {
      row = { ...row, email_log: [...row.email_log, ...JSON.parse(params[1])], ...(params[2] ? { status: 'sent', sent_at: params[3] } : {}) }
      return { rows: [structuredClone(row)], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  }) }
  // Any nested pooled query would deadlock a saturated/one-connection pool.
  store.pool = { connect: vi.fn(async () => connection), query: vi.fn(async () => { throw new Error('Unexpected nested pool query') }) }
  return { store, connection, events, invoice: mapInvoiceRow(row) }
}

describe('protected invoice delivery on the PostgreSQL connection', () => {
  it('locks credit then the authoritative invoice, sends once, and records only afterward on that same connection', async () => {
    const { store, invoice, events, connection } = fixture()
    const stamp = '2026-10-28T23:00:00.000Z'
    const result = await store.deliverInvoiceWithCreditLock(invoice, { stamp, oneTime: ['test@example.test'], attemptId: 'test-attempt' }, async () => {
      expect(events[1]).toContain('pg_advisory_xact_lock')
      expect(events[2]).toMatch(/for update$/)
      expect(events.some((entry) => entry.startsWith('update invoices'))).toBe(false)
      events.push('PROVIDER')
      return { ok: true, providerId: 'synthetic-provider-id' }
    })
    expect(events.indexOf('PROVIDER')).toBeLessThan(events.findIndex((entry) => entry.startsWith('update invoices')))
    expect(result.invoice.sentAt).toBe(stamp)
    expect(result.invoice.emailLog[0]).toMatchObject({ ok: true, attemptId: 'test-attempt', oneTime: ['test@example.test'], providerId: 'synthetic-provider-id' })
    expect(events.at(-1)).toBe('COMMIT')
    expect(store.pool.connect).toHaveBeenCalledTimes(1)
    expect(store.pool.query).not.toHaveBeenCalled()
    expect(connection.release).toHaveBeenCalledTimes(1)
  })
  it('records a definite refusal without setting the document send stamp or changing draft status', async () => {
    const { store, invoice } = fixture()
    const result = await store.deliverInvoiceWithCreditLock(invoice, { stamp: '2026-01-01T00:00:00.000Z' }, async () => ({ ok: false, error: 'Refused', status: 400 }))
    expect(result.invoice.status).toBe('draft')
    expect(result.invoice.sentAt).toBeNull()
    expect(result.invoice.emailLog[0].at).not.toBe('2026-01-01T00:00:00.000Z')
  })
  it.each([true, false])('preserves acceptance or uncertainty when commit fails (accepted=%s)', async (accepted) => {
    const { store, invoice, events } = fixture({ commitFails: true })
    const outcome = accepted ? { ok: true, providerId: 'synthetic' } : { ok: false, uncertain: true, error: 'Unknown delivery' }
    const result = await store.deliverInvoiceWithCreditLock(invoice, {}, async () => outcome)
    expect(result.result).toEqual(outcome)
    expect(result.invoice).toBeNull()
    expect(result.recordError).toContain('Reconcile')
    expect(events.at(-1)).toBe('ROLLBACK')
  })
  it('refuses a payment-state change before dispatch, rather than delivering the stale pay-now copy', async () => {
    const { store, invoice } = fixture({ status: 'paid' })
    const deliver = vi.fn()
    await expect(store.deliverInvoiceWithCreditLock({ ...invoice, status: 'sent' }, {}, deliver)).rejects.toThrow('changed before delivery')
    expect(deliver).not.toHaveBeenCalled()
  })
})

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
describe('bounded provider delivery with synthetic fetch', () => {
  it('aborts a stalled request and reports uncertain delivery instead of a safe retry', async () => {
    vi.stubEnv('RESEND_API_KEY', 'synthetic-not-a-key')
    vi.stubEnv('INVOICE_EMAIL_FROM', 'billing@example.test')
    let signal, headers
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      signal = options.signal; headers = options.headers
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    }))
    const result = await sendInvoiceEmail({ to: ['client@example.test'], subject: 'Synthetic', html: 'Synthetic', timeoutMs: 10, idempotencyKey: 'synthetic-attempt' })
    expect(signal.aborted).toBe(true)
    expect(headers['Idempotency-Key']).toBe('synthetic-attempt')
    expect(result).toMatchObject({ ok: false, uncertain: true })
    expect(result.error).toContain('before sending again')
  })
})
