import type { TimeEntry } from './types'
import { allocateByPercentages, allocateGroupMinutes, sessionMinutes } from './utils'

/**
 * How the Timesheet page turns time entries into the rows and totals it draws.
 *
 * THE RULE this module exists to enforce: an entry's billed duration is ALWAYS
 * `entry.minutes`. Session spans say WHEN the work happened, never HOW MUCH is
 * billed. The two are allowed to disagree, and in this app they routinely do:
 *
 *  - a SPLIT SLICE carries the whole source block's `sessions` verbatim — that
 *    is how clock-in/out survives a split (see the split methods in
 *    `db/store.js`) — while billing only its own allocated share.
 *  - an entry whose duration was TYPED bills the typed figure and keeps its
 *    untouched spans as the audit trail — the same principle as
 *    `minutesAfterEntryEdit` in `lib/group-allocation.js`.
 *
 * Reading a row's duration off its span broke both cases, and the firm owner saw
 * the first one: Lisa's Aug 14 had one 25-minute block split 20 ways, and the
 * page drew ~25 minutes against each of the 20 clients — 8.3 invented hours on
 * top of her real day.
 */

/** One row in the timesheet: a work session, or the whole entry when it has no
 *  session breakdown (legacy/manual entries). `minutes` is BILLED time. */
export type Segment = {
  entry: TimeEntry
  startAt?: string
  endAt?: string
  minutes: number
}

export type TimesheetDay = { date: string; segments: Segment[]; total: number }

/**
 * The rows one entry contributes, and what each of them bills.
 *
 * The spans decide only WHERE the minutes go, never how many there are:
 * `entry.minutes` is apportioned across them in proportion to each span, on the
 * seconds grid with the leftover second handed out by largest remainder, so the
 * rows sum to EXACTLY `entry.minutes`. One session is trivially its own minutes.
 */
export function entrySegments(entry: TimeEntry): Segment[] {
  const sessions = entry.sessions ?? []
  if (sessions.length === 0) {
    return [{ entry, startAt: entry.startAt, endAt: entry.endAt, minutes: entry.minutes }]
  }
  if (sessions.length === 1) {
    const [only] = sessions
    return [{ entry, startAt: only.startAt, endAt: only.endAt, minutes: entry.minutes }]
  }
  const spans = sessions.map((session) => sessionMinutes(session))
  const spanTotal = spans.reduce((sum, span) => sum + span, 0)
  const keys = sessions.map((_, index) => String(index))
  const share =
    spanTotal > 0
      ? allocateByPercentages(
          entry.minutes,
          Object.fromEntries(keys.map((key, index) => [key, (spans[index] / spanTotal) * 100])),
        )
      : // No usable clock (zero-length or malformed spans): there is nothing to
        // weight by, so the minutes divide evenly — still summing to the entry.
        allocateGroupMinutes(entry.minutes, keys, 'even')
  return sessions.map((session, index) => ({
    entry,
    startAt: session.startAt,
    endAt: session.endAt,
    minutes: share[keys[index]] ?? 0,
  }))
}

/**
 * The days a set of entries makes up: each entry's segments filed under its
 * date in clock-in order, newest day first.
 *
 * A day's total is the BILLED minutes of its segments — which, because
 * `entrySegments` apportions each entry's own `minutes`, is exactly the sum of
 * the day's entries. It is never the sum of their spans: split slices share one
 * block's spans, so adding those up counted the same stretch of clock once per
 * client. The page's range and week totals are sums of these day totals, so they
 * inherit the same guarantee.
 */
export function timesheetDays(entries: TimeEntry[]): TimesheetDay[] {
  const byDate = new Map<string, Segment[]>()
  for (const entry of entries) {
    const list = byDate.get(entry.date) ?? []
    list.push(...entrySegments(entry))
    byDate.set(entry.date, list)
  }
  return [...byDate.entries()]
    // Most-recent day first, like the rest of the time views.
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, segments]) => ({
      date,
      segments: segments.slice().sort((x, y) => (x.startAt ?? '').localeCompare(y.startAt ?? '')),
      total: segments.reduce((sum, seg) => sum + seg.minutes, 0),
    }))
}
