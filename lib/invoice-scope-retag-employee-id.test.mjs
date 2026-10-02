import { describe, expect, it } from 'vitest'

import { buildInvoiceLines } from './invoice-lines.js'
import { applyScopeRetag, unaccountedScopeEntries } from './invoice-scope-retag.js'

/**
 * The hours panel's re-tag meets the hours editor's two marks on a line:
 *
 *   - `employeeId` — whose hours the line holds. The re-tag finds a person's
 *     line by it FIRST, so retyping the label (the editor lets her, and the
 *     role-titled labels will make it the norm) no longer strands the line.
 *   - `rateManual` — she typed the rate. The re-tag keeps such a line, and its
 *     rate, when it drains to zero hours, so hours that come back bill at HER
 *     rate rather than the person's own.
 *
 * Lines a draft carried before either mark existed have neither, and are found
 * by their exact label exactly as they always were.
 */

const HOURLY = { id: 'client-1', name: 'Acme', billingMode: 'hourly', hourlyRate: 60, planIds: [] }

const EMPLOYEES = [
  { id: 'emp-1', name: 'Patrice', role: 'Owner', billRate: 100 },
  { id: 'emp-2', name: 'Lisa', role: 'Bookkeeper', billRate: 80 },
]

const entry = (over = {}) => ({
  id: 'x',
  clientId: 'client-1',
  employeeId: 'emp-1',
  billable: true,
  minutes: 60,
  date: '2026-08-04',
  description: 'Reconciled the operating account',
  ...over,
})

const line = (over = {}) => ({
  kind: 'hourly',
  label: 'Billable hours — Patrice',
  detail: '1.00h at $90.00/hr',
  hours: 1,
  rate: 90,
  amount: 90,
  roleTier: 'CFO',
  ...over,
})

const retag = (lines, entries, tagEdits, over = {}) =>
  applyScopeRetag({
    lines,
    entries,
    tagEdits,
    employees: EMPLOYEES,
    client: HOURLY,
    period: '2026-08',
    defaultHourlyRate: 60,
    ...over,
  })

describe('a line found by employeeId', () => {
  // She retyped the label; the line is still Patrice's.
  const renamed = () =>
    line({ label: 'CFO / Advisory Services', employeeId: 'emp-1', hours: 2, amount: 180 })
  const entries = [
    entry({ id: 'e1', minutes: 60 }),
    entry({ id: 'e2', minutes: 60 }),
    entry({ id: 'e4', minutes: 45, billable: false }),
  ]

  it('is found for the DEPARTURE even though the label no longer says Patrice', () => {
    const { lines, changed, blocked } = retag([renamed()], entries, { e1: { tag: 'out-of-scope' } })
    expect(blocked).toEqual([])
    expect(changed).toBe(true)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      label: 'CFO / Advisory Services',
      employeeId: 'emp-1',
      hours: 1,
      rate: 90,
      amount: 90,
      detail: '1.00h at $90.00/hr',
    })
  })

  it('is found for the ARRIVAL too, at the rate the line carries', () => {
    const { lines, blocked } = retag([renamed()], entries, { e4: { tag: 'in-scope' } })
    expect(blocked).toEqual([])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ hours: 2.75, rate: 90, amount: 247.5 })
  })

  it('is never taken by somebody else whose label happens to match', () => {
    // Stamped for Lisa but labeled Patrice: the stamp is the answer.
    const stamped = line({ employeeId: 'emp-2' })
    const { lines, blocked } = retag([stamped], entries, { e1: { tag: 'out-of-scope' } })
    expect(blocked).toEqual(['e1'])
    expect(lines).toEqual([stamped])
  })

  it('stamps the lines a re-tag CREATES with the person', () => {
    const { lines } = retag([], entries, { e4: { tag: 'in-scope' } })
    expect(lines).toHaveLength(1)
    // Labeled the way Generate labels it: the role's title.
    expect(lines[0]).toMatchObject({
      label: 'CFO / Advisory Services',
      employeeId: 'emp-1',
      roleTier: 'CFO',
      hours: 0.75,
      rate: 100,
    })
  })

  it('appends the name when a role-mate already has a line, so two rows never share a label', () => {
    const mate = line({
      label: 'CFO / Advisory Services',
      employeeId: 'emp-9',
      roleTier: 'CFO',
    })
    const { lines } = retag([mate], entries, { e4: { tag: 'in-scope' } })
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe(mate)
    expect(lines[1]).toMatchObject({
      label: 'CFO / Advisory Services — Patrice',
      employeeId: 'emp-1',
    })
  })

  it('does not count an EMPTY hand row as a role-mate: no name next to a row nobody can see', () => {
    const empty = line({
      label: 'CFO / Advisory Services',
      detail: '0.00h at $150.00/hr',
      hours: 0,
      rate: 150,
      amount: 0,
      roleTier: 'CFO',
    })
    const { lines } = retag([empty], entries, { e4: { tag: 'in-scope' } })
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe(empty)
    expect(lines[1]).toMatchObject({ label: 'CFO / Advisory Services', employeeId: 'emp-1' })
    // A row WITH hours still counts.
    const real = { ...empty, hours: 1, amount: 150, detail: '1.00h at $150.00/hr' }
    expect(retag([real], entries, { e4: { tag: 'in-scope' } }).lines[1].label).toBe(
      'CFO / Advisory Services — Patrice',
    )
  })

  it('a renamed stamped line is not what makes the hours panel warn', () => {
    // Patrice's hour is tagged out of scope and the line (renamed, but stamped)
    // still accounts for her: nothing is "unaccounted".
    const out = [entry({ id: 'e5', billable: false })]
    expect(
      unaccountedScopeEntries({
        lines: [renamed()],
        entries: out,
        employees: EMPLOYEES,
        client: HOURLY,
        period: '2026-08',
        defaultHourlyRate: 60,
      }),
    ).toEqual([])
  })
})

describe('a master: employeeId AND sourceClientId', () => {
  const MASTER = { id: 'master', name: 'KLC', billingMode: 'hourly', isBillingMaster: true, planIds: [] }
  const subEntries = [
    entry({ id: 'm1', clientId: 'client-a' }),
    entry({ id: 'm2', clientId: 'client-b' }),
  ]
  const lines = () => [
    line({ label: 'Accounting', employeeId: 'emp-1', sourceClientId: 'client-a' }),
    line({ label: 'Accounting', employeeId: 'emp-1', sourceClientId: 'client-b' }),
  ]

  it('takes the hours off the right company’s line even with the labels identical and retyped', () => {
    const { lines: out } = retag(lines(), subEntries, { m2: { tag: 'out-of-scope' } }, { client: MASTER })
    // Her last row for company B is not a manual-rate line: removed at zero.
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ sourceClientId: 'client-a', hours: 1 })
  })

  it('does not match a line stamped for the right person under the wrong company', () => {
    const onlyA = [lines()[0]]
    const { lines: out, blocked } = retag(
      onlyA,
      subEntries,
      { m2: { tag: 'out-of-scope' } },
      { client: MASTER },
    )
    expect(blocked).toEqual(['m2'])
    expect(out).toEqual(onlyA)
  })

  it('stamps a created line with both', () => {
    const outOfScope = [entry({ id: 'm3', clientId: 'client-a', billable: false })]
    const { lines: out } = retag([], outOfScope, { m3: { tag: 'in-scope' } }, { client: MASTER })
    expect(out[0]).toMatchObject({ employeeId: 'emp-1', sourceClientId: 'client-a' })
  })
})

describe('a line she priced by hand (rateManual) survives its hours going away', () => {
  const manual = (over = {}) => line({ employeeId: 'emp-1', rateManual: true, ...over })
  const inScope = [entry({ id: 'e1', minutes: 60 })]

  it('is KEPT at 0 hours, at her rate, when the re-tag drains it', () => {
    const { lines, changed } = retag([manual()], inScope, { e1: { tag: 'out-of-scope' } })
    expect(changed).toBe(true)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      hours: 0,
      rate: 90,
      rateManual: true,
      employeeId: 'emp-1',
      amount: 0,
      detail: '0.00h at $90.00/hr',
    })
  })

  it('takes the hours back at HER rate when they come back, not Patrice’s own $100', () => {
    const away = retag([manual()], inScope, { e1: { tag: 'out-of-scope' } }).lines
    const back = retag(away, [entry({ id: 'e1', minutes: 60, billable: false })], {
      e1: { tag: 'in-scope' },
    })
    expect(back.lines).toHaveLength(1)
    expect(back.lines[0]).toMatchObject({ hours: 1, rate: 90, rateManual: true, amount: 90 })
  })

  it('moves the same hours to an ad hoc line at her rate, so the total does not move', () => {
    const { lines } = retag([manual()], inScope, { e1: { tag: 'adhoc' } })
    expect(lines.find((l) => l.kind === 'hourly')).toMatchObject({ hours: 0, amount: 0 })
    expect(lines.find((l) => l.kind === 'adhoc')).toMatchObject({ amount: 90 })
    expect(lines.reduce((sum, l) => sum + l.amount, 0)).toBe(90)
  })

  it('a line that is NOT manual is still removed at zero, as it always was', () => {
    const plain = line({ employeeId: 'emp-1' })
    const { lines } = retag([plain], inScope, { e1: { tag: 'out-of-scope' } })
    expect(lines).toEqual([])
  })

  it('an older label-only draft (no employeeId, not manual) behaves exactly as before', () => {
    const older = line()
    expect(retag([older], inScope, { e1: { tag: 'out-of-scope' } }).lines).toEqual([])
    const half = retag([line({ hours: 2, amount: 180 })], inScope, { e1: { tag: 'out-of-scope' } })
    expect(half.lines[0]).toMatchObject({ hours: 1, rate: 90, amount: 90 })
    expect(half.lines[0]).not.toHaveProperty('employeeId')
  })
})

describe('a line with no employeeId is found by a label that carries the person’s name', () => {
  const entries1 = [entry({ id: 'e1', minutes: 60 }), entry({ id: 'e2', minutes: 60 })]
  const outOne = (label, over = {}) =>
    retag([line({ label, hours: 2, amount: 180, ...over })], entries1, { e1: { tag: 'out-of-scope' } })

  it('finds the old "Billable hours — <name>" line (a draft Generate made before the stamp)', () => {
    const { lines, blocked } = outOne('Billable hours — Patrice', { roleTier: undefined })
    expect(blocked).toEqual([])
    expect(lines[0]).toMatchObject({ hours: 1, amount: 90 })
  })

  it('finds a role-titled line with the person’s name appended, in that person’s role', () => {
    const { lines, blocked } = outOne('CFO / Advisory Services — Patrice')
    expect(blocked).toEqual([])
    expect(lines[0]).toMatchObject({ hours: 1, amount: 90 })
  })

  it('NEVER matches a bare role title: a hand-typed role row is inert to a re-tag', () => {
    const { blocked, changed } = outOne('CFO / Advisory Services')
    expect(blocked).toEqual(['e1'])
    expect(changed).toBe(false)
  })

  it('does not take a role-titled line that sits in somebody else’s role, or has somebody else’s name', () => {
    // "Bookkeeping Services — Patrice" on a Bookkeeper-tier line: not Patrice's role.
    expect(outOne('Bookkeeping Services — Patrice', { roleTier: 'Bookkeeper' }).blocked).toEqual(['e1'])
    expect(outOne('CFO / Advisory Services — Lisa').blocked).toEqual(['e1'])
  })

  it('does not call a role-titled-with-name draft line "renamed" (so the hours panel does not warn)', () => {
    const out = [entry({ id: 'e5', billable: false })]
    expect(
      unaccountedScopeEntries({
        lines: [line({ label: 'CFO / Advisory Services — Patrice' })],
        entries: out,
        employees: EMPLOYEES,
        client: HOURLY,
        period: '2026-08',
        defaultHourlyRate: 60,
      }),
    ).toEqual([])
  })
})

describe('a draft generated BEFORE the stamp existed has no employeeId, so a line she renamed is found by label only', () => {
  // Drafts already stored when the stamp shipped carry the label-only kind of
  // line. THE CASE WORTH SAYING OUT LOUD: she renames one AND re-rates it
  // (rateManual). With the label gone and no id, the re-tag cannot find it.
  const renamedAndRerated = () =>
    line({ label: 'Hand-typed hours', rateManual: true, hours: 2, amount: 180 })
  const entries = [entry({ id: 'e1', minutes: 60 }), entry({ id: 'e4', minutes: 45, billable: false })]

  it('taking hours OUT is refused and reported (nothing moves, the tag still saves)', () => {
    const lines = [renamedAndRerated()]
    const { lines: out, changed, blocked } = retag(lines, entries, { e1: { tag: 'out-of-scope' } })
    expect(blocked).toEqual(['e1'])
    expect(changed).toBe(false)
    expect(out).toBe(lines)
  })

  it('putting hours IN creates a NEW per-person line at the staff rate, beside hers', () => {
    const lines = [renamedAndRerated()]
    const { lines: out, blocked } = retag(lines, entries, { e4: { tag: 'in-scope' } })
    expect(blocked).toEqual([])
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(lines[0])
    // $100 is Patrice's own rate, not the $90 she typed on the line she renamed.
    expect(out[1]).toMatchObject({
      label: 'CFO / Advisory Services — Patrice',
      employeeId: 'emp-1',
      hours: 0.75,
      rate: 100,
    })
  })

  it('but a line she re-rated WITHOUT renaming is found by its label and keeps her rate', () => {
    const lines = [line({ rateManual: true, hours: 2, amount: 180 })]
    const { lines: out } = retag(lines, entries, { e4: { tag: 'in-scope' } })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ hours: 2.75, rate: 90, rateManual: true })
  })
})

describe('a line Generate made carries the stamp, so renaming it does not lose it', () => {
  const entries = [
    entry({ id: 'e1', minutes: 60 }),
    entry({ id: 'e2', minutes: 60 }),
    entry({ id: 'e4', minutes: 45, billable: false }),
  ]
  const generated = () =>
    buildInvoiceLines({
      client: HOURLY,
      entries,
      employees: EMPLOYEES,
      billingPeriod: '2026-08',
      defaultHourlyRate: 60,
    }).lines.filter((l) => l.kind === 'hourly')

  it('Generate stamps each per-person hours line with the person', () => {
    expect(generated().map((l) => l.employeeId)).toEqual(['emp-1'])
  })

  it('a renamed AND re-rated generated line is found for departure and arrival, at her rate', () => {
    const [made] = generated()
    const renamed = { ...made, label: 'CFO/Advisory Services', rate: 90, rateManual: true }
    const out = retag([renamed], entries, { e1: { tag: 'out-of-scope' } })
    expect(out.blocked).toEqual([])
    expect(out.lines).toHaveLength(1)
    expect(out.lines[0]).toMatchObject({
      label: 'CFO/Advisory Services',
      hours: 1,
      rate: 90,
      amount: 90,
    })
    const back = retag(out.lines, entries, { e4: { tag: 'in-scope' } })
    expect(back.blocked).toEqual([])
    expect(back.lines).toHaveLength(1)
    expect(back.lines[0]).toMatchObject({ label: 'CFO/Advisory Services', hours: 1.75, rate: 90 })
  })
})

describe('a hand-typed role row (no employeeId) is inert to a re-tag', () => {
  const handRow = () =>
    line({
      label: 'CFO / Advisory Services',
      detail: '5.00h at $150.00/hr',
      hours: 5,
      rate: 150,
      amount: 750,
      roleTier: 'CFO',
      rateManual: true,
    })
  const entries = [entry({ id: 'e1', minutes: 60 }), entry({ id: 'e4', minutes: 45, billable: false })]

  it('is not drawn down when the CFO’s own entry is tagged out of scope', () => {
    const lines = [handRow()]
    const { lines: out, blocked } = retag(lines, entries, { e1: { tag: 'out-of-scope' } })
    // Nothing on the invoice is the CFO's own line, so nothing can be taken off.
    expect(blocked).toEqual(['e1'])
    expect(out).toBe(lines)
    expect(out[0].hours).toBe(5)
  })

  it('is not added to when the CFO’s entry comes in: the person gets her own line', () => {
    const lines = [handRow()]
    const { lines: out } = retag(lines, entries, { e4: { tag: 'in-scope' } })
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(lines[0])
    expect(out[1]).toMatchObject({ employeeId: 'emp-1', hours: 0.75, rate: 100 })
  })
})

describe('the "renamed line" warning and an empty hand row', () => {
  // An out-of-scope entry whose person has no line on the invoice.
  const outEntry = [entry({ id: 'e5', billable: false, minutes: 60 })]
  const warn = (lines) =>
    unaccountedScopeEntries({
      lines,
      entries: outEntry,
      employees: EMPLOYEES,
      client: HOURLY,
      period: '2026-08',
      defaultHourlyRate: 60,
    })
  const handRow = (over = {}) =>
    line({
      label: 'CFO / Advisory Services',
      detail: '0.00h at $150.00/hr',
      hours: 0,
      rate: 150,
      amount: 0,
      roleTier: 'CFO',
      ...over,
    })

  it('an EMPTY row (0 hours, $0) does not turn the warning on', () => {
    expect(warn([handRow()])).toEqual([])
  })

  it('a row with hours on it still does: it may be hiding somebody’s hours', () => {
    expect(warn([handRow({ hours: 3, amount: 450, detail: '3.00h at $150.00/hr' })])).toEqual(['e5'])
  })

  it('an empty row next to a real renamed line does not hide that line’s warning', () => {
    const renamed = line({ label: 'Hand-typed hours', hours: 2, amount: 180 })
    expect(warn([handRow(), renamed])).toEqual(['e5'])
  })
})

describe('a second person arriving in a role tells the role-mate apart', () => {
  // Patrice (Owner = CFO) has the generated bare-title line; Sam is a second CFO.
  const people = [...EMPLOYEES, { id: 'emp-3', name: 'Sam', role: 'Owner', billRate: 110 }]
  const samIn = [entry({ id: 's1', employeeId: 'emp-3', minutes: 30, billable: false })]
  const arrive = (lines) =>
    retag(lines, samIn, { s1: { tag: 'in-scope' } }, { employees: people })
  const mate = (over = {}) =>
    line({
      label: 'CFO / Advisory Services',
      employeeId: 'emp-1',
      roleTier: 'CFO',
      rate: 100,
      ...over,
    })

  it('relabels the untouched, stamped, bare-titled mate "<Title> — <its person>"', () => {
    const original = mate()
    const { lines } = arrive([original])
    expect(lines.map((l) => l.label)).toEqual([
      'CFO / Advisory Services — Patrice',
      'CFO / Advisory Services — Sam',
    ])
    // Only the label moved on the mate: hours, rate, amount and id are as they were.
    expect(lines[0]).toEqual({ ...original, label: 'CFO / Advisory Services — Patrice' })
    expect(lines[1]).toMatchObject({ employeeId: 'emp-3', hours: 0.5, rate: 110 })
    expect(new Set(lines.map((l) => l.label)).size).toBe(2)
  })

  it('leaves a mate whose label she retyped alone', () => {
    const retyped = mate({ label: 'CFO/Advisory Services' })
    const { lines } = arrive([retyped])
    expect(lines[0]).toBe(retyped)
    expect(lines[1].label).toBe('CFO / Advisory Services — Sam')
  })

  it('leaves a hand-typed bare-title row (no employeeId) alone', () => {
    const hand = mate({ employeeId: undefined })
    delete hand.employeeId
    const { lines } = arrive([hand])
    expect(lines[0]).toBe(hand)
    expect(lines[1].label).toBe('CFO / Advisory Services — Sam')
  })

  it('does not touch a role-mate in a different role', () => {
    const lisa = line({
      label: 'Bookkeeping Services',
      employeeId: 'emp-2',
      roleTier: 'Bookkeeper',
    })
    const { lines } = arrive([lisa])
    expect(lines[0]).toBe(lisa)
    expect(lines[1].label).toBe('CFO / Advisory Services')
  })

  it('on a billing master only relabels the mate under the same company', () => {
    const MASTER = { id: 'master', name: 'KLC', billingMode: 'hourly', isBillingMaster: true, planIds: [] }
    const a = mate({ sourceClientId: 'client-a' })
    const b = mate({ sourceClientId: 'client-b' })
    const subEntry = [entry({ id: 's2', employeeId: 'emp-3', clientId: 'client-a', billable: false })]
    const { lines } = retag([a, b], subEntry, { s2: { tag: 'in-scope' } }, { employees: people, client: MASTER })
    expect(lines.find((l) => l.sourceClientId === 'client-a' && l.employeeId === 'emp-1').label).toBe(
      'CFO / Advisory Services — Patrice',
    )
    expect(lines.find((l) => l.sourceClientId === 'client-b')).toBe(b)
  })
})
