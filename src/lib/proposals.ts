import type {
  ProposalMultiplier,
  ProposalPricingKind,
  ProposalRole,
} from './types'

/**
 * Words for the proposal catalog's enums (featreq-311473e2). One place, so the
 * Settings table and the proposal editor can never name the same thing twice
 * two different ways.
 */
export const PROPOSAL_ROLE_LABELS: Record<ProposalRole, string> = {
  bookkeeper: 'Bookkeeper (B)',
  accountant: 'Accountant (A)',
  controller: 'Controller (C)',
}

export const PROPOSAL_MULTIPLIER_LABELS: Record<ProposalMultiplier, string> = {
  none: 'None',
  'weekly-x4': 'Weekly (x 4)',
  'quarterly-div3': 'Quarterly (/ 3)',
  'yearly-div12': 'Yearly (/ 12)',
  'per-cleanup-month': 'Per clean-up month',
  'per-report': 'Per report',
  'per-form': 'Per form',
}

export const PROPOSAL_PRICING_LABELS: Record<ProposalPricingKind, string> = {
  formula: 'Formula',
  flat: 'Flat amount',
  payroll: 'Payroll block',
  'sales-tax': 'Sales tax block',
}
