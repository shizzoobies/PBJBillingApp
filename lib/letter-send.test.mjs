import { describe, expect, it, vi } from 'vitest'

import {
  LETTER_RATE_LIMIT_WAIT_MS,
  LETTER_SEND_GAP_MS,
  assembleLetterPreview,
  letterMissingSentence,
  sendLetterBatch,
  sendOneLetter,
} from './letter-send.js'

/**
 * Previewing and sending the engagement letter (featreq-5e195707), run for real
 * against an in-memory store and a recorded mail sender: who a letter goes to, what
 * stops it, the order of claim and send, a claim that never finished, and a
 * database error in the middle of a run.
 */
const NOW = new Date('2026-10-08T16:00:00Z')
const TEMPLATE = {
  subject: 'Your {{next_year}} 1099s',
  emailBody: 'Hi {{contact_first_name}}, our fee for {{client_name}} is {{fee}}.',
  letterBody: 'Dear {{contact_name}},\n\nWe will prepare the 1099s for {{client_name}} at {{fee}}.',
}
const FIRM = { name: 'PB&J Strategic Accounting', email: 'hello@pbjsa.com' }

const contacts = [
  { id: 'ct-pat', name: 'Pat Doe', email: 'pat@acme.test' },
  { id: 'ct-lee', name: 'Lee Roe', email: 'lee@beta.test' },
  { id: 'ct-sub', name: 'Sam Sub', email: 'sam@sub.test', companyEmails: [{ clientId: 'c-sub', email: 'sam@sub-co.test' }] },
  { id: 'ct-alex', name: 'Alex Owner', email: 'Alex@KA-Performancefl.com' },
]
const baseClient = { billingMode: 'subscription', monthlyRate: 0, lifecycleStage: 'active', contactIds: [], email: '' }
const clients = [
  { ...baseClient, id: 'c-acme', name: 'Acme Books LLC', monthlyRate: 500, contactIds: ['ct-pat'], addressLine1: '12 Main St', city: 'Nashville', state: 'TN', postalCode: '37201' },
  { ...baseClient, id: 'c-hourly', name: 'Hourly Co', billingMode: 'hourly', hourlyRate: 125, contactIds: ['ct-lee'] },
  { ...baseClient, id: 'c-nofee', name: 'No Fee Co', monthlyRate: 0, contactIds: ['ct-lee'] },
  { ...baseClient, id: 'c-team', name: 'Team Co', monthlyRate: 100, contactIds: ['ct-alex'] },
  { ...baseClient, id: 'c-mixed', name: 'Mixed Co', monthlyRate: 100, contactIds: ['ct-alex', 'ct-pat'] },
  {
    ...baseClient,
    id: 'c-master',
    name: 'KLC Holdings',
    isBillingMaster: true,
    billingMode: 'subscription',
    monthlyRate: 900,
    invoiceRecipientClientId: 'c-sub',
  },
  {
    ...baseClient,
    id: 'c-sub',
    name: 'KLC South',
    billToClientId: 'c-master',
    monthlyRate: 400,
    contactIds: ['ct-sub'],
    addressLine1: '9 Pine Rd',
    city: 'Austin',
    state: 'TX',
    postalCode: '78701',
  },
  { ...baseClient, id: 'c-master-nofee', name: 'Feeless Master', isBillingMaster: true, monthlyRate: 0, invoiceRecipientClientId: 'c-sub-b' },
  { ...baseClient, id: 'c-sub-b', name: 'Feeless South', billToClientId: 'c-master-nofee', monthlyRate: 400, contactIds: ['ct-sub'] },
  { ...baseClient, id: 'c-master-hourly', name: 'Hourly Master', isBillingMaster: true, billingMode: 'hourly', hourlyRate: 125, invoiceRecipientClientId: 'c-sub-c' },
  { ...baseClient, id: 'c-sub-c', name: 'Hourly South', billToClientId: 'c-master-hourly', monthlyRate: 400, contactIds: ['ct-sub'] },
  { ...baseClient, id: 'c-master-unset', name: 'Unset Master', isBillingMaster: true, monthlyRate: 900, invoiceRecipientClientId: null },
]

function makeContext(over = {}) {
  return {
    template: TEMPLATE,
    data: { clients, contacts },
    firmSettings: FIRM,
    senderName: 'Brittany',
    now: NOW,
    teamEmails: new Set(),
    replyTo: 'brittany@pbjsa.com',
    ...over,
  }
}

/** The store's three letter-send methods, with the same claim rule as the real ones. */
function fakeStore({ failClaimFor = null, failComplete = false } = {}) {
  const rows = []
  const calls = []
  return {
    rows,
    calls,
    async nextEngagementLetterAttempt(key) {
      calls.push(['next', key.clientId])
      const mine = rows.filter((r) => r.clientId === key.clientId && r.templateHash === key.templateHash && r.firmDay === key.firmDay)
      return Math.max(0, ...mine.map((r) => r.attempt)) + 1
    },
    async claimEngagementLetterSend(args) {
      calls.push(['claim', args.clientId, args.attempt])
      if (failClaimFor === args.clientId) throw new Error('connection terminated')
      const blocker = rows.find(
        (r) => r.clientId === args.clientId && r.templateHash === args.templateHash && r.firmDay === args.firmDay && r.attempt === args.attempt && r.status !== 'failed',
      )
      if (blocker) return { claimed: false, send: { ...blocker } }
      const row = { id: `els-${rows.length + 1}`, ...args, status: 'sending', createdAt: '2026-10-08T14:05:00.000Z' }
      rows.push(row)
      return { claimed: true, send: { ...row } }
    },
    async completeEngagementLetterSend(id, result) {
      calls.push(['complete', id, result.ok])
      if (failComplete) throw new Error('could not write')
      const row = rows.find((r) => r.id === id && r.status === 'sending')
      if (!row) return null
      row.status = result.ok ? 'sent' : 'failed'
      row.error = result.error
      return { ...row }
    },
  }
}

const OPTIONS = { templateHash: 'hash-1', firmDay: '2026-10-08', resend: false, userId: 'user-1' }
function makeDeps(over = {}) {
  const store = over.store ?? fakeStore()
  return {
    store,
    sendMail: over.sendMail ?? vi.fn(async () => ({ ok: true, error: null, providerId: 're_1', status: 200 })),
    pause: over.pause ?? vi.fn(async () => {}),
  }
}

describe('letterMissingSentence', () => {
  it('says an hourly client has no single fee, and names the placeholders to take out', () => {
    expect(letterMissingSentence('Hourly Co', ['fee'], 'hourly')).toBe(
      'Hourly Co is billed hourly, so there is no single fee to fill in - take {{fee}} out of the letter, or write their rates by hand.',
    )
    expect(letterMissingSentence('Hourly Co', ['fee', 'hourly_rate'], 'hourly')).toContain(
      'take {{fee}} and {{hourly_rate}} out of the letter',
    )
  })

  it('keeps the ordinary sentence for any other client, and adds it after the hourly one for other gaps', () => {
    expect(letterMissingSentence('No Fee Co', ['fee'], 'subscription')).toBe(
      '{{fee}} has no value for No Fee Co - set it on the client page, or take the placeholder out of the letter.',
    )
    expect(letterMissingSentence('Hourly Co', ['fee', 'contact_name'], 'hourly')).toBe(
      'Hourly Co is billed hourly, so there is no single fee to fill in - take {{fee}} out of the letter, or write their rates by hand. {{contact_name}} has no value for Hourly Co - set it on the client page, or take the placeholder out of the letter.',
    )
    expect(letterMissingSentence('X', ['contact_first_name', 'contact_name'], 'subscription')).toBe(
      '{{contact_first_name}} and {{contact_name}} have no value for X - set them on the client page, or take the placeholders out of the letter.',
    )
  })
})

describe('assembleLetterPreview - fees', () => {
  it('an hourly client is missing {{fee}} whatever its stored hourly rate, with its own sentence', async () => {
    const preview = await assembleLetterPreview(makeContext(), 'c-hourly')
    expect(preview.missing).toEqual(['fee'])
    expect(preview.missingNote).toBe(
      'Hourly Co is billed hourly, so there is no single fee to fill in - take {{fee}} out of the letter, or write their rates by hand.',
    )
    expect(preview.docs.email.text).not.toContain('$125.00')
  })

  it('an hourly client whose letter has no fee in it is not missing anything', async () => {
    const preview = await assembleLetterPreview(
      makeContext({ template: { subject: 'S', emailBody: 'Hi {{contact_first_name}}', letterBody: 'Dear {{contact_name}}' } }),
      'c-hourly',
    )
    expect(preview.missing).toEqual([])
    expect(preview.missingNote).toBeNull()
  })

  it('a monthly client with no fee is missing it with the ordinary sentence', async () => {
    const preview = await assembleLetterPreview(makeContext(), 'c-nofee')
    expect(preview.missing).toEqual(['fee'])
    expect(preview.missingNote).toMatch(/^\{\{fee\}\} has no value for No Fee Co - set it on the client page/)
  })

  it('answers notFound for a client that is gone', async () => {
    expect(await assembleLetterPreview(makeContext(), 'nope')).toEqual({ notFound: true })
  })
})

describe('assembleLetterPreview - a billing master', () => {
  it('takes the figures from the master and the contacts and address from the receiving company', async () => {
    const preview = await assembleLetterPreview(makeContext(), 'c-master')
    expect(preview.missing).toEqual([])
    expect(preview.to).toEqual(['sam@sub-co.test', 'sam@sub.test'])
    expect(preview.docs.email.text).toContain('Hi Sam,')
    expect(preview.docs.email.text).toContain('KLC Holdings is $900.00 per month')
    expect(preview.docs.email.text).not.toContain('$400.00')
    expect(preview.docs.pdfFilename).toBe('Engagement-Letter-KLC-Holdings-2026.pdf')
  })

  it('a master with no fee is skipped by the ordinary missing rule, not given the receiving company\'s', async () => {
    const preview = await assembleLetterPreview(makeContext(), 'c-master-nofee')
    expect(preview.missing).toEqual(['fee'])
    expect(preview.missingNote).toMatch(/^\{\{fee\}\} has no value for Feeless Master/)
    expect(preview.docs.email.text).not.toContain('$400.00')
  })

  it('an hourly master reads as hourly', async () => {
    const preview = await assembleLetterPreview(makeContext(), 'c-master-hourly')
    expect(preview.missingNote).toMatch(/^Hourly Master is billed hourly/)
  })

  it('a master with no receiving company is refused with the master sentence', async () => {
    const preview = await assembleLetterPreview(makeContext(), 'c-master-unset')
    expect(preview.to).toEqual([])
    expect(preview.recipientNote).toMatch(/no receiving company set/)
    expect(preview.refusal).toBe(preview.recipientNote)
  })
})

describe('assembleLetterPreview - team addresses (the tax-document rule, at the address)', () => {
  const team = new Set(['alex@ka-performancefl.com', 'brittany@pbjsa.com'])

  it('drops an address that belongs to a team member, whatever its case', async () => {
    const preview = await assembleLetterPreview(makeContext({ teamEmails: team }), 'c-mixed')
    expect(preview.to).toEqual(['pat@acme.test'])
    expect(preview.details.map((d) => d.email)).toEqual(['pat@acme.test'])
    expect(preview.teamOnly).toBe(false)
    expect(preview.recipientNote).toBeNull()
  })

  it('says so when the only address on file is a team member\'s', async () => {
    const preview = await assembleLetterPreview(makeContext({ teamEmails: team }), 'c-team')
    expect(preview.to).toEqual([])
    expect(preview.teamOnly).toBe(true)
    expect(preview.recipientNote).toBe('The only address on file for Team Co belongs to a team member.')
    expect(preview.refusal).toBe(preview.recipientNote)
  })

  it('keeps the reply-to mailbox itself even though it is a user account', async () => {
    const withReplyTo = clients.map((c) => (c.id === 'c-team' ? { ...c, email: 'Brittany@pbjsa.com', contactIds: [] } : c))
    const preview = await assembleLetterPreview(makeContext({ teamEmails: team, data: { clients: withReplyTo, contacts } }), 'c-team')
    expect(preview.to).toEqual(['Brittany@pbjsa.com'])
    expect(preview.teamOnly).toBe(false)
  })

  it('leaves everything alone when no team address is known', async () => {
    const preview = await assembleLetterPreview(makeContext({ teamEmails: undefined }), 'c-team')
    expect(preview.to).toEqual(['Alex@KA-Performancefl.com'])
  })
})

describe('sendOneLetter', () => {
  it('claims, then sends the PDF to the addressees only, then closes the claim', async () => {
    const deps = makeDeps()
    const result = await sendOneLetter(makeContext(), 'c-acme', OPTIONS, deps)
    expect(result).toMatchObject({ clientId: 'c-acme', clientName: 'Acme Books LLC', status: 'sent', to: ['pat@acme.test'] })
    expect(deps.store.calls.map((c) => c[0])).toEqual(['claim', 'complete'])
    expect(deps.store.rows[0]).toMatchObject({ status: 'sent', attempt: 1, recipients: ['pat@acme.test'], templateHash: 'hash-1' })
    expect(deps.sendMail).toHaveBeenCalledTimes(1)
    const mail = deps.sendMail.mock.calls[0][0]
    expect(mail).toMatchObject({ to: ['pat@acme.test'], kind: 'letter', letterSendId: 'els-1', fromName: 'PB&J Strategic Accounting' })
    expect(mail.attachments).toHaveLength(1)
    expect(mail.attachments[0].filename).toBe('Engagement-Letter-Acme-Books-LLC-2026.pdf')
    expect(mail.attachments[0].content.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(Object.keys(mail)).not.toEqual(expect.arrayContaining(['cc']))
    expect(Object.keys(mail).join(',')).not.toMatch(/bcc|cc/i)
  })

  it('skips a client missing a value, with the sentence, claiming and sending nothing', async () => {
    for (const [id, code, text] of [
      ['c-nofee', 'missing_placeholder', /^\{\{fee\}\} has no value for No Fee Co/],
      ['c-hourly', 'missing_placeholder', /^Hourly Co is billed hourly, so there is no single fee to fill in/],
      ['c-master-unset', 'no_addressee', /no receiving company set/],
      ['gone', 'not_found', /^This client is no longer on file\.$/],
    ]) {
      const deps = makeDeps()
      const result = await sendOneLetter(makeContext(), id, OPTIONS, deps)
      expect(result, id).toMatchObject({ status: 'skipped', code })
      expect(result.message, id).toMatch(text)
      expect(deps.store.calls, id).toEqual([])
      expect(deps.sendMail, id).not.toHaveBeenCalled()
    }
  })

  it('skips a client whose only address belongs to a team member, claiming and sending nothing', async () => {
    const deps = makeDeps()
    const result = await sendOneLetter(makeContext({ teamEmails: new Set(['alex@ka-performancefl.com']) }), 'c-team', OPTIONS, deps)
    expect(result).toMatchObject({
      status: 'skipped',
      code: 'team_address',
      message: 'The only address on file for Team Co belongs to a team member.',
    })
    expect(deps.store.calls).toEqual([])
    expect(deps.sendMail).not.toHaveBeenCalled()
  })

  it('never mails a team member: a client with a team address and a real one gets only the real one', async () => {
    const deps = makeDeps()
    await sendOneLetter(makeContext({ teamEmails: new Set(['alex@ka-performancefl.com']) }), 'c-mixed', OPTIONS, deps)
    expect(deps.sendMail.mock.calls[0][0].to).toEqual(['pat@acme.test'])
    expect(deps.store.rows[0].recipients).toEqual(['pat@acme.test'])
  })

  it('a second send the same day is "already sent" when the blocking claim is sent', async () => {
    const deps = makeDeps()
    await sendOneLetter(makeContext(), 'c-acme', OPTIONS, deps)
    const again = await sendOneLetter(makeContext(), 'c-acme', OPTIONS, deps)
    expect(again).toMatchObject({
      status: 'skipped',
      code: 'already_sent',
      message: 'Acme Books LLC was already sent this letter today. Use Send again to send it a second time.',
    })
    expect(deps.sendMail).toHaveBeenCalledTimes(1)
  })

  it('a claim still "sending" is never read as sent: it is unfinished, nothing is sent and the row is left alone', async () => {
    const deps = makeDeps()
    deps.store.rows.push({
      id: 'els-old', clientId: 'c-acme', templateHash: 'hash-1', firmDay: '2026-10-08', attempt: 1,
      status: 'sending', createdAt: '2026-10-08T14:05:00.000Z',
    })
    const result = await sendOneLetter(makeContext(), 'c-acme', OPTIONS, deps)
    expect(result).toMatchObject({ status: 'skipped', code: 'unfinished', clientName: 'Acme Books LLC' })
    expect(result.message).toMatch(/^A send to Acme Books LLC started at Oct 8, \d{1,2}:\d{2} (AM|PM) and never finished - check with them, then use Send again anyway\.$/)
    expect(result.message).not.toMatch(/already sent/)
    expect(deps.sendMail).not.toHaveBeenCalled()
    // Never auto-failed: a failed row is re-claimable by a plain Send, which could double-send.
    expect(deps.store.rows[0].status).toBe('sending')
    expect(deps.store.calls.map((c) => c[0])).toEqual(['claim'])
  })

  it('Send again anyway claims the next attempt, even past an unfinished one', async () => {
    const deps = makeDeps()
    deps.store.rows.push({
      id: 'els-old', clientId: 'c-acme', templateHash: 'hash-1', firmDay: '2026-10-08', attempt: 1,
      status: 'sending', createdAt: '2026-10-08T14:05:00.000Z',
    })
    const result = await sendOneLetter(makeContext(), 'c-acme', { ...OPTIONS, resend: true }, deps)
    expect(result.status).toBe('sent')
    expect(deps.store.calls.slice(0, 2)).toEqual([['next', 'c-acme'], ['claim', 'c-acme', 2]])
    expect(deps.store.rows.map((r) => [r.attempt, r.status])).toEqual([[1, 'sending'], [2, 'sent']])
  })

  it('waits 1,500 ms and retries once on a 429, with the same mail', async () => {
    const answers = [{ ok: false, error: 'slow down', status: 429, providerId: null }, { ok: true, error: null, status: 200, providerId: 're_2' }]
    const sendMail = vi.fn(async () => answers.shift())
    const deps = makeDeps({ sendMail })
    const result = await sendOneLetter(makeContext(), 'c-acme', OPTIONS, deps)
    expect(result.status).toBe('sent')
    expect(sendMail).toHaveBeenCalledTimes(2)
    expect(sendMail.mock.calls[1][0]).toBe(sendMail.mock.calls[0][0])
    expect(deps.pause).toHaveBeenCalledExactlyOnceWith(LETTER_RATE_LIMIT_WAIT_MS)
    expect(LETTER_RATE_LIMIT_WAIT_MS).toBe(1500)
  })

  it('a provider refusal is a failed result with its sentence, and the claim is closed as failed', async () => {
    const sendMail = vi.fn(async () => ({ ok: false, error: 'Email provider refused the message (422).', status: 422, providerId: null }))
    const deps = makeDeps({ sendMail })
    const result = await sendOneLetter(makeContext(), 'c-acme', OPTIONS, deps)
    expect(result).toMatchObject({ status: 'failed', code: 'provider', message: 'Email provider refused the message (422).' })
    expect(sendMail).toHaveBeenCalledTimes(1)
    expect(deps.store.rows[0]).toMatchObject({ status: 'failed', error: 'Email provider refused the message (422).' })
  })

  it('an email that went out is reported sent even when closing the log row fails', async () => {
    const deps = makeDeps({ store: fakeStore({ failComplete: true }) })
    const result = await sendOneLetter(makeContext(), 'c-acme', OPTIONS, deps)
    expect(result.status).toBe('sent')
  })

  it('an unexpected throw after the claim closes it as failed and says to check with the client', async () => {
    const sendMail = vi.fn(async () => {
      throw new Error('boom')
    })
    const deps = makeDeps({ sendMail })
    const result = await sendOneLetter(makeContext(), 'c-acme', OPTIONS, deps)
    expect(result).toMatchObject({ status: 'failed', code: 'unexpected' })
    expect(result.message).toMatch(/Check with them before sending again\./)
    expect(deps.store.rows[0].status).toBe('failed')
  })
})

describe('sendLetterBatch', () => {
  it('sends one at a time and spaces the provider calls 600 ms apart, not the skipped ones', async () => {
    const deps = makeDeps()
    const results = await sendLetterBatch(makeContext(), ['c-acme', 'c-nofee', 'c-mixed', 'c-master'], OPTIONS, deps)
    expect(results.map((r) => [r.clientId, r.status])).toEqual([
      ['c-acme', 'sent'],
      ['c-nofee', 'skipped'],
      ['c-mixed', 'sent'],
      ['c-master', 'sent'],
    ])
    // Between the first and the third (a skip makes no provider call) and between the third and the fourth.
    expect(deps.pause.mock.calls.map((c) => c[0])).toEqual([LETTER_SEND_GAP_MS, LETTER_SEND_GAP_MS])
    expect(LETTER_SEND_GAP_MS).toBe(600)
  })

  it('a database error on one client fails that client and the run goes on with every result kept', async () => {
    const deps = makeDeps({ store: fakeStore({ failClaimFor: 'c-mixed' }) })
    const results = await sendLetterBatch(makeContext(), ['c-acme', 'c-mixed', 'c-master'], OPTIONS, deps)
    expect(results.map((r) => [r.clientId, r.status, r.code])).toEqual([
      ['c-acme', 'sent', undefined],
      ['c-mixed', 'failed', 'unexpected'],
      ['c-master', 'sent', undefined],
    ])
    expect(results[1]).toMatchObject({
      clientName: 'Mixed Co',
      message: 'Something went wrong sending the letter to Mixed Co. Check with them before sending again.',
    })
    expect(deps.sendMail).toHaveBeenCalledTimes(2)
  })

  it('names a client that is no longer on file even when the loop throws for it', async () => {
    const deps = makeDeps({ store: fakeStore({ failClaimFor: 'c-acme' }) })
    const results = await sendLetterBatch(makeContext(), ['c-acme'], OPTIONS, deps)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ clientName: 'Acme Books LLC', status: 'failed' })
  })
})
