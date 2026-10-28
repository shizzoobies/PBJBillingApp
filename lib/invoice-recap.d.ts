/**
 * Types for the shared invoice-recap definitions. The implementation is plain JS
 * so `server.js` can import it; these declarations let `src/` use the same
 * "sent", "reimbursed", "prepayment" and "credit" definitions instead of a second
 * TypeScript copy drifting away from them. Shapes are deliberately loose (the
 * `lib/invoice-lines.d.ts` convention): a `PersistedInvoice` satisfies them.
 */

export const RECAP_INVOICE_STATUSES: readonly string[]
export const REIMBURSED_LINE_KINDS: readonly string[]
export const PREPAYMENT_LINE_KIND: string
export const CREDIT_LINE_KINDS: readonly string[]

export interface InvoiceRecapSourceInvoice {
  id: string
  clientId: string
  kind?: string
  status: string
  total: number
  number?: string | null
  sentAt?: string | null
  paidAt?: string | null
  lineItems?: Array<{
    kind?: string
    label?: string
    detail?: string
    amount?: number
    period?: string
    sourceClientId?: string | null
  }>
}

export interface InvoiceRecapRowShape {
  invoiceId: string
  clientId: string
  clientName: string
  number: string | null
  status: string
  total: number
  sentAt: string | null
  paidAt: string | null
  reimbursedTotal: number
  prepaymentTotal: number
  creditTotal: number
  accountingTotal: number
}

export function buildInvoiceRecap(args: {
  invoices?: readonly InvoiceRecapSourceInvoice[]
  clients?: ReadonlyArray<{ id: string; name?: string }>
  visibleClientIds?: Set<string>
}): InvoiceRecapRowShape[]
