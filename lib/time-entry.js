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
  const minutes = sessions.reduce(
    (sum, s) => sum + Math.round((new Date(s.endAt).getTime() - new Date(s.startAt).getTime()) / 60000),
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
