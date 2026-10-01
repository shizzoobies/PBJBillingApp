/**
 * The firm's calendar day — "what day is it for the business?".
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Production (Railway) runs in UTC and the firm works in US Eastern. A server
 * that takes today from `new Date().toISOString().slice(0, 10)` is reading the
 * UTC day, which is already TOMORROW from 8 pm Eastern (7 pm in winter) — and
 * on the last evening of a month it is already next month. The recurring
 * checklist materializer did exactly that, and mixed it with the host's local
 * getters for the year and month, so what it produced depended on which
 * machine ran it.
 *
 * Everything here reads an instant in a NAMED zone through `Intl`, so the
 * answer is the same on a UTC container, an Eastern laptop and a CI runner.
 *
 * Plain JS with a sibling .d.ts so `src/` and the server share one file — same
 * arrangement as lib/checklist-start-floor.js. In the browser there is no
 * `process`, so the zone is always the default there; the browser spawner
 * takes its own "today" from the wall clock and uses this file only to read a
 * recipe's creation stamp the same way the server does.
 *
 * `FIRM_TIME_ZONE` is SERVER-ONLY. The browser always reads US Eastern, so do
 * not set the variable to a different zone: the server and the browser would
 * then disagree about which day a recipe's creation stamp falls on. If the firm
 * ever changes zone, change `DEFAULT_FIRM_TIME_ZONE` instead.
 */

/** The zone the firm keeps its calendar in. */
export const DEFAULT_FIRM_TIME_ZONE = 'America/New_York'

/** One formatter per zone: building an `Intl.DateTimeFormat` is the slow part. */
const formatters = new Map()
/** Zones already complained about, so a bad variable warns once, not per read. */
const rejectedZones = new Set()
/** Whether the "no zone data at all" fallback has been complained about yet. */
let warnedNoZoneData = false

/** The formatter for `timeZone`, or null when the runtime does not know it. */
function formatterFor(timeZone) {
  if (formatters.has(timeZone)) return formatters.get(timeZone)
  let formatter = null
  try {
    // en-CA writes a date as YYYY-MM-DD; the parts are read by name below
    // rather than trusting that layout.
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
  } catch {
    formatter = null
  }
  formatters.set(timeZone, formatter)
  return formatter
}

/**
 * The zone "today" is read in: `FIRM_TIME_ZONE` when the server sets it to a
 * zone the runtime knows, otherwise US Eastern.
 *
 * A value the runtime rejects falls back to the default instead of throwing.
 * The materializer asks on every `read()`, so a typo in a deploy variable must
 * cost a warning in the log, not every page load.
 *
 * @returns {string} an IANA zone name.
 */
export function firmTimeZone() {
  const configured =
    typeof process !== 'undefined' && typeof process.env?.FIRM_TIME_ZONE === 'string'
      ? process.env.FIRM_TIME_ZONE.trim()
      : ''
  if (!configured) return DEFAULT_FIRM_TIME_ZONE
  if (formatterFor(configured)) return configured
  if (!rejectedZones.has(configured)) {
    rejectedZones.add(configured)
    console.warn(
      `[firm-time] FIRM_TIME_ZONE "${configured}" is not a time zone this runtime knows; using ${DEFAULT_FIRM_TIME_ZONE}`,
    )
  }
  return DEFAULT_FIRM_TIME_ZONE
}

/**
 * The calendar date (`YYYY-MM-DD`) an instant falls on in `timeZone`.
 *
 * @param {Date} instant
 * @param {string} [timeZone] an IANA zone; the firm's when omitted or unknown.
 * @returns {string | null} null when `instant` is not a real Date.
 */
export function dateOnlyInZone(instant, timeZone = firmTimeZone()) {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) return null
  const formatter = formatterFor(timeZone) ?? formatterFor(firmTimeZone())
  // A runtime with no zone data at all cannot answer the question. The UTC day
  // is what every caller used before this file existed, and it beats throwing
  // inside a spawner that runs on every read. It says so once, because every
  // evening after 8 pm Eastern the answer is then a day off.
  if (!formatter) {
    if (!warnedNoZoneData) {
      warnedNoZoneData = true
      console.warn(
        `[firm-time] this runtime cannot resolve ${DEFAULT_FIRM_TIME_ZONE}; falling back to the UTC day`,
      )
    }
    return instant.toISOString().slice(0, 10)
  }
  const parts = {}
  for (const part of formatter.formatToParts(instant)) parts[part.type] = part.value
  return `${parts.year}-${parts.month}-${parts.day}`
}

/**
 * Today (`YYYY-MM-DD`) on the firm's calendar.
 *
 * @param {Date} [now] injectable for tests; the system clock otherwise (also
 *   when `now` is not a real Date, so this always answers with a date).
 * @returns {string}
 */
export function firmToday(now = new Date()) {
  const instant = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date()
  return dateOnlyInZone(instant, firmTimeZone())
}
