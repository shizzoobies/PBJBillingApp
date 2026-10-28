/** Types for the plain-JS `lib/hourly-estimate.js` (the Billing tab imports it). */

import type { BillRateVersion } from './rate-history.js'

export declare const RECAP_TIER_ESTIMATE_FIELD: {
  CFO: 'estimatedCfoHours'
  Accountant: 'estimatedAccountantHours'
  Bookkeeper: 'estimatedBookkeeperHours'
}

export declare const ESTIMATE_TIERS: readonly ['CFO', 'Accountant', 'Bookkeeper']

export type EstimateTier = {
  tier: 'CFO' | 'Accountant' | 'Bookkeeper'
  hours: number
  hasEstimate: boolean
  rate: number | null
  amount: number
  employeeCount: number
  source: 'assigned' | 'logged' | 'client_rate' | null
}

export type MonthlyInvoiceEstimate = {
  total: number
  hasEstimate: boolean
  /** Roles with estimated hours but no rate: their hours are NOT counted in `total`. */
  unrated: Array<'CFO' | 'Accountant' | 'Bookkeeper'>
  basis: 'rates' | 'client_rate' | 'none'
  tiers: EstimateTier[]
}

export declare function estimatedMonthlyInvoice(opts: {
  client: {
    hourlyRate?: number | null
    hourlyRatePeriod?: string | null
    assignedBookkeeperIds?: readonly string[] | null
    estimatedBookkeeperHours?: number | null
    estimatedAccountantHours?: number | null
    estimatedCfoHours?: number | null
  }
  employees?: ReadonlyArray<{ id: string; role?: string; billRate?: number | null }>
  billRateVersions?: readonly BillRateVersion[]
  period: string
  months?: number
  loggedEmployeeIds?: readonly string[]
}): MonthlyInvoiceEstimate
