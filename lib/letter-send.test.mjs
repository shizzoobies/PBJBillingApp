import { afterEach, describe, expect, it, vi } from 'vitest'

import { reconcileCoveredResults } from './letter-batch-cover.js'
import {
  LETTER_IN_FLIGHT_MS,
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
  id: 'default',
  name: '1099 Filing',
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
  { ...baseClient, id: 'c-bracket', name: 'Bracket Co', monthlyRate: 100, email: 'Alex Owner <alex@ka-performancefl.com>' },
  { ...baseClient, id: 'c-joined', name: 'Joined Co', monthlyRate: 100, email: 'pat@acme.test, alex@ka-performancefl.com' },
  { ...baseClient, id: 'c-reply-form', name: 'Reply Form Co', monthlyRate: 100, email: 'Brittany Ferguson <brittany@pbjsa.com>' },
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
function fakeStore({ failClaimFor = null, failComplete = false, failRecord = false, deletedLetter = null } = {}) {
  const rows = []
  const calls = []
  // Engagements stage 4: the amendments recorded from sends (kept apart from `calls`).
  const amendments = []
  return {
    rows,
    calls,
    amendments,
    async recordAmendmentFromLetterSend(args) {
      if (failRecord) throw new Error('could not record')
      const already = amendments.find((row) => row.letterSendId === args.letterSendId)
      if (already) return already
      const row = { id: `eng-${amendments.length + 1}`, ...args }
      amendments.push(row)
      return row
    },
    async nextEngagementLetterAttempt(key) {
      calls.push(['next', key.clientId, key.letterId])
      const mine = rows.filter((r) => r.letterId === key.letterId && r.clientId === key.clientId && r.templateHash === key.templateHash && r.firmDay === key.firmDay)
      return Math.max(0, ...mine.map((r) => r.attempt)) + 1
    },
    async claimEngagementLetterSend(args) {
      calls.push(['claim', args.clientId, args.attempt])
      if (failClaimFor === args.clientId) throw new Error('connection terminated')
      if (deletedLetter === args.letterId) return { claimed: false, reason: 'letter_deleted' }
      const blocker = rows.find(
        (r) => r.letterId === args.letterId && r.clientId === args.clientId && r.templateHash === args.templateHash && r.firmDay === args.firmDay && r.attempt === args.attempt && r.status !== 'failed',
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
    expect(letterMissingSentence('Hourly Co', ['fee', 'monthly_fee'], 'hourly')).toContain(
      'take {{fee}} and {{monthly_fee}} out of the letter',
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

  it('lists a retired placeholder in the preview, for every kind of client', async () => {
    const template = { subject: 'S', emailBody: 'Hi', letterBody: 'At {{hourly_rate}}.' }
    for (const id of ['c-acme', 'c-hourly']) {
      const preview = await assembleLetterPreview(makeContext({ template }), id)
      expect(preview.retired, id).toEqual(['hourly_rate'])
      expect(preview.unknown, id).toEqual([])
      expect(preview.missing, id).toEqual([])
    }
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

describe('assembleLetterPreview - a billing master in the same batch', () => {
  it('carries the sentence Send would skip the sub with, and nothing when the master is not ticked', async () => {
    const covered = await assembleLetterPreview(makeContext({ batchClientIds: ['c-master', 'c-sub'] }), 'c-sub')
    expect(covered.batchNote).toBe("KLC South bills through KLC Holdings, which is in this batch - the master's letter covers it.")
    expect((await assembleLetterPreview(makeContext({ batchClientIds: ['c-sub'] }), 'c-sub')).batchNote).toBeNull()
    expect((await assembleLetterPreview(makeContext(), 'c-sub')).batchNote).toBeNull()
    // The master itself is never covered.
    expect((await assembleLetterPreview(makeContext({ batchClientIds: ['c-master', 'c-sub'] }), 'c-master')).batchNote).toBeNull()
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

  // The provider delivers to what it can read in a stored value, so the guard reads every address in it.
  it('catches a team address written as "Name <address>", and skips the client with the same sentence', async () => {
    const preview = await assembleLetterPreview(makeContext({ teamEmails: team }), 'c-bracket')
    expect(preview.to).toEqual([])
    expect(preview.teamOnly).toBe(true)
    expect(preview.recipientNote).toBe('The only address on file for Bracket Co belongs to a team member.')
  })

  it('drops a field that holds a team address next to a real one, whole', async () => {
    const preview = await assembleLetterPreview(makeContext({ teamEmails: team }), 'c-joined')
    expect(preview.to).toEqual([])
    expect(preview.teamOnly).toBe(true)
    expect(preview.recipientNote).toBe('The only address on file for Joined Co belongs to a team member.')
  })

  it('never mails either form', async () => {
    for (const id of ['c-bracket', 'c-joined']) {
      const deps = makeDeps()
      const result = await sendOneLetter(makeContext({ teamEmails: team }), id, OPTIONS, deps)
      expect(result, id).toMatchObject({ status: 'skipped', code: 'team_address' })
      expect(deps.sendMail, id).not.toHaveBeenCalled()
      expect(deps.store.calls, id).toEqual([])
    }
  })

  it('keeps the reply-to mailbox written as "Name <address>"', async () => {
    const preview = await assembleLetterPreview(makeContext({ teamEmails: team }), 'c-reply-form')
    expect(preview.to).toEqual(['Brittany Ferguson <brittany@pbjsa.com>'])
    expect(preview.teamOnly).toBe(false)
  })

  it('leaves everything alone when no team address is known', async () => {
    const preview = await assembleLetterPreview(makeContext({ teamEmails: undefined }), 'c-team')
    expect(preview.to).toEqual(['Alex@KA-Performancefl.com'])
  })
})

describe('sendOneLetter', () => {
  afterEach(() => vi.useRealTimers())

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

  // Brittany keeps several letters: each one is its own "already sent today" and its own log.
  it('keys every claim by the letter being sent, so another letter the same day is not "already sent"', async () => {
    const deps = makeDeps()
    const other = { ...TEMPLATE, id: 'letter-ab12cd34', name: 'Engagement 2027' }
    await sendOneLetter(makeContext(), 'c-acme', OPTIONS, deps)
    const second = await sendOneLetter(makeContext({ template: other }), 'c-acme', OPTIONS, deps)
    expect(second).toMatchObject({ status: 'sent' })
    expect(deps.store.rows.map((row) => row.letterId)).toEqual(['default', 'letter-ab12cd34'])
    await sendOneLetter(makeContext({ template: other }), 'c-acme', { ...OPTIONS, resend: true }, deps)
    expect(deps.store.calls.filter((call) => call[0] === 'next')).toEqual([['next', 'c-acme', 'letter-ab12cd34']])
    expect(deps.store.rows.at(-1)).toMatchObject({ letterId: 'letter-ab12cd34', attempt: 2 })
  })

  it('a claim still "sending" is never read as sent: it is unfinished, nothing is sent and the row is left alone', async () => {
    const deps = makeDeps()
    deps.store.rows.push({
      id: 'els-old', letterId: 'default', clientId: 'c-acme', templateHash: 'hash-1', firmDay: '2026-10-08', attempt: 1,
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

  // A delete that lands between Send loading the letter and the first claim.
  it('a letter deleted before the claim fails the client with its sentence, sending nothing and writing nothing', async () => {
    const deps = makeDeps({ store: fakeStore({ deletedLetter: 'default' }) })
    const result = await sendOneLetter(makeContext(), 'c-acme', OPTIONS, deps)
    expect(result).toEqual({
      clientId: 'c-acme',
      clientName: 'Acme Books LLC',
      status: 'failed',
      code: 'letter_deleted',
      message: 'This letter was deleted before the send started.',
    })
    expect(deps.sendMail).not.toHaveBeenCalled()
    expect(deps.store.rows).toEqual([])
  })

  // Another owner's send that is simply still running (seconds) is not one that died. The age is
  // read from the clock when the claim is refused (the tests set it), not from the request's `now`.
  it('a "sending" claim under two minutes old is a send running right now, not an unfinished one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const deps = makeDeps()
    deps.store.rows.push({
      id: 'els-live', letterId: 'default', clientId: 'c-acme', templateHash: 'hash-1', firmDay: '2026-10-08', attempt: 1,
      status: 'sending', createdAt: '2026-10-08T15:59:30.000Z',
    })
    const result = await sendOneLetter(makeContext(), 'c-acme', OPTIONS, deps)
    expect(result).toMatchObject({ status: 'skipped', code: 'sending_now', clientName: 'Acme Books LLC' })
    expect(result.message).toMatch(/^A send to Acme Books LLC is running right now \(started Oct 8, \d{1,2}:\d{2} (AM|PM)\) - it will show in the sends list when it finishes\.$/)
    expect(deps.sendMail).not.toHaveBeenCalled()
    expect(deps.store.rows[0].status).toBe('sending')
  })

  it('a "sending" claim three minutes old is still unfinished', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const deps = makeDeps()
    deps.store.rows.push({
      id: 'els-stale', letterId: 'default', clientId: 'c-acme', templateHash: 'hash-1', firmDay: '2026-10-08', attempt: 1,
      status: 'sending', createdAt: '2026-10-08T15:57:00.000Z',
    })
    const result = await sendOneLetter(makeContext(), 'c-acme', OPTIONS, deps)
    expect(result).toMatchObject({ status: 'skipped', code: 'unfinished' })
    expect(result.message).toMatch(/and never finished - check with them/)
  })

  it('judges the claim\'s age by the clock at the claim, so a long batch does not leave a stale "now"', async () => {
    // The request began at 16:00 (context.now) and this client came up at 16:05; the claim is from 15:59:30.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-08T16:05:00Z'))
    const deps = makeDeps()
    deps.store.rows.push({
      id: 'els-aged', letterId: 'default', clientId: 'c-acme', templateHash: 'hash-1', firmDay: '2026-10-08', attempt: 1,
      status: 'sending', createdAt: '2026-10-08T15:59:30.000Z',
    })
    const result = await sendOneLetter(makeContext(), 'c-acme', OPTIONS, deps)
    expect(result).toMatchObject({ status: 'skipped', code: 'unfinished' })
  })

  it('shares the two-minute line with the Letters list', () => {
    expect(LETTER_IN_FLIGHT_MS).toBe(2 * 60 * 1000)
  })

  it('Send again anyway claims the next attempt, even past an unfinished one', async () => {
    const deps = makeDeps()
    deps.store.rows.push({
      id: 'els-old', letterId: 'default', clientId: 'c-acme', templateHash: 'hash-1', firmDay: '2026-10-08', attempt: 1,
      status: 'sending', createdAt: '2026-10-08T14:05:00.000Z',
    })
    const result = await sendOneLetter(makeContext(), 'c-acme', { ...OPTIONS, resend: true }, deps)
    expect(result.status).toBe('sent')
    expect(deps.store.calls.slice(0, 2)).toEqual([['next', 'c-acme', 'default'], ['claim', 'c-acme', 2]])
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

/**
 * Engagements stage 4: every send that left is ALSO an amendment on the client's
 * engagements, carrying the filled text the client received. A failure to record
 * never turns a delivered letter into an error.
 */
// featreq-34627da1: the Letters page's per-client recipient picker.
describe('sendOneLetter - the recipients she chose', () => {
  const both = (recipients) => ({ ...OPTIONS, recipients })

  it('sends only the on-file addresses she left ticked, and claims and records exactly those', async () => {
    const deps = makeDeps()
    const result = await sendOneLetter(makeContext(), 'c-mixed', both({ 'c-mixed': { to: ['pat@acme.test'] } }), deps)
    expect(result).toMatchObject({ status: 'sent', to: ['pat@acme.test'] })
    expect(deps.sendMail.mock.calls[0][0].to).toEqual(['pat@acme.test'])
    expect(deps.store.rows[0].recipients).toEqual(['pat@acme.test'])
    expect(deps.store.amendments[0]).toMatchObject({ to: ['pat@acme.test'], party: { email: 'pat@acme.test' } })
  })

  it('adds the addresses for this send only, and the claim row stores the list actually used', async () => {
    const deps = makeDeps()
    const result = await sendOneLetter(
      makeContext(),
      'c-acme',
      both({ 'c-acme': { to: ['pat@acme.test'], extra: ['ap@other.test'] } }),
      deps,
    )
    expect(result).toMatchObject({ status: 'sent', to: ['pat@acme.test', 'ap@other.test'] })
    expect(deps.sendMail.mock.calls[0][0].to).toEqual(['pat@acme.test', 'ap@other.test'])
    expect(deps.store.rows[0].recipients).toEqual(['pat@acme.test', 'ap@other.test'])
  })

  it('refuses one-time addresses alone, an invalid one, or too many - claiming and sending nothing', async () => {
    for (const choice of [
      { to: [], extra: ['ap@other.test'] },
      { to: ['pat@acme.test'], extra: ['not an address'] },
      { to: ['pat@acme.test'], extra: ['a@x.test', 'b@x.test', 'c@x.test', 'd@x.test'] },
    ]) {
      const deps = makeDeps()
      const result = await sendOneLetter(makeContext(), 'c-acme', both({ 'c-acme': choice }), deps)
      expect(result, JSON.stringify(choice)).toMatchObject({ status: 'skipped', code: 'bad_recipients' })
      expect(result.message).toMatch(/nothing was sent/i)
      expect(deps.store.calls).toEqual([])
      expect(deps.sendMail).not.toHaveBeenCalled()
    }
  })

  // Strict (review round 1): a ticked address no longer on file skips the client, never dropped.
  it('skips a client whose ticked address is no longer on file, claiming and sending nothing', async () => {
    for (const choice of [{ to: ['nobody@else.test'] }, { to: ['pat@acme.test', 'gone@acme.test'] }]) {
      const deps = makeDeps()
      const result = await sendOneLetter(makeContext(), 'c-acme', both({ 'c-acme': choice }), deps)
      expect(result, JSON.stringify(choice)).toMatchObject({ status: 'skipped', code: 'recipients_changed' })
      expect(result.message).toBe(
        'The addresses on file for this client have changed. Reload and choose again. Nothing was sent to Acme Books LLC.',
      )
      expect(deps.store.calls).toEqual([])
      expect(deps.sendMail).not.toHaveBeenCalled()
    }
  })

  it('never mails a team member typed as a one-time address', async () => {
    const deps = makeDeps()
    const result = await sendOneLetter(
      makeContext({ teamEmails: new Set(['alex@ka-performancefl.com']) }),
      'c-acme',
      both({ 'c-acme': { to: ['pat@acme.test'], extra: ['Alex@KA-Performancefl.com'] } }),
      deps,
    )
    expect(result).toMatchObject({ status: 'skipped', code: 'team_address' })
    expect(result.message).toBe('Alex@KA-Performancefl.com belongs to a team member. A letter goes to the client only.')
    expect(deps.store.calls).toEqual([])
    expect(deps.sendMail).not.toHaveBeenCalled()
  })

  it('a client with no choice keeps the default (everyone on file), and another client\'s choice is not applied to it', async () => {
    const deps = makeDeps()
    const result = await sendOneLetter(makeContext(), 'c-mixed', both({ 'c-acme': { to: ['pat@acme.test'] } }), deps)
    expect(result.to).toEqual(['Alex@KA-Performancefl.com', 'pat@acme.test'])
  })

  it('the batch hands each client its own choice', async () => {
    const deps = makeDeps()
    const results = await sendLetterBatch(
      makeContext(),
      ['c-acme', 'c-mixed'],
      both({ 'c-mixed': { to: ['pat@acme.test'] } }),
      deps,
    )
    expect(results.map((result) => result.to)).toEqual([['pat@acme.test'], ['pat@acme.test']])
    expect(deps.sendMail.mock.calls.map((call) => call[0].to)).toEqual([['pat@acme.test'], ['pat@acme.test']])
  })
})

describe('sendOneLetter - the amendment record', () => {
  it('records one amendment per sent client, after the send, with the filled text, the party and the send', async () => {
    const sendMail = vi.fn(async () => {
      expect(deps.store.amendments).toHaveLength(0)
      return { ok: true, error: null, providerId: 're_9', status: 200 }
    })
    const deps = makeDeps({ sendMail })
    const result = await sendOneLetter(makeContext(), 'c-acme', OPTIONS, deps)
    expect(result).toMatchObject({ status: 'sent', engagementId: 'eng-1' })
    expect(deps.store.amendments).toHaveLength(1)
    const [record] = deps.store.amendments
    expect(record).toMatchObject({
      letterSendId: 'els-1',
      letterId: 'default',
      clientId: 'c-acme',
      providerId: 're_9',
      to: ['pat@acme.test'],
      createdBy: 'user-1',
      subject: 'Your 2027 1099s',
      emailBody: 'Hi Pat, our fee for Acme Books LLC is $500.00 per month.',
      letterBody: 'Dear Pat Doe,\n\nWe will prepare the 1099s for Acme Books LLC at $500.00 per month.',
      party: {
        company: 'Acme Books LLC',
        contactName: 'Pat Doe',
        email: 'pat@acme.test',
        addressLine1: '12 Main St',
        city: 'Nashville',
        state: 'TN',
        postalCode: '37201',
      },
    })
    expect(Number.isNaN(Date.parse(record.at))).toBe(false)
    // No placeholder is left in what was recorded: it is what the client received.
    expect(`${record.subject}${record.emailBody}${record.letterBody}`).not.toMatch(/\{\{/)
  })

  it('keeps bold runs marked in the record, filled inside', async () => {
    const template = { ...TEMPLATE, letterBody: 'Dear {{contact_name}},\n\nThe fee is **{{fee}}** a month.' }
    const deps = makeDeps()
    await sendOneLetter(makeContext({ template }), 'c-acme', OPTIONS, deps)
    expect(deps.store.amendments[0].letterBody).toBe('Dear Pat Doe,\n\nThe fee is **$500.00 per month** a month.')
  })

  // Review round 1: a client's value is never markup in the record, so a re-send of it
  // (an engagement send parses ** again) cannot bold part of a name.
  it('neutralizes ** inside a filled value, in plain and in bold runs, keeping the bold runs', async () => {
    const odd = { ...clients[0], id: 'c-stars', name: 'A**B Co' }
    const template = {
      ...TEMPLATE,
      emailBody: 'Hi {{contact_first_name}}, for {{client_name}}.',
      letterBody: 'Dear {{contact_name}},\n\nThe fee for {{client_name}} is **{{fee}}** for **{{client_name}}**.',
    }
    const deps = makeDeps()
    await sendOneLetter(makeContext({ template, data: { clients: [...clients, odd], contacts } }), 'c-stars', OPTIONS, deps)
    const [record] = deps.store.amendments
    expect(record.emailBody).toBe('Hi Pat, for A*\\*B Co.')
    expect(record.letterBody).toBe('Dear Pat Doe,\n\nThe fee for A*\\*B Co is **$500.00 per month** for **A*\\*B Co**.')
    // The only ** left are the bold runs' own markers.
    expect(record.letterBody.replace(/\*\*\$500\.00 per month\*\*|\*\*A\*\\\*B Co\*\*/g, '')).not.toContain('**')
  })

  it('records nothing for a skipped, already-sent or failed client', async () => {
    const deps = makeDeps()
    await sendOneLetter(makeContext(), 'c-nofee', OPTIONS, deps)
    await sendOneLetter(makeContext(), 'c-acme', OPTIONS, deps)
    await sendOneLetter(makeContext(), 'c-acme', OPTIONS, deps)
    expect(deps.store.amendments.map((row) => row.clientId)).toEqual(['c-acme'])
    const refused = makeDeps({ sendMail: vi.fn(async () => ({ ok: false, error: 'no', status: 422, providerId: null })) })
    await sendOneLetter(makeContext(), 'c-acme', OPTIONS, refused)
    expect(refused.store.amendments).toEqual([])
  })

  it('a failure to record is logged and the letter is still reported sent', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const deps = makeDeps({ store: fakeStore({ failRecord: true }) })
    const result = await sendOneLetter(makeContext(), 'c-acme', OPTIONS, deps)
    expect(result).toMatchObject({ status: 'sent', engagementId: null, to: ['pat@acme.test'] })
    expect(deps.store.rows[0].status).toBe('sent')
    expect(errors.mock.calls.some((call) => /could not be recorded as an amendment/.test(String(call[0])))).toBe(true)
    errors.mockRestore()
  })

  it('the batch records once per sent client, a billing master under the name its letter carries', async () => {
    const deps = makeDeps()
    const results = await sendLetterBatch(makeContext(), ['c-acme', 'c-nofee', 'c-master'], OPTIONS, deps)
    expect(results.map((r) => r.engagementId ?? null)).toEqual(['eng-1', null, 'eng-2'])
    expect(deps.store.amendments.map((row) => [row.clientId, row.letterSendId, row.party.company])).toEqual([
      ['c-acme', 'els-1', 'Acme Books LLC'],
      ['c-master', 'els-2', 'KLC Holdings'],
    ])
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

  // Brittany's leftovers: KLC-style billing. The sub's letter would reach the master's mailbox too.
  it('skips a sub-company whose billing master is in the same batch, before any claim, and sends the master', async () => {
    const deps = makeDeps()
    const results = await sendLetterBatch(makeContext(), ['c-sub', 'c-master'], OPTIONS, deps)
    expect(results[0]).toEqual({
      clientId: 'c-sub',
      clientName: 'KLC South',
      status: 'skipped',
      code: 'master_in_batch',
      masterId: 'c-master',
      masterName: 'KLC Holdings',
      message: "KLC South bills through KLC Holdings, which is in this batch - the master's letter covers it.",
    })
    expect(results[1]).toMatchObject({ clientId: 'c-master', status: 'sent' })
    // No claim row and no claim call for the sub; one mail, to the master's receiving company.
    expect(deps.store.rows.map((row) => row.clientId)).toEqual(['c-master'])
    expect(deps.store.calls.filter((call) => call[1] === 'c-sub')).toEqual([])
    expect(deps.sendMail).toHaveBeenCalledTimes(1)
    // A skip makes no provider call, so no gap.
    expect(deps.pause).not.toHaveBeenCalled()
  })

  it('says the master\'s letter did not go when the master itself was not sent, and keeps "covered" when it was sent today', async () => {
    // KLC Feeless has no fee, so its letter is skipped for the missing value.
    const deps = makeDeps()
    const results = await sendLetterBatch(makeContext(), ['c-sub-b', 'c-master-nofee'], OPTIONS, deps)
    expect(results[0]).toMatchObject({
      clientId: 'c-sub-b',
      status: 'skipped',
      code: 'master_in_batch',
      message:
        "Feeless South was skipped because Feeless Master was in this batch, but Feeless Master's letter did not go - send Feeless South on its own or fix Feeless Master first.",
    })
    expect(results[1]).toMatchObject({ clientId: 'c-master-nofee', status: 'skipped', code: 'missing_placeholder' })

    // A master already sent today is covered: the sentence stays the first one.
    const again = makeDeps()
    await sendLetterBatch(makeContext(), ['c-master'], OPTIONS, again)
    const second = await sendLetterBatch(makeContext(), ['c-sub', 'c-master'], OPTIONS, again)
    expect(second.map((r) => [r.clientId, r.code])).toEqual([['c-sub', 'master_in_batch'], ['c-master', 'already_sent']])
    expect(second[0].message).toMatch(/the master's letter covers it\.$/)
  })

  describe('reconcileCoveredResults', () => {
    const sub = { clientId: 's1', clientName: 'Feeless South', status: 'skipped', code: 'master_in_batch', masterId: 'm1', masterName: 'Feeless Master', message: 'x' }
    const covered = "Feeless South bills through Feeless Master, which is in this batch - the master's letter covers it."
    const withMaster = (master) => reconcileCoveredResults([sub, { clientId: 'm1', clientName: 'Feeless Master', ...master }])[0]

    it('keeps a sub covered when its master was sent, was already sent today, or has another owner\'s send running now', () => {
      for (const master of [{ status: 'sent' }, { status: 'skipped', code: 'already_sent' }, { status: 'skipped', code: 'sending_now' }]) {
        expect(withMaster(master).message).toBe(covered)
      }
    })

    it('says the master\'s letter did not go for a skipped or failed master, and something neutral for an unfinished one', () => {
      expect(withMaster({ status: 'skipped', code: 'missing_placeholder' }).message).toMatch(/Feeless Master's letter did not go - send Feeless South on its own/)
      expect(withMaster({ status: 'failed', code: 'provider' }).message).toMatch(/letter did not go/)
      const unsure = withMaster({ status: 'skipped', code: 'unfinished' }).message
      expect(unsure).toBe("Feeless South was skipped because Feeless Master was in this batch, but Feeless Master's earlier send never finished - check Feeless Master's send first.")
      expect(unsure).not.toMatch(/did not go/)
    })

    it('switches back to covered when a later Send again sends the master, and back again if it fails', () => {
      const first = reconcileCoveredResults([sub, { clientId: 'm1', clientName: 'Feeless Master', status: 'skipped', code: 'missing_placeholder' }])
      expect(first[0].message).toMatch(/did not go/)
      const second = reconcileCoveredResults([first[0], { clientId: 'm1', clientName: 'Feeless Master', status: 'sent' }])
      expect(second[0].message).toBe(covered)
      const third = reconcileCoveredResults([second[0], { clientId: 'm1', clientName: 'Feeless Master', status: 'failed', code: 'provider' }])
      expect(third[0].message).toMatch(/did not go/)
    })

    it('leaves the sub\'s result alone when the master\'s letter was deleted, or when the master has no result', () => {
      expect(withMaster({ status: 'failed', code: 'letter_deleted' })).toEqual(sub)
      expect(reconcileCoveredResults([sub])[0]).toEqual(sub)
    })

    it('treats a master with no result as "did not go" when told its request failed', () => {
      expect(reconcileCoveredResults([sub], { missingMasterDidNotGo: true })[0].message).toMatch(/Feeless Master's letter did not go/)
    })
  })

  it('sees the master in the whole send when the page splits it into requests of ten', async () => {
    const deps = makeDeps()
    const results = await sendLetterBatch(makeContext(), ['c-sub'], { ...OPTIONS, batch: ['c-master', 'c-acme', 'c-sub'] }, deps)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ code: 'master_in_batch', masterId: 'c-master', masterName: 'KLC Holdings' })
    expect(deps.store.calls).toEqual([])
    expect(deps.sendMail).not.toHaveBeenCalled()
  })

  it('a deleted letter fails every remaining client the same way and stops the loop', async () => {
    const deps = makeDeps({ store: fakeStore({ deletedLetter: 'default' }) })
    const results = await sendLetterBatch(makeContext(), ['c-nofee', 'c-acme', 'c-mixed', 'gone-client'], OPTIONS, deps)
    // c-nofee is skipped for its missing fee before any claim; c-acme is the first claim, which finds the letter gone.
    expect(results.map((r) => [r.clientId, r.status, r.code])).toEqual([
      ['c-nofee', 'skipped', 'missing_placeholder'],
      ['c-acme', 'failed', 'letter_deleted'],
      ['c-mixed', 'failed', 'letter_deleted'],
      ['gone-client', 'failed', 'letter_deleted'],
    ])
    expect(results[2]).toMatchObject({ clientName: 'Mixed Co', message: 'This letter was deleted before the send started.' })
    expect(results[3].clientName).toBeNull()
    // Only the one claim was tried; nothing was mailed.
    expect(deps.store.calls.filter((call) => call[0] === 'claim')).toEqual([['claim', 'c-acme', 1]])
    expect(deps.sendMail).not.toHaveBeenCalled()
  })

  it('sends a sub-company on its own when its master is not in the batch', async () => {
    const deps = makeDeps()
    const results = await sendLetterBatch(makeContext(), ['c-sub', 'c-acme'], OPTIONS, deps)
    expect(results.map((r) => [r.clientId, r.status])).toEqual([['c-sub', 'sent'], ['c-acme', 'sent']])
    expect(deps.store.rows.map((row) => row.clientId)).toEqual(['c-sub', 'c-acme'])
  })

  it('names a client that is no longer on file even when the loop throws for it', async () => {
    const deps = makeDeps({ store: fakeStore({ failClaimFor: 'c-acme' }) })
    const results = await sendLetterBatch(makeContext(), ['c-acme'], OPTIONS, deps)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ clientName: 'Acme Books LLC', status: 'failed' })
  })
})
