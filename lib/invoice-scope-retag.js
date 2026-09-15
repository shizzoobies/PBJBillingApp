/**
 * Re-tagging a time entry's SCOPE from the invoicing side, made lines.
 *
 * Brittany's ask (featreq-8cec48db): while she is reviewing an invoice she can
 * see the hours behind it, and say per line whether that work was in scope, out
 * of scope, or ad hoc — "the final catch in the invoicing side". Her two
 * decisions shape everything here:
 *
 *   1. The tags STAGE UP and apply together when the invoice is saved. So this
 *      is a pure preview function: the editor runs it on every keystroke to
 *      show what the save WOULD store, and the save sends the answer.
 *   2. The panel shows the tag already made at time entry / time review and
 *      lets her OVERRIDE it. So the "before" side of every transition is read
 *      off the ENTRY's own flags, never off the lines.
 *
 * WHY THIS ADJUSTS LINES IN PLACE RATHER THAN REGENERATING THE INVOICE.
 * A draft she is looking at has usually been edited: hours rounded up by hand,
 * a label retyped, an ad hoc line set to courtesy, a retainer credit applied.
 * `buildInvoiceLines` would produce a correct invoice and throw every one of
 * those away — silently, on a click that said nothing about them. So this
 * touches ONLY the lines the re-tagged entry is actually part of, and every
 * other line comes out of here byte-for-byte as it went in.
 *
 * WHERE IT DOES NOTHING. The partition it edits — scoped hours on one side, a
 * per-entry ad hoc line on the other — exists only on an HOURLY invoice from
 * the June 2026 cutover on (`PER_EMPLOYEE_BILLING_START`). A subscription or
 * annual invoice has no such lines, and a pre-cutover invoice carries one
 * aggregate line whose already-sent number must never move. On those,
 * `applicable` is false and the lines are returned untouched; the panel says so
 * rather than offering a control that would quietly do nothing.
 *
 * Everything here is PURE: same inputs, same lines, no clock and no I/O.
 */

import {
  PER_EMPLOYEE_BILLING_START,
  adhocDateLabel,
  adhocLineForMode,
  currency,
  formatDecimalHours,
  normalizeAdhocMode,
} from './invoice-lines.js'
// THE hours rule, shared with payroll and the generator: a row's billed hours
// are its two-decimal hours, and money is that figure times the rate. Adding or
// removing a row from a person's line has to use the same arithmetic the line
// was built with, or the invoice stops multiplying out (commit 876f2ab).
import { displayHours, roundToCent } from './payroll-cost.js'
// The same four tiers the generator stamps, so a line this creates prints under
// the heading a generated one would have.
import { recapStaffTier } from './staff-tiers.js'

/**
 * The three things one piece of time can be, as the panel words them.
 *
 * They are a VIEW of the two booleans already on the entry, not a new field:
 * in scope = billable and not ad hoc, out of scope = not billable, ad hoc =
 * billable and ad hoc. No schema change, and the Time page's flags and this
 * panel are two windows onto one fact.
 */
export const SCOPE_TAGS = Object.freeze(['in-scope', 'out-of-scope', 'adhoc'])

/** What this entry is tagged as right now. */
export function scopeTagOfEntry(entry) {
  if (!entry?.billable) return 'out-of-scope'
  return entry.isAdhoc ? 'adhoc' : 'in-scope'
}

/**
 * The entry flags one tag means. The ONE place the tag becomes the two
 * booleans, used by the panel's preview and by the store's write, so what she
 * saw staged and what lands in `time_entries` cannot describe different things.
 */
export function entryFlagsForScopeTag(tag) {
  if (tag === 'out-of-scope') return { billable: false, isAdhoc: false }
  if (tag === 'adhoc') return { billable: true, isAdhoc: true }
  return { billable: true, isAdhoc: false }
}

/** Is this a tag we recognize? Anything else is ignored rather than guessed at. */
export function isScopeTag(value) {
  return SCOPE_TAGS.includes(value)
}

/** Hours arithmetic in whole hundredths, so no float dust survives a subtraction. */
const hundredths = (hours) => Math.round(Number(hours) * 100)
const fromHundredths = (value) => (value === 0 ? 0 : value / 100)

/** The kinds a new line must never be pushed past — the invoice's tail. */
const TRAILING_KINDS = new Set(['reimbursement', 'recurring'])

/**
 * Where a NEW ad hoc line goes: after the last ad hoc line if there is one, so
 * the block stays a block; otherwise ahead of the reimbursements the invoice
 * ends with; otherwise last.
 *
 * Nothing is ever re-sorted. Every edit in the month-run editor addresses a line
 * by its POSITION in the saved array, so moving an existing line would retarget
 * a control she is looking at.
 */
function adhocInsertIndex(lines) {
  let last = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]?.kind === 'adhoc') last = i
  }
  if (last >= 0) return last + 1
  const trailing = lines.findIndex((line) => TRAILING_KINDS.has(line?.kind))
  return trailing >= 0 ? trailing : lines.length
}

/** Where a NEW "Billable hours — <name>" line goes: with the others. */
function hourlyInsertIndex(lines) {
  let last = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]?.kind === 'hourly') last = i
  }
  if (last >= 0) return last + 1
  const after = lines.findIndex(
    (line) =>
      line?.kind === 'adhoc' || line?.kind === 'time_detail' || TRAILING_KINDS.has(line?.kind),
  )
  return after >= 0 ? after : lines.length
}

/**
 * Can re-tagging move money on this invoice at all? The partition it edits —
 * scoped hours on one side, a per-entry ad hoc line on the other — exists only
 * on an hourly invoice from the June 2026 cutover on. The panel, this module
 * and the store's write all ask it the same way, so a control that is offered,
 * a preview that moves and a save that is accepted cannot disagree.
 */
export function scopeRetagApplies(client, period) {
  return client?.billingMode === 'hourly' && String(period) >= PER_EMPLOYEE_BILLING_START
}

/**
 * The matchers every reader of these lines needs: which line is this entry's,
 * and what a new one would be called. Built once from the invoice's people and
 * rates and shared by the staging preview, by the after-the-save check below
 * and by the panel's read of what each ad hoc line already says — so "this line
 * is that entry's" means exactly one thing in all three.
 */
function scopeLineTools({ entries = [], employees = [], client = null, defaultHourlyRate = 0 }) {
  const isMaster = client?.isBillingMaster === true
  const employeeById = new Map((Array.isArray(employees) ? employees : []).map((e) => [e.id, e]))
  const entryById = new Map((Array.isArray(entries) ? entries : []).map((e) => [e.id, e]))
  const rateFor = (employeeId) => {
    const employee = employeeById.get(employeeId)
    return employee && typeof employee.billRate === 'number' && !Number.isNaN(employee.billRate)
      ? employee.billRate
      : defaultHourlyRate
  }

  const hourlyLabel = (employee) => `Billable hours — ${employee?.name ?? 'Unknown'}`
  const hourlyDetail = (hours, rate) => `${hours.toFixed(2)}h at ${currency.format(rate)}/hr`
  const adhocLabel = (entry) =>
    `Adhoc — ${String(entry.description ?? '').trim() || 'One-off work'}`
  const adhocDetail = (entry, employee, rate) =>
    `${adhocDateLabel(entry.date)} · ${employee?.name ?? 'Unknown'} · ${formatDecimalHours(
      entry.minutes,
    )} at ${currency.format(rate)}/hr`

  /**
   * That person's scoped line on this invoice. On a BILLING MASTER the name is
   * not enough — the same bookkeeper has a line under each company — so the
   * sub's id has to match too.
   */
  const findHourly = (list, entry) => {
    const label = hourlyLabel(employeeById.get(entry.employeeId))
    return list.findIndex(
      (line) =>
        line?.kind === 'hourly' &&
        line.label === label &&
        (!isMaster || line.sourceClientId === entry.clientId),
    )
  }

  /**
   * This entry's own ad hoc line. By `entryId` first — the identity stamped on
   * every line the generator has produced since this shipped. Drafts generated
   * BEFORE it carry no id, so they fall back to an exact label+detail match:
   * both strings are built from the entry, so a match is the same piece of work
   * and a near-miss (an edited label) correctly finds nothing rather than
   * deleting a line she retyped.
   */
  const findAdhoc = (list, entry) => {
    const byId = list.findIndex((line) => line?.kind === 'adhoc' && line.entryId === entry.id)
    if (byId >= 0) return byId
    const employee = employeeById.get(entry.employeeId)
    const label = adhocLabel(entry)
    const detail = adhocDetail(entry, employee, rateFor(entry.employeeId))
    return list.findIndex(
      (line) =>
        line?.kind === 'adhoc' && !line.entryId && line.label === label && line.detail === detail,
    )
  }

  /** Is this a line whose hours this module could add to or take from? */
  const adjustable = (line) =>
    Boolean(line) && Number.isFinite(Number(line.hours)) && Number.isFinite(Number(line.rate))

  return {
    isMaster,
    employeeById,
    entryById,
    rateFor,
    hourlyLabel,
    hourlyDetail,
    adhocLabel,
    adhocDetail,
    findHourly,
    findAdhoc,
    adjustable,
  }
}

/**
 * What each entry's own ad hoc line already says, keyed by entry id.
 *
 * The panel needs this so a row already sitting at "Show detail only" does not
 * render as "Invoice it" and quietly re-bill the work on the next round trip.
 * It matches lines EXACTLY as `findAdhoc` does — by `entryId`, then by the
 * label+detail an un-stamped draft carries — because a pre-commit draft's ad
 * hoc lines have no id and are the common case on a live invoice.
 */
export function savedAdhocModesForEntries({
  lines = [],
  entries = [],
  employees = [],
  client = null,
  defaultHourlyRate = 0,
} = {}) {
  const list = Array.isArray(lines) ? lines : []
  const rows = Array.isArray(entries) ? entries : []
  const { findAdhoc } = scopeLineTools({ entries: rows, employees, client, defaultHourlyRate })
  const modes = {}
  for (const entry of rows) {
    const index = findAdhoc(list, entry)
    if (index >= 0) modes[entry.id] = normalizeAdhocMode(list[index].adhocMode)
  }
  return modes
}

/**
 * THE WARNING THAT HAS TO OUTLIVE THE SAVE.
 *
 * `applyScopeRetag` reports a `blocked` entry while the tag is still staged.
 * But a blocked tag still SAVES — it is a fact about the work — so after the
 * save the editor remounts with no staged edits and the row would go quiet
 * while the hours are still billing on a line nobody adjusted. That is the one
 * state in this feature where the invoice and the time entries disagree about
 * money, and it must keep saying so until someone fixes the line.
 *
 * So this asks the same question of the SAVED tags: does what the lines carry
 * agree with what each entry now says it is?
 *
 *   - tagged ad hoc with no ad hoc line of its own — the charge the tag
 *     promises is not on the invoice, so the work is either missing or buried
 *     inside a hand-typed aggregate;
 *   - tagged anything else while an ad hoc line for it is still there — the
 *     invoice still bills it as a one-off;
 *   - tagged out of scope on an invoice whose hourly lines were renamed by hand
 *     (no line of this person's that carries hours and a rate, and at least one
 *     hourly line that cannot be attributed to anybody) — nobody can show the
 *     hours ever left the number that was typed.
 *
 * Deliberately silent about IN-SCOPE rows: almost every real invoice carries a
 * renamed aggregate, and flagging the hours it is supposed to contain would
 * paint the whole panel red and mean nothing.
 */
export function unaccountedScopeEntries({
  lines = [],
  entries = [],
  employees = [],
  client = null,
  period = '',
  defaultHourlyRate = 0,
} = {}) {
  if (!scopeRetagApplies(client, period)) return []
  const list = Array.isArray(lines) ? lines : []
  const rows = Array.isArray(entries) ? entries : []
  const { findAdhoc, findHourly, hourlyLabel, adjustable } = scopeLineTools({
    entries: rows,
    employees,
    client,
    defaultHourlyRate,
  })

  const known = new Set(
    (Array.isArray(employees) ? employees : []).map((employee) => hourlyLabel(employee)),
  )
  const renamedHourly = list.some(
    (line) => line?.kind === 'hourly' && (!known.has(line.label) || !adjustable(line)),
  )

  const unaccounted = []
  for (const entry of rows) {
    const tag = scopeTagOfEntry(entry)
    const adhocIndex = findAdhoc(list, entry)
    if (tag === 'adhoc') {
      if (adhocIndex < 0) unaccounted.push(entry.id)
      continue
    }
    if (adhocIndex >= 0) {
      unaccounted.push(entry.id)
      continue
    }
    if (tag !== 'out-of-scope' || !renamedHourly) continue
    const hourlyIndex = findHourly(list, entry)
    if (!adjustable(hourlyIndex >= 0 ? list[hourlyIndex] : null)) unaccounted.push(entry.id)
  }
  return unaccounted
}

/**
 * Stage a set of scope re-tags onto an invoice's lines.
 *
 * @param {object} args
 * @param {Array<object>} args.lines - the invoice's stored lines.
 * @param {Array<object>} args.entries - the time entries the panel is showing.
 * @param {Record<string, {tag: string, adhocMode?: string}>} args.tagEdits
 * @param {Array<object>} args.employees - for names, bill rates and role tiers.
 * @param {object|null} args.client - the invoice's client (a master included).
 * @param {string} args.period - YYYY-MM.
 * @param {number} args.defaultHourlyRate - fallback when an employee has none.
 * @returns {{lines: Array<object>, applicable: boolean, changed: boolean}}
 */
export function applyScopeRetag({
  lines = [],
  entries = [],
  tagEdits = {},
  employees = [],
  client = null,
  period = '',
  defaultHourlyRate = 0,
} = {}) {
  const given = Array.isArray(lines) ? lines : []
  const applicable = scopeRetagApplies(client, period)
  const edits = tagEdits && typeof tagEdits === 'object' ? tagEdits : {}
  const ids = Object.keys(edits)
  if (!applicable || ids.length === 0) {
    return { lines: given, applicable, changed: false, blocked: [] }
  }

  const {
    isMaster,
    employeeById,
    entryById,
    rateFor,
    hourlyLabel,
    hourlyDetail,
    adhocLabel,
    adhocDetail,
    findHourly,
    findAdhoc,
  } = scopeLineTools({ entries, employees, client, defaultHourlyRate })

  const next = given.slice()
  let changed = false
  const blocked = []

  // Sorted, so the answer does not depend on the order she happened to click in.
  for (const entryId of ids.slice().sort()) {
    const entry = entryById.get(entryId)
    if (!entry) continue
    const edit = edits[entryId] ?? {}
    if (!isScopeTag(edit.tag)) continue
    const to = edit.tag
    const from = scopeTagOfEntry(entry)
    const mode = normalizeAdhocMode(edit.adhocMode)
    // Re-picking the tag it already has is not an edit — which is what makes
    // this idempotent across a save: once the entry's flags have moved, the
    // same staged tag is a no-op. Ad hoc is the exception, because the choice
    // of what to DO with it can still change.
    if (from === to && to !== 'adhoc') continue

    /**
     * THE DEPARTURE HAS TO SUCCEED BEFORE THE ARRIVAL IS ALLOWED, and this is
     * the guard that stops the whole feature double billing on real invoices.
     *
     * The lines this edits are the generator's: `Billable hours — <name>`
     * carrying its own hours and rate, and one ad hoc line per entry. But she
     * retypes them. Measured against production on 2026-09-14, THIRTY-EIGHT of
     * the forty hourly lines written since the June 2026 cutover had been
     * renamed by hand ("Bookkeeping Services", "CFO/Advisory Services", "For
     * services rendered for the month of") and carried no hours or rate at all.
     *
     * On a line like that the hours cannot be taken out — there is no hours
     * field to subtract from, and no way to know which of two retyped lines the
     * entry is inside. Adding an ad hoc line anyway would charge the client for
     * that work TWICE: once inside the aggregate they typed, once on the new
     * line. So when the hours cannot leave, nothing arrives either, and the
     * entry is reported in `blocked` for the panel to say so beside the row.
     *
     * The tag itself is still hers to set: it is a fact about the work and it
     * drives reports. What this refuses to do is move money it cannot account
     * for on both sides.
     */
    let departed = true
    // The rate the hours were actually billing at, when the departure found a
    // line that says. An arriving ad hoc line is priced off THIS rather than
    // off the employee's current bill rate, so a hand-typed line rate or a bill
    // rate that has moved since the invoice was generated cannot make a
    // same-hours move change the total. See the arrival below.
    let departedRate = null

    if (from === 'in-scope' && to !== 'in-scope') {
      // Out of that person's line, by the hours it contributed.
      const index = findHourly(next, entry)
      const line = index >= 0 ? next[index] : null
      const hoursNow = Number(line?.hours)
      const rate = Number(line?.rate)
      if (line && Number.isFinite(hoursNow) && Number.isFinite(rate)) {
        const hours = fromHundredths(hundredths(hoursNow) - hundredths(displayHours(entry.minutes)))
        if (hours === 0) {
          // Her last row on this invoice: the line has nothing left to say.
          next.splice(index, 1)
          departedRate = rate
          changed = true
        } else if (hours < 0) {
          // The line carries FEWER hours than this entry does — she rounded it
          // down by hand, or it aggregates other people's time. Subtracting
          // would take hours off the line that are not this entry's, and the
          // old code deleted the whole line instead, everyone's hours with it.
          // So nothing moves and the row says so, the same as a renamed line.
          departed = false
        } else {
          next[index] = {
            ...line,
            detail: hourlyDetail(hours, rate),
            hours,
            amount: roundToCent(hours * rate),
          }
          departedRate = rate
          changed = true
        }
      } else {
        departed = false
      }
    }

    if (from === 'adhoc' && to !== 'adhoc') {
      const index = findAdhoc(next, entry)
      if (index >= 0) {
        next.splice(index, 1)
        changed = true
      } else {
        departed = false
      }
    }

    if (!departed) {
      blocked.push(entryId)
      continue
    }

    if (to === 'in-scope') {
      const index = findHourly(next, entry)
      const add = displayHours(entry.minutes)
      const line = index >= 0 ? next[index] : null
      if (line) {
        const hoursNow = Number(line.hours)
        const rate = Number.isFinite(Number(line.rate)) ? Number(line.rate) : rateFor(entry.employeeId)
        // A legacy line carrying no hours is left exactly as stored — its amount
        // is a number somebody sent, not one this can re-derive.
        if (Number.isFinite(hoursNow)) {
          const hours = fromHundredths(hundredths(hoursNow) + hundredths(add))
          next[index] = {
            ...line,
            detail: hourlyDetail(hours, rate),
            hours,
            rate,
            amount: roundToCent(hours * rate),
          }
          changed = true
        }
      } else {
        const employee = employeeById.get(entry.employeeId)
        const rate = rateFor(entry.employeeId)
        next.splice(hourlyInsertIndex(next), 0, {
          kind: 'hourly',
          label: hourlyLabel(employee),
          detail: hourlyDetail(add, rate),
          hours: add,
          rate,
          amount: roundToCent(add * rate),
          // Stamped only when the employee record still exists — a MISSING
          // employee means the tier is unknown, not "Other". Same rule as the
          // generator's.
          ...(employee ? { roleTier: recapStaffTier(employee.role) } : {}),
          ...(isMaster ? { sourceClientId: entry.clientId } : {}),
        })
        changed = true
      }
    }

    if (to === 'adhoc') {
      const index = findAdhoc(next, entry)
      if (index >= 0) {
        // Already has its line: only the three-way decision can still move, and
        // it moves through THE shared money rule the server's sanitizer uses.
        // An ad hoc row that is already ad hoc NEVER gains a second line here.
        const flipped = adhocLineForMode(next[index], mode)
        if (
          flipped.adhocMode !== next[index].adhocMode ||
          flipped.amount !== next[index].amount ||
          flipped.adhocAmount !== next[index].adhocAmount
        ) {
          next[index] = flipped
          changed = true
        }
      } else if (from === 'adhoc') {
        // Ad hoc to ad hoc with no line of its own to move: the entry is
        // already billing SOMEWHERE this cannot see — an un-stamped draft whose
        // ad hoc label she retyped, which is the ordinary shape of a live
        // invoice. Pricing a fresh line would charge the work twice, once on
        // the line she renamed and once on the new one. The departure could not
        // be accounted for, so the arrival is refused exactly like every other.
        blocked.push(entryId)
        continue
      } else {
        const employee = employeeById.get(entry.employeeId)
        // The rate the hours were billing at when they left, when the departure
        // found a line that carries one — otherwise the employee's own. Without
        // this a move that changes nothing about the work moves money.
        const rate = departedRate ?? rateFor(entry.employeeId)
        // Priced off the SAME 2dp hours the detail prints, exactly as the
        // generator does — never off raw clock minutes.
        const amount = roundToCent(displayHours(entry.minutes) * rate)
        const line = {
          kind: 'adhoc',
          label: adhocLabel(entry),
          detail: adhocDetail(entry, employee, rate),
          amount,
          adhocMode: 'billed',
          adhocAmount: amount,
          // What lets a later un-tag find this line again.
          entryId: entry.id,
          ...(employee ? { roleTier: recapStaffTier(employee.role) } : {}),
          ...(isMaster ? { sourceClientId: entry.clientId } : {}),
        }
        next.splice(adhocInsertIndex(next), 0, adhocLineForMode(line, mode))
        changed = true
      }
    }
  }

  return { lines: changed ? next : given, applicable, changed, blocked }
}
