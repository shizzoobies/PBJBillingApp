import { describe, expect, it } from 'vitest'

import {
  buildConsolidatedInvoiceDraft,
  buildInvoiceDraft,
  buildScopeFlags,
  dueDateFromTerms,
  nextInvoiceNumber,
  periodEndDate,
  previousPeriod,
} from './invoice-draft.js'

/**
 * The I1 draft generator. This is money on a client-facing document, so the
 * cases below lean on the ones that would be embarrassing to get wrong: a due
 * date computed from free text Brittany typed, an adjustment that silently
 * doubles, and scope flags that must never become charges.
 */

const client = (over = {}) => ({
  id: 'client-1',
  name: 'Acme',
  billingMode: 'subscription',
  monthlyRate: 500,
  hourlyRate: 0,
  planIds: [],
  ...over,
})

describe('periodEndDate', () => {
  it('finds the last day of the month, including February', () => {
    expect(periodEndDate('2026-08')).toBe('2026-08-31')
    expect(periodEndDate('2026-02')).toBe('2026-02-28')
    expect(periodEndDate('2028-02')).toBe('2028-02-29') // leap year
    expect(periodEndDate('2026-04')).toBe('2026-04-30')
  })

  it('returns null for junk', () => {
    expect(periodEndDate('nonsense')).toBeNull()
  })
})

describe('previousPeriod', () => {
  it('steps back a month and across a year boundary', () => {
    expect(previousPeriod('2026-08')).toBe('2026-07')
    expect(previousPeriod('2026-01')).toBe('2025-12')
  })
})

describe('dueDateFromTerms', () => {
  it('reads the usual ways of writing net terms', () => {
    expect(dueDateFromTerms('2026-08-31', 'Net 30')).toBe('2026-09-30')
    expect(dueDateFromTerms('2026-08-31', 'net30')).toBe('2026-09-30')
    expect(dueDateFromTerms('2026-08-31', '15 days')).toBe('2026-09-15')
    expect(dueDateFromTerms('2026-08-31', 'NET 45')).toBe('2026-10-15')
  })

  it('treats "due on receipt" as the period end itself', () => {
    expect(dueDateFromTerms('2026-08-31', 'Due on receipt')).toBe('2026-08-31')
    expect(dueDateFromTerms('2026-08-31', 'Immediate')).toBe('2026-08-31')
  })

  // A wrong due date on a client's invoice is worse than a conservative one.
  it('falls back to the default rather than guessing', () => {
    expect(dueDateFromTerms('2026-08-31', '')).toBe('2026-09-30')
    expect(dueDateFromTerms('2026-08-31', undefined)).toBe('2026-09-30')
    expect(dueDateFromTerms('2026-08-31', 'whenever you get to it')).toBe('2026-09-30')
    expect(dueDateFromTerms('2026-08-31', 'Net 9999')).toBe('2026-09-30')
  })

  it('honors a caller-supplied default', () => {
    expect(dueDateFromTerms('2026-08-31', '', 10)).toBe('2026-09-10')
  })
})

describe('nextInvoiceNumber', () => {
  it('starts a period at 001', () => {
    expect(nextInvoiceNumber('2026-08', [])).toBe('INV-2026-08-001')
  })

  it('continues after the highest number already issued that period', () => {
    expect(
      nextInvoiceNumber('2026-08', ['INV-2026-08-001', 'INV-2026-08-002']),
    ).toBe('INV-2026-08-003')
  })

  // Numbers are per period, so last month's sequence must not shift this one.
  it('ignores other periods entirely', () => {
    expect(nextInvoiceNumber('2026-08', ['INV-2026-07-042'])).toBe('INV-2026-08-001')
  })

  it('is not confused by gaps or junk', () => {
    expect(
      nextInvoiceNumber('2026-08', ['INV-2026-08-001', 'INV-2026-08-009', null, 'nope']),
    ).toBe('INV-2026-08-010')
  })
})

describe('buildScopeFlags', () => {
  it('says nothing when there is no time logged', () => {
    expect(buildScopeFlags({ client: client(), entries: [], period: '2026-08' })).toEqual([])
  })

  it('flags a month that ran past the client’s estimated hours', () => {
    const flags = buildScopeFlags({
      client: client({ billingMode: 'hourly', estimatedBookkeeperHours: 2 }),
      entries: [
        { clientId: 'client-1', date: '2026-08-04', minutes: 180, billable: true },
      ],
      period: '2026-08',
    })
    expect(flags).toHaveLength(1)
    expect(flags[0].kind).toBe('over-estimate')
    expect(flags[0].detail).toContain('3.0h')
  })

  it('stays quiet when the month is within estimate', () => {
    const flags = buildScopeFlags({
      client: client({ billingMode: 'hourly', estimatedBookkeeperHours: 10 }),
      entries: [{ clientId: 'client-1', date: '2026-08-04', minutes: 60, billable: true }],
      period: '2026-08',
    })
    expect(flags).toEqual([])
  })

  it('flags billable time logged against a flat-fee client', () => {
    const flags = buildScopeFlags({
      client: client({ billingMode: 'subscription' }),
      entries: [{ clientId: 'client-1', date: '2026-08-04', minutes: 120, billable: true }],
      period: '2026-08',
    })
    expect(flags.some((f) => f.kind === 'billable-on-flat-fee')).toBe(true)
  })

  it('ignores other clients and other months', () => {
    const flags = buildScopeFlags({
      client: client({ billingMode: 'hourly', estimatedBookkeeperHours: 1 }),
      entries: [
        { clientId: 'client-other', date: '2026-08-04', minutes: 600, billable: true },
        { clientId: 'client-1', date: '2026-07-04', minutes: 600, billable: true },
      ],
      period: '2026-08',
    })
    expect(flags).toEqual([])
  })
})

describe('buildInvoiceDraft', () => {
  it('produces lines, totals and a due date for a flat-fee client', () => {
    const draft = buildInvoiceDraft({
      client: client({ paymentTerms: 'Net 30' }),
      period: '2026-08',
    })
    expect(draft.lineItems).toHaveLength(1)
    expect(draft.subtotal).toBe(500)
    expect(draft.total).toBe(500)
    expect(draft.dueDate).toBe('2026-09-30')
    expect(draft.period).toBe('2026-08')
    expect(draft.clientId).toBe('client-1')
  })

  it('carries a prior-month adjustment as its own line', () => {
    const draft = buildInvoiceDraft({
      client: client(),
      period: '2026-08',
      priorInvoice: { adjustmentForNextPeriod: 125.5 },
    })
    const adjustment = draft.lineItems.find((line) => line.kind === 'adjustment')
    expect(adjustment?.amount).toBe(125.5)
    expect(adjustment?.label).toBe('Adjustment — 2026-07')
    expect(draft.subtotal).toBe(500)
    // The adjustment is in the TOTAL but not the subtotal.
    expect(draft.total).toBe(625.5)
  })

  it('words a negative adjustment as a credit', () => {
    const draft = buildInvoiceDraft({
      client: client(),
      period: '2026-08',
      priorInvoice: { adjustmentForNextPeriod: -75 },
    })
    const adjustment = draft.lineItems.find((line) => line.kind === 'adjustment')
    expect(adjustment?.detail).toContain('Credit')
    expect(draft.total).toBe(425)
  })

  it('adds no adjustment line when there is nothing to true up', () => {
    for (const priorInvoice of [null, { adjustmentForNextPeriod: 0 }, {}]) {
      const draft = buildInvoiceDraft({ client: client(), period: '2026-08', priorInvoice })
      expect(draft.lineItems.some((line) => line.kind === 'adjustment')).toBe(false)
      expect(draft.total).toBe(500)
    }
  })

  // The whole point of a flag: it is a prompt to look, never a charge.
  it('never lets a scope flag change the amount owed', () => {
    const draft = buildInvoiceDraft({
      client: client({ billingMode: 'subscription', monthlyRate: 500 }),
      period: '2026-08',
      entries: [{ clientId: 'client-1', date: '2026-08-04', minutes: 300, billable: true }],
    })
    expect(draft.scopeFlags.length).toBeGreaterThan(0)
    expect(draft.total).toBe(500)
    expect(draft.lineItems.every((line) => line.kind !== 'scope-flag')).toBe(true)
  })

  it('bills an hourly client per employee and rounds to cents', () => {
    const draft = buildInvoiceDraft({
      client: client({ billingMode: 'hourly', paymentTerms: 'Net 15' }),
      period: '2026-08',
      entries: [
        { clientId: 'client-1', employeeId: 'emp-1', date: '2026-08-04', minutes: 100, billable: true },
      ],
      employees: [{ id: 'emp-1', name: 'Lisa', billRate: 75 }],
    })
    // REPINNED for featreq-cfb1536a: 100 minutes prints as 1.67h, and the
    // printed hours are the price — 1.67 × $75 = $125.25. The old raw-minutes
    // figure ($125.00 exactly) was the cleaner-looking number and the wrong
    // one: nothing on the document multiplied into it.
    expect(draft.total).toBe(125.25)
    expect(draft.dueDate).toBe('2026-09-15')
  })
})

/**
 * The KLC consolidated invoice: one document, four companies' work on it.
 *
 * The cases below are the ones that would be expensive to get wrong on a real
 * client's invoice — money that drifts because it was re-derived instead of
 * added, a company's work landing with no attribution, and a flag that reaches
 * Brittany's month-run chips without saying WHOSE it is.
 */
describe('buildConsolidatedInvoiceDraft', () => {
  const master = { id: 'client-master', name: 'KLC Master', paymentTerms: 'Net 15' }

  const subDraft = (over = {}) => ({
    clientId: 'sub',
    period: '2026-08',
    lineItems: [],
    subtotal: 0,
    total: 0,
    dueDate: '2026-09-30',
    scopeFlags: [],
    billableMinutes: 0,
    entryCount: 0,
    periodLabel: 'August 2026',
    ...over,
  })

  const klc = {
    client: { id: 'client-klc', name: 'KLC Floors & More' },
    draft: subDraft({
      clientId: 'client-klc',
      lineItems: [{ kind: 'plan', label: 'Monthly service', amount: 900 }],
      subtotal: 900,
      total: 900,
      billableMinutes: 0,
      entryCount: 4,
    }),
  }
  const chemtrex = {
    client: { id: 'client-chemtrex', name: 'Chemtrex' },
    draft: subDraft({
      clientId: 'client-chemtrex',
      lineItems: [
        { kind: 'hourly', label: 'Billable hours — Lisa', amount: 262.5 },
        { kind: 'recurring', label: 'QBO subscription', detail: 'Covers Sep 1 – Sep 30', amount: 90 },
      ],
      subtotal: 352.5,
      total: 352.5,
      scopeFlags: [{ kind: 'over-estimate', label: 'More hours than this client is scoped for' }],
      billableMinutes: 210,
      entryCount: 6,
    }),
  }

  it('stamps every carried line with the company it came from, in the order given', () => {
    const draft = buildConsolidatedInvoiceDraft({
      master,
      period: '2026-08',
      subDrafts: [chemtrex, klc],
    })
    expect(draft.lineItems.map((line) => line.sourceClientId)).toEqual([
      'client-chemtrex',
      'client-chemtrex',
      'client-klc',
    ])
    // The order the store sent is the order the document reads in.
    expect(draft.lineItems[0].label).toBe('Billable hours — Lisa')
    expect(draft.lineItems[2].label).toBe('Monthly service')
  })

  it('keeps a stamp a sub draft already wrote rather than overwriting it', () => {
    const preStamped = {
      client: { id: 'client-chemtrex', name: 'Chemtrex' },
      draft: subDraft({
        lineItems: [{ kind: 'plan', label: 'Carried', amount: 10, sourceClientId: 'client-other' }],
        subtotal: 10,
        total: 10,
      }),
    }
    const draft = buildConsolidatedInvoiceDraft({
      master,
      period: '2026-08',
      subDrafts: [preStamped],
    })
    expect(draft.lineItems[0].sourceClientId).toBe('client-other')
  })

  // The ONE money calculator rule at this level: add what the subs computed,
  // never re-derive it from the merged lines.
  it('sums the subs’ own subtotals and totals', () => {
    const draft = buildConsolidatedInvoiceDraft({
      master,
      period: '2026-08',
      subDrafts: [klc, chemtrex],
    })
    expect(draft.subtotal).toBe(1252.5)
    expect(draft.total).toBe(1252.5)
    expect(draft.clientId).toBe('client-master')
    expect(draft.billableMinutes).toBe(210)
    expect(draft.entryCount).toBe(10)
    expect(draft.periodLabel).toBe('August 2026')
  })

  it('names the company in every aggregated scope flag', () => {
    const draft = buildConsolidatedInvoiceDraft({
      master,
      period: '2026-08',
      subDrafts: [klc, chemtrex],
    })
    expect(draft.scopeFlags).toHaveLength(1)
    expect(draft.scopeFlags[0].label).toBe(
      'Chemtrex: More hours than this client is scoped for',
    )
    expect(draft.scopeFlags[0].sourceClientId).toBe('client-chemtrex')
    expect(draft.scopeFlags[0].kind).toBe('over-estimate')
  })

  it('takes the due date from the MASTER’s payment terms, not a sub’s', () => {
    const draft = buildConsolidatedInvoiceDraft({
      master,
      period: '2026-08',
      subDrafts: [klc],
      defaultNetDays: 30,
    })
    // Net 15 from 2026-08-31 — the subs' own due dates are irrelevant.
    expect(draft.dueDate).toBe('2026-09-15')
  })

  it('carries the MASTER’s prior-month adjustment exactly as any invoice does', () => {
    const draft = buildConsolidatedInvoiceDraft({
      master,
      period: '2026-08',
      subDrafts: [klc, chemtrex],
      priorInvoice: { adjustmentForNextPeriod: -50 },
    })
    const last = draft.lineItems.at(-1)
    expect(last.kind).toBe('adjustment')
    expect(last.label).toBe('Adjustment — 2026-07')
    expect(last.amount).toBe(-50)
    // The master's own line is not attributed to any company.
    expect(last.sourceClientId).toBeUndefined()
    // In the total, not the subtotal — the same rule a single-client draft uses.
    expect(draft.subtotal).toBe(1252.5)
    expect(draft.total).toBe(1202.5)
  })

  // Subs no longer invoice, so this should not happen. If it does, the
  // correction is kept (dropping it would swallow money) and flagged.
  it('keeps a stray sub-level adjustment as that sub’s line, and flags it', () => {
    const strayed = {
      client: { id: 'client-xact', name: 'XAct' },
      draft: subDraft({
        lineItems: [{ kind: 'adjustment', label: 'Adjustment — 2026-07', amount: 25 }],
        subtotal: 0,
        total: 25,
      }),
    }
    const draft = buildConsolidatedInvoiceDraft({
      master,
      period: '2026-08',
      subDrafts: [strayed],
    })
    expect(draft.lineItems[0].sourceClientId).toBe('client-xact')
    expect(draft.total).toBe(25)
    const flag = draft.scopeFlags.find((f) => f.kind === 'sub-adjustment')
    expect(flag.label).toContain('XAct:')
  })

  it('treats a sub with nothing to bill as a quiet month, not an error', () => {
    const quiet = { client: { id: 'client-bt', name: 'Bright Tower' }, draft: subDraft() }
    const withQuiet = buildConsolidatedInvoiceDraft({
      master,
      period: '2026-08',
      subDrafts: [klc, quiet, chemtrex],
    })
    const without = buildConsolidatedInvoiceDraft({
      master,
      period: '2026-08',
      subDrafts: [klc, chemtrex],
    })
    expect(withQuiet.lineItems).toHaveLength(without.lineItems.length)
    expect(withQuiet.total).toBe(without.total)
    expect(withQuiet.scopeFlags).toHaveLength(without.scopeFlags.length)
  })

  it('produces an empty but valid draft when the master has no subs at all', () => {
    const draft = buildConsolidatedInvoiceDraft({ master, period: '2026-08', subDrafts: [] })
    expect(draft.lineItems).toEqual([])
    expect(draft.subtotal).toBe(0)
    expect(draft.total).toBe(0)
    expect(draft.dueDate).toBe('2026-09-15')
  })
})
