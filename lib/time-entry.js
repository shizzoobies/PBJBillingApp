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
 * The three things a human has to say before time can be SAVED: which client,
 * which task, and what they actually did. Keyed by field so the UI can put each
 * prompt under the field it belongs to instead of one lump error at the bottom.
 */
export const TIME_ENTRY_FIELD_PROMPTS = {
  client: 'Pick a client to log this time.',
  task: 'Pick or type a task to log this time.',
  detail: 'Add a detail to log this time.',
}

/** How each missing field is named inside the server's combined message. */
const TIME_ENTRY_FIELD_NAMES = {
  client: 'a client',
  task: 'a task',
  detail: 'a detail (what you worked on)',
}

/** "a, b and c" — the server names EVERY missing field in one go. */
function joinFieldNames(names) {
  if (names.length <= 1) return names[0] ?? ''
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * Is this payload a GROUP block — one block of time that belongs to several
 * clients rather than one? Either an unsplit holding entry (its members in
 * `groupClientIds`) or a slice of an already-split group (`groupId`).
 *
 * Group blocks are the one shape where a task can be genuinely absent: the
 * block spans several clients' work and the timer form never offers a task for
 * it, so tasks (and per-client detail) are settled when the block is split.
 * The CLIENT requirement is satisfied by the member list, and the DETAIL
 * requirement still applies — a group block with no note is exactly as useless
 * to review as any other.
 */
function isGroupBlockPayload(input) {
  const groupClientIds = Array.isArray(input?.groupClientIds) ? input.groupClientIds : []
  const groupId = typeof input?.groupId === 'string' ? input.groupId.trim() : ''
  return groupClientIds.filter(Boolean).length > 0 || Boolean(groupId)
}

/**
 * The mandatory-fields rule for LOGGING time, shared by the server's create
 * path and the Time page (so the inline prompts and the 400 can never
 * disagree). Requested by the firm owner: "require Client, Task and Detail
 * before time can be logged."
 *
 *   - non-administrative: a client (a single one, or a group's members), a task
 *     (an attached checklist task OR a typed name — the pick-or-type box counts
 *     either way), and a detail;
 *   - administrative: no client or task by definition, but STILL a detail — a
 *     human reason for the internal time;
 *   - group blocks: see {@link isGroupBlockPayload} — client satisfied by the
 *     members, task not required, detail required.
 *
 * Starting a timer is deliberately NOT covered: a timer starts instantly with
 * nothing filled in and the fields are demanded at Stop & log.
 *
 * @returns `{ missing, error }` — `missing` is the field keys (`client`,
 *   `task`, `detail`) in prompt order, `error` a single human sentence naming
 *   all of them, or `null` when nothing is missing.
 */
export function validateTimeEntryRequiredFields(input = {}) {
  const isAdministrative = Boolean(input?.isAdministrative)
  const description = typeof input?.description === 'string' ? input.description.trim() : ''
  const clientId = typeof input?.clientId === 'string' ? input.clientId.trim() : ''
  const taskId = typeof input?.taskId === 'string' ? input.taskId.trim() : ''
  const taskLabel = typeof input?.taskLabel === 'string' ? input.taskLabel.trim() : ''
  const groupClientIds = Array.isArray(input?.groupClientIds)
    ? input.groupClientIds.filter(Boolean)
    : []
  const isGroupBlock = !isAdministrative && isGroupBlockPayload(input)

  const missing = []
  if (!isAdministrative && !clientId && groupClientIds.length === 0) missing.push('client')
  if (!isAdministrative && !isGroupBlock && !taskId && !taskLabel) missing.push('task')
  if (!description) missing.push('detail')

  if (missing.length === 0) return { missing, error: null }

  // Administrative time keeps its own long-standing wording — it only ever
  // misses the note, and "needs a note describing the work" says why.
  if (isAdministrative) {
    return { missing, error: 'Administrative time needs a note describing the work.' }
  }

  const names = joinFieldNames(missing.map((field) => TIME_ENTRY_FIELD_NAMES[field]))
  return {
    missing,
    error: `Time can't be logged without ${names}. Add ${
      missing.length > 1 ? 'them' : 'it'
    } and log it again.`,
  }
}

/**
 * The same rule applied to an EDIT (`PATCH /api/time-entries/:id`): an edit may
 * not take a required field that was filled in and empty it.
 *
 * Only the detail is guarded, and only when the entry HAD one:
 *   - legacy rows saved before this rule (blank description) must keep loading
 *     and stay editable — you can still fix their minutes, client or date —
 *     so a blank-to-blank patch is allowed;
 *   - the task is deliberately NOT guarded here. The edit form's task picker
 *     only offers the chosen client's checklists, so re-targeting an entry to a
 *     client with no tasks would otherwise be an unescapable dead end. Clearing
 *     a task on an existing entry stays possible; logging NEW time without one
 *     does not.
 *   - the client is already guarded by the PATCH handler itself ("Pick a
 *     client, or mark the entry as administrative.").
 *
 * @param {{description?: unknown}} entry - the stored entry, before the patch.
 * @param {{description?: unknown}} payload - the raw PATCH body.
 * @returns `{ error }` — a human message, or `null` when the edit is allowed.
 */
export function validateTimeEntryEdit(entry = {}, payload = {}) {
  const wantsDescription =
    payload !== null &&
    typeof payload === 'object' &&
    Object.prototype.hasOwnProperty.call(payload, 'description')
  if (!wantsDescription) return { error: null }

  const nextDescription =
    typeof payload.description === 'string' ? payload.description.trim() : ''
  if (nextDescription) return { error: null }

  const currentDescription =
    typeof entry?.description === 'string' ? entry.description.trim() : ''
  // Nothing to clear (legacy blank row) — let the rest of the edit through.
  if (!currentDescription) return { error: null }

  return {
    error: `Time can't be logged without ${TIME_ENTRY_FIELD_NAMES.detail}. Add it and log it again.`,
  }
}

/**
 * What `isAdhoc` should become on an edit — or `undefined` for "don't touch it".
 *
 * THE ORDERING IS THE WHOLE POINT, which is why this takes where the entry ENDS
 * UP rather than where it started. One save can both re-file an administrative
 * entry onto a client AND tick the ad hoc box (the Time page's edit form builds
 * exactly that body). Clamping the flag against the entry's state BEFORE the
 * re-target read "this is administrative time, it can't be ad hoc" and dropped
 * the tick on the floor — silently, with the box still ticked on screen until
 * the next reload.
 *
 * Two rules, in this order:
 *   1. An entry that ends up ADMINISTRATIVE is never ad hoc — it has no client
 *      to be outside the scope of. Matches the create path exactly.
 *   2. Otherwise the person's own answer stands.
 *
 * Returns `undefined` when nobody asked and the move didn't force it, so a
 * no-op save adds no key — which matters, because an added key is what
 * `editRequiresReapproval` counts as a change worth revoking a sign-off for.
 *
 * @param {object} args
 * @param {object|null} args.payload - the PATCH body.
 * @param {boolean} args.effectiveIsAdministrative - admin state AFTER the edit.
 * @param {boolean} args.becameAdministrative - did THIS edit make it admin?
 */
export function adhocAfterEntryEdit({
  payload,
  effectiveIsAdministrative,
  becameAdministrative = false,
}) {
  const asked =
    payload !== null &&
    typeof payload === 'object' &&
    typeof payload.isAdhoc === 'boolean'

  if (effectiveIsAdministrative) {
    // Forced off — but only write it when there is something to force: either
    // the caller asked for a flag it cannot have, or this edit is what turned
    // the entry into administrative time (which has to clear any flag it
    // already carried).
    return asked || becameAdministrative ? false : undefined
  }
  return asked ? payload.isAdhoc : undefined
}

/**
 * Does this edit cost the entry its sign-off?
 *
 * Editing an approved (or rejected) entry normally sends it back through
 * approval: a changed client, duration or date must never keep an old approval
 * silently. A patch that changes nothing at all is exempt, so a save with no
 * edits in it can't churn the queue.
 *
 * ONE further exemption: an OWNER changing nothing but `isAdhoc`. Approval asks
 * "is this record of the work right", and the ad hoc flag does not touch that —
 * it decides how the time BILLS. The person flipping it is the approver, and
 * the review surface is where they are meant to flip it, so revoking their own
 * sign-off would make the backstop yank the row out of the list they are
 * working through. Anyone else's ad hoc edit still re-queues, and so does an
 * owner's the moment it carries any other field.
 *
 * Lives here rather than inline in the route so the rule can be tested — the
 * same reason `validateTimeEntryEdit` above does.
 *
 * @param {string} approvalStatus - the entry's status BEFORE the patch.
 * @param {object} patch - the fields about to be written.
 * @param {boolean} isOwner - is the person making the edit an owner?
 */
export function editRequiresReapproval(approvalStatus, patch = {}, isOwner = false) {
  if (approvalStatus !== 'approved' && approvalStatus !== 'rejected') return false
  return Object.keys(patch ?? {}).some((key) => !(isOwner && key === 'isAdhoc'))
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
