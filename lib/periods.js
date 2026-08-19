/**
 * Period helpers for the Client Recap page (monthly / quarterly / yearly).
 *
 * Pure + deterministic: any "today" is passed in as a yyyy-mm-dd string, so
 * these are unit-testable and safe to share between server and client. A
 * period is a string keyed by granularity:
 *   - month   -> "2026-08"
 *   - quarter -> "2026-Q3"  (Q1=Jan–Mar, Q2=Apr–Jun, Q3=Jul–Sep, Q4=Oct–Dec)
 *   - year    -> "2026"     (calendar year, Jan 1 – Dec 31)
 *
 * The three shapes are distinguishable on sight, which is what lets a stored or
 * URL-supplied period be validated against its own type without a separate tag.
 */

const pad = (n) => String(n).padStart(2, '0')
const lastDayOfMonth = (year, month1to12) => new Date(year, month1to12, 0).getDate()

/**
 * How many MONTHS a period covers — the multiplier that turns the client's
 * per-month planning estimates into a figure for this period. Written down once
 * here because the recap, its captions and its tests all have to agree on it:
 * a quarter is three monthly estimates, a year is twelve.
 */
export const MONTHS_IN_PERIOD = { month: 1, quarter: 3, year: 12 }

export function monthsInPeriodType(type) {
  return MONTHS_IN_PERIOD[type] ?? 1
}

export function isValidPeriodType(type) {
  return type === 'month' || type === 'quarter' || type === 'year'
}

export function isValidPeriod(type, period) {
  if (type === 'month') {
    if (!/^\d{4}-\d{2}$/.test(String(period))) return false
    const m = Number(String(period).slice(5, 7))
    return m >= 1 && m <= 12
  }
  if (type === 'quarter') return /^\d{4}-Q[1-4]$/.test(String(period))
  if (type === 'year') return /^\d{4}$/.test(String(period))
  return false
}

/** The period containing `todayIso` (yyyy-mm-dd). */
export function currentPeriod(type, todayIso) {
  const year = todayIso.slice(0, 4)
  const month = Number(todayIso.slice(5, 7))
  if (type === 'year') return year
  if (type === 'quarter') return `${year}-Q${Math.ceil(month / 3)}`
  return todayIso.slice(0, 7)
}

/** Inclusive yyyy-mm-dd date range for a period. */
export function periodRange(type, period) {
  if (type === 'year') {
    const year = Number(period.slice(0, 4))
    return { start: `${year}-01-01`, end: `${year}-12-31` }
  }
  if (type === 'quarter') {
    const year = Number(period.slice(0, 4))
    const q = Number(period.slice(6))
    const startMonth = (q - 1) * 3 + 1
    const endMonth = startMonth + 2
    return {
      start: `${year}-${pad(startMonth)}-01`,
      end: `${year}-${pad(endMonth)}-${pad(lastDayOfMonth(year, endMonth))}`,
    }
  }
  const year = Number(period.slice(0, 4))
  const month = Number(period.slice(5, 7))
  return {
    start: `${year}-${pad(month)}-01`,
    end: `${year}-${pad(month)}-${pad(lastDayOfMonth(year, month))}`,
  }
}

/** Shift a period by `dir` whole periods (e.g. -1 = previous, +1 = next). */
export function shiftPeriod(type, period, dir) {
  if (type === 'year') {
    return String(Number(period.slice(0, 4)) + dir)
  }
  if (type === 'quarter') {
    const year = Number(period.slice(0, 4))
    const q = Number(period.slice(6))
    const index = (year * 4 + (q - 1)) + dir
    const newYear = Math.floor(index / 4)
    const newQ = (index % 4) + 1
    return `${newYear}-Q${newQ}`
  }
  const year = Number(period.slice(0, 4))
  const month = Number(period.slice(5, 7))
  const index = year * 12 + (month - 1) + dir
  const newYear = Math.floor(index / 12)
  const newMonth = (index % 12) + 1
  return `${newYear}-${pad(newMonth)}`
}

export function previousPeriod(type, period) {
  return shiftPeriod(type, period, -1)
}

/** Human label, e.g. "August 2026", "Q3 2026" or "2026". */
export function periodLabel(type, period) {
  if (type === 'year') return String(period).slice(0, 4)
  if (type === 'quarter') {
    return `Q${period.slice(6)} ${period.slice(0, 4)}`
  }
  const year = Number(period.slice(0, 4))
  const month = Number(period.slice(5, 7))
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(
    new Date(year, month - 1, 1),
  )
}
