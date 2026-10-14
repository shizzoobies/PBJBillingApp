import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ENGAGEMENT_JUST_SENT_MS,
  ENGAGEMENT_RATE_LIMIT_WAIT_MS,
  ENGAGEMENT_SENDING_MS,
  assembleEngagementPreview,
  engagementHash,
  engagementMissingSentence,
  engagementWarnings,
  sendEngagement,
  sendUnderWay,
  sentJustNow,
} from './engagement-send.js'
import { ENGAGEMENT_HASH_PARTY_KEYS, engagementChangedSinceSent } from './engagement-hash.js'
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
    updatedAt: '2026-10-09T15:00:00.000Z',
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
  // The "sending" mark: one stamp per store, taken by the first Send that loaded it
  // (the store's compare-and-set on updated_at, in miniature).
  const stamp = { value: '2026-10-09T15:00:00.000Z' }
  const store = {
    claimEngagementSend: vi.fn(async (id, expectedUpdatedAt) => {
      calls.push('claim')
      if (expectedUpdatedAt !== stamp.value) return null
      stamp.value = '2026-10-09T15:00:01.000Z'
      return { ...engagement(), updatedAt: stamp.value }
    }),
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

// Engagements stage 3, the sent-hash guard: the newest successful send names the
// letter that went out, and signing compares it with the letter as stored now.
describe('engagementChangedSinceSent', () => {
  const sendOf = (row, extra = {}) => ({ kind: 'send', ok: true, at: '2026-10-09T15:00:00.000Z', hash: engagementHash(row), ...extra })

  it('is false for the letter that went out, and true once it is edited', () => {
    const row = engagement()
    const sent = { ...row, emailLog: [sendOf(row)] }
    expect(engagementChangedSinceSent(sent)).toBe(false)
    expect(engagementChangedSinceSent({ ...sent, letterBody: 'Edited after sending' })).toBe(true)
    expect(engagementChangedSinceSent({ ...sent, retainerAmount: 99 })).toBe(true)
    expect(engagementChangedSinceSent({ ...sent, party: { ...row.party, email: 'other@acme.test' } })).toBe(true)
    // Not part of what is sent: no change.
    expect(engagementChangedSinceSent({ ...sent, planIds: ['p1'], packageId: 'pkg-1' })).toBe(false)
  })

  it('reads the NEWEST successful send: a re-send of the edit clears it; a failed send or a delivery event does not count', () => {
    const row = engagement()
    const edited = { ...row, letterBody: 'Edited after sending' }
    expect(engagementChangedSinceSent({ ...edited, emailLog: [sendOf(row), sendOf(edited)] })).toBe(false)
    expect(
      engagementChangedSinceSent({ ...edited, emailLog: [sendOf(row), sendOf(edited, { ok: false }), { kind: 'delivery', event: 'delivered', hash: 'x' }] }),
    ).toBe(true)
  })

  it('cannot tell for a send logged without a hash (before stage 3), or a letter never sent: unchanged', () => {
    const row = engagement()
    expect(engagementChangedSinceSent({ ...row, letterBody: 'x', emailLog: [{ kind: 'send', ok: true, at: '2026-10-01T00:00:00.000Z' }] })).toBe(false)
    expect(engagementChangedSinceSent({ ...row, emailLog: [] })).toBe(false)
    expect(engagementChangedSinceSent(null)).toBe(false)
  })
})

describe('sending one engagement', () => {
  it('sends once to the party, with the PDF and the engagement tag, then logs the send', async () => {
    const deps = makeDeps()
    const result = await send(engagement(), deps)
    expect(result).toMatchObject({ ok: true, error: null, to: ['pat@acme.test'] })
    expect(result.engagement.status).toBe('sent')
    expect(deps.calls).toEqual(['claim', 'send', 'mark'])
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
      // The letter that went out, for the sent-hash guard at signing (engagements stage 3).
      hash: engagementHash(engagement()),
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
      // Nothing was claimed either: a refused Send leaves the letter's stamp alone.
      expect(deps.store.claimEngagementSend, code).not.toHaveBeenCalled()
    }
  })

  // Two Sends started together both read an empty log, so the 15-second check passes for
  // both. The claim on the stamp they loaded lets one through (engagements leftovers 3).
  it('two Sends racing on one letter: one sends, the other is refused as already under way', async () => {
    const deps = makeDeps()
    const row = engagement()
    const [first, second] = await Promise.all([send(row, deps), send(row, deps)])
    expect(deps.sendMail).toHaveBeenCalledTimes(1)
    expect(deps.store.markEngagementSent).toHaveBeenCalledTimes(1)
    const refused = [first, second].filter((result) => result.refused)
    expect(refused).toHaveLength(1)
    expect(refused[0].refused).toMatchObject({ status: 409, error: 'engagement_refused', reason: 'sending' })
    expect([first, second].filter((result) => result.ok === true)).toHaveLength(1)
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
    expect(deps.calls).toEqual(['claim', 'send', 'pause', 'send', 'mark'])
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

  // A Send claims the letter before the provider call; a second tab that reads the letter after the
  // claim must not send too. The claim's "sending" entry counts for two minutes, then ages out.
  it('treats a recent sending entry with no later send as a send in flight, and lets an old one age out', async () => {
    const at = (msAgo) => new Date(NOW.getTime() - msAgo).toISOString()
    const thirty = engagement({ emailLog: [{ kind: 'sending', at: at(30000) }] })
    expect(sentJustNow(thirty, NOW)).toBe(true)
    const deps = makeDeps()
    expect((await send(thirty, deps)).refused).toMatchObject({ status: 409, error: 'engagement_refused', reason: 'sending' })
    expect((await send(thirty, deps)).refused.message).toBe(
      'A send of this letter is already under way - wait a minute, then check Activity. Nothing more was sent.',
    )
    expect(sendUnderWay(thirty, NOW)).toBe(true)
    expect(sendUnderWay(engagement({ emailLog: [{ kind: 'send', ok: true, at: at(1000) }] }), NOW)).toBe(false)
    expect(deps.sendMail).not.toHaveBeenCalled()

    expect(ENGAGEMENT_SENDING_MS).toBe(120000)
    const threeMinutes = engagement({ emailLog: [{ kind: 'sending', at: at(180000) }] })
    expect(sentJustNow(threeMinutes, NOW)).toBe(false)
    expect((await send(threeMinutes, makeDeps())).ok).toBe(true)

    // A send logged after the claim ends it: a failed one frees the letter at once.
    const failedAfter = engagement({ emailLog: [{ kind: 'sending', at: at(30000) }, { kind: 'send', ok: false, at: at(20000) }] })
    expect(sentJustNow(failedAfter, NOW)).toBe(false)
    // ...and a good one holds it for the usual 15 seconds only.
    const goodAfter = engagement({ emailLog: [{ kind: 'sending', at: at(60000) }, { kind: 'send', ok: true, at: at(40000) }] })
    expect(sentJustNow(goodAfter, NOW)).toBe(false)
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
