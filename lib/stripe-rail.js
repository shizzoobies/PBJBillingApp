/**
 * Stripe, used strictly as the PAYMENT RAIL (I3).
 *
 * The app is the invoice of record — numbering, lines, history and status all
 * live in our `invoices` table. Stripe's only jobs are to collect the money and
 * tell us when it arrived. We deliberately do NOT use Stripe Invoicing: that
 * would be a second system of record to reconcile, plus a per-invoice fee.
 *
 * ACH is the payment method (0.8%, capped at $5, versus card's ~3%). Card is a
 * per-client opt-in with the client covering the convenience fee, and is not
 * built here.
 *
 * NOTHING IN HERE THROWS WHEN STRIPE IS UNCONFIGURED. Production runs without
 * keys until the sandbox work is done, and the rest of the app — generating,
 * reviewing, printing, exporting invoices — must keep working regardless. The
 * send path asks `isStripeConfigured()` first and refuses with a sentence a
 * human can act on, rather than surfacing a stack trace.
 */

import Stripe from 'stripe'

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
 * The Checkout Session for one invoice.
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
 * @returns {{ok: true, session: object} | {ok: false, reason: string}}
 */
export async function createInvoiceCheckoutSession({
  invoice,
  client,
  customerId,
  appUrl,
}) {
  const stripe = stripeClient()
  if (!stripe) {
    return { ok: false, reason: 'Stripe is not configured yet — no payment link can be created.' }
  }
  const total = toStripeAmount(invoice.total)
  if (total <= 0) {
    return { ok: false, reason: 'This invoice is not for a positive amount, so it cannot be paid online.' }
  }

  const lineItems = buildCheckoutLineItems(invoice, client)

  if (lineItems.length === 0) {
    return { ok: false, reason: 'This invoice has no chargeable lines.' }
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['us_bank_account'],
      payment_method_options: {
        us_bank_account: {
          verification_method: 'automatic',
          financial_connections: { permissions: ['payment_method'] },
        },
      },
      ...(customerId ? { customer: customerId } : {}),
      line_items: lineItems,
      // Our invoice number is the join key when reconciling a Stripe payout
      // back to this app, and it rides on the PaymentIntent too so it shows up
      // wherever the money is inspected.
      metadata: { invoiceId: invoice.id, invoiceNumber: invoice.number ?? '' },
      payment_intent_data: {
        metadata: { invoiceId: invoice.id, invoiceNumber: invoice.number ?? '' },
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
