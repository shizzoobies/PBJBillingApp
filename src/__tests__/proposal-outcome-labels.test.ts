import { describe, expect, it } from 'vitest'
import { PROPOSAL_STATUS_LABELS, proposalActivity } from '../lib/proposals'
import type { Proposal } from '../lib/types'
import { describeActivityAction } from '../lib/utils'

// Engagements stage 1 (docs/plans/engagements-2026-10.md): a proposal's two
// outcomes read Won and Closed/Lost. The stored statuses stay accepted /
// declined - only the words change.

const BASE: Proposal = {
  id: 'prop-1',
  status: 'draft',
  prospect: {
    company: 'Acme Books',
    contactName: 'Pat Doe',
    title: '',
    email: '',
    phone: '',
    addressLine1: '',
    addressLine2: '',
    city: '',
    state: '',
    postalCode: '',
    notes: '',
  },
  clientId: null,
  inputs: {},
  selections: [],
  pricingSnapshot: null,
  letter: null,
  letterAt: null,
  messages: [],
  emailLog: [],
  sentAt: null,
  acceptedAt: null,
  declinedAt: null,
  declineNote: null,
  copiedFromId: null,
  createdBy: 'emp-patrice',
  createdAt: '2026-10-01T14:00:00.000Z',
  updatedAt: '2026-10-01T14:00:00.000Z',
}

describe('proposal outcome labels', () => {
  it('reads accepted as Won and declined as Closed/Lost; draft and sent unchanged', () => {
    expect(PROPOSAL_STATUS_LABELS).toEqual({
      draft: 'Draft',
      sent: 'Sent',
      accepted: 'Won',
      declined: 'Closed/Lost',
    })
  })

  it('keeps the filter order: Draft, Sent, Won, Closed/Lost', () => {
    expect(Object.values(PROPOSAL_STATUS_LABELS)).toEqual(['Draft', 'Sent', 'Won', 'Closed/Lost'])
  })
})

describe('proposal activity outcome wording', () => {
  it('a won proposal says Won', () => {
    const entries = proposalActivity({
      ...BASE,
      status: 'accepted',
      acceptedAt: '2026-10-05T15:00:00.000Z',
    })
    expect(entries.at(-1)).toEqual({ at: '2026-10-05T15:00:00.000Z', text: 'Won' })
  })

  it('a lost proposal with a note says Closed as lost: <note>', () => {
    const entries = proposalActivity({
      ...BASE,
      status: 'declined',
      declinedAt: '2026-10-05T15:00:00.000Z',
      declineNote: 'Went with a friend',
    })
    expect(entries.at(-1)?.text).toBe('Closed as lost: Went with a friend')
  })

  it('a lost proposal without a note (null or empty) says Closed as lost', () => {
    for (const declineNote of [null, '']) {
      const entries = proposalActivity({
        ...BASE,
        status: 'declined',
        declinedAt: '2026-10-05T15:00:00.000Z',
        declineNote,
      })
      expect(entries.at(-1)?.text).toBe('Closed as lost')
    }
  })
})

describe('the firm Activity feed', () => {
  it('words the stored proposal outcome actions as Won and closed as lost', () => {
    expect(describeActivityAction('proposal_accepted')).toBe('marked a proposal Won:')
    expect(describeActivityAction('proposal_declined')).toBe('closed a proposal as lost:')
  })

  it('leaves other proposal actions on the underscore fallback', () => {
    expect(describeActivityAction('proposal_sent')).toBe('proposal sent')
  })
})
