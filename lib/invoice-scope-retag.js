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
  const applicable =
    client?.billingMode === 'hourly' && String(period) >= PER_EMPLOYEE_BILLING_START
  const edits = tagEdits && typeof tagEdits === 'object' ? tagEdits : {}
  const ids = Object.keys(edits)
  if (!applicable || ids.length === 0) {
    return { lines: given, applicable, changed: false, blocked: [] }
  }

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

    if (from === 'in-scope' && to !== 'in-scope') {
      // Out of that person's line, by the hours it contributed.
      const index = findHourly(next, entry)
      const line = index >= 0 ? next[index] : null
      const hoursNow = Number(line?.hours)
      const rate = Number(line?.rate)
      if (line && Number.isFinite(hoursNow) && Number.isFinite(rate)) {
        const hours = fromHundredths(hundredths(hoursNow) - hundredths(displayHours(entry.minutes)))
        if (hours <= 0) {
          // Her last row on this invoice: the line has nothing left to say.
          next.splice(index, 1)
        } else {
          next[index] = {
            ...line,
            detail: hourlyDetail(hours, rate),
            hours,
            amount: roundToCent(hours * rate),
          }
        }
        changed = true
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
        const flipped = adhocLineForMode(next[index], mode)
        if (
          flipped.adhocMode !== next[index].adhocMode ||
          flipped.amount !== next[index].amount ||
          flipped.adhocAmount !== next[index].adhocAmount
        ) {
          next[index] = flipped
          changed = true
        }
      } else {
        const employee = employeeById.get(entry.employeeId)
        const rate = rateFor(entry.employeeId)
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
