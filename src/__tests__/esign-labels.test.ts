import { describe, expect, it } from 'vitest'
import {
  ESIGN_ACTIVE_STATUSES,
  ESIGN_OPEN_WARNING,
  esignBadgeText,
  esignIsActive,
  esignRefusalSentence,
  esignWarnsOnEdit,
  esignWasMarkedComplete,
} from '../lib/engagements'
import { ApiError, type SignatureRequestStatus } from '../lib/types'

/** The words the e-signature badge and refusals use (featreq-56d39567). */
const request = (status: SignatureRequestStatus) => ({
  status,
  sentAt: '2026-10-21T15:00:00.000Z',
  completedAt: '2026-10-22T15:00:00.000Z',
  lastEventAt: '2026-10-23T15:00:00.000Z',
})

describe('esignBadgeText', () => {
  it.each([
    ['draft', 'E-sign: not sent'],
    ['sent', 'E-sign: sent Oct 21'],
    ['viewed', 'E-sign: viewed'],
    ['signed_partial', 'E-sign: partly signed'],
    ['completed', 'E-sign: signed Oct 22'],
    ['declined', 'E-sign: declined'],
    ['expired', 'E-sign: expired'],
    ['canceled', 'E-sign: canceled'],
    ['withdrawn', 'E-sign: withdrawn'],
    ['bounced', 'E-sign: email bounced'],
    ['error', 'E-sign: problem'],
  ] as const)('%s reads "%s"', (status, text) => {
    expect(esignBadgeText(request(status))).toBe(text)
  })

  it('falls back to the last event day, and leaves the day off when there is none', () => {
    expect(esignBadgeText({ ...request('completed'), completedAt: null })).toBe('E-sign: signed Oct 23')
    expect(esignBadgeText({ status: 'sent', sentAt: null, completedAt: null, lastEventAt: null })).toBe('E-sign: sent')
  })
})

describe('esignWarnsOnEdit', () => {
  it('is true while a request is out and for bounced or error (they can recover), false once it ended', () => {
    for (const status of ['sent', 'viewed', 'signed_partial', 'bounced', 'error'] as const) {
      expect(esignWarnsOnEdit({ status }), status).toBe(true)
    }
    for (const status of ['draft', 'completed', 'declined', 'expired', 'canceled', 'withdrawn'] as const) {
      expect(esignWarnsOnEdit({ status }), status).toBe(false)
    }
    expect(esignWarnsOnEdit(null)).toBe(false)
  })
})

describe('esignIsActive', () => {
  it('is true only while the request is out with the signer', () => {
    for (const status of ESIGN_ACTIVE_STATUSES) expect(esignIsActive({ status })).toBe(true)
    for (const status of ['draft', 'completed', 'declined', 'expired', 'canceled', 'withdrawn', 'bounced', 'error'] as const) {
      expect(esignIsActive({ status })).toBe(false)
    }
    expect(esignIsActive(null)).toBe(false)
    expect(esignIsActive(undefined)).toBe(false)
  })
})

describe('esignRefusalSentence', () => {
  it('uses the server\'s words where they say something specific, and says nothing was sent', () => {
    expect(esignRefusalSentence(new ApiError(409, 'x', 'signature_active'))).toBe('This letter is already out for signature. Send a reminder instead.')
    expect(esignRefusalSentence(new ApiError(409, 'x', 'engagement_changed'))).toMatch(/nothing was sent\. The page now shows the saved version/)
    expect(esignRefusalSentence(new ApiError(409, 'x', 'reminded_today'), 'remind')).toBe('A reminder already went out today.')
    expect(esignRefusalSentence(new ApiError(409, 'E-signature is not set up yet. Nothing was sent.', 'signwell_not_configured'))).toBe(
      'E-signature is not set up yet. Nothing was sent.',
    )
    expect(esignRefusalSentence(new ApiError(404, 'x'))).toBe('This engagement no longer exists. Nothing was sent.')
    expect(esignRefusalSentence(new ApiError(404, 'x'), 'remind')).toBe('This engagement no longer exists. No reminder was sent.')
  })

  it('has a sentence for a failure that is not an ApiError', () => {
    expect(esignRefusalSentence(new Error('boom'))).toBe('Could not send the letter for signature. Nothing was sent.')
    expect(esignRefusalSentence(null, 'remind')).toBe('Could not send the reminder. No reminder was sent.')
  })
})

describe('esignWasMarkedComplete and the open-request warning', () => {
  it('reads a request SignWell completed by a person (not signed by the client) from its note', () => {
    expect(esignWasMarkedComplete({ lastError: 'Marked complete in SignWell, not signed by the client - mark it signed by hand if that is right' })).toBe(true)
    expect(esignWasMarkedComplete({ lastError: 'The signed PDF could not be saved - download it from SignWell' })).toBe(false)
    expect(esignWasMarkedComplete({ lastError: null })).toBe(false)
    expect(esignWasMarkedComplete(null)).toBe(false)
  })

  it('has one sentence for the warning', () => {
    expect(ESIGN_OPEN_WARNING).toBe('An e-signature request is open; the client will sign the earlier version.')
  })

  it('words the finish refusals as the server gave them', () => {
    expect(esignRefusalSentence(new ApiError(409, 'SignWell shows this document as Viewed, not completed.', 'not_completed'))).toBe(
      'SignWell shows this document as Viewed, not completed.',
    )
    expect(esignRefusalSentence(new ApiError(409, 'Already being finished.', 'finishing'))).toBe('Already being finished.')
  })
})

describe('esignRefusalSentence for Check SignWell / Finish e-signature', () => {
  it('uses its own words and never says "Nothing was sent."', () => {
    expect(esignRefusalSentence(new ApiError(409, 'SignWell ended this request (declined), so there is nothing to check.', 'ended'), 'finish')).toBe(
      'SignWell ended this request (declined), so there is nothing to check.',
    )
    expect(esignRefusalSentence(new ApiError(404, 'x'), 'finish')).toBe('This engagement or signature request no longer exists.')
    expect(esignRefusalSentence(new ApiError(500, ''), 'finish')).toBe('Could not check SignWell. Try again in a minute.')
    expect(esignRefusalSentence(new Error('boom'), 'finish')).toBe('Could not check SignWell. Try again in a minute.')
    for (const err of [new ApiError(502, '', 'esign_failed'), new Error('x'), new ApiError(409, 'm', 'finishing')]) {
      expect(esignRefusalSentence(err, 'finish')).not.toMatch(/Nothing was sent/)
    }
  })
})
