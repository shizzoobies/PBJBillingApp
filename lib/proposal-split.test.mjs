import { describe, expect, it } from 'vitest'
import { defaultProposalPricing, priceProposal } from './proposal-pricing.js'
import {
  SPLIT_DRAFT_FIRST,
  SPLIT_LEAVE_ONE,
  SPLIT_LINE_GONE,
  SPLIT_PICK_ONE,
  SPLIT_SIGN_FIRST,
  canSplitProposal,
  splitClientRefusal,
  splitFamily,
  splitLineTotals,
  splitPartIds,
  splitPartWords,
  splitRefusal,
  splitSelections,
  splitSiblings,
  splitSignRefusal,
  splitTotalsWords,
} from './proposal-split.js'

const selections = [
  { serviceId: 'monthly-monthly-transactions-basic' },
  { serviceId: 'reconciliations', override: 50 },
  { serviceId: 'cleanup-transactions-basic' },
]

describe('splitSelections', () => {
  it('moves the named lines exactly as stored and keeps the rest, both in the proposal order', () => {
    const { move, stay, unknown } = splitSelections(selections, ['cleanup-transactions-basic', 'reconciliations'])
    expect(move).toEqual([{ serviceId: 'reconciliations', override: 50 }, { serviceId: 'cleanup-transactions-basic' }])
    expect(stay).toEqual([{ serviceId: 'monthly-monthly-transactions-basic' }])
    expect(unknown).toEqual([])
  })

  it('reports an id that names no line, and ignores junk', () => {
    const { move, unknown } = splitSelections(selections, ['reconciliations', 'payroll', '', null, 7])
    expect(move).toHaveLength(1)
    expect(unknown).toEqual(['payroll'])
    expect(splitSelections(null, null)).toEqual({ move: [], stay: [], unknown: [] })
  })
})

describe('splitRefusal', () => {
  it('allows a draft or sent proposal with some lines moving and some staying', () => {
    for (const status of ['draft', 'sent']) {
      expect(splitRefusal({ status, selections, moveIds: ['reconciliations'] })).toBeNull()
    }
  })

  it('refuses a decided proposal in the words the page uses for it', () => {
    expect(splitRefusal({ status: 'accepted', selections, moveIds: ['reconciliations'], statusWords: 'Won' })).toBe(
      'This proposal is Won - only a Draft or Sent proposal can be split.',
    )
    expect(splitRefusal({ status: 'declined', selections, moveIds: ['reconciliations'] })).toMatch(/declined/)
  })

  it('refuses nothing picked, everything picked, and a line that is gone', () => {
    expect(splitRefusal({ status: 'draft', selections, moveIds: [] })).toBe(SPLIT_PICK_ONE)
    expect(
      splitRefusal({ status: 'draft', selections, moveIds: selections.map((entry) => entry.serviceId) }),
    ).toBe(SPLIT_LEAVE_ONE)
    expect(splitRefusal({ status: 'draft', selections, moveIds: ['reconciliations', 'payroll'] })).toBe(SPLIT_LINE_GONE)
  })
})

describe('canSplitProposal', () => {
  it('needs an open proposal with at least two lines', () => {
    expect(canSplitProposal({ status: 'draft', selections })).toBe(true)
    expect(canSplitProposal({ status: 'sent', selections: selections.slice(0, 2) })).toBe(true)
    expect(canSplitProposal({ status: 'draft', selections: selections.slice(0, 1) })).toBe(false)
    expect(canSplitProposal({ status: 'accepted', selections })).toBe(false)
    expect(canSplitProposal({ status: 'declined', selections })).toBe(false)
    expect(canSplitProposal(null)).toBe(false)
  })
})

describe('splitFamily', () => {
  const row = (id, splitFromId = null, createdAt = '2026-11-01T00:00:00.000Z') => ({ id, splitFromId, createdAt })

  it('a proposal never split is its own family; an unknown id has none', () => {
    const list = [row('a'), row('b')]
    expect(splitFamily(list, 'a').map((entry) => entry.id)).toEqual(['a'])
    expect(splitSiblings(list, 'a')).toEqual([])
    expect(splitFamily(list, 'zzz')).toEqual([])
    expect(splitPartIds(list).size).toBe(0)
  })

  it('gathers a split of a split, oldest first, from any member', () => {
    const list = [
      row('c', 'b', '2026-11-03T00:00:00.000Z'),
      row('a', null, '2026-11-01T00:00:00.000Z'),
      row('b', 'a', '2026-11-02T00:00:00.000Z'),
      row('other', null, '2026-11-02T00:00:00.000Z'),
    ]
    for (const id of ['a', 'b', 'c']) {
      expect(splitFamily(list, id).map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
    }
    expect(splitSiblings(list, 'b').map((entry) => entry.id)).toEqual(['a', 'c'])
    expect([...splitPartIds(list)].sort()).toEqual(['a', 'b', 'c'])
  })

  it('parts whose parent was deleted still find each other, and a copy is never a part', () => {
    const list = [row('b', 'gone'), row('c', 'gone'), { ...row('copy'), copiedFromId: 'b' }]
    expect(splitFamily(list, 'b').map((entry) => entry.id)).toEqual(['b', 'c'])
    expect(splitFamily(list, 'copy').map((entry) => entry.id)).toEqual(['copy'])
    // One part left of a deleted parent: a family of one, so no "part" tag.
    expect(splitPartIds([row('b', 'gone')]).size).toBe(0)
  })

  it('a loop in the links never hangs', () => {
    const list = [row('a', 'b'), row('b', 'a')]
    expect(splitFamily(list, 'a').length).toBeGreaterThan(0)
  })
})

describe('totals in words', () => {
  it('names only the totals that have something, and never prints $0.00', () => {
    expect(splitTotalsWords({ monthly: 191.25, annual: 0, oneTime: 0, cleanup: 315, software: 0 })).toBe(
      'Monthly $191.25 · Clean-up $315.00',
    )
    expect(splitTotalsWords({ monthly: 0, cleanup: 0 })).toBe('Not yet priced')
    expect(splitTotalsWords(null)).toBe('Not yet priced')
  })

  it("splitLineTotals makes the same sums priceProposal makes, so the parts add up to the whole", () => {
    const catalog = { ...defaultProposalPricing(), rates: { bookkeeper: 75, accountant: 115, controller: 125 } }
    const inputs = { transactions: 30, balanceSheetAccounts: 2, totalAccounts: 25, cleanupMonths: 3, plAccounts: 20 }
    const all = [
      { serviceId: 'monthly-monthly-transactions-basic' },
      { serviceId: 'reconciliations' },
      { serviceId: 'reports-monthly-basic' },
      { serviceId: 'cleanup-transactions-basic' },
      { serviceId: 'budget', quantity: 1 },
      { serviceId: 'payroll-setup', flatAmount: 250 },
    ]
    const whole = priceProposal({ catalog, inputs, selections: all })
    expect(splitLineTotals(whole.lines)).toEqual(whole.totals)

    const { move, stay } = splitSelections(all, ['cleanup-transactions-basic', 'payroll-setup'])
    const moved = priceProposal({ catalog, inputs, selections: move })
    const kept = priceProposal({ catalog, inputs, selections: stay })
    for (const key of ['monthly', 'annual', 'oneTime', 'cleanup', 'software']) {
      expect(Math.round((moved.totals[key] + kept.totals[key]) * 100)).toBe(Math.round(whole.totals[key] * 100))
    }
    // The dialog sums the lines it shows: same figures as pricing each part.
    const picked = new Set(move.map((entry) => entry.serviceId))
    expect(splitLineTotals(whole.lines.filter((line) => picked.has(line.serviceId)))).toEqual(moved.totals)
    expect(splitLineTotals(whole.lines.filter((line) => !picked.has(line.serviceId)))).toEqual(kept.totals)
  })

  it('splitPartWords reads a proposal: no lines, not priced, partly priced', () => {
    expect(splitPartWords({ pricingSnapshot: null })).toBe('No lines yet')
    expect(
      splitPartWords({
        pricingSnapshot: { lines: [{ group: 'Monthly', amount: 0, flag: null }], totals: { monthly: 0 } },
      }),
    ).toBe('Not yet priced')
    expect(
      splitPartWords({
        pricingSnapshot: {
          lines: [
            { group: 'Monthly', amount: 100, flag: null },
            { group: 'Clean-up', amount: 0, flag: null },
          ],
          totals: { monthly: 100, cleanup: 0 },
        },
      }),
    ).toBe('Monthly $100.00 (partly priced)')
  })
})

describe('the Accept refusals', () => {
  it('name the client to pick, and say to sign the other letter first', () => {
    expect(splitClientRefusal('Acme Books')).toContain('already belongs to Acme Books')
    expect(splitClientRefusal('Acme Books')).toContain('Pick Acme Books as the existing client')
    expect(splitClientRefusal('')).toContain('a client')
    expect(SPLIT_SIGN_FIRST).toContain('Mark that letter signed first, or void it if that part will not go ahead')
    expect(splitSignRefusal('Acme Books')).toBe(
      'Another part of this proposal already belongs to Acme Books, so this letter would create a second client. Void this letter, then use Draft the engagement on its proposal: it is drafted as an amendment for Acme Books.',
    )
    expect(splitSignRefusal('')).toContain('a client')
    // The proposal could not be tied to that client: a copy with the client picked is the way.
    expect(splitSignRefusal('Acme Books', { tied: false })).toBe(
      'Another part of this proposal already belongs to Acme Books, so this letter would create a second client. Void this letter, then use Copy to new proposal on its proposal, pick Acme Books as the existing client on the copy and accept the copy.',
    )
    expect(SPLIT_DRAFT_FIRST).toContain('has no engagement letter yet. Draft its letter and mark it signed first')
  })
})
