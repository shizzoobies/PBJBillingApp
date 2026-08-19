import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EMAIL_PREF_TYPES,
  isEmailEnabledForEvent,
  sanitizeEmailPrefs,
} from './notification-prefs.js'
import { notify } from './notify.js'

describe('sanitizeEmailPrefs', () => {
  it('returns an empty object for non-object input', () => {
    expect(sanitizeEmailPrefs(null)).toEqual({})
    expect(sanitizeEmailPrefs(undefined)).toEqual({})
    expect(sanitizeEmailPrefs('nope')).toEqual({})
    expect(sanitizeEmailPrefs(['taskAssigned'])).toEqual({})
  })

  it('keeps only known keys with strictly-boolean values', () => {
    const input = {
      taskAssigned: false,
      workflowProgress: true,
      madeUpKey: false,
      waitingUpdates: 'false', // string — dropped, not coerced
      timeSentBack: 0, // number — dropped
    }
    expect(sanitizeEmailPrefs(input)).toEqual({
      taskAssigned: false,
      workflowProgress: true,
    })
  })

  it('accepts every catalog key', () => {
    const allOff = Object.fromEntries(EMAIL_PREF_TYPES.map((type) => [type.key, false]))
    expect(sanitizeEmailPrefs(allOff)).toEqual(allOff)
  })
})

describe('isEmailEnabledForEvent', () => {
  it('defaults to enabled with no prefs, empty prefs, or an unset key', () => {
    expect(isEmailEnabledForEvent(undefined, 'task_assigned')).toBe(true)
    expect(isEmailEnabledForEvent(null, 'task_assigned')).toBe(true)
    expect(isEmailEnabledForEvent({}, 'task_assigned')).toBe(true)
    expect(isEmailEnabledForEvent({ workflowProgress: false }, 'task_assigned')).toBe(true)
  })

  it('defaults to enabled for events outside the catalog', () => {
    expect(isEmailEnabledForEvent({ taskAssigned: false }, 'invoice_ready')).toBe(true)
    expect(isEmailEnabledForEvent({}, 'some_future_event')).toBe(true)
  })

  it('an explicit false suppresses every event in that group', () => {
    for (const type of EMAIL_PREF_TYPES) {
      const prefs = { [type.key]: false }
      for (const event of type.events) {
        expect(isEmailEnabledForEvent(prefs, event)).toBe(false)
      }
    }
  })

  it('an explicit true keeps the group enabled', () => {
    expect(isEmailEnabledForEvent({ taskAssigned: true }, 'task_assigned')).toBe(true)
  })

  it('gates Updates-tracker activity behind the updatesTracker toggle', () => {
    const off = { updatesTracker: false }
    expect(isEmailEnabledForEvent(off, 'update_created')).toBe(false)
    expect(isEmailEnabledForEvent(off, 'update_status_changed')).toBe(false)
    // Unset (the default for existing users) still emails.
    expect(isEmailEnabledForEvent({}, 'update_created')).toBe(true)
    expect(isEmailEnabledForEvent({}, 'update_status_changed')).toBe(true)
    // And turning it off doesn't silence anything else.
    expect(isEmailEnabledForEvent(off, 'task_assigned')).toBe(true)
  })
})

describe('notify() email gate', () => {
  const makeStore = (member) => ({
    createNotification: vi.fn(async (userId, event, message, link, payload) => ({
      id: 'notif-1',
      userId,
      event,
      message,
      link,
      payload,
    })),
    getTeamMember: vi.fn(async () => member),
    getClientNameById: vi.fn(async () => null),
    getClientNameForChecklist: vi.fn(async () => null),
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  const stubEmailPipeline = () => {
    vi.stubEnv('RESEND_API_KEY', 'test-key')
    vi.stubEnv('EMAIL_FROM', 'test@example.com')
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '' }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('still persists the bell notification but sends no email when the type is off', async () => {
    const fetchMock = stubEmailPipeline()
    const store = makeStore({
      id: 'emp-1',
      email: 'lisa@example.com',
      emailNotificationPrefs: { workflowProgress: false },
    })

    const created = await notify(store, 'emp-1', 'case_completed', { message: 'Workflow done' })

    expect(created).not.toBeNull()
    expect(store.createNotification).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends the email when the type is not disabled', async () => {
    const fetchMock = stubEmailPipeline()
    const store = makeStore({
      id: 'emp-1',
      email: 'lisa@example.com',
      emailNotificationPrefs: { workflowProgress: false },
    })

    await notify(store, 'emp-1', 'task_assigned', { message: 'New task: Reconcile' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.resend.com/emails')
  })

  it('sends the email when the user has no stored prefs at all', async () => {
    const fetchMock = stubEmailPipeline()
    const store = makeStore({ id: 'emp-1', email: 'lisa@example.com' })

    await notify(store, 'emp-1', 'case_completed', { message: 'Workflow done' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

/**
 * The question a blocker sends instead of finishing (featreq-8b7d06d7). It rides
 * the existing "Waiting-on updates" toggle rather than inventing a channel
 * nobody has opted into — the same reasoning that put send-back on
 * `waiting_on_requested`.
 */
describe('the waiting-on question event', () => {
  it('is listed under the waiting-on toggle, not on its own', () => {
    const waitingType = EMAIL_PREF_TYPES.find((type) => type.key === 'waitingUpdates')
    expect(waitingType.events).toContain('waiting_on_question')
    const elsewhere = EMAIL_PREF_TYPES.filter(
      (type) => type.key !== 'waitingUpdates' && type.events.includes('waiting_on_question'),
    )
    expect(elsewhere).toEqual([])
  })

  it('is suppressed by exactly the toggle it is listed under', () => {
    expect(isEmailEnabledForEvent({ waitingUpdates: false }, 'waiting_on_question')).toBe(false)
    expect(isEmailEnabledForEvent({ waitingUpdates: true }, 'waiting_on_question')).toBe(true)
    // Unset means on, like every other event here.
    expect(isEmailEnabledForEvent({}, 'waiting_on_question')).toBe(true)
  })
})

/**
 * The two waiting-on subjects carry free text a person typed — a send-back note
 * or a question. The body keeps all of it; the SUBJECT is one line in a mail
 * client, so it is trimmed here rather than left to be chopped mid-word by
 * whatever is reading it.
 */
describe('a typed message in a subject line', () => {
  const makeStore = (member) => ({
    createNotification: vi.fn(async () => ({ id: 'notif-1' })),
    getTeamMember: vi.fn(async () => member),
    getClientNameById: vi.fn(async () => null),
    getClientNameForChecklist: vi.fn(async () => null),
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  const sendAndReadSubject = async (event, message) => {
    vi.stubEnv('RESEND_API_KEY', 'test-key')
    vi.stubEnv('EMAIL_FROM', 'test@example.com')
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '' }))
    vi.stubGlobal('fetch', fetchMock)
    await notify(makeStore({ id: 'emp-1', email: 'lisa@example.com' }), 'emp-1', event, { message })
    return JSON.parse(fetchMock.mock.calls[0][1].body).subject
  }

  it('truncates a very long question rather than passing it through whole', async () => {
    const subject = await sendAndReadSubject('waiting_on_question', 'x'.repeat(900))
    expect(subject.length).toBeLessThan(300)
    expect(subject).toMatch(/…$/)
  })

  it('truncates a very long send-back note the same way', async () => {
    const subject = await sendAndReadSubject('waiting_on_requested', 'y'.repeat(900))
    expect(subject.length).toBeLessThan(300)
    expect(subject).toMatch(/…$/)
  })

  it('leaves an ordinary-length message exactly as it is', async () => {
    const subject = await sendAndReadSubject(
      'waiting_on_question',
      'Lisa has a question about "Bank rec" — which account?',
    )
    expect(subject).toBe(
      'A question about something you are waiting on: Lisa has a question about "Bank rec" — which account?',
    )
  })

  // Newlines in a header are a header-injection shape, and a textarea produces
  // them freely.
  it('flattens the newlines a textarea puts in', async () => {
    const subject = await sendAndReadSubject('waiting_on_question', 'first line\nsecond line')
    expect(subject).not.toMatch(/\n/)
    expect(subject).toContain('first line second line')
  })
})
