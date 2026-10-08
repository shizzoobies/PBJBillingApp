/**
 * Types for `lib/payment-amount-mismatch.js` - the rule that notices a Stripe
 * payment for a different amount than the invoice total, and the shared reader
 * for the marker the store writes for it.
 */

export declare const AMOUNT_MISMATCH_EVENT: 'amount-mismatch'
export declare const AMOUNT_MISMATCH_HANDLED_EVENT: 'amount-mismatch-handled'
export declare const PAYMENT_ON_VOIDED_EVENT: 'on-voided'
export declare const DUPLICATE_PAYMENT_REASON: 'duplicate'
export declare const CREDIT_REVERSAL_EVENT: 'credit-reversal'
export declare const PAYMENT_REVERSAL_EVENT_TYPES: readonly [
  'charge.refunded',
  'charge.dispute.created',
  'charge.dispute.closed',
]

/**
 * The `email_log` entry the webhook appends; `kind: 'payment'`. `reason` is
 * 'duplicate' for a second payment on an already-paid invoice (then
 * `receivedCents` may be null) and absent for the "different amount" kind.
 */
export interface AmountMismatchLogEntry {
  kind: 'payment'
  event: 'amount-mismatch'
  at: string
  paymentIntentId: string | null
  expectedCents: number
  receivedCents: number | null
  reason?: 'duplicate'
  /** A duplicate bank payment that was only started, not settled. */
  settling?: true
  /** A duplicate paid by card (its processing fee came with it). */
  card?: true
}

/** Money that arrived for a VOIDED invoice. Log-only; `amount` is dollars. */
export interface PaymentOnVoidedLogEntry {
  kind: 'payment'
  event: 'on-voided'
  at: string
  paymentIntentId: string | null
  amount: number | null
  detail: string
}

/**
 * A refund or dispute on the payment a credit on account came from, written by the
 * Stripe webhook on the invoice that carried the payment. Log only; `cents` is the
 * refunded or disputed amount (null when Stripe did not say).
 */
export interface CreditReversalLogEntry {
  kind: 'payment'
  event: 'credit-reversal'
  at: string
  paymentIntentId: string
  creditId: string
  noticeKind: 'refund' | 'dispute' | 'dispute-closed'
  cents: number | null
  reason: string
  eventId: string | null
  /** A refund of less than the charge; `chargeCents` is the whole charge. */
  partial?: true
  chargeCents?: number | null
  /** A closed dispute's result from Stripe (won, lost, ...). */
  status?: string
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

export interface UnhandledAmountMismatch {
  expectedCents: number
  /** Null only for a duplicate payment whose amount Stripe did not report. */
  receivedCents: number | null
  at: string | null
  paymentIntentId: string | null
  reason: 'amount' | 'duplicate'
  /** A duplicate bank payment that has only been started (it can still fail). */
  settling: boolean
  /** A duplicate paid by card (its processing fee came with it). */
  card: boolean
  /** How many payments on the invoice are waiting; this describes the newest. */
  count: number
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
  /** More than one waiting: the notice says how many. */
  unhandledCount?: number
}): string

export declare function unhandledCountSentence(count: number | undefined): string

/** `/invoices?period=YYYY-MM` for the invoice's month, else `/invoices`. */
export declare function invoicePeriodLink(
  invoice: { period?: string | null } | null | undefined,
): string

export declare function duplicatePaymentOwnerMessage(args: {
  number: string
  clientName: string
  receivedCents: number | null
  unhandledCount?: number
  settling?: boolean
}): string

export declare function duplicateFailedOwnerMessage(args: {
  number: string
  clientName: string
  detail?: string
}): string

export declare function paymentOnVoidedOwnerMessage(args: {
  number: string
  clientName: string
  receivedCents: number | null
  settling?: boolean
}): string

/** A failed second bank payment clears its duplicate marker and tells the owners. */
export declare function clearDuplicatePaymentOnFailure(args: {
  store: {
    recordInvoicePaymentFailure(
      invoiceId: string,
      entry: { at: string; paymentIntentId: string; detail: string },
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
  invoice: {
    id: string
    status?: string
    number?: string | null
    clientId: string
    period?: string
    emailLog?: ReadonlyArray<unknown> | null
  } | null
  appPublicUrl?: string
}): Promise<void>

export declare function flagPaymentAmountMismatch(args: {
  store: {
    recordInvoiceAmountMismatch(
      invoiceId: string,
      entry: {
        at: string
        paymentIntentId: string | null
        expectedCents: number
        receivedCents: number | null
        reason?: 'duplicate'
        settling?: boolean
        card?: boolean
      },
    ): Promise<unknown>
    /** A settled bank duplicate: its marker stops saying "settling". Optional. */
    settleDuplicatePaymentMarker?(invoiceId: string, paymentIntentId: string): Promise<unknown>
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
  invoice: {
    id: string
    number?: string | null
    clientId: string
    total: number
    period?: string
  } | null
  appPublicUrl?: string
}): Promise<void>

/** Is a double payment for this PaymentIntent on the log, handled or not? */
export declare function duplicatePaymentLogged(
  emailLog: ReadonlyArray<unknown> | null | undefined,
  paymentIntentId: string | null | undefined,
): boolean

/** What Stripe says about a PaymentIntent, as `retrievePaymentIntentFacts` answers it. */
export interface PaymentIntentFacts {
  status: string
  amountReceived: number | null
  /** Cents refunded on the latest charge; null when Stripe did not say. */
  amountRefunded: number | null
  /** Null when Stripe did not say. */
  disputed: boolean | null
  /** 'card' for a card Checkout, null for a bank one. */
  channel: string | null
  currency: string | null
  invoiceId: string | null
}

export type OverpaymentCreditPlan =
  | { ok: true; cents: number }
  | { ok: false; status: number; code: string; message: string }

/** The amount a card Checkout adds its fee to: the invoice total without any card-fee line. */
export declare function owedBeforeCardFee(
  invoice: { total?: number | null; lineItems?: ReadonlyArray<{ kind?: string; amount?: number }> } | null | undefined,
): number

/** What of a double payment reached the firm: the card fee comes off a card payment. */
export declare function defaultOverpaymentCredit(args: {
  receivedCents: number
  card: boolean
  invoice: { total?: number | null; lineItems?: ReadonlyArray<{ kind?: string; amount?: number }> } | null | undefined
}): { creditCents: number; feeCents: number }

/** May this double payment become a credit on account, and for how many cents? */
export declare function planOverpaymentCredit(args: {
  invoice:
    | {
        id: string
        total?: number | null
        lineItems?: ReadonlyArray<{ kind?: string; amount?: number }>
        emailLog?: ReadonlyArray<unknown> | null
      }
    | null
    | undefined
  paymentIntentId: unknown
  intent: PaymentIntentFacts | null
  /** Dollars; lower than what was received, or absent for all of it. */
  requestedAmount?: unknown
}): OverpaymentCreditPlan

/** A Stripe `charge.refunded` or `charge.dispute.created` event. */
export declare function isPaymentReversalEvent(event: { type?: string } | null | undefined): boolean

export interface PaymentReversal {
  kind: 'refund' | 'dispute' | 'dispute-closed'
  paymentIntentId: string | null
  cents: number | null
  /** The whole charge in cents (a refund only); null when Stripe did not say. */
  chargeCents: number | null
  reason: string
  /** A closed dispute's result (won, lost, ...); empty otherwise. */
  status: string
  /** A refund that has not returned the whole charge. */
  partial: boolean
  at: string
}

export declare function paymentReversalOf(event: unknown): PaymentReversal

/** A dispute outcome that leaves the money where it was: won, or `warning_closed`. */
export declare function disputeReleased(status: string | null | undefined): boolean

/**
 * Whether a payment's credit-reversal log entries (one PaymentIntent) hold its credit
 * on account: any refund holds it for good; otherwise a dispute holds it unless the
 * latest one closed as won / warning_closed.
 */
export declare function creditReversalHolds(entries: ReadonlyArray<unknown> | null | undefined): {
  refunded: boolean
  holds: boolean
}

/** What the owners are told when the payment a credit came from was refunded or disputed. */
export declare function creditReversalOwnerMessage(args: {
  clientName: string
  credit: { amount: number; draws?: ReadonlyArray<{ amount: number }>; voidedAt?: string | null }
  reversal: Pick<PaymentReversal, 'kind' | 'cents' | 'reason' | 'partial'> &
    Partial<Pick<PaymentReversal, 'chargeCents' | 'status'>>
  /** The payment was also REFUNDED: a won dispute no longer returns the credit to normal. */
  refunded?: boolean
}): string

/** What the owners are told when an ordinary paid invoice's payment was refunded or disputed. */
export declare function invoiceReversalOwnerMessage(args: {
  clientName: string
  number: string
  reversal: Pick<PaymentReversal, 'kind' | 'cents' | 'reason' | 'partial'> &
    Partial<Pick<PaymentReversal, 'chargeCents' | 'status'>>
}): string

/**
 * The webhook's step for `charge.refunded` / `charge.dispute.created`: notices
 * only, never a void. Store reads and the notice write may throw; the owners'
 * notification never does.
 */
export declare function flagPaymentReversal(args: {
  store: {
    findOverpaymentCredit(paymentIntentId: string): Promise<{ id: string; clientId: string } | null>
    listAccountCredits(
      clientId: string,
    ): Promise<
      Array<{
        id: string
        clientId: string
        amount: number
        draws?: ReadonlyArray<{ amount: number }>
        voidedAt?: string | null
      }>
    >
    recordAccountCreditNotice(
      creditId: string,
      notice: {
        kind: 'refund' | 'dispute' | 'dispute-closed'
        at: string
        cents: number | null
        reason: string
        eventId: string | null
        partial?: boolean
        chargeCents?: number | null
        status?: string
      },
    ): Promise<{ stored: boolean; duplicate: boolean; refunded: boolean } | null>
    findInvoiceByStripeRef(ref: {
      paymentIntentId: string
    }): Promise<{ id: string; status: string; number?: string | null; clientId: string; period?: string } | null>
    getClientNameById(clientId: string): Promise<string | null | undefined>
    getTeamMembers(): Promise<Array<{ id: string; role: string }>>
  }
  notify: (
    store: never,
    userId: string,
    kind: string,
    payload: Record<string, unknown>,
  ) => Promise<unknown>
  event: { id?: string; type: string; created?: number; data?: { object?: unknown } }
  appPublicUrl?: string
}): Promise<{ matched: boolean; notified: boolean }>

/** A second payment on an already-paid invoice: logged as unhandled, owners told once. */
export declare const flagDuplicatePayment: typeof flagPaymentAmountMismatch

/** Money for a voided invoice: logged (`on-voided`), owners told once. */
export declare function flagPaymentOnVoidedInvoice(args: {
  store: {
    recordInvoicePaymentOnVoided(
      invoiceId: string,
      entry: {
        at: string
        paymentIntentId: string | null
        amount: number | null
        detail: string
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
  invoice: { id: string } | null
  getInvoice: (
    id: string,
  ) => Promise<
    { id: string; status: string; number?: string | null; clientId: string; period?: string } | null | undefined
  >
  appPublicUrl?: string
}): Promise<void>
