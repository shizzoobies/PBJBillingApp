/**
 * Shared time-entry input rules.
 *
 * Lives in `lib/` (plain JS) so both the server (`server.js`) and the test
 * suite can import the exact same logic — the manual-entry gate must not be
 * duplicated and drift.
 */

/**
 * Normalize the capture-method fields of an incoming time-entry payload and
 * enforce the manual-entry rule: a `manual` entry requires a non-empty reason.
 *
 * Returns `{ entryMethod, manualReason, error }`:
 *   - `entryMethod` is always `'timer'` unless the payload explicitly asked
 *     for `'manual'`.
 *   - `manualReason` is the trimmed reason for a valid manual entry, otherwise
 *     `undefined` — timer entries never carry a reason.
 *   - `error` is a human-readable string when the input is invalid, otherwise
 *     `null`.
 */
export function normalizeTimeEntryMethod(payload = {}) {
  const isManual = payload?.entryMethod === 'manual'
  const entryMethod = isManual ? 'manual' : 'timer'
  const manualReason =
    isManual && typeof payload?.manualReason === 'string'
      ? payload.manualReason.trim()
      : ''

  if (isManual && !manualReason) {
    return {
      entryMethod,
      manualReason: undefined,
      error: 'A reason is required for manual time entries.',
    }
  }

  return {
    entryMethod,
    manualReason: entryMethod === 'manual' ? manualReason : undefined,
    error: null,
  }
}
