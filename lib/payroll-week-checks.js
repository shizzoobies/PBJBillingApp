/**
 * The weekly payroll review's rules (featreq-20b13da0): which Sunday-to-Saturday
 * week and pay period a day belongs to, and the FLAGS the owner reads on the
 * Payroll review tab of Time Approvals.
 *
 * Pure, plain JS with a sibling .d.ts, like lib/time-entry.js: ship 1 runs it in
 * the browser (the flags on screen); the later ships run the SAME module on the
 * server, where Approve week recomputes the flags before it locks a week. One
 * rule, two callers.
 *
 * Three facts about an entry come from src/lib/payrollClock.ts, which is
 * TypeScript and so cannot be loaded by the server: how it was logged (manual,
 * clock times edited) and its clock-mismatch sentence. The caller hands those in
 * (`factsOf`), so the sentences stay the report's own, state-aware ones. When a
 * server caller needs them, payrollClock's readers move into lib/ first.
 *
 * Every sentence here must be TRUE IN EVERY STATE an entry or a split part can
 * be in, and must not accuse: a manual entry and edited clock times are facts,
 * and both are allowed.
 */

import { displayHours } from './payroll-cost.js'
import { findAlreadyLoggedTimer } from './time-entry.js'

// ---------------------------------------------------------------------------
// Weeks and pay periods
// ---------------------------------------------------------------------------

/**
 * THE PAY PERIOD ANCHOR: the Sunday the firm's two-week pay periods count from
 * (bi-weekly, Sunday to Saturday; Brittany on featreq-e01549db, 2026-11-12).
 * Periods run Nov 1-14, Nov 15-28, Nov 29-Dec 12, and backward the same way.
 *
 * A CONSTANT FOR NOW. Alex has not yet decided where it will be stored (a firm
 * setting, or with the QuickBooks export's periods: plan
 * docs/plans/payroll-week-approval-2026-11.md section 9, decision F). Keep it in
 * this one place until then; nothing else may hard-code the date.
 */
export const PAY_PERIOD_ANCHOR = '2026-11-01'

/** Her numbers (plan section 10, answer 3): flag an entry over 3 hours and a day over 8 hours. Exactly 3.00h and 8.00h are not flagged. */
export const LONG_ENTRY_HOURS = 3
export const LONG_DAY_HOURS = 8

/** Stretches of two entries overlap only when they share MORE than this (stamps round a little). */
export const OVERLAP_TOLERANCE_MINUTES = 1

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * A calendar date as a day number. The date is read as a CALENDAR DATE (its
 * three numbers at UTC midnight), never as an instant, so no time zone and no
 * daylight-saving change can move it; `isoOf` turns it back the same way.
 */
function dayNumber(date) {
  const match = typeof date === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null
  if (!match) return null
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / DAY_MS
}

function isoOf(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10)
}

/** `date` (yyyy-mm-dd) plus `days` calendar days. */
export function addDaysIso(date, days) {
  const day = dayNumber(date)
  if (day === null) throw new Error(`Not a date: ${date}`)
  return isoOf(day + days)
}

/** The Sunday that starts the Sunday-to-Saturday week holding `date`. */
export function sundayOf(date) {
  const day = dayNumber(date)
  if (day === null) throw new Error(`Not a date: ${date}`)
  // Day 0 (1970-01-01) was a Thursday: weekday = (day + 4) mod 7, Sunday = 0.
  const weekday = (((day + 4) % 7) + 7) % 7
  return isoOf(day - weekday)
}

/** The seven dates of the week that starts on `weekStart`, Sunday first. */
export function weekDates(weekStart) {
  const sunday = sundayOf(weekStart)
  return Array.from({ length: 7 }, (_, index) => addDaysIso(sunday, index))
}

/**
 * The most recent week that has ENDED on `today` (the firm's day, yyyy-mm-dd):
 * the week before the one `today` is in. On a Sunday that is the week that
 * ended yesterday.
 */
export function lastCompletedWeekStart(today) {
  return addDaysIso(sundayOf(today), -7)
}

/**
 * The pay period a date belongs to: two Sunday-to-Saturday weeks counted from
 * {@link PAY_PERIOD_ANCHOR} in steps of 14 days, backward too.
 *
 * @returns {{ start: string, end: string, weekNumber: 1 | 2, weekStarts: [string, string] }}
 */
export function payPeriodOf(date) {
  const week = dayNumber(sundayOf(date))
  const anchor = dayNumber(PAY_PERIOD_ANCHOR)
  const start = anchor + Math.floor((week - anchor) / 14) * 14
  return {
    start: isoOf(start),
    end: isoOf(start + 13),
    weekNumber: week === start ? 1 : 2,
    weekStarts: [isoOf(start), isoOf(start + 7)],
  }
}

// ---------------------------------------------------------------------------
// Stretches, overlaps, logged twice
// ---------------------------------------------------------------------------

/**
 * An entry's stretches as instants, earliest first: its `sessions` with real
 * times, or its start/stop pair when it has none (the rule of
 * `effectiveSessions` / `clockSpansOf` on the page). [] for hours only.
 */
export function stretchesOf(entry) {
  const sessions = Array.isArray(entry?.sessions) && entry.sessions.length > 0
    ? entry.sessions
    : entry?.startAt && entry?.endAt
      ? [{ startAt: entry.startAt, endAt: entry.endAt }]
      : []
  return sessions
    .map((span) => ({
      startAt: span?.startAt,
      endAt: span?.endAt,
      startMs: Date.parse(span?.startAt),
      endMs: Date.parse(span?.endAt),
    }))
    .filter((span) => Number.isFinite(span.startMs) && Number.isFinite(span.endMs) && span.endMs > span.startMs)
    .sort((a, b) => a.startMs - b.startMs)
}

/** Two parts of one split block are ONE unit: they carry the block's stretches on purpose (plan section 6). */
const sameBlock = (a, b) => Boolean(a.groupId) && a.groupId === b.groupId

function byPerson(entries) {
  const people = new Map()
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || !entry.employeeId) continue
    people.set(entry.employeeId, [...(people.get(entry.employeeId) ?? []), entry])
  }
  return people
}

function push(map, id, item) {
  map.set(id, [...(map.get(id) ?? []), item])
}

/**
 * OVERLAPS: a stretch of one entry that shares more than
 * {@link OVERLAP_TOLERANCE_MINUTES} with a stretch of ANOTHER entry of the same
 * person. The parts of one split block never overlap each other, two people
 * never overlap, and hours-only entries have nothing to overlap. Two stretches
 * of ONE entry that intersect are reported too (`otherId` is the entry itself).
 *
 * @returns {Map<string, Array<{ otherId: string, startAt: string, endAt: string, minutes: number }>>}
 *   by entry id: the OTHER entry's stretch that overlaps, and by how many minutes.
 */
export function findOverlaps(entries) {
  const found = new Map()
  const tolerance = OVERLAP_TOLERANCE_MINUTES * 60 * 1000
  for (const mine of byPerson(entries).values()) {
    const spans = mine.map((entry) => stretchesOf(entry))
    for (let i = 0; i < mine.length; i++) {
      // Inside one entry.
      for (let s = 0; s < spans[i].length; s++) {
        for (let t = s + 1; t < spans[i].length; t++) {
          const shared = Math.min(spans[i][s].endMs, spans[i][t].endMs) - Math.max(spans[i][s].startMs, spans[i][t].startMs)
          if (shared > tolerance) {
            push(found, mine[i].id, { otherId: mine[i].id, startAt: spans[i][t].startAt, endAt: spans[i][t].endAt, minutes: shared / 60000 })
          }
        }
      }
      for (let j = i + 1; j < mine.length; j++) {
        if (mine[i].id === mine[j].id || sameBlock(mine[i], mine[j])) continue
        for (const a of spans[i]) {
          for (const b of spans[j]) {
            const shared = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs)
            if (shared <= tolerance) continue
            push(found, mine[i].id, { otherId: mine[j].id, startAt: b.startAt, endAt: b.endAt, minutes: shared / 60000 })
            push(found, mine[j].id, { otherId: mine[i].id, startAt: a.startAt, endAt: a.endAt, minutes: shared / 60000 })
          }
        }
      }
    }
  }
  return found
}

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '')

/** What one hours-only entry is FOR: the fields two copies of it would share. */
const hoursOnlyKey = (entry) =>
  JSON.stringify([
    entry.date,
    entry.isAdministrative ? '' : entry.clientId || '',
    Boolean(entry.isAdministrative),
    entry.taskId || trimmed(entry.taskLabel).toLowerCase(),
    Math.round(Number(entry.minutes) * 60),
    trimmed(entry.description),
  ])

/**
 * LOGGED TWICE, by either of two rules:
 *  - `same_start`: two entries of one person hold a stretch starting at the
 *    same instant: the rule `findAlreadyLoggedTimer` refuses a new timer save
 *    by, so a pair saved before that refusal existed (or by an edit) shows here.
 *    Parts of one split block share their stretches on purpose and are skipped.
 *  - `same_hours`: two hours-only entries of one person on one day with the
 *    same client, task, minutes and description.
 *
 * @returns {Map<string, Array<{ otherId: string, rule: 'same_start' | 'same_hours', startAt?: string }>>}
 */
export function findLoggedTwice(entries) {
  const found = new Map()
  for (const mine of byPerson(entries).values()) {
    for (let i = 0; i < mine.length; i++) {
      const a = mine[i]
      const aSpans = stretchesOf(a)
      for (let j = i + 1; j < mine.length; j++) {
        const b = mine[j]
        if (a.id === b.id || sameBlock(a, b)) continue
        const bSpans = stretchesOf(b)
        if (aSpans.length > 0 && bSpans.length > 0) {
          const hit = findAlreadyLoggedTimer({ entries: [b], employeeId: a.employeeId, sessions: aSpans })
          if (hit) {
            const startMs = new Set(bSpans.map((span) => span.startMs))
            const at = aSpans.find((span) => startMs.has(span.startMs))?.startAt
            push(found, a.id, { otherId: b.id, rule: 'same_start', startAt: at })
            push(found, b.id, { otherId: a.id, rule: 'same_start', startAt: at })
          }
        } else if (aSpans.length === 0 && bSpans.length === 0 && hoursOnlyKey(a) === hoursOnlyKey(b)) {
          push(found, a.id, { otherId: b.id, rule: 'same_hours' })
          push(found, b.id, { otherId: a.id, rule: 'same_hours' })
        }
      }
    }
  }
  return found
}

// ---------------------------------------------------------------------------
// The flags
// ---------------------------------------------------------------------------

/**
 * TWO TIERS, so "N flagged" means something:
 *  - `look` (NEEDS A LOOK): a chip, counted, and kept by "Show only flagged".
 *  - `note`: plain text on the row, never counted and never a reason to show a
 *    row on its own: edited clock times (an ordinary, allowed edit) and an
 *    entry not approved yet.
 */
export const FLAG_TIERS = {
  manual: 'look',
  overlap: 'look',
  possible_duplicate: 'look',
  typed_hours: 'look',
  block_parts: 'look',
  sent_back: 'look',
  long_entry: 'look',
  long_day: 'look',
  clock_edited: 'note',
  not_approved: 'note',
}

/** Flag kinds, in the order they are shown on an entry. */
export const ENTRY_FLAG_KINDS = [
  'manual',
  'overlap',
  'possible_duplicate',
  'typed_hours',
  'block_parts',
  'sent_back',
  'long_entry',
  'clock_edited',
  'not_approved',
]

export const FLAG_LABELS = {
  manual: 'Manual entry',
  overlap: 'Overlaps another entry',
  possible_duplicate: 'Possible duplicate',
  typed_hours: 'Hours typed, not timed',
  block_parts: 'Block parts differ from clock',
  sent_back: 'Sent back',
  long_entry: 'Long entry',
  long_day: 'Long day',
  clock_edited: 'Clock times edited',
  not_approved: 'Not approved yet',
}

/**
 * The sentence for edited clock times: the SAME words as the chip on the
 * Approval queue (`CLOCK_TIMES_EDITED_TITLE` in src/lib/payrollClock.ts; a test
 * pins that the two agree).
 */
export const CLOCK_EDITED_SENTENCE =
  'The clock times on this timer entry were edited after the timer ran, by the person or by an owner. Editing is allowed; this does not say who or when.'

export const MANUAL_SENTENCE = 'This time was logged with Log time manually, not with the timer.'

export const NOT_APPROVED_SENTENCE =
  "This entry is waiting for approval. An owner approves it in the Approval queue, or by approving the person's submitted week on the Weekly submissions tab."

/** "12m", "1h 5m", "2h": whole minutes. */
export function formatMinutes(minutes) {
  const whole = Math.max(0, Math.round(Number(minutes) || 0))
  const h = Math.floor(whole / 60)
  const m = whole % 60
  if (h === 0) return `${m}m`
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

/**
 * How much two stretches share, in words. Under two minutes it is said to the
 * second ("1m 15s"), so an overlap of a little more than the one-minute
 * tolerance never reads "by 1m" beside a rule of "more than one minute".
 */
export function formatOverlap(minutes) {
  const seconds = Math.max(0, Math.round((Number(minutes) || 0) * 60))
  if (seconds >= 120) return formatMinutes(seconds / 60)
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m === 0 ? `${s}s` : s === 0 ? `${m}m` : `${m}m ${s}s`
}

const hoursText = (hours) => `${(hours === 0 ? 0 : hours).toFixed(2)}h`

const defaultTime = (iso) =>
  new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

/**
 * Every flag on every entry of a week.
 *
 * @param {Array<object>} entries - the entries on screen (any number of people).
 * @param {object} [options]
 * @param {(entry: object) => { logged?: string, mismatchNote?: string, typedHours?: boolean }} [options.factsOf]
 *   how the entry was logged (`howLogged`: 'manual', 'timer_edited', ...), its
 *   `clockMismatchNote`, and whether that note is the TYPED-hours kind (a
 *   non-empty `clockMismatchShortNote`) rather than a split block's parts, all
 *   from src/lib/payrollClock.ts.
 * @param {(entry: object) => string} [options.nameOf] - how another entry is
 *   named in a sentence (its client, or Administrative).
 * @param {(iso: string) => string} [options.formatTime] - a clock time in words.
 * @param {Array<object>} [options.others] - the entries an overlap or a
 *   duplicate is looked for among (default: `entries`); pass the shown entries
 *   plus the same people's neighbors (the day before and after the week).
 * @returns {Map<string, Array<{ kind: string, tier: 'look' | 'note', label: string, sentence: string }>>}
 *   by entry id; an entry with no flag has no key.
 */
export function entryFlags(entries, options = {}) {
  const factsOf = options.factsOf ?? (() => ({}))
  const formatTime = options.formatTime ?? defaultTime
  const pool = Array.isArray(options.others) ? options.others : entries
  const byId = new Map(pool.map((entry) => [entry.id, entry]))
  const nameOf = options.nameOf ?? ((entry) => entry.clientId || 'Administrative')
  const overlaps = findOverlaps(pool)
  const twice = findLoggedTwice(pool)
  const flags = new Map()

  for (const entry of entries) {
    const list = []
    const add = (kind, sentence) => list.push({ kind, tier: FLAG_TIERS[kind], label: FLAG_LABELS[kind], sentence })
    const facts = factsOf(entry) ?? {}
    const hours = displayHours(Number(entry.minutes) || 0)

    if (facts.logged === 'manual' || (facts.logged === undefined && entry.entryMethod === 'manual')) {
      add('manual', MANUAL_SENTENCE)
    }

    const doubles = twice.get(entry.id) ?? []
    const doubledWith = new Set(doubles.map((hit) => hit.otherId))
    // A pair already flagged as a possible duplicate is not ALSO called an
    // overlap: one sentence for one problem.
    const overlapping = (overlaps.get(entry.id) ?? []).filter((hit) => !doubledWith.has(hit.otherId))
    if (overlapping.length > 0) {
      add(
        'overlap',
        overlapping
          .map((hit) =>
            hit.otherId === entry.id
              ? `Two of this entry's own stretches overlap, by ${formatOverlap(hit.minutes)}.`
              : `Overlaps ${nameOf(byId.get(hit.otherId) ?? {})}, ${formatTime(hit.startAt)} - ${formatTime(hit.endAt)}, by ${formatOverlap(hit.minutes)}.`,
          )
          .join(' '),
      )
    }
    if (doubles.length > 0) {
      add(
        'possible_duplicate',
        doubles
          .map((hit) =>
            hit.rule === 'same_start'
              ? // The match can be any stretch, not the entry's first: never "this entry starts at".
                `Another entry has a stretch that starts at the same moment (${formatTime(hit.startAt)}): ${nameOf(byId.get(hit.otherId) ?? {})}. Check it is not a repeat.`
              : 'Another entry on this day, with no clock times, has the same client, task, hours and description.',
          )
          .join(' '),
      )
    }
    if (facts.mismatchNote) {
      if (facts.typedHours) add('typed_hours', `${facts.mismatchNote} The ${hoursText(hours)} shown is what is counted.`)
      else add('block_parts', facts.mismatchNote)
    }
    if (entry.approvalStatus === 'rejected') {
      const note = trimmed(entry.approvalNote)
      add('sent_back', note ? `Sent back to the person to fix. The note: "${note}"` : 'Sent back to the person to fix.')
    }
    if (hours > LONG_ENTRY_HOURS) add('long_entry', `More than ${LONG_ENTRY_HOURS} hours on one entry (${hoursText(hours)}).`)
    if (facts.logged === 'timer_edited') add('clock_edited', CLOCK_EDITED_SENTENCE)
    if (entry.approvalStatus === 'pending') add('not_approved', NOT_APPROVED_SENTENCE)

    if (list.length > 0) flags.set(entry.id, list)
  }
  return flags
}

/** Only the flags that NEED A LOOK (the counted chips). */
export function lookFlags(flags) {
  return (Array.isArray(flags) ? flags : []).filter((flag) => flag.tier === 'look')
}

/** The flag on a person's day line: more than {@link LONG_DAY_HOURS} hours that day (the day's hours as its line prints them). */
export function dayFlags(dayHours) {
  return dayHours > LONG_DAY_HOURS
    ? [{ kind: 'long_day', tier: 'look', label: FLAG_LABELS.long_day, sentence: `More than ${LONG_DAY_HOURS} hours logged on this day (${hoursText(dayHours)}).` }]
    : []
}
