/**
 * "Download for QBO" — a line-level CSV of a month's invoices, in the column
 * shape QuickBooks Online's invoice import expects, so Brittany bulk-adds the
 * month in one pass instead of re-keying each invoice.
 *
 * QBO matches one row per invoice LINE, repeating the invoice header columns on
 * every row of the same invoice; that is why this is not one row per invoice.
 *
 * ⚠️ THE `Item` COLUMN IS A GUESS UNTIL SHE CONFIRMS IT. QBO matches Item
 * against the product/service list in HER company file, and we do not know
 * those names. The defaults below are readable placeholders. If they do not
 * match her list, QBO will either reject the row or create new items — so this
 * needs one real import against her file before it is trusted. Everything else
 * in the file (numbers, customers, dates, amounts) comes straight from the
 * invoice and is exact.
 */

/** Line kind -> a QBO product/service name. Placeholder until confirmed. */
const ITEM_BY_KIND = {
  plan: 'Services',
  hourly: 'Services',
  reimbursement: 'Reimbursement',
  recurring: 'Reimbursement',
  adjustment: 'Adjustment',
  custom: 'Services',
  // A card processing fee the client covered. Deliberately the same placeholder
  // as the rest until the real product/service list is confirmed — the point is
  // that the line and the total EXPORT at all, so the file matches the money
  // that actually arrived.
  'card-fee': 'Services',
}

export const QBO_COLUMNS = [
  'InvoiceNo',
  'Customer',
  'InvoiceDate',
  'DueDate',
  'Item',
  'ItemDescription',
  'ItemQuantity',
  'ItemRate',
  'ItemAmount',
]

/**
 * Escape one CSV cell. Anything containing a comma, quote or newline is quoted
 * and its quotes doubled — client names like "Cooper & Cooper, PA" would
 * otherwise split into two columns and silently corrupt the import.
 */
export function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value)
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

/** US-format date for QBO: 2026-08-31 -> 08/31/2026. Blank stays blank. */
export function qboDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''))
  if (!match) return ''
  return `${match[2]}/${match[3]}/${match[1]}`
}

/** Last day of a YYYY-MM period, used as the invoice date. */
function periodEnd(period) {
  const year = Number(String(period).slice(0, 4))
  const month = Number(String(period).slice(5, 7))
  if (!Number.isFinite(year) || !Number.isFinite(month)) return ''
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
}

/**
 * Build the CSV text for a set of invoices.
 *
 * VOID invoices are excluded — they are not owed, and importing one into QBO
 * would create a real receivable for money nobody owes.
 *
 * @param {Array} invoices
 * @param {Map<string, {name: string}>|object} clientsById
 * @returns {string} CSV including the header row
 */
export function buildQboCsv(invoices, clientsById) {
  const nameOf = (clientId) => {
    const client =
      clientsById instanceof Map ? clientsById.get(clientId) : clientsById?.[clientId]
    return client?.name ?? 'Unknown client'
  }

  const rows = [QBO_COLUMNS.join(',')]
  for (const invoice of invoices ?? []) {
    if (invoice.status === 'void') continue
    const invoiceDate = qboDate(periodEnd(invoice.period))
    const dueDate = qboDate(invoice.dueDate)
    for (const line of invoice.lineItems ?? []) {
      // Quantity/rate are left blank and the whole value put in ItemAmount:
      // our lines are already extended amounts ("3.5h at $75/hr" is a detail
      // string, not a qty x rate pair), and inventing a quantity would let QBO
      // re-multiply and change the number.
      rows.push(
        [
          invoice.number ?? '',
          nameOf(invoice.clientId),
          invoiceDate,
          dueDate,
          ITEM_BY_KIND[line.kind] ?? 'Services',
          [line.label, line.detail].filter(Boolean).join(' — '),
          '',
          '',
          (Number(line.amount) || 0).toFixed(2),
        ]
          .map(csvCell)
          .join(','),
      )
    }
  }
  return rows.join('\r\n')
}
