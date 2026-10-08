/**
 * A payment that arrived for a different amount than the invoice total.
 *
 * `/pay/:token` mints a fresh Checkout session at the CURRENT total on every
 * open, so what Stripe collects normally equals what the invoice says. They can
 * differ when an invoice is changed after it was sent and the client pays on a
 * page opened before the change. The payment is still recorded (the money did
 * arrive); this is the rule that notices the gap, and the shared reader that
 * turns the marker the store writes into "needs a look" on the way out.
 *
 * Everything here is PURE except `flagPaymentAmountMismatch`, whose store and
 * notifier are handed in - the webhook route is not bootable under test, and
 * this is the part whose once-only behavior has to be provable.
 */

import { cardProcessingFee } from './invoice-lines.js'

/** The two `email_log` events (both tagged `kind: 'payment'`). */
export const AMOUNT_MISMATCH_EVENT = 'amount-mismatch'
export const AMOUNT_MISMATCH_HANDLED_EVENT = 'amount-mismatch-handled'
/**
 * A payment that arrived for a VOIDED invoice. Log-only: a void invoice shows no
 * flag and has no "handled" button, the owners are told once instead.
 */
export const PAYMENT_ON_VOIDED_EVENT = 'on-voided'
/**
 * The `reason` a second payment on an already-paid invoice carries. It rides the
 * amount-mismatch entry (same unhandled list, same flag, same "Mark as handled");
 * an entry with no reason is the original "different amount" kind.
 */
export const DUPLICATE_PAYMENT_REASON = 'duplicate'
/**
 * A refund or a dispute on the payment a credit on account came from. Log-only
 * (`kind: 'payment'`, on the invoice that carried that payment): it changes no
 * status and no money, and nothing derives an unhandled flag from it. The ledger
 * reads it back to say so on the credit.
 */
export const CREDIT_REVERSAL_EVENT = 'credit-reversal'
/** The two Stripe events that say money went back out of a payment we took. */
export const PAYMENT_REVERSAL_EVENT_TYPES = [
  'charge.refunded',
  'charge.dispute.created',
  'charge.dispute.closed',
]

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * The integer cents Stripe says it collected, or null when the event does not
 * say. A checkout session carries `amount_total`; a payment intent carries
 * `amount_received`, with `amount` as the fallback only when `amount_received`
 * is not a number. Any other event type has no received amount.
 */
export function receivedPaymentCents(eventType, object) {
  if (eventType === 'checkout.session.completed') {
    const total = finiteNumber(object?.amount_total)
    return total === null ? null : Math.round(total)
  }
  if (eventType === 'payment_intent.succeeded') {
    const received = finiteNumber(object?.amount_received) ?? finiteNumber(object?.amount)
    return received === null ? null : Math.round(received)
  }
  return null
}

/**
 * Did Stripe collect something other than the invoice total?
 *
 * `invoice` is the invoice AS IT STANDS after the payment was applied, so a card
 * payment's processing fee line is already on it and the total is what the card
 * session was charged. Returns `{ expectedCents, receivedCents }` when the two
 * differ, and null when they agree OR when there is nothing to compare (another
 * event type, no usable received amount, no usable total).
 */
export function paymentAmountMismatch({ eventType, object, invoice }) {
  const receivedCents = receivedPaymentCents(eventType, object)
  if (receivedCents === null) return null
  // Every invoice is in dollars. A presentment currency (Stripe Adaptive
  // Pricing) would make the cents incomparable and flag a normal payment.
  if (typeof object?.currency === 'string' && object.currency.toLowerCase() !== 'usd') {
    console.warn(
      `[stripe] ${eventType} was collected in ${object.currency}, not usd; amount not compared`,
    )
    return null
  }
  const total = Number(invoice?.total)
  if (invoice?.total === null || invoice?.total === undefined || !Number.isFinite(total)) return null
  const expectedCents = Math.round(total * 100)
  return expectedCents === receivedCents ? null : { expectedCents, receivedCents }
}

/** The Stripe PaymentIntent a payment event is about, when it names one. */
export function paymentIntentIdOf(eventType, object) {
  if (eventType === 'payment_intent.succeeded') {
    return typeof object?.id === 'string' && object.id ? object.id : null
  }
  return typeof object?.payment_intent === 'string' && object.payment_intent
    ? object.payment_intent
    : null
}

/**
 * The mismatch markers on an invoice's email log that nobody has marked handled,
 * oldest first. A marker is handled when a LATER `amount-mismatch-handled` entry
 * names the same payment (the same PaymentIntent id, or none on both), or when a
 * later `failed` entry names the same non-null PaymentIntent (the debit never
 * settled).
 */
export function unhandledAmountMismatches(emailLog) {
  const log = Array.isArray(emailLog) ? emailLog : []
  const unhandled = []
  log.forEach((entry, index) => {
    if (!entry || entry.kind !== 'payment' || entry.event !== AMOUNT_MISMATCH_EVENT) return
    const intent = entry.paymentIntentId ?? null
    const handled = log
      .slice(index + 1)
      .some(
        (later) =>
          later?.kind === 'payment' &&
          (later?.paymentIntentId ?? null) === intent &&
          // An owner said so - or the debit that mismatched LATER failed (same
          // non-null intent): no money arrived, so there is no difference to
          // bill or refund. Null intents never match each other here.
          (later?.event === AMOUNT_MISMATCH_HANDLED_EVENT ||
            (later?.event === 'failed' && intent !== null)),
      )
    if (!handled) unhandled.push(entry)
  })
  return unhandled
}

/**
 * The newest unhandled mismatch on an invoice, as `{ expectedCents,
 * receivedCents, at, paymentIntentId, reason, count }`, or null. `count` is how
 * many payments are waiting (the one described is the newest); `reason` is
 * 'duplicate' for a second payment on a paid invoice and 'amount' otherwise;
 * `receivedCents` is null when Stripe did not say what a duplicate was for;
 * `card` is true when the duplicate was paid by card (the fee came with it).
 * DERIVED from the log on every read and never stored, so it cannot go stale
 * against the log it is read from.
 */
export function unhandledAmountMismatch(invoice) {
  const unhandled = unhandledAmountMismatches(invoice?.emailLog)
  if (unhandled.length === 0) return null
  const latest = unhandled[unhandled.length - 1]
  const duplicate = latest.reason === DUPLICATE_PAYMENT_REASON
  return {
    expectedCents: Number(latest.expectedCents) || 0,
    receivedCents:
      duplicate && !Number.isFinite(latest.receivedCents) ? null : Number(latest.receivedCents) || 0,
    at: latest.at ?? null,
    paymentIntentId: latest.paymentIntentId ?? null,
    reason: duplicate ? DUPLICATE_PAYMENT_REASON : 'amount',
    // A duplicate that was only STARTED (a bank debit authorized, not settled).
    settling: duplicate && latest.settling === true,
    card: duplicate && latest.card === true,
    count: unhandled.length,
  }
}

function dollars(cents) {
  return (cents / 100).toFixed(2)
}

/**
 * Is this invoice's payment a BANK payment that has not settled yet? A bank
 * payment sits in `processing` for days (and can still fail), so nothing may say
 * the money is in. A card payment passes through `processing` for a moment
 * only, and its money IS in - it carries the card fee line - so it is not
 * "in progress".
 */
export function paymentInProgress(invoice) {
  return (
    invoice?.status === 'processing' &&
    !(Array.isArray(invoice?.lineItems) ? invoice.lineItems : []).some(
      (line) => line?.kind === 'card-fee',
    )
  )
}

/**
 * When more than one payment on an invoice is waiting for an owner, the notice
 * says how many - not just the newest one. Empty for zero or one (or unknown).
 */
export function unhandledCountSentence(count) {
  return Number.isFinite(count) && count > 1
    ? ` ${count} payments on this invoice are waiting to be marked handled (this is the newest).`
    : ''
}

/**
 * Where a payment notice sends the owner: the Invoices page opened on the
 * invoice's own MONTH (the page reads `period`). A bare `/invoices` would land on
 * the current month, which is the wrong one for last month's invoice.
 */
export function invoicePeriodLink(invoice) {
  const period = typeof invoice?.period === 'string' ? invoice.period : ''
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(period) ? `/invoices?period=${period}` : '/invoices'
}

/** What the owners are told, once per mismatch. */
export function amountMismatchOwnerMessage({
  number,
  clientName,
  expectedCents,
  receivedCents,
  inProgress = false,
  unhandledCount = 0,
}) {
  const more = unhandledCountSentence(unhandledCount)
  if (inProgress) {
    return `Invoice ${number} to ${clientName}: the client's bank payment is for $${dollars(receivedCents)} but the invoice total is $${dollars(expectedCents)}. The payment is still in progress; once it settles, bill or refund the difference.${more}`
  }
  return `Invoice ${number} to ${clientName}: the client paid $${dollars(receivedCents)} but the invoice total is $${dollars(expectedCents)}. It is recorded as paid; bill or refund the difference.${more}`
}

function paymentOf(cents) {
  return Number.isFinite(cents) ? `a payment of $${dollars(cents)}` : 'a payment'
}

/** What the owners are told, once, about a second payment on a paid invoice. */
export function duplicatePaymentOwnerMessage({
  number,
  clientName,
  receivedCents,
  unhandledCount = 0,
  settling = false,
}) {
  const more = unhandledCountSentence(unhandledCount)
  // A bank debit that has only been STARTED has not put money in, and can still
  // fail (the marker then clears by itself): do not say it arrived.
  if (settling) {
    const amount = Number.isFinite(receivedCents) ? ` of $${dollars(receivedCents)}` : ''
    return `Invoice ${number} to ${clientName} was already paid, and a second bank payment${amount} was started for it. It was NOT applied to the invoice; once it settles, refund it or apply it by hand, then mark it handled. If it fails, this clears by itself.${more}`
  }
  return `Invoice ${number} to ${clientName} was already paid, and ${paymentOf(receivedCents)} arrived for it again. It was NOT applied to the invoice; refund it or apply it by hand, then mark it handled.${more}`
}

/**
 * What the owners are told, once, when a bank payment that was STARTED for a
 * second-paid invoice then FAILED: the money never came, so there is nothing to
 * refund and the marker has cleared itself.
 */
export function duplicateFailedOwnerMessage({ number, clientName, detail }) {
  return `The second bank payment on invoice ${number} to ${clientName} failed${detail ? ` - ${detail}` : ''}. The invoice is still paid, nothing arrived, and there is nothing to refund.`
}

/** What the owners are told, once, about money that arrived for a voided invoice. */
export function paymentOnVoidedOwnerMessage({
  number,
  clientName,
  receivedCents,
  settling = false,
}) {
  if (settling) {
    const amount = Number.isFinite(receivedCents) ? ` of $${dollars(receivedCents)}` : ''
    return `Invoice ${number} to ${clientName} is voided, but a bank payment${amount} was started for it; it settles in a few days. Once it does, it needs a refund or to be re-applied by hand.`
  }
  return `Invoice ${number} to ${clientName} is voided, but ${paymentOf(receivedCents)} arrived for it. The money needs a refund or to be re-applied by hand.`
}

/**
 * Tell every owner. One failed notice never costs the others, and nothing here
 * throws: the payment is already recorded and a redelivery is answered
 * `duplicate`, so this is the one chance they get.
 */
async function notifyOwners({
  store,
  notify,
  kind,
  message,
  invoice,
  appPublicUrl,
  label,
  link = invoicePeriodLink(invoice),
  clientId = invoice?.clientId,
}) {
  const members = await store.getTeamMembers()
  for (const owner of members.filter((member) => member.role === 'owner')) {
    try {
      await notify(store, owner.id, kind, {
        message,
        link,
        clientId,
        appPublicUrl,
      })
    } catch (error) {
      console.error(`[stripe] ${label} notice to ${owner.id} failed:`, error)
    }
  }
}

/**
 * The webhook's mismatch step. Runs only AFTER a successful apply and NEVER
 * throws: the payment is already recorded, so nothing in here may turn it into a
 * 500 (a redelivery is answered `duplicate` and would never reach this again).
 *
 * Once per mismatch, not once per event: a card payment fires two events for one
 * intent, and the store answers a truthy invoice only for the call that wrote
 * the marker, so only that call notifies. A marker write that THROWS is logged
 * and the owners are told anyway - the notification is the one thing they cannot
 * get back.
 *
 * @param {object} args
 * @param {{ recordInvoiceAmountMismatch: Function, getClientNameById: Function, getTeamMembers: Function }} args.store
 * @param {Function} args.notify `notify(store, userId, kind, payload)`
 * @param {{ type: string, created?: number, data?: { object?: object } }} args.event
 * @param {{ id: string, number?: string|null, clientId: string, total: number }} args.invoice
 *   the invoice as `applyInvoicePayment` answered it
 * @param {string} [args.appPublicUrl]
 */
export async function flagPaymentAmountMismatch({ store, notify, event, invoice, appPublicUrl }) {
  try {
    if (!invoice) return
    const object = event?.data?.object ?? {}
    if (receivedPaymentCents(event?.type, object) === null) {
      console.warn(
        `[stripe] ${event?.type} for invoice ${invoice.id} carried no usable amount; not compared`,
      )
      return
    }
    const mismatch = paymentAmountMismatch({ eventType: event.type, object, invoice })
    if (!mismatch) return

    const at = new Date((event.created ?? Math.floor(Date.now() / 1000)) * 1000).toISOString()
    let written = true
    try {
      written = await store.recordInvoiceAmountMismatch(invoice.id, {
        at,
        paymentIntentId: paymentIntentIdOf(event.type, object),
        expectedCents: mismatch.expectedCents,
        receivedCents: mismatch.receivedCents,
      })
    } catch (error) {
      console.error('[stripe] amount-mismatch marker write failed:', error)
    }
    if (!written) return

    const clientName =
      (await store.getClientNameById(invoice.clientId).catch(() => '')) || 'a client'
    const message = amountMismatchOwnerMessage({
      number: invoice.number ?? invoice.id,
      clientName,
      ...mismatch,
      inProgress: paymentInProgress(invoice),
      // The invoice as the write answered it: how many are waiting NOW.
      unhandledCount: unhandledAmountMismatches(written?.emailLog).length,
    })
    await notifyOwners({
      store,
      notify,
      kind: 'invoice_amount_mismatch',
      message,
      invoice,
      appPublicUrl,
      label: 'amount-mismatch',
    })
  } catch (error) {
    console.error('[stripe] amount-mismatch check failed:', error)
  }
}

/**
 * The webhook's step for a SECOND payment on an invoice that is already paid
 * (the store answered `duplicatePayment`: it applied nothing). Recorded as an
 * unhandled payment - the amount-mismatch entry with `reason: 'duplicate'`, so
 * the same flag, the same Need a look count and the same "Mark as handled"
 * apply - and the owners are told once. Idempotent on the PaymentIntent: a card
 * payment's two events write one entry and send one notice. Never throws.
 *
 * @param {object} args  same shape as `flagPaymentAmountMismatch`; `invoice` is
 *   the invoice the store answered (unchanged)
 */
export async function flagDuplicatePayment({
  store,
  notify,
  event,
  invoice,
  isCard,
  appPublicUrl,
}) {
  try {
    if (!invoice) return
    const object = event?.data?.object ?? {}
    const receivedCents = receivedPaymentCents(event?.type, object)
    // A bank payment seen at Checkout-completed has only been AUTHORIZED: it
    // settles in days and can fail. (Card passes through completed with the money.)
    const settling = event?.type === 'checkout.session.completed' && isCard === false
    const total = Number(invoice.total)
    const at = new Date((event.created ?? Math.floor(Date.now() / 1000)) * 1000).toISOString()
    let written = true
    try {
      written = await store.recordInvoiceAmountMismatch(invoice.id, {
        at,
        paymentIntentId: paymentIntentIdOf(event.type, object),
        expectedCents: Number.isFinite(total) ? Math.round(total * 100) : 0,
        receivedCents,
        reason: DUPLICATE_PAYMENT_REASON,
        settling,
        // Only a card payment says so: the row shows its fee from this.
        ...(isCard === true ? { card: true } : {}),
      })
    } catch (error) {
      console.error('[stripe] duplicate-payment marker write failed:', error)
    }
    if (!written) {
      // The marker is already there. A bank duplicate is first written while it
      // is only STARTED (`settling`); its `payment_intent.succeeded` is the
      // store's repeat and writes nothing, so without this the row would say
      // "settling" for ever and never offer Apply as credit. The money has
      // arrived: flip the marker. Nothing else about the webhook changes.
      const intentId = paymentIntentIdOf(event?.type, object)
      if (event?.type === 'payment_intent.succeeded' && intentId) {
        try {
          await store.settleDuplicatePaymentMarker?.(invoice.id, intentId)
        } catch (error) {
          console.error('[stripe] duplicate-payment settle failed:', error)
        }
      }
      return
    }

    const clientName =
      (await store.getClientNameById(invoice.clientId).catch(() => '')) || 'a client'
    await notifyOwners({
      store,
      notify,
      kind: 'invoice_payment_duplicate',
      message: duplicatePaymentOwnerMessage({
        number: invoice.number ?? invoice.id,
        clientName,
        receivedCents,
        unhandledCount: unhandledAmountMismatches(written?.emailLog).length,
        settling,
      }),
      invoice,
      appPublicUrl,
      label: 'duplicate-payment',
    })
  } catch (error) {
    console.error('[stripe] duplicate-payment check failed:', error)
  }
}

/** Is a double payment for this PaymentIntent on the log, handled or not? */
export function duplicatePaymentLogged(emailLog, paymentIntentId) {
  if (typeof paymentIntentId !== 'string' || !paymentIntentId) return false
  return (Array.isArray(emailLog) ? emailLog : []).some(
    (entry) =>
      entry?.kind === 'payment' &&
      entry?.event === AMOUNT_MISMATCH_EVENT &&
      entry?.reason === DUPLICATE_PAYMENT_REASON &&
      entry?.paymentIntentId === paymentIntentId,
  )
}

/**
 * What the invoice was worth BEFORE any card fee line: the amount a card
 * Checkout session adds its fee to. An invoice a card already paid carries that
 * fee as a line, and a second card payment's fee is still worked from the amount
 * owed, not from the total with the first fee in it.
 */
export function owedBeforeCardFee(invoice) {
  const lines = Array.isArray(invoice?.lineItems) ? invoice.lineItems : []
  const fees = lines
    .filter((line) => line?.kind === 'card-fee')
    .reduce((sum, line) => sum + (Number(line.amount) || 0), 0)
  return Math.round(((Number(invoice?.total) || 0) - fees) * 100) / 100
}

/**
 * What of a double payment actually REACHED the firm, in cents: a card payment
 * arrives with its processing fee on top (`feeCents`), a bank payment with none.
 * `creditCents` is the amount credited by default - never below a cent.
 */
export function defaultOverpaymentCredit({ receivedCents, card, invoice }) {
  const feeCents = card ? Math.round(cardProcessingFee(owedBeforeCardFee(invoice)) * 100) : 0
  return { creditCents: Math.max(1, receivedCents - feeCents), feeCents }
}

/** The sentence for a double payment that is not (or no longer) waiting on an invoice. */
export const DUPLICATE_NOT_WAITING_MESSAGE =
  'That payment is not waiting on this invoice (it may already be handled).'

/** Is this PaymentIntent's double payment on the log AND still unhandled? */
export function duplicatePaymentWaiting(emailLog, paymentIntentId) {
  return unhandledAmountMismatches(emailLog).some(
    (entry) => entry.reason === DUPLICATE_PAYMENT_REASON && entry.paymentIntentId === paymentIntentId,
  )
}

function planRefusal(status, code, message) {
  return { ok: false, status, code, message }
}

/**
 * May this double payment become a credit on account, and for how many cents?
 * Pure: `intent` is what Stripe says about the PaymentIntent
 * (`{ status, amountReceived, currency, invoiceId }`, null when Stripe could not
 * be asked) and `requestedAmount` the optional lower amount in dollars. The
 * default is everything the client was charged (card fee included); a lower
 * figure is allowed, a higher one never.
 *
 * @returns {{ ok: true, cents: number } | { ok: false, status: number, code: string, message: string }}
 */
export function planOverpaymentCredit({ invoice, paymentIntentId, intent, requestedAmount }) {
  if (typeof paymentIntentId !== 'string' || !paymentIntentId.trim()) {
    return planRefusal(400, 'invalid_payment_intent', 'Say which payment to apply as credit.')
  }
  if (!duplicatePaymentWaiting(invoice?.emailLog, paymentIntentId)) {
    return planRefusal(409, 'not_waiting', DUPLICATE_NOT_WAITING_MESSAGE)
  }
  if (!intent) {
    return planRefusal(502, 'stripe_unreachable', 'Could not reach Stripe to check that payment - try again in a moment.')
  }
  if (intent.status === 'processing') {
    return planRefusal(409, 'still_settling', 'That payment is still settling - try once it clears.')
  }
  if (intent.status !== 'succeeded') {
    return planRefusal(
      409,
      'not_succeeded',
      `Stripe shows that payment as "${intent.status}", so there is nothing to apply.`,
    )
  }
  if (intent.invoiceId !== invoice?.id) {
    return planRefusal(409, 'wrong_invoice', 'Stripe says that payment was made for a different invoice.')
  }
  if (typeof intent.currency === 'string' && intent.currency.toLowerCase() !== 'usd') {
    return planRefusal(409, 'not_usd', 'That payment was not collected in US dollars, so it cannot be applied here.')
  }
  const received = finiteNumber(intent.amountReceived)
  if (received === null || received < 1) {
    return planRefusal(409, 'no_amount', 'Stripe reports no money received on that payment.')
  }
  // Refunds and disputes live on the CHARGE; the intent keeps its amount_received.
  if (intent.disputed === true) {
    return planRefusal(409, 'disputed', 'That payment is disputed, so it cannot be applied as credit.')
  }
  const refunded = finiteNumber(intent.amountRefunded)
  if (refunded === null || typeof intent.disputed !== 'boolean') {
    return planRefusal(
      502,
      'charge_unknown',
      'Stripe did not say whether that payment was refunded or disputed - try again in a moment.',
    )
  }
  // The most she may credit: what was charged and has not gone back out.
  const receivedCents = Math.round(received) - Math.round(refunded)
  if (receivedCents < 1) {
    return planRefusal(409, 'refunded', 'That payment was refunded, so there is nothing to apply.')
  }
  if (requestedAmount === undefined || requestedAmount === null || requestedAmount === '') {
    const fallback = defaultOverpaymentCredit({
      receivedCents: Math.round(received),
      card: intent.channel === 'card',
      invoice,
    })
    return { ok: true, cents: Math.min(receivedCents, fallback.creditCents) }
  }
  const dollarsAsked =
    typeof requestedAmount === 'string' ? Number(requestedAmount.trim()) : requestedAmount
  const cents = typeof dollarsAsked === 'number' ? Math.round(dollarsAsked * 100) : Number.NaN
  if (!Number.isFinite(cents) || cents < 1) {
    return planRefusal(400, 'invalid_amount', 'Enter an amount above $0.00.')
  }
  if (cents > receivedCents) {
    return planRefusal(
      400,
      'amount_too_high',
      refunded > 0
        ? `The credit cannot be more than the $${dollars(receivedCents)} left of what the client was charged after the refund.`
        : `The credit cannot be more than the $${dollars(receivedCents)} the client was charged.`,
    )
  }
  return { ok: true, cents }
}

/**
 * The webhook's step for a payment event whose invoice was VOIDED (the apply
 * answered null: gone or void). `getInvoice` re-reads the invoice - a row that
 * is no longer there has nothing to log on and only gets a log line. The money
 * arrived, so it is written on the invoice's append-only log
 * (`on-voided`; never a status write) and every owner is told once, idempotent
 * on the PaymentIntent. Never throws.
 *
 * @param {object} args
 * @param {(id: string) => Promise<object|null|undefined>} args.getInvoice
 * @param {{ id: string }} args.invoice the invoice as the webhook first found it
 */
export async function flagPaymentOnVoidedInvoice({
  store,
  notify,
  event,
  invoice,
  getInvoice,
  isCard,
  appPublicUrl,
}) {
  try {
    if (!invoice) return
    const current = await getInvoice(invoice.id)
    if (!current || current.status !== 'void') {
      console.warn(
        `[stripe] ${event?.type} for invoice ${invoice.id}: not applied, and it is not a voided invoice that could be logged on`,
      )
      return
    }
    const object = event?.data?.object ?? {}
    const receivedCents = receivedPaymentCents(event?.type, object)
    const at = new Date((event.created ?? Math.floor(Date.now() / 1000)) * 1000).toISOString()
    let written = true
    try {
      written = await store.recordInvoicePaymentOnVoided(current.id, {
        at,
        paymentIntentId: paymentIntentIdOf(event.type, object),
        amount: receivedCents === null ? null : receivedCents / 100,
        detail: `${event.type} arrived after the invoice was voided`,
      })
    } catch (error) {
      console.error('[stripe] on-voided marker write failed:', error)
    }
    if (!written) return

    const clientName =
      (await store.getClientNameById(current.clientId).catch(() => '')) || 'a client'
    await notifyOwners({
      store,
      notify,
      kind: 'invoice_payment_on_voided',
      message: paymentOnVoidedOwnerMessage({
        number: current.number ?? current.id,
        clientName,
        receivedCents,
        settling: event?.type === 'checkout.session.completed' && isCard === false,
      }),
      invoice: current,
      appPublicUrl,
      label: 'on-voided',
    })
  } catch (error) {
    console.error('[stripe] on-voided check failed:', error)
  }
}
/**
 * A `payment_failed` event that reaches an already PAID invoice normally changes
 * nothing. When it is for the intent of a duplicate payment we recorded (a second
 * BANK debit that was only started), nobody has anything to refund: a status-free
 * `failed` entry for that intent is appended - the same mechanism that clears an
 * amount-mismatch marker - so the unhandled flag goes by itself, and the owners
 * are told it failed and that nothing needs refunding. Does nothing without such a
 * marker. Idempotent (the store skips a second `failed` entry for one intent) and
 * never throws.
 *
 * @param {object} args
 * @param {{ id: string, status?: string, emailLog?: unknown[] }} args.invoice
 *   the PAID invoice as read (its log shows whether a duplicate marker exists)
 */
export async function clearDuplicatePaymentOnFailure({
  store,
  notify,
  event,
  invoice,
  appPublicUrl,
}) {
  try {
    if (!invoice || invoice.status !== 'paid') return
    const object = event?.data?.object ?? {}
    const intent = typeof object.id === 'string' && object.id ? object.id : null
    if (!intent) return
    const marker = unhandledAmountMismatches(invoice.emailLog).find(
      (entry) => entry.reason === DUPLICATE_PAYMENT_REASON && entry.paymentIntentId === intent,
    )
    if (!marker) return

    const detail = object.last_payment_error?.message ?? 'the payment was declined'
    const at = new Date((event.created ?? Math.floor(Date.now() / 1000)) * 1000).toISOString()
    await store.recordInvoicePaymentFailure(invoice.id, {
      at,
      paymentIntentId: intent,
      detail,
    })
    const clientName =
      (await store.getClientNameById(invoice.clientId).catch(() => '')) || 'a client'
    await notifyOwners({
      store,
      notify,
      kind: 'invoice_payment_failed',
      message: duplicateFailedOwnerMessage({
        number: invoice.number ?? invoice.id,
        clientName,
        detail,
      }),
      invoice,
      appPublicUrl,
      label: 'duplicate-failed',
    })
  } catch (error) {
    console.error('[stripe] duplicate-payment failure handling failed:', error)
  }
}

/** Is this a Stripe event that says a payment we took was refunded or disputed? */
export function isPaymentReversalEvent(event) {
  return PAYMENT_REVERSAL_EVENT_TYPES.includes(event?.type)
}

/**
 * What a `charge.refunded` (a Charge), `charge.dispute.created` or
 * `charge.dispute.closed` (a Dispute) event says: which payment, how much, why.
 * `cents` is null when Stripe did not say. A refund is `partial` when less than the
 * charge (`chargeCents`) went back; a closed dispute carries Stripe's `status`
 * (won, lost, ...).
 */
export function paymentReversalOf(event) {
  const object = event?.data?.object ?? {}
  const closed = event?.type === 'charge.dispute.closed'
  const dispute = closed || event?.type === 'charge.dispute.created'
  const intent = typeof object.payment_intent === 'string' ? object.payment_intent : object.payment_intent?.id
  const cents = finiteNumber(dispute ? object.amount : object.amount_refunded)
  const chargeCents = dispute ? null : finiteNumber(object.amount)
  const reason = dispute ? object.reason : object.refunds?.data?.[0]?.reason
  return {
    kind: closed ? 'dispute-closed' : dispute ? 'dispute' : 'refund',
    paymentIntentId: typeof intent === 'string' && intent ? intent : null,
    cents: cents === null ? null : Math.round(cents),
    chargeCents: chargeCents === null ? null : Math.round(chargeCents),
    reason: typeof reason === 'string' ? reason : '',
    status: closed && typeof object.status === 'string' ? object.status : '',
    partial:
      !dispute &&
      (cents !== null && chargeCents !== null ? cents < chargeCents : object.refunded === false),
    at: new Date((event?.created ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
  }
}

function reversalWords({ kind, cents, reason, partial, chargeCents }) {
  const amount = Number.isFinite(cents) ? `$${dollars(cents)}` : ''
  const why = String(reason ?? '').replace(/_/g, ' ')
  if (kind === 'dispute') {
    return `disputed (${amount || 'amount not given'}${why ? `, reason ${why}` : ''})`
  }
  const of = partial && amount && Number.isFinite(chargeCents) ? ` of $${dollars(chargeCents)}` : ''
  return `${partial ? 'partly refunded' : 'refunded'}${amount ? ` ${amount}` : ''}${of}${why ? ` (${why})` : ''}`
}

/**
 * A dispute outcome that leaves the firm's money where it was: won, or an inquiry
 * (`warning_closed`) that closed without a chargeback.
 */
export function disputeReleased(status) {
  return status === 'won' || status === 'warning_closed'
}

/**
 * Does a payment's refund / dispute history keep its credit on account HELD (not
 * drawn automatically)? `entries` are the `credit-reversal` log entries for ONE
 * PaymentIntent (other entries are ignored). The rule: any refund note holds it
 * for good, whatever a later dispute says (the money went back to the client);
 * otherwise a dispute holds it unless the LATEST dispute-family note is a close that
 * released it (won, or `warning_closed`). Pure.
 *
 * @returns {{ refunded: boolean, holds: boolean }}
 */
export function creditReversalHolds(entries) {
  let refunded = false
  let latestDispute = null
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.kind !== 'payment' || entry?.event !== CREDIT_REVERSAL_EVENT) continue
    if (entry.noticeKind === 'refund') refunded = true
    else if (entry.noticeKind === 'dispute' || entry.noticeKind === 'dispute-closed') {
      if (!latestDispute || String(entry.at ?? '') >= String(latestDispute.at ?? '')) latestDispute = entry
    }
  }
  const disputeHolds =
    latestDispute !== null &&
    !(latestDispute.noticeKind === 'dispute-closed' && disputeReleased(latestDispute.status))
  return { refunded, holds: refunded || disputeHolds }
}

/** Stripe's result for a closed dispute in words: "won", "lost", "warning closed". */
function closedResult(status) {
  return String(status ?? '').replace(/_/g, ' ') || 'no result given'
}

/**
 * What the owners are told when the payment a credit on account came from was
 * refunded or disputed. `credit` is the ledger's view of it (`amount`, `draws`,
 * `voidedAt`). It never says the credit was voided: that is the owner's click.
 */
export function creditReversalOwnerMessage({ clientName, credit, reversal, refunded = false }) {
  const amountCents = Math.round(Number(credit?.amount ?? 0) * 100)
  const usedCents = (Array.isArray(credit?.draws) ? credit.draws : []).reduce(
    (sum, draw) => sum + Math.round(Number(draw?.amount ?? 0) * 100),
    0,
  )
  let state
  if (credit?.voidedAt) state = 'already void'
  // A part-refund is not a reason to void the whole credit: what to keep is hers to say.
  else if (usedCents <= 0) {
    // A closed dispute on a payment that was ALSO refunded: how much came back is hers to say.
    const byHand = reversal?.partial || (refunded && reversal?.kind === 'dispute-closed')
    state = byHand ? 'unspent - sort it out by hand' : "unspent - void it from the client's page"
  } else if (usedCents >= amountCents) state = `fully used ($${dollars(amountCents)}) - sort it out by hand`
  else state = `partly used ($${dollars(usedCents)} of $${dollars(amountCents)}) - sort it out by hand`
  const subject = `the second payment that was turned into credit on account ($${dollars(amountCents)})`
  if (reversal?.kind === 'dispute-closed') {
    const released = disputeReleased(reversal.status)
    const tail = credit?.voidedAt
      ? 'The credit is already void.'
      : released && !refunded
        ? 'The credit is back to normal.'
        : released
          ? `Its payment was also refunded, so the credit stays held: ${state}.`
          : `The credit is ${state}.`
    return `${clientName}: the dispute on ${subject} was closed: ${closedResult(reversal.status)}. ${tail}`
  }
  return `${clientName}: ${subject} was ${reversalWords(reversal)} in Stripe. The credit is ${state}.`
}

/** What the owners are told when an ordinary payment on a paid invoice was refunded or disputed. */
export function invoiceReversalOwnerMessage({ clientName, number, reversal }) {
  if (reversal?.kind === 'dispute-closed') {
    return `${clientName}: the dispute on the payment for invoice ${number} was closed: ${closedResult(reversal.status)}; the invoice still reads Paid.${disputeReleased(reversal.status) ? '' : ' Sort it out by hand.'}`
  }
  return `${clientName}: the payment for invoice ${number} was ${reversalWords(reversal)} in Stripe; the invoice still reads Paid. Sort it out by hand.`
}

/**
 * The webhook's step for `charge.refunded` and `charge.dispute.created`. Notices
 * only: it NEVER voids a credit and never touches an invoice's status or money.
 *
 *  - the payment became a credit on account: the notice is written on the invoice
 *    that carried the payment (so the ledger can say so) and the owners are told;
 *  - it is the payment of a PAID invoice: the owners are told, nothing is written;
 *  - it matches nothing, or names no payment: nothing happens.
 *
 * The route has already ledgered the event id, so a genuine redelivery never gets
 * here. The notice write is idempotent on the event id too, and a write that
 * answers `duplicate` therefore means an EARLIER attempt at this same event wrote
 * the note and then failed before it could notify (a throw after the write sends
 * the event back through the route's catch, which forgets it for Stripe's retry):
 * the owners are told anyway, because that attempt never told them. The store
 * reads and the notice write may throw; the owners' notification never throws.
 *
 * @returns {Promise<{ matched: boolean, notified: boolean }>}
 */
export async function flagPaymentReversal({ store, notify, event, appPublicUrl }) {
  const reversal = paymentReversalOf(event)
  if (!reversal.paymentIntentId) {
    console.warn(`[stripe] ${event?.type} named no payment intent; nothing to match`)
    return { matched: false, notified: false }
  }
  const tell = async (args) => {
    try {
      await notifyOwners({ store, notify, kind: 'invoice_credit_refunded', appPublicUrl, ...args })
    } catch (error) {
      console.error('[stripe] payment-reversal notice failed:', error)
    }
  }

  const found = await store.findOverpaymentCredit(reversal.paymentIntentId)
  if (found) {
    const ledger = await store.listAccountCredits(found.clientId)
    const credit = ledger.find((entry) => entry.id === found.id) ?? found
    const written = await store.recordAccountCreditNotice(credit.id, {
      kind: reversal.kind,
      at: reversal.at,
      cents: reversal.cents,
      reason: reversal.reason,
      eventId: event.id ?? null,
      partial: reversal.partial,
      chargeCents: reversal.chargeCents,
      status: reversal.status,
    })
    if (written?.duplicate) {
      console.warn(
        `[stripe] ${event.type} ${event.id} was already noted on credit ${credit.id}; telling the owners anyway (the earlier attempt never did)`,
      )
    }
    const clientName = (await store.getClientNameById(credit.clientId).catch(() => '')) || 'A client'
    await tell({
      message: creditReversalOwnerMessage({
        clientName,
        credit,
        reversal,
        refunded: written?.refunded === true,
      }),
      link: `/clients/${credit.clientId}`,
      clientId: credit.clientId,
      label: 'credit-reversal',
    })
    return { matched: true, notified: true }
  }

  const invoice = await store.findInvoiceByStripeRef({ paymentIntentId: reversal.paymentIntentId })
  if (!invoice || invoice.status !== 'paid') {
    console.warn(
      `[stripe] ${event.type} for ${reversal.paymentIntentId}: ${invoice ? `invoice ${invoice.id} is ${invoice.status}, not paid` : 'no credit or invoice carries it'}`,
    )
    return { matched: Boolean(invoice), notified: false }
  }
  const clientName = (await store.getClientNameById(invoice.clientId).catch(() => '')) || 'A client'
  await tell({
    message: invoiceReversalOwnerMessage({ clientName, number: invoice.number ?? invoice.id, reversal }),
    invoice,
    label: 'payment-reversal',
  })
  return { matched: true, notified: true }
}
