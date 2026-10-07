import { describe, expect, it } from 'vitest'

import {
  ACCOUNT_CREDIT_LABEL,
  COMBINED_KEPT_KINDS,
  accountCreditAvailableCents,
  accountCreditLabel,
  accountCreditWantedCents,
  invoiceSections,
  planAccountCreditDraws,
  retainerCreditAmount,
} from './invoice-lines.js'
import { buildInvoiceEmail, clientFacingInvoiceLines } from './invoice-email.js'
import { buildInvoicePdf } from './invoice-pdf.js'
import { buildQboCsv } from './qbo-export.js'
import { editChangesWhatClientSees } from './invoice-sent-change.js'

/**
 * Credit on account, stage 1b: the invoice line that draws it and the one rule
 * that sizes it. PURE: the store's half (the draws as the ledger, the lock, the
 * re-size on save) is in db/store-staleness.test.mjs.
 */

const work = (amount) => ({ kind: 'hourly', label: 'Billable hours', detail: '', amount })

/** A credit as the store's ledger view gives it. */
const credit = (id, amount, over = {}) => ({
  id,
  amount,
  forPeriod: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  voidedAt: null,
  draws: [],
  ...over,
})

describe('what an invoice can take', () => {
  it('is every line but a credit on account, floored at zero, in cents', () => {
    expect(accountCreditWantedCents([work(600), { kind: 'reimbursement', amount: 40.5 }])).toBe(64050)
    expect(accountCreditWantedCents([work(600), { kind: 'account_credit', amount: -250 }])).toBe(60000)
    expect(accountCreditWantedCents([work(100), { kind: 'adjustment', amount: -300 }])).toBe(0)
    expect(accountCreditWantedCents([])).toBe(0)
    expect(accountCreditWantedCents(null)).toBe(0)
  })

  it('leaves the retainer credit IN, so the two credits cannot push the total below zero', () => {
    const lines = [work(600), { kind: 'retainer_credit', amount: -500 }]
    expect(accountCreditWantedCents(lines)).toBe(10000)
    const plan = planAccountCreditDraws({ lines, credits: [credit('a', 400)] })
    expect(plan.totalCents).toBe(10000)
  })

  it('is invisible to the retainer calculator, which is sized first', () => {
    const lines = [work(600), { kind: 'account_credit', amount: -250 }]
    expect(retainerCreditAmount(lines, 1000)).toBe(-600)
  })
})

describe('what one credit has left, as far as one invoice is concerned', () => {
  it('is its amount less every OTHER invoice\'s draws', () => {
    const c = credit('a', 500, {
      draws: [
        { invoiceId: 'other', amount: 120 },
        { invoiceId: 'mine', amount: 200 },
      ],
    })
    expect(accountCreditAvailableCents(c, 'mine')).toBe(38000)
    expect(accountCreditAvailableCents(c, 'nobody')).toBe(18000)
  })

  it('is nothing for a void credit, a missing one, or one overdrawn elsewhere', () => {
    expect(accountCreditAvailableCents(credit('a', 100, { voidedAt: '2026-10-01T00:00:00.000Z' }))).toBe(0)
    expect(accountCreditAvailableCents(null)).toBe(0)
    expect(accountCreditAvailableCents(credit('a', 100, { draws: [{ invoiceId: 'x', amount: 150 }] }))).toBe(0)
  })
})

describe('the draws an apply makes', () => {
  it('takes the oldest credit first, then the next', () => {
    const plan = planAccountCreditDraws({
      lines: [work(300)],
      credits: [
        credit('newer', 200, { createdAt: '2026-09-20T00:00:00.000Z' }),
        credit('older', 150, { createdAt: '2026-09-01T00:00:00.000Z' }),
      ],
    })
    expect(plan.draws).toEqual([
      { creditId: 'older', amount: 150 },
      { creditId: 'newer', amount: 150 },
    ])
    expect(plan.totalCents).toBe(30000)
  })

  it('takes the credits meant for the invoice\'s own month BEFORE older ones', () => {
    const plan = planAccountCreditDraws({
      lines: [work(100)],
      period: '2026-11',
      credits: [
        credit('old', 500, { createdAt: '2026-08-01T00:00:00.000Z' }),
        credit('november', 60, { forPeriod: '2026-11', createdAt: '2026-10-01T00:00:00.000Z' }),
      ],
    })
    expect(plan.draws).toEqual([
      { creditId: 'november', amount: 60 },
      { creditId: 'old', amount: 40 },
    ])
  })

  it('never takes more than the pre-credit total, so the invoice lands on zero at most', () => {
    const plan = planAccountCreditDraws({ lines: [work(80.25)], credits: [credit('a', 500)] })
    expect(plan.totalCents).toBe(8025)
    expect(plan.line.amount).toBe(-80.25)
    expect(plan.draws).toEqual([{ creditId: 'a', amount: 80.25 }])
  })

  it('never takes more than the client has, and skips void credits and ones used up elsewhere', () => {
    const plan = planAccountCreditDraws({
      lines: [work(1000)],
      invoiceId: 'mine',
      credits: [
        credit('void', 300, { voidedAt: '2026-10-01T00:00:00.000Z' }),
        credit('spent', 100, { draws: [{ invoiceId: 'other', amount: 100 }] }),
        credit('live', 70.5),
      ],
    })
    expect(plan.draws).toEqual([{ creditId: 'live', amount: 70.5 }])
  })

  it('does not count the invoice\'s own draws against what it may take again', () => {
    const plan = planAccountCreditDraws({
      lines: [work(1000)],
      invoiceId: 'mine',
      credits: [credit('a', 300, { draws: [{ invoiceId: 'mine', amount: 300 }] })],
    })
    expect(plan.totalCents).toBe(30000)
  })

  it('has no line when nothing can be drawn', () => {
    expect(planAccountCreditDraws({ lines: [work(100)], credits: [] }).line).toBeNull()
    expect(planAccountCreditDraws({ lines: [], credits: [credit('a', 50)] }).line).toBeNull()
    expect(planAccountCreditDraws({ lines: [work(100)], credits: null }).totalCents).toBe(0)
  })

  it('rounds half-cents the way the ledger does', () => {
    const plan = planAccountCreditDraws({ lines: [work(10.005)], credits: [credit('a', 100)] })
    expect(plan.totalCents).toBe(1001)
  })
})

describe('re-sizing a line the invoice already carries', () => {
  it('keeps the same credits in the same order and only SHRINKS them to fit', () => {
    const credits = [
      credit('a', 100, { createdAt: '2026-09-01T00:00:00.000Z' }),
      credit('b', 100, { createdAt: '2026-09-02T00:00:00.000Z' }),
    ]
    const existing = [
      { creditId: 'b', amount: 100 },
      { creditId: 'a', amount: 60 },
    ]
    const shrunk = planAccountCreditDraws({ lines: [work(130)], credits, existing })
    expect(shrunk.draws).toEqual([
      { creditId: 'b', amount: 100 },
      { creditId: 'a', amount: 30 },
    ])
    // ... and does not grow back toward what is available when the invoice does.
    const grown = planAccountCreditDraws({ lines: [work(900)], credits, existing })
    expect(grown.totalCents).toBe(16000)
  })

  it('drops a draw on a credit that is gone or void, and caps one that was overdrawn', () => {
    const credits = [
      credit('void', 100, { voidedAt: '2026-10-01T00:00:00.000Z' }),
      credit('small', 40),
    ]
    const plan = planAccountCreditDraws({
      lines: [work(500)],
      credits,
      existing: [
        { creditId: 'gone', amount: 10 },
        { creditId: 'void', amount: 100 },
        { creditId: 'small', amount: 90 },
      ],
    })
    expect(plan.draws).toEqual([{ creditId: 'small', amount: 40 }])
  })

  it('merges two draws on one credit into one', () => {
    const plan = planAccountCreditDraws({
      lines: [work(500)],
      credits: [credit('a', 100)],
      existing: [
        { creditId: 'a', amount: 30 },
        { creditId: 'a', amount: 50 },
      ],
    })
    expect(plan.draws).toEqual([{ creditId: 'a', amount: 80 }])
  })
})

describe('what the line says', () => {
  it('is plain when the credit is not meant for a month', () => {
    expect(accountCreditLabel([null])).toBe(ACCOUNT_CREDIT_LABEL)
    expect(accountCreditLabel([])).toBe('Credit on account')
  })

  it('names the month when every credit drawn was meant for that one', () => {
    expect(accountCreditLabel(['2026-11'])).toBe('Credit on account - meant for November 2026')
    expect(accountCreditLabel(['2026-11', '2026-11'])).toBe('Credit on account - meant for November 2026')
  })

  it('stays plain when the credits drawn were meant for different months, or only some were', () => {
    expect(accountCreditLabel(['2026-11', '2026-12'])).toBe('Credit on account')
    expect(accountCreditLabel(['2026-11', null])).toBe('Credit on account')
  })

  it('is the label the plan builds the line with', () => {
    const plan = planAccountCreditDraws({
      lines: [work(100)],
      period: '2026-11',
      credits: [credit('a', 500, { forPeriod: '2026-11' })],
    })
    expect(plan.line).toEqual({
      kind: 'account_credit',
      label: 'Credit on account - meant for November 2026',
      detail: '',
      amount: -100,
      draws: [{ creditId: 'a', amount: 100 }],
    })
  })
})

/* -------------------------------------------------------------------------- */
/* Where the client reads it                                                  */
/* -------------------------------------------------------------------------- */

const creditLine = (over = {}) => ({
  kind: 'account_credit',
  label: 'Credit on account - meant for August 2026',
  detail: '',
  amount: -200,
  draws: [{ creditId: 'a', amount: 200 }],
  ...over,
})

const stored = (over = {}) => ({
  id: 'inv-1',
  number: 'INV-2026-08-001',
  period: '2026-08',
  status: 'sent',
  lineItems: [
    { kind: 'plan', label: 'Monthly service', detail: 'Monthly service', amount: 900 },
    { kind: 'reimbursement', label: 'Reimbursement: Filing fee', detail: 'Aug 3, 2026', amount: 45 },
    creditLine(),
  ],
  subtotal: 945,
  total: 745,
  dueDate: '2026-09-15',
  blurb: '',
  sentAt: '2026-08-11T10:00:00.000Z',
  paidAt: null,
  paymentMethod: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  ...over,
})

describe('in the sections', () => {
  it('prints under the sections with the other charges, negative, and the rows still add up', () => {
    const lines = clientFacingInvoiceLines(stored(), { id: 'c1', name: 'Acme' })
    const sections = invoiceSections(lines)
    expect(sections.map((section) => section.key)).toEqual(['plan', 'expenses', 'charges'])
    const charges = sections.at(-1)
    expect(charges.rows).toEqual([creditLine()])
    const money = sections.reduce(
      (sum, section) => sum + section.rows.reduce((inner, row) => inner + row.amount, 0),
      0,
    )
    expect(money).toBe(745)
  })
})

describe('on a billing master\'s combined invoice', () => {
  const master = { id: 'm1', name: 'KLC', isBillingMaster: true }
  const combined = (extra, total) =>
    clientFacingInvoiceLines(
      {
        id: 'inv-m',
        number: 'INV-2026-08-009',
        period: '2026-08',
        total,
        lineItems: [
          { kind: 'plan', label: 'Monthly service - Chemtrex', detail: '', amount: 540, sourceClientId: 'sub-1' },
          extra,
        ],
      },
      master,
    )

  it('is one of the kinds that survive the merge', () => {
    expect(COMBINED_KEPT_KINDS.has('account_credit')).toBe(true)
  })

  it('is kept, stated beside the combined line, and the column still adds to the amount due', () => {
    const lines = combined(creditLine({ label: 'Credit on account' }), 340)
    expect(lines).toHaveLength(2)
    expect(lines[0].amount).toBe(540)
    expect(lines[1]).toMatchObject({ kind: 'account_credit', amount: -200 })
    expect(lines.reduce((sum, line) => sum + line.amount, 0)).toBe(340)
  })

  it('names no company and carries nothing that would (draws name credits, and are not printed)', () => {
    const lines = combined(creditLine({ label: 'Credit on account' }), 340)
    expect(lines.map((line) => line.label).join(' ')).not.toMatch(/Chemtrex/)
  })
})

describe('on the emailed copy and the PDF', () => {
  const client = { id: 'c1', name: 'Clover Ridge Dental', contactIds: [] }

  it('the email states the credit, negative and named, and the total after it', () => {
    const { html, text } = buildInvoiceEmail({ invoice: stored(), client })
    for (const surface of [html, text]) {
      expect(surface).toContain('Credit on account - meant for August 2026')
      expect(surface).toContain('-$200.00')
      expect(surface).toContain('$745.00')
    }
    expect(html.indexOf('Reimbursement: Filing fee')).toBeLessThan(
      html.indexOf('Credit on account - meant for August 2026'),
    )
  })

  const pdfText = (buffer) => {
    const raw = buffer.toString('latin1')
    const runs = []
    for (const match of raw.matchAll(/\[([^\]]*)\]\s*TJ/g)) runs.push(match[1])
    for (const match of raw.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) runs.push(`<${match[1]}>`)
    return runs
      .map((run) =>
        [...run.matchAll(/<([0-9A-Fa-f]*)>/g)]
          .map((hex) => Buffer.from(hex[1], 'hex').toString('latin1'))
          .join(''),
      )
      .join('\n')
  }

  it('the PDF prints the same line after the services, with the same total', async () => {
    const text = pdfText(await buildInvoicePdf({ invoice: stored(), client, compress: false }))
    expect(text).toContain('Credit on account - meant for August 2026')
    expect(text).toContain('-$200.00')
    expect(text).toContain('$745.00')
    expect(text.indexOf('Reimbursement: Filing fee')).toBeLessThan(
      text.indexOf('Credit on account - meant for August 2026'),
    )
  })
})

describe('in the QuickBooks file', () => {
  it('exports as a NEGATIVE line on the Deferred Revenue item, with the service lines at the full fee', () => {
    const csv = buildQboCsv(
      [
        {
          number: 'INV-2026-08-004',
          clientId: 'c1',
          period: '2026-08',
          dueDate: '2026-09-30',
          status: 'reviewed',
          lineItems: [
            { kind: 'plan', label: 'Monthly service', detail: '', amount: 900 },
            creditLine({ label: 'Credit on account', amount: -300 }),
          ],
        },
      ],
      new Map([['c1', { name: 'Acme' }]]),
    )
    const rows = csv.split('\r\n')
    expect(rows).toHaveLength(3)
    expect(rows[1]).toContain('Services')
    expect(rows[1]).toContain('900.00')
    expect(rows[2]).toContain('Deferred Revenue')
    expect(rows[2]).toContain('-300.00')
  })
})

describe('changed since it was sent', () => {
  const edit = (before, after) =>
    editChangesWhatClientSees({ lineItems: { before, after } })

  it('counts when the amount or the wording of the credit moves', () => {
    expect(edit([creditLine()], [creditLine({ amount: -150 })])).toBe(true)
    expect(edit([creditLine()], [creditLine({ label: 'Credit on account' })])).toBe(true)
  })

  it('counts when the credit line is added or taken off', () => {
    expect(edit([work(500)], [work(500), creditLine()])).toBe(true)
    expect(edit([work(500), creditLine()], [work(500)])).toBe(true)
  })

  it('does not count a change to which credit paid how much, which the client cannot see', () => {
    expect(
      edit([creditLine()], [creditLine({ draws: [{ creditId: 'b', amount: 200 }] })]),
    ).toBe(false)
  })
})
