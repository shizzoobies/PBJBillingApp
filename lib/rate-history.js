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
 * `null` means NO RATE ON FILE and keeps today's meaning: on the bill side
 * `billRateAt` decides what comes next (the person's first rate, the live
 * `billRate` only for someone with no versions, then the client's own rate);
 * on the cost side that person's time carries no labor cost (never $0.00 —
 * see `personPeriodCost`).
 */

/**
 * The row's rate as a number, or null when it is not one. `Number(null)` is 0
 * and 0 passes `Number.isFinite`, so a `rate: null` row (unreachable through
 * the endpoints — both columns are NOT NULL — but cheap to be wrong about)
 * would otherwise bill or cost an hour at $0.00 instead of reading as NO rate.
 * Both store backends hand the resolver `Number(row.rate)`, so a string here
 * is a bug upstream, not a rate.
 */
function rateOf(version) {
  const rate = version?.rate
  return typeof rate === 'number' && Number.isFinite(rate) ? rate : null
}

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
  return best ? rateOf(best) : null
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
  return best ? rateOf(best) : null
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

/** This person's EARLIEST bill-rate version (the whole row), or null. */
function earliestBillVersion(versions, employeeId) {
  if (!Array.isArray(versions)) return null
  if (typeof employeeId !== 'string' || !employeeId) return null
  let best = null
  for (const version of versions) {
    if (!version || version.userId !== employeeId) continue
    const at = version.effectivePeriod
    if (typeof at !== 'string' || !at) continue
    if (best === null || at < best.effectivePeriod) best = version
  }
  return best
}

/**
 * THE ONE BILL-RATE CHAIN. What this person's hour bills at on an invoice for
 * `billingPeriod`, for a client whose pin that month is `ratePeriod` (null for
 * an unpinned client). Every surface that prices time — the invoice lines, the
 * AI hours summary, the recap estimate, firm analytics, the Client page's
 * "Hourly rates" block, the scope re-tag — calls this, so they cannot drift.
 *
 *   1. the person's version at or before the pin (`ratePeriod ?? billingPeriod`);
 *   2. else the person's EARLIEST version, if it has started by
 *      `billingPeriod` — the rate they started at, held until the client's
 *      review moves the pin. A person whose first rate postdates the pin (a
 *      new hire, or anyone given a first rate after the cutover) bills at it,
 *      never at a later raise;
 *   3. else, ONLY when the person has no versions at all in the list, their
 *      live `billRate` — the pre-rate-history mirror, for callers that pass no
 *      versions. With versions on file the mirror is the NEWEST one, future
 *      raises included, so it is never read then;
 *   4. else null, and the caller falls back to the client's own rate.
 */
export function billRateAt(versions, employee, ratePeriod, billingPeriod) {
  const employeeId = employee?.id
  const versioned = billRateFor(versions, employeeId, ratePeriod ?? billingPeriod)
  if (versioned !== null) return versioned
  const first = earliestBillVersion(versions, employeeId)
  if (first) {
    const rate = rateOf(first)
    if (
      typeof billingPeriod === 'string' &&
      billingPeriod &&
      first.effectivePeriod <= billingPeriod &&
      rate !== null
    ) {
      return rate
    }
    return null
  }
  const live = employee?.billRate
  return typeof live === 'number' && Number.isFinite(live) ? live : null
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
 * `{ from, to, changedAt, changedBy }` and this reads it back.
 *
 * THE ORDER THE MOVES WERE MADE IN MATTERS. The ledger is replayed in written
 * order (`changedAt`, falling back to array order when any entry lacks one),
 * and each move M, against the moves still standing before it:
 *
 *   - SUPERSEDES every earlier move whose `to` is at or after M's `to` — an
 *     undo (06→10 then 10→06) or a retroactive move (06→12 in August, then
 *     12→09 in November) replaces what it overlaps;
 *   - CANCELS every earlier move whose `to` had not started when M was made
 *     (its `to` is after the month of M's `changedAt`) — a correction (06→10
 *     then, still in September, 10→11) means October never billed at October.
 *
 * The moves left standing have strictly increasing `to`s, and a month then
 * bills at:
 *
 *   1. the standing move with the greatest `to` at or before `period`;
 *   2. else the FIRST entry's `from` — where the client sat before any move
 *      (null when it was never pinned);
 *   3. else, with no history, the live `hourlyRatePeriod`.
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
    const stamped = (entry) => typeof entry.changedAt === 'string' && entry.changedAt
    // Array.prototype.sort is stable, so equal stamps keep their array order.
    const written = history.every(stamped)
      ? [...history].sort((a, b) => (a.changedAt < b.changedAt ? -1 : a.changedAt > b.changedAt ? 1 : 0))
      : history
    let standing = []
    for (const move of written) {
      const madeIn = stamped(move) ? move.changedAt.slice(0, 7) : null
      standing = standing.filter(
        (earlier) => earlier.to < move.to && (madeIn === null || earlier.to <= madeIn),
      )
      standing.push(move)
    }
    let applied = null
    for (const move of standing) if (move.to <= period) applied = move
    if (applied) return applied.to
    const first = written[0]
    return typeof first.from === 'string' && first.from ? first.from : null
  }
  const pin = client?.hourlyRatePeriod
  return typeof pin === 'string' && pin ? pin : null
}
