/**
 * The staff-facing monthly invoice recap (featreq-0c2d4ce5).
 *
 * Brittany's ask, in her words: her employees need "the total amount for the
 * company and then the reimbursed expenses, but they need to see each one
 * separate so they know what each reimbursed was for" — so they can record the
 * deposit correctly (fee income vs. pass-through reimbursements). And "each
 * team member only sees the invoices for their client".
 *
 * So: for one month, one row per SENT invoice the viewer may see — the
 * company's total, the accounting-services remainder, and every reimbursed
 * expense line individually, never combined. This module is the whole
 * computation; the route hands it the month's invoices and the viewer's
 * visible-client set and sends back what it returns.
 *
 * Deliberate boundaries:
 *  - Only invoices that have actually GONE OUT ("a recap of monthly bills …
 *    when sent"): sent / processing / paid / overdue. Drafts and reviewed
 *    invoices are still the owner's business, and voids are not bills.
 *  - Only 'monthly' invoices. A retainer is money held on account, not a
 *    monthly bill, and it has no reimbursements to break out.
 *  - Visibility is the invoice's own client, full stop — the same
 *    all-or-nothing stance the Client Recap takes on billing masters. A staffer
 *    who needs a master's combined invoice gets there by being assigned to the
 *    master, not by a partial view that presents itself as the whole.
 */

/** The statuses that mean "this bill went out". */
export const RECAP_INVOICE_STATUSES = Object.freeze(['sent', 'processing', 'paid', 'overdue'])

/**
 * The line kinds that are client-reimbursed expenses: one-off reimbursements
 * and the recurring (synthesized-per-period) ones. Everything else on an
 * invoice — plan, hourly, adjustment, adhoc, card fee, retainer credit — is
 * the accounting side of the bill.
 */
export const REIMBURSED_LINE_KINDS = Object.freeze(['reimbursement', 'recurring'])

const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100

/**
 * Build the recap rows for one month.
 *
 * @param {object} args
 * @param {Array<object>} args.invoices - the month's invoices (listInvoices({period}))
 * @param {Array<object>} args.clients - all clients, for names
 * @param {Set<string>} args.visibleClientIds - visibleClientIdSet for the session
 * @returns {Array<object>} one row per visible sent invoice, alphabetical by client
 */
export function buildInvoiceRecap({ invoices = [], clients = [], visibleClientIds = new Set() }) {
  const nameOf = (id) => clients.find((client) => client.id === id)?.name ?? 'Unknown client'
  const rows = []
  for (const invoice of invoices) {
    if (invoice?.kind !== 'monthly') continue
    if (!RECAP_INVOICE_STATUSES.includes(invoice.status)) continue
    if (!visibleClientIds.has(invoice.clientId)) continue
    const lines = Array.isArray(invoice.lineItems) ? invoice.lineItems : []
    const reimbursedLines = lines
      .filter((line) => REIMBURSED_LINE_KINDS.includes(line?.kind))
      .map((line) => ({
        label: String(line.label ?? ''),
        detail: String(line.detail ?? ''),
        amount: roundMoney(line.amount),
        // On a billing master's merged invoice, name WHICH company the expense
        // belongs to — the staffer is recording it against that company's
        // books. Ordinary invoices carry no sourceClientId and get null.
        company:
          line.sourceClientId && line.sourceClientId !== invoice.clientId
            ? nameOf(line.sourceClientId)
            : null,
      }))
    const reimbursedTotal = roundMoney(
      reimbursedLines.reduce((sum, line) => sum + line.amount, 0),
    )
    const total = roundMoney(invoice.total)
    rows.push({
      invoiceId: invoice.id,
      clientId: invoice.clientId,
      clientName: nameOf(invoice.clientId),
      number: invoice.number ?? null,
      status: invoice.status,
      total,
      sentAt: invoice.sentAt ?? null,
      paidAt: invoice.paidAt ?? null,
      reimbursedTotal,
      // What the fee side of the deposit is once the pass-throughs come out.
      // Derived from the SAME lines the breakout shows, so the three numbers
      // on a row always reconcile: accounting + reimbursed = total.
      accountingTotal: roundMoney(total - reimbursedTotal),
      reimbursedLines,
    })
  }
  rows.sort(
    (a, b) =>
      a.clientName.localeCompare(b.clientName) ||
      String(a.number ?? '').localeCompare(String(b.number ?? '')),
  )
  return rows
}
