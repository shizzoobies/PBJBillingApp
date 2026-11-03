/**
 * "Push to next month" (featreq-40697310): a small draft invoice is closed and
 * everything on it moves onto the NEXT month's invoice as its own lines, so the
 * client gets one invoice when it is worth sending.
 *
 * Brittany's answer to the ticket was option 1: a button on a draft. The October
 * invoice closes as "rolled into November" (stored as a VOID with
 * `rolledIntoPeriod`, so every existing reader already treats it as not live),
 * and November's invoice lists the October work under its own heading. If
 * November is still too small she can push again; a chain keeps each line's
 * original month.
 *
 * WHY THE LINES ARE CARRIED, NOT RE-DERIVED: time entries carry no "invoiced"
 * flag (hours are picked by date, lib/invoice-lines.js `isInBillingPeriod`), so
 * November's generation would never pick up October's hours by itself.
 *
 * Pure: no clock, no database. The store decides and writes; the editor and the
 * documents read the same rules from here.
 */

import { getBillingPeriodLabel, isEmptyHoursLine, isEmptyPlanLine } from './invoice-lines.js'
import { hasUnconfirmedCoverage } from './expense-coverage.js'
import { normalizeBillingPeriodMonths } from './billing-period.js'
import { isInactiveClientStage } from './recurring-gate.js'

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100

/** Is this a real "YYYY-MM"? */
export function isRollPeriod(value) {
  return typeof value === 'string' && PERIOD.test(value)
}

/** The "YYYY-MM" right after `period` ('2026-12' -> '2027-01'); null for anything else. */
export function nextPeriod(period) {
  if (!isRollPeriod(period)) return null
  let year = Number(period.slice(0, 4))
  let month = Number(period.slice(5, 7)) + 1
  if (month > 12) {
    month = 1
    year += 1
  }
  return `${year}-${String(month).padStart(2, '0')}`
}

/**
 * The line kinds that move. Everything that describes WORK or a CHARGE: the plan,
 * hours, ad hoc work, reimbursements (one-off and recurring), a true-up, a typed
 * line and the informational hours detail.
 *
 * Everything else stays behind on the closed invoice, because it belongs to the
 * DOCUMENT rather than the work: the advance section (re-attached separately,
 * see `rolledAdvanceOffer`), a billing-period prepayment (refused before a push
 * ever happens), credit on account and a retainer credit, and a card fee (only
 * ever added to a paid invoice). The void gives the credits back: credit on
 * account goes back on account and a retainer goes back to unapplied. They are
 * NOT drawn or re-applied on the next invoice automatically when the lines are
 * added to a draft that already exists - apply them to next month's invoice from
 * its editor if wanted. (A next month generated AFTER the push draws credit on
 * account the way every generated draft does.)
 */
export const ROLL_FORWARD_KEPT_KINDS = Object.freeze(
  new Set(['plan', 'hourly', 'reimbursement', 'recurring', 'adhoc', 'adjustment', 'custom', 'time_detail']),
)

/**
 * The kinds a carried block is inserted IN FRONT OF on the receiving invoice:
 * the lines that are about the document, not the work. Keeping the carried work
 * above them keeps Stripe checkout, the QuickBooks export and the AI reading
 * work first and credits last, as every generated invoice already reads.
 */
const DOCUMENT_TAIL_KINDS = new Set(['prepayment', 'account_credit', 'retainer_credit', 'card-fee', 'advance_request'])

/** Did this line come over from an earlier month's invoice? */
export function isCarriedLine(line) {
  return isRollPeriod(line?.carriedFromPeriod)
}

/** The heading the carried lines print under: "Carried forward from October 2026". */
export function carriedForwardTitle(period) {
  return `Carried forward from ${getBillingPeriodLabel(period)}`
}

/** What a rolled invoice says instead of "Voided": "Rolled into November 2026". */
export function rolledIntoLabel(period) {
  return `Rolled into ${getBillingPeriodLabel(period)}`
}

/** The longest label the store's sanitizer keeps (db/store.js `sanitizeInvoiceLines`). */
const LABEL_MAX = 300

/**
 * The lines a pushed invoice hands to the next month, from its CURRENT lines (as
 * she edited them, not as generated).
 *
 * Each carried line is an ordinary editable line on the next invoice, plus:
 *   - `carriedFromPeriod`: the month the work was done in. Kept through a chain,
 *     so October's lines pushed on from November still say October.
 *   - `carriedFromInvoiceId`: the invoice that was pushed to bring it HERE (the
 *     immediate source). Undo removes exactly these.
 *   - a label the client can read: "October 2026: Bookkeeping Services". A line
 *     already carried keeps the label it has.
 *
 * What is DROPPED from a carried line, on purpose:
 *   - `recurringId` and the covered-date fields. The window was billed for
 *     October and stays in October's ledger entry (a push does not release it);
 *     on November's invoice the line is just a charge whose label still names its
 *     dates. Leaving the id on would let November's ledger write, release or
 *     confirm October's window.
 *   - `employeeId` and `entryId`. Those tie a line to the hours panel's re-tag;
 *     October's line must not absorb, or lose, hours re-tagged in November.
 *   - `roleTier`. The carried block prints under its own heading, not under a role.
 * An empty hours row or a $0 plan line has nothing to tell anyone and is left behind.
 */
export function carriedLinesFromRolledInvoice(invoice) {
  const fromPeriod = invoice?.period
  if (!isRollPeriod(fromPeriod)) return []
  const label = getBillingPeriodLabel(fromPeriod)
  const out = []
  for (const line of Array.isArray(invoice?.lineItems) ? invoice.lineItems : []) {
    if (!line || !ROLL_FORWARD_KEPT_KINDS.has(line.kind)) continue
    if (isEmptyHoursLine(line) || isEmptyPlanLine(line)) continue
    const already = isCarriedLine(line)
    const carried = {
      kind: line.kind,
      label: already
        ? String(line.label ?? '')
        : `${label}: ${String(line.label ?? '').trim() || 'Charge'}`.slice(0, LABEL_MAX),
      detail: String(line.detail ?? ''),
      amount: round2(line.amount),
    }
    if (typeof line.hours === 'number') carried.hours = line.hours
    if (typeof line.rate === 'number') carried.rate = line.rate
    if (line.kind === 'hourly' && line.rateManual === true) carried.rateManual = true
    if (line.kind === 'adhoc') {
      carried.adhocMode = line.adhocMode ?? 'billed'
      carried.adhocAmount = round2(line.adhocAmount ?? line.amount)
    }
    if (line.kind === 'recurring' && line.section === 'software') carried.section = 'software'
    if (typeof line.sourceClientId === 'string' && line.sourceClientId) {
      carried.sourceClientId = line.sourceClientId
    }
    carried.carriedFromPeriod = already ? line.carriedFromPeriod : fromPeriod
    carried.carriedFromInvoiceId = invoice.id
    out.push(carried)
  }
  return out
}

/** The kinds the subtotal leaves out (db/store.js `recomputeInvoiceMoney`). */
const SUBTOTAL_EXCLUDED_KINDS = new Set(['adjustment', 'retainer_credit', 'account_credit'])

/**
 * `lines` with `carried` put in: any lines this same invoice carried before are
 * taken out first (so a repeat is idempotent), and the new block goes in front of
 * the first document-tail line (prepayment, credits, card fee, advance section),
 * else at the end. Pure; neither input is mutated.
 */
export function insertCarriedLines(lines, carried) {
  const list = Array.isArray(lines) ? lines : []
  const adding = Array.isArray(carried) ? carried : []
  const fromIds = new Set(adding.map((line) => line.carriedFromInvoiceId).filter(Boolean))
  const kept = list.filter((line) => !fromIds.has(line?.carriedFromInvoiceId))
  const at = kept.findIndex((line) => DOCUMENT_TAIL_KINDS.has(line?.kind))
  return at < 0 ? [...kept, ...adding] : [...kept.slice(0, at), ...adding, ...kept.slice(at)]
}

/** `lines` without the lines that the push of invoice `invoiceId` brought in. */
export function withoutCarriedLinesFrom(lines, invoiceId) {
  return (Array.isArray(lines) ? lines : []).filter((line) => line?.carriedFromInvoiceId !== invoiceId)
}

/** Subtotal and total from lines, by the store's one rule. */
export function moneyOfLines(lines) {
  const list = Array.isArray(lines) ? lines : []
  return {
    subtotal: round2(
      list.filter((line) => !SUBTOTAL_EXCLUDED_KINDS.has(line?.kind)).reduce((sum, line) => sum + (Number(line?.amount) || 0), 0),
    ),
    total: round2(list.reduce((sum, line) => sum + (Number(line?.amount) || 0), 0)),
  }
}

/**
 * A generated draft with the carried lines added: after the month's own lines and
 * its true-up, before the billing-period prepayment and credit on account are
 * worked out (the generator adds those afterwards, so they see the carried money).
 * Returns the SAME draft when there is nothing to carry.
 */
export function withCarriedLines(draft, carried) {
  if (!draft || !Array.isArray(carried) || carried.length === 0) return draft
  const lineItems = insertCarriedLines(draft.lineItems, carried)
  return { ...draft, lineItems, ...moneyOfLines(lineItems) }
}

/**
 * Does a line list still hold anything to bill? Used by Undo: a next-month draft
 * that held NOTHING but the carried lines (plus credits or an advance section) is
 * voided rather than left as an empty invoice.
 */
export function hasBillableContent(lines) {
  return (Array.isArray(lines) ? lines : []).some(
    (line) =>
      ROLL_FORWARD_KEPT_KINDS.has(line?.kind) &&
      !isEmptyHoursLine(line) &&
      !isEmptyPlanLine(line) &&
      !(line.kind === 'time_detail' && Math.round((Number(line.amount) || 0) * 100) === 0),
  )
}

/** The advance section a pushed invoice carried, or null. */
export function rolledAdvanceOffer(invoice) {
  const line = (Array.isArray(invoice?.lineItems) ? invoice.lineItems : []).find((row) => row?.kind === 'advance_request')
  return line?.advanceOffer?.requestId ? line.advanceOffer : null
}

const UNSENT = new Set(['draft', 'reviewed'])

/** The live (not void) monthly invoice among `invoices`, if any. */
function liveMonthly(invoices) {
  return (Array.isArray(invoices) ? invoices : []).find(
    (row) => (row?.kind ?? 'monthly') === 'monthly' && row.status !== 'void',
  )
}

/** A void monthly invoice among `invoices` that was itself pushed on, if any. */
function pushedOn(invoices) {
  return (Array.isArray(invoices) ? invoices : []).find(
    (row) => (row?.kind ?? 'monthly') === 'monthly' && row.status === 'void' && isRollPeriod(row.rolledIntoPeriod),
  )
}

const named = (invoice) => (invoice?.number ? ` (${invoice.number})` : '')

/**
 * Why this invoice cannot be pushed to next month, or null when it can.
 * `{ code, message }`: the code is for the route, the message is what she reads.
 *
 * @param {object} args
 * @param {object} args.invoice        the invoice to push
 * @param {object|null} args.client    its client
 * @param {Array}  args.nextInvoices   the client's MONTHLY invoices for the next month, void ones included
 * @param {boolean} [args.autopayActive] an automatic payment is claimed or in flight on it
 */
export function rollForwardRefusal({ invoice, client, nextInvoices = [], autopayActive = false }) {
  if (!invoice) return { code: 'not_found', message: 'That invoice was not found.' }
  if ((invoice.kind ?? 'monthly') !== 'monthly') {
    return { code: 'not_monthly', message: 'Only a monthly invoice can be pushed to next month.' }
  }
  if (invoice.status === 'void') {
    return isRollPeriod(invoice.rolledIntoPeriod)
      ? { code: 'already_rolled', message: `This invoice was already pushed: it is ${rolledIntoLabel(invoice.rolledIntoPeriod).toLowerCase()}.` }
      : { code: 'not_unsent', message: 'This invoice is voided, so there is nothing to push.' }
  }
  if (!UNSENT.has(invoice.status)) {
    return { code: 'not_unsent', message: 'Only a draft or reviewed invoice can be pushed to next month. This one has gone out.' }
  }
  if (invoice.sentAt) {
    return {
      code: 'sent_once',
      message: 'This invoice was already emailed to the client once, so it cannot be pushed. Void it instead if it should not be paid.',
    }
  }
  const to = nextPeriod(invoice.period)
  if (!to) return { code: 'bad_period', message: 'This invoice has no billing month to push from.' }
  if (
    normalizeBillingPeriodMonths(client?.billingPeriodMonths) > 1 ||
    (invoice.lineItems ?? []).some((line) => line?.kind === 'prepayment')
  ) {
    return {
      code: 'billing_period',
      message: 'Pushing an invoice to next month is not supported yet for clients billed for several months at a time.',
    }
  }
  if (hasUnconfirmedCoverage(invoice.lineItems)) {
    return { code: 'coverage_unconfirmed', message: 'Confirm the covered dates on this invoice first.' }
  }
  if (autopayActive) {
    return {
      code: 'autopay_in_flight',
      message: 'An automatic payment is in progress on this invoice, so it cannot be pushed.',
    }
  }
  const toLabel = getBillingPeriodLabel(to)
  const live = liveMonthly(nextInvoices)
  if (live && !UNSENT.has(live.status)) {
    return {
      code: 'next_invoice_sent',
      message: `${toLabel}'s invoice${named(live)} already went out, so this cannot be pushed onto it.`,
    }
  }
  // Emailed once and put back to draft: the client already holds a copy without
  // these lines, so adding to it would change a document they have.
  if (live && live.sentAt) {
    return {
      code: 'next_invoice_sent_once',
      message: `${toLabel}'s invoice${named(live)} was already emailed to the client once, so this cannot be pushed onto it.`,
    }
  }
  if (!live) {
    const later = pushedOn(nextInvoices)
    if (later) {
      return {
        code: 'next_invoice_rolled',
        message: `${toLabel}'s invoice was itself pushed to ${getBillingPeriodLabel(later.rolledIntoPeriod)}. Undo that push first.`,
      }
    }
  }
  return null
}

/**
 * Why this client's invoice could not be built again, or null when it can. The
 * generator's own client skips (db/store.js `generateInvoicesForPeriod`), in
 * words: an undo that clears the push but cannot rebuild the month would leave
 * the work billed nowhere.
 */
export function clientUnbillableReason(client) {
  if (!client) return 'This client is no longer on file.'
  const name = String(client.name ?? '').trim() || 'This client'
  if (client.platformInvoicingOptOut === true) return `${name} is invoiced outside the app.`
  if (isInactiveClientStage(client.lifecycleStage)) return `${name} is inactive.`
  if ((client.lifecycleStage ?? 'active') !== 'active') return `${name} is not an active client yet.`
  if (typeof client.billToClientId === 'string' && client.billToClientId) {
    return `${name} is billed on another client's invoice.`
  }
  return null
}

/**
 * The lines an UNDO rebuilds the pushed month's invoice from: the pushed
 * invoice's own lines exactly as she left them (stamps intact, including lines
 * that had been carried into it from an earlier push), minus only the kinds a
 * push drops - the advance section, credits, a prepayment and a card fee are
 * re-derived on the rebuilt draft, never copied.
 */
export function rebuiltLinesFromRolledInvoice(invoice) {
  return (Array.isArray(invoice?.lineItems) ? invoice.lineItems : [])
    .filter((line) => line && ROLL_FORWARD_KEPT_KINDS.has(line.kind))
    .map((line) => ({ ...line }))
}

/**
 * Why a push cannot be undone, or null when it can.
 *
 * @param {object} args
 * @param {object} args.invoice         the pushed (void + rolledIntoPeriod) invoice
 * @param {Array}  args.nextInvoices    the client's MONTHLY invoices for the month it was pushed into
 * @param {Array}  [args.periodInvoices] the client's MONTHLY invoices for the pushed invoice's own month
 */
export function rollUndoRefusal({ invoice, nextInvoices = [], periodInvoices = [], client }) {
  if (!invoice) return { code: 'not_found', message: 'That invoice was not found.' }
  if (invoice.status !== 'void' || !isRollPeriod(invoice.rolledIntoPeriod)) {
    return { code: 'not_rolled', message: 'This invoice was not pushed to another month.' }
  }
  // `client` omitted (undefined) skips this check; null means not on file.
  if (client !== undefined) {
    const unbillable = clientUnbillableReason(client)
    if (unbillable) {
      return {
        code: 'client_not_billable',
        message: `${unbillable} Its invoice could not be rebuilt, so the push cannot be undone.`,
      }
    }
  }
  const toLabel = getBillingPeriodLabel(invoice.rolledIntoPeriod)
  const live = liveMonthly(nextInvoices)
  if (live && !UNSENT.has(live.status)) {
    return {
      code: 'next_invoice_sent',
      message: `${toLabel}'s invoice${named(live)} already went out with these lines on it, so the push cannot be undone.`,
    }
  }
  if (live && live.sentAt) {
    return {
      code: 'next_invoice_sent_once',
      message: `${toLabel}'s invoice${named(live)} was already emailed to the client once with these lines on it, so the push cannot be undone.`,
    }
  }
  if (!live) {
    const later = pushedOn(nextInvoices)
    if (later) {
      return {
        code: 'next_invoice_rolled',
        message: `${toLabel}'s invoice was pushed on to ${getBillingPeriodLabel(later.rolledIntoPeriod)}. Undo that push first.`,
      }
    }
  }
  if (live && (live.lineItems ?? []).some((line) => line?.kind === 'account_credit' || line?.kind === 'retainer_credit')) {
    return {
      code: 'next_invoice_credit',
      message: `${toLabel}'s invoice has a credit applied. Take the credit off that invoice first, then undo the push.`,
    }
  }
  const own = liveMonthly(periodInvoices.filter((row) => row?.id !== invoice.id))
  if (own) {
    return {
      code: 'period_has_invoice',
      message: `${getBillingPeriodLabel(invoice.period)} already has a live invoice${named(own)} for this client.`,
    }
  }
  return null
}

/**
 * The confirm sheet's words, in her terms. `advance` is the pushed invoice's
 * advance section (`rolledAdvanceOffer`), or null.
 */
export function rollForwardConfirmText(invoice, advance = rolledAdvanceOffer(invoice)) {
  const from = getBillingPeriodLabel(invoice.period)
  const toPeriod = nextPeriod(invoice.period)
  const to = toPeriod ? getBillingPeriodLabel(toPeriod) : 'next month'
  const toMonth = to.split(' ')[0]
  const sentences = [
    `Everything on this ${from} invoice moves onto ${to}'s invoice as its own lines, listed as ${from.split(' ')[0]} work.`,
    `This invoice closes as rolled into ${toMonth}.`,
    `You can push again from ${toMonth} if it is still too small.`,
  ]
  if (advance) {
    const name = advance.number ? `The advance request ${advance.number}` : 'The advance request'
    sentences.push(
      advance.collection === 'invoice'
        ? `${name} on this invoice moves with it and is collected on ${to}'s payment link.`
        : `${name} stays on its own payment page. Attach it to ${to}'s invoice again if you want it shown there.`,
    )
  }
  return sentences.join(' ')
}
