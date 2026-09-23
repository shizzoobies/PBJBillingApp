import { describe, expect, it } from 'vitest'

import { buildInvoiceLines } from './invoice-lines.js'
import {
  applyScopeRetag,
  entryFlagsForScopeTag,
  savedAdhocModesForEntries,
  scopeTagOfEntry,
  unaccountedScopeEntries,
} from './invoice-scope-retag.js'

/**
 * Re-tagging one entry's scope from the invoicing side — featreq-8cec48db.
 *
 * The invariant these tests exist for is that RE-TAGGING IS ARITHMETIC ON THE
 * LINES SHE IS LOOKING AT, not a regeneration of the invoice. Two things follow,
 * and everything below is one of them:
 *
 *   - the money moves exactly as much as the hours did — an entry taken out of
 *     a person's billable line and given its own ad hoc line at the same rate
 *     changes the invoice total by nothing at all;
 *   - every line the entry is not part of comes out byte-for-byte as it went
 *     in, including the ones she rounded by hand.
 */

const HOURLY = {
  id: 'client-1',
  name: 'Acme',
  billingMode: 'hourly',
  hourlyRate: 60,
  planIds: [],
}

const EMPLOYEES = [
  { id: 'emp-1', name: 'Patrice', role: 'Owner', billRate: 100 },
  { id: 'emp-2', name: 'Lisa', role: 'Bookkeeper', billRate: 80 },
]

const entry = (over = {}) => ({
  id: 'entry-x',
  clientId: 'client-1',
  employeeId: 'emp-1',
  billable: true,
  minutes: 60,
  date: '2026-08-04',
  description: 'Reconciled the operating account',
  ...over,
})

/** 1.50h and 0.50h of Patrice's time, 1.00h of Lisa's flagged ad hoc, and
 *  0.75h of Patrice's already marked not billable. */
const ENTRIES = [
  entry({ id: 'e1', minutes: 90, description: 'Month-end close' }),
  entry({ id: 'e2', minutes: 30, description: 'Payroll journal' }),
  entry({
    id: 'e3',
    employeeId: 'emp-2',
    minutes: 60,
    isAdhoc: true,
    description: 'Rush 1099 question',
    date: '2026-08-06',
  }),
  entry({ id: 'e4', minutes: 45, billable: false, description: 'Internal cleanup' }),
]

const generated = () =>
  buildInvoiceLines({
    client: HOURLY,
    entries: ENTRIES,
    billingPeriod: '2026-08',
    employees: EMPLOYEES,
    defaultHourlyRate: 60,
  }).lines

const retag = (tagEdits, over = {}) =>
  applyScopeRetag({
    lines: generated(),
    entries: ENTRIES,
    tagEdits,
    employees: EMPLOYEES,
    client: HOURLY,
    period: '2026-08',
    defaultHourlyRate: 60,
    ...over,
  })

const total = (lines) => lines.reduce((sum, line) => sum + line.amount, 0)
const find = (lines, label) => lines.find((line) => line.label === label)

describe('scope tags are a view of the flags already on the entry', () => {
  it('reads each of the three off billable + isAdhoc', () => {
    expect(scopeTagOfEntry({ billable: true })).toBe('in-scope')
    expect(scopeTagOfEntry({ billable: true, isAdhoc: true })).toBe('adhoc')
    expect(scopeTagOfEntry({ billable: false })).toBe('out-of-scope')
  })

  it('writes each of the three back as the same two booleans', () => {
    expect(entryFlagsForScopeTag('in-scope')).toEqual({ billable: true, isAdhoc: false })
    expect(entryFlagsForScopeTag('adhoc')).toEqual({ billable: true, isAdhoc: true })
    expect(entryFlagsForScopeTag('out-of-scope')).toEqual({ billable: false, isAdhoc: false })
  })
})

describe('the starting invoice', () => {
  it('bills Patrice 2.00h and Lisa 1.00h of ad hoc', () => {
    const lines = generated()
    expect(find(lines, 'Billable hours — Patrice')).toMatchObject({ hours: 2, amount: 200 })
    expect(find(lines, 'Adhoc — Rush 1099 question')).toMatchObject({ amount: 80 })
    expect(total(lines)).toBe(280)
  })
})

describe('all six transitions', () => {
  it('in scope -> ad hoc: the hours move sides and the total does not change', () => {
    const { lines, changed } = retag({ e1: { tag: 'adhoc', adhocMode: 'billed' } })
    expect(changed).toBe(true)
    // 2.00h - 1.50h left on her line, at the same $100.
    expect(find(lines, 'Billable hours — Patrice')).toMatchObject({
      hours: 0.5,
      rate: 100,
      amount: 50,
      detail: '0.50h at $100.00/hr',
    })
    expect(find(lines, 'Adhoc — Month-end close')).toMatchObject({
      kind: 'adhoc',
      amount: 150,
      adhocMode: 'billed',
      adhocAmount: 150,
      entryId: 'e1',
      detail: 'Aug 4, 2026 · Patrice · 1.50h at $100.00/hr',
    })
    expect(total(lines)).toBe(280)
  })

  it('in scope -> out of scope: the invoice loses exactly those hours', () => {
    const { lines } = retag({ e1: { tag: 'out-of-scope' } })
    expect(find(lines, 'Billable hours — Patrice')).toMatchObject({ hours: 0.5, amount: 50 })
    expect(lines.some((line) => line.label === 'Adhoc — Month-end close')).toBe(false)
    expect(total(lines)).toBe(280 - 150)
  })

  it('ad hoc -> in scope: the line goes, the hours join her billable line', () => {
    const { lines } = retag({ e3: { tag: 'in-scope' } })
    expect(lines.some((line) => line.kind === 'adhoc')).toBe(false)
    expect(find(lines, 'Billable hours — Lisa')).toMatchObject({
      kind: 'hourly',
      hours: 1,
      rate: 80,
      amount: 80,
      roleTier: 'Bookkeeper',
      detail: '1.00h at $80.00/hr',
    })
    expect(total(lines)).toBe(280)
  })

  it('ad hoc -> out of scope: the line goes and nothing replaces it', () => {
    const { lines } = retag({ e3: { tag: 'out-of-scope' } })
    expect(lines.some((line) => line.kind === 'adhoc')).toBe(false)
    expect(lines.some((line) => line.label === 'Billable hours — Lisa')).toBe(false)
    expect(total(lines)).toBe(200)
  })

  it('out of scope -> in scope: the hours arrive on that person s line', () => {
    const { lines } = retag({ e4: { tag: 'in-scope' } })
    expect(find(lines, 'Billable hours — Patrice')).toMatchObject({
      hours: 2.75,
      amount: 275,
      detail: '2.75h at $100.00/hr',
    })
    expect(total(lines)).toBe(355)
  })

  it('out of scope -> ad hoc: a new line at that employee s rate', () => {
    const { lines } = retag({ e4: { tag: 'adhoc', adhocMode: 'billed' } })
    expect(find(lines, 'Adhoc — Internal cleanup')).toMatchObject({
      amount: 75,
      adhocAmount: 75,
      entryId: 'e4',
    })
    // Her scoped line is untouched — this entry was never in it.
    expect(find(lines, 'Billable hours — Patrice')).toMatchObject({ hours: 2, amount: 200 })
    expect(total(lines)).toBe(355)
  })
})

describe('the three ad hoc options ride along', () => {
  it('a courtesy tag prices the new line at nothing and holds the reserve', () => {
    const { lines } = retag({ e1: { tag: 'adhoc', adhocMode: 'courtesy' } })
    expect(find(lines, 'Adhoc — Month-end close')).toMatchObject({
      amount: 0,
      adhocMode: 'courtesy',
      adhocAmount: 150,
    })
    // The hours still left her billable line, so the invoice IS 150 lighter.
    expect(total(lines)).toBe(130)
  })

  it('re-deciding an entry that is already ad hoc only moves the mode', () => {
    const { lines, changed } = retag({ e3: { tag: 'adhoc', adhocMode: 'omitted' } })
    expect(changed).toBe(true)
    expect(find(lines, 'Adhoc — Rush 1099 question')).toMatchObject({
      amount: 0,
      adhocMode: 'omitted',
      adhocAmount: 80,
    })
    expect(lines.filter((line) => line.kind === 'adhoc')).toHaveLength(1)
  })
})

describe('lines appear and disappear only when the hours say so', () => {
  it('drops a person s line when the last of their hours leaves it', () => {
    const { lines } = retag({
      e1: { tag: 'out-of-scope' },
      e2: { tag: 'out-of-scope' },
    })
    expect(lines.some((line) => line.label === 'Billable hours — Patrice')).toBe(false)
    expect(total(lines)).toBe(80)
  })

  it('creates the line in the generator s shape when the person has none', () => {
    const { lines } = retag({ e3: { tag: 'in-scope' } })
    const made = find(lines, 'Billable hours — Lisa')
    const asGenerated = buildInvoiceLines({
      client: HOURLY,
      entries: [{ ...ENTRIES[2], isAdhoc: false }],
      billingPeriod: '2026-08',
      employees: EMPLOYEES,
      defaultHourlyRate: 60,
    }).lines.find((line) => line.kind === 'hourly')
    expect(made).toEqual(asGenerated)
  })
})

describe('a re-tag prices a new line at the client’s pin', () => {
  it('bills a pinned client at the pin, never at the person’s newest rate', () => {
    // Lisa's live billRate (80) mirrors her August raise; this client is
    // pinned to June, where she bills at 70 — so the invoice would.
    const billRateVersions = [
      { userId: 'emp-2', effectivePeriod: '2026-06', rate: 70 },
      { userId: 'emp-2', effectivePeriod: '2026-08', rate: 80 },
    ]
    const pinned = { ...HOURLY, hourlyRatePeriod: '2026-06' }
    const outOfScope = entry({
      id: 'L1',
      employeeId: 'emp-2',
      billable: false,
      minutes: 60,
      description: 'Catch-up',
    })
    const args = {
      lines: [],
      entries: [outOfScope],
      employees: EMPLOYEES,
      client: pinned,
      period: '2026-08',
      defaultHourlyRate: 60,
      billRateVersions,
      ratePeriod: '2026-06',
    }
    const toInScope = applyScopeRetag({ ...args, tagEdits: { L1: { tag: 'in-scope' } } })
    expect(find(toInScope.lines, 'Billable hours — Lisa')).toMatchObject({
      rate: 70,
      amount: 70,
      detail: '1.00h at $70.00/hr',
    })
    const toAdhoc = applyScopeRetag({
      ...args,
      tagEdits: { L1: { tag: 'adhoc', adhocMode: 'billed' } },
    })
    expect(find(toAdhoc.lines, 'Adhoc — Catch-up')).toMatchObject({ amount: 70, adhocAmount: 70 })
  })
})

describe('everything the entry is not part of is left alone', () => {
  it('preserves a hand-rounded line and a reimbursement byte for byte', () => {
    const base = [
      ...generated(),
      { kind: 'reimbursement', label: 'Reimbursement: Filing fee', detail: 'Aug 9, 2026', amount: 41.5 },
      { kind: 'custom', label: 'Goodwill discount', detail: '', amount: -25 },
    ]
    // She rounded Patrice's line up by hand before opening the panel.
    base[0] = { ...base[0], hours: 2.25, amount: 225 }
    const { lines } = applyScopeRetag({
      lines: base,
      entries: ENTRIES,
      tagEdits: { e3: { tag: 'out-of-scope' } },
      employees: EMPLOYEES,
      client: HOURLY,
      period: '2026-08',
      defaultHourlyRate: 60,
    })
    expect(lines[0]).toBe(base[0])
    expect(lines.find((line) => line.kind === 'reimbursement')).toBe(base[2])
    expect(lines.find((line) => line.kind === 'custom')).toBe(base[3])
  })

  it('finds a pre-change ad hoc line by its label and detail when it has no id', () => {
    const legacy = generated().map((line) => {
      if (line.kind !== 'adhoc') return line
      const { entryId: _dropped, ...rest } = line
      return rest
    })
    const { lines, changed } = applyScopeRetag({
      lines: legacy,
      entries: ENTRIES,
      tagEdits: { e3: { tag: 'out-of-scope' } },
      employees: EMPLOYEES,
      client: HOURLY,
      period: '2026-08',
      defaultHourlyRate: 60,
    })
    expect(changed).toBe(true)
    expect(lines.some((line) => line.kind === 'adhoc')).toBe(false)
  })

  it('new ad hoc lines land with the ad hoc block, ahead of the reimbursements', () => {
    const base = [
      ...generated(),
      { kind: 'reimbursement', label: 'Reimbursement: Filing fee', detail: '', amount: 41.5 },
    ]
    const { lines } = applyScopeRetag({
      lines: base,
      entries: ENTRIES,
      tagEdits: { e4: { tag: 'adhoc' } },
      employees: EMPLOYEES,
      client: HOURLY,
      period: '2026-08',
      defaultHourlyRate: 60,
    })
    expect(lines.map((line) => line.kind)).toEqual([
      'hourly',
      'adhoc',
      'adhoc',
      'reimbursement',
    ])
  })
})

/**
 * THE GUARD THAT STOPS A DOUBLE BILL, and the production measurement behind it.
 *
 * Reproduced against production on 2026-09-14: of the forty hourly lines
 * written since the June 2026 cutover, THIRTY-EIGHT had been renamed by hand
 * ("Bookkeeping Services", "CFO/Advisory Services", "For services rendered for
 * the month of") and carried no hours or rate at all. On those the hours cannot
 * be taken out — so adding an ad hoc line would charge the client twice for the
 * same work, once inside the aggregate and once on the new line.
 */
describe('an hourly line that has been renamed by hand', () => {
  /** The real shape of INV-2026-08-014: one typed line, no hours, no rate. */
  const renamed = () => [
    {
      kind: 'hourly',
      label: 'For services rendered for the month of',
      detail: '',
      amount: 800,
    },
    { kind: 'recurring', label: 'Recurring: QuickBooks Ledger', detail: 'monthly', amount: 10 },
  ]

  const onRenamed = (tagEdits) =>
    applyScopeRetag({
      lines: renamed(),
      entries: ENTRIES,
      tagEdits,
      employees: EMPLOYEES,
      client: HOURLY,
      period: '2026-08',
      defaultHourlyRate: 60,
    })

  it('adds NO ad hoc line, because the hours could not leave the one they are on', () => {
    const { lines, changed, blocked } = onRenamed({ e1: { tag: 'adhoc' } })
    expect(lines.some((line) => line.kind === 'adhoc')).toBe(false)
    expect(total(lines)).toBe(810)
    expect(changed).toBe(false)
    expect(blocked).toEqual(['e1'])
  })

  it('reports the same for out of scope rather than pretending it moved', () => {
    const { lines, blocked } = onRenamed({ e1: { tag: 'out-of-scope' } })
    expect(total(lines)).toBe(810)
    expect(blocked).toEqual(['e1'])
  })

  it('will not give hours back to a person whose ad hoc line was retyped', () => {
    const lines = generated().map((line) =>
      line.kind === 'adhoc' ? { kind: 'adhoc', label: 'Extra work', detail: '', amount: 80 } : line,
    )
    const { lines: after, blocked } = applyScopeRetag({
      lines,
      entries: ENTRIES,
      tagEdits: { e3: { tag: 'in-scope' } },
      employees: EMPLOYEES,
      client: HOURLY,
      period: '2026-08',
      defaultHourlyRate: 60,
    })
    // Neither a new billable line nor a removed ad hoc one: the work would
    // otherwise have been charged on both.
    expect(after.some((line) => line.label === 'Billable hours — Lisa')).toBe(false)
    expect(total(after)).toBe(280)
    expect(blocked).toEqual(['e3'])
  })

  // Nothing was billing this entry, so there is nothing to take out and the new
  // line cannot double anything.
  it('still lets out-of-scope time arrive on a renamed invoice', () => {
    const { lines, blocked } = onRenamed({ e4: { tag: 'adhoc' } })
    expect(lines.find((line) => line.kind === 'adhoc')).toMatchObject({ amount: 75 })
    expect(total(lines)).toBe(885)
    expect(blocked).toEqual([])
  })
})

/**
 * THE THREE WAYS A CHARGE USED TO APPEAR WITHOUT ITS HOURS EVER LEAVING, each
 * one reproduced by executing the shipped function over real invoice shapes
 * before it was fixed. Every one of them moved money on a live Stripe invoice.
 */
describe('a charge is only ever added when the hours could be taken off', () => {
  /** The ad hoc line she retyped: still billing, no longer findable. */
  const retypedAdhoc = () =>
    generated().map((line) =>
      line.kind === 'adhoc'
        ? { kind: 'adhoc', label: 'Rush question', detail: '', amount: 80, adhocMode: 'billed', adhocAmount: 80 }
        : line,
    )

  // Reproduced at $150 -> $300 with an empty `blocked`: the row was already ad
  // hoc, so nothing departed, and the arrival built a second priced line beside
  // the one she had renamed. Re-picking "Ad hoc", or reverting after staging
  // out of scope, was enough to fire it.
  it('ad hoc -> ad hoc on a retyped line adds nothing and says so', () => {
    const before = retypedAdhoc()
    const { lines, blocked } = applyScopeRetag({
      lines: before,
      entries: ENTRIES,
      tagEdits: { e3: { tag: 'adhoc', adhocMode: 'billed' } },
      employees: EMPLOYEES,
      client: HOURLY,
      period: '2026-08',
      defaultHourlyRate: 60,
    })
    expect(lines.filter((line) => line.kind === 'adhoc')).toHaveLength(1)
    expect(total(lines)).toBe(total(before))
    expect(blocked).toEqual(['e3'])
  })

  it('and the same when the mode is what she changed', () => {
    const { lines, blocked } = applyScopeRetag({
      lines: retypedAdhoc(),
      entries: ENTRIES,
      tagEdits: { e3: { tag: 'adhoc', adhocMode: 'courtesy' } },
      employees: EMPLOYEES,
      client: HOURLY,
      period: '2026-08',
      defaultHourlyRate: 60,
    })
    expect(lines.filter((line) => line.kind === 'adhoc')).toHaveLength(1)
    expect(total(lines)).toBe(280)
    expect(blocked).toEqual(['e3'])
  })

  it('but an ad hoc line it CAN find only ever changes mode, never doubles', () => {
    const { lines } = retag({ e3: { tag: 'adhoc', adhocMode: 'courtesy' } })
    expect(lines.filter((line) => line.kind === 'adhoc')).toHaveLength(1)
    expect(find(lines, 'Adhoc — Rush 1099 question')).toMatchObject({
      amount: 0,
      adhocMode: 'courtesy',
      adhocAmount: 80,
    })
  })

  /**
   * Reproduced at $350 -> $50: her line had been rounded DOWN by hand below the
   * hours of the entry leaving it, so the subtraction went negative and the old
   * `hours <= 0` deleted the whole line — everyone's hours on it with it.
   */
  it('a subtraction that would go negative leaves the line exactly as it was', () => {
    const base = generated()
    // 2.00h rounded down to 1.00h by hand, while e1 alone is 1.50h.
    base[0] = { ...base[0], hours: 1, detail: '1.00h at $100.00/hr', amount: 100 }
    const { lines, blocked } = applyScopeRetag({
      lines: base,
      entries: ENTRIES,
      tagEdits: { e1: { tag: 'out-of-scope' } },
      employees: EMPLOYEES,
      client: HOURLY,
      period: '2026-08',
      defaultHourlyRate: 60,
    })
    expect(lines.find((line) => line.kind === 'hourly')).toBe(base[0])
    expect(total(lines)).toBe(total(base))
    expect(blocked).toEqual(['e1'])
  })

  it('still removes the line when the hours land exactly on zero', () => {
    const { lines, blocked } = retag({
      e1: { tag: 'out-of-scope' },
      e2: { tag: 'out-of-scope' },
    })
    expect(lines.some((line) => line.kind === 'hourly')).toBe(false)
    expect(blocked).toEqual([])
  })

  /**
   * Reproduced at $200 -> $250: the hours left at the line's own $100 and
   * arrived at the employee's current $125 bill rate. Moving work between two
   * columns of the same invoice must not change what it costs.
   */
  it('prices the arriving ad hoc line off the rate the hours were billing at', () => {
    const base = generated()
    // A hand-typed rate — or a bill rate that has moved since the generate.
    base[0] = { ...base[0], rate: 125, detail: '2.00h at $125.00/hr', amount: 250 }
    const { lines } = applyScopeRetag({
      lines: base,
      entries: ENTRIES,
      tagEdits: { e1: { tag: 'adhoc', adhocMode: 'billed' } },
      employees: EMPLOYEES,
      client: HOURLY,
      period: '2026-08',
      defaultHourlyRate: 60,
    })
    expect(find(lines, 'Billable hours — Patrice')).toMatchObject({ hours: 0.5, amount: 62.5 })
    expect(find(lines, 'Adhoc — Month-end close')).toMatchObject({ amount: 187.5 })
    // The whole point: net zero.
    expect(total(lines)).toBe(total(base))
  })
})

/**
 * WHAT THE LINES SAY ABOUT TIME THAT IS ALREADY TAGGED — the warning that has
 * to outlive the save, because a blocked tag still saves and the line on the
 * other side of it is still unadjusted.
 */
describe('hours the invoice does not account for', () => {
  const unaccounted = (lines, entries = ENTRIES, over = {}) =>
    unaccountedScopeEntries({
      lines,
      entries,
      employees: EMPLOYEES,
      client: HOURLY,
      period: '2026-08',
      defaultHourlyRate: 60,
      ...over,
    })

  it('says nothing about an invoice its own generator wrote', () => {
    expect(unaccounted(generated())).toEqual([])
  })

  it('flags ad hoc time with no ad hoc line of its own', () => {
    const renamed = [
      { kind: 'hourly', label: 'For services rendered for the month of', detail: '', amount: 800 },
    ]
    // e3 is ad hoc and has no line here; e4 is out of scope and nobody can show
    // its hours ever left the number that was typed.
    expect(unaccounted(renamed)).toEqual(['e3', 'e4'])
  })

  it('keeps saying so after a blocked tag has been saved', () => {
    const renamed = [
      { kind: 'hourly', label: 'For services rendered for the month of', detail: '', amount: 800 },
    ]
    // What the save wrote when the panel refused to move the money.
    const saved = ENTRIES.map((row) =>
      row.id === 'e1' ? { ...row, ...entryFlagsForScopeTag('out-of-scope') } : row,
    )
    expect(unaccounted(renamed, saved)).toContain('e1')
  })

  it('flags an ad hoc line still billing time that is no longer ad hoc', () => {
    const saved = ENTRIES.map((row) =>
      row.id === 'e3' ? { ...row, ...entryFlagsForScopeTag('in-scope') } : row,
    )
    expect(unaccounted(generated(), saved)).toEqual(['e3'])
  })

  it('is silent where re-tagging could never have moved money', () => {
    expect(unaccounted([], ENTRIES, { client: { ...HOURLY, billingMode: 'subscription' } })).toEqual(
      [],
    )
    expect(unaccounted([], ENTRIES, { period: '2026-05' })).toEqual([])
  })
})

/**
 * What the panel puts in the ad hoc select. Reading only `entryId`-stamped
 * lines showed "Invoice it" beside a row already sitting at courtesy on a
 * pre-commit draft, and one round trip through the panel re-billed it.
 */
describe('the ad hoc decision each line already carries', () => {
  const modes = (lines) =>
    savedAdhocModesForEntries({
      lines,
      entries: ENTRIES,
      employees: EMPLOYEES,
      client: HOURLY,
      defaultHourlyRate: 60,
    })

  it('reads a stamped line', () => {
    const lines = generated().map((line) =>
      line.kind === 'adhoc' ? { ...line, adhocMode: 'omitted', amount: 0 } : line,
    )
    expect(modes(lines)).toEqual({ e3: 'omitted' })
  })

  it('reads a pre-commit draft s line by its label and detail', () => {
    const lines = generated().map((line) => {
      if (line.kind !== 'adhoc') return line
      const { entryId: _dropped, ...rest } = line
      return { ...rest, adhocMode: 'courtesy', amount: 0, adhocAmount: 80 }
    })
    expect(modes(lines)).toEqual({ e3: 'courtesy' })
  })

  it('says nothing about an entry with no ad hoc line at all', () => {
    expect(modes([generated()[0]])).toEqual({})
  })
})

describe('a billing master', () => {
  const MASTER = {
    id: 'client-master',
    name: 'KLC',
    billingMode: 'hourly',
    hourlyRate: 60,
    isBillingMaster: true,
    planIds: [],
  }
  const SUB_ENTRIES = [
    entry({ id: 'm1', clientId: 'client-a', minutes: 60, description: 'Close A' }),
    entry({ id: 'm2', clientId: 'client-b', minutes: 60, description: 'Close B' }),
  ]
  const MASTER_LINES = [
    {
      kind: 'hourly',
      label: 'Billable hours — Patrice',
      detail: '1.00h at $100.00/hr',
      hours: 1,
      rate: 100,
      amount: 100,
      roleTier: 'Other',
      sourceClientId: 'client-a',
    },
    {
      kind: 'hourly',
      label: 'Billable hours — Patrice',
      detail: '1.00h at $100.00/hr',
      hours: 1,
      rate: 100,
      amount: 100,
      roleTier: 'Other',
      sourceClientId: 'client-b',
    },
  ]

  const masterRetag = (tagEdits) =>
    applyScopeRetag({
      lines: MASTER_LINES,
      entries: SUB_ENTRIES,
      tagEdits,
      employees: EMPLOYEES,
      client: MASTER,
      period: '2026-08',
      defaultHourlyRate: 60,
    })

  it('takes the hours off the RIGHT company s line, not the first name match', () => {
    const { lines } = masterRetag({ m2: { tag: 'out-of-scope' } })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toBe(MASTER_LINES[0])
  })

  it('stamps a new ad hoc line with the company it came from', () => {
    const { lines } = masterRetag({ m1: { tag: 'adhoc' } })
    expect(lines.find((line) => line.kind === 'adhoc')).toMatchObject({
      sourceClientId: 'client-a',
      entryId: 'm1',
      amount: 100,
    })
  })
})

describe('where re-tagging cannot move money', () => {
  const notApplicable = (over) => {
    const base = generated()
    const result = applyScopeRetag({
      lines: base,
      entries: ENTRIES,
      tagEdits: { e1: { tag: 'out-of-scope' } },
      employees: EMPLOYEES,
      client: HOURLY,
      period: '2026-08',
      defaultHourlyRate: 60,
      ...over,
    })
    expect(result.applicable).toBe(false)
    expect(result.changed).toBe(false)
    expect(result.lines).toBe(base)
  }

  it('says so on a subscription invoice', () => {
    notApplicable({ client: { ...HOURLY, billingMode: 'subscription' } })
  })

  it('says so on an annual invoice', () => {
    notApplicable({ client: { ...HOURLY, billingMode: 'annual' } })
  })

  it('says so before the June 2026 cutover, where one aggregate line was sent', () => {
    notApplicable({ period: '2026-05' })
  })
})

describe('re-applying the same staged tags', () => {
  it('changes nothing once the entries themselves carry the new tag', () => {
    const first = retag({ e1: { tag: 'adhoc', adhocMode: 'billed' } })
    // What the save writes to the entry, from the same shared rule the store uses.
    const saved = ENTRIES.map((row) =>
      row.id === 'e1' ? { ...row, ...entryFlagsForScopeTag('adhoc') } : row,
    )
    const second = applyScopeRetag({
      lines: first.lines,
      entries: saved,
      tagEdits: { e1: { tag: 'adhoc', adhocMode: 'billed' } },
      employees: EMPLOYEES,
      client: HOURLY,
      period: '2026-08',
      defaultHourlyRate: 60,
    })
    expect(second.changed).toBe(false)
    expect(second.lines).toBe(first.lines)
  })

  it('is pure — the same arguments give the same answer and the input is untouched', () => {
    const base = generated()
    const args = {
      lines: base,
      entries: ENTRIES,
      tagEdits: { e1: { tag: 'out-of-scope' }, e4: { tag: 'adhoc' } },
      employees: EMPLOYEES,
      client: HOURLY,
      period: '2026-08',
      defaultHourlyRate: 60,
    }
    const once = applyScopeRetag(args)
    const twice = applyScopeRetag(args)
    expect(twice.lines).toEqual(once.lines)
    expect(base).toEqual(generated())
  })
})
