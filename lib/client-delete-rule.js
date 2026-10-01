/**
 * The one rule for "may this client be deleted?", shared by the client page
 * (which decides whether to offer the Delete button) and the server (which
 * refuses a bulk save that would delete a client with history).
 *
 * A client is deletable only when it has NO time entries and NO invoices. An
 * invoice counts in any status, void included: a number that was issued must
 * not vanish. Anything else is retired instead ("Mark inactive"), which keeps
 * all of it. Time takes precedence in the wording when both are true, because
 * it is the one the owner can see on the client's own page.
 */

export const CLIENT_HAS_TIME_REASON =
  'This client has time logged, so it cannot be deleted. Mark it inactive instead.'
export const CLIENT_HAS_INVOICES_REASON =
  'This client has invoices, so it cannot be deleted. Mark it inactive instead.'

/**
 * @param {{ timeEntryCount?: number, invoiceCount?: number }} counts
 * @returns {{ deletable: true, reason: null } | { deletable: false, reason: string }}
 */
export function clientDeleteVerdict({ timeEntryCount = 0, invoiceCount = 0 } = {}) {
  if (timeEntryCount > 0) return { deletable: false, reason: CLIENT_HAS_TIME_REASON }
  if (invoiceCount > 0) return { deletable: false, reason: CLIENT_HAS_INVOICES_REASON }
  return { deletable: true, reason: null }
}

/**
 * The sentence the server answers a refused bulk save with. Names the client,
 * because the save covers the whole workspace and the owner has to know which
 * one stopped it.
 *
 * @param {string} name
 * @param {{ hasTime: boolean, hasInvoices: boolean }} history
 * @returns {string}
 */
export function clientHistoryRefusal(name, { hasTime, hasInvoices }) {
  const what = hasTime || !hasInvoices ? 'time logged' : 'invoices'
  return `${name} has ${what} and cannot be deleted. Reload and mark it inactive instead.`
}
