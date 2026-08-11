/**
 * Shared time-entry input rules.
 *
 * Lives in `lib/` (plain JS) so both the server (`server.js`) and the test
 * suite can import the exact same logic — the manual-entry gate must not be
 * duplicated and drift.
 */

/**
 * Normalize the capture-method fields of an incoming time-entry payload and
 * enforce the manual-entry rule: a `manual` entry requires a non-empty reason.
 *
 * Returns `{ entryMethod, manualReason, error }`:
 *   - `entryMethod` is always `'timer'` unless the payload explicitly asked
 *     for `'manual'`.
 *   - `manualReason` is the trimmed reason for a valid manual entry, otherwise
 *     `undefined` — timer entries never carry a reason.
 *   - `error` is a human-readable string when the input is invalid, otherwise
 *     `null`.
 */
export function normalizeTimeEntryMethod(payload = {}) {
  const isManual = payload?.entryMethod === 'manual'
  const entryMethod = isManual ? 'manual' : 'timer'
  const manualReason =
    isManual && typeof payload?.manualReason === 'string'
      ? payload.manualReason.trim()
      : ''

  if (isManual && !manualReason) {
    return {
      entryMethod,
      manualReason: undefined,
      error: 'A reason is required for manual time entries.',
    }
  }

  return {
    entryMethod,
    manualReason: entryMethod === 'manual' ? manualReason : undefined,
    error: null,
  }
}

/**
 * Validate + normalize an incoming `sessions` array (each an exact start/stop
 * span) and derive the authoritative totals from it.
 *
 * Returns `{ sessions, minutes, startAt, endAt, error }`:
 *   - When `rawSessions` is `undefined`/`null` (field omitted), every field is
 *     `undefined` and `error` is `null` — the caller should leave sessions
 *     untouched.
 *   - When it's a valid non-empty array, `sessions` is the cleaned ISO pairs,
 *     `minutes` is the summed duration, and `startAt`/`endAt` are the
 *     first-start / last-stop envelope.
 *   - Invalid input (not an array, a bad/zero-length span, or an empty array)
 *     yields an `error` string.
 */
export function normalizeWorkSessions(rawSessions) {
  if (rawSessions === undefined || rawSessions === null) {
    return { sessions: undefined, minutes: undefined, startAt: undefined, endAt: undefined, error: null }
  }
  if (!Array.isArray(rawSessions)) {
    return { error: 'Sessions must be a list of start/stop spans.' }
  }
  if (rawSessions.length === 0) {
    return { error: 'An entry needs at least one work session.' }
  }
  const sessions = []
  for (const raw of rawSessions) {
    const start = typeof raw?.startAt === 'string' ? new Date(raw.startAt) : null
    const end = typeof raw?.endAt === 'string' ? new Date(raw.endAt) : null
    if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return { error: 'Each session needs a valid start and stop time.' }
    }
    if (end.getTime() <= start.getTime()) {
      return { error: 'Each session must stop after it starts.' }
    }
    sessions.push({ startAt: start.toISOString(), endAt: end.toISOString() })
  }
  // Seconds-precise duration (minutes can be fractional, e.g. 45s = 0.75) so a
  // sub-minute timer stop is logged exactly instead of rounded away.
  const minutes = sessions.reduce(
    (sum, s) =>
      sum + Math.round((new Date(s.endAt).getTime() - new Date(s.startAt).getTime()) / 1000) / 60,
    0,
  )
  const startMs = Math.min(...sessions.map((s) => new Date(s.startAt).getTime()))
  const endMs = Math.max(...sessions.map((s) => new Date(s.endAt).getTime()))
  return {
    sessions,
    minutes,
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(endMs).toISOString(),
    error: null,
  }
}

/**
 * The Sunday (yyyy-mm-dd) that anchors the US Sun–Sat work week containing
 * `dateStr`. Noon avoids any DST/timezone boundary flip; getDay() of a calendar
 * date's weekday is timezone-independent.
 *
 * Lives here beside the weekly gate because every caller that needs a
 * blocking-week answer also needs the same week anchor — the server's timer
 * gate and the assistant's diagnose_time_logging tool must not disagree about
 * which week a date belongs to.
 */
export function weekStartOf(dateStr) {
  const d = new Date(`${dateStr}T12:00:00`)
  d.setDate(d.getDate() - d.getDay())
  return d.toISOString().slice(0, 10)
}

/**
 * The weekly-submission gate, as a pure rule shared by the server and tests.
 *
 * A bookkeeper is blocked from logging NEW time only when a PRIOR week's
 * timesheet has been REJECTED by an owner and sent back for changes —
 * resubmitting that week is the one thing in the bookkeeper's control. An
 * un-submitted or still-pending prior week does NOT block: weekly submission
 * is a nudge, not a wall, and "awaiting the owner's approval" is out of the
 * bookkeeper's hands (this is the behavior firm owners asked for after the
 * original force-submit gate locked staff out of the timer).
 *
 * The gate only applies to NEW work — an entry dated in the CURRENT week or
 * later. Backfilling a week that has already ended never gates; see
 * `listBlockingWeeks`.
 *
 * @param {string} entryWeekStart - Sunday-anchored weekStart ('YYYY-MM-DD') of
 *   the new entry being logged.
 * @param {Iterable<string>} priorWeekStarts - Sunday-anchored weekStarts the
 *   user already has time entries in (any weeks; this function filters to those
 *   strictly before `entryWeekStart`).
 * @param {Array<{weekStart: string, status: string}>} submissions - the user's
 *   weekly submissions ({ weekStart, status } — extra fields ignored).
 * @param {Iterable<string>} [lockedPeriods] - see `listBlockingWeeks`.
 * @param {string} todayWeekStart - REQUIRED; see `listBlockingWeeks`.
 * @returns {{weekStart: string, reason: 'unsubmitted' | 'rejected'} | null} the
 *   earliest prior week with logged time that must be submitted/resubmitted
 *   before logging on (un-submitted or rejected), or `null` when nothing blocks.
 */
export function findBlockingWeek(
  entryWeekStart,
  priorWeekStarts,
  submissions,
  lockedPeriods,
  todayWeekStart,
) {
  return (
    listBlockingWeeks(entryWeekStart, priorWeekStarts, submissions, lockedPeriods, todayWeekStart)[0] ??
    null
  )
}

/**
 * Every prior week with logged time that must be submitted/resubmitted before
 * logging on — the full list behind `findBlockingWeek`, oldest → newest.
 *
 * `findBlockingWeek` returns only the earliest of these (what the gate keys
 * off). This plural form lets the caller name ALL blockers in one message so a
 * bookkeeper who skipped several weeks submits them in a single pass instead of
 * discovering them one 423 at a time.
 *
 * @param {string} entryWeekStart - see `findBlockingWeek`.
 * @param {Iterable<string>} priorWeekStarts - see `findBlockingWeek`.
 * @param {Array<{weekStart: string, status: string}>} submissions - see above.
 * @param {Iterable<string>} [lockedPeriods] - 'YYYY-MM' months the user's
 *   timesheet is LOCKED (sealed) for. A week whose month is locked never gates:
 *   the owner has closed that month, so staff can't (and shouldn't need to)
 *   submit it to log later time. This also covers the case where locking a
 *   month auto-approved its entries but left no weekly-submission row behind,
 *   which would otherwise make a sealed week look "un-submitted."
 * @param {string} todayWeekStart - REQUIRED Sunday-anchored weekStart of TODAY.
 *   The gate only fires for an entry in the current week or later; anything
 *   earlier is a backfill and never gates. Deliberately not optional: a caller
 *   that forgets it would silently re-introduce the old, wrong behavior, so it
 *   throws instead.
 * @returns {Array<{weekStart: string, reason: 'unsubmitted' | 'rejected'}>} the
 *   blocking prior weeks, oldest → newest (empty when nothing blocks).
 */
export function listBlockingWeeks(
  entryWeekStart,
  priorWeekStarts,
  submissions,
  lockedPeriods,
  todayWeekStart,
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(todayWeekStart ?? ''))) {
    throw new TypeError(
      'listBlockingWeeks requires todayWeekStart as a YYYY-MM-DD week anchor (weekStartOf(today)).',
    )
  }

  // The gate forces the weekly submission cadence for NEW work only. An entry
  // dated in a week that has already ENDED is someone catching up on a week they
  // forgot — exactly what we want them to do — so it never gates. Editing an
  // entry (PATCH) has never had a weekly gate, and a past-week create now agrees
  // with it. Month locks are a separate, earlier check and still apply.
  // ISO dates compare correctly as strings, same as the prior-week filter below.
  if (entryWeekStart < todayWeekStart) return []

  const lockedMonths = lockedPeriods instanceof Set ? lockedPeriods : new Set(lockedPeriods ?? [])
  // Only PRIOR weeks that actually have logged time can gate — and never a week
  // inside a locked (sealed) month.
  const priorWeeks = [
    ...new Set([...(priorWeekStarts ?? [])].filter((weekStart) => weekStart < entryWeekStart)),
  ]
    .filter((weekStart) => !lockedMonths.has(weekStart.slice(0, 7)))
    .sort()
  if (priorWeeks.length === 0) return []

  const statusByWeek = new Map()
  for (const submission of submissions ?? []) {
    if (submission && submission.weekStart) statusByWeek.set(submission.weekStart, submission.status)
  }

  // Oldest → newest: a prior week that is UN-SUBMITTED (no submission row) or
  // REJECTED (sent back) blocks. A submitted/pending/approved week does NOT
  // block — once submitted it's out of staff's hands, so an awaiting-approval
  // week never locks them out of the timer.
  const blocking = []
  for (const weekStart of priorWeeks) {
    const status = statusByWeek.get(weekStart)
    if (!status) blocking.push({ weekStart, reason: 'unsubmitted' })
    else if (status === 'rejected') blocking.push({ weekStart, reason: 'rejected' })
  }
  return blocking
}
