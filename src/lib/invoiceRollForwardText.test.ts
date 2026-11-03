import { describe, expect, it } from 'vitest'
import { generateRollForwardNote, rollForwardNotice, undoRollForwardNotice } from './invoiceRollForwardText'
import { generateSkipMessage } from './invoiceSkipMessage'
import type { PersistedInvoice } from './types'

/** What the month run says after a push, an undo, and a Generate that carried pushed lines (featreq-40697310). */

const inv = (over: Partial<PersistedInvoice>) => ({ id: 'x', number: null, period: '2026-08', ...over }) as PersistedInvoice

describe('rollForwardNotice', () => {
  it('names the invoice now holding the lines, and an advance that moved', () => {
    expect(
      rollForwardNotice(
        {
          rolled: inv({ number: 'INV-2026-08-001', rolledIntoPeriod: '2026-09' }),
          carrier: inv({ number: 'INV-2026-09-004' }),
          advance: { invoiceId: 'c', requestId: 'r', number: 'ADV-0004', attached: true, message: null },
        },
        { number: 'INV-2026-08-001', period: '2026-08' },
      ),
    ).toBe('INV-2026-08-001 was pushed into September 2026. Its lines are now on INV-2026-09-004. The advance request ADV-0004 moved with it.')
  })

  it('says the lines wait for next month’s Generate, and why an advance did not move', () => {
    expect(
      rollForwardNotice(
        {
          rolled: inv({ number: 'INV-2026-08-001', rolledIntoPeriod: '2026-09' }),
          carrier: null,
          advance: { invoiceId: null, requestId: 'r', number: null, attached: false, message: 'Collected separately, so it stays on its own payment page.' },
        },
        { number: 'INV-2026-08-001', period: '2026-08' },
      ),
    ).toBe(
      "INV-2026-08-001 was pushed into September 2026. Its lines go onto September 2026's invoice when you generate September 2026. The advance request was not moved: Collected separately, so it stays on its own payment page.",
    )
  })
})

describe('undoRollForwardNotice', () => {
  const base = { rolled: inv({ number: 'INV-2026-08-001' }), skipped: [], advance: null, generateError: null }
  const fallback = { number: 'INV-2026-08-001', period: '2026-08', clientName: 'Acme' }

  it('says a next-month invoice that held nothing else was voided', () => {
    expect(
      undoRollForwardNotice(
        { ...base, carrier: inv({ number: 'INV-2026-09-001' }), carrierVoided: true, regenerated: inv({ number: 'INV-2026-08-002' }) },
        fallback,
      ),
    ).toBe(
      "The push of INV-2026-08-001 was undone. INV-2026-09-001 held nothing else, so it was voided. August 2026's invoice was rebuilt as you left it, as INV-2026-08-002.",
    )
  })

  it('says why nothing was built, or that rebuilding failed', () => {
    expect(
      undoRollForwardNotice(
        { ...base, carrier: null, carrierVoided: false, regenerated: null, skipped: [{ clientId: 'c', reason: 'nothing-to-bill' }] },
        fallback,
      ),
    ).toBe('The push of INV-2026-08-001 was undone. Acme has nothing to bill for August 2026 — no hours, plan, or reimbursements — so no invoice was created.')
    expect(
      undoRollForwardNotice(
        { ...base, carrier: null, carrierVoided: false, regenerated: null, generateError: 'Press Generate to build the month.' },
        fallback,
      ),
    ).toBe('The push of INV-2026-08-001 was undone. Press Generate to build the month.')
  })
})

describe('generateRollForwardNote', () => {
  it('counts carried invoices and pushed clients, and names an advance that could not move', () => {
    expect(
      generateRollForwardNote({
        skipped: [{ reason: 'rolled-forward' }, { reason: 'opted-out' }],
        carried: [{ clientId: 'c', invoiceId: 'i', fromInvoiceId: 'f', fromPeriod: '2026-07', lines: 2 }],
        advances: [{ invoiceId: 'i', requestId: 'r', number: 'ADV-1', attached: false, message: 'Choose an active advance request for this billing client.' }],
      }),
    ).toBe(
      ' 1 invoice carried lines pushed from last month. 1 client pushed to next month, so not billed here. The advance request ADV-1 was not moved: Choose an active advance request for this billing client.',
    )
    expect(generateRollForwardNote({ skipped: [], carried: [], advances: [] })).toBe('')
  })

  it('names, in words, every client whose pushed work no invoice could take', () => {
    const names: Record<string, string> = { c1: 'Bright Tower', c2: 'Rivercity', c3: 'KLC Sub' }
    expect(
      generateRollForwardNote(
        {
          skipped: [
            { clientId: 'c1', reason: 'client-inactive', carriedFromPeriod: '2026-10' },
            { clientId: 'c2', reason: 'opted-out', carriedFromPeriod: '2026-10' },
            { clientId: 'c3', reason: 'billed-to-other', carriedFromPeriod: '2026-10' },
            { clientId: 'c4', reason: 'opted-out' },
          ],
        },
        (id) => names[id] ?? id,
      ),
    ).toBe(
      " Bright Tower: October's pushed work is waiting but this client is inactive, so no invoice was made." +
        " Rivercity: October's pushed work is waiting but this client is invoiced outside the app, so no invoice was made." +
        " KLC Sub: October's pushed work is waiting but this client is billed on another client's invoice, so no invoice was made.",
    )
  })
})

describe('the single-client skip sentence', () => {
  it('says the month was pushed and how to bill it here instead', () => {
    expect(generateSkipMessage({ reason: 'rolled-forward', rolledIntoPeriod: '2026-09' }, 'Acme', 'August 2026')).toBe(
      "Acme's August 2026 invoice was pushed into September 2026, so no invoice was created. Undo the push to bill it in August 2026.",
    )
  })
})
