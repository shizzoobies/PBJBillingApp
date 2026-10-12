import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ENGAGEMENT_JUST_SENT_MS,
  ENGAGEMENT_RATE_LIMIT_WAIT_MS,
  assembleEngagementPreview,
  engagementHash,
  engagementMissingSentence,
  engagementWarnings,
  sendEngagement,
  sentJustNow,
} from './engagement-send.js'
import { ENGAGEMENT_HASH_PARTY_KEYS } from './engagement-hash.js'
import { letterTemplateHash } from './letter-template.js'
import { sendInvoiceEmail } from './notify.js'

/**
 * Previewing and sending ONE engagement letter (docs/plans/engagements-2026-10.md,
 * stage 2B), run for real against a recorded store and a recorded mail sender: who
 * the letter goes to, what stops it and in which order, the one provider call and its
 * 429 retry, and a log failure that must not turn a letter that left into a failure.
 * The PDF builder is a stub (the real one has its own tests); everything else is real.
 */
const NOW = new Date('2026-10-09T16:00:00Z')
const FIRM = { name: 'PB&J Strategic Accounting', email: 'hello@pbjsa.com', clientDefaults: { paymentTerms: '' } }
const PDF = Buffer.from('%PDF-1.4 stub')

function engagement(over = {}) {
  const base = {
    id: 'eng-1',
    kind: 'original',
    status: 'draft',
    proposalId: 'prop-1',
    clientId: null,
    party: {
      company: 'Acme Books',
      contactName: 'Pat Doe',
      title: 'Owner',
      email: 'pat@acme.test',
      phone: '',
      addressLine1: '9 Elm St',
      addressLine2: '',
      city: 'Franklin',
      state: 'TN',
      postalCode: '37064',
    },
    subject: 'Engagement letter - {{client_name}}',
    emailBody: 'Hi {{contact_first_name}},\n\nAttached is our engagement letter.\n\n{{sender_name}}',
    letterBody: 'Dear {{contact_name}},\n\n**Fees**\n\nOur fee is {{fee}}.',
    sectionKeys: ['intro', 'fees'],
    figures: {
      totals: { monthly: 630, annual: 0, oneTime: 0, cleanup: 0, software: 0 },
      lines: [{ serviceId: 'svc-1', group: 'Monthly', name: 'Transactions', amount: 630, cadence: null, role: 'bookkeeper', hours: 8.4 }],
      hoursByRole: { bookkeeper: 8.4, accountant: 0, controller: 0 },
      paymentTerms: 'Due on receipt',
    },
    retainerAmount: 630,
    packageId: null,
    planIds: [],
    emailLog: [],
    ...over,
  }
  return { ...base, templateHash: engagementHash(base) }
}

function makeContext(over = {}) {
  return {
    data: { clients: [], contacts: [] },
    firmSettings: FIRM,
    senderName: 'Brittany',
    now: NOW,
    teamEmails: new Set(['alex@ka-performancefl.com', 'brittany@pbjsa.com']),
    replyTo: 'brittany@pbjsa.com',
    buildPdf: async () => PDF,
    ...over,
  }
}

function makeDeps({ results = [{ ok: true, providerId: 're_1', status: 200 }], configured = true, markThrows = false } = {}) {
  const calls = []
  const store = {
    markEngagementSent: vi.fn(async (id, entry) => {
      calls.push('mark')
      if (markThrows) throw new Error('database went away')
      return { ...engagement(), status: entry.ok ? 'sent' : 'draft', emailLog: [{ kind: 'send', ...entry }] }
    }),
  }
  const queue = [...results]
  const sendMail = vi.fn(async () => {
    calls.push('send')
    return queue.shift() ?? { ok: true, providerId: 're_x', status: 200 }
  })
  const pause = vi.fn(async () => {
    calls.push('pause')
  })
  return { store, sendMail, pause, configured, calls }
}

const send = (row, deps, over = {}) =>
  sendEngagement(makeContext(over.context), row, { templateHash: row.templateHash, to: over.to, userId: 'emp-patrice' }, deps)

describe('the engagement preview', () => {
  it('fills the stored letter for the party and addresses it to the party', async () => {
    const preview = await assembleEngagementPreview(makeContext(), engagement())
    expect(preview.to).toEqual(['pat@acme.test'])
    expect(preview.docs.email.subject).toBe('Engagement letter - Acme Books')
    expect(preview.docs.email.text).toContain('Hi Pat,')
    expect(preview.docs.pdf).toBe(PDF)
    expect(preview.missing).toEqual([])
    expect(preview.unknown).toEqual([])
    expect(preview.refusal).toBeNull()
  })

  it('uses the address typed at Send instead of the party one', async () => {
    const preview = await assembleEngagementPreview(makeContext(), engagement(), { to: 'owner@acme.test' })
    expect(preview.to).toEqual(['owner@acme.test'])
  })

  it('never addresses a team member, in any form, but the reply-to mailbox may stay', async () => {
    for (const email of ['alex@ka-performancefl.com', 'Alex Owner <ALEX@ka-performancefl.com>', 'pat@acme.test, alex@ka-performancefl.com']) {
      const preview = await assembleEngagementPreview(makeContext(), engagement({ party: { ...engagement().party, email } }))
      expect(preview.to, email).toEqual([])
      expect(preview.teamOnly, email).toBe(true)
      expect(preview.refusal).toMatch(/belongs to a team member/)
    }
    const reply = await assembleEngagementPreview(makeContext(), engagement({ party: { ...engagement().party, email: 'brittany@pbjsa.com' } }))
    expect(reply.to).toEqual(['brittany@pbjsa.com'])
  })

  it('says when there is no address at all', async () => {
    const preview = await assembleEngagementPreview(makeContext(), engagement({ party: { ...engagement().party, email: '' } }))
    expect(preview.to).toEqual([])
    expect(preview.teamOnly).toBe(false)
    expect(preview.recipientNote).toMatch(/There is no email address for Acme Books/)
  })

  it('warns on unknown and retired placeholders against the ENGAGEMENT list', async () => {
    const row = engagement({ letterBody: 'Monthly: {{services_monthly}} {{hourly_rate}} {{not_a_key}}' })
    expect(engagementWarnings(row)).toEqual({ unknown: ['not_a_key'], retired: ['hourly_rate'] })
    const preview = await assembleEngagementPreview(makeContext(), row)
    expect(preview.unknown).toEqual(['not_a_key'])
    expect(preview.retired).toEqual(['hourly_rate'])
    expect(preview.refusal).toMatch(/is not a placeholder the app fills in/)
  })

  it('hashes the three boxes AND the retainer and the party (the recipient), not just what Letters hashes', () => {
    const row = engagement()
    expect(engagementHash(row)).toMatch(/^[0-9a-f]{64}$/)
    expect(engagementHash(row)).not.toBe(letterTemplateHash(row))
    for (const change of [
      { subject: 'x' },
      { emailBody: 'x' },
      { letterBody: 'x' },
      { retainerAmount: 500 },
      { retainerAmount: null },
      ...ENGAGEMENT_HASH_PARTY_KEYS.map((key) => ({ party: { ...row.party, [key]: 'changed' } })),
    ]) {
      expect(engagementHash({ ...row, ...change }), JSON.stringify(change)).not.toBe(engagementHash(row))
    }
    // What is not sent is not in the key; "no retainer" reads the same however it is written.
    expect(engagementHash({ ...row, planIds: ['p1'], packageId: 'pkg', status: 'sent', emailLog: [{}] })).toBe(engagementHash(row))
    expect(engagementHash({ ...row, party: { ...row.party, notes: 'x' } })).toBe(engagementHash(row))
    expect(engagementHash({ ...row, retainerAmount: 0 })).toBe(engagementHash({ ...row, retainerAmount: null }))
    expect(engagementHash({ ...row, retainerAmount: '' })).toBe(engagementHash({ ...row, retainerAmount: null }))
    expect(engagementHash({ ...row, party: { ...row.party } })).toBe(engagementHash(row))
    expect(engagementMissingSentence('Acme', [])).toBeNull()
    expect(engagementMissingSentence('Acme', ['cleanup_fee'])).toMatch(/\{\{cleanup_fee\}\} has no value for Acme/)
  })
})

describe('sending one engagement', () => {
  it('sends once to the party, with the PDF and the engagement tag, then logs the send', async () => {
    const deps = makeDeps()
    const result = await send(engagement(), deps)
    expect(result).toMatchObject({ ok: true, error: null, to: ['pat@acme.test'] })
    expect(result.engagement.status).toBe('sent')
    expect(deps.calls).toEqual(['send', 'mark'])
    const [mail] = deps.sendMail.mock.calls[0]
    expect(mail).toMatchObject({
      to: ['pat@acme.test'],
      subject: 'Engagement letter - Acme Books',
      fromName: 'PB&J Strategic Accounting',
      engagementId: 'eng-1',
      kind: 'engagement',
    })
    expect(mail.attachments).toEqual([{ filename: expect.stringMatching(/\.pdf$/), content: PDF }])
    expect(mail).not.toHaveProperty('cc')
    expect(mail).not.toHaveProperty('bcc')
    expect(deps.store.markEngagementSent).toHaveBeenCalledWith('eng-1', {
      to: ['pat@acme.test'],
      providerId: 're_1',
      ok: true,
      error: null,
      subject: 'Engagement letter - Acme Books',
    })
  })

  it('refuses in order, before the provider is called', async () => {
    const cases = [
      [{ templateHash: 'stale' }, 'engagement_changed', 409],
      [{ letterBody: '{{not_a_key}}' }, 'unknown_placeholder', 409],
      [{ letterBody: 'Clean-up: {{cleanup_fee}}' }, 'missing_placeholder', 409],
      [{ emailBody: '   ' }, 'engagement_empty', 409],
      // A blank email body (an inactive email section) or a blank letter is refused alike.
      [{ emailBody: '' }, 'engagement_empty', 409],
      [{ letterBody: ' \n ' }, 'engagement_empty', 409],
      [{ subject: '' }, 'engagement_empty', 409],
      [{ status: 'signed' }, 'engagement_refused', 409],
      [{ status: 'void' }, 'engagement_refused', 409],
      [{ party: { ...engagement().party, email: 'alex@ka-performancefl.com' } }, 'team_address', 409],
      [{ party: { ...engagement().party, email: '' } }, 'no_recipient', 409],
    ]
    for (const [over, code, status] of cases) {
      const deps = makeDeps()
      const row = { ...engagement(over) }
      if (over.templateHash) row.templateHash = over.templateHash
      const result = await sendEngagement(makeContext(), row, { templateHash: over.templateHash ?? row.templateHash }, deps)
      expect(result.refused, code).toMatchObject({ status, error: code })
      expect(result.refused.message, code).toBeTruthy()
      expect(deps.sendMail, code).not.toHaveBeenCalled()
      expect(deps.store.markEngagementSent, code).not.toHaveBeenCalled()
    }
  })

  it('a hash check comes first: a stale page is refused even when the letter is otherwise unsendable', async () => {
    const deps = makeDeps()
    const row = engagement({ status: 'void', letterBody: '{{not_a_key}}' })
    const result = await sendEngagement(makeContext(), row, { templateHash: 'stale' }, deps)
    expect(result.refused.error).toBe('engagement_changed')
  })

  it('refuses when the PDF did not build, and when email is not configured', async () => {
    const noPdf = await send(engagement(), makeDeps(), {
      context: {
        buildPdf: async () => {
          throw new Error('pdfkit broke')
        },
      },
    })
    expect(noPdf.refused).toMatchObject({ status: 502, error: 'pdf_failed' })
    const deps = makeDeps({ configured: false })
    const unconfigured = await send(engagement(), deps)
    expect(unconfigured.refused).toMatchObject({ status: 502, error: 'engagement_send_failed' })
    expect(deps.sendMail).not.toHaveBeenCalled()
  })

  it('refuses a typed address that belongs to a team member', async () => {
    const deps = makeDeps()
    const result = await send(engagement(), deps, { to: 'alex@ka-performancefl.com' })
    expect(result.refused.error).toBe('team_address')
    expect(deps.sendMail).not.toHaveBeenCalled()
  })

  it('waits and retries once on a 429, and logs a provider refusal without throwing', async () => {
    const deps = makeDeps({
      results: [
        { ok: false, status: 429, error: 'slow down' },
        { ok: false, status: 422, error: 'Email provider refused the message (422).' },
      ],
    })
    const result = await send(engagement(), deps)
    expect(deps.calls).toEqual(['send', 'pause', 'send', 'mark'])
    expect(deps.pause).toHaveBeenCalledWith(ENGAGEMENT_RATE_LIMIT_WAIT_MS)
    expect(result).toMatchObject({ ok: false, error: 'Email provider refused the message (422).' })
    expect(deps.store.markEngagementSent.mock.calls[0][1]).toMatchObject({ ok: false, error: 'Email provider refused the message (422).' })
  })

  it('a log failure after the provider accepted it still answers sent', async () => {
    const deps = makeDeps({ markThrows: true })
    const row = engagement()
    const result = await send(row, deps)
    expect(result.ok).toBe(true)
    expect(result.engagement).toEqual(row)
  })

  it('a throw from the sender is a failed send, logged, never an exception', async () => {
    const deps = makeDeps()
    deps.sendMail.mockImplementationOnce(async () => {
      throw new Error('socket hang up')
    })
    const result = await send(engagement(), deps)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/did not finish sending/)
    expect(deps.store.markEngagementSent.mock.calls[0][1]).toMatchObject({ ok: false })
  })

  it('refuses a second send within 15 seconds of one that left (a double click), as just_sent', async () => {
    const at = (msAgo) => new Date(NOW.getTime() - msAgo).toISOString()
    const just = engagement({ status: 'sent', emailLog: [{ kind: 'send', ok: true, at: at(5000), to: ['pat@acme.test'] }] })
    const deps = makeDeps()
    const result = await send(just, deps)
    expect(result.refused).toMatchObject({ status: 409, error: 'engagement_refused', reason: 'just_sent' })
    expect(deps.sendMail).not.toHaveBeenCalled()
    expect(sentJustNow(just, NOW)).toBe(true)

    // Older than the window, a failed last send, or a delivery event after it: sent as asked.
    expect(ENGAGEMENT_JUST_SENT_MS).toBe(15000)
    for (const emailLog of [
      [{ kind: 'send', ok: true, at: at(ENGAGEMENT_JUST_SENT_MS + 1) }],
      [{ kind: 'send', ok: false, at: at(1000) }],
      [{ kind: 'send', ok: true, at: at(60000) }, { kind: 'delivery', event: 'delivered', at: at(1000) }],
    ]) {
      const row = engagement({ status: 'sent', emailLog })
      const again = makeDeps()
      expect((await send(row, again)).ok, JSON.stringify(emailLog)).toBe(true)
    }
  })

  it('a sent letter can be sent again', async () => {
    const deps = makeDeps()
    const result = await send(engagement({ status: 'sent' }), deps)
    expect(result.ok).toBe(true)
  })
})

describe('sendInvoiceEmail for an engagement', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  function stubResend() {
    const calls = []
    vi.stubEnv('RESEND_API_KEY', 're_test_key')
    vi.stubEnv('INVOICE_EMAIL_FROM', 'billing@pbjsa.com')
    vi.stubEnv('INVOICE_REPLY_TO', 'brittany@pbjsa.com')
    vi.stubEnv('OWNER_EMAIL', 'alex@example.test')
    vi.stubGlobal('fetch', async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) })
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 're_eng_1' }) }
    })
    return calls
  }

  it('tags the engagement, not an invoice, replies to the invoice mailbox and copies no one', async () => {
    const calls = stubResend()
    const deps = { ...makeDeps(), sendMail: sendInvoiceEmail }
    const result = await send(engagement(), deps)
    expect(result.ok).toBe(true)
    const body = calls[0].body
    expect(body.tags).toEqual([
      { name: 'engagement_id', value: 'eng-1' },
      { name: 'kind', value: 'engagement' },
    ])
    expect(body.to).toEqual(['pat@acme.test'])
    expect(body.reply_to).toBe('brittany@pbjsa.com')
    expect(body.from).toBe('PB&J Strategic Accounting <billing@pbjsa.com>')
    expect(body).not.toHaveProperty('cc')
    expect(body).not.toHaveProperty('bcc')
    expect(body.attachments).toHaveLength(1)
    expect(deps.store.markEngagementSent.mock.calls[0][1]).toMatchObject({ ok: true, providerId: 're_eng_1' })
  })
})
