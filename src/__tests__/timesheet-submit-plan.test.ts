import { describe, expect, it } from 'vitest'
import {
  buildTimesheetSubmitPlan,
  weekDayRangeLabel,
} from '../lib/timesheetSubmitPlan'
import type { TimeEntry, TimesheetLock, WeeklySubmission } from '../lib/types'

/**
 * `buildTimesheetSubmitPlan` is the decision behind the guided "Submit
 * timesheet" modal: given the weeks a user has logged time in, their weekly
 * submissions, their month locks, and today's week, it answers "which week does
 * this click submit, and what should the prompt say?"
 *
 * The past-week half delegates to the server's own `listBlockingWeeks`, so
 * these cases double as a guard that the flow and the weekly gate stay aligned:
 * a week the gate would treat as settled must never be queued here.
 */

// Sundays. TODAY is inside the week of 2026-08-09.
const WEEK_JUL_19 = '2026-07-19'
const WEEK_JUL_26 = '2026-07-26'
const WEEK_AUG_02 = '2026-08-02'
const TODAY_WEEK = '2026-08-09'

const ME = 'emp-me'

let seq = 0
function entry(employeeId: string, date: string, minutes = 60): TimeEntry {
  seq += 1
  return {
    id: `time-${seq}`,
    employeeId,
    clientId: 'client-1',
    date,
    minutes,
    description: 'Work',
    approvalStatus: 'pending',
  } as TimeEntry
}

function submission(
  userId: string,
  weekStart: string,
  status: WeeklySubmission['status'],
): WeeklySubmission {
  seq += 1
  return {
    id: `sub-${seq}`,
    userId,
    weekStart,
    submittedAt: `${weekStart}T12:00:00.000Z`,
    status,
  }
}

function lock(userId: string, period: string): TimesheetLock {
  seq += 1
  return { id: `lock-${seq}`, userId, period, lockedBy: 'owner-1', lockedAt: `${period}-28` }
}

function plan({
  entries = [] as TimeEntry[],
  submissions = [] as WeeklySubmission[],
  locks = [] as TimesheetLock[],
  employeeId = ME,
} = {}) {
  return buildTimesheetSubmitPlan({
    employeeId,
    entries,
    submissions,
    locks,
    todayWeekStart: TODAY_WEEK,
  })
}

describe('buildTimesheetSubmitPlan', () => {
  it('queues every unsubmitted past week oldest-first and targets the oldest', () => {
    const result = plan({
      entries: [
        entry(ME, '2026-08-04'), // week of Aug 2
        entry(ME, '2026-07-21'), // week of Jul 19
        entry(ME, '2026-07-29'), // week of Jul 26
        entry(ME, '2026-08-11'), // current week
      ],
    })

    expect(result.step).toBe('past')
    expect(result.pastWeeks.map((week) => week.weekStart)).toEqual([
      WEEK_JUL_19,
      WEEK_JUL_26,
      WEEK_AUG_02,
    ])
    expect(result.target?.weekStart).toBe(WEEK_JUL_19)
    // Two more queued behind the target — what the modal counts down.
    expect(result.remainingAfterTarget).toBe(2)
  })

  it('carries each past week total minutes so the prompt can name the hours', () => {
    const result = plan({
      entries: [entry(ME, '2026-07-21', 90), entry(ME, '2026-07-23', 30)],
    })

    expect(result.target).toEqual({ weekStart: WEEK_JUL_19, minutes: 120, reason: 'unsubmitted' })
  })

  it('skips past weeks that are already submitted or approved', () => {
    const result = plan({
      entries: [entry(ME, '2026-07-21'), entry(ME, '2026-07-29'), entry(ME, '2026-08-04')],
      submissions: [
        submission(ME, WEEK_JUL_19, 'approved'),
        submission(ME, WEEK_JUL_26, 'pending'),
      ],
    })

    expect(result.pastWeeks.map((week) => week.weekStart)).toEqual([WEEK_AUG_02])
  })

  it('counts a rejected (sent-back) past week as still needing submission', () => {
    const result = plan({
      entries: [entry(ME, '2026-07-21'), entry(ME, '2026-08-04')],
      submissions: [
        submission(ME, WEEK_JUL_19, 'rejected'),
        submission(ME, WEEK_AUG_02, 'pending'),
      ],
    })

    expect(result.step).toBe('past')
    expect(result.target?.weekStart).toBe(WEEK_JUL_19)
    // The modal uses this to say "an owner sent this back" instead of "submit".
    expect(result.target?.reason).toBe('rejected')
    expect(result.remainingAfterTarget).toBe(0)
  })

  it('excludes weeks in a locked month exactly as the weekly gate does', () => {
    const result = plan({
      entries: [entry(ME, '2026-07-21'), entry(ME, '2026-07-29'), entry(ME, '2026-08-04')],
      locks: [lock(ME, '2026-07')],
    })

    // July is sealed — the owner closed it, so neither July week is the user's
    // to submit. Only the August week is queued.
    expect(result.pastWeeks.map((week) => week.weekStart)).toEqual([WEEK_AUG_02])
  })

  it("ignores another user's entries, submissions, and locks", () => {
    const result = plan({
      entries: [entry('emp-other', '2026-07-21'), entry(ME, '2026-08-04')],
      submissions: [submission('emp-other', WEEK_AUG_02, 'approved')],
      locks: [lock('emp-other', '2026-08')],
    })

    expect(result.pastWeeks.map((week) => week.weekStart)).toEqual([WEEK_AUG_02])
  })

  it('never queues a past week with no logged time', () => {
    const result = plan({ entries: [entry(ME, '2026-08-11')] })

    expect(result.pastWeeks).toEqual([])
    expect(result.step).toBe('current')
  })

  it('asks the current-week question once nothing prior is outstanding', () => {
    const result = plan({
      entries: [entry(ME, '2026-07-21'), entry(ME, '2026-08-11', 45)],
      submissions: [submission(ME, WEEK_JUL_19, 'approved')],
    })

    expect(result.step).toBe('current')
    expect(result.pastWeeks).toEqual([])
    expect(result.target).toEqual({ weekStart: TODAY_WEEK, minutes: 45, reason: 'unsubmitted' })
    expect(result.currentWeek.eligible).toBe(true)
    expect(result.remainingAfterTarget).toBe(0)
  })

  it('offers the current week as a resubmit when it was sent back', () => {
    const result = plan({
      entries: [entry(ME, '2026-08-11')],
      submissions: [submission(ME, TODAY_WEEK, 'rejected')],
    })

    expect(result.step).toBe('current')
    expect(result.target?.reason).toBe('rejected')
  })

  it('offers nothing when the current week is already pending review', () => {
    const result = plan({
      entries: [entry(ME, '2026-08-11')],
      submissions: [submission(ME, TODAY_WEEK, 'pending')],
    })

    expect(result.step).toBe('none')
    expect(result.target).toBeNull()
    expect(result.currentWeek.status).toBe('pending')
    expect(result.currentWeek.eligible).toBe(false)
  })

  it('offers nothing when the current month is locked', () => {
    const result = plan({
      entries: [entry(ME, '2026-08-11')],
      locks: [lock(ME, '2026-08')],
    })

    expect(result.step).toBe('none')
    expect(result.currentWeek.monthLocked).toBe(true)
    expect(result.currentWeek.eligible).toBe(false)
  })

  it('asks about the current week even when nothing has been logged yet', () => {
    const result = plan()

    expect(result.step).toBe('current')
    expect(result.currentWeek.minutes).toBe(0)
  })

  it('past weeks always win over the current week', () => {
    const result = plan({
      entries: [entry(ME, '2026-08-04'), entry(ME, '2026-08-11')],
    })

    expect(result.step).toBe('past')
    expect(result.target?.weekStart).toBe(WEEK_AUG_02)
    // The current week is still described — the modal needs it for the next step.
    expect(result.currentWeek.weekStart).toBe(TODAY_WEEK)
    expect(result.currentWeek.eligible).toBe(true)
  })
})

describe('weekDayRangeLabel', () => {
  it('names both ends with their weekday, the way the prompt reads', () => {
    expect(weekDayRangeLabel('2026-07-26')).toBe('Sun Jul 26 – Sat Aug 1')
    expect(weekDayRangeLabel(TODAY_WEEK)).toBe('Sun Aug 9 – Sat Aug 15')
  })
})
