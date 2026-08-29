/**
 * Why a single-client generate produced nothing.
 *
 * A month-wide run can pass these over in silence — one prospect among forty
 * clients is not news — but someone who just asked for ONE invoice and got none
 * is owed the reason.
 *
 * It lives here rather than beside the page that shows it because every branch
 * is a sentence a person reads after a click that appeared to do nothing, and
 * that deserves its own test. (A page file can only export components without
 * breaking fast refresh, which is the other half of why it moved.)
 */

/** One entry of the generate endpoint's `skipped` array. */
export type InvoiceGenerateSkip = {
  reason?: string
  /** Only on `billed-to-other`: the billing master the work went onto. */
  billedToClientId?: string | null
}

export function generateSkipMessage(
  skipped: InvoiceGenerateSkip | undefined,
  clientName: string,
  periodLabel: string,
  /**
   * A billing master's id to its name. Returns null when that master is not in
   * the workspace — a name we cannot vouch for is worse than none, so the
   * sentence falls back to "another client's invoice" rather than printing an
   * id at her.
   */
  masterName: (clientId: string | null | undefined) => string | null = () => null,
) {
  switch (skipped?.reason) {
    case 'nothing-to-bill':
      return `${clientName} has nothing to bill for ${periodLabel} — no hours, plan, or reimbursements — so no invoice was created.`
    case 'already-generated':
      return `${clientName} already has an invoice for ${periodLabel}. Reload the page and try again.`
    case 'not-billable-yet':
      return `${clientName} is not an active client yet, so there is nothing to bill.`
    case 'no-such-client':
      return `${clientName} is no longer on file.`
    // Not a failure and not silence: this company's work IS billed, on somebody
    // else's document. Naming the payer is the whole point — "no invoice" on its
    // own reads as "we forgot to bill them".
    case 'billed-to-other': {
      const master = masterName(skipped.billedToClientId)
      return master ? `Billed on ${master}'s invoice` : "Billed on another client's invoice"
    }
    // A master with nothing pointed at it has no lines to build from. It is
    // misconfigured, not empty, so it says what is missing rather than
    // reporting the month as having nothing to bill.
    case 'master-without-subs':
      return 'This is a billing master with no companies pointed at it yet.'
    default:
      return `No invoice was created for ${clientName} for ${periodLabel}.`
  }
}
