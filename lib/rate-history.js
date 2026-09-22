/**
 * EFFECTIVE-DATED RATES — the one answer to "what did this person's hour cost,
 * or bill for, back then".
 *
 * Pure: same inputs, same answer, no clock and no I/O, exactly like
 * `lib/invoice-lines.js` and `lib/payroll-cost.js`. Every surface that prices
 * or costs time goes through here, so a raise can never mean two different
 * things on two screens.
 *
 * COMPARISON IS LEXICOGRAPHIC, on purpose. 'YYYY-MM' and 'YYYY-MM-DD' are
 * zero-padded fixed-width strings, so string order IS chronological order —
 * the convention `lib/invoice-lines.js` already bills by
 * (`billingPeriod >= PER_EMPLOYEE_BILLING_START`). No Date is constructed
 * anywhere in this file, which is also what keeps it free of time zones.
 *
 * `null` means NO RATE ON FILE and keeps today's meaning: on the bill side the
 * caller falls back to the employee's `billRate` and then the client's own
 * rate; on the cost side that person's time carries no labor cost (never
 * $0.00 — see `personPeriodCost`).
 */

/** The greatest `key` <= `asOf` for this person, or null. */
function resolve(versions, employeeId, asOf, key) {
  if (!Array.isArray(versions)) return null
  if (typeof employeeId !== 'string' || !employeeId) return null
  if (typeof asOf !== 'string' || !asOf) return null
  let best = null
  for (const version of versions) {
    if (!version || version.userId !== employeeId) continue
    const at = version[key]
    if (typeof at !== 'string' || !at || at > asOf) continue
    if (best === null || at > best[key]) best = version
  }
  const rate = Number(best?.rate)
  return best && Number.isFinite(rate) ? rate : null
}

/** The greatest `key` for this person regardless of date, or null. */
function newest(versions, employeeId, key) {
  if (!Array.isArray(versions)) return null
  if (typeof employeeId !== 'string' || !employeeId) return null
  let best = null
  for (const version of versions) {
    if (!version || version.userId !== employeeId) continue
    const at = version[key]
    if (typeof at !== 'string' || !at) continue
    if (best === null || at > best[key]) best = version
  }
  const rate = Number(best?.rate)
  return best && Number.isFinite(rate) ? rate : null
}

/**
 * What this person's time BILLS at for a given rate period ('YYYY-MM') — the
 * row with the greatest `effectivePeriod` at or before it.
 */
export function billRateFor(versions, employeeId, ratePeriod) {
  return resolve(versions, employeeId, ratePeriod, 'effectivePeriod')
}

/**
 * What this person's time COSTS on a given day ('YYYY-MM-DD') — the row with
 * the greatest `effectiveDate` at or before it.
 *
 * Keyed by the ENTRY DATE rather than the billing period because a raise lands
 * on a payday and the payroll report's windows are date ranges. A September
 * recap therefore costs September's entries at the rate in force on each
 * entry's own day.
 */
export function costRateFor(versions, employeeId, entryDate) {
  return resolve(versions, employeeId, entryDate, 'effectiveDate')
}

/** This person's newest bill rate — what `users.bill_rate` mirrors. */
export function latestBillRate(versions, employeeId) {
  return newest(versions, employeeId, 'effectivePeriod')
}

/** This person's newest cost rate — what `users.cost_rate` mirrors. */
export function latestCostRate(versions, employeeId) {
  return newest(versions, employeeId, 'effectiveDate')
}

/**
 * THE CLIENT'S PIN AS IT STOOD IN A GIVEN BILLING MONTH.
 *
 * A client pinned to June and moved to September in August bills July at
 * June's rates and October at September's. The live `hourlyRatePeriod` alone
 * cannot say that, so the move is also written to `hourlyRateHistory` as
 * `{ from, to, changedAt, changedBy }` and this reads it back:
 *
 *   1. the latest history entry whose `to` is at or before `period` — the pin
 *      that was in force that month;
 *   2. else, if there IS history, the earliest entry's `from` — where the
 *      client sat before the first move (null when it was never pinned);
 *   3. else the live `hourlyRatePeriod`, for a client that has never moved.
 *
 * Null means "no pin", and the caller then prices at the billing period
 * itself — today's rates, which is what an unpinned client has always done.
 */
export function ratePeriodAsOf(client, period) {
  const history = Array.isArray(client?.hourlyRateHistory)
    ? client.hourlyRateHistory.filter(
        (entry) => entry && typeof entry.to === 'string' && entry.to,
      )
    : []
  if (history.length > 0 && typeof period === 'string' && period) {
    let applied = null
    for (const entry of history) {
      if (entry.to > period) continue
      if (applied === null || entry.to > applied.to) applied = entry
    }
    if (applied) return applied.to
    let earliest = history[0]
    for (const entry of history) if (entry.to < earliest.to) earliest = entry
    return typeof earliest.from === 'string' && earliest.from ? earliest.from : null
  }
  const pin = client?.hourlyRatePeriod
  return typeof pin === 'string' && pin ? pin : null
}
