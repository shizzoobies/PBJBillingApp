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

/**
 * How far a set of percentages may drift from 100 and still count as 100.
 * Typing 33.33 / 33.33 / 33.34 adds up to exactly 100 in decimal but not always
 * in binary floating point, and the owner must not be blocked by dust she can't
 * see. Anything larger than this is a real gap she has to close.
 */
const PERCENT_EPSILON = 0.0001

/** Do these percentages add up to 100 (allowing for float dust)? */
export function percentagesTotalTo100(percents) {
  let total = 0
  for (const value of Object.values(percents ?? {})) {
    const percent = Number(value)
    if (Number.isFinite(percent)) total += percent
  }
  return Math.abs(total - 100) <= PERCENT_EPSILON
}

/**
 * Allocate `totalMinutes` across clients by PERCENTAGE — "give Acme 60% and
 * Bright Books 40%" instead of "give Acme 36 minutes and Bright Books 24".
 *
 * Percentages are a friendlier way to SAY a custom split; they are not a new
 * kind of split. What gets persisted is still `group_allocation = 'custom'` —
 * the stored mode vocabulary ('even' | 'custom' | 'full') and every rule built
 * on it (payroll counts a 'full' block once, the split endpoint demands
 * 'even'/'custom' account for every second) stay exactly as they were. The
 * caller converts percentages to minutes with this function and submits the
 * resulting minutes as a normal custom split.
 *
 * The percentages MUST total 100 — the caller validates that (see
 * `percentagesTotalTo100`), because only the caller can tell the owner which
 * number to change. Given that, the parts here sum to EXACTLY the block: the
 * work is done in whole SECONDS, each client gets the floor of its share, and
 * the leftover seconds go out one at a time by LARGEST REMAINDER, ties broken by
 * the order the ids appear in `percents` (the modal builds that map in its
 * on-screen client order, so the first client on screen wins a tie). If the
 * percentages do NOT total 100 the result is honestly short or over — it is not
 * silently stretched to fill the block.
 *
 * @param {number} totalMinutes
 * @param {Record<string, number>} percents - clientId → percentage (may be fractional).
 * @returns {Record<string, number>} clientId → minutes, on the seconds grid.
 */
export function allocateByPercentages(totalMinutes, percents) {
  const ids = Object.keys(percents ?? {}).filter((id) => Boolean(id))
  const result = {}
  if (ids.length === 0) return result

  const totalSeconds = Math.max(0, minutesToSeconds(totalMinutes))
  const shares = ids.map((id, index) => {
    const percent = Number(percents[id])
    const exact = Number.isFinite(percent) && percent > 0 ? (totalSeconds * percent) / 100 : 0
    const whole = Math.floor(exact)
    return { id, index, whole, remainder: exact - whole }
  })

  // The leftover seconds are only MEANT to be spread when the percentages
  // describe the whole block. If they don't total 100 the floors stand, so the
  // result is visibly short (or over) instead of being stretched to fit.
  if (percentagesTotalTo100(percents)) {
    let leftover = totalSeconds - shares.reduce((sum, share) => sum + share.whole, 0)
    // Largest remainder first; a tie keeps the caller's client order.
    const byRemainder = [...shares].sort((a, b) => b.remainder - a.remainder || a.index - b.index)
    for (const share of byRemainder) {
      if (leftover <= 0) break
      share.whole += 1
      leftover -= 1
    }
  }

  for (const share of shares) result[share.id] = secondsToMinutes(share.whole)
  return result
}

/**
 * The reverse: what percentages produced these minutes. Used to open the
 * percentage view over an EXISTING split, so "Adjust split" shows 60 / 40
 * rather than making the owner work it out from 36m and 24m.
 *
 * Rounded to 2 decimal places and adjusted (largest remainder again, in
 * hundredths of a percent) so the numbers on screen ADD UP TO 100 — a plain
 * round would show 33.33 / 33.33 / 33.33 and immediately fail the caller's
 * own 100% check. With no minutes to go on (a zero-length block) it falls back
 * to even percentages, which is what the inputs would default to anyway.
 *
 * @param {Record<string, number>} allocations - clientId → minutes.
 * @param {number} totalMinutes - the block those minutes divide.
 * @returns {Record<string, number>} clientId → percentage, 2dp, summing to 100.
 */
export function percentagesFromMinutes(allocations, totalMinutes) {
  const ids = Object.keys(allocations ?? {}).filter((id) => Boolean(id))
  const result = {}
  if (ids.length === 0) return result

  const totalSeconds = Math.max(0, minutesToSeconds(totalMinutes))
  // Work in HUNDREDTHS of a percent so 2dp rounding is exact integer arithmetic.
  const shares = ids.map((id, index) => {
    const seconds = Math.max(0, minutesToSeconds(allocations[id]))
    const exact = totalSeconds > 0 ? (seconds * 10000) / totalSeconds : 10000 / ids.length
    const whole = Math.floor(exact)
    return { id, index, whole, remainder: exact - whole }
  })

  let leftover = 10000 - shares.reduce((sum, share) => sum + share.whole, 0)
  const byRemainder = [...shares].sort(
    (a, b) => b.remainder - a.remainder || a.index - b.index,
  )
  for (const share of byRemainder) {
    if (leftover <= 0) break
    share.whole += 1
    leftover -= 1
  }

  for (const share of shares) result[share.id] = share.whole / 100
  return result
}

/**
 * What kind of split target a time entry is. Splitting started life as a
 * group-timer-only feature; ANY client-billed entry can now be divided across
 * clients, so the store, the endpoint and the modal all need to tell the cases
 * apart the same way — hence one shared rule here rather than three copies of
 * `!clientId && !isAdministrative && members.length > 0`.
 *
 *  - `holding`        — an unsplit group block: no single client, not admin,
 *                       member clients parked in `groupClientIds`. That member
 *                       list IS the allowed target set.
 *  - `regular`        — an ordinary client-billed entry. A slice from an
 *                       earlier split counts too (it carries a `groupId`, but
 *                       its minutes are just minutes) — the caller names the
 *                       target clients explicitly.
 *  - `administrative` — internal time; there is no client to divide.
 *  - `unsplittable`   — no client and no members: malformed, or a holding block
 *                       someone already split.
 *
 * @param {{clientId?: string, isAdministrative?: boolean, groupClientIds?: string[]}} entry
 * @returns {'holding'|'regular'|'administrative'|'unsplittable'}
 */
export function classifySplitTarget(entry) {
  if (!entry) return 'unsplittable'
  if (entry.isAdministrative) return 'administrative'
  if (entry.clientId) return 'regular'
  const members = Array.isArray(entry.groupClientIds)
    ? entry.groupClientIds.filter((id) => typeof id === 'string' && id)
    : []
  return members.length > 0 ? 'holding' : 'unsplittable'
}

/**
 * The checkbox list a REGULAR-entry split opens with: every client the user is
 * allowed to bill, by name, with the entry's CURRENT client pulled to the front
 * so the client it is splitting away from is never buried in a long list.
 *
 * Pure so the modal and its test agree on the ordering. Duplicate and id-less
 * rows are dropped.
 *
 * `currentClientId` may be a LIST — an existing split's member clients, when the
 * modal reopens to adjust that split. Every id in it is pinned to the front, in
 * the order given, so the clients already in the split lead the picker.
 *
 * @param {Array<{id: string, name?: string}>} clients
 * @param {string|string[]} [currentClientId]
 * @returns {Array<{id: string, name: string}>}
 */
export function splitClientOptions(clients, currentClientId) {
  const seen = new Set()
  const options = []
  for (const client of clients ?? []) {
    if (!client || typeof client.id !== 'string' || !client.id || seen.has(client.id)) continue
    seen.add(client.id)
    options.push({ id: client.id, name: String(client.name ?? '') })
  }
  options.sort((a, b) => a.name.localeCompare(b.name))
  const pinned = (Array.isArray(currentClientId) ? currentClientId : [currentClientId]).filter(
    (id) => typeof id === 'string' && id,
  )
  // Back to front, so the pinned ids end up at the head in their own order.
  for (let index = pinned.length - 1; index >= 0; index -= 1) {
    const at = options.findIndex((option) => option.id === pinned[index])
    if (at > 0) options.unshift(...options.splice(at, 1))
  }
  return options
}

/** Whole seconds across a list of `{startAt, endAt}` spans. Bad spans count 0. */
function sessionsTotalSeconds(sessions) {
  let total = 0
  for (const session of sessions ?? []) {
    const start = session?.startAt ? new Date(session.startAt).getTime() : NaN
    const end = session?.endAt ? new Date(session.endAt).getTime() : NaN
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) continue
    total += Math.round((end - start) / 1000)
  }
  return total
}

/**
 * What a GROUP SLICE's `minutes` becomes when its `sessions` are edited.
 *
 * A slice carries the ORIGINAL block's sessions verbatim (that's its clock-in/
 * out provenance) but its own ALLOCATED minutes — 20 minutes of a 60-minute
 * block. The normal edit path derives minutes from sessions, which on a slice
 * silently blew the allocation back up to the full block: fixing a typo in the
 * description of a three-way split turned 20+20+20 into 60+60+60. That is
 * exactly "it will not let me adjust my time entry without losing the client
 * split I chose".
 *
 * So a slice's sessions edit moves its minutes by the DELTA instead of
 * replacing them: an unchanged clock leaves the allocation exactly as it was,
 * and Resume / Add time still add the time they added. Falls back to the plain
 * sessions total when there is nothing to diff against, or when the delta would
 * wipe the slice out.
 *
 * @param {number} currentMinutes - the slice's allocated minutes today.
 * @param {Array<{startAt: string, endAt: string}>} previousSessions
 * @param {Array<{startAt: string, endAt: string}>} nextSessions
 * @returns {number} minutes, on the seconds grid.
 */
export function sliceMinutesAfterSessionEdit(currentMinutes, previousSessions, nextSessions) {
  const nextSeconds = sessionsTotalSeconds(nextSessions)
  const previousSeconds = sessionsTotalSeconds(previousSessions)
  if (previousSeconds <= 0) return secondsToMinutes(nextSeconds)
  const adjusted = minutesToSeconds(currentMinutes) + (nextSeconds - previousSeconds)
  return secondsToMinutes(adjusted > 0 ? adjusted : nextSeconds)
}

/**
 * What an entry's `minutes` becomes after an edit — the ONE rule the PATCH
 * handler, the edit form's live preview, and their tests all share.
 *
 * The billed duration and the clock-in/out spans are two different facts. The
 * spans say WHEN the work happened; `minutes` says how much of it is billed.
 * They usually agree, so an untouched duration is derived from the spans. But
 * they are allowed to disagree, and when the user TYPES a duration, that is a
 * deliberate statement about what to bill — it wins, and the sessions stay
 * verbatim as the audit trail of when the work actually happened. Without that,
 * editing a session-backed entry's time was impossible: the typed figure was
 * recomputed away from the unchanged clock, so it silently snapped back ("still
 * will not let me edit the time before I split it").
 *
 * With the duration untouched the pre-existing rules stand: a regular entry
 * derives its minutes from the new spans, and a SLICE moves by the session
 * delta so an edit can never inflate it back to the whole block.
 *
 * @param {object} options
 * @param {number|null|undefined} options.typedMinutes - what the user typed, or
 *   null/undefined when the duration field was not touched.
 * @param {number} options.sessionsMinutes - total across the NEW sessions.
 * @param {boolean} options.isSlice - is this entry part of a split group?
 * @param {number} options.currentMinutes - the entry's stored minutes today.
 * @param {Array<{startAt: string, endAt: string}>} options.previousSessions
 * @param {Array<{startAt: string, endAt: string}>} options.nextSessions
 * @returns {number} minutes, on the seconds grid.
 */
export function minutesAfterEntryEdit({
  typedMinutes,
  sessionsMinutes,
  isSlice,
  currentMinutes,
  previousSessions,
  nextSessions,
}) {
  if (typeof typedMinutes === 'number' && Number.isFinite(typedMinutes) && typedMinutes > 0) {
    return secondsToMinutes(minutesToSeconds(typedMinutes))
  }
  return isSlice
    ? sliceMinutesAfterSessionEdit(currentMinutes, previousSessions, nextSessions)
    : secondsToMinutes(minutesToSeconds(sessionsMinutes))
}

/**
 * How the split modal REOPENS an existing split: the group's current clients,
 * their exact current minutes, and the mode that produced them.
 *
 * `blockMinutes` is the duration the even / full previews divide, reconstructed
 * from the slices rather than remembered: a `full` split billed every client the
 * whole block, so the block is one slice; every other mode divided the block, so
 * the block is the sum. `totalMinutes` is what the group bills TODAY — the
 * "was" figure shown next to the new total.
 *
 * Pure so the modal and its test agree. Slices with no client are ignored, and
 * two slices on the same client fold together (nothing creates that today, but
 * the prefill must not show a client twice).
 *
 * @param {Array<{clientId?: string, minutes?: number, groupAllocation?: string}>} slices
 * @returns {{clientIds: string[], customMinutes: Record<string, string>, mode: 'even'|'full'|'custom', blockMinutes: number, totalMinutes: number}}
 */
export function splitGroupPrefill(slices) {
  const byClient = new Map()
  for (const slice of slices ?? []) {
    if (!slice || typeof slice.clientId !== 'string' || !slice.clientId) continue
    const seconds = Math.max(0, minutesToSeconds(slice.minutes))
    byClient.set(slice.clientId, (byClient.get(slice.clientId) ?? 0) + seconds)
  }
  const clientIds = [...byClient.keys()]
  const customMinutes = {}
  let totalSeconds = 0
  let largestSeconds = 0
  for (const [id, seconds] of byClient) {
    customMinutes[id] = String(secondsToMinutes(seconds))
    totalSeconds += seconds
    if (seconds > largestSeconds) largestSeconds = seconds
  }
  // No stored mode (e.g. a group logged straight from the manual form) means the
  // safest reopen is 'custom': it shows the exact amounts and recomputes nothing.
  const stored = (slices ?? []).map((slice) => normalizeMode(slice?.groupAllocation)).find(Boolean)
  const mode = stored ?? 'custom'
  return {
    clientIds,
    customMinutes,
    mode,
    blockMinutes: secondsToMinutes(mode === 'full' ? largestSeconds : totalSeconds),
    totalMinutes: secondsToMinutes(totalSeconds),
  }
}

/** The three split modes, or null for anything else. */
function normalizeMode(value) {
  return value === 'even' || value === 'full' || value === 'custom' ? value : null
}
