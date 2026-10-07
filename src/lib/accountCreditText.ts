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
  if (credit.sourceKind === 'prepayment') {
    // A prepayment names the month it covers: on the row itself, or as the tail
    // of its source (prepay:<invoice>:<YYYY-MM>).
    const covered = credit.forPeriod ?? /(\d{4}-\d{2})$/.exec(credit.sourceRef)?.[1] ?? null
    return covered ? `Prepayment for ${accountCreditMonth(covered)}` : 'Prepayment'
  }
  return 'Manual credit'
}
