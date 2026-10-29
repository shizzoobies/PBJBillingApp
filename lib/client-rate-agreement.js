/** Effective billing-month agreements. A null scope inherits; zero is a price. */
import { recapStaffTier } from './staff-tiers.js'
export function clientRateOverrideAt(client, employeeId, period, employeeRole = null) {
  if (client?.billingMode !== 'hourly' || typeof period !== 'string') return null
  let everyone = null
  let person = null
  let role = null
  const tier = employeeRole === 'CFO' ? 'CFO' : recapStaffTier(employeeRole)
  for (const row of client.hourlyRateOverrides ?? []) {
    if (!row || row.effectivePeriod > period) continue
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(row.effectivePeriod)) continue
    if (row.rate !== null && (typeof row.rate !== 'number' || !Number.isFinite(row.rate) || row.rate < 0)) continue
    // The store returns append order; a correction for the same month wins.
    if (row.userId === null && !row.role && (!everyone || row.effectivePeriod >= everyone.effectivePeriod)) everyone = row
    if (row.role && row.role === tier && (!role || row.effectivePeriod >= role.effectivePeriod)) role = row
    if (employeeId && row.userId === employeeId && (!person || row.effectivePeriod >= person.effectivePeriod)) person = row
  }
  return person?.rate ?? role?.rate ?? everyone?.rate ?? null
}

export function validateClientRateAgreement({ id, effectivePeriod, userId = null, role = null, rate, note = '' } = {}) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(id)) throw new Error('A request identifier is required.')
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(effectivePeriod ?? '') || effectivePeriod < '2026-06') {
    throw new Error('Choose a real billing month, June 2026 or later.')
  }
  if (userId !== null && (typeof userId !== 'string' || !userId || userId.length > 100)) throw new Error('Choose a team member or all team members.')
  if (role !== null && (!['CFO', 'Accountant', 'Bookkeeper'].includes(role) || userId !== null)) throw new Error('Choose one staff role or one person, not both.')
  if (rate !== null && (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 10000)) throw new Error('Enter a rate from $0 to $10,000, or choose inherited rates.')
  return { id, effectivePeriod, userId, role, rate: rate === null ? null : Math.round(rate * 100) / 100, note: String(note).trim().slice(0, 500) }
}
