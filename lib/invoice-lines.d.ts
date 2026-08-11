/**
 * Types for the shared invoice line builder. Implementation is plain JS so the
 * server generator can import it; this lets the React side use it too.
 */

/** What produced this line — the persisted invoice stores it, and Client Recap
 *  uses it to separate service revenue from reimbursements. */
export type InvoiceLineKind = 'plan' | 'hourly' | 'reimbursement' | 'recurring'

export type InvoiceLineOut = {
  kind: InvoiceLineKind
  label: string
  detail: string
  amount: number
}

export type BuildInvoiceLinesResult = {
  lines: InvoiceLineOut[]
  total: number
  billableMinutes: number
  entryCount: number
  plan: unknown
  periodLabel: string
}

/** Structural inputs — deliberately loose so both the TS and JS callers fit. */
export type BuildInvoiceLinesArgs = {
  client: {
    id: string
    planIds?: string[]
    billingMode?: string
    hourlyRate?: number
    monthlyRate?: number
    annualRate?: number
    annualBillingMonth?: number | string
    monthlyServiceTier?: string
  }
  entries?: Array<{
    clientId?: string
    employeeId?: string
    billable?: boolean
    minutes: number
    date?: string
  }>
  plans?: Array<{ id: string; name: string }>
  billingPeriod: string
  reimbursements?: Array<{ clientId: string; date: string; description: string; amount: number }>
  recurringReimbursements?: Array<{
    clientId: string
    description: string
    amount: number
    frequency: string
    startDate: string
  }>
  employees?: Array<{ id: string; name?: string; billRate?: number | null }>
  defaultHourlyRate?: number
}

export const PER_EMPLOYEE_BILLING_START: string
export const MONTH_NAMES: string[]
export const currency: Intl.NumberFormat

export function formatHours(minutes: number): string
export function normalizeBillingMonth(value: unknown): number
export function getBillingPeriodLabel(period: string): string
export function isInBillingPeriod(entry: { date?: string }, period: string): boolean
export function recurringReimbursementAppliesToPeriod(
  recurring: { startDate?: string; frequency?: string },
  period: string,
): boolean
export function buildInvoiceLines(args: BuildInvoiceLinesArgs): BuildInvoiceLinesResult

export const STRIPE_CARD_PERCENT: number
export const STRIPE_CARD_FIXED: number
export const CARD_PROCESSING_FEE_LABEL: string
export function cardProcessingFee(total: number): number
export function cardChargedTotal(total: number): number
export function cardProcessingFeeLine(invoice: { total?: number }): {
  kind: 'card-fee'
  label: string
  detail: string
  amount: number
}
