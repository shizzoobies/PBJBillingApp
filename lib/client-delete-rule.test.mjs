import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import {
  CLIENT_HAS_INVOICES_REASON,
  CLIENT_HAS_INVOICES_REASON_RETIRED,
  CLIENT_HAS_TIME_REASON,
  CLIENT_HAS_TIME_REASON_RETIRED,
  clientDeleteVerdict,
  clientHistoryRefusal,
} from './client-delete-rule.js'

describe('clientDeleteVerdict', () => {
  it('lets a client with no time and no invoices be deleted', () => {
    assert.deepEqual(clientDeleteVerdict({ timeEntryCount: 0, invoiceCount: 0 }), {
      deletable: true,
      reason: null,
      retiredReason: null,
    })
    assert.equal(clientDeleteVerdict().deletable, true)
  })

  it('refuses a client with time logged, in words', () => {
    const verdict = clientDeleteVerdict({ timeEntryCount: 3, invoiceCount: 0 })
    assert.equal(verdict.deletable, false)
    assert.equal(
      verdict.reason,
      'This client has time logged, so it cannot be deleted. Mark it inactive instead.',
    )
    assert.equal(verdict.reason, CLIENT_HAS_TIME_REASON)
  })

  it('refuses a client with only invoices (void ones count - the count is of rows, not of status)', () => {
    const verdict = clientDeleteVerdict({ timeEntryCount: 0, invoiceCount: 1 })
    assert.equal(verdict.deletable, false)
    assert.equal(
      verdict.reason,
      'This client has invoices, so it cannot be deleted. Mark it inactive instead.',
    )
    assert.equal(verdict.reason, CLIENT_HAS_INVOICES_REASON)
  })

  it('gives the time sentence when both are true', () => {
    assert.equal(
      clientDeleteVerdict({ timeEntryCount: 2, invoiceCount: 5 }).reason,
      CLIENT_HAS_TIME_REASON,
    )
  })
})

describe('the variant for a client that is already inactive', () => {
  it('drops "Mark it inactive instead" and nothing else', () => {
    assert.equal(
      clientDeleteVerdict({ timeEntryCount: 1 }).retiredReason,
      'This client has time logged, so it cannot be deleted.',
    )
    assert.equal(
      clientDeleteVerdict({ invoiceCount: 1 }).retiredReason,
      'This client has invoices, so it cannot be deleted.',
    )
    assert.equal(CLIENT_HAS_TIME_REASON_RETIRED + ' Mark it inactive instead.', CLIENT_HAS_TIME_REASON)
    assert.equal(
      CLIENT_HAS_INVOICES_REASON_RETIRED + ' Mark it inactive instead.',
      CLIENT_HAS_INVOICES_REASON,
    )
  })

  it('keeps the same precedence, and has none for a deletable client', () => {
    assert.equal(
      clientDeleteVerdict({ timeEntryCount: 1, invoiceCount: 1 }).retiredReason,
      CLIENT_HAS_TIME_REASON_RETIRED,
    )
    assert.equal(clientDeleteVerdict().retiredReason, null)
  })
})

describe('clientHistoryRefusal', () => {
  it('names the client and says time logged', () => {
    assert.equal(
      clientHistoryRefusal('Acme', { hasTime: true, hasInvoices: false }),
      'Acme has time logged and cannot be deleted. Reload and mark it inactive instead.',
    )
  })

  it('says invoices only when there is no time', () => {
    assert.equal(
      clientHistoryRefusal('Acme', { hasTime: false, hasInvoices: true }),
      'Acme has invoices and cannot be deleted. Reload and mark it inactive instead.',
    )
  })

  it('prefers time when both are true', () => {
    assert.match(clientHistoryRefusal('Acme', { hasTime: true, hasInvoices: true }), /time logged/)
  })
})
