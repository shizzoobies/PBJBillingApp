import { describe, expect, it } from 'vitest'

import {
  adhocLineForMode,
  buildInvoiceLines,
  normalizeAdhocMode,
  renderedInvoiceLines,
} from './invoice-lines.js'
import { buildInvoiceDraft } from './invoice-draft.js'
import { buildInvoiceEmail } from './invoice-email.js'
import { buildInvoicePdf } from './invoice-pdf.js'
import { buildQboCsv } from './qbo-export.js'

/**
 * Ad hoc time — one-off work outside a client's scoped arrangement, billed on
 * its own line at the employee's rate.
 *
 * The invariant these tests exist for is NO DOUBLE BILLING: a billable entry is
 * counted in the adhoc lines or in "Billable hours — <name>", never in both and
 * never in neither. Everything else here (the three-way choice, what prints)
 * only matters because it must not break that.
 */

const HOURLY = {
  id: 'client-1',
  name: 'Acme',
  billingMode: 'hourly',
  hourlyRate: 60,
  planIds: [],
}

const EMPLOYEES = [
  { id: 'emp-1', name: 'Patrice', billRate: 100 },
  { id: 'emp-2', name: 'Lisa', billRate: 80 },
]

const entry = (over = {}) => ({
  clientId: 'client-1',
  employeeId: 'emp-1',
  billable: true,
  minutes: 60,
  date: '2026-08-04',
  description: 'Reconciled the operating account',
  ...over,
})

const build = (entries, over = {}) =>
  buildInvoiceLines({
    client: HOURLY,
    entries,
    billingPeriod: '2026-08',
    employees: EMPLOYEES,
    defaultHourlyRate: 60,
    ...over,
  })

/** Total on lines of one kind — the shape most assertions below want. */
const sumOfKind = (lines, kind) =>
  lines.filter((line) => line.kind === kind).reduce((sum, line) => sum + line.amount, 0)

describe('the no-double-billing invariant', () => {
  it('bills an ad hoc entry on its own line and NOT inside the hours', () => {
    const lines = build([
      entry({ minutes: 120 }), // scoped: 2h at $100
      entry({ minutes: 30, isAdhoc: true, description: 'Rush 1099 question' }),
    ]).lines

    // Scoped hours cover the 2h only. If the ad hoc half-hour leaked in, this
    // would be $250.
    expect(sumOfKind(lines, 'hourly')).toBe(200)
    expect(sumOfKind(lines, 'adhoc')).toBe(50)
    expect(lines.find((line) => line.kind === 'hourly').detail).toContain('2.00h')
  })

  it('bills every billable entry exactly once, through one path or the other', () => {
    const entries = [
      entry({ minutes: 60 }),
      entry({ minutes: 90, employeeId: 'emp-2' }),
      entry({ minutes: 45, isAdhoc: true }),
      entry({ minutes: 15, isAdhoc: true, employeeId: 'emp-2' }),
    ]
    const built = build(entries)

    // What the entries are worth at their own rates, computed independently of
    // the builder — the two must agree to the penny, which they only can if
    // each entry landed on exactly one side of the partition.
    const expected = entries.reduce((sum, each) => {
      const rate = EMPLOYEES.find((e) => e.id === each.employeeId).billRate
      return sum + (each.minutes / 60) * rate
    }, 0)

    expect(sumOfKind(built.lines, 'hourly') + sumOfKind(built.lines, 'adhoc')).toBeCloseTo(
      expected,
      10,
    )
    expect(built.total).toBeCloseTo(expected, 10)
  })

  it('drops the employee from the hours entirely when ALL their time was ad hoc', () => {
    const lines = build([
      entry({ minutes: 60 }),
      entry({ minutes: 60, employeeId: 'emp-2', isAdhoc: true }),
    ]).lines

    const hourly = lines.filter((line) => line.kind === 'hourly')
    expect(hourly).toHaveLength(1)
    expect(hourly[0].label).toBe('Billable hours — Patrice')
    // ...and Lisa's hour is still billed, once, as ad hoc.
    expect(sumOfKind(lines, 'adhoc')).toBe(80)
  })

  it('leaves NON-billable ad hoc time off the invoice, like any internal time', () => {
    const lines = build([entry({ isAdhoc: true, billable: false })]).lines
    expect(lines.filter((line) => line.kind === 'adhoc')).toHaveLength(0)
    expect(sumOfKind(lines, 'hourly')).toBe(0)
  })
})

describe('ad hoc lines', () => {
  it('bills at the EMPLOYEE rate, not the client legacy rate', () => {
    const lines = build([entry({ minutes: 90, isAdhoc: true, employeeId: 'emp-2' })]).lines
    const adhoc = lines.find((line) => line.kind === 'adhoc')
    // 1.5h at Lisa's $80, not at the client's $60.
    expect(adhoc.amount).toBe(120)
    expect(adhoc.detail).toContain('1.50h at $80.00/hr')
  })

  it('falls back to the client rate when the employee has no bill rate', () => {
    const lines = build([entry({ isAdhoc: true, employeeId: 'emp-nobody' })]).lines
    expect(lines.find((line) => line.kind === 'adhoc').amount).toBe(60)
  })

  it('names the work, the day and the person', () => {
    const adhoc = build([
      entry({ isAdhoc: true, description: 'Rush 1099 question' }),
    ]).lines.find((line) => line.kind === 'adhoc')

    expect(adhoc.label).toBe('Adhoc — Rush 1099 question')
    expect(adhoc.detail).toContain('Aug 4, 2026')
    expect(adhoc.detail).toContain('Patrice')
  })

  it('stays readable when nobody wrote a description', () => {
    const adhoc = build([entry({ isAdhoc: true, description: '   ' })]).lines.find(
      (line) => line.kind === 'adhoc',
    )
    expect(adhoc.label).toBe('Adhoc — One-off work')
  })

  it('starts on "invoice it", holding the amount it would charge', () => {
    const adhoc = build([entry({ isAdhoc: true })]).lines.find((line) => line.kind === 'adhoc')
    expect(adhoc.adhocMode).toBe('billed')
    expect(adhoc.adhocAmount).toBe(adhoc.amount)
  })

  it('lists oldest first', () => {
    const labels = build([
      entry({ isAdhoc: true, date: '2026-08-20', description: 'Later' }),
      entry({ isAdhoc: true, date: '2026-08-02', description: 'Earlier' }),
    ])
      .lines.filter((line) => line.kind === 'adhoc')
      .map((line) => line.label)
    expect(labels).toEqual(['Adhoc — Earlier', 'Adhoc — Later'])
  })

  it('leaves flat-fee clients alone — their ad hoc time is not a charge', () => {
    const lines = buildInvoiceLines({
      client: { ...HOURLY, billingMode: 'subscription', monthlyRate: 500 },
      entries: [entry({ isAdhoc: true })],
      billingPeriod: '2026-08',
      employees: EMPLOYEES,
    }).lines
    expect(lines.filter((line) => line.kind === 'adhoc')).toHaveLength(0)
    expect(lines.reduce((sum, line) => sum + line.amount, 0)).toBe(500)
  })

  it('never separates pre-cutover months — an already-sent number must not move', () => {
    const built = buildInvoiceLines({
      client: HOURLY,
      entries: [entry({ date: '2026-05-04', isAdhoc: true, minutes: 120 })],
      billingPeriod: '2026-05',
      employees: EMPLOYEES,
    })
    expect(built.lines.filter((line) => line.kind === 'adhoc')).toHaveLength(0)
    // The one legacy aggregate line, at the client's own rate: 2h at $60.
    expect(built.total).toBe(120)
  })
})

describe('the three-way choice', () => {
  const line = () => ({ kind: 'adhoc', label: 'Adhoc — x', detail: '', amount: 75, adhocAmount: 75 })

  it('zeroes a courtesy line but keeps what it would have charged', () => {
    const courtesy = adhocLineForMode(line(), 'courtesy')
    expect(courtesy.amount).toBe(0)
    expect(courtesy.adhocAmount).toBe(75)
  })

  it('zeroes an omitted line the same way', () => {
    expect(adhocLineForMode(line(), 'omitted').amount).toBe(0)
  })

  it('restores the amount when the owner puts it back on the invoice', () => {
    const flipped = adhocLineForMode(adhocLineForMode(line(), 'omitted'), 'billed')
    expect(flipped.amount).toBe(75)
    expect(flipped.adhocMode).toBe('billed')
  })

  it('reads anything unrecognized as the default', () => {
    expect(normalizeAdhocMode(undefined)).toBe('billed')
    expect(normalizeAdhocMode('free')).toBe('billed')
    expect(normalizeAdhocMode('omitted')).toBe('omitted')
  })

  // A line with no reserve on it yet must not be zeroed by a round trip —
  // absent means "nobody has set this", not "worth nothing".
  it('falls back to the line’s own amount when there is no reserve', () => {
    const bare = { kind: 'adhoc', label: 'Adhoc — x', detail: '', amount: 75 }
    const roundTrip = adhocLineForMode(adhocLineForMode(bare, 'courtesy'), 'billed')
    expect(roundTrip.amount).toBe(75)
  })
})

describe('what actually prints', () => {
  const lines = [
    { kind: 'hourly', label: 'Billable hours — Patrice', detail: '', amount: 200 },
    { kind: 'adhoc', label: 'Adhoc — billed', detail: '', amount: 50, adhocMode: 'billed' },
    { kind: 'adhoc', label: 'Adhoc — courtesy', detail: '', amount: 0, adhocMode: 'courtesy' },
    { kind: 'adhoc', label: 'Adhoc — omitted', detail: '', amount: 0, adhocMode: 'omitted' },
  ]

  it('shows a courtesy line and hides an omitted one', () => {
    expect(renderedInvoiceLines(lines).map((line) => line.label)).toEqual([
      'Billable hours — Patrice',
      'Adhoc — billed',
      'Adhoc — courtesy',
    ])
  })

  it('does not change the money either way — the hidden line is worth nothing', () => {
    const shown = renderedInvoiceLines(lines).reduce((sum, line) => sum + line.amount, 0)
    const all = lines.reduce((sum, line) => sum + line.amount, 0)
    expect(shown).toBe(all)
  })

  it('treats an ad hoc line with no mode as billed and prints it', () => {
    expect(renderedInvoiceLines([{ kind: 'adhoc', label: 'Adhoc — legacy', amount: 10 }])).toHaveLength(
      1,
    )
  })

  /**
   * A POSITIVE-IDENTIFICATION filter: it drops only what it can positively
   * identify as an omitted ad hoc line, and passes everything else through
   * untouched. Two callers depend on that and would break silently if this
   * ever became strict about `kind`:
   *
   *   - the in-app PRINT sheet (src/pages/InvoicesPage.tsx), which hands it
   *     already display-mapped lines carrying only label/detail/amount;
   *   - `clientFacingInvoiceLines`, which runs a standard-mode document back
   *     through it after the print sheet has already filtered once.
   *
   * So: kind-less lines survive, and filtering twice is the same as filtering
   * once. Pinned here rather than left as a comment, because a comment does
   * not fail a build.
   */
  it('passes kind-less lines through, and is idempotent', () => {
    const displayMapped = [
      { label: 'Monthly service', detail: 'August', amount: 900 },
      { label: 'Reimbursement: Filing fee', detail: 'Aug 3, 2026', amount: 45 },
    ]
    expect(renderedInvoiceLines(displayMapped)).toEqual(displayMapped)
    expect(renderedInvoiceLines(renderedInvoiceLines(lines))).toEqual(renderedInvoiceLines(lines))
  })

  it('keeps an omitted line out of the QBO export and a courtesy line in', () => {
    const csv = buildQboCsv(
      [{ number: 'INV-2026-08-001', clientId: 'client-1', period: '2026-08', lineItems: lines }],
      new Map([['client-1', { name: 'Acme' }]]),
    )
    expect(csv).toContain('Adhoc — courtesy')
    expect(csv).not.toContain('Adhoc — omitted')
  })
})

/**
 * The three documents that leave the building. Asserted on the REAL rendered
 * output rather than on the shared filter, because the failure worth catching
 * is one surface quietly forgetting to use it and mailing a client a line the
 * owner decided they would never see.
 *
 * The PDF reader is the one from `invoice-pdf.test.mjs` — PDFKit writes text as
 * hex-encoded WinAnsi runs, so assertions stay on ASCII substrings.
 */
describe('what the client actually receives', () => {
  const invoice = {
    number: 'INV-2026-08-001',
    period: '2026-08',
    dueDate: '2026-09-30',
    total: 250,
    subtotal: 250,
    blurb: '',
    lineItems: [
      { kind: 'hourly', label: 'Billable hours - Lisa', detail: '', amount: 200 },
      { kind: 'adhoc', label: 'Adhoc - shown free', detail: '', amount: 0, adhocMode: 'courtesy' },
      { kind: 'adhoc', label: 'Adhoc - left off', detail: '', amount: 0, adhocMode: 'omitted' },
    ],
  }
  const client = { name: 'Acme', email: 'ap@acme.test' }

  function pdfText(buffer) {
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

  it('emails the courtesy line at $0.00 and never the omitted one', () => {
    const { html, text } = buildInvoiceEmail({ invoice, client })

    expect(html).toContain('Adhoc - shown free')
    expect(html).not.toContain('Adhoc - left off')
    // The plain-text alternative is a second copy of the breakdown — it has to
    // make the same promise, or the two halves of one email disagree.
    expect(text).toContain('Adhoc - shown free')
    expect(text).not.toContain('Adhoc - left off')
    expect(text).toContain('$0.00')
  })

  it('prints the courtesy line in the PDF and leaves the omitted one out', async () => {
    const rendered = pdfText(await buildInvoicePdf({ invoice, client, compress: false }))

    expect(rendered).toContain('Adhoc - shown free')
    expect(rendered).not.toContain('Adhoc - left off')
  })
})

describe('the generated draft', () => {
  it('carries the ad hoc lines, their mode and a matching reserve amount', () => {
    const draft = buildInvoiceDraft({
      client: HOURLY,
      period: '2026-08',
      entries: [entry({ minutes: 120 }), entry({ minutes: 50, isAdhoc: true })],
      employees: EMPLOYEES,
      defaultHourlyRate: 60,
    })

    const adhoc = draft.lineItems.filter((line) => line.kind === 'adhoc')
    expect(adhoc).toHaveLength(1)
    // 50 minutes at $100 is $83.333…; both fields land on the same cent, so a
    // courtesy-then-billed round trip cannot move the total by a penny.
    expect(adhoc[0].amount).toBe(83.33)
    expect(adhoc[0].adhocAmount).toBe(83.33)
    expect(adhoc[0].adhocMode).toBe('billed')
    expect(draft.total).toBe(283.33)
  })
})
