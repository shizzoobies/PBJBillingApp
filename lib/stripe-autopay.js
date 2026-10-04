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
