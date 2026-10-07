/**
 * Billing period (stage 2 of docs/plans/credit-on-account-and-billing-period-2026-10.md):
 * a subscription client who pays every N months instead of every month.
 *
 * Alex's rule: everything existing stays as it is. Period = 1 (monthly) for every
 * client until Brittany sets it, and the OLD `annual` billing mode is untouched -
 * it is not a billing period and never reads one.
 *
 * How it works (Brittany, 2026-10-07): the client still gets a monthly invoice with
 * everyone else's. On the FIRST month of a period (the "anchor" month) that invoice
 * also carries one `prepayment` line per LATER month of the period, at the current
 * monthly fee as the estimate. The later months each get their own invoice, which
 * draws the prepayment back down; when it is used up the next period's anchor
 * invoice carries the next prepayment.
 *
 * Pure and deterministic, shared by the server and the client page.
 */

import { getBillingPeriodLabel } from './invoice-lines.js'

/** The longest period a client can be on, in months. */
export const BILLING_PERIOD_MAX_MONTHS = 24

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/

/** A whole number of months from 1 to 24; anything else is 1 (monthly, as today). */
export function normalizeBillingPeriodMonths(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'object') return 1
  const months = Number(value)
  return Number.isInteger(months) && months >= 1 && months <= BILLING_PERIOD_MAX_MONTHS ? months : 1
}

/** A real "YYYY-MM", or null. */
export function normalizePeriodAnchorMonth(value) {
  return typeof value === 'string' && MONTH.test(value) ? value : null
}

/**
 * The client page's check before it saves: N is a whole number 1..24, and the first
 * month of a period is required whenever N is above 1.
 *
 * @returns {{ok: true} | {ok: false, message: string}}
 */
export function validateBillingPeriod({ months, anchor }) {
  const n = Number(months)
  if (months === '' || months === null || months === undefined || !Number.isInteger(n) || n < 1 || n > BILLING_PERIOD_MAX_MONTHS) {
    return { ok: false, message: `Bill every must be a whole number of months from 1 to ${BILLING_PERIOD_MAX_MONTHS}.` }
  }
  if (n > 1 && !normalizePeriodAnchorMonth(anchor)) {
    return { ok: false, message: 'Pick the first month of a period to bill less often than monthly.' }
  }
  return { ok: true }
}

const monthIndex = (period) => {
  const match = MONTH.exec(String(period ?? ''))
  return match ? Number(match[1]) * 12 + (Number(match[2]) - 1) : null
}

const periodAt = (index) => `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`

/** True for a client whose invoices follow a billing period: a priced subscription client with N above 1 and an anchor. */
export function hasBillingPeriod(client) {
  if (!client || client.billingMode !== 'subscription') return false
  if (!(Number(client.monthlyRate) > 0)) return false
  return (
    normalizeBillingPeriodMonths(client.billingPeriodMonths) > 1 &&
    normalizePeriodAnchorMonth(client.periodAnchorMonth) !== null
  )
}

/** The first month of the period `period` falls in (anchor + k*N), or null before the anchor or without a period. */
export function periodAnchorFor(client, period) {
  if (!hasBillingPeriod(client)) return null
  const months = normalizeBillingPeriodMonths(client.billingPeriodMonths)
  const anchor = monthIndex(client.periodAnchorMonth)
  const at = monthIndex(period)
  if (anchor === null || at === null || at < anchor) return null
  return periodAt(anchor + Math.floor((at - anchor) / months) * months)
}

/** The months a prepayment on `period`'s invoice covers: months 2..N of the period, only when `period` IS an anchor month. */
export function prepaymentMonthsFor(client, period) {
  if (periodAnchorFor(client, period) !== period) return []
  const months = normalizeBillingPeriodMonths(client.billingPeriodMonths)
  const first = monthIndex(period)
  return Array.from({ length: months - 1 }, (_, step) => periodAt(first + step + 1))
}

/** "Prepayment for November 2026". */
export function prepaymentLabel(period) {
  return `Prepayment for ${getBillingPeriodLabel(period)}`
}

/**
 * The extra lines an anchor month's invoice carries after its normal ones: one per
 * later month of the period, at the client's current monthly fee. An estimate - the
 * later months' own invoices draw it and bill the real figure.
 */
export function prepaymentLines(client, period) {
  return prepaymentMonthsFor(client, period).map((month) => ({
    kind: 'prepayment',
    label: prepaymentLabel(month),
    detail: '',
    amount: Number(client.monthlyRate),
    period: month,
  }))
}

/** The first anchor month on or after `fromPeriod` (the anchor itself while it is ahead), or null without a period. */
export function nextPrepaymentMonth(client, fromPeriod) {
  if (!hasBillingPeriod(client)) return null
  const months = normalizeBillingPeriodMonths(client.billingPeriodMonths)
  const anchor = monthIndex(client.periodAnchorMonth)
  const from = monthIndex(fromPeriod)
  if (anchor === null || from === null) return null
  if (from <= anchor) return periodAt(anchor)
  return periodAt(anchor + Math.ceil((from - anchor) / months) * months)
}

/** "October through December 2026", or "December 2026 through January 2027" across a year end. */
function coverageWords(first, last) {
  const [firstYear, firstMonth] = [first.slice(0, 4), getBillingPeriodLabel(first).split(' ')[0]]
  const [lastYear, lastMonth] = [last.slice(0, 4), getBillingPeriodLabel(last).split(' ')[0]]
  return firstYear === lastYear
    ? `${firstMonth} through ${lastMonth} ${lastYear}`
    : `${firstMonth} ${firstYear} through ${lastMonth} ${lastYear}`
}

/**
 * The sentence under the client page's Billing period card: which invoice carries
 * the next prepayment and what it covers. `today` is a YYYY-MM-DD firm date.
 */
export function billingPeriodSentence({ months, anchor, today }) {
  const n = normalizeBillingPeriodMonths(months)
  if (n === 1) return 'Billed every month, as always. Nothing is prepaid.'
  const first = normalizePeriodAnchorMonth(anchor)
  if (!first) return 'Pick the first month of a period to see when the next prepayment is.'
  const next = nextPrepaymentMonth(
    { billingMode: 'subscription', monthlyRate: 1, billingPeriodMonths: n, periodAnchorMonth: first },
    String(today ?? '').slice(0, 7),
  )
  const later = Array.from({ length: n - 1 }, (_, step) => periodAt(monthIndex(next) + step + 1))
  const names = later.map((month) => getBillingPeriodLabel(month).split(' ')[0])
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `The next prepayment is on the ${getBillingPeriodLabel(next)} invoice. It covers ${coverageWords(next, later[later.length - 1])} and carries the estimated fee for ${list}.`
}
