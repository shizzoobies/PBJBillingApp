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
  return 'Manual credit'
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
