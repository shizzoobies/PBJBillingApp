import { describe, expect, it } from 'vitest'

import { buildProposalPdf, proposalPdfFilename } from './proposal-pdf.js'

/**
 * The proposal PDF (featreq-311473e2, spec §5.4). Asserts on the REAL bytes,
 * like lib/invoice-pdf.test.mjs: built uncompressed, each drawn line is a `TJ`
 * array of hex runs, reassembled here. ASCII substrings only.
 */
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

const proposal = {
  id: 'prop-1',
  prospect: { company: 'Acme Books', contactName: 'Pat Doe', email: 'pat@acme.test', phone: '' },
  letter: {
    subject: 'Your bookkeeping proposal',
    sections: [
      { heading: 'Opening', body: 'Thank you for meeting with us.' },
      { heading: 'Pricing', body: 'Weekly transactions come to $630.00 a month.' },
    ],
    text: 'Opening\n\nThank you for meeting with us.\n\nPricing\n\nWeekly transactions come to $630.00 a month.',
  },
  pricingSnapshot: {
    lines: [
      { serviceId: 'monthly-weekly-transactions-basic', group: 'Monthly', name: 'Weekly transactions', tier: 'Basic', amount: 630 },
      { serviceId: 'payroll-setup', group: 'Annual and one-time', name: 'Payroll setup', tier: null, amount: 400 },
    ],
    totals: { monthly: 630, annual: 0, oneTime: 400, cleanup: 0 },
  },
}

const firmSettings = {
  name: 'PB&J Strategic Accounting',
  city: 'Nashville',
  state: 'TN',
  email: 'hello@pbjsa.com',
}

describe('buildProposalPdf', () => {
  it('prints the firm, the prospect, the letter and the priced lines', async () => {
    const text = pdfText(
      await buildProposalPdf({
        proposal,
        firmSettings,
        preparedOn: new Date('2026-09-23T12:00:00Z'),
        compress: false,
      }),
    )
    expect(text).toContain('PB&J Strategic Accounting')
    expect(text).toContain('Nashville, TN')
    expect(text).toContain('Proposal')
    expect(text).toContain('September 23, 2026')
    expect(text).toContain('Acme Books')
    expect(text).toContain('Thank you for meeting with us.')
    expect(text).toContain('Weekly transactions (Basic)')
    expect(text).toContain('$630.00')
    expect(text).toContain('ANNUAL AND ONE-TIME')
  })

  it('prints only the totals that are not zero', async () => {
    const text = pdfText(await buildProposalPdf({ proposal, firmSettings, compress: false }))
    expect(text).toContain('Monthly fee')
    expect(text).toContain('One-time fees')
    expect(text).not.toContain('Annual fees')
    expect(text).not.toContain('Clean-up')
  })

  it('renders a proposal with no letter and no lines without throwing', async () => {
    const buffer = await buildProposalPdf({ proposal: { id: 'prop-2', prospect: {} } })
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })
})

describe('buildProposalPdf pricing lines that are not yet priced', () => {
  it('prints "Not yet priced" for a flagged zero-amount line, never $0.00', async () => {
    const withUnpriced = {
      ...proposal,
      pricingSnapshot: {
        lines: [
          { serviceId: 'monthly-weekly-transactions-basic', group: 'Monthly', name: 'Weekly transactions', tier: 'Basic', amount: 600 },
          { serviceId: 'payroll-setup', group: 'Annual and one-time', name: 'Payroll setup', tier: null, amount: 0, flag: 'needs-count' },
        ],
        totals: { monthly: 600, annual: 0, oneTime: 0, cleanup: 0 },
      },
    }
    const text = pdfText(await buildProposalPdf({ proposal: withUnpriced, firmSettings, compress: false }))
    expect(text).toContain('$600.00')
    expect(text.match(/Not yet priced/g)).toHaveLength(1)
    expect(text).not.toContain('$0.00')
  })

  it('prints "Not yet priced" for a no-rate line (a $0 role rate), never $0.00', async () => {
    const withNoRate = {
      ...proposal,
      pricingSnapshot: {
        lines: [
          { serviceId: 'payroll', group: 'Payroll', name: 'Payroll', tier: null, amount: 0, computedAmount: 0, flag: 'no-rate' },
        ],
        totals: { monthly: 0, annual: 0, oneTime: 0, cleanup: 0 },
      },
    }
    const text = pdfText(await buildProposalPdf({ proposal: withNoRate, firmSettings, compress: false }))
    expect(text.match(/Not yet priced/g)).toHaveLength(1)
    expect(text).not.toContain('$0.00')
  })

  it('prints "Not yet priced" for a retired line', async () => {
    const withRetired = {
      ...proposal,
      pricingSnapshot: {
        lines: [
          { serviceId: 'monthly-weekly-transactions-basic', group: 'Monthly', name: 'Weekly transactions', tier: 'Basic', amount: 600 },
          { serviceId: 'old-service', group: 'Annual and one-time', name: 'Old service', tier: null, amount: 0, flag: 'retired' },
        ],
        totals: { monthly: 600, annual: 0, oneTime: 0, cleanup: 0 },
      },
    }
    const text = pdfText(await buildProposalPdf({ proposal: withRetired, firmSettings, compress: false }))
    expect(text).toContain('Not yet priced')
    expect(text).not.toContain('$0.00')
  })
})

describe('the Software section (featreq-a69a3cc0)', () => {
  const withSoftware = {
    ...proposal,
    pricingSnapshot: {
      lines: [
        ...proposal.pricingSnapshot.lines,
        { serviceId: 'software-qbo-plus', group: 'Software', name: 'QBO Plus', tier: null, amount: 98, flag: null },
        { serviceId: 'software-bill-pay-basic', group: 'Software', name: 'QB Bill Pay Basic', tier: null, amount: 0, flag: null },
      ],
      totals: { monthly: 630, annual: 0, oneTime: 400, cleanup: 0, software: 98 },
    },
  }

  it('prints its own heading and a total row, kept apart from the monthly fee', async () => {
    const text = pdfText(await buildProposalPdf({ proposal: withSoftware, firmSettings, compress: false }))
    expect(text).toContain('SOFTWARE (BILLED AT COST)')
    expect(text).toContain('QBO Plus')
    expect(text).toContain('$98.00')
    expect(text).toContain('Software, at cost (monthly)')
    expect(text).toContain('Monthly fee')
    expect(text.indexOf('SOFTWARE (BILLED AT COST)')).toBeGreaterThan(text.indexOf('ANNUAL AND ONE-TIME'))
  })

  it('says "No charge" for a $0 plan, and "Not yet priced" only for the other kinds', async () => {
    const text = pdfText(await buildProposalPdf({ proposal: withSoftware, firmSettings, compress: false }))
    expect(text).toContain('QB Bill Pay Basic')
    expect(text.match(/No charge/g)).toHaveLength(1)
    expect(text).not.toContain('Not yet priced')
    expect(text).not.toContain('$0.00')
  })

  it('prints no software heading or total on a proposal with no software, or on an old snapshot', async () => {
    const text = pdfText(await buildProposalPdf({ proposal, firmSettings, compress: false }))
    expect(text).not.toContain('SOFTWARE')
    expect(text).not.toContain('Software, at cost')
  })
})

describe('proposalPdfFilename', () => {
  it('names the file for the prospect, with nothing path-ish in it', () => {
    expect(proposalPdfFilename(proposal)).toBe('Proposal-Acme-Books.pdf')
    expect(proposalPdfFilename({ prospect: { company: '../../etc' } })).toBe('Proposal-etc.pdf')
    expect(proposalPdfFilename({ id: 'prop-9', prospect: {} })).toBe('Proposal-prop-9.pdf')
  })
})
