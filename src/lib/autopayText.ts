import type { AutopaySummary } from './types'
import { dateOnlyInZone } from '../../lib/firm-time.js'

/** The words the owner's autopay panel says (featreq-bef42b72). */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Oct 5, 2026", on the FIRM's day (an evening moment must not read as tomorrow). */
export function autopayDate(iso: string | null): string {
  if (!iso) return ''
  const day = dateOnlyInZone(new Date(iso))
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day ?? '')
  if (!match) return ''
  return `${MONTHS[Number(match[2]) - 1]} ${Number(match[3])}, ${match[1]}`
}

function methodWords(summary: AutopaySummary): string {
  const kind = summary.methodType === 'card' ? 'card' : 'bank account'
  const brand = summary.bankOrBrand ? ` (${summary.bankOrBrand})` : ''
  return summary.last4 ? `${kind} ending ${summary.last4}${brand}` : kind
}

/** The one sentence the panel says for each status. Exported so it can be tested. */
export function autopayStatusText(summary: AutopaySummary | null): string {
  switch (summary?.status) {
    case 'invited':
      return `Invited on ${autopayDate(summary.invitedAt)}. Waiting for the client to set up a bank account or card.`
    case 'pending_verification':
      return 'The client has started setting up. Their bank is verifying the account, which can take a day or two.'
    case 'enrolled': {
      const since = autopayDate(summary.consentedAt)
      return `Enrolled: ${methodWords(summary)}${since ? `, since ${since}` : ''}.`
    }
    case 'withdrawn':
      return `The client turned autopay off${summary.withdrawnAt ? ` on ${autopayDate(summary.withdrawnAt)}` : ''}.`
    case 'revoked':
      return 'Autopay was turned off because the bank refused a debit. The client needs to be invited again.'
    default:
      return 'Not enrolled.'
  }
}

/** The row badge: 'autopay' while a charge is claimed, in flight or collected, 'failed' once it failed. */
export function autopayAttemptBadge(
  attempt: { status: string } | null | undefined,
): 'autopay' | 'failed' | null {
  if (!attempt) return null
  if (attempt.status === 'failed') return 'failed'
  return attempt.status === 'claimed' || attempt.status === 'processing' || attempt.status === 'succeeded'
    ? 'autopay'
    : null
}

/**
 * Can the saved method be tried again? Not when the bank itself said the account
 * cannot be debited: those turn autopay off, and "Charge again" would only be
 * refused.
 */
export function autopayAttemptCanBeRepeated(attempt: { errorCode: string | null }): boolean {
  return !['debit_not_authorized', 'account_closed', 'no_account'].includes(attempt.errorCode ?? '')
}
