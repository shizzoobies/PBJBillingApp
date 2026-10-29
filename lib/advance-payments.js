// Advance requests are not service invoices. Only settled receipt rows create credit.
export class AdvancePaymentError extends Error {}
export const advanceCents = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1_000_000) throw new AdvancePaymentError('Enter an amount above $0 and no more than $1,000,000.')
  const cents = Math.round(value * 100)
  if (cents < 1) throw new AdvancePaymentError('Enter at least $0.01.')
  return cents
}
export function advanceRequest({ id, clientId, amount, note = '', actorUserId = null, collectionMethod = null, forPeriod = null, publicToken = null }, at) {
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(id ?? '')) throw new AdvancePaymentError('A request identifier is required.')
  if (collectionMethod !== null && !['bank', 'manual'].includes(collectionMethod)) throw new AdvancePaymentError('Choose bank payment or payment outside the app.')
  if (forPeriod !== null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(forPeriod)) throw new AdvancePaymentError('Choose a real billing month or general credit.')
  return { id, clientId, number: `ADV-${at.slice(0, 4)}-${id.slice(0, 8).toUpperCase()}`, requestedCents: advanceCents(amount), note: String(note).trim().slice(0, 500), collectionMethod, forPeriod, publicToken, createdAt: at, createdBy: actorUserId, canceledAt: null }
}
export function billingDefaults(input, actorUserId, at) {
  const { id, clientId, effectivePeriod, advanceAmount = null, collectionMethod = null, allocation = null, balanceDisplay = null } = input
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(id ?? '') || !clientId || !/^\d{4}-(0[1-9]|1[0-2])$/.test(effectivePeriod ?? '')) throw new AdvancePaymentError('Choose a client and effective billing month.')
  if (advanceAmount !== null) advanceCents(advanceAmount)
  if (collectionMethod !== null && !['bank', 'manual'].includes(collectionMethod)) throw new AdvancePaymentError('Choose a collection method or leave it unset.')
  if (allocation !== null && !['general', 'month'].includes(allocation)) throw new AdvancePaymentError('Choose general or month-reserved credit, or leave it unset.')
  if (balanceDisplay !== null && !['summary', 'detailed'].includes(balanceDisplay)) throw new AdvancePaymentError('Choose a balance display or leave it unset.')
  return { id, clientId, effectivePeriod, advanceAmount, collectionMethod, allocation, balanceDisplay, createdAt: at, createdBy: actorUserId }
}
export function billingDefaultsAt(rows, period) {
  return rows.filter((row) => row.effectivePeriod <= period).sort((a, b) => a.effectivePeriod.localeCompare(b.effectivePeriod) || a.createdAt.localeCompare(b.createdAt)).at(-1) ?? null
}
export function advanceSummary(request, receipts) {
  const receivedCents = receipts.filter((row) => row.requestId === request.id).reduce((sum, row) => sum + row.cents, 0)
  return { ...request, receivedCents, outstandingCents: request.canceledAt ? 0 : Math.max(0, request.requestedCents - receivedCents) }
}
export function advanceReceipt({ requestId, sourceRef, amount, receivedOn, method, actorUserId = null }, request, today, at) {
  if (!request || request.id !== requestId) throw new AdvancePaymentError('Advance payment request not found.')
  if (!/^(manual:[a-zA-Z0-9-]{16,80}|stripe:pi_[a-zA-Z0-9]+)$/.test(sourceRef ?? '')) throw new AdvancePaymentError('A unique receipt reference is required.')
  const stamp = Date.parse(`${receivedOn}T12:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedOn ?? '') || !Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== receivedOn || receivedOn > today) throw new AdvancePaymentError('Choose the actual date received, no later than today.')
  return { requestId, clientId: request.clientId, sourceRef, cents: advanceCents(amount), receivedOn, method: String(method || 'manual').slice(0, 80), createdAt: at, createdBy: actorUserId }
}
export function advanceCredits(requests, receipts, reversals) {
  return receipts.map((receipt) => {
    const notices = reversals.filter((event) => event.sourceRef === receipt.sourceRef)
    const refunds = notices.filter((event) => event.kind === 'refund')
    const latest = [...(refunds.length ? refunds : notices)].sort((a, b) => String(a.at).localeCompare(String(b.at)) || Number(a.kind === 'dispute-closed') - Number(b.kind === 'dispute-closed') || String(a.id).localeCompare(String(b.id))).at(-1)
    // Hold the whole receipt on a partial refund until a person reconciles it.
    // A later dispute win never releases money that was refunded.
    const holds = !!latest && (refunds.length > 0 || latest.kind !== 'dispute-closed' || !['won', 'warning_closed'].includes(latest.status))
    const request = requests.find((row) => row.id === receipt.requestId)
    return { id: `advance:${receipt.sourceRef}`, clientId: receipt.clientId, amount: receipt.cents / 100,
      sourceKind: 'advance_payment', sourceRef: receipt.sourceRef, forPeriod: request?.forPeriod ?? null, derived: true,
      note: `Advance received for ${request?.number ?? receipt.requestId}`, createdAt: `${receipt.receivedOn}T12:00:00.000Z`,
      createdBy: receipt.createdBy, voidedAt: null, voidedBy: null,
      ...(latest ? { reversal: { kind: latest.kind, at: latest.at, amount: latest.cents == null ? null : latest.cents / 100, reason: latest.reason || '', status: latest.status || '', holds, partial: latest.cents != null && latest.cents < receipt.cents, chargeAmount: receipt.cents / 100 } } : {}) }
  })
}
export function stripeAdvanceReceipt(intent, request, today, at, receivedOn = today) {
  if (intent.status !== 'succeeded' || intent.currency !== 'usd' || !Number.isSafeInteger(intent.amount_received) || intent.amount_received <= 0) throw new AdvancePaymentError('A settled USD payment with a verified received amount is required.')
  if (intent.metadata?.advancePaymentRequestId !== request?.id) throw new AdvancePaymentError('The payment does not identify this advance request.')
  return advanceReceipt({ requestId: request.id, sourceRef: `stripe:${intent.id}`, amount: intent.amount_received / 100, receivedOn, method: 'stripe' }, request, today, at)
}
