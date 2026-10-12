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
 * The largest count a priced line's formula text names (`... x 6 clean-up months`,
 * `$25.00 x 2 states`) - the count the line was actually priced with, a typed
 * quantity included. 0 when no line says.
 */
function countFromFormulas(lines, pattern) {
  let best = 0
  for (const line of lines) {
    const match = pattern.exec(String(line?.formula ?? ''))
    const n = match ? Number(match[1]) : 0
    if (Number.isFinite(n) && n > best) best = n
  }
  return best
}

const inputCount = (inputs, key) => {
  const n = Number(inputs?.[key])
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** "- Name" per line, each name once, in snapshot order. */
function nameList(lines) {
  const names = []
  for (const line of lines) {
    const name = clean(line?.name)
    if (name && !names.includes(name)) names.push(name)
  }
  return names.map((name) => `- ${name}`).join('\n')
}

/** "- Business return: $1,200.00 per year" / "- Payroll setup: $400.00, one time" / "- Name" (not priced). */
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

  const lines = (Array.isArray(figures?.lines) ? figures.lines : []).filter(
    (line) => line && typeof line === 'object',
  )
  const software = letterMoney(totals?.software)
  const retainer = letterMoney(engagement?.retainerAmount)
  const cleanupMonths =
    countFromFormulas(
      lines.filter((line) => line.group === CLEANUP_GROUP),
      /x (\d+(?:\.\d+)?) clean-up months?/,
    ) || inputCount(counts, 'cleanupMonths')
  const states =
    countFromFormulas(
      lines.filter((line) => line.group === SALES_TAX_GROUP),
      /x (\d+(?:\.\d+)?) states?/,
    ) || inputCount(counts, 'states')
  const hours = snapshotHoursByRole(figures)

  return {
    ...values,
    services_monthly: nameList(lines.filter((line) => MONTHLY_GROUPS.includes(line.group))),
    services_annual: annualList(lines.filter((line) => line.group === ANNUAL_GROUP)),
    one_time_fee: letterMoney(totals?.oneTime),
    cleanup_fee: letterMoney(totals?.cleanup),
    cleanup_months: counted(cleanupMonths, 'month', 'months'),
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
