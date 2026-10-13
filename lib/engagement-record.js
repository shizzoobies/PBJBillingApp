/**
 * Is this engagement a PURE RECORD (engagements stage 4)? An amendment that brings
 * nothing to the client - no money in its figures, no lines, no plans, no package, no
 * retainer, its fee kept (a Letters send, or a letter amendment left as drafted).
 * Signing one records the signature only; keeping one in force when a superseding
 * letter replaces the rest therefore loses nothing. Shared by the store (signing) and
 * the sign dialog (the warning on an amendment that is NOT one), so the two never drift.
 */
export function engagementIsPureRecord(engagement) {
  if (engagement?.kind !== 'amendment') return false
  const figures = engagement.figures && typeof engagement.figures === 'object' ? engagement.figures : {}
  const totals = figures.totals && typeof figures.totals === 'object' ? figures.totals : {}
  return (
    !Object.values(totals).some((value) => Number(value) > 0) &&
    !(Array.isArray(figures.lines) && figures.lines.length > 0) &&
    (engagement.planIds ?? []).length === 0 &&
    !engagement.packageId &&
    !(Number(engagement.retainerAmount) > 0) &&
    (engagement.feeMode ?? 'replace') === 'keep'
  )
}
