export type AdvanceOffer = { requestId: string; number: string; requestedCents: number; receivedCents: number; outstandingCents: number; optional: boolean; collection?: 'invoice' | 'separate'; collectionMethod?: 'bank' | 'manual' | null; forPeriod: string | null; url: string; preparedAt: string; preparedBy: string | null }
type Invoice = { lineItems?: Array<{ kind?: string; advanceOffer?: AdvanceOffer }>; lines?: Array<{ kind?: string; advanceOffer?: AdvanceOffer }> }
export type LinkAdvance = { requestId: string; number: string; cents: number; optional: boolean }
export type AdvancePaymentSummary = { invoiceCents: number; advanceCents: number; feeCents: number; totalCents: number; advance: LinkAdvance | null }
export function invoiceAdvanceOffer(invoice: Invoice): AdvanceOffer | null
export function advanceOfferCollection(offer: AdvanceOffer | null | undefined): 'invoice' | 'separate'
export function advanceOfferText(invoice: Invoice, options?: { carried?: boolean; autopay?: boolean; card?: boolean; settlement?: { advanceCents: number | null; pending?: boolean } | null }): string[]
export function linkAdvanceFor(advance: LinkAdvance | null | undefined, channel: 'ach' | 'card'): LinkAdvance | null
export function advancePaymentSummary(args: { total: number; advance?: LinkAdvance | null; channel?: 'ach' | 'card' }): AdvancePaymentSummary
export function advancePaymentRows(summary: AdvancePaymentSummary): Array<[string, string]>
