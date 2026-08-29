import { describe, expect, it } from 'vitest'
import { generateSkipMessage } from '../lib/invoiceSkipMessage'

/**
 * The sentences someone reads after asking for ONE invoice and getting none.
 *
 * Consolidated billing adds two reasons that are NOT failures, and both would
 * be misread as one if they came out as the generic "No invoice was created":
 *
 *   `billed-to-other`      — this company IS billed, on the master's invoice.
 *   `master-without-subs`  — the master is misconfigured, not empty.
 *
 * The generic fallback exists precisely so an unknown reason is never silence,
 * so the pre-existing reasons are pinned here too — they are what a regression
 * in the new switch arms would fall through to.
 */

const KLC = 'KLC Master'
const masters = (id: string | null | undefined) =>
  id === 'client-klc-master' ? KLC : null

describe('generateSkipMessage — consolidated billing', () => {
  it('names the master a company is billed on', () => {
    expect(
      generateSkipMessage(
        { reason: 'billed-to-other', billedToClientId: 'client-klc-master' },
        'Chemtrex',
        'August 2026',
        masters,
      ),
    ).toBe("Billed on KLC Master's invoice")
  })

  // A name we cannot vouch for is worse than none: printing an id at her, or
  // worse the wrong client's name, is how "billed where?" starts.
  it('falls back when the master is not in the workspace', () => {
    expect(
      generateSkipMessage(
        { reason: 'billed-to-other', billedToClientId: 'client-gone' },
        'Chemtrex',
        'August 2026',
        masters,
      ),
    ).toBe("Billed on another client's invoice")
  })

  it('falls back when the skip carried no master at all', () => {
    expect(
      generateSkipMessage({ reason: 'billed-to-other' }, 'Chemtrex', 'August 2026', masters),
    ).toBe("Billed on another client's invoice")
  })

  // Misconfigured, not empty. "Nothing to bill" would send her looking for
  // missing time entries that were never the problem.
  it('says a billing master has nothing pointed at it', () => {
    expect(
      generateSkipMessage(
        { reason: 'master-without-subs' },
        'KLC Master',
        'August 2026',
        masters,
      ),
    ).toBe('This is a billing master with no companies pointed at it yet.')
  })

  it('leaves the pre-existing reasons alone', () => {
    expect(
      generateSkipMessage({ reason: 'nothing-to-bill' }, 'Acme', 'August 2026', masters),
    ).toContain('Acme has nothing to bill for August 2026')
    expect(
      generateSkipMessage({ reason: 'already-generated' }, 'Acme', 'August 2026', masters),
    ).toContain('already has an invoice')
    expect(
      generateSkipMessage({ reason: 'not-billable-yet' }, 'Acme', 'August 2026', masters),
    ).toContain('not an active client yet')
    expect(
      generateSkipMessage({ reason: 'no-such-client' }, 'Acme', 'August 2026', masters),
    ).toBe('Acme is no longer on file.')
  })

  it('still answers when the reason is unknown or the skip is missing', () => {
    expect(generateSkipMessage(undefined, 'Acme', 'August 2026', masters)).toBe(
      'No invoice was created for Acme for August 2026.',
    )
    expect(
      generateSkipMessage({ reason: 'something-new' }, 'Acme', 'August 2026', masters),
    ).toBe('No invoice was created for Acme for August 2026.')
  })
})
