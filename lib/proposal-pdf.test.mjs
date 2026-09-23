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

describe('proposalPdfFilename', () => {
  it('names the file for the prospect, with nothing path-ish in it', () => {
    expect(proposalPdfFilename(proposal)).toBe('Proposal-Acme-Books.pdf')
    expect(proposalPdfFilename({ prospect: { company: '../../etc' } })).toBe('Proposal-etc.pdf')
    expect(proposalPdfFilename({ id: 'prop-9', prospect: {} })).toBe('Proposal-prop-9.pdf')
  })
})
