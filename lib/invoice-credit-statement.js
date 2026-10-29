const cents = (value) => Math.round((Number(value) || 0) * 100)
export function buildCreditStatement(invoice, credits, at) {
  if (!(invoice.lineItems ?? []).some((line) => ['account_credit', 'advance_request'].includes(line.kind))) return null
  let opening = 0, reserved = 0, held = 0
  for (const credit of credits) {
    if (credit.voidedAt) continue
    const others = (credit.draws ?? []).filter((draw) => draw.invoiceId !== invoice.id)
    const committed = others.filter((draw) => !['draft', 'reviewed'].includes(draw.status))
    const otherDrafts = others.filter((draw) => ['draft', 'reviewed'].includes(draw.status))
    const balance = Math.max(0, cents(credit.amount) - committed.reduce((sum, draw) => sum + cents(draw.amount), 0))
    const reservations = otherDrafts.reduce((sum, draw) => sum + cents(draw.amount), 0)
    opening += balance
    reserved += reservations
    if (credit.reversal?.holds) held += Math.max(0, balance - reservations)
  }
  const applied = Math.max(0, -(invoice.lineItems ?? []).filter((line) => line.kind === 'account_credit').reduce((sum, line) => sum + cents(line.amount), 0))
  const retainer = Math.max(0, -(invoice.lineItems ?? []).filter((line) => line.kind === 'retainer_credit').reduce((sum, line) => sum + cents(line.amount), 0))
  return { asOf: at, openingCents: opening, appliedCents: applied, closingCents: opening - applied,
    reservedCents: reserved, heldCents: held, currentChargesCents: cents(invoice.total) + applied + retainer,
    retainerAppliedCents: retainer, amountDueCents: cents(invoice.total) }
}
export function invoiceCreditStatement(invoice) {
  const lines = invoice?.lineItems ?? invoice?.lines ?? []
  const line = lines.find((line) => line.kind === 'account_credit') ?? lines.find((line) => line.kind === 'advance_request')
  const value = line?.creditStatement
  if (!value || value.appliedCents !== -cents(line.amount)) return null
  const difference = invoice.total === undefined ? 0 : cents(invoice.total) - value.amountDueCents
  const cardFees = lines.filter((row) => row.kind === 'card-fee').reduce((sum, row) => sum + cents(row.amount), 0)
  if (difference && difference !== cardFees) return null
  return difference ? { ...value, currentChargesCents: value.currentChargesCents + difference, amountDueCents: value.amountDueCents + difference } : value
}
export function creditStatementText(invoice) {
  const value = invoiceCreditStatement(invoice)
  if (!value) return []
  const money = (amount) => (amount / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
  return [...(value.display === 'summary' ? [] : [`Credit balance at invoice preparation (${value.asOf.slice(0, 10)})`]),
    ...(value.openingCents > 0 ? [`Opening credit balance: ${money(value.openingCents)}`] : []),
    `Current charges: ${money(value.currentChargesCents)}`,
    ...(value.retainerAppliedCents ? [`Retainer applied separately: ${money(value.retainerAppliedCents)}`] : []),
    `Credit applied to this invoice: ${money(value.appliedCents)}`,
    `Closing credit balance: ${money(value.closingCents)}`,
    ...(value.reservedCents ? [`Included in closing balance, reserved on other drafts: ${money(value.reservedCents)}`] : []),
    ...(value.heldCents ? [`Included in closing balance, on hold: ${money(value.heldCents)}`] : []),
    `Amount due on this invoice: ${money(value.amountDueCents)}`,
    'Month-specific prepayments remain assigned to their billing months. This is a snapshot, not a current account statement.']
}
