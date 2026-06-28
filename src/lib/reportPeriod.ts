/**
 * Shared "Report period" date-range model. Pure functions only — no React, no
 * app context, no I/O — so the same model can drive the Time / Timesheet /
 * Board / Checklists views today and a future client-report feature tomorrow.
 *
 * Every date is a LOCAL calendar day ('YYYY-MM-DD'); string comparison on that
 * shape is timezone-safe (no Date math at the boundaries). "today" is always
 * passed in as a 'YYYY-MM-DD' string so callers control "now" and tests stay
 * deterministic.
 */

import { weekRangeOf } from './utils'

export type ReportPreset = 'week' | 'month' | 'quarter' | 'ytd' | 'custom'

/** A selected range: a preset tag plus its resolved inclusive bounds. */
export type ReportPeriod = { preset: ReportPreset; from: string; to: string }

/** The preset options, in display order, for the control's <select>. */
export const REPORT_PRESETS: { value: ReportPreset; label: string }[] = [
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
  { value: 'quarter', label: 'This quarter' },
  { value: 'ytd', label: 'This year to date' },
  { value: 'custom', label: 'Custom' },
]

const pad = (n: number) => String(n).padStart(2, '0')

/** Last day-of-month (1–12) as a number, via the JS day-0-of-next-month trick. */
function lastDayOfMonth(year: number, month1to12: number): number {
  return new Date(year, month1to12, 0).getDate()
}

const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

/** "Jun 1" for a 'YYYY-MM-DD' day (no year). Falls back to the raw value. */
function shortDay(dateOnly: string): string {
  const [year, month, day] = dateOnly.split('-').map(Number)
  if (!year || !month || !day) return dateOnly
  return `${SHORT_MONTHS[month - 1]} ${day}`
}

/**
 * The inclusive { from, to } bounds for a non-custom preset, relative to
 * `todayDateOnly` ('YYYY-MM-DD'). All bounds are local calendar days.
 *  - week:    the Sun–Sat week containing today (via `weekRangeOf`).
 *  - month:   first → last day of today's month.
 *  - quarter: first day of the quarter's first month → last day of its last.
 *  - ytd:     Jan 1 of today's year → today.
 */
export function presetRange(
  preset: Exclude<ReportPreset, 'custom'>,
  todayDateOnly: string,
): { from: string; to: string } {
  const year = Number(todayDateOnly.slice(0, 4))
  const month = Number(todayDateOnly.slice(5, 7))

  if (preset === 'week') {
    const { start, end } = weekRangeOf(todayDateOnly)
    return { from: start, to: end }
  }

  if (preset === 'month') {
    return {
      from: `${year}-${pad(month)}-01`,
      to: `${year}-${pad(month)}-${pad(lastDayOfMonth(year, month))}`,
    }
  }

  if (preset === 'quarter') {
    const startMonth = Math.floor((month - 1) / 3) * 3 + 1
    const endMonth = startMonth + 2
    return {
      from: `${year}-${pad(startMonth)}-01`,
      to: `${year}-${pad(endMonth)}-${pad(lastDayOfMonth(year, endMonth))}`,
    }
  }

  // ytd
  return { from: `${year}-01-01`, to: todayDateOnly }
}

/** The default period a fresh user gets: the current calendar month. */
export function defaultReportPeriod(todayDateOnly: string): ReportPeriod {
  const { from, to } = presetRange('month', todayDateOnly)
  return { preset: 'month', from, to }
}

/** Inclusive membership test: p.from <= dateOnly <= p.to (string compare). */
export function isInReportPeriod(dateOnly: string, p: ReportPeriod): boolean {
  if (!dateOnly) return false
  return dateOnly >= p.from && dateOnly <= p.to
}

/**
 * Human label for a period, e.g. "Jun 1 – Jun 30, 2026". When the bounds span
 * different years the year is shown on both ends ("Dec 1, 2025 – Jan 31, 2026").
 */
export function reportPeriodLabel(p: ReportPeriod): string {
  const fromYear = p.from.slice(0, 4)
  const toYear = p.to.slice(0, 4)
  if (fromYear !== toYear) {
    return `${shortDay(p.from)}, ${fromYear} – ${shortDay(p.to)}, ${toYear}`
  }
  return `${shortDay(p.from)} – ${shortDay(p.to)}, ${toYear}`
}

/** A plausible 'YYYY-MM-DD' string (shape check only, not a real-date check). */
function isDateOnly(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

/**
 * Validate a persisted (untrusted) value into a usable ReportPeriod, without
 * any `any` casts. For non-custom presets the from/to are ALWAYS re-derived
 * from `todayDateOnly` (so "This month" means *this* month on every load, not
 * the month it was saved in). For a custom period the stored from/to are kept
 * when they're valid 'YYYY-MM-DD' days (swapped if reversed); anything invalid
 * falls back to the default month.
 */
export function normalizeReportPeriod(raw: unknown, todayDateOnly: string): ReportPeriod {
  if (!raw || typeof raw !== 'object') return defaultReportPeriod(todayDateOnly)
  const candidate = raw as { preset?: unknown; from?: unknown; to?: unknown }
  const preset = candidate.preset

  if (
    preset === 'week' ||
    preset === 'month' ||
    preset === 'quarter' ||
    preset === 'ytd'
  ) {
    const { from, to } = presetRange(preset, todayDateOnly)
    return { preset, from, to }
  }

  if (preset === 'custom') {
    if (isDateOnly(candidate.from) && isDateOnly(candidate.to)) {
      const from = candidate.from <= candidate.to ? candidate.from : candidate.to
      const to = candidate.from <= candidate.to ? candidate.to : candidate.from
      return { preset: 'custom', from, to }
    }
    return defaultReportPeriod(todayDateOnly)
  }

  return defaultReportPeriod(todayDateOnly)
}

/**
 * True when the period covers EXACTLY one Sun–Sat week — i.e. its bounds equal
 * `weekRangeOf(p.from)`. Drives the Timesheet's single-week (weekly
 * submit/lock) vs multi-week (read-only range) modes. Independent of `todayDateOnly`,
 * which is accepted for signature symmetry with the other helpers.
 */
export function isSingleWeek(p: ReportPeriod, _todayDateOnly: string): boolean {
  void _todayDateOnly
  const { start, end } = weekRangeOf(p.from)
  return p.from === start && p.to === end
}
