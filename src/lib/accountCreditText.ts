import type { AccountCredit, AccountCreditDraw, PersistedInvoice } from './types'

/** "November 2026" from a YYYY-MM. */
export function accountCreditMonth(period: string): string {
  const [year, month] = period.split('-').map(Number)
  if (!year || !month) return period
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/** One draw on a credit, as the ledger says it: "$200.00 on INV-2026-10-004 (October 2026)". */
export function accountCreditDrawText(draw: AccountCreditDraw): string {
  const dollars = draw.amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
  const invoice = draw.invoiceNumber ?? 'a draft invoice'
  return `${dollars} on ${invoice}${draw.period ? ` (${accountCreditMonth(draw.period)})` : ''}`
}

/** Where a credit came from, in the words the ledger shows. */
export function accountCreditSourceText(credit: AccountCredit): string {
  if (credit.sourceKind === 'overpayment') return 'Overpayment'
  // Derived from a paid invoice; the note already names it ("Prepayment on INV-2026-10-001").
  if (credit.sourceKind === 'prepayment') return credit.note || 'Prepayment'
  return 'Manual credit'
}

/**
 * The ledger line for a credit whose payment was refunded or disputed in Stripe:
 * "Refunded in Stripe on Oct 8, 2026 ($412.50)" / "Disputed in Stripe on ... ($412.50,
 * reason fraudulent)". `date` is the already-formatted day. Empty for a credit with no notice.
 */
export function accountCreditReversalText(credit: AccountCredit, date: string): string {
  const reversal = credit.reversal
  if (!reversal) return ''
  const money = (value: number) => value.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
  const dollars = reversal.amount === null ? '' : money(reversal.amount)
  const why = reversal.reason.replace(/_/g, ' ')
  if (reversal.kind === 'dispute-closed') {
    return `Dispute closed (${(reversal.status ?? '').replace(/_/g, ' ') || 'no result given'}) on ${date}`
  }
  if (reversal.kind === 'dispute') {
    const detail = [dollars, why ? `reason ${why}` : ''].filter(Boolean).join(', ')
    return `Disputed in Stripe on ${date}${detail ? ` (${detail})` : ''}`
  }
  if (reversal.partial) {
    const whole = reversal.chargeAmount == null ? '' : ` of ${money(reversal.chargeAmount)}`
    return `Partly refunded in Stripe on ${date}${dollars ? ` (${dollars}${whole})` : ''}`
  }
  return `Refunded in Stripe on ${date}${dollars ? ` (${dollars})` : ''}`
}

/**
 * The tooltip on a noticed credit's Void button. A used credit that holds is left
 * to be sorted out by hand (its Void is disabled); an unspent one says why Void is
 * on offer, and never claims a part-refunded payment was refunded whole. A won
 * dispute is a normal credit again (no tooltip).
 */
export function accountCreditVoidTitle(credit: AccountCredit): string | undefined {
  const reversal = credit.reversal
  if (!reversal) return undefined
  if (reversal.holds && credit.draws.length > 0) {
    return `${credit.remaining > 0 ? 'Partly' : 'Fully'} used - sort it out by hand`
  }
  if (reversal.kind === 'dispute-closed') {
    if (!reversal.holds) return undefined
    return reversal.status === 'lost'
      ? 'Void this credit - the dispute was lost'
      : 'Void this credit - the dispute was closed'
  }
  if (reversal.kind === 'dispute') return 'Void this credit - its payment was disputed'
  if (reversal.partial) return 'Void this credit - only part of its payment was refunded'
  return 'Void this credit - its payment was refunded'
}

/**
 * What a build says about credit on account (stage 1c): the month run draws it onto
 * each new monthly draft by itself, so the note after Generate, a one-client
 * generate and Void & regenerate adds " Credit on account applied: $X on 1 invoice."
 * Read off the credit lines of the invoices the server returned, in whole cents, so
 * the figure she is told is the figure stored. Empty when no new draft drew any.
 */
export function generatedCreditNote(
  created: readonly PersistedInvoice[],
  /** Clients whose voided drafts already held credit: when every draw is theirs it reads "carried over". */
  carriedOverClientIds?: ReadonlySet<string>,
): string {
  let cents = 0
  let invoices = 0
  let allCarried = true
  for (const invoice of created) {
    const drawn = invoice.lineItems
      .filter((line) => line.kind === 'account_credit')
      .reduce((sum, line) => sum + Math.round(Math.abs(Number(line.amount) || 0) * 100), 0)
    if (drawn > 0) {
      cents += drawn
      invoices += 1
      if (!carriedOverClientIds?.has(invoice.clientId)) allCarried = false
    }
  }
  if (cents === 0) return ''
  const dollars = (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
  return ` Credit on account ${carriedOverClientIds && allCarried ? 'carried over' : 'applied'}: ${dollars} ${invoices === 1 ? 'on 1 invoice' : `across ${invoices} invoices`}.`
}
