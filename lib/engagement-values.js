/**
 * The values an ENGAGEMENT letter's `{{placeholders}}` are filled with
 * (docs/plans/engagements-2026-10.md, stage 2A).
 *
 * An engagement letter goes to a party that is often not a client yet (a Won
 * prospect), and its figures come from the proposal's priced snapshot (kept on the
 * engagement as `figures`), not from a client record. So this builds the Letters
 * values (lib/letter-template.js `letterValues`) and then overrides them: the name,
 * contact and address from the party, the fees from the snapshot, plus the
 * engagement-only keys (ENGAGEMENT_PLACEHOLDERS).
 *
 * Pure and browser-safe like letter-template.js: no store, no env, no node built-ins,
 * no clock (`now` is passed in). Every value is a string; blank means "no value", and
 * `fillTemplate(text, values, placeholdersFor('engagement'))` reports a blank required
 * one as missing, exactly as Letters does.
 */

import { firmToday } from './firm-time.js'
import { paymentTermsLabel } from './invoice-draft.js'
import { engagementPlaceholders, letterMoney, letterTemplateHash, letterValues } from './letter-template.js'
import { mailingAddressLines } from './mailing-address.js'
import {
  ANNUAL_GROUP,
  CLEANUP_GROUP,
  isNoChargeLine,
  MONTHLY_GROUPS,
  snapshotHoursByRole,
} from './proposal-pricing.js'

/** The engagement-only placeholders, each `{key, label, description, required, scope: 'engagement'}`. */
export const ENGAGEMENT_PLACEHOLDERS = engagementPlaceholders

const SALES_TAX_GROUP = 'Sales tax'

const clean = (value) => String(value ?? '').trim()

/** "1 month" / "6 months"; '' for nothing. */
function counted(n, singular, plural) {
  if (!(Number.isFinite(n) && n > 0)) return ''
  const shown = Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100)
  return `${shown} ${n === 1 ? singular : plural}`
}

/**
 * The largest `count` the lines were priced per (lib/proposal-pricing.js: clean-up
 * months on a per-clean-up-month line, states on a sales-tax line). 0 when no line
 * carries one (a chart-of-accounts-only clean-up, a snapshot priced before 2026-10).
 */
function largestCount(lines) {
  let best = 0
  for (const line of lines) {
    const n = typeof line?.count === 'number' ? line.count : 0
    if (Number.isFinite(n) && n > best) best = n
  }
  return best
}

const inputCount = (inputs, key) => {
  const n = Number(inputs?.[key])
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** The groups whose lines the letter lists one by one ({{services_monthly}}, {{services_annual}}). */
const LISTED_GROUPS = Object.freeze([...MONTHLY_GROUPS, ANNUAL_GROUP])

const SKIP_REASONS = Object.freeze({
  retired: 'retired from the catalog',
  'needs-count': 'no count typed',
  'no-rate': 'not yet priced',
  'unknown-input': 'its count is missing from the catalog',
  'invalid-input': 'a figure on it is not a number',
})

/**
 * Why a proposal line is NOT listed in the letter, or null when it is. A signed
 * letter must not promise work nobody priced:
 *  - a retired line never is;
 *  - a line at $0 is not - unless it is a software plan that really costs nothing
 *    (`isNoChargeLine`, Bill Pay Basic);
 *  - a flagged line (no count typed, no rate, a missing input) is not - unless it
 *    carries a price she set by hand (an override), which the fee already includes.
 */
function skipReason(line) {
  if (line.flag === 'retired') return SKIP_REASONS.retired
  if (isNoChargeLine(line)) return null
  if (Number(line.amount) > 0) return null
  return SKIP_REASONS[line.flag] ?? 'priced at $0.00'
}

/** The lines a letter lists from one set of groups. */
const listedLines = (lines, groups) => lines.filter((line) => groups.includes(line.group) && !skipReason(line))

/** "- Name" per line, each name once, in snapshot order. */
function nameList(lines) {
  const names = []
  for (const line of lines) {
    const name = clean(line?.name)
    if (name && !names.includes(name)) names.push(name)
  }
  return names.map((name) => `- ${name}`).join('\n')
}

/** "- Business return: $1,200.00 per year" / "- Payroll setup: $400.00, one time". */
function annualList(lines) {
  const rows = []
  for (const line of lines) {
    const name = clean(line?.name)
    if (!name) continue
    const amount = letterMoney(line?.amount)
    const row = !amount
      ? `- ${name}`
      : line?.cadence === 'one-time'
        ? `- ${name}: ${amount}, one time`
        : `- ${name}: ${amount} per year`
    if (!rows.includes(row)) rows.push(row)
  }
  return rows.join('\n')
}

const snapshotLines = (figures) =>
  (Array.isArray(figures?.lines) ? figures.lines : []).filter((line) => line && typeof line === 'object')

/**
 * The proposal lines the letter's service lists leave out, and why - for the editor
 * to say "Not in the letter: Budget (no count typed)". The listed groups only (the
 * monthly ones and Annual and one-time - clean-up and software lines are never listed
 * one by one), plus a selection the catalog no longer names at all (no group); in
 * snapshot order.
 *
 * @param {{lines?: ReadonlyArray<object>}|null|undefined} snapshot  the engagement's figures
 * @returns {Array<{name: string, group: string|null, serviceId: string|null, reason: string}>}
 */
export function skippedEngagementLines(snapshot) {
  const skipped = []
  for (const line of snapshotLines(snapshot)) {
    const groupless = line.flag === 'retired' && !line.group
    if (!LISTED_GROUPS.includes(line.group) && !groupless) continue
    const reason = skipReason(line)
    if (!reason) continue
    skipped.push({
      name: clean(line.name) || clean(line.serviceId) || 'Unnamed service',
      group: typeof line.group === 'string' ? line.group : null,
      serviceId: typeof line.serviceId === 'string' ? line.serviceId : null,
      reason,
    })
  }
  return skipped
}

const MONTH_SHAPE = /^(\d{4})-(\d{2})(?:-\d{2})?$/

/** "2026-11" -> "November 2026"; '' for anything else. */
function monthLabel(value) {
  const match = MONTH_SHAPE.exec(clean(value))
  if (!match) return ''
  const year = Number(match[1])
  const month = Number(match[2])
  if (month < 1 || month > 12) return ''
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year, month - 1, 15)),
  )
}

/** The month after the firm's today, as "YYYY-MM". */
function nextMonthOf(now) {
  const day = firmToday(now)
  const year = Number(day.slice(0, 4))
  const month = Number(day.slice(5, 7))
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`
}

/** Hours to one decimal ("12.5"), '' when none. */
function hoursLabel(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? (Math.round(n * 10) / 10).toFixed(1) : ''
}

const firstText = (...values) => values.find((value) => typeof value === 'string' && value.trim()) ?? ''

/** Whether the proposal has annual, one-time or clean-up work (its lines, else its totals). */
function hasOtherFees(lines, totals) {
  if (lines.some((line) => line.group === ANNUAL_GROUP || line.group === CLEANUP_GROUP)) return true
  return [totals?.annual, totals?.oneTime, totals?.cleanup].some((amount) => Number(amount) > 0)
}

/**
 * Every placeholder's value for one engagement letter.
 *
 * @param {object} args
 * @param {object} [args.engagement]    the engagement row: `party`, `figures`, `retainerAmount`, `startMonth?`
 * @param {object|null} [args.snapshot] the priced figures; default `engagement.figures`
 *   (`{totals, lines, hoursByRole?, paymentTerms?, inputs?}` or a proposal's pricingSnapshot)
 * @param {object} [args.party]         default `engagement.party`: {company, contactName, email, addressLine1, addressLine2, city, state, postalCode}
 * @param {object|null} [args.client]   the linked client, when there is one (an upsell, an amendment)
 * @param {object[]} [args.contacts]    every contact (the client's are found by `contactIds`)
 * @param {object|null} [args.firmSettings]
 * @param {Date} [args.now]             injectable for tests
 * @param {string} [args.senderName]
 * @param {string} [args.paymentTerms]  default: the figures' terms, the client's, then the firm default
 * @param {Record<string, number>} [args.inputs]  the proposal's counts, a fallback for clean-up months / states
 * @returns {Record<string, string>}
 */
export function engagementValues({
  engagement = null,
  snapshot = undefined,
  party = undefined,
  client = null,
  contacts = [],
  firmSettings = null,
  now = new Date(),
  senderName = '',
  paymentTerms = undefined,
  inputs = undefined,
} = {}) {
  const figures = snapshot === undefined ? (engagement?.figures ?? null) : snapshot
  const who = party ?? engagement?.party ?? {}
  const counts = inputs ?? figures?.inputs ?? null
  const base = letterValues({ client: client ?? {}, contacts, firmSettings, now, senderName })

  const contactName = clean(who?.contactName) || base.contact_name
  const partyAddress = mailingAddressLines(who)
  const values = {
    ...base,
    client_name: clean(who?.company) || clean(client?.name) || clean(who?.contactName),
    contact_first_name: contactName.split(/\s+/)[0] ?? '',
    contact_name: contactName,
    client_address: partyAddress.length ? partyAddress.join('\n') : base.client_address,
  }

  // The fee: from the snapshot's totals when there is one (a proposal's figures),
  // else what the client is billed today (an amendment with no proposal behind it).
  const totals = figures?.totals && typeof figures.totals === 'object' ? figures.totals : null
  if (totals) {
    const monthly = letterMoney(totals.monthly)
    const annual = letterMoney(totals.annual)
    values.monthly_fee = monthly
    values.annual_fee = annual
    values.fee = monthly ? `${monthly} per month` : annual ? `${annual} per year` : ''
  }

  const lines = snapshotLines(figures)
  const software = letterMoney(totals?.software)
  const retainer = letterMoney(engagement?.retainerAmount)
  // Counts from what the lines were priced per (`line.count`), else the proposal's inputs.
  const cleanupMonths =
    largestCount(lines.filter((line) => line.group === CLEANUP_GROUP)) || inputCount(counts, 'cleanupMonths')
  const states =
    largestCount(lines.filter((line) => line.group === SALES_TAX_GROUP)) || inputCount(counts, 'states')
  const hours = snapshotHoursByRole(figures)

  return {
    ...values,
    fee_sentence: values.fee ? `Our recurring fee is ${values.fee}.` : '',
    other_fees_sentence: hasOtherFees(lines, totals)
      ? 'Fees for any annual, one-time, or clean-up work are shown in the sections above.'
      : '',
    // The signature block's title line: the party's title, else a line to write on.
    contact_title: clean(who?.title) || '______________',
    services_monthly: nameList(listedLines(lines, MONTHLY_GROUPS)),
    services_annual: annualList(listedLines(lines, [ANNUAL_GROUP])),
    one_time_fee: letterMoney(totals?.oneTime),
    cleanup_fee: letterMoney(totals?.cleanup),
    cleanup_months: counted(cleanupMonths, 'month', 'months'),
    cleanup_months_phrase:
      cleanupMonths > 0 ? ` for the past ${cleanupMonths === 1 ? 'month' : counted(cleanupMonths, 'month', 'months')}` : '',
    software_fee: software,
    software_sentence: software
      ? `Software subscriptions we manage for you are billed at our cost, currently ${software} per month, in addition to the fees above.`
      : '',
    sales_tax_states: counted(states, 'state', 'states'),
    payment_terms: paymentTermsLabel(
      firstText(paymentTerms, figures?.paymentTerms, client?.paymentTerms, firmSettings?.clientDefaults?.paymentTerms),
    ),
    retainer_amount: retainer,
    retainer_sentence: retainer ? `A retainer of ${retainer} is due when you return this letter signed.` : '',
    start_month: monthLabel(engagement?.startMonth) || monthLabel(nextMonthOf(now)),
    hours_bookkeeper: hoursLabel(hours.bookkeeper),
    hours_accountant: hoursLabel(hours.accountant),
    hours_cfo: hoursLabel(hours.controller),
  }
}

/** The snapshot key of an engagement's three boxes - the very same hash Letters uses. */
export const engagementTemplateHash = letterTemplateHash
