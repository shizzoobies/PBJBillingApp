import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFeedbackAbortController, listFeedbackAttachments, logoutSession, setPreviewUser } from '../lib/api'

afterEach(() => { setPreviewUser(null); vi.unstubAllGlobals() })
describe('attachment identity boundaries', () => {
  it('aborts synchronously when logout starts, before its response', async () => {
    let complete!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { complete = resolve })))
    const controller = createFeedbackAbortController()
    const logout = logoutSession()
    expect(controller.signal.aborted).toBe(true)
    complete(new Response('{}', { status: 200 }))
    await logout
  })
  it('aborts at preview identity change and preserves central preview headers', async () => {
    const controller = createFeedbackAbortController()
    setPreviewUser('staff-fixture')
    expect(controller.signal.aborted).toBe(true)
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"attachments":[]}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const active = createFeedbackAbortController()
    await listFeedbackAttachments('fixture', active.signal)
    const headers = fetchMock.mock.calls[0][1].headers as Headers
    expect(headers.get('X-Preview-Mode')).toBe('1')
    expect(headers.get('X-Preview-As')).toBe('staff-fixture')
    active.abort()
  })
})
