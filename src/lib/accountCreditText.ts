import type { AccountCredit } from './types'

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

/** Where a credit came from, in the words the ledger shows. */
export function accountCreditSourceText(credit: AccountCredit): string {
  if (credit.sourceKind === 'overpayment') return 'Overpayment'
  return 'Manual credit'
}
