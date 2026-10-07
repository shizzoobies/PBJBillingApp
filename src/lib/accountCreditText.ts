import type { AccountCredit, AccountCreditDraw } from './types'

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
