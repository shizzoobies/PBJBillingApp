/**
 * Types for the plain-JS `lib/billing-period.js` (a subscription client who pays
 * every N months). Keep in step with the exports there.
 */

export declare const BILLING_PERIOD_MAX_MONTHS: number

type PeriodClient = {
  billingMode?: string
  monthlyRate?: number | null
  billingPeriodMonths?: number | null
  periodAnchorMonth?: string | null
  isBillingMaster?: boolean | null
  billToClientId?: string | null
}

export declare function normalizeBillingPeriodMonths(value: unknown): number
export declare function normalizePeriodAnchorMonth(value: unknown): string | null
export declare function validateBillingPeriod(args: {
  months: unknown
  anchor: unknown
}): { ok: true } | { ok: false; message: string }
export declare function hasBillingPeriod(client: PeriodClient | null | undefined): boolean
export declare function periodAnchorFor(client: PeriodClient | null | undefined, period: string): string | null
export declare function prepaymentMonthsFor(client: PeriodClient | null | undefined, period: string): string[]
export declare function prepaymentLabel(period: string): string
export declare function prepaymentLines(
  client: PeriodClient | null | undefined,
  period: string,
): Array<{ kind: 'prepayment'; label: string; detail: string; amount: number; period: string }>
export declare function unpaidPrepaymentFor(args: {
  client: PeriodClient & { id: string }
  invoice:
    | {
        kind?: string
        status?: string
        period: string
        total?: number | null
        lineItems?: Array<{ kind?: string; draws?: Array<{ creditId?: string }> }>
      }
    | null
    | undefined
  invoices: Array<{
    clientId?: string
    kind?: string
    status?: string
    period?: string
    id: string
    number?: string | null
    lineItems?: Array<{ kind?: string; period?: string }>
  }>
  credits?: Array<{ id: string; remaining?: number }>
}): {
  month: string
  anchorPeriod: string
  reason: 'unpaid' | 'processing' | 'not_applied'
  anchorInvoice: { id: string; number: string | null; status: string }
  message: string
} | null
export declare function nextPrepaymentMonth(client: PeriodClient | null | undefined, fromPeriod: string): string | null
export declare function billingPeriodSentence(args: { months: unknown; anchor: unknown; today: string }): string
