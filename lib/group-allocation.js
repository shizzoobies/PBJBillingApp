/**
 * How one block of "group time" is divided across its member clients.
 *
 * Lives in `lib/` (plain JS) so the SERVER (`server.js`, which now owns the
 * split) and the CLIENT (`src/lib/utils.ts`, which draws the preview in the
 * split modal) run the exact same arithmetic. When these two disagreed, the
 * preview promised one thing and the saved entries were another.
 *
 * Everything here works in whole SECONDS. Time entries are seconds-precise
 * (`minutes` is `numeric` in Postgres; `coerceEntryMinutes` snaps to the second,
 * not the minute), so rounding an allocation to whole minutes threw away real
 * tracked time — a 48m 30s block split three ways used to lose 30 seconds.
 */

/** Minutes → whole seconds. The one place the seconds grid is defined. */
export function minutesToSeconds(minutes) {
  const seconds = Math.round(Number(minutes) * 60)
  return Number.isFinite(seconds) ? seconds : 0
}

/** Whole seconds → minutes (possibly fractional, e.g. 30s = 0.5). */
export function secondsToMinutes(seconds) {
  return seconds / 60
}

/**
 * Human-readable duration for messages ("2m 30s", "1h 5m", "45s").
 *
 * Deliberately mirrors `formatHoursMinutes` in `src/lib/utils.ts` so a server
 * validation message reads identically to what the modal shows on screen.
 */
export function formatDurationLabel(minutes) {
  const totalSeconds = Math.max(0, minutesToSeconds(minutes))
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  if (h === 0 && m === 0) return `${s}s`
  const parts = []
  if (h > 0) parts.push(`${h}h`)
  if (m > 0) parts.push(`${m}m`)
  if (h === 0 && s > 0) parts.push(`${s}s`)
  return parts.join(' ')
}

/**
 * Allocate `totalMinutes` of work across `clientIds` per the chosen mode and
 * return a map of clientId → minutes. Pure + deterministic.
 *
 * - `even`: the block's SECONDS are divided as evenly as possible and the
 *   leftover seconds are handed out one at a time to the first clients, so the
 *   parts sum to EXACTLY the block. Nothing is lost and nothing is invented.
 * - `full`: every client gets the whole duration. This is intentional billing
 *   semantics (a meeting that serves several clients bills each of them the
 *   full hour), so the parts deliberately do NOT sum to the block.
 * - `custom`: each client gets its own `custom[clientId]` value, snapped to the
 *   second; a missing / non-positive value becomes 0. The caller is responsible
 *   for validating that the parts add up (the server does; see the split
 *   endpoint).
 *
 * Duplicate / empty ids are ignored. Callers decide whether to drop 0-minute
 * clients before persisting.
 *
 * @param {number} totalMinutes
 * @param {string[]} clientIds
 * @param {'even'|'full'|'custom'} mode
 * @param {Record<string, number>} [custom]
 * @returns {Record<string, number>}
 */
export function allocateGroupMinutes(totalMinutes, clientIds, mode, custom = {}) {
  const ids = (clientIds ?? []).filter(
    (id, index) => Boolean(id) && clientIds.indexOf(id) === index,
  )
  const result = {}
  if (ids.length === 0) return result

  if (mode === 'full') {
    const each = secondsToMinutes(Math.max(0, minutesToSeconds(totalMinutes)))
    for (const id of ids) result[id] = each
    return result
  }

  if (mode === 'custom') {
    for (const id of ids) {
      const seconds = minutesToSeconds(custom?.[id])
      result[id] = seconds > 0 ? secondsToMinutes(seconds) : 0
    }
    return result
  }

  // even — divide the SECONDS and spread the remainder one second at a time so
  // the parts sum to exactly the block.
  const totalSeconds = Math.max(0, minutesToSeconds(totalMinutes))
  const base = Math.floor(totalSeconds / ids.length)
  let remainder = totalSeconds - base * ids.length
  for (const id of ids) {
    result[id] = secondsToMinutes(base + (remainder > 0 ? 1 : 0))
    if (remainder > 0) remainder -= 1
  }
  return result
}
