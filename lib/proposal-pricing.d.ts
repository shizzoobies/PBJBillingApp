/**
 * Types for the plain-JS `lib/proposal-pricing.js`, so `src/` prices a
 * proposal through the very function the server snapshots with.
 *
 * Keep these in sync with the actual exports in lib/proposal-pricing.js.
 */

export type ProposalGroup =
  | 'Monthly'
  | 'Reconciliations'
  | 'AR'
  | 'AP'
  | 'Payroll'
  | 'Sales tax'
  | 'Reports'
  | 'Additional reports'
  | 'Annual and one-time'
  | 'Clean-up'
export type ProposalTier = 'Basic' | 'Classes' | 'Advance'
export type ProposalRole = 'bookkeeper' | 'accountant' | 'controller'
export type ProposalPricingKind = 'formula' | 'flat' | 'payroll' | 'sales-tax'
export type ProposalMultiplier =
  | 'none'
  | 'weekly-x4'
  | 'quarterly-div3'
  | 'yearly-div12'
  | 'per-cleanup-month'
  | 'per-report'
  | 'per-form'
export type ProposalCadence = 'annual' | 'one-time'
export type PayrollRun = 'weekly' | 'biweekly' | 'monthly'

export type ProposalRates = Record<ProposalRole, number>

export type ProposalInput = { key: string; label: string; help: string }

export type ProposalService = {
  id: string
  group: ProposalGroup
  name: string
  tier: ProposalTier | null
  pricing: ProposalPricingKind
  inputKey: string | null
  factor: number
  role: ProposalRole | null
  multiplier: ProposalMultiplier
  /** Only on 'Annual and one-time' rows; splits that group's total. */
  cadence: ProposalCadence | null
  active: boolean
  sortOrder: number
}

export type ProposalPricing = {
  rates: ProposalRates
  inputs: ProposalInput[]
  services: ProposalService[]
}

export type ProposalSelection = {
  serviceId: string
  quantity?: number
  flatAmount?: number
  override?: number
  payrollRun?: PayrollRun
  includeBonus?: boolean
  includeReview?: boolean
}

export type PricedLine = {
  serviceId: string
  group: ProposalGroup
  name: string
  tier: ProposalTier | null
  cadence: ProposalCadence | null
  amount: number
  computedAmount: number
  formula: string
  flag: 'unknown-input' | null
}

export type ProposalTotals = { monthly: number; annual: number; oneTime: number; cleanup: number }

export declare const PROPOSAL_GROUPS: readonly ProposalGroup[]
export declare const MONTHLY_GROUPS: readonly ProposalGroup[]
export declare const ANNUAL_GROUP: 'Annual and one-time'
export declare const CLEANUP_GROUP: 'Clean-up'
export declare const PROPOSAL_TIERS: readonly ProposalTier[]
export declare const PROPOSAL_ROLES: readonly ProposalRole[]
export declare const PROPOSAL_PRICING_KINDS: readonly ProposalPricingKind[]
export declare const PROPOSAL_MULTIPLIERS: readonly ProposalMultiplier[]
export declare const PROPOSAL_CADENCES: readonly ProposalCadence[]
export declare const PAYROLL_RUNS: readonly PayrollRun[]
export declare const PAYROLL_BONUS_FACTOR: number
export declare const PAYROLL_TAX_FACTOR: number
export declare const SALES_TAX_AMOUNT_KEY: string
export declare const DEFAULT_PROPOSAL_PRICING: Readonly<ProposalPricing>

export declare function defaultProposalPricing(): ProposalPricing
export declare function roundCents(value: number): number
export declare function formatProposalMoney(amount: number): string
export declare function priceProposal(args: {
  catalog: Pick<ProposalPricing, 'inputs' | 'services'> | null | undefined
  rates: Partial<ProposalRates> | null | undefined
  inputs: Record<string, number> | null | undefined
  selections: readonly ProposalSelection[] | null | undefined
}): { lines: PricedLine[]; totals: ProposalTotals }
