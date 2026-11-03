/**
 * Types for the plain-JS `lib/invoice-rollforward.js` ("Push to next month",
 * featreq-40697310), so the month-run editor reads the same rules and words the
 * store enforces.
 */
type LineLike = {
  kind?: string
  label?: string
  amount?: number
  carriedFromPeriod?: string
  carriedFromInvoiceId?: string
}
type InvoiceLike = {
  id?: string
  period?: string
  kind?: string
  status?: string
  number?: string | null
  sentAt?: string | null
  rolledIntoPeriod?: string | null
  lineItems?: readonly LineLike[]
}
type AdvanceOfferLike = { requestId: string; number?: string; collection?: string; optional?: boolean }

export type RollRefusal = { code: string; message: string }

export declare const ROLL_FORWARD_KEPT_KINDS: ReadonlySet<string>
export declare function isRollPeriod(value: unknown): value is string
export declare function nextPeriod(period: string): string | null
export declare function isCarriedLine(line: unknown): boolean
export declare function carriedForwardTitle(period: string): string
export declare function rolledIntoLabel(period: string): string
export declare function carriedLinesFromRolledInvoice(invoice: InvoiceLike): LineLike[]
export declare function insertCarriedLines<T>(lines: readonly T[], carried: readonly LineLike[]): T[]
export declare function withoutCarriedLinesFrom<T>(lines: readonly T[], invoiceId: string): T[]
export declare function moneyOfLines(lines: readonly LineLike[]): { subtotal: number; total: number }
export declare function hasBillableContent(lines: readonly LineLike[]): boolean
export declare function rolledAdvanceOffer(invoice: InvoiceLike): AdvanceOfferLike | null
export declare function rollForwardRefusal(args: {
  invoice: InvoiceLike | null
  client: { billingPeriodMonths?: number | null } | null
  nextInvoices?: readonly InvoiceLike[]
  autopayActive?: boolean
}): RollRefusal | null
export declare function rollUndoRefusal(args: {
  invoice: InvoiceLike | null
  nextInvoices?: readonly InvoiceLike[]
  periodInvoices?: readonly InvoiceLike[]
  /** Omit to skip the "can the client be billed again" check; null = not on file. */
  client?: ClientLike | null
}): RollRefusal | null
type ClientLike = {
  name?: string
  lifecycleStage?: string | null
  platformInvoicingOptOut?: boolean
  billToClientId?: string | null
}
export declare function clientUnbillableReason(client: ClientLike | null): string | null
export declare function rebuiltLinesFromRolledInvoice(invoice: InvoiceLike): LineLike[]
export declare function rollForwardConfirmText(invoice: InvoiceLike, advance?: AdvanceOfferLike | null): string
