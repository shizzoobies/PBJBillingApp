import { describe, expect, it } from 'vitest'

import { assembleEngagement } from './engagement-assemble.js'
import { DEFAULT_ENGAGEMENT_SECTIONS } from './engagement-sections.js'
import {
  ENGAGEMENT_PLACEHOLDERS,
  engagementTemplateHash,
  engagementValues,
  skippedEngagementLines,
} from './engagement-values.js'
import {
  engagementPlaceholders,
  fillTemplate,
  letterMoney,
  letterPlaceholders,
  letterTemplateHash,
  placeholdersFor,
  templateWarnings,
} from './letter-template.js'
import { defaultProposalPricing, priceProposal } from './proposal-pricing.js'

/**
 * The values an engagement letter is filled with (docs/plans/engagements-2026-10.md 2A),
 * and the placeholder scopes that keep the engagement-only keys out of Letters.
 */

const NOW = new Date('2026-10-08T16:00:00Z')
const catalog = defaultProposalPricing()

function snapshotOf(selections, inputs) {
  const { lines, totals, hoursByRole } = priceProposal({ catalog, rates: catalog.rates, inputs, selections })
  return { rates: catalog.rates, lines, totals, hoursByRole, catalogAt: '2026-10-01T12:00:00.000Z' }
}

const FULL_INPUTS = {
  balanceSheetAccounts: 20,
  employees: 10,
  clientCallHours: 2,
  transactions: 200,
  cleanupMonths: 6,
  salesTaxReviewAmount: 25,
  states: 2,
}
const full = snapshotOf(
  [
    { serviceId: 'reconciliations' },
    { serviceId: 'payroll' },
    { serviceId: 'client-call' },
    { serviceId: 'business-return', flatAmount: 1200 },
    { serviceId: 'payroll-setup', flatAmount: 400 },
    { serviceId: 'cleanup-transactions-basic' },
    { serviceId: 'sales-tax-quarterly' },
    { serviceId: 'software-qbo-plus' },
  ],
  FULL_INPUTS,
)

const party = {
  company: 'Acme Books LLC',
  contactName: 'Pat Doe',
  email: 'pat@acme.test',
  addressLine1: '12 Main St',
  city: 'Nashville',
  state: 'TN',
  postalCode: '37201',
}
const firmSettings = { name: 'PB&J Strategic Accounting', email: 'hello@pbjsa.com', phone: '615-555-0100' }

const valuesFor = (over = {}) =>
  engagementValues({
    engagement: { party, figures: full, retainerAmount: full.totals.monthly },
    firmSettings,
    now: NOW,
    senderName: 'Brittany Patrice',
    ...over,
  })

describe('placeholder scopes', () => {
  it('every Letters placeholder is scope both; the engagement ones are scope engagement', () => {
    expect(letterPlaceholders.every((entry) => entry.scope === 'both')).toBe(true)
    expect(engagementPlaceholders.every((entry) => entry.scope === 'engagement')).toBe(true)
    expect(ENGAGEMENT_PLACEHOLDERS).toBe(engagementPlaceholders)
    const letterKeys = new Set(letterPlaceholders.map((entry) => entry.key))
    expect(engagementPlaceholders.filter((entry) => letterKeys.has(entry.key))).toEqual([])
  })

  it('lists the planned engagement keys', () => {
    expect(ENGAGEMENT_PLACEHOLDERS.map((entry) => entry.key).sort()).toEqual(
      [
        'one_time_fee',
        'cleanup_fee',
        'cleanup_months',
        'cleanup_months_phrase',
        'fee_sentence',
        'software_fee',
        'software_sentence',
        'services_monthly',
        'services_annual',
        'sales_tax_states',
        'payment_terms',
        'retainer_amount',
        'retainer_sentence',
        'start_month',
        'hours_bookkeeper',
        'hours_accountant',
        'hours_cfo',
      ].sort(),
    )
    expect(ENGAGEMENT_PLACEHOLDERS.filter((entry) => entry.required).map((entry) => entry.key)).toEqual([
      'services_monthly',
      'services_annual',
      'cleanup_fee',
      'sales_tax_states',
      'start_month',
    ])
    for (const entry of ENGAGEMENT_PLACEHOLDERS) {
      expect(entry.label, entry.key).toBeTruthy()
      expect(entry.description, entry.key).toBeTruthy()
      expect(typeof entry.required).toBe('boolean')
      expect(Object.isFrozen(entry)).toBe(true)
    }
  })

  it("placeholdersFor('letter') is the Letters list; 'engagement' adds the engagement keys", () => {
    expect(placeholdersFor('letter')).toBe(letterPlaceholders)
    expect(placeholdersFor('anything')).toBe(letterPlaceholders)
    expect(placeholdersFor('engagement').map((entry) => entry.key)).toEqual([
      ...letterPlaceholders.map((entry) => entry.key),
      ...engagementPlaceholders.map((entry) => entry.key),
    ])
    expect(Object.isFrozen(placeholdersFor('engagement'))).toBe(true)
  })

  it('an engagement key stays unknown to Letters, and fills for an engagement', () => {
    const text = 'Clean-up {{cleanup_fee}} for {{client_name}}'
    expect(fillTemplate(text, { cleanup_fee: '$9.00', client_name: 'Acme' })).toEqual({
      text: 'Clean-up {{cleanup_fee}} for Acme',
      missing: [],
      unknown: ['cleanup_fee'],
      retired: [],
    })
    expect(fillTemplate(text, { cleanup_fee: '$9.00', client_name: 'Acme' }, placeholdersFor('engagement'))).toEqual({
      text: 'Clean-up $9.00 for Acme',
      missing: [],
      unknown: [],
      retired: [],
    })
    expect(fillTemplate(text, {}, placeholdersFor('engagement')).missing).toEqual(['cleanup_fee', 'client_name'])
    expect(fillTemplate('{{retainer_sentence}}', {}, placeholdersFor('engagement'))).toEqual({
      text: '',
      missing: [],
      unknown: [],
      retired: [],
    })
    expect(fillTemplate('{{hourly_rate}}', {}, placeholdersFor('engagement')).retired).toEqual(['hourly_rate'])
    expect(templateWarnings({ letterBody: text })).toEqual({ unknown: ['cleanup_fee'], retired: [] })
    expect(templateWarnings({ letterBody: text }, placeholdersFor('engagement'))).toEqual({ unknown: [], retired: [] })
  })

  it('every seed section names only known engagement placeholders', () => {
    for (const section of DEFAULT_ENGAGEMENT_SECTIONS) {
      expect(templateWarnings({ letterBody: section.body }, placeholdersFor('engagement')), section.key).toEqual({
        unknown: [],
        retired: [],
      })
    }
  })
})

describe('engagementValues', () => {
  it('fills every key from the party, the snapshot and the engagement', () => {
    expect(valuesFor()).toEqual({
      client_name: 'Acme Books LLC',
      contact_first_name: 'Pat',
      contact_name: 'Pat Doe',
      fee: '$756.67 per month',
      monthly_fee: '$756.67',
      annual_fee: '$1,200.00',
      client_address: '12 Main St\nNashville, TN 37201',
      year: '2026',
      next_year: '2027',
      today: 'October 8, 2026',
      firm_name: 'PB&J Strategic Accounting',
      firm_email: 'hello@pbjsa.com',
      firm_phone: '615-555-0100',
      sender_name: 'Brittany Patrice',
      fee_sentence: 'Our recurring fee is $756.67 per month.',
      services_monthly: '- Reconciliations\n- Payroll\n- File sales tax quarterly\n- Client call',
      services_annual: '- Payroll setup: $400.00, one time\n- Business return: $1,200.00 per year',
      one_time_fee: '$400.00',
      cleanup_fee: '$2,700.00',
      cleanup_months: '6 months',
      cleanup_months_phrase: ' for the past 6 months',
      software_fee: '$98.00',
      software_sentence:
        'Software subscriptions we manage for you are billed at our cost, currently $98.00 per month, in addition to the fees above.',
      sales_tax_states: '2 states',
      payment_terms: 'Due on receipt',
      retainer_amount: '$756.67',
      retainer_sentence: 'A retainer of $756.67 is due when you return this letter signed.',
      start_month: 'November 2026',
      hours_bookkeeper: '5.0',
      hours_accountant: '1.0',
      hours_cfo: '2.0',
    })
    expect(Object.keys(valuesFor()).sort()).toEqual(placeholdersFor('engagement').map((entry) => entry.key).sort())
  })

  it('money is the Letters format; zero is blank, never "$0.00"', () => {
    expect(letterMoney(1234.5)).toBe('$1,234.50')
    expect(letterMoney(0)).toBe('')
    const bare = valuesFor({
      engagement: { party, figures: snapshotOf([{ serviceId: 'reconciliations' }], FULL_INPUTS), retainerAmount: 0 },
    })
    expect(bare).toMatchObject({
      annual_fee: '',
      one_time_fee: '',
      cleanup_fee: '',
      software_fee: '',
      software_sentence: '',
      retainer_amount: '',
      retainer_sentence: '',
      services_annual: '',
      cleanup_months: '',
      sales_tax_states: '',
    })
  })

  it('an annual-only proposal: the fee is per year', () => {
    const annual = snapshotOf([{ serviceId: 'business-return', flatAmount: 900 }], {})
    expect(valuesFor({ engagement: { party, figures: annual } })).toMatchObject({
      fee: '$900.00 per year',
      monthly_fee: '',
      annual_fee: '$900.00',
      services_monthly: '',
      hours_bookkeeper: '',
    })
  })

  it('counts come from what the lines were priced with, else the inputs', () => {
    const typed = snapshotOf([{ serviceId: 'cleanup-reconciliations', quantity: 1 }], { balanceSheetAccounts: 4 })
    expect(valuesFor({ engagement: { party, figures: typed } }).cleanup_months).toBe('1 month')
    const oneState = snapshotOf([{ serviceId: 'sales-tax-monthly' }], { salesTaxReviewAmount: 20, states: 1 })
    expect(valuesFor({ engagement: { party, figures: oneState } }).sales_tax_states).toBe('1 state')
    const noMonths = snapshotOf([{ serviceId: 'cleanup-chart-of-accounts' }], { chartAccountsToClean: 10 })
    expect(valuesFor({ engagement: { party, figures: noMonths } }).cleanup_months).toBe('')
    expect(valuesFor({ engagement: { party, figures: noMonths }, inputs: { cleanupMonths: 3 } }).cleanup_months).toBe(
      '3 months',
    )
    expect(valuesFor({ engagement: { party, figures: { ...noMonths, inputs: { cleanupMonths: 4 } } } }).cleanup_months).toBe(
      '4 months',
    )
  })

  it('the start month: the engagement own, else the month after today (across a year end)', () => {
    expect(valuesFor({ engagement: { party, figures: full, startMonth: '2027-01' } }).start_month).toBe('January 2027')
    expect(valuesFor({ engagement: { party, figures: full, startMonth: '2027-03-01' } }).start_month).toBe('March 2027')
    expect(valuesFor({ engagement: { party, figures: full, startMonth: '2027-13' } }).start_month).toBe('November 2026')
    expect(valuesFor({ now: new Date('2026-12-10T16:00:00Z') }).start_month).toBe('January 2027')
  })

  it('payment terms: given, else the figures, the client, the firm default; always worded', () => {
    expect(valuesFor({ paymentTerms: 'Net 45' }).payment_terms).toBe('Net 45')
    expect(valuesFor({ paymentTerms: 'Net 15' }).payment_terms).toBe('Due on receipt')
    expect(valuesFor({ engagement: { party, figures: { ...full, paymentTerms: 'Net 60' } } }).payment_terms).toBe('Net 60')
    expect(
      valuesFor({ firmSettings: { ...firmSettings, clientDefaults: { paymentTerms: 'Net 30' } } }).payment_terms,
    ).toBe('Net 30')
  })

  it('an older snapshot with no hours reads the hours as blank, and never throws', () => {
    const old = {
      lines: full.lines.map(({ role: _role, hours: _hours, ...line }) => line),
      totals: full.totals,
    }
    expect(valuesFor({ engagement: { party, figures: old } })).toMatchObject({
      hours_bookkeeper: '',
      hours_accountant: '',
      hours_cfo: '',
      fee: '$756.67 per month',
    })
    expect(() => engagementValues()).not.toThrow()
    expect(() => engagementValues({ engagement: { figures: { lines: 'x', totals: 7 } } })).not.toThrow()
    expect(engagementValues({ now: NOW }).start_month).toBe('November 2026')
  })

  it('name and contact: the party first, then the linked client', () => {
    const client = {
      name: 'Acme Holdings',
      billingMode: 'subscription',
      monthlyRate: 500,
      contactIds: ['c-lee'],
      addressLine1: '9 Side St',
      city: 'Memphis',
      state: 'TN',
      postalCode: '38103',
    }
    const contacts = [{ id: 'c-lee', name: 'Lee Roe' }]
    const fromClient = engagementValues({ engagement: { party: {}, figures: full }, client, contacts, now: NOW })
    expect(fromClient).toMatchObject({
      client_name: 'Acme Holdings',
      contact_name: 'Lee Roe',
      contact_first_name: 'Lee',
      client_address: '9 Side St\nMemphis, TN 38103',
    })
    const soleOwner = engagementValues({ party: { contactName: 'Sam Lee' }, snapshot: full, now: NOW })
    expect(soleOwner).toMatchObject({ client_name: 'Sam Lee', contact_name: 'Sam Lee', contact_first_name: 'Sam' })
  })

  it("with no snapshot (an amendment), the fee is the client's own, as in Letters", () => {
    const client = { name: 'Acme', billingMode: 'subscription', monthlyRate: 500, contact: 'Pat Doe' }
    expect(engagementValues({ client, snapshot: null, now: NOW })).toMatchObject({
      fee: '$500.00 per month',
      monthly_fee: '$500.00',
      services_monthly: '',
    })
  })

  it('the seed letter fills completely for a full proposal and for a one-line one', () => {
    for (const figures of [full, snapshotOf([{ serviceId: 'reconciliations' }], { balanceSheetAccounts: 12 })]) {
      const assembled = assembleEngagement({ sections: DEFAULT_ENGAGEMENT_SECTIONS, snapshot: figures, kind: 'original' })
      const values = valuesFor({ engagement: { party, figures, retainerAmount: null } })
      for (const text of [assembled.subject, assembled.emailBody, assembled.letterBody]) {
        const filled = fillTemplate(text, values, placeholdersFor('engagement'))
        expect(filled.missing).toEqual([])
        expect(filled.unknown).toEqual([])
        expect(filled.text).not.toMatch(/\{\{/)
      }
    }
  })

  it('the hash is the Letters hash', () => {
    const boxes = { subject: 's', emailBody: 'e', letterBody: 'l' }
    expect(engagementTemplateHash(boxes)).toBe(letterTemplateHash(boxes))
    expect(engagementTemplateHash(boxes)).toMatch(/^[0-9a-f]{64}$/)
  })
})

/** Assemble the seed letter for these figures and fill all three boxes. */
function filledSeedLetter(figures, over = {}) {
  const assembled = assembleEngagement({ sections: DEFAULT_ENGAGEMENT_SECTIONS, snapshot: figures, kind: 'original' })
  const values = valuesFor({ engagement: { party, figures, retainerAmount: null }, ...over })
  const parts = [assembled.subject, assembled.emailBody, assembled.letterBody].map((text) =>
    fillTemplate(text, values, placeholdersFor('engagement')),
  )
  return {
    sectionKeys: assembled.sectionKeys,
    // A blank optional sentence leaves extra blank lines; the email and the PDF drop them.
    letter: parts[2].text.replace(/\n{3,}/g, '\n\n'),
    missing: [...new Set(parts.flatMap((part) => part.missing))],
    unknown: [...new Set(parts.flatMap((part) => part.unknown))],
  }
}

describe('review round 1 (2026-10-11)', () => {
  it('M1: a clean-up-only engagement sends unedited: no recurring-fee sentence, nothing missing', () => {
    const cleanupOnly = snapshotOf([{ serviceId: 'cleanup-transactions-basic' }], { transactions: 100, cleanupMonths: 3 })
    expect(valuesFor({ engagement: { party, figures: cleanupOnly } })).toMatchObject({ fee: '', fee_sentence: '' })
    const result = filledSeedLetter(cleanupOnly)
    expect(result.sectionKeys).toContain('cleanup')
    expect(result).toMatchObject({ missing: [], unknown: [] })
    expect(result.letter).not.toContain('Our recurring fee')
    expect(result.letter).toContain('**Fees and payment**\n\nFees for any annual, one-time, or clean-up work')
    // {{fee}} itself is still there for her own use.
    expect(placeholdersFor('engagement').find((entry) => entry.key === 'fee').required).toBe(true)
  })

  it('M1: a one-time-only engagement sends unedited too', () => {
    const oneTime = snapshotOf([{ serviceId: 'payroll-setup', flatAmount: 400 }], {})
    const result = filledSeedLetter(oneTime)
    expect(result).toMatchObject({ missing: [], unknown: [] })
    expect(result.letter).toContain('- Payroll setup: $400.00, one time')
  })

  it('M2: clean-up months are optional; a chart-of-accounts-only clean-up reads well without them', () => {
    const chartOnly = snapshotOf([{ serviceId: 'cleanup-chart-of-accounts' }], { chartAccountsToClean: 10 })
    expect(valuesFor({ engagement: { party, figures: chartOnly } })).toMatchObject({
      cleanup_months: '',
      cleanup_months_phrase: '',
    })
    const result = filledSeedLetter(chartOnly)
    expect(result).toMatchObject({ missing: [], unknown: [] })
    expect(result.letter).toContain('We will bring your books up to date: we will categorize')
    const zero = snapshotOf([{ serviceId: 'cleanup-reconciliations', quantity: 0, override: 300 }], { balanceSheetAccounts: 4 })
    expect(valuesFor({ engagement: { party, figures: zero } }).cleanup_months_phrase).toBe('')
    const one = snapshotOf([{ serviceId: 'cleanup-reconciliations', quantity: 1 }], { balanceSheetAccounts: 4 })
    expect(valuesFor({ engagement: { party, figures: one } }).cleanup_months_phrase).toBe(' for the past month')
    expect(filledSeedLetter(full).letter).toContain('We will bring your books up to date for the past 6 months: we will')
  })

  it('M2: the proposal inputs on the figures are still the fallback', () => {
    const chartOnly = snapshotOf([{ serviceId: 'cleanup-chart-of-accounts' }], { chartAccountsToClean: 10 })
    expect(
      valuesFor({ engagement: { party, figures: { ...chartOnly, inputs: { cleanupMonths: 2 } } } }).cleanup_months_phrase,
    ).toBe(' for the past 2 months')
  })

  it('M4: unpriced, $0, no-count and retired lines stay out of the lists and are reported', () => {
    const mixed = snapshotOf(
      [
        { serviceId: 'reconciliations' },
        { serviceId: 'kpi-reports' }, // no totalAccounts: $0.00
        { serviceId: 'gone-row' }, // retired
        { serviceId: 'budget' }, // no count typed
        { serviceId: 'business-return' }, // flat, nothing typed: $0.00
        { serviceId: 'individual-return', flatAmount: 350 },
      ],
      { balanceSheetAccounts: 20 },
    )
    const values = valuesFor({ engagement: { party, figures: mixed } })
    expect(values.services_monthly).toBe('- Reconciliations')
    expect(values.services_annual).toBe('- Individual return: $350.00 per year')
    // Snapshot (catalog) order; a selection the catalog no longer names is listed too.
    expect(skippedEngagementLines(mixed)).toEqual([
      { name: 'gone-row', group: null, serviceId: 'gone-row', reason: 'retired from the catalog' },
      { name: 'KPI reports', group: 'Additional reports', serviceId: 'kpi-reports', reason: 'priced at $0.00' },
      { name: 'Budget', group: 'Annual and one-time', serviceId: 'budget', reason: 'no count typed' },
      { name: 'Business return', group: 'Annual and one-time', serviceId: 'business-return', reason: 'priced at $0.00' },
    ])
  })

  it('M4: a retired line in a listed group, an unpriced rate, and a hand-set price', () => {
    const figures = {
      totals: { monthly: 300 },
      lines: [
        { serviceId: 'old', group: 'Monthly', name: 'Old service', amount: 0, flag: 'retired' },
        { serviceId: 'payroll', group: 'Payroll', name: 'Payroll', amount: 0, flag: 'no-rate' },
        { serviceId: 'ar-follow-up', group: 'AR', name: 'Follow up with clients', amount: 300, computedAmount: 0, flag: 'no-rate' },
        { serviceId: 'x', group: 'Reports', name: 'Junk input', amount: 0, flag: 'invalid-input' },
        { serviceId: 'y', group: 'AP', name: 'Missing input', amount: 0, flag: 'unknown-input' },
        { serviceId: 'software-bill-pay-basic', group: 'Software', name: 'QB Bill Pay Basic', amount: 0, flag: null },
      ],
    }
    expect(valuesFor({ engagement: { party, figures } }).services_monthly).toBe('- Follow up with clients')
    expect(skippedEngagementLines(figures).map((entry) => [entry.name, entry.reason])).toEqual([
      ['Old service', 'retired from the catalog'],
      ['Payroll', 'not yet priced'],
      ['Junk input', 'a figure on it is not a number'],
      ['Missing input', 'its count is missing from the catalog'],
    ])
    expect(skippedEngagementLines(null)).toEqual([])
    expect(skippedEngagementLines({ lines: [null, 7] })).toEqual([])
  })

  it('M4: a section whose every line was left out reports its list as missing, so Send refuses', () => {
    const unpriced = snapshotOf([{ serviceId: 'kpi-reports' }], {})
    expect(filledSeedLetter(unpriced).missing).toEqual(expect.arrayContaining(['services_monthly']))
  })

  it('L2: counts come from line.count, never the formula text; an old snapshot falls back to inputs', () => {
    const figures = {
      totals: { cleanup: 900 },
      lines: [{ group: 'Clean-up', name: 'Reconciliations', amount: 900, formula: '20 x 0.25 x $75/hr x 9 clean-up months', count: 3 }],
    }
    expect(valuesFor({ engagement: { party, figures } }).cleanup_months).toBe('3 months')
    const old = { ...figures, lines: [{ ...figures.lines[0], count: undefined }] }
    expect(valuesFor({ engagement: { party, figures: old } }).cleanup_months).toBe('')
    expect(valuesFor({ engagement: { party, figures: { ...old, inputs: { cleanupMonths: 5 } } } }).cleanup_months).toBe(
      '5 months',
    )
  })

  it('L3: a list that is not frozen is read afresh on every fill', () => {
    const list = [{ key: 'client_name', required: true }]
    expect(fillTemplate('{{extra}}', {}, list).unknown).toEqual(['extra'])
    list.push({ key: 'extra', required: false })
    expect(fillTemplate('{{extra}}', { extra: 'now known' }, list)).toMatchObject({ text: 'now known', unknown: [] })
  })

  it('L5: a blank sender name leaves the firm line and no dangling comma', () => {
    const { letter } = filledSeedLetter(full, { senderName: '' })
    expect(letter).toContain('Sincerely,\n\nPB&J Strategic Accounting')
    expect(letter).not.toContain(', PB&J Strategic Accounting')
    expect(letter).toContain('Name: Pat Doe\nTitle: ______________\nfor Acme Books LLC\nDate: ______________')
  })
})
