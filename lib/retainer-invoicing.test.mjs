import { describe, expect, it } from 'vitest'

import {
  RETAINER_CREDIT_LABEL,
  retainerCreditAmount,
  retainerCreditLine,
} from './invoice-lines.js'
import { nextRetainerInvoiceNumber } from './invoice-draft.js'
import { buildQboCsv } from './qbo-export.js'

/**
 * Retainers: the money collected when an engagement starts, and given back when
 * it ends.
 *
 * The invariant these tests exist for is THE FLOOR AT ZERO. A retainer credit is
 * the only line in this app that can be negative, and an invoice reading -$400
 * would be a promise to pay a client — something this app has no mechanism for
 * and no business printing. Everything else here (the numbering, what exports)
 * only matters because that number has to be right first.
 *
 * The store's half of the story — which retainer got spent, and the fact that it
 * can only be spent once — lives in db/store-staleness.test.mjs, because it is a
 * fact about two rows rather than about arithmetic.
 */

const monthly = (amount) => ({ kind: 'hourly', label: 'Billable hours', detail: '', amount })

describe('the retainer credit is sized by the calculator', () => {
  it('gives back the whole retainer when the invoice is bigger', () => {
    expect(retainerCreditAmount([monthly(1200)], 500)).toBe(-500)
  })

  it('never drives the total below zero', () => {
    // $500 held, $400 of work left. The credit stops at the work.
    expect(retainerCreditAmount([monthly(400)], 500)).toBe(-400)
  })

  it('lands the total exactly on zero when the two match', () => {
    const lines = [monthly(500)]
    const credit = retainerCreditAmount(lines, 500)
    expect(credit).toBe(-500)
    expect(lines.reduce((sum, line) => sum + line.amount, credit)).toBe(0)
  })

  it('sums every other line, not just the first', () => {
    expect(
      retainerCreditAmount(
        [
          monthly(300),
          { kind: 'reimbursement', label: 'Filing fee', detail: '', amount: 75 },
          { kind: 'adjustment', label: 'Adjustment — 2026-07', detail: '', amount: -25 },
        ],
        1000,
      ),
    ).toBe(-350)
  })

  // Re-sizing an invoice that already carries a credit must not measure against
  // itself: counting the -$400 already there would halve the credit every time
  // the lines were touched, silently.
  it('ignores a credit line already on the invoice', () => {
    const lines = [
      monthly(400),
      { kind: 'retainer_credit', label: RETAINER_CREDIT_LABEL, detail: '', amount: -400 },
    ]
    expect(retainerCreditAmount(lines, 500)).toBe(-400)
  })

  it('credits nothing when there is nothing left on the invoice', () => {
    expect(retainerCreditAmount([], 500)).toBe(0)
    expect(retainerCreditAmount([monthly(0)], 500)).toBe(0)
  })

  it('credits nothing from a retainer that holds nothing', () => {
    expect(retainerCreditAmount([monthly(400)], 0)).toBe(0)
    expect(retainerCreditAmount([monthly(400)], -100)).toBe(0)
  })

  it('rounds to cents', () => {
    expect(retainerCreditAmount([monthly(100.005)], 1000)).toBe(-100.01)
  })
})

describe('the credit as a line', () => {
  it('carries the retainer it came out of, so the save knows what to spend', () => {
    const line = retainerCreditLine({
      lines: [monthly(1200)],
      retainerAmount: 500,
      retainerId: 'inv-ret-1',
      retainerNumber: 'INV-RET-2026-001',
    })

    expect(line).toEqual({
      kind: 'retainer_credit',
      label: RETAINER_CREDIT_LABEL,
      detail: 'Retainer INV-RET-2026-001',
      amount: -500,
      retainerInvoiceId: 'inv-ret-1',
    })
  })

  it('is the same figure the calculator gives, clamped and all', () => {
    const lines = [monthly(400)]
    expect(retainerCreditLine({ lines, retainerAmount: 500 }).amount).toBe(
      retainerCreditAmount(lines, 500),
    )
  })
})

describe('retainer numbering', () => {
  it('starts a year at 001', () => {
    expect(nextRetainerInvoiceNumber('2026', [])).toBe('INV-RET-2026-001')
  })

  it('continues from the highest retainer of that year', () => {
    expect(
      nextRetainerInvoiceNumber('2026', ['INV-RET-2026-001', 'INV-RET-2026-002']),
    ).toBe('INV-RET-2026-003')
  })

  it('is scoped to its own year', () => {
    expect(nextRetainerInvoiceNumber('2027', ['INV-RET-2026-009'])).toBe('INV-RET-2027-001')
  })

  // The two sequences share an archive and must never hand out the same string.
  it('cannot collide with the monthly sequence', () => {
    expect(
      nextRetainerInvoiceNumber('2026', ['INV-2026-08-001', 'INV-2026-08-002']),
    ).toBe('INV-RET-2026-001')
  })
})

describe('a credited invoice exports for what is actually owed', () => {
  it('carries the retainer lines into the QBO file, credit negative', () => {
    const csv = buildQboCsv(
      [
        {
          number: 'INV-2026-08-004',
          clientId: 'c1',
          period: '2026-08',
          dueDate: '2026-09-30',
          status: 'reviewed',
          lineItems: [
            monthly(600),
            {
              kind: 'retainer_credit',
              label: RETAINER_CREDIT_LABEL,
              detail: 'Retainer INV-RET-2026-001',
              amount: -500,
            },
          ],
        },
      ],
      new Map([['c1', { name: 'Acme' }]]),
    )

    const rows = csv.split('\r\n')
    expect(rows).toHaveLength(3)
    expect(rows[2]).toContain('-500.00')
    // Both ends of a retainer share one item name, so they net out in QBO.
    expect(rows[2]).toContain('Retainer')
  })

  it('exports a retainer invoice itself', () => {
    const csv = buildQboCsv(
      [
        {
          number: 'INV-RET-2026-001',
          clientId: 'c1',
          period: '2026-01',
          dueDate: '2026-01-31',
          status: 'sent',
          lineItems: [{ kind: 'retainer', label: 'Retainer', detail: '', amount: 2500 }],
        },
      ],
      new Map([['c1', { name: 'Acme' }]]),
    )

    expect(csv.split('\r\n')[1]).toContain('2500.00')
  })
})
