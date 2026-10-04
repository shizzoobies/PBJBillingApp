import { describe, expect, it } from 'vitest'

import {
  AUTOPAY_STATUSES,
  autopayBadgeFor,
  autopaySummary,
  emptyAutopay,
  latestAttemptByInvoice,
} from './stripe-autopay.js'

describe('autopaySummary', () => {
  const row = {
    clientId: 'c1',
    status: 'enrolled',
    paymentMethodId: 'pm_secret',
    methodType: 'us_bank_account',
    last4: '6789',
    bankOrBrand: 'TEST BANK',
    mandateId: 'mandate_secret',
    consentedAt: '2026-10-05T12:00:00.000Z',
    invitedAt: '2026-10-04T12:00:00.000Z',
    setupToken: 'tok_secret',
    withdrawnAt: null,
    updatedAt: '2026-10-05T12:00:00.000Z',
  }

  it('says what the owner needs to read', () => {
    expect(autopaySummary(row)).toEqual({
      clientId: 'c1',
      status: 'enrolled',
      methodType: 'us_bank_account',
      last4: '6789',
      bankOrBrand: 'TEST BANK',
      invitedAt: '2026-10-04T12:00:00.000Z',
      consentedAt: '2026-10-05T12:00:00.000Z',
      withdrawnAt: null,
    })
  })

  it('never carries the setup token, the payment method id or the mandate id', () => {
    const text = JSON.stringify(autopaySummary(row))
    for (const secret of ['tok_secret', 'pm_secret', 'mandate_secret']) {
      expect(text).not.toContain(secret)
    }
  })

  it('reads an unknown or missing status as off', () => {
    expect(autopaySummary({ clientId: 'c1', status: 'weird' }).status).toBe('off')
    expect(autopaySummary(null).status).toBe('off')
    expect(autopaySummary(emptyAutopay('c1')).status).toBe('off')
  })

  it('knows the six statuses', () => {
    expect(AUTOPAY_STATUSES).toEqual([
      'off',
      'invited',
      'pending_verification',
      'enrolled',
      'withdrawn',
      'revoked',
    ])
  })
})

describe('the invoice badge', () => {
  const attempt = (invoiceId, attemptNo, status) => ({ invoiceId, attemptNo, status })

  it('uses the highest attempt number per invoice', () => {
    const latest = latestAttemptByInvoice([
      attempt('a', 2, 'processing'),
      attempt('a', 1, 'failed'),
      attempt('b', 1, 'succeeded'),
    ])
    expect(latest.get('a').attemptNo).toBe(2)
    expect(latest.get('b').status).toBe('succeeded')
  })

  it('is autopay while claimed, in flight or collected', () => {
    for (const status of ['claimed', 'processing', 'succeeded']) {
      expect(autopayBadgeFor(attempt('a', 1, status))).toBe('autopay')
    }
  })

  it('is failed when the latest attempt failed, and nothing when there was none', () => {
    expect(autopayBadgeFor(attempt('a', 1, 'failed'))).toBe('failed')
    expect(autopayBadgeFor(undefined)).toBeNull()
    expect(autopayBadgeFor(attempt('a', 1, 'mystery'))).toBeNull()
  })
})
