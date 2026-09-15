/**
 * The read-time signals about an invoice that has gone out: a payment that
 * failed, and a bill that is past the firm's thirty-day line.
 *
 * NEITHER IS A STATUS. `overdue` exists in the status union and nothing has
 * ever written it — the month run folds it into Sent, the recap counts it as
 * sent, and the payment guard accepts it. Deriving "past due" at read time
 * instead keeps it that way: there is no migration, no scheduler racing the
 * status column, and an invoice that gets paid stops being past due the instant
 * its status moves, with nothing to clean up.
 *
 * Everything here is PURE. There is no clock in this file: "today" is a
 * parameter, because the two callers disagree about what day it is on purpose —
 * the SPA passes `localDateOnly()` (the browser's wall clock, so an owner
 * working at 8pm CDT does not see tomorrow's date) and the server passes
 * `todayIso()` (UTC). Putting a `new Date()` in here would silently pick one.
 *
 * `latestInvoiceSend` and `unresolvedPaymentFailure` were lifted verbatim out of
 * `src/lib/utils.ts` so the server could use the same rule the month run does;
 * `src/lib/utils.ts` re-exports them, so every existing import still works.
 */

/** The statuses that mean "this bill went out and is still owed". */
const STILL_OWED = new Set(['sent', 'overdue'])

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Whole days from one YYYY-MM-DD to another. Parsed at UTC midnight so no
 * daylight-saving hour can round a 30-day gap to 29.
 */
function wholeDaysBetween(fromDate, toDate) {
  const from = Date.parse(`${fromDate}T00:00:00Z`)
  const to = Date.parse(`${toDate}T00:00:00Z`)
  if (Number.isNaN(from) || Number.isNaN(to)) return 0
  return Math.round((to - from) / DAY_MS)
}

/**
 * The last send that actually landed with the provider — the one the
 * "Sent … to …" line is about.
 *
 * A tagged entry is skipped, and that one test covers all of them: delivery
 * events, payment failures, the payment ack and receipt, the pay-link open, and
 * the past-due notice all carry a `kind`, and none of them is the invoice going
 * out. A paid invoice whose INVOICE email bounced must keep saying so rather
 * than report the receipt's delivery instead.
 */
export function latestInvoiceSend(emailLog) {
  const entries = (emailLog ?? []).filter((entry) => entry && entry.ok && !entry.kind)
  return entries.length > 0 ? entries[entries.length - 1] : null
}

/**
 * A payment attempt that failed and that nobody has acted on yet — the reason
 * an invoice sits in the month run's "Payment failed" tab.
 *
 * Unresolved means: the invoice is still owed (`sent` or `overdue` — the
 * webhook puts a failed one back to `sent`), and the newest failure is more
 * recent than the newest invoice email. A re-send is the follow-up: it mints a
 * fresh pay link and goes to the client, so the failure is answered and the
 * invoice returns to Sent. A payment that starts another way (a new link the
 * client actually uses, a check marked paid by hand) moves the status off
 * `sent`, which resolves it too.
 *
 * Copying a fresh payment link does NOT write a send entry, so a failure stays
 * visible through that path until the client's next attempt begins. Deliberate:
 * a copied link is not yet in the client's hands as far as the log can tell.
 */
export function unresolvedPaymentFailure(invoice) {
  if (!invoice || !STILL_OWED.has(invoice.status)) return null
  let latest = null
  for (const entry of invoice.emailLog ?? []) {
    if (!entry || entry.kind !== 'payment') continue
    // `>=` so a later position wins a tie, as with delivery events.
    if (!latest || entry.at >= latest.at) latest = entry
  }
  if (!latest) return null
  const send = latestInvoiceSend(invoice.emailLog)
  if (send && send.at >= latest.at) return null
  return latest
}

/**
 * Is this invoice past the firm's own past-due line, and by how long?
 *
 * The line is `invoice.dueDate` — thirty days from the day the invoice was
 * FIRST SENT (`db/store.js` `recordInvoiceSent` re-stamps it on that first
 * send; generation writes a provisional date from the issue day). The client is
 * never shown it: their invoice says "Due on receipt". It is the day after
 * which the firm chases.
 *
 * Four rules, in the order they are cheapest to check:
 *
 *  - Still owed. A paid, void, draft or reviewed invoice is nobody's follow-up,
 *    and `processing` means a real debit is settling — chasing that client
 *    would be wrong.
 *  - It has a due date. An invoice sent before the date existed has none, and
 *    guessing one would invent a past-due bill.
 *  - STRICTLY before today, compared as YYYY-MM-DD strings (which sort
 *    correctly, and cannot pick up a time zone the way two Date objects can).
 *    Due TODAY is not past due — the client has the day.
 *  - An unresolved payment failure WINS. That tab is the more actionable of the
 *    two: the client tried, something broke, and somebody has to call them. An
 *    invoice appearing in both lists would be counted twice and chased twice.
 *
 * @returns `{ dueDate, daysPastDue }`, or null when it is not past due.
 */
export function pastDueInvoice(invoice, todayDateOnly) {
  if (!invoice || !STILL_OWED.has(invoice.status)) return null
  const dueDate = typeof invoice.dueDate === 'string' ? invoice.dueDate : ''
  const today = typeof todayDateOnly === 'string' ? todayDateOnly : ''
  if (!dueDate || !today || !(dueDate < today)) return null
  if (unresolvedPaymentFailure(invoice)) return null
  const daysPastDue = wholeDaysBetween(dueDate, today)
  if (daysPastDue <= 0) return null
  return { dueDate, daysPastDue }
}

/** "1 day" / "12 days" — so every surface says it the same way. */
export function daysPastDueLabel(days) {
  const count = Number(days) || 0
  return `${count} ${count === 1 ? 'day' : 'days'}`
}
