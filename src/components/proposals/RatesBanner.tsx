import { Link } from 'react-router-dom'
import { unsetRateRoles } from '../../lib/proposals'
import type { ProposalRates } from '../../lib/types'

/**
 * The warning every proposal surface shows while a catalog rate is $0 — a line
 * priced at a $0 rate reads "Not yet priced", so the fix is to set the rates.
 * Renders nothing when every rate is set (or the catalog has not loaded).
 */
export function ProposalRatesBanner({ rates }: { rates: Partial<ProposalRates> | null | undefined }) {
  if (!rates || unsetRateRoles(rates).length === 0) return null
  return (
    <p className="form-error" role="alert">
      Proposal rates are not set — set them under <Link to="/settings">Settings &gt; Proposal pricing</Link>
    </p>
  )
}
