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
  /** Like per-form, but reads ONLY the selection's typed quantity - no input fallback. */
  | 'per-count'
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
  /** null for a retired/unknown selection the catalog no longer names (priceProposal). */
  serviceId: string | null
  /** null for a retired/unknown selection the catalog no longer names (priceProposal). */
  group: ProposalGroup | null
  name: string
  tier: ProposalTier | null
  cadence: ProposalCadence | null
  amount: number
  computedAmount: number
  formula: string
  flag: 'unknown-input' | 'needs-count' | 'invalid-input' | 'retired' | null
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

/** Owner-edited catalog in, a safe catalog out; anything not an object is the seed. */
export declare function sanitizeProposalPricing(raw: unknown): ProposalPricing

export type ProposalProspect = {
  company: string
  contactName: string
  email: string
  phone: string
  notes: string
}

/** The prospect block, every field a capped string. */
export declare function cleanProposalProspect(raw: unknown): ProposalProspect
/** Finite, non-negative counts; with `allowedKeys`, only the catalog's own inputs. */
export declare function cleanProposalInputs(
  raw: unknown,
  allowedKeys?: Iterable<string> | null,
): Record<string, number>
/** One entry per service (the last wins), numbers finite and non-negative. */
export declare function cleanProposalSelections(raw: unknown): ProposalSelection[]


/** A chat patch AFTER `validateProposalPatch` (lib/assistant.js). */
export type ValidatedProposalPatch = {
  prospect?: Partial<ProposalProspect>
  inputs?: Record<string, number>
  selections?: { add: ProposalSelection[]; remove: string[] }
}

/** Apply a validated chat patch; adding one tier of a row replaces its siblings. */
export declare function applyProposalPatch(
  current: {
    prospect?: Partial<ProposalProspect> | null
    inputs?: Record<string, number> | null
    selections?: readonly ProposalSelection[] | null
  },
  patch: ValidatedProposalPatch | null | undefined,
  services: readonly ProposalService[],
): { prospect: ProposalProspect; inputs: Record<string, number>; selections: ProposalSelection[] }
