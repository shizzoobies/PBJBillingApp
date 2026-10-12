import { describe, expect, it } from 'vitest'

import { assembleEngagement } from './engagement-assemble.js'
import { buildEngagementDocuments } from './engagement-documents.js'
import { DEFAULT_ENGAGEMENT_SECTIONS } from './engagement-sections.js'
import { engagementValues } from './engagement-values.js'
import { defaultProposalPricing, priceProposal } from './proposal-pricing.js'

/**
 * An engagement letter's two documents (docs/plans/engagements-2026-10.md 2A): the
 * cover email and the PDF, built like the Letters ones but filled with the
 * engagement values and addressed to the party.
 */

const NOW = new Date('2026-10-08T16:00:00Z')
const catalog = defaultProposalPricing()
const priced = priceProposal({
  catalog,
  rates: catalog.rates,
  inputs: { balanceSheetAccounts: 20, employees: 10 },
  selections: [{ serviceId: 'reconciliations' }, { serviceId: 'payroll' }],
})
const figures = { ...priced, paymentTerms: '' }
const party = {
  company: 'Acme <Books> & Co',
  contactName: 'Pat Doe',
  email: 'pat@acme.test',
  addressLine1: '12 Main St',
  city: 'Nashville',
  state: 'TN',
  postalCode: '37201',
}
const firmSettings = { name: 'PB&J Strategic Accounting', email: 'hello@pbjsa.com', phone: '615-555-0100' }
const assembled = assembleEngagement({ sections: DEFAULT_ENGAGEMENT_SECTIONS, snapshot: figures, kind: 'original' })
const engagement = { kind: 'original', party, figures, retainerAmount: 490, ...assembled }
const values = engagementValues({ engagement, firmSettings, now: NOW, senderName: 'Brittany Patrice' })

const fakePdf = (seen) => async (args) => {
  seen.push(args)
  return Buffer.from('%PDF-fake')
}
const build = (over = {}) => {
  const seen = []
  return buildEngagementDocuments({ engagement, values, firmSettings, buildPdf: fakePdf(seen), ...over }).then(
    (result) => ({ ...result, seen }),
  )
}

function pdfText(buffer) {
  const raw = buffer.toString('latin1')
  const runs = []
  for (const match of raw.matchAll(/\[([^\]]*)\]\s*TJ/g)) runs.push(match[1])
  return runs
    .map((run) =>
      [...run.matchAll(/<([0-9A-Fa-f]*)>/g)]
        .map((hex) => Buffer.from(hex[1], 'hex').toString('latin1'))
        .join(''),
    )
    .join('\n')
}

describe('buildEngagementDocuments', () => {
  it('fills the subject and the email from the engagement values', async () => {
    const { email, fill } = await build()
    expect(email.subject).toBe('Engagement letter - Acme <Books> & Co')
    expect(email.text.startsWith('Hi Pat,\n\nThank you for choosing PB&J Strategic Accounting.')).toBe(true)
    expect(email.text).toContain('Thank you,\nBrittany Patrice')
    expect(email.text).toContain('hello@pbjsa.com')
    expect(email.text).not.toContain('{{')
    expect(fill).toEqual({ missing: [], unknown: [], retired: [] })
  })

  it('escapes the email HTML and renders **bold** as <strong>, the plain text without markers', async () => {
    const { email } = await build({
      engagement: { ...engagement, emailBody: 'Hi **{{contact_first_name}}**,\n\nFor <b>{{client_name}}</b>' },
    })
    expect(email.html).toContain('Hi <strong>Pat</strong>,')
    expect(email.html).toContain('For &lt;b&gt;Acme &lt;Books&gt; &amp; Co&lt;/b&gt;')
    expect(email.html).not.toContain('<b>')
    expect(email.text).toContain('Hi Pat,')
    expect(email.text).not.toContain('**')
  })

  it('hands the renderer the filled letter, addressed to the party, dated today, titled with the subject', async () => {
    const { seen, pdfFilename, pdf } = await build()
    expect(seen).toHaveLength(1)
    const [args] = seen
    expect(args.client).toEqual({
      name: 'Acme <Books> & Co',
      addressLine1: '12 Main St',
      addressLine2: '',
      city: 'Nashville',
      state: 'TN',
      postalCode: '37201',
    })
    expect(args.dateLabel).toBe('October 8, 2026')
    expect(args.title).toBe('Engagement letter - Acme <Books> & Co')
    expect(args.firmSettings).toBe(firmSettings)
    expect(args.bodyText.startsWith('Dear Pat Doe,')).toBe(true)
    expect(args.bodyText).toContain('**Monthly services**\n\nEach month we will provide')
    expect(args.bodyText).toContain('- Reconciliations\n- Payroll')
    expect(args.bodyText).toContain('The fee for this monthly work is $490.00 per month.')
    expect(args.bodyText).toContain('A retainer of $490.00 is due when you return this letter signed.')
    expect(args.bodyText).toContain('Payment terms: Due on receipt.')
    expect(args.bodyText).toContain('Name: Pat Doe')
    expect(args.bodyText).not.toContain('{{')
    expect(pdf.toString('latin1')).toBe('%PDF-fake')
    expect(pdfFilename).toBe('Engagement-Letter-Acme-Books-Co-2026.pdf')
  })

  it('falls back to the linked client for the address, and names a prospect with no company by the contact', async () => {
    const client = { name: 'Acme Holdings', addressLine1: '9 Side St', city: 'Memphis', state: 'TN', postalCode: '38103' }
    const bare = { ...engagement, party: { contactName: 'Sam Lee' } }
    const { seen, pdfFilename } = await build({
      engagement: bare,
      values: engagementValues({ engagement: bare, now: NOW }),
      client,
    })
    expect(seen[0].client).toMatchObject({ name: 'Sam Lee', addressLine1: '9 Side St', city: 'Memphis' })
    expect(pdfFilename).toBe('Engagement-Letter-Sam-Lee-2026.pdf')
  })

  it('reports missing and unknown placeholders across the three boxes, and keeps a typo visible', async () => {
    const { fill, email, seen } = await build({
      engagement: {
        ...engagement,
        subject: '{{clientname}} letter',
        emailBody: 'Fee {{cleanup_fee}}',
        letterBody: '{{hourly_rate}} and {{clientname}}',
      },
    })
    expect(fill).toEqual({ missing: ['cleanup_fee'], unknown: ['clientname'], retired: ['hourly_rate'] })
    expect(email.subject).toBe('{{clientname}} letter')
    expect(seen[0].bodyText).toBe('{{hourly_rate}} and {{clientname}}')
  })

  it('a blank subject falls back to the firm, and a bolded one goes out plain', async () => {
    expect((await build({ engagement: { ...engagement, subject: '  ' } })).email.subject).toBe(
      'Engagement letter from PB&J Strategic Accounting',
    )
    expect((await build({ engagement: { ...engagement, subject: 'A **bold**\nsubject' } })).email.subject).toBe(
      'A bold subject',
    )
  })

  it('returns pdfError, not a throw, when the renderer fails', async () => {
    const result = await buildEngagementDocuments({
      engagement,
      values,
      firmSettings,
      buildPdf: () => {
        throw 'plain string'
      },
    })
    expect(result.pdf).toBeNull()
    expect(result.pdfError).toBeInstanceOf(Error)
    expect(result.pdfError.message).toBe('plain string')
    expect(result.email.subject).toBe('Engagement letter - Acme <Books> & Co')
  })

  it('writes the filled letter onto the real PDF', async () => {
    const { pdf, pdfError } = await buildEngagementDocuments({
      engagement,
      values,
      firmSettings,
      buildPdf: (args) => import('./letter-pdf.js').then((mod) => mod.buildLetterPdf({ ...args, compress: false })),
    })
    expect(pdfError).toBeNull()
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    const text = pdfText(pdf)
    expect(text).toContain('Dear Pat Doe,')
    expect(text).toContain('October 8, 2026')
    expect(text).toContain('Agreed and accepted:')
    expect(text).not.toContain('{{')
  })

  it('never throws on an empty engagement', async () => {
    const result = await buildEngagementDocuments({ engagement: null, values: null, buildPdf: fakePdf([]) })
    expect(result.email.subject).toBe('Engagement letter from PB&J Strategic Accounting')
    expect(result.fill).toEqual({ missing: [], unknown: [], retired: [] })
    expect(result.pdfFilename).toBe('Engagement-Letter-client.pdf')
  })
})
