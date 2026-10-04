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
// ARGUMENT and the store as another. Nothing here imports the SDK, so a test
// drives all of it with fakes and the store module never drags Stripe in.

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
