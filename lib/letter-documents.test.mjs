import { describe, expect, it } from 'vitest'

import { buildLetterDocuments } from './letter-documents.js'

/**
 * The engagement letter's two documents (featreq-5e195707), built in one place
 * for the preview and the send. The real PDF renderer runs unless a test swaps
 * it, so the filled letter is read out of real bytes.
 */
const NOW = new Date('2026-10-08T16:00:00Z')

const template = {
  subject: 'Your {{next_year}} 1099s, {{contact_first_name}}',
  emailBody: 'Hi {{contact_first_name}},\n\nThe letter for {{client_name}} is attached.\nOur fee is {{fee}}.\n\nThanks,\n{{sender_name}}',
  letterBody: 'Dear {{contact_name}},\n\nWe will prepare the 1099s for {{client_name}} for {{next_year}} at {{fee}}.',
}
const client = {
  id: 'client-1',
  name: 'Acme <Books> & Co',
  billingMode: 'subscription',
  monthlyRate: 500,
  addressLine1: '12 Main St',
  city: 'Nashville',
  state: 'TN',
  postalCode: '37201',
  contactIds: ['c-pat'],
}
const contacts = [{ id: 'c-pat', name: 'Pat Doe' }]
const firmSettings = { name: 'PB&J Strategic Accounting', email: 'hello@pbjsa.com', phone: '615-555-0100' }

const build = (over = {}) =>
  buildLetterDocuments({
    template,
    client,
    contacts,
    firmSettings,
    now: NOW,
    senderName: 'Brittany',
    ...over,
  })

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

describe('buildLetterDocuments', () => {
  it('fills the subject and the email text for the client', async () => {
    const { email, fill } = await build()
    expect(email.subject).toBe('Your 2027 1099s, Pat')
    expect(email.text).toContain('Hi Pat,')
    expect(email.text).toContain('The letter for Acme <Books> & Co is attached.\nOur fee is $500.00 per month.')
    expect(email.text).toContain('Thanks,\nBrittany')
    expect(email.text).toContain('PB&J Strategic Accounting')
    expect(email.text).toContain('hello@pbjsa.com')
    expect(email.text).not.toContain('{{')
    expect(fill).toEqual({ missing: [], unknown: [], retired: [] })
  })

  it('escapes every filled value in the email HTML and keeps the line breaks', async () => {
    const { email } = await build()
    expect(email.html).toContain('Acme &lt;Books&gt; &amp; Co')
    expect(email.html).not.toContain('<Books>')
    expect(email.html).toContain('is attached.<br>Our fee is $500.00 per month.')
    expect(email.html).toContain('Hi Pat,')
    expect(email.html.match(/<p /g).length).toBeGreaterThanOrEqual(4)
  })

  it('escapes the template text itself, not just the values', async () => {
    const { email } = await build({ template: { subject: 's', emailBody: 'a <script>x</script> "q"', letterBody: 'l' } })
    expect(email.html).toContain('a &lt;script&gt;x&lt;/script&gt; &quot;q&quot;')
    expect(email.html).not.toContain('<script>')
  })

  it('builds the PDF with the filled letter, the date and the client', async () => {
    const { pdf, pdfFilename, pdfError } = await build()
    expect(pdfError).toBeNull()
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(pdfFilename).toBe('Engagement-Letter-Acme-Books-Co-2026.pdf')
  })

  it('hands the renderer the filled body, the date line and the subject as the title', async () => {
    const seen = []
    await build({
      buildPdf: async (args) => {
        seen.push(args)
        return Buffer.from('%PDF-fake')
      },
    })
    expect(seen).toHaveLength(1)
    expect(seen[0].bodyText).toBe(
      'Dear Pat Doe,\n\nWe will prepare the 1099s for Acme <Books> & Co for 2027 at $500.00 per month.',
    )
    expect(seen[0].dateLabel).toBe('October 8, 2026')
    expect(seen[0].title).toBe('Your 2027 1099s, Pat')
    expect(seen[0].client).toBe(client)
    expect(seen[0].firmSettings).toBe(firmSettings)
  })

  it('writes the filled letter onto the real PDF', async () => {
    const { pdf } = await build({
      buildPdf: (args) => import('./letter-pdf.js').then((mod) => mod.buildLetterPdf({ ...args, compress: false })),
    })
    const text = pdfText(pdf)
    expect(text).toContain('Dear Pat Doe,')
    expect(text).toContain('October 8, 2026')
    expect(text).toContain('at $500.00 per month.')
    expect(text).not.toContain('{{')
  })

  it('returns pdfError, not a throw, when the renderer fails', async () => {
    const result = await build({
      buildPdf: async () => {
        throw new Error('boom')
      },
    })
    expect(result.pdf).toBeNull()
    expect(result.pdfError).toBeInstanceOf(Error)
    expect(result.pdfError.message).toBe('boom')
    expect(result.email.subject).toBe('Your 2027 1099s, Pat')
    expect(result.pdfFilename).toBe('Engagement-Letter-Acme-Books-Co-2026.pdf')
  })

  it('wraps a thrown non-Error', async () => {
    const result = await build({
      buildPdf: () => {
        throw 'plain string'
      },
    })
    expect(result.pdfError).toBeInstanceOf(Error)
    expect(result.pdfError.message).toBe('plain string')
  })

  it('reports a retired placeholder from any box, left as typed', async () => {
    const result = await build({
      template: { subject: 'S', emailBody: 'at {{hourly_rate}}', letterBody: '{{client_name}} {{hourly_rate}}' },
    })
    expect(result.fill).toEqual({ missing: [], unknown: [], retired: ['hourly_rate'] })
    expect(result.email.text).toContain('at {{hourly_rate}}')
  })

  it('merges missing and unknown placeholders across the three boxes', async () => {
    const result = await build({
      client: { ...client, monthlyRate: 0 },
      template: {
        subject: 'For {{clientname}} at {{fee}}',
        emailBody: '{{fee}} {{oops}}',
        letterBody: '{{monthly_fee}} {{oops}} {{fee}}',
      },
    })
    expect(result.fill.missing).toEqual(['fee', 'monthly_fee'])
    expect(result.fill.unknown).toEqual(['clientname', 'oops'])
    expect(result.email.subject).toBe('For {{clientname}} at')
  })

  it('collapses a multi-line subject and falls back to one naming the firm when blank', async () => {
    expect((await build({ template: { subject: 'One\r\n  two\n', emailBody: 'e', letterBody: 'l' } })).email.subject).toBe(
      'One two',
    )
    expect((await build({ template: { subject: '  ', emailBody: 'e', letterBody: 'l' } })).email.subject).toBe(
      'A letter from PB&J Strategic Accounting',
    )
    const long = await build({ template: { subject: 'x'.repeat(500), emailBody: 'e', letterBody: 'l' } })
    expect(long.email.subject).toHaveLength(200)
  })

  it('builds from an empty template and no firm without throwing', async () => {
    const result = await buildLetterDocuments({ template: {}, client: {}, now: NOW })
    expect(result.email.subject).toBe('A letter from PB&J Strategic Accounting')
    expect(result.email.text).toContain('PB&J Strategic Accounting')
    expect(result.pdfError).toBeNull()
    expect(result.pdfFilename).toBe('Engagement-Letter-client-2026.pdf')
  })
})
