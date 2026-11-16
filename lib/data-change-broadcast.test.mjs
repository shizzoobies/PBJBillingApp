import { describe, expect, it } from 'vitest'
import { writeBroadcastsDataChange } from './data-change-broadcast.js'

describe('which successful API writes tell every open tab to re-read the workspace', () => {
  it('workspace writes do', () => {
    for (const path of ['/api/app-data', '/api/checklists/cl-1/toggle', '/api/invoices/inv-1/send', '/api/pending-notes']) {
      expect(writeBroadcastsDataChange(path)).toBe(true)
    }
  })

  it('a person’s own settings under /api/me/ do not (Dashboard arrangement, email toggles)', () => {
    expect(writeBroadcastsDataChange('/api/me/dashboard-layout')).toBe(false)
    expect(writeBroadcastsDataChange('/api/me/notification-prefs')).toBe(false)
  })

  it('sign-in and the event stream do not, and neither does anything outside /api/', () => {
    expect(writeBroadcastsDataChange('/api/auth/login')).toBe(false)
    expect(writeBroadcastsDataChange('/api/events')).toBe(false)
    expect(writeBroadcastsDataChange('/health')).toBe(false)
    expect(writeBroadcastsDataChange(undefined)).toBe(false)
  })

  it('a person’s own week plan does not (My Week saves on every day click)', () => {
    expect(writeBroadcastsDataChange('/api/week-plan/client-1')).toBe(false)
    expect(writeBroadcastsDataChange('/api/week-plan')).toBe(false)
    // Only that path: a neighbor that merely starts the same way still pings.
    expect(writeBroadcastsDataChange('/api/week-planner')).toBe(true)
    expect(writeBroadcastsDataChange('/api/week-plans/x')).toBe(true)
  })

  it('a path that only starts like /api/me does not slip out', () => {
    expect(writeBroadcastsDataChange('/api/members')).toBe(true)
  })
})
