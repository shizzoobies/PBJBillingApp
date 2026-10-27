import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendEngagementEsignRequest } from '../lib/api'
import { ApiError } from '../lib/types'

/**
 * Send for signature through the browser's door (Alex, 2026-10-27): the signer she confirmed rides in the POST
 * body; an accepted send answers the request; a `recipients_changed` refusal carries the list as it is now (the
 * confirm reopens on it); a non-owner's 403 is a plain error. server.js is not booted by tests: its route glue is
 * pinned in engagement-esign-routes.test.ts and the rules run in lib/engagement-esign.test.mjs.
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(async () =>
    jsonResponse({
      request: { id: 'sigreq-1', status: 'sent', recipients: [{ id: 'signer-1', name: 'Casey Fox', email: 'cfo@acme.test' }] },
      engagement: { id: 'eng-1', status: 'sent' },
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sendEngagementEsignRequest', () => {
  it('POSTs the page hash and the confirmed signer as JSON, and answers the request', async () => {
    const result = await sendEngagementEsignRequest('eng 1', { templateHash: 'hash-1', signer: { email: 'cfo@acme.test' } })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toBe('/api/engagements/eng%201/esign')
    expect(String(url)).not.toContain('cfo@acme.test')
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('Content-Type')).toMatch(/application\/json/)
    expect(JSON.parse(String(init.body))).toEqual({ templateHash: 'hash-1', signer: { email: 'cfo@acme.test' } })
    expect(result.request.recipients[0].email).toBe('cfo@acme.test')
  })

  it('a recipients_changed refusal carries the list as it is now', async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse(
        {
          error: 'recipients_changed',
          message: 'gone@acme.test is no longer on file for this letter. Choose who signs again. Nothing was sent.',
          recipients: [{ email: 'pat@acme.test', source: 'Pat Doe' }],
        },
        409,
      ),
    )
    const failure = await sendEngagementEsignRequest('eng-1', { templateHash: 'hash-1', signer: { email: 'gone@acme.test' } }).catch(
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(ApiError)
    expect(failure).toMatchObject({ status: 409, code: 'recipients_changed', recipients: [{ email: 'pat@acme.test', source: 'Pat Doe' }] })
    expect((failure as ApiError).message).toMatch(/no longer on file/)
  })

  it("a non-owner's 403 is an error, never a send", async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse({ error: 'Only owners can send engagements for signature' }, 403))
    const failure = await sendEngagementEsignRequest('eng-1', { templateHash: 'hash-1', signer: { email: 'cfo@acme.test' } }).catch(
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(ApiError)
    expect(failure).toMatchObject({ status: 403 })
  })
})
