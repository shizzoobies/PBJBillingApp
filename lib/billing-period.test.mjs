import { describe, expect, it } from 'vitest'
import {
  BILLING_PERIOD_MAX_MONTHS,
  billingPeriodSentence,
  hasBillingPeriod,
  nextPrepaymentMonth,
  normalizeBillingPeriodMonths,
  normalizePeriodAnchorMonth,
  periodAnchorFor,
  prepaymentLabel,
  prepaymentLines,
  prepaymentMonthsFor,
  unpaidPrepaymentFor,
  validateBillingPeriod,
} from './billing-period.js'

const client = (over = {}) => ({
  id: 'client-q',
  billingMode: 'subscription',
  monthlyRate: 500,
  billingPeriodMonths: 3,
  periodAnchorMonth: '2026-10',
  ...over,
})

describe('normalizeBillingPeriodMonths', () => {
  it('keeps a whole number from 1 to 24', () => {
    expect(normalizeBillingPeriodMonths(1)).toBe(1)
    expect(normalizeBillingPeriodMonths(3)).toBe(3)
    expect(normalizeBillingPeriodMonths('6')).toBe(6)
    expect(normalizeBillingPeriodMonths(BILLING_PERIOD_MAX_MONTHS)).toBe(24)
  })

  it('answers 1 (monthly) for anything else', () => {
    for (const bad of [0, -2, 25, 2.5, '', 'abc', null, undefined, NaN, {}]) {
      expect(normalizeBillingPeriodMonths(bad)).toBe(1)
    }
  })
})

describe('normalizePeriodAnchorMonth', () => {
  it('keeps a real YYYY-MM and nothing else', () => {
    expect(normalizePeriodAnchorMonth('2026-10')).toBe('2026-10')
    for (const bad of ['2026-13', '2026-00', '2026-1', '26-10', '', null, undefined, 202610, '2026-10-01']) {
      expect(normalizePeriodAnchorMonth(bad)).toBeNull()
    }
  })
})

describe('validateBillingPeriod', () => {
  it('accepts monthly with no anchor', () => {
    expect(validateBillingPeriod({ months: 1, anchor: '' })).toEqual({ ok: true })
  })

  it('requires a whole number from 1 to 24', () => {
    expect(validateBillingPeriod({ months: 0, anchor: '2026-10' }).ok).toBe(false)
    expect(validateBillingPeriod({ months: 25, anchor: '2026-10' }).ok).toBe(false)
    expect(validateBillingPeriod({ months: 2.5, anchor: '2026-10' }).ok).toBe(false)
  })

  it('requires the first month of a period when billing less often than monthly', () => {
    const refused = validateBillingPeriod({ months: 3, anchor: '' })
    expect(refused.ok).toBe(false)
    expect(refused.message).toMatch(/first month/i)
    expect(validateBillingPeriod({ months: 3, anchor: '2026-10' })).toEqual({ ok: true })
  })
})

describe('hasBillingPeriod', () => {
  it('is true only for a subscription client with a rate, N above 1 and an anchor', () => {
    expect(hasBillingPeriod(client())).toBe(true)
    expect(hasBillingPeriod(client({ billingPeriodMonths: 1 }))).toBe(false)
    expect(hasBillingPeriod(client({ periodAnchorMonth: null }))).toBe(false)
    expect(hasBillingPeriod(client({ monthlyRate: 0 }))).toBe(false)
    expect(hasBillingPeriod(client({ monthlyRate: undefined }))).toBe(false)
    expect(hasBillingPeriod(client({ billingMode: 'hourly' }))).toBe(false)
    expect(hasBillingPeriod(client({ billingMode: 'annual' }))).toBe(false)
    expect(hasBillingPeriod({})).toBe(false)
  })
})

describe('periodAnchorFor', () => {
  it('names the first month of the period a month falls in', () => {
    const c = client()
    expect(periodAnchorFor(c, '2026-10')).toBe('2026-10')
    expect(periodAnchorFor(c, '2026-11')).toBe('2026-10')
    expect(periodAnchorFor(c, '2026-12')).toBe('2026-10')
    expect(periodAnchorFor(c, '2027-01')).toBe('2027-01')
    expect(periodAnchorFor(c, '2027-03')).toBe('2027-01')
  })

  it('is null before the anchor, and for a client with no period', () => {
    expect(periodAnchorFor(client(), '2026-09')).toBeNull()
    expect(periodAnchorFor(client({ billingPeriodMonths: 1 }), '2026-11')).toBeNull()
  })
})

describe('prepaymentMonthsFor', () => {
  it('lists the LATER months of the period on an anchor month only', () => {
    const c = client()
    expect(prepaymentMonthsFor(c, '2026-10')).toEqual(['2026-11', '2026-12'])
    expect(prepaymentMonthsFor(c, '2026-11')).toEqual([])
    expect(prepaymentMonthsFor(c, '2026-12')).toEqual([])
    expect(prepaymentMonthsFor(c, '2027-01')).toEqual(['2027-02', '2027-03'])
  })

  it('gives nothing before the anchor', () => {
    expect(prepaymentMonthsFor(client({ periodAnchorMonth: '2027-01' }), '2026-10')).toEqual([])
  })

  it('crosses a year end and handles a long period', () => {
    expect(prepaymentMonthsFor(client({ billingPeriodMonths: 2, periodAnchorMonth: '2026-12' }), '2026-12')).toEqual([
      '2027-01',
    ])
    expect(prepaymentMonthsFor(client({ billingPeriodMonths: 24, periodAnchorMonth: '2026-01' }), '2026-01')).toHaveLength(23)
  })

  it('is empty for a monthly, hourly or annual client', () => {
    expect(prepaymentMonthsFor(client({ billingPeriodMonths: 1 }), '2026-10')).toEqual([])
    expect(prepaymentMonthsFor(client({ billingMode: 'hourly' }), '2026-10')).toEqual([])
    expect(prepaymentMonthsFor(client({ billingMode: 'annual', annualRate: 1200 }), '2026-10')).toEqual([])
  })
})

describe('prepaymentLines', () => {
  it('builds one line per later month at the current monthly fee', () => {
    expect(prepaymentLines(client(), '2026-10')).toEqual([
      { kind: 'prepayment', label: 'Prepayment for November 2026', detail: '', amount: 500, period: '2026-11' },
      { kind: 'prepayment', label: 'Prepayment for December 2026', detail: '', amount: 500, period: '2026-12' },
    ])
    expect(prepaymentLines(client(), '2026-11')).toEqual([])
  })

  it('has a label helper the editor and the tests share', () => {
    expect(prepaymentLabel('2027-02')).toBe('Prepayment for February 2027')
  })
})

describe('nextPrepaymentMonth', () => {
  it('is the anchor itself while it is still ahead', () => {
    expect(nextPrepaymentMonth(client(), '2026-09')).toBe('2026-10')
  })

  it('is this month on an anchor month and the next anchor otherwise', () => {
    expect(nextPrepaymentMonth(client(), '2026-10')).toBe('2026-10')
    expect(nextPrepaymentMonth(client(), '2026-11')).toBe('2027-01')
    expect(nextPrepaymentMonth(client(), '2027-03')).toBe('2027-04')
  })

  it('is null for a client with no period', () => {
    expect(nextPrepaymentMonth(client({ billingPeriodMonths: 1 }), '2026-10')).toBeNull()
  })
})

describe('billingPeriodSentence', () => {
  it('says what the next prepayment is and what it covers', () => {
    expect(billingPeriodSentence({ months: 3, anchor: '2026-10', today: '2026-10-07' })).toBe(
      'The next prepayment is on the October 2026 invoice. It covers October through December 2026 and carries the estimated fee for November and December.',
    )
  })

  it('names the following period once the anchor month has passed', () => {
    expect(billingPeriodSentence({ months: 3, anchor: '2026-10', today: '2026-11-05' })).toBe(
      'The next prepayment is on the January 2027 invoice. It covers January through March 2027 and carries the estimated fee for February and March.',
    )
  })

  it('reads right for two months and for monthly', () => {
    expect(billingPeriodSentence({ months: 2, anchor: '2026-12', today: '2026-12-01' })).toBe(
      'The next prepayment is on the December 2026 invoice. It covers December 2026 through January 2027 and carries the estimated fee for January.',
    )
    expect(billingPeriodSentence({ months: 1, anchor: '', today: '2026-12-01' })).toBe(
      'Billed every month, as always. Nothing is prepaid.',
    )
  })

  it('asks for the first month while the anchor is missing', () => {
    expect(billingPeriodSentence({ months: 3, anchor: '', today: '2026-10-07' })).toMatch(/pick the first month/i)
  })
})

describe('unpaidPrepaymentFor (the send guard)', () => {
  const c = client()
  const anchorInvoice = (over = {}) => ({
    id: 'inv-oct',
    clientId: 'client-q',
    kind: 'monthly',
    period: '2026-10',
    number: 'INV-2026-10-001',
    status: 'sent',
    lineItems: [
      { kind: 'plan', amount: 500 },
      { kind: 'prepayment', amount: 500, period: '2026-11' },
      { kind: 'prepayment', amount: 500, period: '2026-12' },
    ],
    ...over,
  })
  const november = (over = {}) => ({
    id: 'inv-nov',
    clientId: 'client-q',
    kind: 'monthly',
    period: '2026-11',
    number: 'INV-2026-11-001',
    status: 'reviewed',
    lineItems: [{ kind: 'plan', amount: 500 }],
    ...over,
  })

  it('names the anchor invoice when it is sent but not paid', () => {
    const found = unpaidPrepaymentFor({ client: c, invoice: november(), invoices: [anchorInvoice()] })
    expect(found).toMatchObject({
      anchorPeriod: '2026-10',
      month: '2026-11',
      anchorInvoice: { id: 'inv-oct', number: 'INV-2026-10-001', status: 'sent' },
    })
    expect(found.message).toBe(
      'INV-2026-10-001 carries the prepayment for November 2026 and has not been paid yet (it is Sent), so sending this invoice would bill that month again.',
    )
  })

  it.each([
    ['draft', /has not been sent yet/],
    ['reviewed', /has not been sent yet/],
  ])('also stops (reason unpaid) when the anchor invoice is %s', (status, wording) => {
    const found = unpaidPrepaymentFor({ client: c, invoice: november(), invoices: [anchorInvoice({ status })] })
    expect(found.message).toMatch(wording)
  })

  it('holds nothing for a month no anchor invoice billed ahead (M-4)', () => {
    // No anchor invoice at all (never generated).
    expect(unpaidPrepaymentFor({ client: c, invoice: november(), invoices: [] })).toBeNull()
    // An anchor invoice that never carried November's line (the anchor was set in the
    // past, or she removed the line): it billed nothing ahead, so nothing is held.
    expect(
      unpaidPrepaymentFor({
        client: c,
        invoice: november(),
        invoices: [anchorInvoice({ lineItems: [{ kind: 'plan', amount: 500 }] })],
      }),
    ).toBeNull()
    // It carries December's line, not November's.
    expect(
      unpaidPrepaymentFor({
        client: c,
        invoice: november(),
        invoices: [anchorInvoice({ lineItems: [{ kind: 'prepayment', amount: 500, period: '2026-12' }] })],
      }),
    ).toBeNull()
  })

  it('tags the unpaid hold with the reason unpaid', () => {
    expect(unpaidPrepaymentFor({ client: c, invoice: november(), invoices: [anchorInvoice()] }).reason).toBe('unpaid')
  })

  describe('a PAID anchor (I-1: the month was generated before it was paid)', () => {
    const paid = anchorInvoice({ status: 'paid' })
    const credit = (over = {}) => ({ id: 'prepay:inv-oct:2026-11', remaining: 500, ...over })
    const drawLine = (creditId = 'prepay:inv-oct:2026-11') => ({
      kind: 'account_credit',
      amount: -500,
      draws: [{ creditId, amount: 500 }],
    })

    it('holds a month that carries no draw while the derived credit still has money left', () => {
      const found = unpaidPrepaymentFor({ client: c, invoice: november(), invoices: [paid], credits: [credit()] })
      expect(found).toMatchObject({
        reason: 'not_applied',
        month: '2026-11',
        anchorPeriod: '2026-10',
        anchorInvoice: { id: 'inv-oct', status: 'paid' },
      })
      expect(found.message).toBe(
        "This month was prepaid on October 2026's invoice, but the prepayment has not been applied to this invoice. Apply credit on account, or Void & regenerate, before sending.",
      )
    })

    it('passes once the invoice draws that credit (Apply credit or a regenerate)', () => {
      const drawing = november({ lineItems: [{ kind: 'plan', amount: 500 }, drawLine()] })
      expect(unpaidPrepaymentFor({ client: c, invoice: drawing, invoices: [paid], credits: [credit()] })).toBeNull()
    })

    it('holds a draw on some OTHER credit as not applied', () => {
      const other = november({ lineItems: [{ kind: 'plan', amount: 500 }, drawLine('credit-xyz')] })
      expect(unpaidPrepaymentFor({ client: c, invoice: other, invoices: [paid], credits: [credit()] }).reason).toBe(
        'not_applied',
      )
    })

    it('passes when the credit is used up elsewhere, missing, or the ledger was not supplied', () => {
      expect(unpaidPrepaymentFor({ client: c, invoice: november(), invoices: [paid], credits: [credit({ remaining: 0 })] })).toBeNull()
      expect(unpaidPrepaymentFor({ client: c, invoice: november(), invoices: [paid], credits: [] })).toBeNull()
      expect(unpaidPrepaymentFor({ client: c, invoice: november(), invoices: [paid] })).toBeNull()
    })
  })

  describe('a PROCESSING anchor (R-3: the bank transfer is still clearing)', () => {
    const clearing = anchorInvoice({ status: 'processing' })

    it('holds with its own reason and sentence: the credit arrives when it settles, so sending now double-bills', () => {
      const found = unpaidPrepaymentFor({ client: c, invoice: november(), invoices: [clearing] })
      expect(found).toMatchObject({
        reason: 'processing',
        month: '2026-11',
        anchorPeriod: '2026-10',
        anchorInvoice: { id: 'inv-oct', status: 'processing' },
      })
      expect(found.message).toBe(
        "This month was prepaid on October 2026's invoice and that payment is still clearing. Once it settles, Apply credit on account (or Void & regenerate) and send then.",
      )
    })

    it('keeps the unpaid reason (with Send anyway) for a sent or draft anchor', () => {
      expect(unpaidPrepaymentFor({ client: c, invoice: november(), invoices: [anchorInvoice()] }).reason).toBe('unpaid')
      expect(unpaidPrepaymentFor({ client: c, invoice: november(), invoices: [anchorInvoice({ status: 'draft' })] }).reason).toBe('unpaid')
    })

    it('does not fire for a month that owes nothing', () => {
      expect(unpaidPrepaymentFor({ client: c, invoice: november({ total: 0 }), invoices: [clearing] })).toBeNull()
    })

    it('still fires while it owes something', () => {
      expect(unpaidPrepaymentFor({ client: c, invoice: november({ total: 1 }), invoices: [clearing] }).reason).toBe('processing')
    })
  })

  describe('a month that owes nothing has nothing to apply (R-1)', () => {
    const paid = anchorInvoice({ status: 'paid' })
    const credit = { id: 'prepay:inv-oct:2026-11', remaining: 500 }
    it('passes when the total is 0 or less (fee typed down, or covered by a retainer or other credit)', () => {
      expect(unpaidPrepaymentFor({ client: c, invoice: november({ total: 0 }), invoices: [paid], credits: [credit] })).toBeNull()
      expect(unpaidPrepaymentFor({ client: c, invoice: november({ total: -5 }), invoices: [paid], credits: [credit] })).toBeNull()
    })
    it('still holds when it owes something, and when the total is not known to be 0', () => {
      expect(unpaidPrepaymentFor({ client: c, invoice: november({ total: 1 }), invoices: [paid], credits: [credit] }).reason).toBe('not_applied')
      expect(unpaidPrepaymentFor({ client: c, invoice: november({ total: 500 }), invoices: [paid], credits: [credit] }).reason).toBe('not_applied')
    })
  })

  describe('a month fully covered by OTHER credit is not held, whatever the anchor (M-5)', () => {
    // The total is already 0 (or less) because a manual or overpayment credit or a
    // retainer covered it, so sending it cannot bill the month again.
    const anchors = {
      draft: anchorInvoice({ status: 'draft' }),
      sent: anchorInvoice(),
      processing: anchorInvoice({ status: 'processing' }),
      paid: anchorInvoice({ status: 'paid' }),
    }
    const credit = { id: 'prepay:inv-oct:2026-11', remaining: 500 }
    it.each(Object.keys(anchors))('passes for a %s anchor when the total is 0 or less', (status) => {
      for (const total of [0, -5]) {
        expect(
          unpaidPrepaymentFor({ client: c, invoice: november({ total }), invoices: [anchors[status]], credits: [credit] }),
        ).toBeNull()
      }
    })
    it.each([
      ['draft', 'unpaid'],
      ['sent', 'unpaid'],
      ['processing', 'processing'],
      ['paid', 'not_applied'],
    ])('still holds a %s anchor (%s) while the month owes something, or its total is unknown', (status, reason) => {
      const anchor = anchors[status]
      expect(unpaidPrepaymentFor({ client: c, invoice: november({ total: 0.01 }), invoices: [anchor], credits: [credit] }).reason).toBe(reason)
      expect(unpaidPrepaymentFor({ client: c, invoice: november(), invoices: [anchor], credits: [credit] }).reason).toBe(reason)
      expect(unpaidPrepaymentFor({ client: c, invoice: november({ total: '0' }), invoices: [anchor], credits: [credit] }).reason).toBe(reason)
    })
  })

  it('ignores a void anchor invoice (it billed nothing) and another client invoice', () => {
    expect(
      unpaidPrepaymentFor({ client: c, invoice: november(), invoices: [anchorInvoice({ status: 'void' })] }),
    ).toBeNull()
    expect(
      unpaidPrepaymentFor({
        client: c,
        invoice: november(),
        invoices: [anchorInvoice({ clientId: 'someone-else', status: 'sent' })],
      }),
    ).toBeNull()
  })

  it('does not apply to the anchor month itself, a month before the anchor, a monthly client or a sent invoice', () => {
    expect(unpaidPrepaymentFor({ client: c, invoice: november({ period: '2026-10' }), invoices: [] })).toBeNull()
    expect(unpaidPrepaymentFor({ client: c, invoice: november({ period: '2026-09' }), invoices: [] })).toBeNull()
    expect(
      unpaidPrepaymentFor({ client: client({ billingPeriodMonths: 1 }), invoice: november(), invoices: [] }),
    ).toBeNull()
    expect(unpaidPrepaymentFor({ client: c, invoice: november({ status: 'sent' }), invoices: [] })).toBeNull()
    expect(unpaidPrepaymentFor({ client: c, invoice: november({ kind: 'retainer' }), invoices: [] })).toBeNull()
  })

  it('follows the next period: January is the anchor, February looks at January', () => {
    const january = anchorInvoice({
      id: 'inv-jan',
      period: '2027-01',
      number: 'INV-2027-01-001',
      lineItems: [
        { kind: 'prepayment', amount: 500, period: '2027-02' },
        { kind: 'prepayment', amount: 500, period: '2027-03' },
      ],
    })
    const february = november({ period: '2027-02', number: 'INV-2027-02-001' })
    expect(
      unpaidPrepaymentFor({ client: c, invoice: february, invoices: [anchorInvoice({ status: 'paid' }), january] })
        .anchorInvoice.id,
    ).toBe('inv-jan')
  })
})

describe('billing masters and their subs have no billing period (M-3)', () => {
  it('hasBillingPeriod ignores a stored period on either', () => {
    expect(hasBillingPeriod(client())).toBe(true)
    expect(hasBillingPeriod(client({ isBillingMaster: true }))).toBe(false)
    expect(hasBillingPeriod(client({ billToClientId: 'master-1' }))).toBe(false)
    expect(prepaymentLines(client({ isBillingMaster: true }), '2026-10')).toEqual([])
    expect(nextPrepaymentMonth(client({ billToClientId: 'master-1' }), '2026-10')).toBeNull()
  })
})

describe('the card sentence agrees with what generation and the guard do (M-4)', () => {
  it('an anchor set in the past: the next prepayment is the next anchor, and the months before it are not held', () => {
    const c = client({ billingPeriodMonths: 3, periodAnchorMonth: '2026-09' })
    const sentence = billingPeriodSentence({ months: 3, anchor: '2026-09', today: '2026-10-07' })
    expect(sentence).toContain('on the December 2026 invoice')
    // Generation puts lines on December (covering January and February) and not on October.
    expect(prepaymentMonthsFor(c, '2026-12')).toEqual(['2027-01', '2027-02'])
    expect(prepaymentMonthsFor(c, '2026-10')).toEqual([])
    // September's invoice was generated before the period existed: no lines, so October holds nothing.
    const september = { id: 'inv-sep', clientId: c.id, kind: 'monthly', period: '2026-09', status: 'sent', lineItems: [{ kind: 'plan', amount: 500 }] }
    const october = { id: 'inv-oct', clientId: c.id, kind: 'monthly', period: '2026-10', status: 'draft', lineItems: [] }
    expect(unpaidPrepaymentFor({ client: c, invoice: october, invoices: [september] })).toBeNull()
  })
})
