/**
 * Stripe autopay (featreq-bef42b72): a client who has said "debit me" has a
 * saved payment method on file, and the invoice is charged to it the moment the
 * invoice is SENT.
 *
 * This file is the part that needs no database and no network: the vocabulary,
 * the owner-safe summary of a client's enrollment, the eligibility rule, and
 * (in the later half) the exact payloads that go to Stripe. Everything that
 * moves money is decided HERE, in small functions a test can reach, rather
 * than inside the send route where nothing can.
 *
 * Money rule of thumb for this whole feature: every gate fails CLOSED. A
 * missing value, an unknown status or an unset kill switch means "do not
 * charge".
 */

import { randomBytes } from 'node:crypto'

import { cardProcessingFee } from './invoice-lines.js'
import { ensureStripeCustomer, toStripeAmount } from './stripe-rail.js'

/** A client's enrollment, in the order it normally moves. */
export const AUTOPAY_STATUSES = Object.freeze([
  'off',
  'invited',
  'pending_verification',
  'enrolled',
  'withdrawn',
  'revoked',
])

/**
 * One attempt to charge one invoice. `claimed` is the row inserted BEFORE Stripe
 * is called (it is what makes a second charge impossible); `processing` is a
 * bank debit in flight; `succeeded` and `failed` are the two ends.
 */
export const AUTOPAY_ATTEMPT_STATUSES = Object.freeze([
  'claimed',
  'processing',
  'succeeded',
  'failed',
])

/** An attempt in any of these states means money is, or may be, moving. */
export const AUTOPAY_ACTIVE_ATTEMPT_STATUSES = Object.freeze(
  new Set(['claimed', 'processing', 'succeeded']),
)

/** The fields of an enrollment row, camelCase, as both store backends return them. */
export function emptyAutopay(clientId) {
  return {
    clientId,
    status: 'off',
    paymentMethodId: null,
    methodType: null,
    last4: null,
    bankOrBrand: null,
    mandateId: null,
    consentedAt: null,
    invitedAt: null,
    setupToken: null,
    withdrawnAt: null,
    updatedAt: null,
  }
}

/**
 * What the OWNER'S screen is told about a client's enrollment. Deliberately
 * leaves out the setup token (it is a bearer link), the payment method id and
 * the mandate id: the panel needs words and a last four, never an identifier
 * anyone could use against Stripe.
 */
export function autopaySummary(row) {
  const status = AUTOPAY_STATUSES.includes(row?.status) ? row.status : 'off'
  return {
    clientId: row?.clientId ?? null,
    status,
    methodType: row?.methodType ?? null,
    last4: row?.last4 ?? null,
    bankOrBrand: row?.bankOrBrand ?? null,
    invitedAt: row?.invitedAt ?? null,
    consentedAt: row?.consentedAt ?? null,
    withdrawnAt: row?.withdrawnAt ?? null,
  }
}

/**
 * The latest attempt per invoice. "Latest" is the highest attempt number, which
 * is the only ordering that survives two attempts sharing a timestamp.
 */
export function latestAttemptByInvoice(attempts) {
  const latest = new Map()
  for (const attempt of attempts ?? []) {
    if (!attempt?.invoiceId) continue
    const held = latest.get(attempt.invoiceId)
    if (!held || Number(attempt.attemptNo) > Number(held.attemptNo)) {
      latest.set(attempt.invoiceId, attempt)
    }
  }
  return latest
}

/**
 * The badge an invoice row wears: 'autopay' while a charge is claimed, in
 * flight or collected, 'failed' when the latest attempt failed, null when
 * autopay never touched the invoice.
 */
export function autopayBadgeFor(latestAttempt) {
  if (!latestAttempt) return null
  if (latestAttempt.status === 'failed') return 'failed'
  return AUTOPAY_ACTIVE_ATTEMPT_STATUSES.has(latestAttempt.status) ? 'autopay' : null
}

/* -------------------------------------------------------------------------- */
/* Enrollment: the setup Checkout, and what its events do                      */
/* -------------------------------------------------------------------------- */

// Every Stripe-touching function below takes the `stripe` client as an
// ARGUMENT and the store as another, so a test drives all of it with fakes.

/** The statuses from which a setup completing may ENROLL a client. */
const ENROLLABLE_STATUSES = ['invited', 'pending_verification', 'enrolled']

/** A durable, unguessable link token: 32 random bytes, base64url. */
export function newSetupToken() {
  return randomBytes(32).toString('base64url')
}

/** Card is offered only to a client who has card payments switched on. */
export function autopayOffersCard(client) {
  return client?.cardPaymentsEnabled === true
}

/**
 * What a client reads on Stripe's page beside the confirm button. It is the
 * authorization they are giving, so it says what will be charged, when, and how
 * to stop it - and it says it BEFORE they press the button.
 */
export function autopayConsentText({ firmName, cardsOffered }) {
  return (
    `By saving this payment method you authorize ${firmName} to charge it for the total of each ` +
    'invoice at the time the invoice is emailed to you. ' +
    (cardsOffered
      ? 'Bank transfers have no fee; a card payment adds the card processing fee shown on the invoice. '
      : 'Bank transfers have no fee. ') +
    'You can turn automatic payments off at any time from the link in our emails.'
  )
}

/**
 * The parameters of the setup Checkout session. Exported so a test can read the
 * exact payload - above all that it can NEVER carry an invoice id: a setup is a
 * statement about a client, and anything that reads `metadata.invoiceId` off an
 * event must not be able to mistake one for a payment.
 *
 * Bank (`us_bank_account`) always; `card` only when the client's card payments
 * are on, so a client who was never offered a card is never offered one here.
 * The bank options are the same as the pay link's: automatic verification, so
 * a client can log into their bank in one sitting and fall back to microdeposits.
 */
export function buildAutopaySetupSessionParams({ client, customerId, appUrl, token, firmName }) {
  const cardsOffered = autopayOffersCard(client)
  const metadata = { clientId: client.id, purpose: 'autopay' }
  return {
    mode: 'setup',
    customer: customerId,
    payment_method_types: cardsOffered ? ['us_bank_account', 'card'] : ['us_bank_account'],
    payment_method_options: {
      us_bank_account: {
        verification_method: 'automatic',
        financial_connections: { permissions: ['payment_method'] },
      },
    },
    metadata,
    setup_intent_data: { metadata },
    custom_text: {
      submit: { message: autopayConsentText({ firmName: firmName || 'PB&J Strategic Accounting', cardsOffered }) },
    },
    success_url: `${appUrl}/autopay/${token}?done=1`,
    cancel_url: `${appUrl}/autopay/${token}?cancelled=1`,
  }
}

/**
 * Mint a fresh setup Checkout session (hosted Checkout URLs die in about a day,
 * so every open of the durable link mints its own, exactly as /pay/<token>
 * does). Never throws: a refusal comes back as a sentence.
 */
export async function createAutopaySetupSession({ stripe, client, customerId, appUrl, token, firmName }) {
  if (!stripe) return { ok: false, reason: 'Stripe is not configured yet.' }
  try {
    const session = await stripe.checkout.sessions.create(
      buildAutopaySetupSessionParams({ client, customerId, appUrl, token, firmName }),
    )
    return { ok: true, session }
  } catch (error) {
    return {
      ok: false,
      reason: error?.message
        ? `Stripe refused the setup page: ${error.message}`
        : 'Stripe refused the setup page.',
    }
  }
}

/**
 * The saved method's facts, from a SetupIntent retrieved with `payment_method`
 * and `mandate` expanded. `consentedAt` is the moment the client accepted the
 * mandate (bank), or now for a card, which has none.
 */
export function describeSetupIntent(setupIntent, { now = new Date() } = {}) {
  const method = setupIntent?.payment_method
  const methodObject = method && typeof method === 'object' ? method : null
  const mandate = setupIntent?.mandate && typeof setupIntent.mandate === 'object' ? setupIntent.mandate : null
  const type = methodObject?.type ?? null
  const accepted = Number(mandate?.customer_acceptance?.accepted_at)
  return {
    paymentMethodId: methodObject?.id ?? (typeof method === 'string' ? method : null),
    methodType: type,
    last4: methodObject?.us_bank_account?.last4 ?? methodObject?.card?.last4 ?? null,
    bankOrBrand: methodObject?.us_bank_account?.bank_name ?? methodObject?.card?.brand ?? null,
    mandateId:
      mandate?.id ?? (typeof setupIntent?.mandate === 'string' ? setupIntent.mandate : null),
    consentedAt:
      Number.isFinite(accepted) && accepted > 0
        ? new Date(accepted * 1000).toISOString()
        : now.toISOString(),
  }
}

/** Retrieve a SetupIntent with its method and mandate, and describe it. Throws on a Stripe error. */
export async function fetchSetupIntentDetails(stripe, setupIntentId) {
  const setupIntent = await stripe.setupIntents.retrieve(setupIntentId, {
    expand: ['payment_method', 'mandate'],
  })
  return describeSetupIntent(setupIntent)
}

/** Detach a saved method so nothing can ever charge it again. Best effort, never throws. */
export async function detachPaymentMethod(stripe, paymentMethodId) {
  if (!stripe || !paymentMethodId) return false
  try {
    await stripe.paymentMethods.detach(paymentMethodId)
    return true
  } catch (error) {
    console.warn(`[autopay] could not detach ${paymentMethodId}:`, error?.message || error)
    return false
  }
}

/**
 * Which kind of SETUP event this is, or null for an event that is not about a
 * setup at all.
 *
 * Every setup event has to be recognized BEFORE the webhook looks for an invoice:
 * a setup names a client, never an invoice, and one that fell into the payment
 * path would at best log "unknown invoice" and at worst be matched by an id and
 * applied as money. `ignored` is a setup event we do nothing with (still
 * acknowledged).
 *
 * @returns {{kind: 'session_completed'|'succeeded'|'failed'|'ignored', clientId: string|null,
 *   setupIntentId: string|null} | null}
 */
export function classifySetupEvent(event) {
  const object = event?.data?.object ?? {}
  const clientId = typeof object.metadata?.clientId === 'string' ? object.metadata.clientId : null
  if (event?.type === 'checkout.session.completed' && object.mode === 'setup') {
    return { kind: 'session_completed', clientId, setupIntentId: object.setup_intent ?? null }
  }
  if (typeof event?.type === 'string' && event.type.startsWith('setup_intent.')) {
    const ours = object.metadata?.purpose === 'autopay'
    if (!ours) return { kind: 'ignored', clientId, setupIntentId: object.id ?? null }
    if (event.type === 'setup_intent.succeeded') {
      return { kind: 'succeeded', clientId, setupIntentId: object.id ?? null }
    }
    if (event.type === 'setup_intent.setup_failed') {
      return { kind: 'failed', clientId, setupIntentId: object.id ?? null }
    }
    return { kind: 'ignored', clientId, setupIntentId: object.id ?? null }
  }
  return null
}

/**
 * Apply one setup event to a client's enrollment. NEVER touches an invoice -
 * it has no way to: it is given the enrollment store and Stripe, nothing else.
 *
 * Throws when the enrollment could not be written or Stripe could not be read
 * (the caller takes the event back out of its dedup ledger so Stripe's retry
 * applies it). Returns what, if anything, the owners should be told.
 *
 * @returns {Promise<{notify: null | {event: 'autopay_enrolled', clientId: string, summary: object}}>}
 */
export async function applyAutopaySetupEvent({ store, stripe, event }) {
  const setup = classifySetupEvent(event)
  if (!setup || setup.kind === 'ignored' || !setup.clientId) return { notify: null }

  if (setup.kind === 'session_completed') {
    // Checkout is finished, but a bank that is verifying by microdeposit is not
    // enrolled yet. The guard keeps this from walking an already-enrolled client
    // back (setup_intent.succeeded can arrive first).
    await store.updateClientAutopay(
      setup.clientId,
      { status: 'pending_verification' },
      { onlyIfStatus: ['invited'] },
    )
    return { notify: null }
  }

  if (setup.kind === 'failed') {
    await store.updateClientAutopay(
      setup.clientId,
      { status: 'invited' },
      { onlyIfStatus: ['pending_verification'] },
    )
    return { notify: null }
  }

  // succeeded: the one event that enrolls.
  const details = await fetchSetupIntentDetails(stripe, setup.setupIntentId)
  if (!details.paymentMethodId) throw new Error('The saved payment method could not be read.')
  const before = await store.getClientAutopay(setup.clientId)
  const row = await store.updateClientAutopay(
    setup.clientId,
    { status: 'enrolled', ...details, withdrawnAt: null },
    { onlyIfStatus: ENROLLABLE_STATUSES },
  )
  if (!row) {
    // Turned off, withdrawn, revoked, or never invited: the client finished a
    // setup the owner no longer wants. Do not leave a chargeable method behind.
    await detachPaymentMethod(stripe, details.paymentMethodId)
    return { notify: null }
  }
  if (before?.paymentMethodId && before.paymentMethodId !== details.paymentMethodId) {
    await detachPaymentMethod(stripe, before.paymentMethodId)
  }
  const newlyEnrolled =
    before?.status !== 'enrolled' || before.paymentMethodId !== details.paymentMethodId
  return {
    notify: newlyEnrolled
      ? { event: 'autopay_enrolled', clientId: setup.clientId, summary: autopaySummary(row) }
      : null,
  }
}

/** The fields that make a row unchargeable. Display fields stay for the owner's panel. */
const CLEARED_METHOD = { paymentMethodId: null, mandateId: null }

/**
 * Turn a client's autopay off - the CLIENT withdrawing (`by: 'client'`, via the
 * emailed link) or the OWNER turning it off (`by: 'owner'`). Either way the
 * saved method is detached, so nothing can charge it again, and the durable
 * link is invalidated on the owner's side only: a client who withdrew may open
 * it again to read that autopay is off.
 *
 * @returns {Promise<{changed: boolean, row: object|null}>}
 */
export async function turnOffAutopay({ store, stripe, clientId, by, now = new Date() }) {
  const before = await store.getClientAutopay(clientId)
  if (!before || before.status === 'off' || before.status === 'withdrawn') {
    return { changed: false, row: before }
  }
  const patch =
    by === 'owner'
      ? { status: 'off', setupToken: null, ...CLEARED_METHOD }
      : { status: 'withdrawn', withdrawnAt: now.toISOString(), ...CLEARED_METHOD }
  const row = await store.updateClientAutopay(clientId, patch, {
    onlyIfStatus: ['invited', 'pending_verification', 'enrolled', 'revoked'],
  })
  if (!row) return { changed: false, row: before }
  await detachPaymentMethod(stripe, before.paymentMethodId)
  return { changed: true, row }
}

/* -------------------------------------------------------------------------- */
/* Charging: who is eligible, what is sent to Stripe, what a failure means     */
/* -------------------------------------------------------------------------- */

/**
 * THE KILL SWITCH. Autopay charges nothing unless the environment variable is
 * exactly `on`. It is unset in production until the owner sets it, so shipping
 * this code cannot move a dollar by itself; any other value, including `ON`,
 * `true` and `1`, is OFF.
 */
export function autopayChargingEnabled(env = process.env) {
  return env?.AUTOPAY_CHARGING === 'on'
}

/**
 * Has this invoice ALREADY been emailed to the client, successfully? Only an
 * untagged, ok entry counts: a pay-link open, a delivery event, a receipt or a
 * failed attempt is not "the client was sent the invoice". Autopay charges on
 * the FIRST send only; every re-send after that is a plain email.
 *
 * The ONE tagged entry that counts is `'not-emailed'`, the stamp that marked the
 * invoice sent for a client whose invoices are never emailed: if that switch is
 * later turned off, pressing Send is NOT the first send of a weeks-old invoice.
 */
export function hasPriorOkInvoiceSend(invoice) {
  return (invoice?.emailLog ?? []).some(
    (entry) => entry?.ok === true && (!entry?.kind || entry.kind === 'not-emailed'),
  )
}

/** Does an attempt in this list mean money is, or may be, moving? */
export function hasActiveAutopayAttempt(attempts) {
  return (attempts ?? []).some((attempt) => AUTOPAY_ACTIVE_ATTEMPT_STATUSES.has(attempt?.status))
}

/**
 * The channel a saved method charges on: `card` or `ach`. The client's card
 * payments setting is what allows a card at all - a client who has since had
 * card payments switched off is never charged one.
 */
export function autopayChannelFor(client, enrollment) {
  if (enrollment?.methodType === 'card') return client?.cardPaymentsEnabled === true ? 'card' : null
  if (enrollment?.methodType === 'us_bank_account') return 'ach'
  return null
}

/**
 * Every gate between "an invoice was sent" and "a charge is attempted", in one
 * place and failing CLOSED. All of them must hold:
 *
 *  - the kill switch is on;
 *  - the client is enrolled, with a saved method and a link to withdraw
 *    (autopay without a way to turn it off is not offered);
 *  - the method's channel is allowed (a card only while card payments are on);
 *  - the client is not billed outside the app;
 *  - this is the invoice's FIRST ok send, so no re-send, resend of a changed
 *    invoice or receipt can ever charge;
 *  - nothing has been attempted on it before (the attempt table's primary key
 *    is the real guard; this is the cheap early answer);
 *  - it is not voided, paid or in flight, and is for a positive amount.
 *
 * `attemptNo` greater than 1 is the owner's explicit "Charge again": it skips
 * only the first-send rule, and requires the latest attempt to have failed.
 * `firstSendChecked` (attempt 1 only) says the first-send rule was already
 * applied before the email went out; every other gate is re-applied.
 *
 * @returns {{ok: true, channel: 'ach'|'card'} | {ok: false, reason: string}}
 */
export function autopayChargeDecision({
  client,
  invoice,
  enrollment,
  attempts = [],
  env = process.env,
  attemptNo = 1,
  firstSendChecked = false,
}) {
  if (!autopayChargingEnabled(env)) return { ok: false, reason: 'charging_off' }
  if (!client || !invoice || !enrollment) return { ok: false, reason: 'no_enrollment' }
  if (enrollment.status !== 'enrolled' || !enrollment.paymentMethodId || !enrollment.setupToken) {
    return { ok: false, reason: 'not_enrolled' }
  }
  if (client.platformInvoicingOptOut === true) return { ok: false, reason: 'client_opted_out' }
  // Invoices for this client are delivered outside the app and never emailed,
  // so nobody was told a debit was coming (the first-send email is where the
  // client learns it, and the withdraw link rides on it). Treated like the
  // opt-out: nothing is charged.
  if (client.invoiceNoEmail === true) return { ok: false, reason: 'client_not_emailed' }
  const channel = autopayChannelFor(client, enrollment)
  if (!channel) return { ok: false, reason: 'method_not_allowed' }
  if (!(Number(invoice.total) > 0) || toStripeAmount(invoice.total) <= 0) {
    return { ok: false, reason: 'nothing_owed' }
  }
  if (['void', 'paid', 'processing'].includes(invoice.status)) {
    return { ok: false, reason: `invoice_${invoice.status}` }
  }
  if (attemptNo === 1) {
    // `firstSendChecked` is for the charge step that runs AFTER the send was
    // recorded: by then the log holds the send that is being charged for, and
    // the first-send question was already answered (and acted on - no pay link
    // was minted) before the email left.
    // `sentAt` is the belt to the log's braces: an invoice that already carries a
    // sent date (marked sent some other way, a log entry lost) is not on its
    // first send either. Read on the invoice as it was BEFORE this send, which
    // is what the pre-send call passes.
    if (!firstSendChecked && (hasPriorOkInvoiceSend(invoice) || invoice.sentAt)) {
      return { ok: false, reason: 'not_first_send' }
    }
    if ((attempts ?? []).length > 0) return { ok: false, reason: 'already_attempted' }
  } else {
    const latest = latestAttemptByInvoice(attempts).get(invoice.id)
    if (!latest || latest.status !== 'failed' || Number(latest.attemptNo) !== attemptNo - 1) {
      return { ok: false, reason: 'previous_attempt_not_failed' }
    }
  }
  return { ok: true, channel }
}

/**
 * What a charge is for, in cents: the invoice total, plus (for a card) the same
 * processing fee the card pay link adds. A card charge that left the fee off
 * would collect less than the firm is owed, and one that added it without the
 * `channel: card` metadata would trip the webhook's amount-mismatch flag.
 */
export function autopayChargeCents(invoice, channel) {
  const base = toStripeAmount(invoice?.total)
  return channel === 'card' ? base + toStripeAmount(cardProcessingFee(invoice?.total)) : base
}

/**
 * The exact PaymentIntent that is created. Exported so a test can read it:
 *
 *  - `confirm` and `off_session` together: charged now, with nobody present;
 *  - the saved method and customer, the method TYPE pinned (never "any");
 *  - a bank charge carries the mandate the client accepted at setup;
 *  - `metadata.invoiceId` is what the webhook finds the invoice by, and
 *    `autopay: '1'` and `attempt` are what it finds the attempt by;
 *  - a card carries `channel: 'card'`, which is how the webhook adds the fee
 *    line to the invoice;
 *  - the idempotency key names the invoice AND the attempt, so a retried
 *    request (a dropped connection, the SDK's own retry) can never create a
 *    second charge for the same attempt.
 */
export function buildAutopayPaymentIntent({ invoice, client, enrollment, customerId, attemptNo, channel }) {
  const isCard = channel === 'card'
  return {
    params: {
      amount: autopayChargeCents(invoice, channel),
      currency: 'usd',
      customer: customerId,
      payment_method: enrollment.paymentMethodId,
      payment_method_types: [isCard ? 'card' : 'us_bank_account'],
      confirm: true,
      off_session: true,
      ...(!isCard && enrollment.mandateId ? { mandate: enrollment.mandateId } : {}),
      description: `Invoice ${invoice.number ?? ''} · ${client?.name ?? ''}`.trim(),
      metadata: {
        invoiceId: invoice.id,
        invoiceNumber: invoice.number ?? '',
        autopay: '1',
        attempt: String(attemptNo),
        ...(isCard ? { channel: 'card' } : {}),
      },
    },
    options: { idempotencyKey: `autopay:${invoice.id}:${attemptNo}` },
  }
}

/**
 * Failure codes that mean the saved BANK method must not be tried again: the
 * client never authorized the debit, or the account is closed or does not
 * exist. Each also turns the client's autopay to `revoked`.
 */
export const AUTOPAY_REVOKING_CODES = Object.freeze([
  'debit_not_authorized',
  'account_closed',
  'no_account',
])

export function autopayFailureRevokes(code) {
  return AUTOPAY_REVOKING_CODES.includes(code)
}

/**
 * Whether a Stripe ERROR (the create call threw) is a DEFINITE refusal - the
 * charge did not happen - or AMBIGUOUS: the request may or may not have
 * reached Stripe, or may still be running. An ambiguous attempt is never marked
 * failed, because "Charge again" on an attempt that actually went through is a
 * double charge.
 *
 * With network retries on, a create that timed out and was retried while Stripe
 * is STILL PROCESSING the original answers 409 `idempotency_key_in_use` as an
 * invalid-request error. That is not a refusal - the original may complete - so
 * a 409, those two codes, an idempotency error, and anything Stripe itself says
 * to retry (`Stripe-Should-Retry: true`) are all ambiguous, whatever the error's
 * type says.
 */
export function isDefiniteStripeRefusal(error) {
  const status = Number(error?.statusCode ?? error?.raw?.statusCode)
  const code = error?.code ?? error?.raw?.code
  const shouldRetry = String(
    error?.headers?.['stripe-should-retry'] ?? error?.raw?.headers?.['stripe-should-retry'] ?? '',
  ).toLowerCase()
  if (status === 409) return false
  if (code === 'idempotency_key_in_use' || code === 'lock_timeout') return false
  if (error?.type === 'StripeIdempotencyError') return false
  if (shouldRetry === 'true') return false
  return [
    'StripeCardError',
    'StripeInvalidRequestError',
    'StripeAuthenticationError',
    'StripePermissionError',
    'StripeRateLimitError',
  ].includes(error?.type)
}

/**
 * Create the charge. Never throws.
 *
 * @returns {Promise<
 *   {ok: true, intentId: string, status: 'succeeded'|'processing'} |
 *   {ok: false, definite: boolean, intentId: string|null, code: string|null, message: string}>}
 */
export async function chargeAutopayInvoice({ stripe, ...details }) {
  if (!stripe) {
    return { ok: false, definite: true, intentId: null, code: 'not_configured', message: 'Stripe is not configured.' }
  }
  const { params, options } = buildAutopayPaymentIntent(details)
  try {
    const intent = await stripe.paymentIntents.create(params, options)
    if (intent.status === 'succeeded' || intent.status === 'processing') {
      return { ok: true, intentId: intent.id, status: intent.status }
    }
    // requires_action, requires_payment_method...: no money moved and none will
    // without the client. A definite failure; the intent exists, so the webhook
    // will also hear of it.
    return {
      ok: false,
      definite: true,
      intentId: intent.id ?? null,
      code: intent.last_payment_error?.code ?? intent.status,
      message: intent.last_payment_error?.message ?? `The payment needs action (${intent.status}).`,
    }
  } catch (error) {
    const intent = error?.payment_intent ?? error?.raw?.payment_intent ?? null
    return {
      ok: false,
      definite: isDefiniteStripeRefusal(error),
      intentId: typeof intent?.id === 'string' ? intent.id : null,
      code: error?.code ?? null,
      message: error?.message || 'Stripe could not be reached.',
    }
  }
}

/**
 * The bank refused to be debited (see AUTOPAY_REVOKING_CODES): the saved method
 * is detached and the client's autopay becomes `revoked`, which can only be
 * undone by a fresh invitation. Only an ENROLLED client is revoked - a client
 * who already withdrew or was turned off stays as they are.
 *
 * @returns {Promise<{changed: boolean, row: object|null}>}
 */
export async function revokeAutopay({ store, stripe, clientId }) {
  const before = await store.getClientAutopay(clientId)
  if (!before || before.status !== 'enrolled') return { changed: false, row: before }
  const row = await store.updateClientAutopay(
    clientId,
    { status: 'revoked', ...CLEARED_METHOD },
    { onlyIfStatus: ['enrolled'] },
  )
  if (!row) return { changed: false, row: before }
  await detachPaymentMethod(stripe, before.paymentMethodId)
  return { changed: true, row }
}

/** The sentence an owner reads when a charge was not attempted, by the decision's reason. */
export function autopayRefusalWords(reason) {
  const words = {
    charging_off: 'Automatic charging is not switched on.',
    no_enrollment: 'This client is not set up for automatic payments.',
    not_enrolled: 'This client is not set up for automatic payments.',
    client_opted_out: 'This client is invoiced outside the app.',
    client_not_emailed: 'This client’s invoices are delivered outside the app and never emailed, so nothing is charged automatically.',
    method_not_allowed: 'The saved payment method can no longer be charged (card payments are off for this client).',
    nothing_owed: 'There is nothing owed on this invoice.',
    invoice_void: 'This invoice is voided.',
    invoice_paid: 'This invoice is already paid.',
    invoice_processing: 'A payment is already going through on this invoice.',
    not_first_send: 'This invoice was already sent.',
    already_attempted: 'An automatic payment was already attempted on this invoice.',
    previous_attempt_not_failed: 'The last automatic payment has not failed, so it cannot be charged again.',
    not_claimed: 'An automatic payment is already in progress for this invoice, or the invoice changed. Reload and look again.',
    changed: 'The invoice changed before the charge was made, so nothing was charged.',
    amount_changed: 'The invoice total changed after the email went out, so nothing was charged.',
    enrollment_changed: 'The client turned off automatic payments (or card payments) before the charge was made, so nothing was charged.',
    session_complete: 'The client had already started paying this invoice through a payment link, so nothing was charged.',
    sessions_not_retired: 'An open payment link on this invoice could not be closed, so nothing was charged.',
    stripe_unreachable: 'Stripe could not be reached, so nothing was charged.',
    payment_exists: 'Stripe already shows a payment for this invoice, so nothing was charged.',
    send_not_recorded: 'The send could not be recorded, so nothing was charged.',
    no_invoice: 'Invoice not found.',
  }
  return words[reason] ?? 'The automatic payment was not attempted.'
}

/* -------------------------------------------------------------------------- */
/* What is already at Stripe for an invoice                                    */
/* -------------------------------------------------------------------------- */

/** A PaymentIntent in either of these states means money is moving or has moved. */
const MONEY_MOVED_STATUSES = ['succeeded', 'processing']

/**
 * Every PaymentIntent Stripe holds for one invoice, found by the `invoiceId` we
 * put on each one (a pay-link payment, an autopay attempt).
 *
 * LISTED BY CUSTOMER, not searched: `paymentIntents.search` is eventually
 * consistent (a charge created a moment ago can be missing from it for up to a
 * minute), and the one question this answers - "did the attempt we are unsure
 * about reach Stripe?" - is asked exactly when that lag would give the wrong
 * answer. A list is read-after-write. Throws on a Stripe error: the caller must
 * treat "could not look" as "do not charge".
 *
 * @returns {Promise<Array<{id: string, status: string, attempt: string|null, errorCode: string|null, errorMessage: string|null}>>}
 */
export async function findInvoiceIntents({ stripe, customerId, invoiceId }) {
  if (!customerId || !invoiceId) return []
  const found = []
  let startingAfter
  for (let page = 0; page < 5; page += 1) {
    const result = await stripe.paymentIntents.list({
      customer: customerId,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })
    for (const intent of result?.data ?? []) {
      if (intent?.metadata?.invoiceId !== invoiceId) continue
      found.push({
        id: intent.id,
        status: intent.status,
        attempt: intent.metadata?.attempt ?? null,
        errorCode: intent.last_payment_error?.code ?? null,
        errorMessage: intent.last_payment_error?.message ?? null,
      })
    }
    if (!result?.has_more || !(result?.data ?? []).length) break
    startingAfter = result.data[result.data.length - 1].id
  }
  return found
}

/** Has any of these intents collected, or started collecting, money? */
export function moneyMovedIntent(intents) {
  return (intents ?? []).find((intent) => MONEY_MOVED_STATUSES.includes(intent.status)) ?? null
}

/**
 * Retire the invoice's open Checkout sessions so a pay link cannot collect what
 * autopay is about to. A session that is already COMPLETE means the client has
 * paid (or a bank debit is in flight) by that route: the answer is "do not
 * charge". Anything Stripe cannot confirm is also "do not charge".
 *
 * @returns {Promise<{ok: true} | {ok: false, reason: 'session_complete'|'sessions_not_retired'|'stripe_unreachable', message: string}>}
 */
export async function retireCheckoutSessions({ stripe, sessionIds }) {
  const ids = [...new Set((sessionIds ?? []).filter((id) => typeof id === 'string' && id))]
  const unreachable = (error) => ({
    ok: false,
    reason: 'stripe_unreachable',
    message: error?.message || 'Stripe could not be reached.',
  })
  for (const id of ids) {
    let session
    try {
      session = await stripe.checkout.sessions.retrieve(id)
    } catch (error) {
      return unreachable(error)
    }
    if (session?.status === 'complete') {
      return { ok: false, reason: 'session_complete', message: `Checkout session ${id} was already completed.` }
    }
    if (session?.status !== 'open') continue
    try {
      await stripe.checkout.sessions.expire(id)
    } catch (error) {
      // It may have completed in the instant between the read and the expire.
      try {
        const again = await stripe.checkout.sessions.retrieve(id)
        if (again?.status === 'complete') {
          return { ok: false, reason: 'session_complete', message: `Checkout session ${id} was completed.` }
        }
        if (again?.status === 'open') {
          return { ok: false, reason: 'sessions_not_retired', message: error?.message || 'A payment link could not be closed.' }
        }
      } catch (readError) {
        return unreachable(readError)
      }
    }
  }
  return { ok: true }
}

/** Cancel an intent that will never be paid (a decline, an action nobody will take). Best effort. */
async function cancelIntentQuietly(stripe, intentId) {
  if (!stripe || !intentId) return
  try {
    await stripe.paymentIntents.cancel(intentId)
  } catch (error) {
    console.warn(`[autopay] could not cancel ${intentId}:`, error?.message || error)
  }
}

/* -------------------------------------------------------------------------- */
/* The charge step                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Reasons that are NOT worth telling the owners about: the invoice itself is
 * gone, void, paid or already being paid (nothing to chase), or another attempt
 * already exists and says so on the row.
 */
const QUIET_REFUSALS = new Set([
  'not_claimed',
  'no_invoice',
  'invoice_void',
  'invoice_paid',
  'invoice_processing',
  'already_attempted',
  'previous_attempt_not_failed',
])

/**
 * An invoice email went out saying "we will charge your saved payment method"
 * and then NO charge was made. The client was told there is nothing to do and
 * holds no Pay link, so somebody must hear about it: a failed attempt row (so
 * the invoice row says "Autopay failed"), a line on the invoice's history (the
 * Payment failed tab), and a notification under Payment problems. The owner then
 * re-sends the invoice, which - having a prior send - carries a Pay link and
 * never charges.
 *
 * Never throws.
 */
export async function reportAutopayNotCharged({
  store,
  invoice,
  reason,
  attemptNo = 1,
  channel = null,
  detail = null,
  notifyOwners = async () => {},
}) {
  try {
    const sentence = detail ?? autopayRefusalWords(reason)
    await store.recordFailedAutopayAttempt(invoice.id, {
      attemptNo,
      amountCents: toStripeAmount(invoice.total),
      channel,
      errorCode: reason,
      error: sentence,
    })
    await store.recordInvoicePaymentFailure(invoice.id, {
      at: new Date().toISOString(),
      paymentIntentId: null,
      detail: sentence,
    })
    const name = (await store.getClientNameById(invoice.clientId).catch(() => '')) || 'a client'
    await notifyOwners('invoice_payment_failed', {
      clientId: invoice.clientId,
      message: `The email for invoice ${invoice.number ?? invoice.id} to ${name} said it would be charged automatically, but nothing was charged: ${sentence} Send the invoice again so they get a Pay link.`,
    })
  } catch (error) {
    console.error('[autopay] could not report an uncharged autopay send:', error?.message || error)
  }
}

/**
 * THE CHARGE STEP. Runs AFTER the invoice email has gone out and been recorded
 * (attempt 1), or when the owner presses "Charge again" (attempt 2 and later).
 * Every dependency is injected so the whole thing is provable with a fake
 * Stripe: this is the function that moves money.
 *
 * The order is the design:
 *
 *   1. read everything FRESH and decide (`autopayChargeDecision`), and check the
 *      amount is still the one the email quoted (`emailedCents`);
 *   2. CLAIM the attempt - one atomic insert; no row, no charge;
 *   3. look once more, AFTER the claim: the invoice (a void, a payment marked by
 *      hand or an edit stops the charge), the enrollment (a client who withdrew
 *      in the gap is not charged), then Stripe - close the invoice's open
 *      Checkout sessions (a completed one means "do not charge") and, for
 *      "Charge again", refuse if ANY intent for this invoice has collected or is
 *      collecting money;
 *   4. create the PaymentIntent, idempotency-keyed to (invoice, attempt);
 *   5. record the outcome.
 *
 * A bank charge comes back `processing`: this step moves the invoice to
 * 'processing' and nothing else - only the webhook marks it paid and sends the
 * receipt. A card comes back `succeeded` and is left entirely to the webhook.
 * A DEFINITE refusal marks the attempt failed (cancelling the intent it leaves
 * open, and, for a bank that cannot be debited, revoking autopay); an AMBIGUOUS
 * error (the request may have reached Stripe) leaves the attempt claimed, and
 * only "Check with Stripe" (`reconcileAutopayAttempt`) resolves it.
 *
 * `announced` is true when the client was ALREADY told they would be charged
 * (the first-send email): any refusal then is reported to the owners and written
 * on the invoice (`reportAutopayNotCharged`) instead of vanishing.
 *
 * Never throws for a Stripe or business outcome; a store failure does throw,
 * and the caller (which has already emailed the client) must not let it fail
 * the send.
 *
 * @param {object} args
 * @param {object} args.store
 * @param {object|null} args.stripe
 * @param {string} args.invoiceId
 * @param {number} [args.attemptNo]
 * @param {number|null} [args.emailedCents] what the email told the client would be charged
 * @param {boolean} [args.announced]
 * @param {object} [args.env]
 * @param {(event: string, details: {clientId: string, message: string}) => Promise<void>} [args.notifyOwners]
 * @returns {Promise<{charged: boolean, reason: string|null, attempt: object|null}>}
 */
export async function runAutopayCharge({
  store,
  stripe,
  invoiceId,
  attemptNo = 1,
  emailedCents = null,
  announced = false,
  env = process.env,
  notifyOwners = async () => {},
}) {
  const invoice = (await store.listInvoices()).find((entry) => entry.id === invoiceId)
  if (!invoice) return { charged: false, reason: 'no_invoice', attempt: null }

  const report = async (reason, channel, detail = null) => {
    if (announced && attemptNo === 1 && !QUIET_REFUSALS.has(reason)) {
      await reportAutopayNotCharged({ store, invoice, reason, attemptNo, channel, detail, notifyOwners })
    }
  }
  const refuse = async (reason, channel = null) => {
    await report(reason, channel)
    return { charged: false, reason, attempt: null }
  }

  const client = await store.getClientById(invoice.clientId)
  const enrollment = await store.getClientAutopay(invoice.clientId)
  const attempts = await store.listAutopayAttempts({ invoiceId })
  const decision = autopayChargeDecision({
    client,
    invoice,
    enrollment,
    attempts,
    env,
    attemptNo,
    firstSendChecked: attemptNo === 1,
  })
  if (!decision.ok) return refuse(decision.reason)

  // The amount the CLIENT was told. The claim below only proves the invoice is
  // still what it is NOW; this proves it is still what the email said.
  if (emailedCents !== null && autopayChargeCents(invoice, decision.channel) !== emailedCents) {
    return refuse('amount_changed', decision.channel)
  }

  const claimed = await store.claimAutopayAttempt(invoiceId, {
    attemptNo,
    amountCents: toStripeAmount(invoice.total),
    channel: decision.channel,
  })
  if (!claimed) return refuse('not_claimed')

  // Everything from here until Stripe is called can still say no. Nothing has
  // been charged, so the attempt simply fails; `quiet` is for an invoice that
  // is gone, void or already paid, where there is nothing for anyone to chase.
  const stopBeforeCharge = async (reason, detail, { quiet = false } = {}) => {
    const sentence = detail ?? autopayRefusalWords(reason)
    // "Charge again" is the owner pressing a button and being answered: a refusal
    // before Stripe was called gives the claim back instead of writing a new
    // failed row for every press. Only the first, announced attempt keeps its row
    // (that row is what makes the invoice say "Autopay failed").
    if (attemptNo > 1) {
      await store.releaseUnchargedAutopayAttempt(invoiceId, attemptNo)
      return { charged: false, reason, attempt: null, message: sentence }
    }
    const attempt = await store.updateAutopayAttempt(invoiceId, attemptNo, {
      status: 'failed',
      errorCode: reason,
      error: sentence,
    })
    if (!quiet) await report(reason, decision.channel, sentence)
    return { charged: false, reason, attempt }
  }

  const look = (await store.listInvoices()).find((entry) => entry.id === invoiceId)
  // Still SENT or overdue, not merely "not void": a payment marked by hand since
  // the claim must stop the charge too.
  if (!look || (look.status !== 'sent' && look.status !== 'overdue')) {
    return stopBeforeCharge('changed', null, { quiet: true })
  }
  if (toStripeAmount(look.total) !== toStripeAmount(invoice.total)) {
    return stopBeforeCharge('changed')
  }
  // The client may have withdrawn, been revoked, or had card payments switched
  // off since the decision above was made.
  const lookEnrollment = await store.getClientAutopay(invoice.clientId)
  const lookClient = await store.getClientById(invoice.clientId)
  if (
    !lookEnrollment ||
    lookEnrollment.status !== 'enrolled' ||
    lookEnrollment.paymentMethodId !== enrollment.paymentMethodId ||
    !lookClient ||
    lookClient.platformInvoicingOptOut === true ||
    lookClient.invoiceNoEmail === true ||
    autopayChannelFor(lookClient, lookEnrollment) !== decision.channel ||
    !autopayChargingEnabled(env)
  ) {
    return stopBeforeCharge('enrollment_changed')
  }

  if (!stripe) return stopBeforeCharge('stripe_unreachable', 'Stripe is not configured.')

  // A pay link must not be able to collect what this is about to. Closing the
  // invoice's open Checkout sessions here (after the claim, which also makes the
  // pay page refuse) leaves no window for a new one to appear unseen.
  const retired = await retireCheckoutSessions({
    stripe,
    sessionIds: [look.stripeCheckoutSessionId, look.stripeCardSessionId],
  })
  if (!retired.ok) return stopBeforeCharge(retired.reason, retired.message)

  // "Charge again" follows an attempt whose outcome we RECORDED as failed. Ask
  // Stripe whether that is true of every intent it holds for this invoice: a
  // payment that is succeeded or processing means a second charge would be a
  // double one, whatever our row says.
  let customerId = null
  try {
    customerId = await ensureStripeCustomer({ client, store, stripe })
    if (attemptNo > 1) {
      const intents = await findInvoiceIntents({ stripe, customerId, invoiceId })
      const moved = moneyMovedIntent(intents)
      if (moved) {
        return stopBeforeCharge(
          'payment_exists',
          `Stripe already shows a payment for this invoice (${moved.id}, ${moved.status}), so nothing was charged. The webhook will mark the invoice paid when Stripe confirms it; or look the payment up in Stripe.`,
        )
      }
    }
  } catch (error) {
    return stopBeforeCharge('stripe_unreachable', error?.message || 'Stripe could not be reached.')
  }

  const result = await chargeAutopayInvoice({
    stripe,
    invoice,
    client,
    enrollment,
    customerId,
    attemptNo,
    channel: decision.channel,
  })

  if (result.ok) {
    // Only from `claimed`: the webhook may already have settled this attempt
    // (a card is succeeded within a second), and the route must never write
    // over a terminal state the webhook set.
    const attempt = await store.updateAutopayAttempt(
      invoiceId,
      attemptNo,
      { status: result.status === 'succeeded' ? 'succeeded' : 'processing', paymentIntentId: result.intentId },
      { onlyIfStatus: ['claimed'] },
    )
    if (result.status === 'processing') {
      // A bank debit is in flight for days. Move the invoice to 'processing'
      // (which also blocks a void and a pay link) unless the webhook already
      // reported this very attempt failed.
      const current = (await store.listAutopayAttempts({ invoiceId })).find(
        (entry) => entry.attemptNo === attemptNo,
      )
      if (current?.status !== 'failed') {
        await store.applyInvoicePayment(invoiceId, {
          status: 'processing',
          paymentIntentId: result.intentId,
        })
      }
    }
    return { charged: true, reason: null, attempt }
  }

  const clientName = (await store.getClientNameById(invoice.clientId).catch(() => '')) || 'a client'
  const label = invoice.number ?? invoice.id
  if (!result.definite) {
    await store.updateAutopayAttempt(
      invoiceId,
      attemptNo,
      { error: result.message },
      { onlyIfStatus: ['claimed'] },
    )
    await notifyOwners('invoice_payment_failed', {
      clientId: invoice.clientId,
      message: `Could not confirm whether the automatic payment on invoice ${label} to ${clientName} went through (${result.message}). Open the invoice and press Check with Stripe.`,
    })
    return { charged: false, reason: 'unconfirmed', attempt: claimed }
  }

  const attempt = await store.updateAutopayAttempt(
    invoiceId,
    attemptNo,
    { status: 'failed', paymentIntentId: result.intentId, error: result.message, errorCode: result.code },
    { onlyIfStatus: ['claimed'] },
  )
  // A declined or action-needed intent is left open by Stripe and could be
  // confirmed later by anything holding its secret: it is closed here.
  await cancelIntentQuietly(stripe, result.intentId)
  // The Payment failed tab reads this log entry, idempotent on the intent id, so
  // the webhook's own entry for the same intent does not double it.
  await store
    .recordInvoicePaymentFailure(invoiceId, {
      at: new Date().toISOString(),
      paymentIntentId: result.intentId,
      detail: result.message,
    })
    .catch((error) => console.error('[autopay] payment-failure log write failed:', error))
  if (autopayFailureRevokes(result.code)) {
    const revoked = await revokeAutopay({ store, stripe, clientId: invoice.clientId })
    if (revoked.changed) {
      await notifyOwners('autopay_revoked', {
        clientId: invoice.clientId,
        message: `Automatic payments for ${clientName} were turned off because the bank refused the debit (${result.code}). Invite them again once they have a working account.`,
      })
    }
  }
  // With an intent, Stripe also sends payment_intent.payment_failed and the
  // webhook tells the owners; without one nothing will, so this does.
  if (!result.intentId) {
    await notifyOwners('invoice_payment_failed', {
      clientId: invoice.clientId,
      message: `Automatic payment failed on invoice ${label} to ${clientName} - ${result.message}`,
    })
  }
  return { charged: false, reason: 'failed', attempt }
}

/**
 * "CHECK WITH STRIPE": resolve an attempt stuck at `claimed` - the process died
 * between the claim and the call, or the call ended in an error that does not say
 * whether it reached Stripe. Asks Stripe what it holds for this invoice:
 *
 *   - an intent for THIS attempt that has collected or is collecting money is
 *     ADOPTED: the attempt becomes `processing` with its id and the invoice moves
 *     to 'processing', so the webhook (or Verify payment, if the webhook was
 *     lost) carries it to paid;
 *   - an intent for this attempt that did not (declined, needs action) is
 *     cancelled and the attempt FAILED;
 *   - NO intent for this attempt: nothing was charged, so the attempt is failed
 *     and void, a pay link and "Charge again" work again - but only once the
 *     attempt is older than `minAgeMs`, because the original request cannot
 *     still be in flight after that (the client's own timeouts are far shorter),
 *     and one that could still land would make "failed" a lie.
 *
 * @returns {Promise<{outcome: 'not_stuck'|'stripe_unreachable'|'too_soon'|'adopted'|'failed'|'no_payment_found', attempt: object|null, message: string|null}>}
 */
export async function reconcileAutopayAttempt({
  store,
  stripe,
  invoiceId,
  attemptNo = null,
  now = new Date(),
  minAgeMs = 10 * 60 * 1000,
}) {
  const attempts = await store.listAutopayAttempts({ invoiceId })
  const attempt = attemptNo
    ? attempts.find((entry) => entry.attemptNo === attemptNo)
    : (latestAttemptByInvoice(attempts).get(invoiceId) ?? null)
  if (!attempt || attempt.status !== 'claimed') {
    return { outcome: 'not_stuck', attempt: attempt ?? null, message: null }
  }
  const invoice = (await store.listInvoices()).find((entry) => entry.id === invoiceId)
  const client = invoice ? await store.getClientById(invoice.clientId) : null
  if (!stripe) return { outcome: 'stripe_unreachable', attempt, message: 'Stripe is not configured.' }

  let intents
  try {
    intents = await findInvoiceIntents({
      stripe,
      customerId: client?.stripeCustomerId ?? null,
      invoiceId,
    })
  } catch (error) {
    return { outcome: 'stripe_unreachable', attempt, message: error?.message || 'Stripe could not be reached.' }
  }
  const mine = intents.filter((intent) => String(intent.attempt) === String(attempt.attemptNo))

  if (mine.length > 0) {
    const moved = moneyMovedIntent(mine)
    if (moved) {
      const adopted = await store.updateAutopayAttempt(
        invoiceId,
        attempt.attemptNo,
        { status: 'processing', paymentIntentId: moved.id, error: null, errorCode: null },
        { onlyIfStatus: ['claimed'] },
      )
      if (invoice && (invoice.status === 'sent' || invoice.status === 'overdue')) {
        await store.applyInvoicePayment(invoiceId, { status: 'processing', paymentIntentId: moved.id })
      }
      return {
        outcome: 'adopted',
        attempt: adopted ?? attempt,
        message: `Stripe has this payment (${moved.id}, ${moved.status}). It will be marked paid when Stripe confirms it.`,
      }
    }
    const failedIntent = mine[0]
    await cancelIntentQuietly(stripe, failedIntent.id)
    const sentence = failedIntent.errorMessage ?? `Stripe did not collect this payment (${failedIntent.status}).`
    const failed = await store.updateAutopayAttempt(
      invoiceId,
      attempt.attemptNo,
      { status: 'failed', paymentIntentId: failedIntent.id, error: sentence, errorCode: failedIntent.errorCode ?? failedIntent.status },
      { onlyIfStatus: ['claimed'] },
    )
    await store
      .recordInvoicePaymentFailure(invoiceId, {
        at: now.toISOString(),
        paymentIntentId: failedIntent.id,
        detail: sentence,
      })
      .catch((error) => console.error('[autopay] payment-failure log write failed:', error))
    return { outcome: 'failed', attempt: failed ?? attempt, message: sentence }
  }

  const age = now.getTime() - Date.parse(attempt.createdAt ?? attempt.updatedAt ?? '')
  if (!Number.isFinite(age) || age < minAgeMs) {
    return {
      outcome: 'too_soon',
      attempt,
      message: 'This attempt is only minutes old, so it may still be in progress. Try again in a few minutes.',
    }
  }
  const sentence = 'Stripe has no payment for this attempt, so nothing was charged.'
  const failed = await store.updateAutopayAttempt(
    invoiceId,
    attempt.attemptNo,
    { status: 'failed', error: sentence, errorCode: 'not_found_at_stripe' },
    { onlyIfStatus: ['claimed'] },
  )
  await store
    .recordInvoicePaymentFailure(invoiceId, { at: now.toISOString(), paymentIntentId: null, detail: sentence })
    .catch((error) => console.error('[autopay] payment-failure log write failed:', error))
  return { outcome: 'no_payment_found', attempt: failed ?? attempt, message: sentence }
}

/**
 * What a payment_intent event says about an autopay ATTEMPT (the invoice side is
 * the existing webhook path). Best effort and never throws: the invoice has
 * already been dealt with, and a bookkeeping hiccup here must not turn a
 * recorded payment into a redelivered event.
 *
 * @returns {Promise<{revoked: boolean}>}
 */
export async function recordAutopayAttemptEvent({ store, stripe, invoice, intent, outcome, notifyOwners = async () => {} }) {
  try {
    const attemptNo = Number(intent?.metadata?.attempt)
    if (!Number.isInteger(attemptNo)) return { revoked: false }
    if (outcome === 'succeeded') {
      await store.updateAutopayAttempt(
        invoice.id,
        attemptNo,
        { status: 'succeeded', paymentIntentId: intent.id, error: null, errorCode: null },
        { onlyIfStatus: ['claimed', 'processing', 'failed'] },
      )
      return { revoked: false }
    }
    const code = intent?.last_payment_error?.code ?? null
    const message = intent?.last_payment_error?.message ?? 'the payment was declined'
    await store.updateAutopayAttempt(
      invoice.id,
      attemptNo,
      { status: 'failed', paymentIntentId: intent.id, error: message, errorCode: code },
      { onlyIfStatus: ['claimed', 'processing'] },
    )
    if (!autopayFailureRevokes(code)) return { revoked: false }
    const revoked = await revokeAutopay({ store, stripe, clientId: invoice.clientId })
    if (revoked.changed) {
      const name = (await store.getClientNameById(invoice.clientId).catch(() => '')) || 'a client'
      await notifyOwners('autopay_revoked', {
        clientId: invoice.clientId,
        message: `Automatic payments for ${name} were turned off because the bank returned the debit (${code}). Invite them again once they have a working account.`,
      })
    }
    return { revoked: revoked.changed }
  } catch (error) {
    console.error('[autopay] could not record the attempt outcome:', error?.message || error)
    return { revoked: false }
  }
}
