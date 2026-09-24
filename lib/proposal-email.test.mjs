import { afterEach, describe, expect, it, vi } from 'vitest'

import { sendInvoiceEmail } from './notify.js'
import { buildProposalEmail } from './proposal-email.js'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('buildProposalEmail', () => {
  const proposal = {
    prospect: { company: 'Acme Books', contactName: 'Pat <Doe>' },
    letter: { subject: 'Your bookkeeping proposal', text: '...' },
  }

  it('uses the letter subject, greets the contact and escapes the HTML', () => {
    const email = buildProposalEmail({
      proposal,
      firmSettings: { name: 'PB&J Strategic Accounting', city: 'Nashville', state: 'TN' },
    })
    expect(email.subject).toBe('Your bookkeeping proposal')
    expect(email.text).toContain('Hi Pat <Doe>,')
    expect(email.text).toContain('Nashville, TN')
    expect(email.html).toContain('Hi Pat &lt;Doe&gt;,')
    expect(email.html).not.toContain('<Doe>')
  })

  it('falls back to a subject naming the firm', () => {
    expect(buildProposalEmail({ proposal: { prospect: {} } }).subject).toBe(
      'Your proposal from PB&J Strategic Accounting',
    )
  })
})

describe('sendInvoiceEmail for a proposal', () => {
  it('tags the proposal, not an invoice, so the webhook can find it', async () => {
    const calls = []
    vi.stubEnv('RESEND_API_KEY', 're_test_key')
    vi.stubEnv('INVOICE_EMAIL_FROM', 'billing@pbjsa.com')
    vi.stubGlobal('fetch', async (url, init) => {
      calls.push(JSON.parse(init.body))
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 're_1' }) }
    })
    const result = await sendInvoiceEmail({
      to: ['pat@acme.test'],
      subject: 's',
      html: '<p>hi</p>',
      proposalId: 'prop-1a2b3c4d',
      kind: 'proposal',
    })
    expect(result).toEqual({ ok: true, error: null, providerId: 're_1' })
    expect(calls[0].tags).toEqual([
      { name: 'proposal_id', value: 'prop-1a2b3c4d' },
      { name: 'kind', value: 'proposal' },
    ])
  })
})
