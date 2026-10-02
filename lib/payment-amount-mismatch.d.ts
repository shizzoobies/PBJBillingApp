/**
 * Types for `lib/payment-amount-mismatch.js` - the rule that notices a Stripe
 * payment for a different amount than the invoice total, and the shared reader
 * for the marker the store writes for it.
 */

export declare const AMOUNT_MISMATCH_EVENT: 'amount-mismatch'
export declare const AMOUNT_MISMATCH_HANDLED_EVENT: 'amount-mismatch-handled'

/** The `email_log` entry the webhook appends; `kind: 'payment'`. */
export interface AmountMismatchLogEntry {
  kind: 'payment'
  event: 'amount-mismatch'
  at: string
  paymentIntentId: string | null
  expectedCents: number
  receivedCents: number
}

/** The entry an owner's "Mark as handled" appends. */
export interface AmountMismatchHandledLogEntry {
  kind: 'payment'
  event: 'amount-mismatch-handled'
  at: string
  by: string | null
  paymentIntentId: string | null
}

export interface AmountMismatch {
  expectedCents: number
  receivedCents: number
}

export interface UnhandledAmountMismatch extends AmountMismatch {
  at: string | null
  paymentIntentId: string | null
}

export declare function receivedPaymentCents(
  eventType: string | undefined,
  object: unknown,
): number | null

export declare function paymentAmountMismatch(args: {
  eventType: string | undefined
  object: unknown
  invoice: { total?: number | null } | null | undefined
}): AmountMismatch | null

export declare function paymentIntentIdOf(
  eventType: string | undefined,
  object: unknown,
): string | null

export declare function unhandledAmountMismatches(
  emailLog: ReadonlyArray<unknown> | null | undefined,
): AmountMismatchLogEntry[]

export declare function unhandledAmountMismatch(
  invoice: { emailLog?: ReadonlyArray<unknown> | null } | null | undefined,
): UnhandledAmountMismatch | null

/** A bank payment that has not settled yet (status processing, no card fee line). */
export declare function paymentInProgress(
  invoice: { status?: string; lineItems?: ReadonlyArray<{ kind?: string }> } | null | undefined,
): boolean

export declare function amountMismatchOwnerMessage(args: {
  number: string
  clientName: string
  expectedCents: number
  receivedCents: number
  /** The payment has not settled: say so instead of "recorded as paid". */
  inProgress?: boolean
}): string

export declare function flagPaymentAmountMismatch(args: {
  store: {
    recordInvoiceAmountMismatch(
      invoiceId: string,
      entry: {
        at: string
        paymentIntentId: string | null
        expectedCents: number
        receivedCents: number
      },
    ): Promise<unknown>
    getClientNameById(clientId: string): Promise<string | null | undefined>
    getTeamMembers(): Promise<Array<{ id: string; role: string }>>
  }
  notify: (
    store: never,
    userId: string,
    kind: string,
    payload: Record<string, unknown>,
  ) => Promise<unknown>
  event: { type: string; created?: number; data?: { object?: unknown } }
  invoice: { id: string; number?: string | null; clientId: string; total: number } | null
  appPublicUrl?: string
}): Promise<void>
