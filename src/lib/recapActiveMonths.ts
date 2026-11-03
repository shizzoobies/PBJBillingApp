/**
 * How the Client Recap words the months it counted (featreq-8dffdff7).
 *
 * A quarter or a year counts only the months the client was ACTIVE - from its
 * first time entry, invoice or set-up through the current month (an inactive
 * client stops at its last activity). The server decides which months those
 * are (lib/client-recap.js `clientActiveMonths`) and why each other month was
 * left out; this file only says it, so the page and the CSV export use the
 * same words.
 */
import type { ClientRecap } from './api'

/** The recap fields these captions read. All optional: an older payload has none of them. */
export type RecapActivity = Partial<
  Pick<
    ClientRecap,
    | 'monthsInPeriod'
    | 'calendarMonthsInPeriod'
    | 'activeMonths'
    | 'activeInPeriod'
    | 'clientSince'
    | 'isBillingMaster'
    | 'activeMonthsUniform'
    | 'periodNotStarted'
    | 'uncountedMonths'
    | 'subs'
    | 'range'
  >
>

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2026-08" -> "Aug 2026"; anything else is returned as given. */
export function monthShort(month: string | null | undefined): string {
  const match = /^(\d{4})-(\d{2})$/.exec(String(month ?? ''))
  if (!match) return String(month ?? '')
  return `${SHORT_MONTHS[Number(match[2]) - 1] ?? match[2]} ${match[1]}`
}

/** ["2026-08", ..., "2026-11"] -> "Aug–Nov 2026"; one month -> "Nov 2026"; none -> "". */
export function activeSpanLabel(months: string[] | null | undefined): string {
  const list = months ?? []
  if (list.length === 0) return ''
  const first = list[0]
  const last = list[list.length - 1]
  if (first === last) return monthShort(first)
  if (first.slice(0, 4) === last.slice(0, 4)) {
    return `${monthShort(first).slice(0, 3)}–${monthShort(last)}`
  }
  return `${monthShort(first)}–${monthShort(last)}`
}

/** True when a billing master's companies counted different months. */
const isMixedMaster = (activity: RecapActivity) =>
  activity.isBillingMaster === true && activity.activeMonthsUniform === false

/** True when the server counted fewer months than the calendar holds. */
export function isTrimmed(activity: RecapActivity | null | undefined): boolean {
  if (!activity || !Array.isArray(activity.activeMonths)) return false
  if (isMixedMaster(activity)) return true
  const calendar = activity.calendarMonthsInPeriod ?? activity.monthsInPeriod ?? 0
  return activity.activeMonths.length < calendar
}

/**
 * The Estimate column header's note.
 *
 * Unchanged when every month counted: " (monthly estimates × 12 months)", and
 * nothing for a single month. Otherwise it names the months, e.g.
 * " (monthly estimates × 4 months: Aug–Nov 2026, client since Aug 2026)".
 */
export function scaledEstimateNote(
  monthsInPeriod: number,
  activity: RecapActivity | null = null,
): string {
  if (!activity || !isTrimmed(activity)) {
    return monthsInPeriod > 1 ? ` (monthly estimates × ${monthsInPeriod} months)` : ''
  }
  if (isMixedMaster(activity)) return ' (monthly estimates × each company’s own active months)'
  const months = activity.activeMonths ?? []
  if (months.length === 0) {
    return activity.periodNotStarted ? ' (period not started yet)' : ' (not active in this period)'
  }
  const rangeStart = String(activity.range?.start ?? '').slice(0, 7)
  const since =
    activity.clientSince && rangeStart && activity.clientSince >= rangeStart
      ? `, client since ${monthShort(activity.clientSince)}`
      : ''
  const unit = months.length === 1 ? 'month' : 'months'
  return ` (monthly estimates × ${months.length} ${unit}: ${activeSpanLabel(months)}${since})`
}

/** What to print in an Estimate cell when the period has none to show. */
export function noEstimateWord(activity: RecapActivity | null | undefined): string | null {
  if (!activity || activity.activeInPeriod !== false) return null
  return activity.periodNotStarted ? 'Not started yet' : 'Not active'
}

/**
 * One sentence for the Billing and Profitability captions saying which months
 * were counted and why the others were not - null when every month of the
 * period counted, so the page reads exactly as it always did.
 */
export function activeMonthsSentence(activity: RecapActivity | null | undefined): string | null {
  if (!activity || !isTrimmed(activity)) return null
  const calendar = activity.calendarMonthsInPeriod ?? activity.monthsInPeriod ?? 0
  if (isMixedMaster(activity)) {
    const parts = (activity.subs ?? [])
      .filter((sub) => typeof sub.monthsInPeriod === 'number')
      .map((sub) => `${sub.name} ${sub.monthsInPeriod} of ${calendar}`)
    return (
      'Estimates and plan fees count each company’s own active months' +
      (parts.length > 0 ? ` (${parts.join(', ')})` : '') +
      ' — from its first time entry, invoice or set-up through the current month.'
    )
  }
  const months = activity.activeMonths ?? []
  if (months.length === 0) {
    if (activity.periodNotStarted) {
      return 'This period hasn’t started yet, so nothing is planned or priced for it.'
    }
    const rangeEnd = String(activity.range?.end ?? '').slice(0, 7)
    if (activity.clientSince && rangeEnd && activity.clientSince > rangeEnd) {
      return `Not active in this period — this client’s first activity on record is ${monthShort(activity.clientSince)}, so nothing is planned or priced for it.`
    }
    return 'Not active in this period — none of its months count, so nothing is planned or priced for it.'
  }
  const counted = `Counted ${months.length} of ${calendar} months (${activeSpanLabel(months)}).`
  const uncounted = activity.uncountedMonths
  if (!uncounted) {
    return `${counted} Months before the client’s first time entry, invoice or set-up, months not yet begun, and months after an inactive client’s last activity are left out.`
  }
  const reasons = [
    uncounted.beforeStart.length > 0
      ? `${activeSpanLabel(uncounted.beforeStart)} is before the client’s first activity on record`
      : null,
    uncounted.notYetBegun.length > 0
      ? `${activeSpanLabel(uncounted.notYetBegun)} ${uncounted.notYetBegun.length === 1 ? 'has' : 'have'} not started yet`
      : null,
    uncounted.afterLastActivity.length > 0
      ? `${activeSpanLabel(uncounted.afterLastActivity)} is after this inactive client’s last activity`
      : null,
  ].filter((reason): reason is string => reason !== null)
  return reasons.length > 0 ? `${counted} Left out: ${reasons.join('; ')}.` : counted
}

/**
 * The CSV's "Active months" cell: the span, "None", or - on a billing master
 * whose companies counted different months - each company's own span.
 */
export function activeMonthsCell(activity: RecapActivity): string {
  if (isMixedMaster(activity)) {
    return (activity.subs ?? [])
      .map((sub) => `${sub.name}: ${sub.activeMonths?.length ? activeSpanLabel(sub.activeMonths) : 'None'}`)
      .join('; ')
  }
  const months = activity.activeMonths ?? []
  return months.length === 0 ? 'None' : activeSpanLabel(months)
}
