export type AdvanceOffer = { requestId: string; number: string; requestedCents: number; receivedCents: number; outstandingCents: number; optional: boolean; forPeriod: string | null; url: string; preparedAt: string; preparedBy: string | null }
type Invoice = { lineItems?: Array<{ kind?: string; advanceOffer?: AdvanceOffer }>; lines?: Array<{ kind?: string; advanceOffer?: AdvanceOffer }> }
export function invoiceAdvanceOffer(invoice: Invoice): AdvanceOffer | null
export function advanceOfferText(invoice: Invoice): string[]
