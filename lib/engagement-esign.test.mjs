import { describe, expect, it, vi } from 'vitest'

import {
  ESIGN_WITHDRAW_TIMEOUT_MS,
  withdrawOpenSignatureRequests,
  withdrawReasonFor,
  withdrawSignatureRequest,
  ESIGN_EXPIRES_IN_DAYS,
  ESIGN_MESSAGE,
  esignPdfBuilder,
  remindEngagementSignature,
  sendEngagementForSignature,
} from './engagement-esign.js'
import { engagementEsignHash, engagementHash } from './engagement-hash.js'
import { EsignaturesError } from './esignatures.js'
import { SignwellError } from './signwell.js'

/**
 * Sending an engagement for signature and reminding (featreq-56d39567), run for real against
 * a recorded store and a recorded SignWell module: what stops a send and in which order, the
 * one SignWell call and what it carries, and a bookkeeping failure that must not turn a
 * document that left into a failure. The letter's PDF builder is a stub here (the real one
 * has its own tests, lib/letter-pdf.test.mjs); the preview and its refusals are the real ones.
 */
const NOW = new Date('2026-10-21T16:00:00Z')
const FIRM = { name: 'PB&J Strategic Accounting', email: 'hello@pbjsa.com', clientDefaults: { paymentTerms: '' } }
const PDF = Buffer.from('%PDF-1.4 stub letter')
const ENV = { SIGNWELL_API_KEY: 'sw_fake_key_1234567890' }

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
      email: 'pat@example.invalid',
      phone: '',
      addressLine1: '9 Elm St',
      addressLine2: '',
      city: 'Franklin',
      state: 'TN',
      postalCode: '37064',
    },
    subject: 'Engagement letter - {{client_name}}',
    emailBody: 'Hi {{contact_first_name}},\n\nAttached is our engagement letter.\n\n{{sender_name}}',
    letterBody: 'Dear {{contact_name}},\n\n**Fees**\n\nOur fee is {{fee}}.\n\nSignature: ______\nDate: ______',
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
    updatedAt: '2026-10-21T15:00:00.000Z',
    ...over,
  }
  return { ...base, templateHash: engagementHash(base) }
}

const context = (over = {}) => ({
  data: { clients: [], contacts: [] },
  firmSettings: FIRM,
  senderName: 'Brittany',
  now: NOW,
  teamEmails: new Set(['alex@ka-performancefl.example', 'brittany@pbjsa.example']),
  replyTo: 'brittany@pbjsa.example',
  ...over,
})

function setup({ active = null, createFails = null, recordFails = false, logFails = false, env = ENV, signwellFails = null } = {}) {
  const store = {
    activeSignatureRequestForEngagement: vi.fn(async () => active),
    createSignatureRequest: vi.fn(async (row) => {
      if (recordFails) throw new Error('db down for pat@example.invalid')
      return { id: 'sigreq-1', ...row, lastRemindedAt: null }
    }),
    markEngagementEsigned: vi.fn(async (id, entry) => {
      if (logFails) throw new Error('db down')
      return { id, status: 'sent', emailLog: [{ kind: 'esign', ...entry }] }
    }),
    updateSignatureRequest: vi.fn(async (id, patch) => ({ id, ...patch })),
  }
  const signwell = {
    createDocumentFromFile: vi.fn(async () => {
      if (signwellFails ?? createFails) throw signwellFails ?? createFails
      return { id: 'doc-1', status: 'Created', recipients: [{ id: '1', signing_url: 'https://sign.example.invalid/secret' }] }
    }),
    sendReminder: vi.fn(async () => null),
  }
  const buildPdf = vi.fn(async () => PDF)
  const deps = { store, signwell, env, publicUrl: 'https://app.example.invalid/', buildPdf, isPureRecord: () => false }
  return { store, signwell, buildPdf, deps }
}

const send = (eng, deps, ctx = context(), options = {}) =>
  sendEngagementForSignature(ctx, eng, { templateHash: eng.templateHash, userId: 'emp-patrice', ...options }, deps)

describe('sendEngagementForSignature: refusals (nothing reaches SignWell)', () => {
  it('refuses without a SignWell key, before anything else', async () => {
    const { deps, signwell, store } = setup({ env: {} })
    const result = await send(engagement(), deps)
    expect(result.refused).toMatchObject({ status: 409, error: 'signwell_not_configured' })
    expect(result.refused.message).toMatch(/Nothing was sent/)
    expect(signwell.createDocumentFromFile).not.toHaveBeenCalled()
    expect(store.createSignatureRequest).not.toHaveBeenCalled()
  })

  it('refuses a page hash that is not the stored letter\'s', async () => {
    const { deps, signwell } = setup()
    const result = await sendEngagementForSignature(context(), engagement(), { templateHash: 'stale', userId: 'u' }, deps)
    expect(result.refused).toMatchObject({ status: 409, error: 'engagement_changed' })
    expect(signwell.createDocumentFromFile).not.toHaveBeenCalled()
  })

  it.each(['signed', 'superseded', 'void'])('refuses a %s engagement', async (status) => {
    const { deps, signwell } = setup()
    const result = await send(engagement({ status }), deps)
    expect(result.refused).toMatchObject({ status: 409, error: 'engagement_refused' })
    expect(result.refused.message).toContain(status)
    expect(signwell.createDocumentFromFile).not.toHaveBeenCalled()
  })

  it('refuses a client signing would refuse: a billing master, a retired client, a missing one', async () => {
    const cases = [
      [{ id: 'c1', name: 'Master Co', isBillingMaster: true }, /billing master/],
      [{ id: 'c1', name: 'Old Co', lifecycleStage: 'inactive' }, /is retired/],
    ]
    for (const [client, pattern] of cases) {
      const { deps, signwell } = setup()
      const result = await send(engagement({ clientId: 'c1' }), deps, context({ data: { clients: [client], contacts: [] } }))
      expect(result.refused).toMatchObject({ status: 409, error: 'client_refused' })
      expect(result.refused.message).toMatch(pattern)
      expect(signwell.createDocumentFromFile).not.toHaveBeenCalled()
    }
    const { deps } = setup()
    const missing = await send(engagement({ clientId: 'gone' }), deps)
    expect(missing.refused).toMatchObject({ error: 'client_refused' })
    expect(missing.refused.message).toMatch(/no longer exists/)
  })

  it('lets a pure-record amendment through for a master or retired client (signing records the signature only)', async () => {
    const { deps, signwell } = setup()
    deps.isPureRecord = () => true
    const client = { id: 'c1', name: 'Master Co', isBillingMaster: true }
    const result = await send(engagement({ clientId: 'c1', status: 'sent' }), deps, context({ data: { clients: [client], contacts: [] } }))
    expect(result.ok).toBe(true)
    expect(signwell.createDocumentFromFile).toHaveBeenCalledTimes(1)
  })

  it('refuses while a request is active, naming it so the page can offer Send reminder', async () => {
    const { deps, signwell } = setup({ active: { id: 'sigreq-9', status: 'viewed', sentAt: '2026-10-20T15:00:00.000Z' } })
    const result = await send(engagement(), deps)
    expect(result.refused).toMatchObject({ status: 409, error: 'signature_active', requestId: 'sigreq-9' })
    expect(result.refused.message).toMatch(/already out for signature .*Oct 20.*Send a reminder instead/)
    expect(signwell.createDocumentFromFile).not.toHaveBeenCalled()
  })

  it('refuses unknown and retired placeholders, missing values and an empty letter', async () => {
    const unknown = await send(engagement({ letterBody: 'Dear {{contact_name}}, {{no_such_thing}}' }), setup().deps)
    expect(unknown.refused).toMatchObject({ status: 409, error: 'unknown_placeholder', unknown: ['no_such_thing'] })
    const missing = await send(engagement({ emailBody: 'Hi {{contact_first_name}}, {{retainer_amount}} {{software_total}}' }), setup().deps)
    expect(['missing_placeholder', 'unknown_placeholder']).toContain(missing.refused.error)
    const empty = await send(engagement({ letterBody: '   ' }), setup().deps)
    expect(empty.refused).toMatchObject({ status: 409, error: 'engagement_empty' })
  })

  // Task 17: initials and extra signature fields typed into the body are SignWell's, not typos.
  it('sends a letter with initials and an extra signature field in the body, the tags handed to the PDF as tag runs', async () => {
    const { deps, signwell, buildPdf } = setup()
    const eng = engagement({
      letterBody: 'Dear {{contact_name}},\n\nInitial each term: {{initial:1:y}}\n\nSecond signature {{signature:1:y}}\n\nSignature: ______\nDate: ______',
    })
    const result = await send(eng, deps)
    expect(result.refused).toBeUndefined()
    expect(result.ok).toBe(true)
    expect(signwell.createDocumentFromFile).toHaveBeenCalledTimes(1)
    const drawn = buildPdf.mock.calls[0][0].paragraphs.flat()
    expect(drawn.filter((run) => run.esignTag).map((run) => run.text)).toEqual(['{{initial:1:y}}', '{{signature:1:y}}'])

    const second = await send(engagement({ letterBody: 'Initial {{i:2:y}}' }), setup().deps)
    expect(second.refused).toMatchObject({ status: 409, error: 'unknown_placeholder', unknown: ['i:2:y'] })
    expect(second.refused.message).toMatch(/names signer 2, but a letter goes to one signer/)
  })

  it('refuses an e-sign field tag in the subject or the email body, and nothing reaches SignWell', async () => {
    for (const over of [{ subject: 'Sign {{initial:1:y}}' }, { emailBody: 'Hi,\n\nPlease sign {{signature:1:y}}' }]) {
      const { deps, signwell } = setup()
      const result = await send(engagement(over), deps)
      expect(result.refused, JSON.stringify(over)).toMatchObject({ status: 409, error: 'unknown_placeholder' })
      expect(result.refused.message).toBe('E-sign fields belong in the letter, not the email. Nothing was sent.')
      expect(signwell.createDocumentFromFile).not.toHaveBeenCalled()
    }
  })

  it('never e-signs to a team mailbox', async () => {
    for (const email of ['alex@ka-performancefl.example', 'Alex Owner <ALEX@ka-performancefl.example>', 'pat@example.invalid, alex@ka-performancefl.example']) {
      const { deps, signwell } = setup()
      const result = await send(engagement({ party: { ...engagement().party, email } }), deps)
      expect(['team_address', 'no_recipient'], email).toContain(result.refused.error)
      expect(signwell.createDocumentFromFile).not.toHaveBeenCalled()
    }
  })

  it('needs one plain email address for the signer: none, a named one, a list', async () => {
    const none = await send(engagement({ party: { ...engagement().party, email: '' } }), setup().deps)
    expect(none.refused).toMatchObject({ status: 409, error: 'no_recipient' })
    for (const email of ['Pat Doe <pat@example.invalid>', 'pat@example.invalid; sam@example.invalid']) {
      const { deps, signwell } = setup()
      const result = await send(engagement({ party: { ...engagement().party, email } }), deps)
      expect(['invalid_recipient', 'team_address'], email).toContain(result.refused.error)
      expect(signwell.createDocumentFromFile).not.toHaveBeenCalled()
    }
  })

  it('refuses when the PDF cannot be built', async () => {
    const { deps, signwell } = setup()
    deps.buildPdf = vi.fn(async () => {
      throw new Error('pdf boom')
    })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await send(engagement(), deps)
    errors.mockRestore()
    expect(result.refused).toMatchObject({ status: 502, error: 'pdf_failed' })
    expect(signwell.createDocumentFromFile).not.toHaveBeenCalled()
  })
})

describe('sendEngagementForSignature: the send', () => {
  it('creates ONE SignWell document for the party and records the request and the log', async () => {
    const { deps, signwell, store, buildPdf } = setup()
    const eng = engagement({ clientId: 'c1', status: 'sent' })
    const clients = [{ id: 'c1', name: 'Acme Books', isBillingMaster: false, lifecycleStage: 'active' }]
    const result = await send(eng, deps, context({ data: { clients, contacts: [] } }))

    expect(result.ok).toBe(true)
    expect(signwell.createDocumentFromFile).toHaveBeenCalledTimes(1)
    const [args, options] = signwell.createDocumentFromFile.mock.calls[0]
    expect(Buffer.from(args.fileBase64, 'base64').equals(PDF)).toBe(true)
    expect(args.fileName).toMatch(/^Engagement-Letter-Acme-Books-\d{4}\.pdf$/)
    expect(args.name).toBe('Acme Books - Engagement letter')
    expect(args.subject).toBe('Engagement letter - Acme Books')
    // A fixed message: the letter's own email asks for a signed copy by reply, which is wrong here.
    expect(args.message).toBe('Please review and sign your engagement letter electronically where indicated.')
    expect(args.message).toBe(ESIGN_MESSAGE)
    expect(args.recipients).toEqual([{ id: '1', name: 'Pat Doe', email: 'pat@example.invalid' }])
    expect(args.textTags).toBe(true)
    expect(args.fields).toBeUndefined()
    expect(args.metadata).toEqual({ engagement_id: 'eng-1', client_id: 'c1', app: 'pbjbillingapp' })
    expect(args.expiresIn).toBe(ESIGN_EXPIRES_IN_DAYS)
    expect(ESIGN_EXPIRES_IN_DAYS).toBe(30)
    expect(args.redirectUrl).toBe('https://app.example.invalid/signed-thank-you')
    // Test mode unless SIGNWELL_TEST_MODE is the literal false.
    expect(args.testMode).toBe(true)
    expect(options).toEqual({ env: ENV })
    expect(buildPdf).toHaveBeenCalledTimes(1)

    expect(store.createSignatureRequest).toHaveBeenCalledWith({
      engagementId: 'eng-1',
      clientId: 'c1',
      signwellDocumentId: 'doc-1',
      status: 'sent',
      recipients: [{ id: '1', name: 'Pat Doe', email: 'pat@example.invalid' }],
      testMode: true,
      // The letter AND its signing details as they went to SignWell: signing later needs them unchanged.
      esignHash: engagementEsignHash(eng),
      sentAt: expect.any(String),
      createdBy: 'emp-patrice',
    })
    expect(store.markEngagementEsigned).toHaveBeenCalledWith('eng-1', {
      to: ['pat@example.invalid'],
      signatureRequestId: 'sigreq-1',
      testMode: true,
      subject: 'Engagement letter - Acme Books',
      hash: engagementHash(eng),
      at: expect.any(String),
    })
    expect(result.request.id).toBe('sigreq-1')
    expect(result.engagement.emailLog[0].kind).toBe('esign')
    // SignWell's signing link never leaves SignWell: it is neither stored nor returned.
    expect(JSON.stringify([store.createSignatureRequest.mock.calls, result])).not.toContain('sign.example.invalid')
  })

  it('goes live only for the literal SIGNWELL_TEST_MODE=false', async () => {
    const live = setup({ env: { ...ENV, SIGNWELL_TEST_MODE: 'false' } })
    await send(engagement(), live.deps)
    expect(live.signwell.createDocumentFromFile.mock.calls[0][0].testMode).toBe(false)
    expect(live.store.createSignatureRequest.mock.calls[0][0].testMode).toBe(false)
    const unset = setup({ env: { ...ENV, SIGNWELL_TEST_MODE: 'yes' } })
    await send(engagement(), unset.deps)
    expect(unset.signwell.createDocumentFromFile.mock.calls[0][0].testMode).toBe(true)
  })

  it('omits client_id from the metadata for a prospect with no client yet', async () => {
    const { deps, signwell } = setup()
    await send(engagement(), deps)
    expect(signwell.createDocumentFromFile.mock.calls[0][0].metadata).toEqual({ engagement_id: 'eng-1', app: 'pbjbillingapp' })
  })

  it('one document per double click: a second send while the first is on its way is refused', async () => {
    const { deps, signwell } = setup()
    let release
    signwell.createDocumentFromFile.mockImplementationOnce(
      () => new Promise((resolve) => {
        release = () => resolve({ id: 'doc-1' })
      }),
    )
    const first = send(engagement(), deps)
    await vi.waitFor(() => expect(signwell.createDocumentFromFile).toHaveBeenCalledTimes(1))
    const second = await send(engagement(), deps)
    expect(second.refused).toMatchObject({ status: 409, error: 'signature_active' })
    release()
    expect((await first).ok).toBe(true)
    expect(signwell.createDocumentFromFile).toHaveBeenCalledTimes(1)
  })

  it('holds the letter in flight from the quick refusals until the request is recorded: a double click in either window makes one document', async () => {
    // Window 1: while the PDF is being built (before SignWell is asked at all).
    const building = setup()
    let finishBuild
    building.deps.buildPdf = vi.fn(() => new Promise((resolve) => {
      finishBuild = () => resolve(PDF)
    }))
    const first = send(engagement(), building.deps)
    await vi.waitFor(() => expect(building.deps.buildPdf).toHaveBeenCalledTimes(1))
    const during = await send(engagement(), building.deps)
    expect(during.refused).toMatchObject({ status: 409, error: 'signature_active' })
    expect(building.deps.buildPdf).toHaveBeenCalledTimes(1)
    finishBuild()
    expect((await first).ok).toBe(true)
    expect(building.signwell.createDocumentFromFile).toHaveBeenCalledTimes(1)

    // Window 2: SignWell has answered but the request row is not written yet.
    const recording = setup()
    let finishRecord
    recording.store.createSignatureRequest.mockImplementation(
      (row) => new Promise((resolve) => {
        finishRecord = () => resolve({ id: 'sigreq-1', ...row, lastRemindedAt: null })
      }),
    )
    const second = send(engagement(), recording.deps)
    await vi.waitFor(() => expect(recording.store.createSignatureRequest).toHaveBeenCalledTimes(1))
    const between = await send(engagement(), recording.deps)
    expect(between.refused).toMatchObject({ status: 409, error: 'signature_active' })
    expect(recording.signwell.createDocumentFromFile).toHaveBeenCalledTimes(1)
    finishRecord()
    expect((await second).ok).toBe(true)
    // Released afterwards: with the row written (and no active request in this fake) a later send is allowed.
    recording.store.createSignatureRequest.mockImplementation(async (row) => ({ id: 'sigreq-1', ...row, lastRemindedAt: null }))
    expect((await send(engagement(), recording.deps)).ok).toBe(true)
  })

  it('holds the letter BEFORE asking whether one is already out: two clicks cannot both pass the question', async () => {
    const { deps, store, signwell } = setup()
    let answerActive
    store.activeSignatureRequestForEngagement.mockImplementationOnce(() => new Promise((resolve) => {
      answerActive = () => resolve(null)
    }))
    const first = send(engagement(), deps)
    await vi.waitFor(() => expect(store.activeSignatureRequestForEngagement).toHaveBeenCalledTimes(1))
    const second = await send(engagement(), deps)
    expect(second.refused).toMatchObject({ status: 409, error: 'signature_active' })
    // The second click never reached the question.
    expect(store.activeSignatureRequestForEngagement).toHaveBeenCalledTimes(1)
    answerActive()
    expect((await first).ok).toBe(true)
    expect(signwell.createDocumentFromFile).toHaveBeenCalledTimes(1)
    // The hold is released when the question itself answers "already out".
    store.activeSignatureRequestForEngagement.mockResolvedValueOnce({ id: 'sigreq-9', status: 'sent' })
    expect((await send(engagement(), deps)).refused.error).toBe('signature_active')
    store.activeSignatureRequestForEngagement.mockResolvedValue(null)
    expect((await send(engagement(), deps)).ok).toBe(true)
  })

  it('releases the hold on every way out: a refusal after it, a SignWell failure, a record failure', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const pdfFails = setup()
    pdfFails.deps.buildPdf = vi.fn(async () => {
      throw new Error('pdf boom')
    })
    expect((await send(engagement(), pdfFails.deps)).refused.error).toBe('pdf_failed')
    pdfFails.deps.buildPdf = vi.fn(async () => PDF)
    expect((await send(engagement(), pdfFails.deps)).ok).toBe(true)

    const recordFails = setup({ recordFails: true })
    expect((await send(engagement(), recordFails.deps)).refused.error).toBe('esign_record_failed')
    recordFails.store.createSignatureRequest.mockImplementation(async (row) => ({ id: 'sigreq-1', ...row }))
    expect((await send(engagement(), recordFails.deps)).ok).toBe(true)

    const missing = setup()
    missing.deps.buildPdf = vi.fn(async () => {
      throw new Error('boom')
    })
    // Refused for a missing recipient before the PDF is built: nothing is held afterwards.
    const noEmail = await send(engagement({ party: { ...engagement().party, email: '' } }), missing.deps)
    expect(noEmail.refused.error).toBe('no_recipient')
    missing.deps.buildPdf = vi.fn(async () => PDF)
    expect((await send(engagement(), missing.deps)).ok).toBe(true)
    errors.mockRestore()
  })

  it('says what SignWell refused in plain words, records nothing, and lets a retry through', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cases = [
      [new SignwellError('x', { status: 401 }), /rejected the API key/],
      [new SignwellError('x', { status: 429 }), /busy right now/],
      [new SignwellError('x', { status: 422, signwellMessage: 'Bad email pat@example.invalid' }), /refused the document: Bad email \[email\]\. Nothing was sent/],
      [new SignwellError('x', { code: 'network' }), /could not be reached/],
      [new Error('weird'), /could not be asked/],
    ]
    for (const [failure, pattern] of cases) {
      const { deps, store } = setup({ signwellFails: failure })
      const result = await send(engagement(), deps)
      expect(result.refused).toMatchObject({ status: 502, error: 'esign_failed' })
      expect(result.refused.message).toMatch(pattern)
      expect(result.refused.message).not.toContain('pat@example.invalid')
      expect(store.createSignatureRequest).not.toHaveBeenCalled()
      expect(store.markEngagementEsigned).not.toHaveBeenCalled()
      // The in-flight mark is gone: the same letter can be sent again.
      const again = await send(engagement(), setup().deps)
      expect(again.ok).toBe(true)
    }
    errors.mockRestore()
  })

  it('a request row that cannot be written says SignWell has the document, and logs no address', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { deps, store } = setup({ recordFails: true })
    const result = await send(engagement(), deps)
    expect(result.refused).toMatchObject({ status: 500, error: 'esign_record_failed' })
    expect(result.refused.message).toContain('doc-1')
    expect(store.markEngagementEsigned).not.toHaveBeenCalled()
    expect(JSON.stringify(errors.mock.calls)).not.toContain('pat@example.invalid')
    errors.mockRestore()
  })

  it('a log that cannot be written never turns a document that left into a failure', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const eng = engagement()
    const { deps } = setup({ logFails: true })
    const result = await send(eng, deps)
    errors.mockRestore()
    expect(result.ok).toBe(true)
    expect(result.request.id).toBe('sigreq-1')
    expect(result.engagement).toBe(eng)
  })

  it('the e-signature PDF says to sign where indicated, not to return a copy by reply; a rewritten closing is left alone', async () => {
    const closing = 'If this letter reflects your understanding of our engagement, please sign below and return a copy to us by replying to the email it came with. We look forward to working with you.'
    const text = async (bodyText, paragraphs) => {
      const buffer = await esignPdfBuilder({ bodyText, paragraphs, client: { name: 'Acme Books' }, firmSettings: FIRM, dateLabel: 'October 21, 2026', compress: false })
      const raw = buffer.toString('latin1')
      return [...raw.matchAll(/\[([^\]]*)\]\s*TJ/g)]
        .map((match) => [...match[1].matchAll(/<([0-9A-Fa-f]*)>/g)].map((hex) => Buffer.from(hex[1], 'hex').toString('latin1')).join(''))
        .join('\n')
        .replace(/\s+/g, ' ')
    }
    const electronic = await text(closing, [[{ text: closing, bold: false }]])
    expect(electronic).toContain('please sign electronically where indicated')
    expect(electronic).not.toContain('replying')
    expect(electronic).toContain('We look forward to working with you.')
    // Written her own way: untouched.
    const own = 'Sign here and post it back to us.'
    expect(await text(own, [[{ text: own, bold: false }]])).toContain(own)
    // Plain text alone (no runs) is read the same way.
    expect(await text(closing)).toContain('please sign electronically where indicated')
  })

  it('the default PDF builder writes the signature and date tags into the letter', async () => {
    const buffer = await esignPdfBuilder({
      bodyText: 'Dear Pat,\n\nSignature: ______\nDate: ______',
      client: { name: 'Acme Books' },
      firmSettings: FIRM,
      dateLabel: 'October 21, 2026',
      title: 'Engagement letter',
      compress: false,
    })
    const raw = buffer.toString('latin1').toLowerCase()
    for (const tag of ['{{signature:1:y}}', '{{date:1:y}}']) {
      expect(raw).toContain(Buffer.from(tag, 'latin1').toString('hex'))
    }
  })
})

describe('remindEngagementSignature', () => {
  const active = (over = {}) => ({ id: 'sigreq-1', signwellDocumentId: 'doc-1', status: 'sent', lastRemindedAt: null, ...over })
  const remind = (deps) => remindEngagementSignature('eng-1', { now: NOW, ...deps })

  it('refuses when nothing is out for signature', async () => {
    const { deps, signwell } = setup()
    const result = await remind(deps)
    expect(result.refused).toMatchObject({ status: 409, error: 'no_active_signature' })
    expect(signwell.sendReminder).not.toHaveBeenCalled()
  })

  it('reminds the active request once and stamps it', async () => {
    const { deps, signwell, store } = setup({ active: active() })
    const result = await remind(deps)
    expect(result.ok).toBe(true)
    expect(signwell.sendReminder).toHaveBeenCalledWith('doc-1', { env: ENV })
    expect(store.updateSignatureRequest).toHaveBeenCalledWith('sigreq-1', { lastRemindedAt: NOW.toISOString() })
    expect(result.request.lastRemindedAt).toBe(NOW.toISOString())
  })

  it('only once per firm day: refused the same day, allowed the next, and the day is the firm\'s not UTC', async () => {
    const sameDay = setup({ active: active({ lastRemindedAt: '2026-10-21T13:30:00.000Z' }) })
    const refused = await remind(sameDay.deps)
    expect(refused.refused).toMatchObject({ status: 409, error: 'reminded_today', requestId: 'sigreq-1' })
    expect(sameDay.signwell.sendReminder).not.toHaveBeenCalled()

    const yesterday = setup({ active: active({ lastRemindedAt: '2026-10-20T20:00:00.000Z' }) })
    expect((await remind(yesterday.deps)).ok).toBe(true)

    // 01:00 UTC on the 22nd is still the evening of the 21st in Eastern time: the same firm day.
    const lateEvening = setup({ active: active({ lastRemindedAt: '2026-10-22T01:00:00.000Z' }) })
    const result = await remindEngagementSignature('eng-1', { ...lateEvening.deps, now: new Date('2026-10-22T02:00:00Z') })
    expect(result.refused?.error).toBe('reminded_today')
  })

  it('answers a status SignWell cannot remind (422) as a plain 409, and other failures as 502', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cannot = setup({ active: active() })
    cannot.signwell.sendReminder.mockRejectedValue(new SignwellError('x', { status: 422 }))
    const first = await remind(cannot.deps)
    expect(first.refused).toMatchObject({ status: 409, error: 'esign_cannot_remind' })
    expect(cannot.store.updateSignatureRequest).not.toHaveBeenCalled()

    const down = setup({ active: active() })
    down.signwell.sendReminder.mockRejectedValue(new SignwellError('x', { code: 'network' }))
    const second = await remind(down.deps)
    expect(second.refused).toMatchObject({ status: 502, error: 'esign_failed' })
    expect(second.refused.message).toMatch(/No reminder was sent/)
    errors.mockRestore()
  })
})

/**
 * eSignatures.io as the provider (task 18): with its token set, a send makes a Markdown template from the
 * FILLED letter and a contract from it; SignWell is never asked. The refusals are the same ones.
 */
describe('sendEngagementForSignature through eSignatures.io', () => {
  const ES_ENV = { ESIGNATURES_SECRET_TOKEN: 'es_fake_token_1234567890' }
  function esSetup({ env = ES_ENV, active = null, templateFails = null, contractFails = null, recordFails = false } = {}) {
    const base = setup({ env, active, recordFails })
    const esignatures = {
      createTemplate: vi.fn(async () => {
        if (templateFails) throw templateFails
        return 'tpl-1'
      }),
      createContract: vi.fn(async () => {
        if (contractFails) throw contractFails
        return { id: 'ctr-1', status: 'sent', signers: [{ id: 'signer-1', sign_page_url: 'https://esignatures.example.invalid/sign/secret' }] }
      }),
      resendToSigner: vi.fn(async () => ({ status: 'queued' })),
    }
    base.deps.esignatures = esignatures
    // The default builder (Markdown) is what an eSignatures send uses: the PDF stub is not involved.
    delete base.deps.buildPdf
    return { ...base, esignatures }
  }

  it('makes ONE template from the filled letter and ONE contract, and records the request with its provider, template and signer', async () => {
    const { deps, esignatures, signwell, store } = esSetup()
    const eng = engagement({ clientId: 'c1', status: 'sent' })
    const clients = [{ id: 'c1', name: 'Acme Books', isBillingMaster: false, lifecycleStage: 'active' }]
    const result = await send(eng, deps, context({ data: { clients, contacts: [] } }))
    expect(result.ok).toBe(true)
    expect(signwell.createDocumentFromFile).not.toHaveBeenCalled()

    expect(esignatures.createTemplate).toHaveBeenCalledTimes(1)
    const [template, templateOptions] = esignatures.createTemplate.mock.calls[0]
    expect(template.title).toMatch(/^Acme Books - Engagement letter [A-Z][a-z]+ \d{1,2}, \d{4}$/)
    expect(templateOptions).toEqual({ env: ES_ENV })
    // The letter as Markdown: filled, firm heading, bold kept, no placeholder left, no signature lines.
    expect(template.markdown).toMatch(/^## PB&J Strategic Accounting\n/)
    expect(template.markdown).toContain('Dear Pat Doe,')
    expect(template.markdown).toContain('**Fees**')
    expect(template.markdown).not.toContain('{{')
    expect(template.markdown).not.toMatch(/Signature:|Date:|_{3,}/)

    expect(esignatures.createContract).toHaveBeenCalledTimes(1)
    const [contract, contractOptions] = esignatures.createContract.mock.calls[0]
    expect(contractOptions).toEqual({ env: ES_ENV })
    expect(contract).toEqual({
      templateId: 'tpl-1',
      title: template.title,
      signers: [{ name: 'Pat Doe', email: 'pat@example.invalid' }],
      testMode: true,
      expiresInHours: 30 * 24,
      metadata: JSON.stringify({ engagement_id: 'eng-1', client_id: 'c1', app: 'pbjbillingapp', esign_hash: engagementEsignHash(eng) }),
      // Fixed wording, never the letter's own email (it asks for a signed copy by reply).
      emails: {
        signatureRequestSubject: 'Please sign your engagement letter - PB&J Strategic Accounting',
        signatureRequestText: ESIGN_MESSAGE,
        finalContractSubject: 'Your signed engagement letter',
        finalContractText: 'Thank you for signing your engagement letter with PB&J Strategic Accounting.',
        replyTo: 'brittany@pbjsa.example',
      },
      companyName: 'PB&J Strategic Accounting',
    })

    expect(store.createSignatureRequest).toHaveBeenCalledWith({
      engagementId: 'eng-1',
      clientId: 'c1',
      provider: 'esignatures',
      providerDocumentId: 'ctr-1',
      providerTemplateId: 'tpl-1',
      providerSignerId: 'signer-1',
      status: 'sent',
      recipients: [{ id: 'signer-1', name: 'Pat Doe', email: 'pat@example.invalid' }],
      testMode: true,
      esignHash: engagementEsignHash(eng),
      sentAt: expect.any(String),
      createdBy: 'emp-patrice',
    })
    expect(store.markEngagementEsigned).toHaveBeenCalledWith('eng-1', expect.objectContaining({ signatureRequestId: 'sigreq-1', testMode: true, hash: engagementHash(eng) }))
    // The signing link never leaves eSignatures.io.
    expect(JSON.stringify([store.createSignatureRequest.mock.calls, result])).not.toContain('esignatures.example.invalid')
  })

  it('goes live only for the literal ESIGNATURES_TEST_MODE=false; a prospect\'s metadata has no client_id', async () => {
    const live = esSetup({ env: { ...ES_ENV, ESIGNATURES_TEST_MODE: 'false', SIGNWELL_TEST_MODE: 'true' } })
    await send(engagement(), live.deps)
    expect(live.esignatures.createContract.mock.calls[0][0].testMode).toBe(false)
    expect(live.store.createSignatureRequest.mock.calls[0][0].testMode).toBe(false)
    expect(JSON.parse(live.esignatures.createContract.mock.calls[0][0].metadata)).toEqual({
      engagement_id: 'eng-1',
      app: 'pbjbillingapp',
      esign_hash: engagementEsignHash(engagement()),
    })
    const test = esSetup({ env: { ...ES_ENV, SIGNWELL_TEST_MODE: 'false' } })
    await send(engagement(), test.deps)
    expect(test.esignatures.createContract.mock.calls[0][0].testMode).toBe(true)
  })

  it('ESIGN_PROVIDER=signwell sends through SignWell even with the token set', async () => {
    const { deps, esignatures, signwell } = esSetup({ env: { ...ES_ENV, ...ENV, ESIGN_PROVIDER: 'signwell' } })
    deps.buildPdf = vi.fn(async () => PDF)
    expect((await send(engagement(), deps)).ok).toBe(true)
    expect(signwell.createDocumentFromFile).toHaveBeenCalledTimes(1)
    expect(esignatures.createTemplate).not.toHaveBeenCalled()
  })

  it('initials tags become required checkboxes in the template; signature and date tags are dropped', async () => {
    const { deps, esignatures } = esSetup()
    await send(engagement({ letterBody: 'Dear {{contact_name}},\n\nTerms. {{initial:1:y}}\n\n{{signature:1:y}} {{date:1:y}}' }), deps)
    const { markdown } = esignatures.createTemplate.mock.calls[0][0]
    expect(markdown).toContain('Initials: I have read and agree to the section above `{"line_type":"checkbox","input_type":"every_signer","input_required":"yes","signer_field_id":"initials_1"}`')
    expect(markdown).not.toContain('signature')
  })

  it('the same refusals, before eSignatures.io is asked: active request, placeholders, team address, no address', async () => {
    const cases = [
      [{ active: { id: 'sigreq-9', status: 'sent' } }, engagement(), 'signature_active'],
      [{}, engagement({ letterBody: 'Dear {{nope}}' }), 'unknown_placeholder'],
      [{}, engagement({ party: { ...engagement().party, email: 'alex@ka-performancefl.example' } }), 'team_address'],
      [{}, engagement({ party: { ...engagement().party, email: '' } }), 'no_recipient'],
      [{}, engagement({ status: 'void' }), 'engagement_refused'],
    ]
    for (const [options, eng, error] of cases) {
      const { deps, esignatures } = esSetup(options)
      const result = await send(eng, deps)
      expect(result.refused?.error, error).toBe(error)
      expect(esignatures.createTemplate).not.toHaveBeenCalled()
      expect(esignatures.createContract).not.toHaveBeenCalled()
    }
    // Nothing set up at all: the old code, a provider-neutral sentence.
    const none = esSetup({ env: {} })
    const refused = await send(engagement(), none.deps)
    expect(refused.refused).toMatchObject({ status: 409, error: 'signwell_not_configured' })
    expect(refused.refused.message).toMatch(/E-signature is not set up yet.*Nothing was sent/)
  })

  it('says what eSignatures.io refused in plain words, records nothing, and releases the hold', async () => {
    const { EsignaturesError } = await import('./esignatures.js')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cases = [
      [{ templateFails: new EsignaturesError('x', { status: 401, code: 'unauthorized' }) }, /rejected the token/],
      [{ contractFails: new EsignaturesError('x', { status: 429, code: 'rate_limited' }) }, /busy right now/],
      [{ contractFails: new EsignaturesError('x', { status: 400, providerMessage: 'Bad signer pat@example.invalid' }) }, /eSignatures\.io refused the letter: Bad signer \[email\]\. Nothing was sent/],
      [{ templateFails: new EsignaturesError('x', { code: 'network' }) }, /could not be reached/],
    ]
    for (const [options, pattern] of cases) {
      const { deps, store } = esSetup(options)
      const result = await send(engagement(), deps)
      expect(result.refused).toMatchObject({ status: 502, error: 'esign_failed' })
      expect(result.refused.message).toMatch(pattern)
      expect(store.createSignatureRequest).not.toHaveBeenCalled()
      expect((await send(engagement(), esSetup().deps)).ok).toBe(true)
    }
    errors.mockRestore()
  })

  it('a request row that cannot be written names the contract to withdraw', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { deps } = esSetup({ recordFails: true })
    const result = await send(engagement(), deps)
    errors.mockRestore()
    expect(result.refused).toMatchObject({ status: 500, error: 'esign_record_failed' })
    expect(result.refused.message).toContain('ctr-1')
    expect(result.refused.message).toMatch(/eSignatures\.io has the contract/)
  })
})

describe('remindEngagementSignature through eSignatures.io', () => {
  const ES_ENV = { ESIGNATURES_SECRET_TOKEN: 'es_fake_token_1234567890' }
  const esActive = (over = {}) => ({
    id: 'sigreq-1',
    provider: 'esignatures',
    providerDocumentId: 'ctr-1',
    signwellDocumentId: 'ctr-1',
    providerSignerId: 'signer-1',
    status: 'sent',
    lastRemindedAt: null,
    ...over,
  })
  const esDeps = (active) => {
    const { deps, store, signwell } = setup({ active, env: ES_ENV })
    const esignatures = { resendToSigner: vi.fn(async () => ({ status: 'queued' })) }
    return { deps: { ...deps, esignatures, now: NOW }, store, signwell, esignatures }
  }

  it('resends the request to the stored signer, once per firm day, and never asks SignWell', async () => {
    const { deps, esignatures, signwell, store } = esDeps(esActive())
    const result = await remindEngagementSignature('eng-1', deps)
    expect(result.ok).toBe(true)
    expect(esignatures.resendToSigner).toHaveBeenCalledWith('ctr-1', 'signer-1', { env: ES_ENV })
    expect(signwell.sendReminder).not.toHaveBeenCalled()
    expect(store.updateSignatureRequest).toHaveBeenCalledWith('sigreq-1', { lastRemindedAt: NOW.toISOString() })
    const again = esDeps(esActive({ lastRemindedAt: '2026-10-21T13:30:00.000Z' }))
    const refused = await remindEngagementSignature('eng-1', again.deps)
    expect(refused.refused).toMatchObject({ status: 409, error: 'reminded_today' })
    expect(refused.refused.message).toMatch(/eSignatures\.io also reminds the signer on its own schedule/)
    expect(again.esignatures.resendToSigner).not.toHaveBeenCalled()
  })

  it('a request with no signer id recorded cannot be reminded (409), and a 4xx from eSignatures.io is a plain 409', async () => {
    const { EsignaturesError } = await import('./esignatures.js')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const none = esDeps(esActive({ providerSignerId: null }))
    expect((await remindEngagementSignature('eng-1', none.deps)).refused).toMatchObject({ status: 409, error: 'esign_cannot_remind' })
    expect(none.esignatures.resendToSigner).not.toHaveBeenCalled()
    const refused = esDeps(esActive())
    refused.esignatures.resendToSigner.mockRejectedValue(new EsignaturesError('x', { status: 400 }))
    expect((await remindEngagementSignature('eng-1', refused.deps)).refused).toMatchObject({ status: 409, error: 'esign_cannot_remind' })
    const down = esDeps(esActive())
    down.esignatures.resendToSigner.mockRejectedValue(new EsignaturesError('x', { code: 'network' }))
    const result = await remindEngagementSignature('eng-1', down.deps)
    expect(result.refused).toMatchObject({ status: 502, error: 'esign_failed' })
    expect(result.refused.message).toMatch(/No reminder was sent/)
    expect(down.store.updateSignatureRequest).not.toHaveBeenCalled()
    errors.mockRestore()
  })
})

describe('changed since sent counts a send for signature', () => {
  it('compares the letter with the hash its newest esign (or send) carried', async () => {
    const { engagementChangedSinceSent } = await import('./engagement-hash.js')
    const eng = engagement({ status: 'sent' })
    const entry = { kind: 'esign', ok: true, hash: engagementHash(eng), at: '2026-10-21T16:00:00.000Z' }
    expect(engagementChangedSinceSent({ ...eng, emailLog: [entry] })).toBe(false)
    expect(engagementChangedSinceSent({ ...eng, subject: 'Edited after it went out', emailLog: [entry] })).toBe(true)
    // The newest of the two kinds decides.
    const edited = { ...eng, subject: 'Edited' }
    const resent = { kind: 'send', ok: true, hash: engagementHash(edited), at: '2026-10-22T16:00:00.000Z' }
    expect(engagementChangedSinceSent({ ...edited, emailLog: [entry, resent] })).toBe(false)
    expect(engagementChangedSinceSent({ ...edited, emailLog: [resent, { ...entry, at: '2026-10-23T16:00:00.000Z' }] })).toBe(true)
    // An esign entry that did not go out is not a send; one with no hash cannot be compared.
    expect(engagementChangedSinceSent({ ...edited, emailLog: [{ ...entry, ok: false }] })).toBe(false)
    expect(engagementChangedSinceSent({ ...edited, emailLog: [{ kind: 'esign', ok: true, hash: null }] })).toBe(false)
  })
})

/**
 * Withdrawing an open request when its letter no longer stands (featreq-60118b28 item 1): voided, marked signed
 * by hand, or superseded. Best-effort through the request's OWN provider; the request always ends "withdrawn".
 */
describe('withdrawSignatureRequest', () => {
  const FINISHED = ['completed', 'declined', 'expired', 'canceled', 'withdrawn']
  function withdrawStore(rows) {
    const state = { rows: rows.map((row) => ({ lastError: null, ...row })), events: [] }
    return {
      state,
      getSignatureRequest: vi.fn(async (id) => {
        const row = state.rows.find((entry) => entry.id === id)
        return row ? { ...row } : null
      }),
      listSignatureRequestsForEngagement: vi.fn(async (engagementId) => state.rows.filter((row) => row.engagementId === engagementId).map((row) => ({ ...row }))),
      recordSignwellEventOnce: vi.fn(async (key, type) => {
        state.events.push([key, type])
        return true
      }),
      updateSignatureRequest: vi.fn(async (id, patch) => {
        const row = state.rows.find((entry) => entry.id === id)
        if (!row) return null
        if (patch.status && !FINISHED.includes(row.status)) row.status = patch.status
        if (patch.lastError !== undefined) row.lastError = patch.lastError
        return { ...row }
      }),
    }
  }
  const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const esRow = (over = {}) => ({ id: 'sigreq-es', engagementId: 'eng-1', provider: 'esignatures', providerDocumentId: 'ctr-1', signwellDocumentId: 'ctr-1', status: 'viewed', ...over })

  it('eSignatures.io: withdraws the contract (8 s at most), ledgers es:<contract>:contract-withdrawn, ends the request with no note', async () => {
    const store = withdrawStore([esRow({ lastError: 'an older delivery note' })])
    const esignatures = { withdrawContract: vi.fn(async () => null), getContract: vi.fn(async () => ({ id: 'ctr-1', status: 'withdrawn' })) }
    const env = { ESIGNATURES_SECRET_TOKEN: 'tok' }
    const result = await withdrawSignatureRequest(store.state.rows[0], { store, esignatures, env, reason: 'void', log: quiet })
    expect(esignatures.withdrawContract).toHaveBeenCalledWith('ctr-1', { env, timeoutMs: ESIGN_WITHDRAW_TIMEOUT_MS })
    expect(ESIGN_WITHDRAW_TIMEOUT_MS).toBe(8000)
    expect(store.state.events).toEqual([['es:ctr-1:contract-withdrawn', 'esignatures:withdrawn-by-app']])
    expect(result).toMatchObject({ withdrawn: true, providerError: null })
    expect(store.state.rows[0]).toMatchObject({ status: 'withdrawn', lastError: null })
  })

  const refusing = (contract) => ({
    withdrawContract: vi.fn(async () => {
      throw new EsignaturesError('eSignatures.io answered 422: contract cannot be withdrawn for pat@example.invalid', { status: 422 })
    }),
    getContract: vi.fn(async () => {
      if (contract instanceof Error) throw contract
      return { id: 'ctr-1', ...contract }
    }),
  })

  it('eSignatures.io refusing, and the re-read shows it NOT signed: withdrawn here, the provider message in the note, never throws', async () => {
    const store = withdrawStore([esRow()])
    const esignatures = refusing({ status: 'sent' })
    const env = { ESIGNATURES_SECRET_TOKEN: 'tok' }
    const result = await withdrawSignatureRequest(store.state.rows[0], { store, esignatures, env, reason: 'void', log: quiet })
    // Re-read inside the same cap.
    expect(esignatures.getContract).toHaveBeenCalledWith('ctr-1', { env, timeoutMs: ESIGN_WITHDRAW_TIMEOUT_MS })
    expect(result).toMatchObject({ withdrawn: true })
    expect(store.state.rows[0].status).toBe('withdrawn')
    expect(store.state.rows[0].lastError.startsWith(
      'Withdrawn here because the letter was voided, but eSignatures.io did not withdraw it (eSignatures.io answered 422: contract cannot be withdrawn',
    )).toBe(true)
    expect(store.state.rows[0].lastError.endsWith('- withdraw it in eSignatures.io')).toBe(true)
    // No address in the note.
    expect(store.state.rows[0].lastError).not.toContain('pat@example.invalid')
    expect(store.state.events).toHaveLength(1)
  })

  it('ALREADY SIGNED at eSignatures.io (the withdrawal refused, the re-read reads signed): left OPEN for the webhook or Finish, never withdrawn', async () => {
    for (const reason of ['signed', 'void', 'superseded']) {
      const store = withdrawStore([esRow({ status: 'viewed', lastError: null })])
      const result = await withdrawSignatureRequest(store.state.rows[0], { store, esignatures: refusing({ status: 'signed' }), reason, log: quiet })
      expect(result, reason).toMatchObject({ withdrawn: false, signedAtProvider: true })
      // Still open: the webhook and Check / Finish can still complete it (the hourly PDF retry only takes over
      // once it is completed).
      expect(store.state.rows[0].status, reason).toBe('viewed')
      expect(store.state.rows[0].lastError, reason).toMatch(/^eSignatures\.io did not withdraw it when the letter .* - press Check eSignatures\.io$/)
      expect(store.state.rows[0].lastError).not.toContain('pat@example.invalid')
      // No ledger row: the provider's own events still land.
      expect(store.state.events, reason).toEqual([])
    }
  })

  it('a re-read that fails too leaves the request open (unknown is not "not signed"); one that reads withdrawn ends it with no note', async () => {
    const unreadable = withdrawStore([esRow()])
    const left = await withdrawSignatureRequest(unreadable.state.rows[0], { store: unreadable, esignatures: refusing(new Error('down')), reason: 'void', log: quiet })
    expect(left).toMatchObject({ withdrawn: false, signedAtProvider: false })
    expect(unreadable.state.rows[0].status).toBe('viewed')
    expect(unreadable.state.events).toEqual([])

    const already = withdrawStore([esRow()])
    const done = await withdrawSignatureRequest(already.state.rows[0], { store: already, esignatures: refusing({ status: 'withdrawn' }), reason: 'void', log: quiet })
    expect(done).toMatchObject({ withdrawn: true, providerError: null })
    expect(already.state.rows[0]).toMatchObject({ status: 'withdrawn', lastError: null })
  })

  it('SignWell, letter marked signed: nothing is withdrawn (the app cannot cancel there; a signature given at SignWell can still finish)', async () => {
    const store = withdrawStore([{ id: 'sigreq-sw', engagementId: 'eng-1', provider: 'signwell', signwellDocumentId: 'doc-1', status: 'sent' }])
    expect(await withdrawSignatureRequest(store.state.rows[0], { store, esignatures: {}, reason: 'signed', log: quiet })).toBeNull()
    expect(store.updateSignatureRequest).not.toHaveBeenCalled()
    expect(store.state.rows[0].status).toBe('sent')
  })

  it('SignWell: no provider call (the module has no cancel); withdrawn here with a note saying so', async () => {
    const store = withdrawStore([{ id: 'sigreq-sw', engagementId: 'eng-1', provider: 'signwell', signwellDocumentId: 'doc-1', status: 'sent' }])
    const esignatures = { withdrawContract: vi.fn() }
    const result = await withdrawSignatureRequest(store.state.rows[0], { store, esignatures, reason: 'superseded', log: quiet })
    expect(esignatures.withdrawContract).not.toHaveBeenCalled()
    expect(store.recordSignwellEventOnce).not.toHaveBeenCalled()
    expect(result.withdrawn).toBe(true)
    expect(store.state.rows[0].lastError).toBe(
      'Withdrawn here because the letter was superseded; the app cannot cancel it at SignWell - cancel it there if the client could still sign',
    )
  })

  it('a finished request is left alone (null); one that finished meanwhile keeps its own status and note', async () => {
    const esignatures = { withdrawContract: vi.fn(async () => null), getContract: vi.fn(async () => ({ id: 'ctr-1', status: 'withdrawn' })) }
    for (const status of FINISHED) {
      const store = withdrawStore([esRow({ status })])
      expect(await withdrawSignatureRequest(store.state.rows[0], { store, esignatures, log: quiet })).toBeNull()
      expect(store.updateSignatureRequest).not.toHaveBeenCalled()
    }
    expect(esignatures.withdrawContract).not.toHaveBeenCalled()
    // Completed between the read and the update: the store keeps it completed; no note is written over the completion's.
    const store = withdrawStore([esRow({ status: 'completed', lastError: 'the completion note' })])
    const raced = await withdrawSignatureRequest({ ...store.state.rows[0], status: 'viewed' }, { store, esignatures, log: quiet })
    expect(raced).toMatchObject({ withdrawn: false })
    expect(store.state.rows[0]).toMatchObject({ status: 'completed', lastError: 'the completion note' })
    expect(store.updateSignatureRequest).toHaveBeenCalledTimes(1)
    // The withdrawn ledger row is written only after the status move succeeded.
    expect(store.state.events).toEqual([])
  })

  it('never throws, even when the store does', async () => {
    const store = withdrawStore([esRow()])
    store.updateSignatureRequest = vi.fn(async () => {
      throw new Error('db down')
    })
    store.recordSignwellEventOnce = vi.fn(async () => {
      throw new Error('ledger down')
    })
    const esignatures = { withdrawContract: vi.fn(async () => null), getContract: vi.fn(async () => ({ id: 'ctr-1', status: 'withdrawn' })) }
    await expect(withdrawSignatureRequest(store.state.rows[0], { store, esignatures, log: quiet })).resolves.toMatchObject({ withdrawn: false })
  })
})

describe('withdrawOpenSignatureRequests', () => {
  const silent = { info() {}, warn() {}, error() {} }

  it('withdraws every request still open on each letter (bounced and error too), once per letter, and skips finished ones', async () => {
    const rows = [
      { id: 'a', engagementId: 'eng-1', provider: 'esignatures', providerDocumentId: 'ctr-a', status: 'viewed', lastError: null },
      { id: 'b', engagementId: 'eng-1', provider: 'esignatures', providerDocumentId: 'ctr-b', status: 'bounced', lastError: null },
      { id: 'c', engagementId: 'eng-1', provider: 'esignatures', providerDocumentId: 'ctr-c', status: 'declined', lastError: null },
      { id: 'd', engagementId: 'eng-2', provider: 'esignatures', providerDocumentId: 'ctr-d', status: 'sent', lastError: null },
    ]
    const store = {
      getSignatureRequest: vi.fn(async (id) => ({ ...rows.find((row) => row.id === id) })),
      listSignatureRequestsForEngagement: vi.fn(async (id) => rows.filter((row) => row.engagementId === id).map((row) => ({ ...row }))),
      recordSignwellEventOnce: vi.fn(async () => true),
      updateSignatureRequest: vi.fn(async (id, patch) => {
        const row = rows.find((entry) => entry.id === id)
        if (patch.status) row.status = patch.status
        if (patch.lastError !== undefined) row.lastError = patch.lastError
        return { ...row }
      }),
    }
    const esignatures = { withdrawContract: vi.fn(async () => null), getContract: vi.fn(async (id) => ({ id, status: 'withdrawn' })) }
    const results = await withdrawOpenSignatureRequests(
      [
        ['eng-1', 'signed'],
        ['eng-2', 'superseded'],
        ['eng-1', 'superseded'],
        [null, 'void'],
      ],
      { store, esignatures, log: silent },
    )
    expect(esignatures.withdrawContract.mock.calls.map((call) => call[0])).toEqual(['ctr-a', 'ctr-b', 'ctr-d'])
    expect(results.map((result) => result.request.id)).toEqual(['a', 'b', 'd'])
    expect(rows.map((row) => row.status)).toEqual(['withdrawn', 'withdrawn', 'declined', 'withdrawn'])
    expect(store.listSignatureRequestsForEngagement).toHaveBeenCalledTimes(2)
  })

  it('a letter whose requests cannot be read is skipped; the others are still withdrawn', async () => {
    const store = {
      listSignatureRequestsForEngagement: vi.fn(async (id) => {
        if (id === 'eng-bad') throw new Error('down')
        return [{ id: 'x', engagementId: id, provider: 'signwell', status: 'sent' }]
      }),
      recordSignwellEventOnce: vi.fn(async () => true),
      updateSignatureRequest: vi.fn(async (id, patch) => ({ id, status: patch.status ?? 'withdrawn' })),
    }
    const results = await withdrawOpenSignatureRequests([['eng-bad', 'void'], ['eng-ok', 'void']], { store, esignatures: {}, log: silent })
    expect(results).toHaveLength(1)
    expect(results[0].withdrawn).toBe(true)
  })
})

describe('withdrawSignatureRequest: the re-read after a 2xx (featreq-60118b28 round 2)', () => {
  const quiet = { info() {}, warn() {}, error() {} }
  const store = (row) => {
    const state = { row: { lastError: null, ...row }, events: [] }
    return {
      state,
      getSignatureRequest: vi.fn(async () => ({ ...state.row })),
      recordSignwellEventOnce: vi.fn(async (key) => {
        state.events.push(key)
        return true
      }),
      updateSignatureRequest: vi.fn(async (id, patch) => {
        if (patch.status && !['completed', 'declined', 'expired', 'canceled', 'withdrawn'].includes(state.row.status)) state.row.status = patch.status
        if (patch.lastError !== undefined) state.row.lastError = patch.lastError
        return { ...state.row }
      }),
    }
  }
  const row = { id: 'sigreq-es', engagementId: 'eng-1', provider: 'esignatures', providerDocumentId: 'ctr-1', status: 'sent' }
  const answering = (status) => ({ withdrawContract: vi.fn(async () => ({ status: 'ok' })), getContract: vi.fn(async () => ({ id: 'ctr-1', status })) })

  it('a withdraw that answered 2xx but the contract still reads SIGNED: left open (a no-op on a signed contract is not a withdrawal)', async () => {
    const s = store(row)
    const result = await withdrawSignatureRequest(s.state.row, { store: s, esignatures: answering('signed'), reason: 'void', log: quiet })
    expect(result).toMatchObject({ withdrawn: false, signedAtProvider: true, providerError: null })
    expect(s.state.row.status).toBe('sent')
    expect(s.state.row.lastError).toBe('eSignatures.io could not confirm the withdrawal when the letter was voided - press Check eSignatures.io')
    expect(s.state.events).toEqual([])
  })

  it('a 2xx and a contract that reads sent (the provider has not caught up) or withdrawn: withdrawn here, no note', async () => {
    for (const reads of ['sent', 'withdrawn']) {
      const s = store(row)
      const result = await withdrawSignatureRequest(s.state.row, { store: s, esignatures: answering(reads), reason: 'superseded', log: quiet })
      expect(result, reads).toMatchObject({ withdrawn: true, providerError: null })
      expect(s.state.row, reads).toMatchObject({ status: 'withdrawn', lastError: null })
      expect(s.state.events, reads).toEqual(['es:ctr-1:contract-withdrawn'])
    }
  })

  it('left open, but the row finished meanwhile: its own status and note are kept (no note written)', async () => {
    const s = store(row)
    s.getSignatureRequest.mockImplementation(async () => ({ ...s.state.row, status: 'completed', lastError: 'the completion note' }))
    const result = await withdrawSignatureRequest(s.state.row, { store: s, esignatures: answering('signed'), reason: 'signed', log: quiet })
    expect(result).toMatchObject({ withdrawn: false, signedAtProvider: true })
    expect(result.request.status).toBe('completed')
    expect(s.updateSignatureRequest).not.toHaveBeenCalled()
  })

  it('withdrawReasonFor names the reason for a letter that no longer stands, and none for a draft or sent one', () => {
    expect(withdrawReasonFor({ status: 'void' })).toBe('void')
    expect(withdrawReasonFor({ status: 'superseded' })).toBe('superseded')
    expect(withdrawReasonFor({ status: 'signed' })).toBe('signed')
    expect(withdrawReasonFor({ status: 'sent' })).toBeNull()
    expect(withdrawReasonFor(null)).toBeNull()
  })
})

describe('remindEngagementSignature: only while the letter can still be signed (featreq-60118b28 round 2)', () => {
  it('a void, superseded or signed letter is never reminded, whatever request is still open; a sent one is', async () => {
    for (const status of ['void', 'superseded', 'signed']) {
      const { deps, signwell, store } = setup({ active: { id: 'sigreq-1', status: 'sent', signwellDocumentId: 'doc-1', lastRemindedAt: null } })
      const refused = await remindEngagementSignature('eng-1', { ...deps, now: NOW, engagement: { id: 'eng-1', status } })
      expect(refused.refused, status).toMatchObject({ status: 409, error: 'engagement_closed' })
      expect(refused.refused.message).toBe(`This letter is ${status}, so no reminder was sent.`)
      expect(signwell.sendReminder).not.toHaveBeenCalled()
      expect(store.activeSignatureRequestForEngagement).not.toHaveBeenCalled()
    }
    const { deps, signwell } = setup({ active: { id: 'sigreq-1', status: 'sent', signwellDocumentId: 'doc-1', lastRemindedAt: null } })
    expect((await remindEngagementSignature('eng-1', { ...deps, now: NOW, engagement: { id: 'eng-1', status: 'sent' } })).ok).toBe(true)
    expect(signwell.sendReminder).toHaveBeenCalledTimes(1)
  })
})

/**
 * Who signs (Alex, 2026-10-27): Send for signature confirms or changes the signer first - the party's
 * address, one of the client's contacts, or one address for this send only. The chosen address is what
 * the provider gets, what the request row and the letter's log carry; the party is never changed.
 */
describe('sendEngagementForSignature: the signer she confirmed', () => {
  const ES_ENV = { ESIGNATURES_SECRET_TOKEN: 'es_fake_token_1234567890' }
  const CLIENT = { id: 'c1', name: 'Acme Books', isBillingMaster: false, lifecycleStage: 'active', contactIds: ['ct-1'], email: 'books@example.invalid' }
  const CONTACT = { id: 'ct-1', name: 'Casey Fox', email: 'CFO@example.invalid' }
  const withClient = () => context({ data: { clients: [CLIENT], contacts: [CONTACT] } })
  function esSetup(options = {}) {
    const base = setup({ env: ES_ENV, ...options })
    const esignatures = {
      createTemplate: vi.fn(async () => 'tpl-1'),
      createContract: vi.fn(async () => ({ id: 'ctr-1', status: 'sent', signers: [{ id: 'signer-1' }] })),
    }
    base.deps.esignatures = esignatures
    delete base.deps.buildPdf
    return { ...base, esignatures }
  }

  it("a client contact: the provider, the request row and the log all carry the contact's address and name; the party is untouched", async () => {
    const { deps, esignatures, store } = esSetup()
    const eng = engagement({ clientId: 'c1' })
    const party = structuredClone(eng.party)
    const result = await send(eng, deps, withClient(), { signer: { email: 'cfo@example.invalid' } })
    expect(result.ok).toBe(true)
    expect(esignatures.createContract.mock.calls[0][0].signers).toEqual([{ name: 'Casey Fox', email: 'CFO@example.invalid' }])
    expect(store.createSignatureRequest.mock.calls[0][0].recipients).toEqual([{ id: 'signer-1', name: 'Casey Fox', email: 'CFO@example.invalid' }])
    expect(store.markEngagementEsigned.mock.calls[0][1].to).toEqual(['CFO@example.invalid'])
    expect(eng.party).toEqual(party)
    // The letter itself is still addressed to the party.
    expect(esignatures.createTemplate.mock.calls[0][0].markdown).toContain('Dear Pat Doe,')
  })

  it('a one-time address goes to the provider under the party contact name (or a typed name), and is never written to the party', async () => {
    const { deps, esignatures, store } = esSetup()
    const eng = engagement({ clientId: 'c1' })
    const result = await send(eng, deps, withClient(), { signer: { email: 'owner@elsewhere.invalid', oneTime: true } })
    expect(result.ok).toBe(true)
    expect(esignatures.createContract.mock.calls[0][0].signers).toEqual([{ name: 'Pat Doe', email: 'owner@elsewhere.invalid' }])
    expect(store.markEngagementEsigned.mock.calls[0][1].to).toEqual(['owner@elsewhere.invalid'])
    expect(eng.party.email).toBe('pat@example.invalid')

    const named = esSetup()
    await send(engagement({ clientId: 'c1' }), named.deps, withClient(), { signer: { email: 'owner@elsewhere.invalid', name: 'Jo Owner', oneTime: true } })
    expect(named.esignatures.createContract.mock.calls[0][0].signers).toEqual([{ name: 'Jo Owner', email: 'owner@elsewhere.invalid' }])
  })

  it("the party's own address, posted, is today's send exactly", async () => {
    const posted = esSetup()
    await send(engagement({ clientId: 'c1' }), posted.deps, withClient(), { signer: { email: 'PAT@example.invalid' } })
    const missing = esSetup()
    await send(engagement({ clientId: 'c1' }), missing.deps, withClient())
    expect(posted.esignatures.createContract.mock.calls[0][0].signers).toEqual([{ name: 'Pat Doe', email: 'pat@example.invalid' }])
    expect(missing.esignatures.createContract.mock.calls[0][0].signers).toEqual([{ name: 'Pat Doe', email: 'pat@example.invalid' }])
  })

  it('a party with no address of its own can still be signed by a contact she picks', async () => {
    const { deps, esignatures } = esSetup()
    const eng = engagement({ clientId: 'c1', party: { ...engagement().party, email: '' } })
    expect((await send(eng, deps, withClient())).refused).toMatchObject({ error: 'no_recipient' })
    const picked = esSetup()
    expect((await send(eng, picked.deps, withClient(), { signer: { email: 'cfo@example.invalid' } })).ok).toBe(true)
    expect(picked.esignatures.createContract.mock.calls[0][0].signers[0].email).toBe('CFO@example.invalid')
    expect(esignatures.createContract).not.toHaveBeenCalled()
  })

  it('refuses before the provider is asked: a team mailbox, two addresses, an address no longer on file, a shape it cannot read', async () => {
    const cases = [
      [{ email: 'alex@ka-performancefl.example', oneTime: true }, 409, 'team_address'],
      [{ email: 'cfo@example.invalid, pat@example.invalid', oneTime: true }, 409, 'invalid_recipient'],
      [{ email: 'gone@example.invalid' }, 409, 'recipients_changed'],
      [{ email: ['cfo@example.invalid'] }, 400, 'signer_invalid'],
      ['cfo@example.invalid', 400, 'signer_invalid'],
    ]
    for (const [signer, status, error] of cases) {
      const { deps, esignatures, store } = esSetup()
      const result = await send(engagement({ clientId: 'c1' }), deps, withClient(), { signer })
      expect(result.refused, JSON.stringify(signer)).toMatchObject({ status, error })
      expect(esignatures.createTemplate).not.toHaveBeenCalled()
      expect(esignatures.createContract).not.toHaveBeenCalled()
      expect(store.createSignatureRequest).not.toHaveBeenCalled()
    }
    const { deps } = esSetup()
    const changed = await send(engagement({ clientId: 'c1' }), deps, withClient(), { signer: { email: 'gone@example.invalid' } })
    expect(changed.refused.recipients.map((entry) => entry.email)).toEqual(['pat@example.invalid', 'CFO@example.invalid', 'books@example.invalid'])
  })

  it('SignWell sends to the chosen signer too', async () => {
    const { deps, signwell, store } = setup()
    const result = await send(engagement({ clientId: 'c1' }), deps, withClient(), { signer: { email: 'cfo@example.invalid' } })
    expect(result.ok).toBe(true)
    expect(signwell.createDocumentFromFile.mock.calls[0][0].recipients).toEqual([{ id: '1', name: 'Casey Fox', email: 'CFO@example.invalid' }])
    expect(store.createSignatureRequest.mock.calls[0][0].recipients).toEqual([{ id: '1', name: 'Casey Fox', email: 'CFO@example.invalid' }])
    expect(store.markEngagementEsigned.mock.calls[0][1].to).toEqual(['CFO@example.invalid'])
  })
})
