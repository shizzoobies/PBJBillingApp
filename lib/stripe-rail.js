/**
 * Stripe, used strictly as the PAYMENT RAIL (I3).
 *
 * The app is the invoice of record — numbering, lines, history and status all
 * live in our `invoices` table. Stripe's only jobs are to collect the money and
 * tell us when it arrived. We deliberately do NOT use Stripe Invoicing: that
 * would be a second system of record to reconcile, plus a per-invoice fee.
 *
 * ACH is the DEFAULT payment method (0.8%, capped at $5, versus card's ~3%) and
 * carries no fee for anyone. Card is a per-client opt-in: a card-enabled client
 * gets a SECOND Checkout session alongside the ACH one, carrying an extra line
 * for the processing fee so the firm nets the invoice total either way. The two
 * sessions are siblings — paying one expires the other, because two live links
 * for one invoice is two ways to pay it.
 *
 * NOTHING IN HERE THROWS WHEN STRIPE IS UNCONFIGURED. Production runs without
 * keys until the sandbox work is done, and the rest of the app — generating,
 * reviewing, printing, exporting invoices — must keep working regardless. The
 * send path asks `isStripeConfigured()` first and refuses with a sentence a
 * human can act on, rather than surfacing a stack trace.
 */

import Stripe from 'stripe'

import { CARD_PROCESSING_FEE_LABEL, cardProcessingFee } from './invoice-lines.js'

let cached = null

/** True when the secret key is present. Never logs or returns the key itself. */
export function isStripeConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY)
}

/** True when webhook signatures can be verified. Without this we refuse events. */
export function isStripeWebhookConfigured() {
  return Boolean(process.env.STRIPE_WEBHOOK_SECRET)
}

/**
 * The shared client, or null when unconfigured. Built lazily so importing this
 * module is free and so a key added to the environment is picked up on the next
 * call rather than needing a restart-ordering dance.
 */
export function stripeClient() {
  if (!isStripeConfigured()) return null
  if (!cached) {
    cached = new Stripe(process.env.STRIPE_SECRET_KEY, {
      // Pinned deliberately: an account-level API version change should never
      // silently alter the shape of what we read off a webhook.
      apiVersion: '2024-06-20',
      // Named so it is obvious in Stripe's request logs which app called.
      appInfo: { name: 'PBJBillingApp' },
      maxNetworkRetries: 2,
    })
  }
  return cached
}

/** Test/sandbox credentials start `sk_test_`; live start `sk_live_`. */
export function isStripeTestMode() {
  return String(process.env.STRIPE_SECRET_KEY ?? '').startsWith('sk_test_')
}

/**
 * Money in cents, which is what Stripe takes. Rounded once here rather than at
 * each call site, because a half-cent drifting into a line total is the kind of
 * thing that only shows up on a client's bank statement.
 */
export function toStripeAmount(dollars) {
  return Math.round((Number(dollars) || 0) * 100)
}

/**
 * The Checkout line items for one invoice. Exported so the tricky part — what
 * happens to a NEGATIVE line — is testable without touching the network.
 *
 * Stripe rejects negative line amounts, so a credit carried from last month
 * cannot be sent as its own line. When any line is negative the whole thing
 * collapses to a single line for the invoice total, which is the amount the
 * client actually owes. The invoice itself still shows the full breakdown; this
 * only changes what the payment page lists.
 */
export function buildCheckoutLineItems(invoice, client) {
  const total = toStripeAmount(invoice?.total)
  const lines = invoice?.lineItems ?? []
  const hasNegativeLine = lines.some((line) => Number(line.amount) < 0)

  if (hasNegativeLine) {
    if (total <= 0) return []
    return [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: total,
          product_data: {
            name: `Invoice ${invoice.number ?? ''}`.trim(),
            description: `${client?.name ?? 'Client'} · ${invoice.period}`,
          },
        },
      },
    ]
  }

  return lines
    .filter((line) => toStripeAmount(line.amount) > 0)
    .map((line) => ({
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: toStripeAmount(line.amount),
        product_data: {
          name: line.label || 'Services',
          ...(line.detail ? { description: line.detail } : {}),
        },
      },
    }))
}

/**
 * The Checkout line items for the CARD channel: the same lines the ACH session
 * carries, plus one final line for the processing fee.
 *
 * The fee is a line rather than an adjusted total on purpose — the payer sees
 * what the invoice said and then sees exactly what the card costs them, which is
 * also what the emailed wording promises. `buildCheckoutLineItems` already
 * handles the credit-line collapse, so the fee simply lands after whatever it
 * produced.
 */
export function buildCardCheckoutLineItems(invoice, client) {
  const base = buildCheckoutLineItems(invoice, client)
  if (base.length === 0) return []
  const fee = toStripeAmount(cardProcessingFee(invoice?.total))
  if (fee <= 0) return base
  return [
    ...base,
    {
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: fee,
        product_data: {
          name: CARD_PROCESSING_FEE_LABEL,
          description: 'Bank transfer has no fee.',
        },
      },
    },
  ]
}

/**
 * Both channels' Checkout sessions, which differ only in the payment method and
 * in whether the fee line is present. One implementation so a change to the
 * metadata, the URLs or the error wording cannot land on one channel only.
 *
 * @returns {{ok: true, session: object} | {ok: false, reason: string}}
 */
async function createSession({ invoice, client, customerId, appUrl, channel }) {
  const stripe = stripeClient()
  if (!stripe) {
    return { ok: false, reason: 'Stripe is not configured yet — no payment link can be created.' }
  }
  const total = toStripeAmount(invoice.total)
  if (total <= 0) {
    return { ok: false, reason: 'This invoice is not for a positive amount, so it cannot be paid online.' }
  }

  const isCard = channel === 'card'
  const lineItems = isCard
    ? buildCardCheckoutLineItems(invoice, client)
    : buildCheckoutLineItems(invoice, client)

  if (lineItems.length === 0) {
    return { ok: false, reason: 'This invoice has no chargeable lines.' }
  }

  // The ACH session's metadata is left exactly as it was — no `channel` key —
  // so nothing about the default path changes. The webhook reads the ABSENCE of
  // the key as ACH, which is also right for every session minted before this.
  const metadata = {
    invoiceId: invoice.id,
    invoiceNumber: invoice.number ?? '',
    ...(isCard ? { channel: 'card' } : {}),
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: isCard ? ['card'] : ['us_bank_account'],
      ...(isCard
        ? {}
        : {
            payment_method_options: {
              us_bank_account: {
                verification_method: 'automatic',
                financial_connections: { permissions: ['payment_method'] },
              },
            },
          }),
      ...(customerId ? { customer: customerId } : {}),
      line_items: lineItems,
      // Our invoice number is the join key when reconciling a Stripe payout
      // back to this app, and it rides on the PaymentIntent too so it shows up
      // wherever the money is inspected.
      metadata,
      payment_intent_data: {
        metadata,
        description: `Invoice ${invoice.number ?? ''} · ${client.name}`.trim(),
      },
      success_url: `${appUrl}/invoices?paid=${encodeURIComponent(invoice.id)}`,
      cancel_url: `${appUrl}/invoices?cancelled=${encodeURIComponent(invoice.id)}`,
    })
    return { ok: true, session }
  } catch (error) {
    // A Stripe-side refusal (ACH not enabled on the account, a restricted key
    // missing a scope) must read as a fixable configuration problem, not as an
    // app crash — those are the two most likely failures on first setup.
    return {
      ok: false,
      reason: error?.message
        ? `Stripe refused the payment link: ${error.message}`
        : 'Stripe refused the payment link.',
    }
  }
}

/**
 * The DEFAULT Checkout Session for one invoice, for every client.
 *
 * `us_bank_account` only, and `verification_method: 'automatic'` so a client can
 * log into their bank and pay in one sitting, falling back to microdeposits for
 * anyone who will not (Alex's call — offer both, let the client pick).
 *
 * Line items mirror the invoice so the client sees the same breakdown they were
 * emailed. A NEGATIVE line (a credit from last month's true-up) cannot be sent
 * to Stripe as a line item — Stripe rejects negative amounts — so the lines are
 * collapsed to a single total line whenever any line is negative. The invoice
 * itself still shows the full breakdown; this only affects the payment page.
 *
 * No fee, ever. Bank transfer is the no-fee channel for everyone.
 *
 * @returns {{ok: true, session: object} | {ok: false, reason: string}}
 */
export async function createInvoiceCheckoutSession({ invoice, client, customerId, appUrl }) {
  return createSession({ invoice, client, customerId, appUrl, channel: 'ach' })
}

/**
 * The SECOND Checkout Session, minted only for a client with card payments
 * switched on. Card-only, and carrying the grossed-up processing fee as its own
 * final line so the firm nets the invoice total exactly.
 *
 * The invoice's stored lines are NOT changed here — the fee only becomes a line
 * on the invoice of record if the client actually pays this way, which the
 * webhook does.
 *
 * @returns {{ok: true, session: object} | {ok: false, reason: string}}
 */
export async function createInvoiceCardCheckoutSession({ invoice, client, customerId, appUrl }) {
  return createSession({ invoice, client, customerId, appUrl, channel: 'card' })
}

/**
 * Retire the Checkout session an invoice used to point at, after a newer one
 * has replaced it.
 *
 * Every send mints a fresh session, so without this a client who was emailed
 * twice holds two live pay links for one invoice and can pay it twice — two
 * ACH debits, a refund to arrange, and an awkward call. Expiring the old one
 * makes the superseded link say so.
 *
 * Best effort by design: the old session may already be expired or completed,
 * and neither is a reason to fail a send that has otherwise gone through.
 */
export async function expireCheckoutSession(sessionId) {
  if (!sessionId) return false
  const stripe = stripeClient()
  if (!stripe) return false
  try {
    await stripe.checkout.sessions.expire(sessionId)
    return true
  } catch (error) {
    console.warn(`[stripe] could not expire session ${sessionId}:`, error?.message || error)
    return false
  }
}

/**
 * Which channel a verified webhook event belongs to, and which session that
 * payment has just made redundant.
 *
 * Pulled out of the route because it is the decision the whole card feature
 * turns on and it is not otherwise reachable by a test: get `isCard` wrong and
 * either the fee never lands on the invoice, or it lands on a client who paid by
 * bank transfer and was never charged one.
 *
 * The channel is read from metadata WE set on both the Checkout session and its
 * PaymentIntent, falling back to the stored card session id. Absent metadata
 * means ACH — the right answer for every session minted before card existed.
 *
 * `siblingSessionId` is the OTHER channel's live session, or null when there is
 * nothing to retire. Expiring it is what makes paying twice impossible.
 *
 * @returns {{isCard: boolean, siblingSessionId: string|null}}
 */
export function resolveWebhookChannel({ eventType, object, invoice }) {
  const isCard =
    object?.metadata?.channel === 'card' ||
    (eventType === 'checkout.session.completed' &&
      Boolean(invoice?.stripeCardSessionId) &&
      object?.id === invoice.stripeCardSessionId)
  const sibling = isCard ? invoice?.stripeCheckoutSessionId : invoice?.stripeCardSessionId
  return {
    isCard,
    siblingSessionId: sibling && sibling !== object?.id ? sibling : null,
  }
}

/**
 * Verify a webhook signature and return the event. Returns null when the
 * signature does not check out, which is the ONLY thing standing between this
 * endpoint and anyone on the internet marking invoices paid.
 */
export function verifyStripeEvent(rawBody, signatureHeader) {
  const stripe = stripeClient()
  if (!stripe || !isStripeWebhookConfigured() || !signatureHeader) return null
  try {
    return stripe.webhooks.constructEvent(
      rawBody,
      signatureHeader,
      process.env.STRIPE_WEBHOOK_SECRET,
    )
  } catch {
    return null
  }
}
