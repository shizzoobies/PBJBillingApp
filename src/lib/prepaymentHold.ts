import { ApiError } from './types'

/**
 * The billing-period send guard's question, read off a failed request.
 *
 * The server answers 409 `prepayment_unpaid` when a later month of a billing-period
 * client would go out while its prepayment is unpaid, still clearing, or paid but not
 * applied to this invoice. Send (the month run and the lower Email view) and Mark
 * reviewed on a never-email client all ask the same question, so the reading of the
 * answer lives here once. Only the 'unpaid' reason may be overridden; the sentence is
 * always the server's own.
 *
 * @returns null when the error is anything else
 */
export function prepaymentHoldOf(error: unknown): { message: string; canOverride: boolean } | null {
  if (!(error instanceof ApiError) || error.code !== 'prepayment_unpaid') return null
  return { message: error.message, canOverride: canOverridePrepayment(error.reason) }
}

/** The one rule for "Send anyway": only the 'unpaid' hold may be overridden. */
export function canOverridePrepayment(reason: string | undefined): boolean {
  return reason === 'unpaid'
}
