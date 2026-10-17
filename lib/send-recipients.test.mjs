import { describe, expect, it } from 'vitest'
import {
  MAX_POSTED_RECIPIENTS,
  autopayAllowedDetails,
  chooseSendRecipients,
  isOneEmailAddress,
  proposalAllowedDetails,
  questionnaireAllowedDetails,
  recipientChoiceOf,
} from './send-recipients.js'
import { questionnaireLastRecipients, resolveSendRecipients } from './invoice-recipients.js'

/**
 * The server's half of the recipient picker (featreq-34627da1), run for real: the
 * body's shape, each route's addresses on file, and the strict decision every manual
 * send makes with them.
 */

const clients = [
  { id: 'c-acme', name: 'Acme', contactIds: ['ct-pat', 'ct-team'], email: 'office@acme.test' },
  { id: 'c-other', name: 'Other Co', contactIds: ['ct-oz'], email: 'office@other.test' },
  { id: 'c-master', name: 'KLC', isBillingMaster: true, invoiceRecipientClientId: 'c-sub', contactIds: [] },
  { id: 'c-sub', name: 'KLC South', billToClientId: 'c-master', contactIds: ['ct-sam'] },
  { id: 'c-unset', name: 'Unset', isBillingMaster: true, invoiceRecipientClientId: null, contactIds: [] },
]
const contacts = [
  { id: 'ct-pat', name: 'Pat', email: 'pat@acme.test' },
  { id: 'ct-team', name: 'Alex Owner', email: 'alex@ka-performancefl.com' },
  { id: 'ct-oz', name: 'Oz', email: 'oz@other.test' },
  { id: 'ct-sam', name: 'Sam', email: 'sam@south.test' },
]
const emails = (details) => details.map((detail) => detail.email)

describe('recipientChoiceOf - the shape of the picker\'s choice', () => {
  it('reads absent fields as the send\'s default', () => {
    expect(recipientChoiceOf({})).toEqual({ to: undefined, extra: undefined })
    expect(recipientChoiceOf(null)).toEqual({ to: undefined, extra: undefined })
    expect(recipientChoiceOf({ to: '', extra: null })).toEqual({ to: undefined, extra: undefined })
  })

  it('reads one address as a string as a list of one, trimmed, and refuses a string that is not one address', () => {
    expect(recipientChoiceOf({ to: ' pat@acme.test ' })).toEqual({ to: ['pat@acme.test'], extra: undefined })
    for (const to of ['pat', 'a@b.com, c@d.com', 'Pat <pat@acme.test>', `${'a'.repeat(320)}@x.test`]) {
      expect(recipientChoiceOf({ to }), to).toBeNull()
    }
  })

  it('takes a list of strings up to the cap, and refuses a longer one or any non-string', () => {
    const many = Array.from({ length: MAX_POSTED_RECIPIENTS }, (_, n) => `p${n}@x.test`)
    expect(MAX_POSTED_RECIPIENTS).toBe(50)
    expect(recipientChoiceOf({ to: many })?.to).toHaveLength(50)
    expect(recipientChoiceOf({ to: [...many, 'one@more.test'] })).toBeNull()
    expect(recipientChoiceOf({ to: ['a@x.test', 42] })).toBeNull()
    expect(recipientChoiceOf({ to: { 0: 'a@x.test' } })).toBeNull()
  })

  it('passes `extra` through when it is a list (the resolver validates each), and refuses anything else', () => {
    expect(recipientChoiceOf({ to: ['a@x.test'], extra: ['b@y.test'] })).toEqual({ to: ['a@x.test'], extra: ['b@y.test'] })
    expect(recipientChoiceOf({ extra: 'b@y.test' })).toBeNull()
    expect(recipientChoiceOf({ extra: { a: 1 } })).toBeNull()
  })

  it('isOneEmailAddress is the old single-address check', () => {
    expect(isOneEmailAddress('pat@acme.test')).toBe(true)
    expect(isOneEmailAddress('pat@acme')).toBe(false)
    expect(isOneEmailAddress(7)).toBe(false)
  })
})

describe('chooseSendRecipients - strict, the same for every route', () => {
  const details = [
    { email: 'pat@acme.test', source: 'Pat' },
    { email: 'office@acme.test', source: 'client record' },
  ]

  it('sends the ticked ones plus this send\'s, and names the one-time ones', () => {
    expect(chooseSendRecipients({ details, to: ['office@acme.test'], extra: ['ap@new.test'] })).toEqual({
      ok: true,
      to: ['office@acme.test', 'ap@new.test'],
      oneTime: ['ap@new.test'],
    })
  })

  it('refuses a ticked address no longer on file - 409, with the list as it is now - instead of dropping it', () => {
    const refused = chooseSendRecipients({ details, to: ['pat@acme.test', 'gone@acme.test'] })
    expect(refused).toMatchObject({ ok: false, status: 409, error: 'recipients_changed' })
    expect(refused.recipients).toEqual(details)
  })

  it('never one-time alone while anything is on file; a bad or fourth one-time address is a 400', () => {
    expect(chooseSendRecipients({ details, to: [], extra: ['ap@new.test'] })).toMatchObject({
      ok: false,
      status: 400,
      error: 'invoice_no_chosen_recipient',
    })
    expect(chooseSendRecipients({ details, to: ['pat@acme.test'], extra: ['nope'] })).toMatchObject({
      status: 400,
      error: 'invoice_bad_extra_recipient',
    })
  })

  it('without `strict` the resolver still filters (the reminder runs its own strict check before it)', () => {
    expect(resolveSendRecipients({ allowed: emails(details), to: ['pat@acme.test', 'gone@acme.test'] })).toEqual({
      ok: true,
      to: ['pat@acme.test'],
      oneTime: [],
    })
  })
})

describe('proposalAllowedDetails', () => {
  const proposal = (over = {}) => ({
    clientId: null,
    prospect: { email: 'boss@prospect.test', contactName: 'Bea', company: 'Prospect Co' },
    ...over,
  })

  it('a prospect is its own address', () => {
    expect(proposalAllowedDetails({ proposal: proposal(), clients, contacts })).toEqual([
      { email: 'boss@prospect.test', source: 'Bea' },
    ])
  })

  it("a proposal for a client adds THAT client's addresses, never another client's", () => {
    const list = emails(proposalAllowedDetails({ proposal: proposal({ clientId: 'c-acme' }), clients, contacts }))
    expect(list).toEqual(['boss@prospect.test', 'pat@acme.test', 'alex@ka-performancefl.com', 'office@acme.test'])
    expect(list).not.toContain('oz@other.test')
  })

  it('keeps a team address (a proposal never filtered them), and with a blank prospect email offers the contacts', () => {
    const list = emails(
      proposalAllowedDetails({ proposal: proposal({ clientId: 'c-acme', prospect: { email: '' } }), clients, contacts }),
    )
    expect(list).toEqual(['pat@acme.test', 'alex@ka-performancefl.com', 'office@acme.test'])
  })

  it('a billing master is addressed through its receiving company', () => {
    expect(emails(proposalAllowedDetails({ proposal: proposal({ clientId: 'c-master' }), clients, contacts }))).toEqual([
      'boss@prospect.test',
      'sam@south.test',
    ])
  })

  it('the route\'s decision refuses a `to` outside that list', () => {
    const details = proposalAllowedDetails({ proposal: proposal({ clientId: 'c-acme' }), clients, contacts })
    expect(chooseSendRecipients({ details, to: ['oz@other.test'] })).toMatchObject({ ok: false, status: 409 })
    expect(chooseSendRecipients({ details, to: ['pat@acme.test'] })).toMatchObject({ ok: true, to: ['pat@acme.test'] })
  })
})

describe('questionnaireAllowedDetails', () => {
  const sentThree = {
    sentTo: 'a@p.test',
    proposalId: null,
    emailLog: [
      { kind: 'send', ok: true, to: ['old@p.test'] },
      { kind: 'send', ok: true, to: ['a@p.test', 'b@p.test', 'c@p.test'] },
      { kind: 'delivery', event: 'delivered', to: ['a@p.test'] },
      { kind: 'send', ok: false, to: ['failed@p.test'] },
    ],
  }

  it('a brand-new link has nothing on file', () => {
    expect(questionnaireAllowedDetails({})).toEqual([])
  })

  it('re-offers everyone the last successful email went to, not only sentTo', () => {
    expect(questionnaireLastRecipients(sentThree)).toEqual(['a@p.test', 'b@p.test', 'c@p.test'])
    expect(emails(questionnaireAllowedDetails({ questionnaire: sentThree }))).toEqual(['a@p.test', 'b@p.test', 'c@p.test'])
    // A link whose log says nothing falls back to sentTo.
    expect(questionnaireLastRecipients({ sentTo: 'x@p.test', emailLog: [] })).toEqual(['x@p.test'])
    expect(questionnaireLastRecipients({ sentTo: null })).toEqual([])
  })

  it("adds the prospect (and its client's, never another client's) once the answers started a proposal", () => {
    const proposal = { clientId: 'c-acme', prospect: { email: 'B@p.test', contactName: 'Bea' } }
    const list = emails(questionnaireAllowedDetails({ questionnaire: sentThree, proposal, clients, contacts }))
    expect(list).toEqual(['a@p.test', 'b@p.test', 'c@p.test', 'pat@acme.test', 'alex@ka-performancefl.com', 'office@acme.test'])
    expect(list).not.toContain('oz@other.test')
  })

  it('the route\'s decision refuses a `to` outside that list, and a new link takes only this send\'s', () => {
    const details = questionnaireAllowedDetails({ questionnaire: sentThree })
    expect(chooseSendRecipients({ details, to: ['old@p.test'] })).toMatchObject({ ok: false, status: 409 })
    expect(chooseSendRecipients({ details: [], to: [], extra: ['new@p.test'] })).toMatchObject({
      ok: true,
      to: ['new@p.test'],
    })
    expect(chooseSendRecipients({ details: [], to: ['x@p.test'] })).toMatchObject({ ok: false, status: 409 })
  })
})

describe('autopayAllowedDetails', () => {
  it("is the invoice addressee's addresses: the client's own, never another client's", () => {
    const allowed = autopayAllowedDetails({ client: clients[0], clients, contacts })
    expect(allowed.refusal).toBeNull()
    // A team address on file was always invited (autopay never filtered them).
    expect(emails(allowed.details)).toEqual(['pat@acme.test', 'alex@ka-performancefl.com', 'office@acme.test'])
  })

  it("a billing master's go to its receiving company; one that names none is refused", () => {
    expect(emails(autopayAllowedDetails({ client: clients[2], clients, contacts }).details)).toEqual(['sam@south.test'])
    const unset = autopayAllowedDetails({ client: clients[4], clients, contacts })
    expect(unset.details).toEqual([])
    expect(unset.refusal?.error).toBe('master_recipient_unset')
  })

  it('the route\'s decision refuses a `to` outside that list', () => {
    const { details } = autopayAllowedDetails({ client: clients[0], clients, contacts })
    expect(chooseSendRecipients({ details, to: ['oz@other.test'] })).toMatchObject({ ok: false, status: 409 })
    expect(chooseSendRecipients({ details, to: undefined })).toMatchObject({ ok: true, to: emails(details) })
  })
})
