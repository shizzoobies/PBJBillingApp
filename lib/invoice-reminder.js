/**
 * Sending ONE payment reminder (featreq-3f1d63b6, the manual "Send reminder"
 * button), as a plain function so every rule is tested by running it rather
 * than by reading server.js. The route does the session, origin and body
 * checks and hands over the store and the mail sender it wants used.
 *
 * What a reminder is: a short email, to the addresses the invoice itself goes
 * to, carrying the invoice's SAME durable pay link (`/pay/<token>`). It is
 * logged on the invoice's email log as `kind: 'reminder'`, which is a tagged
 * entry: it never marks the invoice sent, never moves the sent date, the status
 * or the due date, never counts as autopay's first send, and leaves a Payment
 * failed invoice where it is (`latestInvoiceSend` skips it).
 *
 * What a reminder never does: create a Stripe Checkout session or customer
 * (nothing here imports Stripe; the token comes from the store, which mints one
 * only for an invoice that predates tokens and never calls Stripe to do it),
 * attach the invoice document, or schedule anything.
 *
 * Every refusal is decided before the token is asked for and before the email
 * is built, and the invoice and its autopay attempts are read once more right
 * before the provider call - an email cannot be unsent.
 */

import { periodAnchorFor, prepaidMonthCovering } from './billing-period.js'
import { buildInvoiceReminderEmail } from './invoice-email.js'
import { firmToday } from './firm-time.js'
import { getBillingPeriodLabel } from './invoice-lines.js'
import {
  RECIPIENTS_CHANGED_REASON,
  invoiceEmailAddressee,
  resolveInvoiceRecipients,
  resolveSendRecipients,
} from './invoice-recipients.js'
import { invoiceContentChanged } from './invoice-sent-change.js'
import { REMINDER_KIND, reminderRefusalCode, reminderRefusalMessage } from './invoice-reminder-rule.js'
import { hasActiveAutopayAttempt } from './stripe-autopay.js'

const refusal = (code, clientName) => ({
  status: 409,
  body: { error: code, message: reminderRefusalMessage(code, clientName) },
})

/**
 * Remind the client about one invoice, or say why not.
 *
 * `context`: { invoiceId, now, appUrl, stripeConfigured, userId, to? }. `to` is
 * the list the owner's confirm SHOWED: when it is posted, the reminder goes to
 * exactly those addresses, and one that is no longer on file (a contact changed
 * in another tab after the confirm) refuses the reminder rather than email
 * anybody unseen. Omitted, it goes to everyone on file (Send's default).
 * `deps`: { store, sendEmail } - the app's store (both backends implement every
 * method used here) and `sendInvoiceEmail` from lib/notify.js, the same provider
 * call Send uses, so the From name and the reply-to match.
 *
 * Never throws for a provider or bookkeeping problem after the email left: a
 * reminder that was delivered is never reported as failed. A store read that
 * fails BEFORE the send throws, and nothing has been emailed.
 *
 * @returns {Promise<{status: number, body: object}>} 200 `{ invoice }` (the
 *   recorded row), 200 `{ invoice, logged: false }` when the email left but its
 *   log entry could not be written after one retry, or a refusal `{ error, message }`.
 */
export async function remindInvoice(context, { store, sendEmail }) {
  const { invoiceId, appUrl = '', stripeConfigured = false, userId = null } = context
  const now = context.now instanceof Date ? context.now : new Date()
  const today = firmToday(now)

  const invoice = (await store.listInvoices()).find((entry) => entry.id === invoiceId) ?? null
  if (!invoice) return { status: 404, body: { error: 'invoice_not_found', message: 'Invoice not found.' } }

  const data = await store.read()
  const clients = data?.clients ?? []
  const client = clients.find((entry) => entry.id === invoice.clientId) ?? null
  // The status refusals do not need a client, so a void or draft invoice whose
  // client is gone still says what it is; anything that would send needs one.
  const statusOnly = reminderRefusalCode({
    invoice,
    client: null,
    autopayActive: false,
    changedSinceSent: false,
    today: '',
  })
  if (statusOnly) return refusal(statusOnly, client?.name)
  if (!client) {
    return { status: 409, body: { error: 'invoice_no_client', message: 'This invoice has no client on file.' } }
  }

  const changedSinceSent =
    (await store.withChangedSinceSent([invoice]))?.[0]?.changedSinceSent === true
  const autopayActive = hasActiveAutopayAttempt(await store.listAutopayAttempts({ invoiceId: invoice.id }))
  const code = reminderRefusalCode({ invoice, client, autopayActive, changedSinceSent, today })
  if (code) return refusal(code, client.name)

  // A MONTH ALREADY PREPAID (billing period): the period's anchor invoice is paid
  // and carries a prepayment line for this month that this invoice does not draw.
  // The client has paid for it, so they are not chased for it again. Only a
  // billing-period client's non-anchor month reads the anchor's month at all.
  const anchorPeriod = periodAnchorFor(client, invoice.period)
  if (anchorPeriod && anchorPeriod !== invoice.period) {
    const covered = prepaidMonthCovering({
      client,
      invoice,
      invoices: await store.listInvoices({ period: anchorPeriod }),
    })
    if (covered) {
      return {
        status: 409,
        body: {
          error: 'month_prepaid',
          message: `This month is covered by a prepayment on ${
            covered.anchorInvoice.number ?? `${getBillingPeriodLabel(anchorPeriod)}'s invoice`
          }, which is paid, so no reminder was sent. Apply credit on account to this invoice instead.`,
        },
      }
    }
  }

  // THE SEND ROUTE'S RESOLVER, step for step, so a reminder refuses exactly
  // where Send refuses: a billing master with no receiving company, or nobody on
  // file. The posted `to` (what the confirm showed) is bound STRICTLY: every
  // address in it must still be on file, or nothing is sent - a filter that
  // quietly dropped the changed one could still email a list she never saw.
  const addressee = invoiceEmailAddressee(client, clients)
  if (addressee.refusal) return { status: 409, body: { ...addressee.refusal } }
  const recipients = resolveInvoiceRecipients({ client: addressee.addressee, contacts: data?.contacts ?? [] })
  const posted = context.to
  if (posted !== undefined) {
    if (!Array.isArray(posted) || posted.some((address) => typeof address !== 'string')) {
      return {
        status: 400,
        body: { error: 'invoice_bad_recipients', message: '`to` must be a list of email addresses.' },
      }
    }
    const onFile = new Set(recipients.to.map((address) => address.toLowerCase()))
    if (posted.some((address) => !onFile.has(address.trim().toLowerCase()))) {
      return { status: 409, body: { error: 'recipients_changed', message: RECIPIENTS_CHANGED_REASON } }
    }
  }
  const chosen = resolveSendRecipients({ allowed: recipients.to, to: posted })
  if (!chosen.ok) return { status: chosen.status, body: { error: chosen.error, message: chosen.message } }
  const to = chosen.to

  // The SAME link the invoice carried. `getOrCreateInvoicePayToken` coalesces:
  // an invoice with a token gets it back unchanged, one that predates tokens
  // gets its first (approved). No Checkout session is created here - the
  // `/pay/<token>` page builds one when the client opens it. Without Stripe
  // there is nothing to pay through, so no link (the email stands alone, as
  // Send's does). A token that cannot be had is a refusal, not a link-less
  // reminder: "pay with the same link as before" with no link would be wrong.
  let payUrl = ''
  let cardPayUrl = ''
  if (stripeConfigured) {
    let token = null
    try {
      token = await store.getOrCreateInvoicePayToken(invoice.id)
    } catch (error) {
      console.error('[invoices] reminder: could not read the pay link:', error?.message || error)
    }
    if (!token) {
      return {
        status: 502,
        body: {
          error: 'pay_link_failed',
          message: "Could not get this invoice's pay link, so no reminder was sent. Try again.",
        },
      }
    }
    const base = String(appUrl).replace(/\/+$/, '')
    payUrl = `${base}/pay/${token}`
    if (client.cardPaymentsEnabled === true) cardPayUrl = `${payUrl}/card`
  }

  const firmSettings = await store.getFirmSettings().catch(() => null)
  const email = buildInvoiceReminderEmail({
    invoice,
    client,
    firmName: firmSettings?.name || undefined,
    payUrl,
    cardPayUrl,
    // No token before this reminder (its first send carried no link, e.g. an
    // autopay client's): there is no "same link as before" to point at.
    linkIsNew: Boolean(payUrl) && !invoice.payToken,
  })

  // THE LAST LOOK before the email leaves. A void, a payment that started, an
  // edit, an autopay attempt claimed, or another tab's reminder since the read
  // above all stop it here. The instant between this read and the provider call
  // is not covered (the same caveat as Send).
  const lastLook =
    (await store.listInvoices({ period: invoice.period ?? null })).find((entry) => entry.id === invoice.id) ??
    null
  if (!lastLook || lastLook.status === 'void') {
    return {
      status: 409,
      body: {
        error: 'invoice_voided',
        message: 'This invoice was voided while the reminder was being prepared. Nothing was emailed.',
      },
    }
  }
  const lastCode = reminderRefusalCode({
    invoice: lastLook,
    client,
    autopayActive: hasActiveAutopayAttempt(await store.listAutopayAttempts({ invoiceId: invoice.id })),
    changedSinceSent,
    today,
  })
  if (lastCode) {
    return {
      status: 409,
      body: { error: lastCode, message: `${reminderRefusalMessage(lastCode, client.name)} Nothing was emailed.` },
    }
  }
  if (invoiceContentChanged(invoice, lastLook)) {
    return {
      status: 409,
      body: {
        error: 'invoice_changed',
        message: 'This invoice changed while the reminder was being prepared. Nothing was emailed. Try again.',
      },
    }
  }

  const sent = await sendEmail({
    to,
    subject: email.subject,
    html: email.html,
    text: email.text,
    attachments: [],
    fromName: firmSettings?.name || undefined,
    invoiceId: invoice.id,
    kind: REMINDER_KIND,
  })
  const stamp = now.toISOString()

  if (!sent?.ok) {
    // Logged either way: the failed attempt is the evidence for "did the
    // reminder go?". A tagged entry, so it changes nothing else.
    try {
      await store.recordInvoiceSent(invoice.id, {
        kind: REMINDER_KIND,
        to,
        subject: email.subject,
        ok: false,
        error: sent?.error ?? 'The email provider did not accept the reminder.',
        providerId: sent?.providerId ?? null,
        stamp,
      })
    } catch (error) {
      console.error('[invoices] reminder: the failed attempt could not be logged:', error)
    }
    return {
      status: 502,
      body: {
        error: 'reminder_send_failed',
        message: sent?.error || 'The email provider did not accept the reminder.',
      },
    }
  }

  // Past this point the reminder HAS left, and no bookkeeping failure may make
  // the answer say otherwise. The log entry is what "Last reminded" and the
  // once-a-day guard read, so a write that throws (or answers null: no row was
  // written) is tried ONCE more. If that fails too the answer is still 200 -
  // the email is out - but says `logged: false`, so the caller knows the record
  // is missing. (A write that committed and then threw could log twice; one
  // duplicate log line is the lesser harm next to a reminder with no record.)
  const entry = {
    kind: REMINDER_KIND,
    to,
    subject: email.subject,
    ok: true,
    error: null,
    providerId: sent.providerId ?? null,
    stamp,
  }
  let recorded = null
  for (let attempt = 1; attempt <= 2 && !recorded; attempt += 1) {
    try {
      recorded = await store.recordInvoiceSent(invoice.id, entry)
    } catch (error) {
      console.error(`[invoices] reminder log write ${attempt} of 2 failed after delivery:`, error)
    }
  }
  if (!recorded) {
    console.error(`[invoices] reminder for ${invoice.id} was emailed but could not be logged`)
    return { status: 200, body: { invoice: lastLook, logged: false } }
  }
  try {
    await store.recordActivity(userId, 'invoice_reminded', `${invoice.number ?? invoice.id}`)
  } catch (error) {
    console.error('[invoices] reminder activity entry failed after delivery:', error)
  }
  return { status: 200, body: { invoice: recorded } }
}
