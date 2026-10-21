import { describe, expect, it } from 'vitest'

import { engagementEsignHash, engagementHash } from './engagement-hash.js'

/** What an e-signature request pins: the letter AND the signing details signing would apply (featreq-56d39567). */
const base = () => ({
  subject: 'Engagement letter',
  emailBody: 'Hi Pat',
  letterBody: 'The letter',
  retainerAmount: 500,
  party: { company: 'Acme Books', contactName: 'Pat', email: 'pat@example.invalid' },
  packageId: 'pkg-1',
  planIds: ['plan-b', 'plan-a'],
  feeMode: 'replace',
  figures: { totals: { monthly: 630, annual: 0 }, lines: [{ name: 'Transactions', amount: 630 }], hoursByRole: { bookkeeper: 8 } },
})

describe('engagementEsignHash', () => {
  it('is 64 hex characters, stable, and different from the letter hash alone', () => {
    const hash = engagementEsignHash(base())
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(engagementEsignHash(base())).toBe(hash)
    expect(hash).not.toBe(engagementHash(base()))
  })

  it('moves with the letter: the text boxes, the retainer and the party', () => {
    const hash = engagementEsignHash(base())
    for (const change of [
      { subject: 'Other' },
      { emailBody: 'Other' },
      { letterBody: 'Other' },
      { retainerAmount: 600 },
      { party: { ...base().party, email: 'else@example.invalid' } },
    ]) {
      expect(engagementEsignHash({ ...base(), ...change }), JSON.stringify(change)).not.toBe(hash)
    }
  })

  it('moves with the signing details: package, plans, fee choice and figures', () => {
    const hash = engagementEsignHash(base())
    for (const change of [
      { packageId: 'pkg-2' },
      { packageId: null },
      { planIds: ['plan-a'] },
      { planIds: ['plan-a', 'plan-b', 'plan-c'] },
      { feeMode: 'add' },
      { figures: { ...base().figures, totals: { monthly: 700, annual: 0 } } },
    ]) {
      expect(engagementEsignHash({ ...base(), ...change }), JSON.stringify(change)).not.toBe(hash)
    }
  })

  it('does not move with things that are not the letter or its signing details', () => {
    const hash = engagementEsignHash(base())
    expect(engagementEsignHash({ ...base(), status: 'sent', updatedAt: 'x', emailLog: [{ kind: 'send' }] })).toBe(hash)
    // The order plans were listed in, and the order of keys inside the figures, are not changes.
    expect(engagementEsignHash({ ...base(), planIds: ['plan-a', 'plan-b'] })).toBe(hash)
    const figures = base().figures
    expect(
      engagementEsignHash({
        ...base(),
        figures: { hoursByRole: { bookkeeper: 8 }, lines: [{ amount: 630, name: 'Transactions' }], totals: { annual: 0, monthly: 630 } },
      }),
    ).toBe(hash)
    expect(figures).toBeTruthy()
  })

  it('reads an engagement with nothing on it without throwing', () => {
    expect(engagementEsignHash({})).toMatch(/^[0-9a-f]{64}$/)
    expect(engagementEsignHash(null)).toMatch(/^[0-9a-f]{64}$/)
    // Absent and default fee choice are the same.
    expect(engagementEsignHash({ feeMode: 'replace' })).toBe(engagementEsignHash({}))
  })
})
