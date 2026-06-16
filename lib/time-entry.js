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
 * @param {string} entryWeekStart - Sunday-anchored weekStart ('YYYY-MM-DD') of
 *   the new entry being logged.
 * @param {Iterable<string>} priorWeekStarts - Sunday-anchored weekStarts the
 *   user already has time entries in (any weeks; this function filters to those
 *   strictly before `entryWeekStart`).
 * @param {Array<{weekStart: string, status: string}>} submissions - the user's
 *   weekly submissions ({ weekStart, status } — extra fields ignored).
 * @returns {string|null} the earliest prior week with logged time whose
 *   submission is `rejected` (the one to fix first), or `null` when nothing
 *   blocks.
 */
export function findBlockingRejectedWeek(entryWeekStart, priorWeekStarts, submissions) {
  const priorWeeks = new Set(
    [...(priorWeekStarts ?? [])].filter((weekStart) => weekStart < entryWeekStart),
  )
  if (priorWeeks.size === 0) return null
  const rejectedPriorWeeks = (submissions ?? [])
    .filter(
      (submission) =>
        submission &&
        submission.status === 'rejected' &&
        priorWeeks.has(submission.weekStart),
    )
    .map((submission) => submission.weekStart)
    .sort()
  return rejectedPriorWeeks[0] ?? null
}
