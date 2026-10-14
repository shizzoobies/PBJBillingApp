/**
 * Automatic invoice reminders (featreq-3f1d63b6, Brittany's yes of 2026-10-14):
 * on the 15th, 20th, 25th and the last day of the month, the app emails every
 * client with an unpaid invoice the same short reminder the "Send reminder"
 * button sends, until the invoice is paid.
 *
 * Two halves in this file:
 *
 *  - PURE: `isAutoReminderDay`, `firmHourOf`, `planAutoReminders` and its
 *    read-only wrapper `planAutoRemindersFor` (a dry run needs no store). No
 *    clock, no store: the firm day and the invoices are parameters, so every rule
 *    is tested by running it.
 *  - The RUNNER, `runAutoInvoiceReminders`, which server.js calls on its hourly
 *    timer. It takes the store, the mail sender and the owner notifier as
 *    parameters (server.js is not importable from a test), decides whether this
 *    tick is a reminder tick at all, plans, and sends ONE AT A TIME through the
 *    SAME `remindInvoice` the button uses: same email, same pay link, same log
 *    entry, same Payment failed clearing, same last look before the provider call.
 *
 * WHO IS NEVER REMINDED BY THE SCHEDULER (the button is unchanged): an invoice
 * the app never emailed (no real send on its log: a never-email client's "Mark
 * reviewed" stamp, or a legacy Sent row), and one whose last real send is under
 * `AUTO_REMINDER_MIN_DAYS_AFTER_SEND` firm days old (a reminder on top of a
 * fresh invoice is a nag).
 *
 * WHO A REMINDER GOES TO: the addresses the invoice was actually SENT to (its
 * last real send, minus any typed for that one send only), narrowed to those still
 * on file for the client. An address that was removed since is not emailed; none
 * left means the invoice is skipped (`recipients_changed`) for a person to remind
 * by hand. The button keeps its own rule: the owner sees and chooses the list.
 *
 * ONCE PER DAY needs no table and no marker: `reminderRefusalCode` refuses a
 * second reminder (or a send) on the same firm day, so the 10 am tick, the 11 am
 * tick and a restart at noon all find the day's work already done and send
 * nothing. A reminder that FAILED is not counted by that rule, so this module
 * keeps its own in-process, per-firm-day memory (below) for the cases where a
 * second email would be the worse outcome.
 *
 * The owners hear ONE summary per run that did something. A run with nothing to
 * send is a log line only; a run that only had skips or failures worth seeing is
 * summarized at most once per firm day.
 */

import { dateOnlyInZone, firmTimeZone } from './firm-time.js'
import { latestInvoiceSend, unresolvedPaymentFailure } from './invoice-overdue.js'
import { invoiceEmailAddressee, resolveInvoiceRecipients } from './invoice-recipients.js'
import { remindInvoice } from './invoice-reminder.js'
import { REMINDER_REFUSAL_TIPS, reminderRefusalCode } from './invoice-reminder-rule.js'
import { hasActiveAutopayAttempt } from './stripe-autopay.js'

/** The notification event the owners' summary is filed under. */
export const AUTO_REMINDER_EVENT = 'invoice_auto_reminders'

/** The days of the month (besides the last) the reminders go out on. */
const REMINDER_DAYS = new Set([15, 20, 25])

/** Reminders go out from 9:00 through 17:59 firm time, never at night. */
export const AUTO_REMINDER_FIRST_HOUR = 9
export const AUTO_REMINDER_LAST_HOUR = 17

/** The scheduler leaves an invoice alone until its last real send is this many firm days old. */
export const AUTO_REMINDER_MIN_DAYS_AFTER_SEND = 5

/** Automatic attempts per invoice per firm day (a refused send is retried by the next tick, up to this). */
export const AUTO_REMINDER_MAX_ATTEMPTS_PER_DAY = 3

/** The pause between two sends, so a long list stays under the mail provider's rate limit. */
const DEFAULT_PAUSE_MS = 600

/**
 * Provider answers that mean the key or the sending domain is wrong: every
 * further send would fail the same way. (A 422 is about ONE message - a bad
 * address, say - so it counts against that invoice only.)
 */
const HALT_STATUSES = new Set([401, 403])

/** `INVOICE_AUTO_REMINDERS` values that mean off (case-insensitive). */
const OFF_VALUES = new Set(['off', 'false', '0', 'no', 'disabled'])

/** Skip reasons the owners do not need told every reminder day: standing facts. */
const QUIET_CODES = new Set([
  'reminded_today',
  'payment_clearing',
  'nothing_owed',
  'client_opted_out',
  'client_not_emailed',
  'sent_recently',
  'handled_today',
])

/** The words for the skip codes that are this module's own (the rest are the reminder rule's). */
const OWN_REASONS = {
  invoice_no_client: 'no client on file',
  never_emailed: 'never emailed from the app',
  sent_recently: 'sent in the last few days',
  handled_today: 'already handled today',
  recipients_changed: 'the addresses on file changed since it was sent - remind it by hand',
  no_recipients: 'no one to email (see the client\'s billing settings)',
}

/** How many skipped lines one summary spells out before it says "and N more". */
const SUMMARY_LINES = 12

/**
 * `off` for INVOICE_AUTO_REMINDERS=off|false|0|no|disabled (any case), `preview`
 * to plan and tell the owners what WOULD go out without emailing anybody, `on`
 * for everything else (the default).
 */
export function autoReminderMode(env = {}) {
  const value = String(env.INVOICE_AUTO_REMINDERS ?? '').trim().toLowerCase()
  if (OFF_VALUES.has(value)) return 'off'
  if (value === 'preview') return 'preview'
  return 'on'
}

/** The minimum firm days after a real send: INVOICE_AUTO_REMINDER_MIN_DAYS, else 5. */
export function minDaysAfterSend(env = {}) {
  const raw = env.INVOICE_AUTO_REMINDER_MIN_DAYS
  if (raw === undefined || raw === null || String(raw).trim() === '') return AUTO_REMINDER_MIN_DAYS_AFTER_SEND
  const days = Number(raw)
  return Number.isInteger(days) && days >= 0 ? days : AUTO_REMINDER_MIN_DAYS_AFTER_SEND
}

/** The last day of the month of a firm day `YYYY-MM-DD`, as a number (28..31). */
function lastDayOfMonth(firmDay) {
  const [year, month] = String(firmDay).split('-').map(Number)
  // Day 0 of the NEXT month is the last day of this one; plain arithmetic on
  // the string's own year and month, so no clock or zone is involved.
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** Whole days from one firm day to another (both `YYYY-MM-DD`), by calendar arithmetic. */
function wholeFirmDays(fromDay, toDay) {
  return Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86400000)
}

/**
 * Is this firm day a reminder day: the 15th, 20th, 25th, or the month's last day?
 *
 * @param {string} firmDay `YYYY-MM-DD` (`firmToday()`)
 */
export function isAutoReminderDay(firmDay) {
  if (typeof firmDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(firmDay)) return false
  const month = Number(firmDay.slice(5, 7))
  if (month < 1 || month > 12) return false
  const day = Number(firmDay.slice(8, 10))
  return REMINDER_DAYS.has(day) || day === lastDayOfMonth(firmDay)
}

/** The firm-time hour (0-23) an instant falls in. */
export function firmHourOf(instant, timeZone = firmTimeZone()) {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) return -1
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).formatToParts(
    instant,
  )
  const hour = Number(parts.find((part) => part.type === 'hour')?.value)
  return Number.isFinite(hour) ? hour : -1
}

const STILL_UNPAID = new Set(['sent', 'overdue'])

const lower = (address) => String(address ?? '').trim().toLowerCase()

/**
 * The addresses an automatic reminder goes to: those the invoice's last real
 * send went to (minus the ones typed for that send only), still on file for the
 * client. `{ to }`, or `{ code }` when there is nobody.
 */
function autoRecipients({ client, clients, contacts, send }) {
  const addressee = invoiceEmailAddressee(client, clients)
  if (addressee.refusal) return { code: 'no_recipients', sentTo: null }
  const oneTime = new Set((send.oneTime ?? []).map(lower))
  const sentTo = new Set((send.to ?? []).map(lower).filter((address) => address && !oneTime.has(address)))
  const onFile = resolveInvoiceRecipients({ client: addressee.addressee, contacts: contacts ?? [] }).to
  const to = onFile.filter((address) => sentTo.has(lower(address)))
  return to.length > 0 ? { to } : { code: 'recipients_changed', sentTo: [...sentTo] }
}

/**
 * Who a reminder goes to today, and who is skipped and why.
 *
 * Considered: every invoice that went out and is still owed (`sent` / `overdue`,
 * which includes one sitting in Payment failed - a reminder clears that). A
 * draft, reviewed, paid, void or processing invoice is nobody's follow-up and is
 * not listed at all. Each candidate is judged by `reminderRefusalCode`, the rule
 * the button and the server's 409 use, and then by the two rules that are the
 * scheduler's own: it must have been really emailed (`never_emailed`), and not
 * within `minDaysAfterSend` firm days ago (`sent_recently`).
 *
 * @param {object} args
 * @param {object[]} args.invoices
 * @param {object[]} args.clients
 * @param {string} args.today the firm day, YYYY-MM-DD
 * @param {ReadonlySet<string>} [args.autopayInFlight] invoice ids with an attempt claimed, processing or succeeded
 * @param {ReadonlySet<string>} [args.changedSinceSent] invoice ids edited after their last send
 * @param {number} [args.minDaysAfterSend]
 * @param {object[]} [args.contacts] the contacts, to resolve who is still on file
 * @returns {{ remind: {invoice: object, client: object, to: string[]}[], skipped: {invoice: object, client: object|null, code: string, sentTo?: string[]|null}[] }}
 */
export function planAutoReminders({
  invoices,
  clients,
  contacts = [],
  today,
  autopayInFlight = new Set(),
  changedSinceSent = new Set(),
  minDaysAfterSend: minDays = AUTO_REMINDER_MIN_DAYS_AFTER_SEND,
}) {
  const clientById = new Map((clients ?? []).map((client) => [client.id, client]))
  const remind = []
  const skipped = []
  const ordered = [...(invoices ?? [])]
    .filter((invoice) => invoice && STILL_UNPAID.has(invoice.status))
    .sort((a, b) =>
      `${a.period ?? ''}${a.number ?? ''}${a.id}`.localeCompare(`${b.period ?? ''}${b.number ?? ''}${b.id}`),
    )
  for (const invoice of ordered) {
    const client = clientById.get(invoice.clientId) ?? null
    if (!client) {
      skipped.push({ invoice, client: null, code: 'invoice_no_client' })
      continue
    }
    const code = reminderRefusalCode({
      invoice,
      client,
      autopayActive: autopayInFlight.has(invoice.id),
      changedSinceSent: changedSinceSent.has(invoice.id),
      today,
    })
    if (code) {
      skipped.push({ invoice, client, code })
      continue
    }
    // The last REAL send (a reminder, a not-emailed stamp or a payment notice is
    // not one). No such send means the app never emailed this invoice, so it has
    // no business auto-chasing it.
    const send = latestInvoiceSend(invoice.emailLog)
    const sentDay = send ? dateOnlyInZone(new Date(send.at)) : null
    if (!sentDay) {
      skipped.push({ invoice, client, code: 'never_emailed' })
    } else if (wholeFirmDays(sentDay, today) < minDays) {
      skipped.push({ invoice, client, code: 'sent_recently' })
    } else {
      const recipients = autoRecipients({ client, clients, contacts, send })
      if (recipients.to) remind.push({ invoice, client, to: recipients.to })
      else skipped.push({ invoice, client, code: recipients.code, sentTo: recipients.sentTo })
    }
  }
  return { remind, skipped }
}

/** A short reason for one skipped or refused invoice, in the owners' words. */
function reasonFor(code, message) {
  if (OWN_REASONS[code]) return OWN_REASONS[code]
  if (REMINDER_REFUSAL_TIPS[code]) return REMINDER_REFUSAL_TIPS[code]
  const text = String(message ?? code ?? '').replace(/\s+/g, ' ').trim()
  return text.length > 90 ? `${text.slice(0, 89).trimEnd()}...` : text || 'not sent'
}

const dollars = (invoice) => `$${(Number(invoice.total) || 0).toFixed(2)}`

/** `Acme ($945.00) - reason`: a client's name and the amount, nothing else. */
const lineFor = ({ invoice, client, reason }) =>
  `${client?.name ?? 'Unknown client'} (${dollars(invoice)}) - ${reason}`

const asSet = (value) => (value instanceof Set ? value : new Set(value ?? []))

/**
 * A DRY RUN: the plan for a firm day, read-only and storeless, as plain data.
 * Nothing is sent, nothing is written. For a script that reads production
 * (read-only) and prints who would be reminded on a given day.
 *
 * @param {object} args
 * @param {object[]} args.invoices the invoices as the store lists them
 * @param {object[]} args.clients the clients (`store.read().clients`)
 * @param {object[]} [args.contacts] the contacts (`store.read().contacts`); without them only a client's own address is on file
 * @param {string} [args.today] the firm day `YYYY-MM-DD`; else the day of `now`
 * @param {Date} [args.now] defaults to the system clock
 * @param {Record<string, string|undefined>} [args.env] reads INVOICE_AUTO_REMINDER_MIN_DAYS
 * @param {Iterable<string>} [args.autopayInFlight] invoice ids with an attempt in flight (unknown = none)
 * @param {Iterable<string>} [args.changedSinceSent] invoice ids edited since their send (unknown = none)
 * @returns {{
 *   today: string, isReminderDay: boolean, hour: number, minDaysAfterSend: number,
 *   remind: {invoiceId: string, number: string|null, period: string|null, clientId: string, clientName: string, total: number, paymentFailed: boolean, to: string[]}[],
 *   skipped: {invoiceId: string, number: string|null, period: string|null, clientId: string, clientName: string, total: number, code: string, reason: string, quiet: boolean, sentTo: string[]|null}[]
 * }}
 */
export function planAutoRemindersFor({
  invoices,
  clients,
  contacts = [],
  today,
  now,
  env = {},
  autopayInFlight,
  changedSinceSent,
}) {
  const instant = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date()
  const day = typeof today === 'string' && today ? today : dateOnlyInZone(instant)
  const minDays = minDaysAfterSend(env)
  const plan = planAutoReminders({
    invoices,
    clients,
    contacts,
    today: day,
    autopayInFlight: asSet(autopayInFlight),
    changedSinceSent: asSet(changedSinceSent),
    minDaysAfterSend: minDays,
  })
  const brief = ({ invoice, client }) => ({
    invoiceId: invoice.id,
    number: invoice.number ?? null,
    period: invoice.period ?? null,
    clientId: invoice.clientId,
    clientName: client?.name ?? 'Unknown client',
    total: Number(invoice.total) || 0,
  })
  return {
    today: day,
    isReminderDay: isAutoReminderDay(day),
    hour: firmHourOf(instant),
    minDaysAfterSend: minDays,
    remind: plan.remind.map((entry) => ({
      ...brief(entry),
      paymentFailed: Boolean(unresolvedPaymentFailure(entry.invoice)),
      to: entry.to,
    })),
    skipped: plan.skipped.map((entry) => ({
      ...brief(entry),
      code: entry.code,
      reason: reasonFor(entry.code),
      quiet: QUIET_CODES.has(entry.code),
      sentTo: entry.sentTo ?? null,
    })),
  }
}

/* -------------------------------------------------------------------------- */
/* The runner                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What this process remembers about TODAY'S sends, so a second email is never
 * the price of a retry. Keyed by firm day; any other day's entry is dropped the
 * next time a day is asked for.
 *
 *  - `blocked`: invoices that must not be tried again today - a reminder that
 *    left (even one whose log write failed, which the once-a-day rule could not
 *    see), or one whose send may have left (the provider never answered).
 *  - `attempts`: automatic attempts per invoice, capped per day.
 *  - `halted`: the provider answered 401/403 (key or domain), so the rest of
 *    the day's sends would fail the same way: nothing more is tried today. (A
 *    422 is about one message and only counts against that invoice's attempts.)
 *
 * In-process on purpose (no table, no file): a restart forgets it, and the
 * once-a-day rule and the provider's own idempotency key still hold.
 */
const dayStates = new Map()
function dayStateFor(day) {
  for (const key of [...dayStates.keys()]) if (key !== day) dayStates.delete(key)
  if (!dayStates.has(day)) dayStates.set(day, { blocked: new Set(), attempts: new Map(), halted: null })
  return dayStates.get(day)
}
/** The firm day the owners' summary was last filed on (this process). */
let lastSummaryDay = null

/** For tests: forget everything the runner remembers. */
export function resetAutoReminderState() {
  dayStates.clear()
  lastSummaryDay = null
}

/**
 * One run of the automatic reminders.
 *
 * Does nothing (and says why in `reason`) unless: the switch is not off, mail is
 * configured, the firm day is a reminder day, the firm hour is 9:00-17:59 and
 * (to send) the site's public address is known. Every send is the manual
 * button's own path; an error on one invoice is caught, logged `[auto-remind]`,
 * reported in the summary, and never stops the loop. A provider answer of 401,
 * 403 stops the run (and the rest of the day): that is configuration. A 422
 * counts against that invoice's attempts only.
 *
 * `INVOICE_AUTO_REMINDERS=preview` plans and files ONLY the owner summary
 * ("Would remind: ..."), emailing no client.
 *
 * @param {object} deps
 * @param {object} deps.store the app store (both backends)
 * @param {Function} deps.sendEmail `sendInvoiceEmail` from lib/notify.js
 * @param {(message: string) => Promise<void>} deps.notifyOwners files ONE owner notification
 * @param {(day: string) => Promise<boolean>} [deps.summaryAlreadySent] has today's summary gone out (any owner)?
 * @param {Record<string, string|undefined>} [deps.env] process.env
 * @param {() => Date} [deps.clock]
 * @param {string} [deps.appUrl] APP_PUBLIC_URL
 * @param {boolean} [deps.stripeConfigured]
 * @param {number} [deps.pauseMs] pause between two sends
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {Pick<Console, 'log' | 'error'>} [deps.log]
 */
export async function runAutoInvoiceReminders({
  store,
  sendEmail,
  notifyOwners,
  summaryAlreadySent = async () => false,
  env = {},
  clock = () => new Date(),
  appUrl = '',
  stripeConfigured = false,
  pauseMs = DEFAULT_PAUSE_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console,
}) {
  const mode = autoReminderMode(env)
  if (mode === 'off') return { ran: false, reason: 'off' }
  // The sender's own variables: INVOICE_EMAIL_FROM wins over EMAIL_FROM there.
  if (!env.RESEND_API_KEY || !(env.INVOICE_EMAIL_FROM || env.EMAIL_FROM)) {
    return { ran: false, reason: 'mail_not_configured' }
  }
  const start = clock()
  const today = dateOnlyInZone(start)
  if (!isAutoReminderDay(today)) return { ran: false, reason: 'not_a_reminder_day' }
  const hour = firmHourOf(start)
  if (hour < AUTO_REMINDER_FIRST_HOUR || hour > AUTO_REMINDER_LAST_HOUR) {
    return { ran: false, reason: 'outside_hours' }
  }
  const preview = mode === 'preview'
  // A reminder carries the pay link, and nothing here has a request to read the
  // site's address from: without APP_PUBLIC_URL the link would be a bare path.
  // Checked only on a reminder day inside the hours, so it is not an hourly
  // error line every day of the month.
  if (!preview && stripeConfigured && !appUrl) {
    log.error('[auto-remind] APP_PUBLIC_URL is not set, so a reminder could not carry its pay link; nothing sent')
    return { ran: false, reason: 'no_public_url' }
  }
  const state = dayStateFor(today)
  if (!preview && state.halted) return { ran: false, reason: 'halted' }

  const invoices = (await store.listInvoices()).filter((invoice) => STILL_UNPAID.has(invoice?.status))
  const data = await store.read()
  const clients = data?.clients ?? []
  const contacts = data?.contacts ?? []
  const changed = await store.withChangedSinceSent(invoices)
  const changedSinceSent = new Set(changed.filter((invoice) => invoice.changedSinceSent === true).map((i) => i.id))
  const inFlight = new Set()
  const attemptsByInvoice = new Map()
  for (const attempt of await store.listAutopayAttempts()) {
    const list = attemptsByInvoice.get(attempt.invoiceId) ?? []
    list.push(attempt)
    attemptsByInvoice.set(attempt.invoiceId, list)
  }
  for (const [invoiceId, attempts] of attemptsByInvoice) {
    if (hasActiveAutopayAttempt(attempts)) inFlight.add(invoiceId)
  }

  const plan = planAutoReminders({
    invoices,
    clients,
    contacts,
    today,
    autopayInFlight: inFlight,
    changedSinceSent,
    minDaysAfterSend: minDaysAfterSend(env),
  })
  const skipped = plan.skipped.map((entry) => ({ ...entry, reason: reasonFor(entry.code) }))

  // Already emailed today by this process, or tried as often as allowed: leave alone.
  let queue = plan.remind
  if (!preview) {
    queue = []
    for (const entry of plan.remind) {
      const id = entry.invoice.id
      if (state.blocked.has(id) || (state.attempts.get(id) ?? 0) >= AUTO_REMINDER_MAX_ATTEMPTS_PER_DAY) {
        skipped.push({ ...entry, code: 'handled_today', reason: reasonFor('handled_today') })
      } else {
        queue.push(entry)
      }
    }
  }

  let message = ''
  let reminded = 0
  const cleared = []
  let stopped = null

  if (preview) {
    const names = queue.map(({ invoice, client }) => `${client.name} (${dollars(invoice)})`)
    const worth = skipped.filter((entry) => !QUIET_CODES.has(entry.code))
    log.log(`[auto-remind] ${today} (preview): would remind ${queue.length}; ${skipped.length} skipped`)
    if (queue.length === 0 && worth.length === 0) return { ran: true, preview: true, today, attempted: 0, reminded: 0, skipped, notified: false }
    const shown = names.slice(0, SUMMARY_LINES)
    if (names.length > SUMMARY_LINES) shown.push(`and ${names.length - SUMMARY_LINES} more`)
    const namedSkips = worth.filter((entry) => entry.code !== 'never_emailed')
    const shownSkips = namedSkips.slice(0, SUMMARY_LINES).map(lineFor)
    if (namedSkips.length > SUMMARY_LINES) shownSkips.push(`and ${namedSkips.length - SUMMARY_LINES} more`)
    message =
      `Automatic invoice reminders - ${today}: Would remind ${queue.length} (preview, nothing was emailed)` +
      (shown.length > 0 ? `: ${shown.join('; ')}` : '') +
      (shownSkips.length > 0 ? `; skipped: ${shownSkips.join('; ')}` : '') +
      neverEmailedText(worth)
    return await fileSummary({
      message,
      once: true,
      today,
      notifyOwners,
      summaryAlreadySent,
      log,
      result: { ran: true, preview: true, today, attempted: queue.length, reminded: 0, skipped },
    })
  }

  // Only a call that REACHED the mail sender can have emailed anybody.
  const reachedSender = new Set()
  const trackedSend = async (payload) => {
    reachedSender.add(payload.invoiceId)
    return sendEmail(payload)
  }
  const failedAtById = new Map(
    queue.map(({ invoice }) => [invoice.id, unresolvedPaymentFailure(invoice)?.at ?? null]),
  )

  for (const [index, { invoice, client, to }] of queue.entries()) {
    if (state.halted) break
    if (index > 0 && pauseMs > 0) await sleep(pauseMs)
    state.attempts.set(invoice.id, (state.attempts.get(invoice.id) ?? 0) + 1)
    try {
      // `to`: the addresses the invoice was actually sent to (and that are still on file).
      const result = await remindInvoice(
        { invoiceId: invoice.id, now: clock(), appUrl, stripeConfigured, userId: null, auto: true, to },
        { store, sendEmail: trackedSend },
      )
      if (result.status === 200) {
        reminded += 1
        // It left. Even when its log entry did not land (so the once-a-day rule
        // cannot see it), it is not sent again today.
        state.blocked.add(invoice.id)
        if (result.body?.logged === false) {
          log.error(`[auto-remind] ${invoice.id} was emailed but could not be logged`)
        } else if (failedAtById.get(invoice.id) && !unresolvedPaymentFailure(result.body?.invoice)) {
          cleared.push({ invoice, client, failedAt: failedAtById.get(invoice.id) })
        }
        continue
      }
      const code = result.body?.error ?? `http_${result.status}`
      const providerStatus = result.body?.providerStatus ?? null
      skipped.push({
        invoice,
        client,
        code,
        // The provider's own name for the problem, when it gave one (422: validation_error ...).
        reason: reasonFor(
          code,
          result.body?.providerError ? `${result.body.providerError}: ${result.body.message}` : result.body?.message,
        ),
        refused: result.status === 409,
      })
      log.error(`[auto-remind] ${invoice.id} not reminded: ${code}`)
      if (code === 'reminder_send_failed') {
        if (result.body?.providerStatus === null || result.body?.providerStatus === undefined) {
          // The provider never answered (timeout, dropped connection): it MAY have sent.
          state.blocked.add(invoice.id)
        } else if (HALT_STATUSES.has(providerStatus)) {
          state.halted = providerStatus
          stopped = providerStatus
          log.error(`[auto-remind] stopped: ${providerStatus} from the email provider; nothing more is sent today`)
        }
      }
    } catch (error) {
      skipped.push({ invoice, client, code: 'error', reason: reasonFor('error', error?.message), failed: true })
      log.error(`[auto-remind] ${invoice.id} failed:`, error?.message || error)
      // A throw after the mail sender was called may have left the email out.
      if (reachedSender.has(invoice.id)) state.blocked.add(invoice.id)
    }
  }

  const worthSeeing = skipped.filter((entry) => !QUIET_CODES.has(entry.code))
  const summary = { ran: true, today, attempted: queue.length, reminded, skipped, cleared: cleared.length, stopped }
  log.log(
    `[auto-remind] ${today}: reminded ${reminded} of ${queue.length}; ${skipped.length} skipped (${worthSeeing.length} worth seeing); cleared Payment failed on ${cleared.length}`,
  )
  if (reminded === 0 && worthSeeing.length === 0 && !stopped) return { ...summary, notified: false }

  const named = worthSeeing.filter((entry) => entry.code !== 'never_emailed')
  const shown = named.slice(0, SUMMARY_LINES).map(lineFor)
  if (named.length > SUMMARY_LINES) shown.push(`and ${named.length - SUMMARY_LINES} more`)
  message =
    `Automatic invoice reminders - ${today}: reminded ${reminded} of ${queue.length}` +
    (shown.length > 0 ? `; skipped: ${shown.join('; ')}` : '') +
    neverEmailedText(worthSeeing) +
    (cleared.length > 0
      ? `; Cleared Payment failed: ${cleared
          .map(
            ({ invoice, client, failedAt }) =>
              `${client.name} (${invoice.number ?? invoice.id}, failed ${dateOnlyInZone(new Date(failedAt))})`,
          )
          .join('; ')}`
      : '') +
    (stopped ? `; stopped: ${stopped} from the email provider` : '')
  // A run that sent something (or cleared a failure) is always filed; one that
  // only has things worth seeing is filed once a day, not every hour.
  return await fileSummary({
    message,
    once: reminded === 0,
    today,
    notifyOwners,
    summaryAlreadySent,
    log,
    result: summary,
  })
}

/** The one line for every invoice the app never emailed: a count, not a name each. */
function neverEmailedText(entries) {
  const count = entries.filter((entry) => entry.code === 'never_emailed').length
  if (count === 0) return ''
  return count === 1
    ? '; 1 invoice was never emailed from the app and was not reminded'
    : `; ${count} invoices were never emailed from the app and were not reminded`
}

/** File the owners' summary, once per firm day when `once` (this process AND any owner's notifications say). */
async function fileSummary({ message, once, today, notifyOwners, summaryAlreadySent, log, result }) {
  if (once) {
    if (lastSummaryDay === today) return { ...result, notified: false }
    try {
      if (await summaryAlreadySent(today)) {
        lastSummaryDay = today
        return { ...result, notified: false }
      }
    } catch (error) {
      log.error('[auto-remind] could not check for an earlier summary:', error?.message || error)
    }
  }
  try {
    await notifyOwners(message)
  } catch (error) {
    log.error('[auto-remind] the owner summary failed:', error?.message || error)
    return { ...result, notified: false }
  }
  lastSummaryDay = today
  return { ...result, notified: true, message }
}
