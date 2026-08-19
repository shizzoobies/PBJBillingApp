import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TimesheetPage } from '../pages/TimesheetPage'
import type { AppContextValue } from '../AppContext'
import type { AppData, TimeEntry, TimesheetLock, WeeklySubmission } from '../lib/types'

/**
 * featreq-cbb7efe8: "the submit button remains clickable even after a week or
 * pay period has already been submitted."
 *
 * It never actually double-submitted — clicking it opened the guided modal,
 * which declines to offer a pending or approved week — but a bright, live
 * button after you have already sent the week reads as "you still owe this,"
 * and people clicked it again to find out.
 *
 * These pin the button itself, rendered through the real Timesheet page, one
 * case per submission state. The two that must NOT gray out are the ones that
 * would dead-end someone: a sent-back week (the resubmit path) and a week that
 * is settled while an OLDER week is still owed.
 */

const ME = 'emp-me'
const WEEK = '2026-08-09' // Sunday of the current week
const PRIOR_WEEK = '2026-08-02'
// Wednesday inside the week of Sun Aug 9, 2026.
const TODAY = new Date('2026-08-12T12:00:00')

let seq = 0
function entry(date: string, minutes = 60): TimeEntry {
  seq += 1
  return {
    id: `time-${seq}`,
    employeeId: ME,
    clientId: 'client-1',
    date,
    minutes,
    description: 'Work',
    approvalStatus: 'pending',
  } as TimeEntry
}

function submission(weekStart: string, status: WeeklySubmission['status']): WeeklySubmission {
  seq += 1
  return {
    id: `sub-${seq}`,
    userId: ME,
    weekStart,
    submittedAt: `${weekStart}T12:00:00.000Z`,
    status,
  }
}

let contextValue: AppContextValue

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))

function renderPage({
  entries = [entry('2026-08-11')],
  submissions = [] as WeeklySubmission[],
  locks = [] as TimesheetLock[],
  previewMode = false,
  employeeId = ME,
} = {}) {
  const data = {
    clients: [{ id: 'client-1', name: 'Acme' }],
    employees: [{ id: ME, name: 'Lisa Chen', role: 'Bookkeeper' }],
    checklists: [],
    timeEntries: entries,
    weeklySubmissions: submissions,
    timesheetLocks: locks,
  } as unknown as AppData

  contextValue = {
    data,
    role: 'employee',
    activeEmployeeId: employeeId,
    visibleEntries: entries,
    previewMode,
    reportPeriod: { preset: 'week', from: WEEK, to: '2026-08-15' },
    setReportPeriod: vi.fn(),
    submitWeeklyTimesheet: vi.fn().mockResolvedValue(undefined),
  } as unknown as AppContextValue

  render(<TimesheetPage />)
  return screen.getByRole('button', { name: 'Submit timesheet' })
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(TODAY)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Submit timesheet button state', () => {
  it('stays clickable for a week that has never been submitted', () => {
    const button = renderPage()

    expect(button).toBeEnabled()
    expect(button).toHaveAttribute(
      'title',
      'Check any past weeks you still owe, then send a week for review.',
    )
  })

  it('grays out once the week is submitted, and says it is awaiting review', () => {
    const button = renderPage({ submissions: [submission(WEEK, 'pending')] })

    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'Submitted — awaiting review.')
  })

  it('grays out once the week is approved, and says the week is closed', () => {
    const button = renderPage({ submissions: [submission(WEEK, 'approved')] })

    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'Approved — this week is closed.')
  })

  it('stays clickable for a SENT-BACK week — the resubmit path must not dead-end', () => {
    const button = renderPage({ submissions: [submission(WEEK, 'rejected')] })

    expect(button).toBeEnabled()
    // The click targets this very week, so it gets the plain invitation — not
    // one of the "sends a different week" redirects.
    expect(button).toHaveAttribute(
      'title',
      'Check any past weeks you still owe, then send a week for review.',
    )
  })

  it('names the week the click will send when an older week is queued ahead of this one', () => {
    // Both weeks are owed and neither is settled — the redirect warning is not
    // just for weeks that are already in.
    const button = renderPage({
      entries: [entry('2026-08-04'), entry('2026-08-11')],
    })

    expect(button).toBeEnabled()
    expect(button).toHaveAttribute(
      'title',
      'Submitting sends the week of Sun Aug 2 – Sat Aug 8 first.',
    )
  })

  it('grays out with a sign-in reason when there is no active employee', () => {
    // Nothing was computed, so "you are all caught up" would be a lie.
    const button = renderPage({ employeeId: '' })

    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'Sign in to submit a timesheet.')
  })

  it('stays clickable when the viewed week is settled but an older week is still owed', () => {
    // Disabling here would strand the week of Aug 2 — and an un-submitted older
    // week is exactly what the weekly gate blocks new time on.
    const button = renderPage({
      entries: [entry('2026-08-04'), entry('2026-08-11')],
      submissions: [submission(WEEK, 'pending')],
    })

    expect(button).toBeEnabled()
    expect(button).toHaveAttribute(
      'title',
      'This week is submitted and awaiting review. Submitting sends the week of Sun Aug 2 – Sat Aug 8 instead.',
    )
  })

  it('grays out for a locked month even when the week was never submitted', () => {
    const button = renderPage({
      locks: [
        {
          id: 'lock-1',
          userId: ME,
          period: '2026-08',
          lockedBy: 'owner-1',
          lockedAt: '2026-08-31',
        } as TimesheetLock,
      ],
    })

    expect(button).toBeDisabled()
    expect(button).toHaveAttribute(
      'title',
      'This month is locked, so this week can no longer be submitted.',
    )
  })

  it('grays out while previewing as another user', () => {
    const button = renderPage({ previewMode: true })

    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'Cannot submit while previewing as another user.')
  })

  it('keys on the week on screen, not on "anything has been submitted"', () => {
    // The prior week is in and approved; this week is untouched. A global
    // "already submitted" check would wrongly gray this out.
    const button = renderPage({
      entries: [entry('2026-08-04'), entry('2026-08-11')],
      submissions: [submission(PRIOR_WEEK, 'approved')],
    })

    expect(button).toBeEnabled()
  })
})
