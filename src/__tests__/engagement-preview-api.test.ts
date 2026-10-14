import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { engagementPreviewPdfUrl, previewEngagementRequest } from '../lib/api'

/**
 * The browser's door onto the engagement preview: the address she typed for a send
 * goes in the request body, never in a URL (history, server logs, the PDF frame's src).
 */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(async () => jsonResponse({ subject: 'S', to: ['a@b.test'] }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('previewEngagementRequest', () => {
  it('POSTs the typed address in the body and the URL has no to=', async () => {
    await previewEngagementRequest('eng 1', 'typed@client.test')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toContain('/api/engagements/eng%201/preview')
    expect(String(url)).not.toContain('to=')
    expect(String(url)).not.toContain('typed@client.test')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ to: 'typed@client.test' })
  })

  it('with no typed address sends an empty body, still a POST', async () => {
    await previewEngagementRequest('eng-1')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toBe('/api/engagements/eng-1/preview')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({})
  })
})

describe('engagementPreviewPdfUrl', () => {
  it('is the plain PDF path: the PDF does not depend on the recipient', () => {
    expect(engagementPreviewPdfUrl('eng-1')).toBe('/api/engagements/eng-1/preview.pdf')
    expect(engagementPreviewPdfUrl('eng-1')).not.toContain('to=')
  })
})
