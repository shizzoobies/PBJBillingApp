/** Types for the plain-JS `lib/invoice-estimate.js` (the SPA shares its client rule and "left to invoice" test). */

export interface InvoiceEstimateRow {
  clientId: string
  clientName: string
  /** 'sent': the invoice as stored. 'projected': the Client Recap projection. 'too_early': nothing usable yet. */
  basis: 'sent' | 'projected' | 'too_early'
  /** A word for the basis ("estimate", "service so far", "plan", "no rates", "too early"...); null on a sent row. */
  detail: string | null
  /** Null when the estimate is unusable (never a made-up $0.00). */
  service: number | null
  reimburse: number
  /** Null when there is nothing to quote. */
  total: number | null
  invoiceNumber?: string | null
}

export interface InvoiceEstimate {
  period: string
  monthTotal: number
  serviceTotal: number
  reimburseTotal: number
  clients: InvoiceEstimateRow[]
}

export function isInvoiceRunClient(client: {
  lifecycleStage?: string | null
  platformInvoicingOptOut?: boolean
  billToClientId?: string | null
}): boolean

export function buildInvoiceEstimate(args: {
  period: string
  data: Record<string, unknown>
  invoices?: readonly unknown[]
  billRateVersions?: readonly unknown[]
  today: string
}): InvoiceEstimate

export function clientsLeftToInvoice(
  rows: readonly InvoiceEstimateRow[],
): Array<{ id: string; name: string }>
