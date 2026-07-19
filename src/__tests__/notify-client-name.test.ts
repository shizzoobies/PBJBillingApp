import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error - plain-JS module without type declarations
import { notify } from '../../lib/notify.js'

/**
 * The email a notification sends must name the client it's about (Urgent
 * request). notify() resolves the client from the clientId/checklistId the call
 * site already passes and renders it as a labeled line + in the subject.
 */

type Sent = { subject: string; html: string; to: string }

function fakeStore(overrides: Record<string, unknown> = {}) {
  return {
    createNotification: vi.fn(async () => ({ id: 'n1' })),
    getTeamMember: vi.fn(async () => ({ id: 'u1', email: 'staff@firm.test' })),
    getClientNameById: vi.fn(async () => 'Beta Inc'),
    getClientNameForChecklist: vi.fn(async () => 'Acme LLC'),
    ...overrides,
  }
}

let sent: Sent | null

beforeEach(() => {
  sent = null
  process.env.RESEND_API_KEY = 'test-key'
  process.env.EMAIL_FROM = 'noreply@firm.test'
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body)
      sent = { subject: body.subject, html: body.html, to: body.to }
      return { ok: true, text: async () => '' }
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.RESEND_API_KEY
  delete process.env.EMAIL_FROM
})

describe('notify — client name in email', () => {
  it('resolves the client from checklistId and shows it in the body and subject', async () => {
    const store = fakeStore()
    await notify(store, 'u1', 'task_assigned', {
      message: 'New task: Reconcile books',
      checklistId: 'c1',
    })
    expect(store.getClientNameForChecklist).toHaveBeenCalledWith('c1')
    expect(sent).not.toBeNull()
    expect(sent!.html).toContain('Client:')
    expect(sent!.html).toContain('Acme LLC')
    expect(sent!.subject).toContain('Acme LLC')
  })

  it('resolves from an explicit clientId when there is no checklistId', async () => {
    const store = fakeStore()
    await notify(store, 'u1', 'time_entry_manual', {
      message: 'Manual time entry needs approval',
      clientId: 'client-9',
    })
    expect(store.getClientNameById).toHaveBeenCalledWith('client-9')
    expect(sent!.html).toContain('Beta Inc')
  })

  it('prefers an explicit clientName over a lookup', async () => {
    const store = fakeStore()
    await notify(store, 'u1', 'task_assigned', {
      message: 'New task',
      clientName: 'Explicit Co',
      checklistId: 'c1',
    })
    expect(store.getClientNameForChecklist).not.toHaveBeenCalled()
    expect(sent!.html).toContain('Explicit Co')
  })

  it('omits the client line when there is no client to resolve', async () => {
    const store = fakeStore({
      getClientNameById: vi.fn(async () => null),
      getClientNameForChecklist: vi.fn(async () => null),
    })
    await notify(store, 'u1', 'task_assigned', { message: 'New task' })
    expect(sent!.html).not.toContain('Client:')
  })

  it('does not duplicate the client in the subject when already present', async () => {
    const store = fakeStore({ getClientNameForChecklist: vi.fn(async () => 'Acme LLC') })
    await notify(store, 'u1', 'task_assigned', {
      message: 'x',
      subject: 'Manual entry for Acme LLC',
      checklistId: 'c1',
    })
    expect(sent!.subject).toBe('Manual entry for Acme LLC')
  })

  it('HTML-escapes the client name', async () => {
    const store = fakeStore({ getClientNameForChecklist: vi.fn(async () => '<b>X</b> & Co') })
    await notify(store, 'u1', 'task_assigned', { message: 'x', checklistId: 'c1' })
    expect(sent!.html).toContain('&lt;b&gt;X&lt;/b&gt; & Co')
    expect(sent!.html).not.toContain('<b>X</b>')
  })
})
