/**
 * Payroll aggregation rules for GROUP-TIME SPLITS, and THE labor-cost rule.
 *
 * The implementation moved to `lib/payroll-cost.js` so the Node server (which
 * cannot load TypeScript) shares it rather than keeping a second copy: the
 * Client Recap needs the same per-person, cent-rounded cost the payroll report
 * shows. This file is the TypeScript door onto that one implementation — every
 * existing import keeps working and there is nothing here to drift.
 *
 * Read the rules (full-mode dedup, rounding order, "no rate is not $0.00") in
 * `lib/payroll-cost.js`.
 */

export type { PayrollSlice } from '../../lib/payroll-cost.js'

export {
  allocatePersonCost,
  billableMinutes,
  displayHours,
  duplicateFullSliceIds,
  internalMinutes,
  laborCost,
  periodDisplayHours,
  periodMoney,
  personPeriodCost,
  roundToCent,
  sumDisplayHours,
  sumPersonCosts,
  trackedMinutes,
} from '../../lib/payroll-cost.js'
