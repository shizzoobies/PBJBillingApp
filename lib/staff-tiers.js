/**
 * THE staff role tier mapping — the one place it is written down.
 *
 * Lifted out of `lib/client-recap.js` (which still re-exports it, so every
 * existing reader keeps working) when the invoice redesign needed the SAME
 * tiers to group an invoice's hours lines. It could not simply import the recap:
 * `lib/client-recap.js` imports `buildInvoiceLines` from `lib/invoice-lines.js`,
 * so invoice-lines importing back would be a cycle. Copying the switch would
 * have been worse — two mappings that agree today and drift the first time a
 * staff role is added. So it lives here, in a leaf module that imports nothing,
 * and both sides read it.
 *
 * ── Why these four names ──────────────────────────────────────────────────
 *
 * The firm owner asks for the recap's people to read "CFO hours, Accountant,
 * Bookkeeper" and to stay in that order every month. The app has no "CFO" staff
 * role: `employees[].role` (and the `users.staff_role` column behind it) allows
 * exactly three values — 'Owner', 'Accountant', 'Bookkeeper'. What IS called CFO
 * is the client-side planning field `estimatedCfoHours`, which sits beside
 * `estimatedAccountantHours` and `estimatedBookkeeperHours` on a client. Those
 * three estimate fields are the tiers she means, so the mapping is:
 *
 *   estimatedCfoHours         <- role 'Owner'        (the firm owner does the CFO work)
 *   estimatedAccountantHours  <- role 'Accountant'   (db role 'senior_bookkeeper')
 *   estimatedBookkeeperHours  <- role 'Bookkeeper'
 *
 * Anything else — a role that has not been set, or a value added later — lands
 * in 'Other' and sorts last rather than silently jumping the queue.
 *
 * A tier nobody logged time in is OMITTED, not shown as a zero row: `byStaff` is
 * a list of people, and inventing a person to hold a zero would be worse than a
 * short list. The ORDER of the tiers that are present never changes, which is
 * what "the same order month to month" actually needs — and it is the order the
 * invoice's role groups print in too.
 */
export const RECAP_STAFF_TIERS = ['CFO', 'Accountant', 'Bookkeeper', 'Other']

export function recapStaffTier(employeeRole) {
  switch (employeeRole) {
    case 'Owner':
      return 'CFO'
    case 'Accountant':
      return 'Accountant'
    case 'Bookkeeper':
      return 'Bookkeeper'
    default:
      return 'Other'
  }
}
