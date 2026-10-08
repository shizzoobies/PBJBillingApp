import { afterEach, describe, expect, it, vi } from 'vitest'

import { sendInvoiceEmail } from './notify.js'
import { buildQuestionnaireEmail } from './proposal-questionnaire-email.js'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const LINK = 'https://app.pbjsa.com/questionnaire/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'

describe('buildQuestionnaireEmail', () => {
  const firm = { name: 'PB&J Strategic Accounting', city: 'Nashville', state: 'TN' }

  it('carries her welcome text and the link, in both versions', () => {
    const email = buildQuestionnaireEmail({
      link: LINK,
      firmSettings: firm,
      expiresAt: '2026-11-03T15:00:00.000Z',
    })
    expect(email.subject).toBe('A few questions from PB&J Strategic Accounting')
    expect(email.text).toContain('keep the perfect books')
    expect(email.text).toContain(LINK)
    expect(email.html).toContain(`href="${LINK}"`)
    expect(email.text).toContain('The link works until November 3, 2026.')
    expect(email.text).toContain('Nashville, TN')
  })

  it('keeps the link out of the subject', () => {
    expect(buildQuestionnaireEmail({ link: LINK }).subject).not.toContain('questionnaire/')
  })

  it('tells them what not to send', () => {
    expect(buildQuestionnaireEmail({ link: LINK }).text).toMatch(
      /do not send passwords, EINs, Social Security numbers or bank account numbers/i,
    )
  })

  it('greets by name when it has one, and escapes it', () => {
    const email = buildQuestionnaireEmail({ link: LINK, contactName: 'Pat <Doe>' })
    expect(email.text).toContain('Hi Pat <Doe>,')
    expect(email.html).toContain('Hi Pat &lt;Doe&gt;,')
    expect(email.html).not.toContain('<Doe>')
    expect(buildQuestionnaireEmail({ link: LINK }).text.startsWith('Hello,')).toBe(true)
  })

  it('escapes a link that tries to break out of the attribute', () => {
    const email = buildQuestionnaireEmail({ link: 'https://x.test/"><script>alert(1)</script>' })
    expect(email.html).not.toContain('<script>')
  })

  it('says nothing about expiry when it has no date', () => {
    expect(buildQuestionnaireEmail({ link: LINK }).text).not.toContain('The link works until')
  })
})

describe('sendInvoiceEmail for a questionnaire', () => {
  it('tags the questionnaire, not an invoice or a proposal, so the webhook can find it', async () => {
    const calls = []
    vi.stubEnv('RESEND_API_KEY', 're_test_key')
    vi.stubEnv('INVOICE_EMAIL_FROM', 'billing@pbjsa.com')
    vi.stubGlobal('fetch', async (url, init) => {
      calls.push(JSON.parse(init.body))
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 're_9' }) }
    })
    const result = await sendInvoiceEmail({
      to: ['pat@acme.test'],
      subject: 's',
      html: '<p>hi</p>',
      questionnaireId: 'pq-1a2b3c4d',
      kind: 'questionnaire',
    })
    expect(result).toEqual({ ok: true, error: null, providerId: 're_9', status: 200 })
    expect(calls[0].tags).toEqual([
      { name: 'questionnaire_id', value: 'pq-1a2b3c4d' },
      { name: 'kind', value: 'questionnaire' },
    ])
  })
})
