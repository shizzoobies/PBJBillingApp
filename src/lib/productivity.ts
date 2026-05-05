// Productivity report helpers — date-range presets, period bucketing, and
// business-day arithmetic. Pure functions so they're easy to test and reuse.

export type Granularity = 'daily' | 'weekly'

export type DateRangePreset =
  | 'this-week'
  | 'last-week'
  | 'this-month'
  | 'last-month'
  | 'custom'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function pad(n: number) {
  return n < 10 ? `0${n}` : String(n)
}

function toIso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function parseIso(iso: string): Date {
  // Anchor at noon to avoid DST edge weirdness when shifting by days.
  return new Date(`${iso}T12:00:00`)
}

function shiftDays(iso: string, days: number): string {
  const d = parseIso(iso)
  d.setDate(d.getDate() + days)
  return toIso(d)
}

/**
 * Mon=0..Sun=6. Treat the ISO date as local-noon so the weekday is stable.
 */
function dayOfWeekMonZero(iso: string): number {
  const d = parseIso(iso).getDay() // 0=Sun..6=Sat
  return (d + 6) % 7 // 0=Mon..6=Sun
}

/**
 * Date-range preset definitions. Weeks are Monday–Sunday. Months are
 * calendar months in the local timezone.
 */
export function rangeForPreset(
  preset: DateRangePreset,
  today: Date = new Date(),
): { from: string; to: string } {
  const todayIso = toIso(today)

  if (preset === 'this-week') {
    const offset = dayOfWeekMonZero(todayIso)
    const from = shiftDays(todayIso, -offset)
    const to = shiftDays(from, 6)
    return { from, to }
  }

  if (preset === 'last-week') {
    const offset = dayOfWeekMonZero(todayIso)
    const thisMonday = shiftDays(todayIso, -offset)
    const from = shiftDays(thisMonday, -7)
    const to = shiftDays(from, 6)
    return { from, to }
  }

  if (preset === 'this-month') {
    const y = today.getFullYear()
    const m = today.getMonth()
    const from = `${y}-${pad(m + 1)}-01`
    const lastDay = new Date(y, m + 1, 0).getDate()
    const to = `${y}-${pad(m + 1)}-${pad(lastDay)}`
    return { from, to }
  }

  if (preset === 'last-month') {
    const y = today.getFullYear()
    const m = today.getMonth()
    const from = `${m === 0 ? y - 1 : y}-${pad(m === 0 ? 12 : m)}-01`
    const lastDay = new Date(y, m, 0).getDate()
    const to = `${m === 0 ? y - 1 : y}-${pad(m === 0 ? 12 : m)}-${pad(lastDay)}`
    return { from, to }
  }

  // 'custom' — caller manages dates; default to this-week.
  return rangeForPreset('this-week', today)
}

/**
 * Returns ordered ISO date strings (yyyy-mm-dd) representing each period
 * between from..to inclusive.
 *
 * - granularity 'daily' → one entry per calendar day
 * - granularity 'weekly' → one entry per Monday-anchored week. The first entry
 *   is the Monday on or before `fromIso`; the last entry is the Monday on or
 *   before `toIso`.
 */
export function periodsBetween(
  fromIso: string,
  toIso: string,
  granularity: Granularity,
): string[] {
  if (!ISO_DATE.test(fromIso) || !ISO_DATE.test(toIso)) {
    return []
  }
  if (toIso < fromIso) return []

  const out: string[] = []

  if (granularity === 'daily') {
    let cursor = fromIso
    let safety = 0
    while (cursor <= toIso && safety < 5000) {
      out.push(cursor)
      cursor = shiftDays(cursor, 1)
      safety += 1
    }
    return out
  }

  // weekly: align to Monday on or before fromIso.
  const startOffset = dayOfWeekMonZero(fromIso)
  let cursor = shiftDays(fromIso, -startOffset)
  let safety = 0
  while (cursor <= toIso && safety < 1000) {
    out.push(cursor)
    cursor = shiftDays(cursor, 7)
    safety += 1
  }
  return out
}

/**
 * Map an ISO date (yyyy-mm-dd) or ISO timestamp to its bucket key for the
 * given granularity. For 'weekly', returns the Monday on or before the date.
 */
export function bucketKeyForDate(
  isoDateOrTimestamp: string,
  granularity: Granularity,
): string {
  const dateOnly = isoDateOrTimestamp.slice(0, 10)
  if (!ISO_DATE.test(dateOnly)) return dateOnly
  if (granularity === 'daily') return dateOnly
  const offset = dayOfWeekMonZero(dateOnly)
  return shiftDays(dateOnly, -offset)
}

/**
 * Bucket items by period using the value at `dateKey` (an ISO date or
 * timestamp string). Returns an object whose keys are the period start dates
 * from `periods`, each mapped to the items that fall in that bucket.
 */
export function bucketByPeriod<T>(
  items: T[],
  dateKey: keyof T,
  periods: string[],
  granularity: Granularity,
): Record<string, T[]> {
  const out: Record<string, T[]> = {}
  for (const p of periods) out[p] = []
  const periodSet = new Set(periods)
  for (const item of items) {
    const raw = item[dateKey]
    if (typeof raw !== 'string') continue
    const key = bucketKeyForDate(raw, granularity)
    if (periodSet.has(key)) {
      out[key].push(item)
    }
  }
  return out
}

/** Mon–Fri only. */
export function isBusinessDay(iso: string): boolean {
  if (!ISO_DATE.test(iso)) return false
  const dow = dayOfWeekMonZero(iso) // 0=Mon..6=Sun
  return dow <= 4
}

/** Inclusive count of Mon–Fri days between fromIso..toIso. */
export function businessDaysIn(fromIso: string, toIso: string): number {
  if (!ISO_DATE.test(fromIso) || !ISO_DATE.test(toIso)) return 0
  if (toIso < fromIso) return 0
  let count = 0
  let cursor = fromIso
  let safety = 0
  while (cursor <= toIso && safety < 5000) {
    if (isBusinessDay(cursor)) count += 1
    cursor = shiftDays(cursor, 1)
    safety += 1
  }
  return count
}

/** Inclusive count of all calendar days between fromIso..toIso. */
export function calendarDaysIn(fromIso: string, toIso: string): number {
  if (!ISO_DATE.test(fromIso) || !ISO_DATE.test(toIso)) return 0
  if (toIso < fromIso) return 0
  const start = parseIso(fromIso).getTime()
  const end = parseIso(toIso).getTime()
  return Math.round((end - start) / (24 * 60 * 60 * 1000)) + 1
}

/** Short label for a period start date — used as x-axis ticks. */
export function formatPeriodLabel(iso: string, granularity: Granularity): string {
  if (!ISO_DATE.test(iso)) return iso
  const d = parseIso(iso)
  if (granularity === 'daily') {
    return `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()}`
  }
  return `Wk ${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()}`
}

export const PRESET_LABELS: Record<DateRangePreset, string> = {
  'this-week': 'This week',
  'last-week': 'Last week',
  'this-month': 'This month',
  'last-month': 'Last month',
  custom: 'Custom',
}
