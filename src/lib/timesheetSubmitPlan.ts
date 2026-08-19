import { listBlockingWeeks } from '../../lib/time-entry.js'
import type { TimeEntry, TimesheetLock, WeeklySubmission, WeeklySubmissionStatus } from './types'
import { currentWeekStart, weekRangeOf, weekStartOf } from './utils'

/**
 * A week the guided submit flow can send to an owner right now.
 *
 * `reason` is 'rejected' when the week was already submitted and sent back —
 * the confirm copy says so, because "submit" reads differently when it's really
 * "resubmit after fixing what the owner flagged."
 */
export type SubmitTarget = {
  /** Sunday that anchors the week ('YYYY-MM-DD'). */
  weekStart: string
  /** Total minutes this user logged in that week (shown in the prompt). */
  minutes: number
  reason: 'unsubmitted' | 'rejected'
}

/** Where the current (in-progress) week stands, for the "are you finished?" question. */
export type CurrentWeekState = {
  weekStart: string
  minutes: number
  /** null when the user has never submitted this week. */
  status: WeeklySubmissionStatus | null
  /** The current week's month is sealed, so it can't be submitted at all. */
  monthLocked: boolean
  /** True when submitting it would be accepted (never submitted, or sent back). */
  eligible: boolean
}

/**
 * What the guided "Submit timesheet" modal should say and do on this click.
 *
 * - `step: 'past'` — at least one week BEFORE this one still needs submitting.
 *   `target` is the OLDEST of them and `remainingAfterTarget` counts the rest.
 * - `step: 'current'` — nothing prior is outstanding, so the flow asks the
 *   completion question about the current week; `target` is that week.
 * - `step: 'none'` — nothing prior is outstanding AND the current week can't be
 *   submitted (already pending/approved, or its month is locked). `target` is
 *   null; the modal just reports where things stand.
 */
export type TimesheetSubmitPlan = {
  step: 'past' | 'current' | 'none'
  /** Every outstanding PAST week, oldest → newest (empty unless `step` is 'past'). */
  pastWeeks: SubmitTarget[]
  target: SubmitTarget | null
  /** Past weeks still waiting AFTER `target` is submitted (0 outside `step: 'past'`). */
  remainingAfterTarget: number
  currentWeek: CurrentWeekState
}

/**
 * Decide the whole guided submit flow from data the client already holds.
 *
 * The past-week half is NOT re-derived here — it is `listBlockingWeeks` from
 * `lib/time-entry.js`, the very function the server's weekly gate runs, called
 * with `entryWeekStart === todayWeekStart` so it yields "every week before this
 * one that has logged time and is un-submitted or sent back, oldest first,
 * skipping sealed months." Sharing the call is the point: the flow and the gate
 * cannot disagree about which weeks are outstanding.
 *
 * Pure and synchronous — everything it needs is in the workspace payload
 * (`timeEntries`, `weeklySubmissions`, `timesheetLocks`), so the modal costs no
 * extra round trip and re-plans for free after each successful submit.
 *
 * @param todayWeekStart - Sunday-anchored week start of TODAY. Injected rather
 *   than read from the clock so the decision is testable.
 */
export function buildTimesheetSubmitPlan({
  employeeId,
  entries,
  submissions,
  locks,
  todayWeekStart = currentWeekStart(),
}: {
  employeeId: string
  entries: readonly TimeEntry[]
  submissions: readonly WeeklySubmission[]
  locks?: readonly TimesheetLock[]
  todayWeekStart?: string
}): TimesheetSubmitPlan {
  const lockedPeriods = new Set(
    (locks ?? []).filter((lock) => lock.userId === employeeId).map((lock) => lock.period),
  )

  // Minutes per week for this user, across every week they've logged in. The
  // key set doubles as `priorWeekStarts` for the gate — a week with no time has
  // nothing to submit and must never be named.
  const minutesByWeek = new Map<string, number>()
  for (const entry of entries) {
    if (!employeeId || entry.employeeId !== employeeId || !entry.date) continue
    const week = weekStartOf(entry.date)
    minutesByWeek.set(week, (minutesByWeek.get(week) ?? 0) + (entry.minutes ?? 0))
  }

  const mine = submissions.filter((submission) => submission.userId === employeeId)
  const statusByWeek = new Map<string, WeeklySubmissionStatus>()
  for (const submission of mine) statusByWeek.set(submission.weekStart, submission.status)

  // The server's own rule, verbatim. Asking it about an entry dated in the
  // current week is exactly the question the flow needs answered.
  const pastWeeks: SubmitTarget[] = employeeId
    ? listBlockingWeeks(todayWeekStart, minutesByWeek.keys(), mine, lockedPeriods, todayWeekStart).map(
        (week) => ({
          weekStart: week.weekStart,
          minutes: minutesByWeek.get(week.weekStart) ?? 0,
          reason: week.reason,
        }),
      )
    : []

  const currentStatus = statusByWeek.get(todayWeekStart) ?? null
  const monthLocked = lockedPeriods.has(todayWeekStart.slice(0, 7))
  const currentWeek: CurrentWeekState = {
    weekStart: todayWeekStart,
    minutes: minutesByWeek.get(todayWeekStart) ?? 0,
    status: currentStatus,
    monthLocked,
    // Same rule the week widgets already use for their button: a pending or
    // approved week is out of the user's hands; a rejected one is theirs again.
    eligible:
      Boolean(employeeId) && !monthLocked && (!currentStatus || currentStatus === 'rejected'),
  }

  if (pastWeeks.length > 0) {
    return {
      step: 'past',
      pastWeeks,
      target: pastWeeks[0],
      remainingAfterTarget: pastWeeks.length - 1,
      currentWeek,
    }
  }

  if (currentWeek.eligible) {
    return {
      step: 'current',
      pastWeeks,
      target: {
        weekStart: currentWeek.weekStart,
        minutes: currentWeek.minutes,
        reason: currentStatus === 'rejected' ? 'rejected' : 'unsubmitted',
      },
      remainingAfterTarget: 0,
      currentWeek,
    }
  }

  return { step: 'none', pastWeeks, target: null, remainingAfterTarget: 0, currentWeek }
}

/** How the page-level "Submit timesheet" button should render right now. */
export type SubmitButtonState = {
  disabled: boolean
  /** Tooltip. When disabled it says why; when enabled it says what the click does. */
  title: string
}

/**
 * Whether the page-level "Submit timesheet" button can do anything on this
 * click, and the tooltip that explains itself either way.
 *
 * The client's report: the button stayed bright and clickable after a week had
 * already been sent, which reads as "you still owe this week." It never
 * actually double-submitted — the guided modal declines to offer a pending or
 * approved week, and `submitWeeklyTimesheet` in `db/store.js` leaves an
 * approved row untouched — but the button has to say so BEFORE the click, not
 * after it opens a modal that shrugs.
 *
 * The disable is deliberately not "something has been submitted." It is "this
 * click has nothing to send" — `plan.target === null`, the same decision the
 * modal makes — and the reason quoted in the tooltip is the VIEWED week's own
 * state, so paging to a week that is still owed lights the button back up.
 *
 * One case is worth naming because it looks like an exception: the viewed week
 * is pending or approved, but an OLDER week is still owed. The button stays
 * enabled — graying it out would strand that older week, and an un-submitted
 * older week is exactly what the weekly gate blocks new time on — so instead
 * the tooltip names the week the click would actually send.
 *
 * A REJECTED week always keeps the button live: `listBlockingWeeks` queues a
 * sent-back past week, and a sent-back current week is `eligible`, so the plan
 * always has a target for it. Without that the rejection flow would dead-end.
 */
export function submitTimesheetButtonState({
  employeeId,
  entries,
  submissions,
  locks,
  viewedWeekStart,
  previewMode = false,
  todayWeekStart = currentWeekStart(),
}: {
  employeeId: string
  entries: readonly TimeEntry[]
  submissions: readonly WeeklySubmission[]
  locks?: readonly TimesheetLock[]
  /** The Sunday-anchored week the widget is showing (drives the reason text). */
  viewedWeekStart: string
  previewMode?: boolean
  todayWeekStart?: string
}): SubmitButtonState {
  if (previewMode) {
    return { disabled: true, title: 'Cannot submit while previewing as another user.' }
  }
  // No signed-in employee means nothing was computed — `buildTimesheetSubmitPlan`
  // short-circuits to an empty plan on a falsy id. Falling through would tell
  // someone they were all caught up on the strength of a lookup that never ran.
  if (!employeeId) {
    return { disabled: true, title: 'Sign in to submit a timesheet.' }
  }

  const plan = buildTimesheetSubmitPlan({ employeeId, entries, submissions, locks, todayWeekStart })
  const viewedStatus =
    submissions.find(
      (submission) => submission.userId === employeeId && submission.weekStart === viewedWeekStart,
    )?.status ?? null

  const target = plan.target
  if (target) {
    // Whenever the click would send a week OTHER than the one on screen, say so
    // — not only when the viewed week is settled. Someone looking at an owed
    // week while an even older one is queued ahead of it needs the same warning.
    if (target.weekStart !== viewedWeekStart) {
      const settled =
        viewedStatus === 'approved'
          ? 'This week is approved. '
          : viewedStatus === 'pending'
            ? 'This week is submitted and awaiting review. '
            : ''
      return {
        disabled: false,
        title: `${settled}Submitting sends the week of ${weekDayRangeLabel(target.weekStart)} ${
          settled ? 'instead' : 'first'
        }.`,
      }
    }
    return {
      disabled: false,
      title: 'Check any past weeks you still owe, then send a week for review.',
    }
  }

  if (viewedStatus === 'approved') {
    return { disabled: true, title: 'Approved — this week is closed.' }
  }
  if (viewedStatus === 'pending') {
    return { disabled: true, title: 'Submitted — awaiting review.' }
  }
  const viewedMonthLocked = (locks ?? []).some(
    (lock) => lock.userId === employeeId && lock.period === viewedWeekStart.slice(0, 7),
  )
  if (viewedMonthLocked) {
    return { disabled: true, title: 'This month is locked, so this week can no longer be submitted.' }
  }
  return { disabled: true, title: 'Nothing left to submit — every week you owe is in.' }
}

/**
 * "Sun Jul 27 – Sat Aug 2" — a week named the way the client asked for it, with
 * the weekday spelled out on both ends so there's no doubt which days are
 * included. `getWeekLabel` (used in headers) drops the weekdays and adds the
 * year; this one exists for the submit prompt's sentence copy.
 */
export function weekDayRangeLabel(weekStart: string): string {
  const { start, end } = weekRangeOf(weekStart)
  // Two formatters, not one: `{ weekday, month, day }` renders "Sun, Jul 27" in
  // en-US and the comma reads badly mid-sentence.
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short' })
  const monthDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
  const format = (iso: string) => {
    const date = new Date(`${iso}T12:00:00`)
    return `${weekday.format(date)} ${monthDay.format(date)}`
  }
  return `${format(start)} – ${format(end)}`
}
