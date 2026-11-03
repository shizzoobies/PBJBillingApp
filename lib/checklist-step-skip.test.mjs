import { afterEach, describe, expect, it, vi } from 'vitest'

import { EMAIL_PREF_TYPES, isEmailEnabledForEvent } from './notification-prefs.js'
import { notify } from './notify.js'
import { nextStageRefusalMessage } from './open-next-stage.js'

/**
 * Skip a step (featreq-7e1827e0): the new notification and the owner's "could not
 * open" wording. The rest is in src/__tests__/skip-a-step*.test.ts(x) and
 * db/store-staleness.test.mjs.
 */

describe('the owner notice reuses the stage-advance sentences', () => {
  it('already_spawned reads "Step 2 is already open."', () => {
    expect(nextStageRefusalMessage('already_spawned', { stageIndex: 0 })).toBe('Step 2 is already open.')
  })
})

describe('the notification', () => {
  const savedEnv = { key: process.env.RESEND_API_KEY, from: process.env.EMAIL_FROM }
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    if (savedEnv.key === undefined) delete process.env.RESEND_API_KEY
    else process.env.RESEND_API_KEY = savedEnv.key
    if (savedEnv.from === undefined) delete process.env.EMAIL_FROM
    else process.env.EMAIL_FROM = savedEnv.from
  })

  it('is a known event with its own subject, and rides the Skipped and pushed switch', async () => {
    process.env.RESEND_API_KEY = 'test-key'
    process.env.EMAIL_FROM = 'app@example.test'
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'email-1' }), text: async () => '' })
    vi.stubGlobal('fetch', fetchMock)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = {
      createNotification: vi.fn(async (userId, event, message) => ({ userId, event, message })),
      getTeamMember: vi.fn(async () => ({ email: 'allison@example.test', emailNotificationPrefs: {} })),
      getClientNameById: vi.fn(async () => ''),
      getClientNameForChecklist: vi.fn(async () => ''),
    }
    await notify(store, 'emp-allison', 'checklist_step_skipped', { message: 'Lisa skipped step 1 of 3.', checklistId: 'cl-2' })
    expect(errors.mock.calls.some((call) => String(call[0]).includes('Unknown event'))).toBe(false)
    expect(store.createNotification).toHaveBeenCalledWith(
      'emp-allison',
      'checklist_step_skipped',
      'Lisa skipped step 1 of 3.',
      null,
      expect.anything(),
    )
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.subject).toBe('A step before yours was skipped')

    const group = EMAIL_PREF_TYPES.find((entry) => entry.key === 'skippedTasks')
    expect(group?.events).toContain('checklist_step_skipped')
    expect(isEmailEnabledForEvent({ skippedTasks: false }, 'checklist_step_skipped')).toBe(false)
    expect(isEmailEnabledForEvent({}, 'checklist_step_skipped')).toBe(true)
  })
})

