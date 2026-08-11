import { describe, expect, it } from 'vitest'

import {
  CARD_PROCESSING_FEE_LABEL,
  STRIPE_CARD_FIXED,
  STRIPE_CARD_PERCENT,
  cardChargedTotal,
  cardProcessingFee,
  cardProcessingFeeLine,
} from './invoice-lines.js'

/**
 * The card processing fee, which exists to keep ONE promise: whatever channel a
 * client pays through, the firm receives the invoice total exactly.
 *
 * That makes this arithmetic, not preference. A fee that is a cent light means
 * the firm quietly eats a cent on every card invoice; a fee that is a cent heavy
 * means the client is overcharged and the invoice and the card statement stop
 * agreeing. Both are the kind of thing an accounting firm gets asked about.
 *
 * The property tests below re-derive Stripe's cut from the exported constants
 * rather than hardcoding 2.9% + 30¢, so if the rates are ever changed these fail
 * only if the MATH broke — not simply because the number moved.
 */

/** What the firm is left with after Stripe takes its cut, in cents. */
function netCents(chargedDollars) {
  return Math.round(chargedDollars * 100) * (1 - STRIPE_CARD_PERCENT) - STRIPE_CARD_FIXED * 100
}

describe('cardProcessingFee', () => {
  it('grosses up so the firm nets the invoice exactly — the headline case', () => {
    // $100.00 invoice: the client pays $103.30, Stripe keeps $3.30, the firm
    // banks $100.00. A naive 2.9% + 30c ($3.20) would have left it $0.10 short.
    expect(cardProcessingFee(100)).toBe(3.3)
    expect(cardChargedTotal(100)).toBe(103.3)
    expect(netCents(103.3)).toBeGreaterThanOrEqual(10000)
  })

  /**
   * The edge the naive round misses. At $100.29 the gross-up lands on
   * 10359.42 cents, which rounds DOWN — and 10359 cents charged nets 10028.59,
   * four tenths of a cent under. The bump is what makes it 10360.
   */
  it('bumps a cent when rounding to the nearest cent would under-net', () => {
    expect(cardProcessingFee(100.29)).toBe(3.31)
    expect(cardChargedTotal(100.29)).toBe(103.6)
    expect(netCents(103.6)).toBeGreaterThanOrEqual(10029)
    // The un-bumped answer really would have been short.
    expect(netCents(103.59)).toBeLessThan(10029)
  })

  it('never nets less than the invoice, across a wide sweep of totals', () => {
    for (let cents = 1; cents <= 25000; cents += 7) {
      const total = cents / 100
      expect(netCents(cardChargedTotal(total))).toBeGreaterThanOrEqual(cents - 1e-9)
    }
  })

  it('is the SMALLEST fee that does that — a cent less always falls short', () => {
    for (let cents = 1; cents <= 25000; cents += 7) {
      const total = cents / 100
      const oneCentLess = Math.round(cardChargedTotal(total) * 100 - 1) / 100
      expect(netCents(oneCentLess)).toBeLessThan(cents - 1e-9)
    }
  })

  it('holds on the real invoice amounts this firm actually bills', () => {
    // Taken from production: a July hourly invoice, a monthly subscription, and
    // a whole month's billing.
    for (const total of [15, 500, 3837.58, 4400.83, 12400]) {
      expect(netCents(cardChargedTotal(total))).toBeGreaterThanOrEqual(total * 100 - 1e-9)
    }
  })

  it('charges nothing on a zero, negative or junk total', () => {
    expect(cardProcessingFee(0)).toBe(0)
    expect(cardProcessingFee(-25)).toBe(0)
    expect(cardProcessingFee(null)).toBe(0)
    expect(cardProcessingFee(undefined)).toBe(0)
    expect(cardProcessingFee('abc')).toBe(0)
  })

  it('returns whole cents, never a fraction of one', () => {
    for (const total of [0.01, 1, 9.99, 100.29, 3837.58]) {
      const fee = cardProcessingFee(total)
      expect(Math.round(fee * 100)).toBeCloseTo(fee * 100, 9)
    }
  })
})

describe('cardProcessingFeeLine', () => {
  it('is the fee for that invoice, under the shared label', () => {
    expect(cardProcessingFeeLine({ total: 100 })).toEqual({
      kind: 'card-fee',
      label: CARD_PROCESSING_FEE_LABEL,
      detail: 'Paid by card',
      amount: 3.3,
    })
  })

  // The kind is what stops the webhook appending it twice — one card payment
  // fires both `checkout.session.completed` and `payment_intent.succeeded`.
  it('carries the card-fee kind, not a generic custom line', () => {
    expect(cardProcessingFeeLine({ total: 500 }).kind).toBe('card-fee')
  })
})
