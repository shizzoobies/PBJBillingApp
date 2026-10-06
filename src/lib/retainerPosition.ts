import type { ClientRetainer } from './api'

/**
 * A client's retainer position from its retainers (void ones are never
 * listed): `total` is everything recorded or sent, `applied` what was given
 * back as credit on invoices, `remaining` what is paid and still creditable
 * (a part-credited retainer is spent, so nothing of it remains), and
 * `awaiting` what was sent or drafted but is not paid, so cannot be credited.
 */
export function retainerPosition(rows: ClientRetainer[]) {
  let total = 0
  let applied = 0
  let remaining = 0
  let awaiting = 0
  for (const row of rows) {
    total += row.total
    if (row.appliedToInvoiceId) applied += row.credit?.amount ?? row.total
    else if (row.status === 'paid') remaining += row.total
    else awaiting += row.total
  }
  return { total, applied, remaining, awaiting }
}
