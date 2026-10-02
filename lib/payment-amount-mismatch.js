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

/** The two `email_log` events (both tagged `kind: 'payment'`). */
export const AMOUNT_MISMATCH_EVENT = 'amount-mismatch'
export const AMOUNT_MISMATCH_HANDLED_EVENT = 'amount-mismatch-handled'

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
 * receivedCents, at, paymentIntentId }`, or null. DERIVED from the log on every
 * read and never stored, so it cannot go stale against the log it is read from.
 */
export function unhandledAmountMismatch(invoice) {
  const unhandled = unhandledAmountMismatches(invoice?.emailLog)
  if (unhandled.length === 0) return null
  const latest = unhandled[unhandled.length - 1]
  return {
    expectedCents: Number(latest.expectedCents) || 0,
    receivedCents: Number(latest.receivedCents) || 0,
    at: latest.at ?? null,
    paymentIntentId: latest.paymentIntentId ?? null,
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

/** What the owners are told, once per mismatch. */
export function amountMismatchOwnerMessage({
  number,
  clientName,
  expectedCents,
  receivedCents,
  inProgress = false,
}) {
  if (inProgress) {
    return `Invoice ${number} to ${clientName}: the client's bank payment is for $${dollars(receivedCents)} but the invoice total is $${dollars(expectedCents)}. The payment is still in progress; once it settles, bill or refund the difference.`
  }
  return `Invoice ${number} to ${clientName}: the client paid $${dollars(receivedCents)} but the invoice total is $${dollars(expectedCents)}. It is recorded as paid; bill or refund the difference.`
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
    let isNewMarker = true
    try {
      isNewMarker = Boolean(
        await store.recordInvoiceAmountMismatch(invoice.id, {
          at,
          paymentIntentId: paymentIntentIdOf(event.type, object),
          expectedCents: mismatch.expectedCents,
          receivedCents: mismatch.receivedCents,
        }),
      )
    } catch (error) {
      console.error('[stripe] amount-mismatch marker write failed:', error)
    }
    if (!isNewMarker) return

    const clientName =
      (await store.getClientNameById(invoice.clientId).catch(() => '')) || 'a client'
    const message = amountMismatchOwnerMessage({
      number: invoice.number ?? invoice.id,
      clientName,
      ...mismatch,
      inProgress: paymentInProgress(invoice),
    })
    const members = await store.getTeamMembers()
    for (const owner of members.filter((member) => member.role === 'owner')) {
      try {
        await notify(store, owner.id, 'invoice_amount_mismatch', {
          message,
          link: '/invoices',
          clientId: invoice.clientId,
          appPublicUrl,
        })
      } catch (error) {
        console.error(`[stripe] amount-mismatch notice to ${owner.id} failed:`, error)
      }
    }
  } catch (error) {
    console.error('[stripe] amount-mismatch check failed:', error)
  }
}
