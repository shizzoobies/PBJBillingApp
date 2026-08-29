import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InvoiceMonthRun } from '../components/InvoiceMonthRun'
import { InvoicesPage } from '../pages/InvoicesPage'
import { isBillingMasterClient, selectableClients, workableClients } from '../lib/clientLifecycle'
import type { Client } from '../lib/types'

/**
 * A BILLING MASTER is a payer, not a company anyone works for.
 *
 * It holds no time entries, checklists, estimates or recurring reimbursements,
 * and the server refuses writes of any of them against it. So offering "KLC
 * Master" in the timer dropdown is an invitation to a refusal — the app must
 * not present a choice it will not honor. That is the UI half of the plan's
 * "hide those surfaces in the UI for a master".
 *
 * The filtering lives in ONE place (`workableClients`), which is what these
 * tests are mostly about: every work picker in the app derives from it, so a
 * new dropdown gets the rule by using the shared helper rather than by
 * remembering. What is pinned alongside it is the other half — masters must
 * still appear everywhere they are legitimately addressed, because a payer you
 * cannot select is a payer you cannot invoice.
 */

const master = {
  id: 'client-klc-master',
  name: 'KLC Master',
  isBillingMaster: true,
} as unknown as Client

const sub = { id: 'client-chemtrex', name: 'Chemtrex' } as unknown as Client
const retired = {
  id: 'client-old',
  name: 'Former Co',
  lifecycleStage: 'inactive',
} as unknown as Client

const all = [master, sub, retired]

afterEach(() => {
  vi.restoreAllMocks()
})

describe('workableClients', () => {
  it('drops a billing master and keeps the ordinary clients', () => {
    expect(workableClients(all).map((client) => client.id)).toEqual(['client-chemtrex'])
  })

  // It is the two rules together, not one instead of the other.
  it('still drops retired clients', () => {
    expect(workableClients([master, sub, retired]).some(isBillingMasterClient)).toBe(false)
    expect(workableClients([retired])).toHaveLength(0)
  })

  /*
   * The case that matters most. A record already pointed at a master — data
   * written before the guard, or a client that became one afterwards — has to
   * keep its own name in its own dropdown. Drop it and the <select> renders
   * blank, and the next save silently re-points the record at whatever sits at
   * the top of the list.
   */
  it('re-admits a master the record being edited is already pointed at', () => {
    expect(workableClients(all, ['client-klc-master']).map((c) => c.id)).toEqual([
      'client-klc-master',
      'client-chemtrex',
    ])
  })

  it('ignores empty keepIds rather than re-admitting everything', () => {
    expect(workableClients(all, [null, undefined, '']).map((c) => c.id)).toEqual([
      'client-chemtrex',
    ])
  })

  // The distinction the two helpers exist to draw: billing surfaces still get
  // the master, because that is the thing they are for.
  it('is narrower than selectableClients, which still offers the master', () => {
    expect(selectableClients(all).map((c) => c.id)).toEqual([
      'client-klc-master',
      'client-chemtrex',
    ])
  })

  it('treats an absent flag as an ordinary client', () => {
    expect(isBillingMasterClient({ isBillingMaster: undefined })).toBe(false)
    expect(isBillingMasterClient({ isBillingMaster: false })).toBe(false)
    expect(isBillingMasterClient({ isBillingMaster: true })).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* One real picker, end to end                                                */
/* -------------------------------------------------------------------------- */

vi.mock('../components/ReimbursementsCard', () => ({
  ReimbursementsCard: () => null,
}))

vi.mock('../AppContext', () => ({
  useAppContext: () => ({
    data: {
      clients: all,
      contacts: [],
      timeEntries: [],
      plans: [],
      reimbursements: [],
      recurringReimbursements: [],
      employees: [],
    },
    selectedClientId: 'client-klc-master',
    setSelectedClientId: vi.fn(),
    billingPeriod: '2026-08',
    printInvoice: vi.fn(),
    ownerMode: true,
    firmSettings: { name: 'PB&J Strategic Accounting', clientDefaults: { hourlyRate: 0 } },
  }),
}))

vi.mock('../lib/api', () => ({
  answerInvoiceAiReviewQuestionRequest: vi.fn(),
  confirmInvoiceCoverageRequest: vi.fn(),
  createInvoicePaymentLinkRequest: vi.fn(),
  generateInvoicesRequest: vi.fn(),
  listInvoiceAiReviewsRequest: vi.fn(async () => []),
  listInvoicesRequest: vi.fn(async () => []),
  listUnappliedRetainersRequest: vi.fn(async () => []),
  rateInvoiceRequest: vi.fn(),
  regenerateInvoicesRequest: vi.fn(),
  sendInvoiceRequest: vi.fn(),
  updateInvoiceRequest: vi.fn(),
}))

describe('the billing surfaces still offer a billing master', () => {
  // The other half of the rule, and the one that would be caught late: a payer
  // filtered out of the invoice page is a payer that can never be billed.
  it('lists it in the Invoices page client picker, beside an ordinary client', async () => {
    render(
      <div id="root">
        <InvoicesPage />
      </div>,
    )

    const picker = (await screen.findByLabelText('Client')) as HTMLSelectElement
    const names = [...picker.options].map((option) => option.textContent)
    expect(names).toContain('KLC Master')
    expect(names).toContain('Chemtrex')
    // …and the retired client is still out, which is the pre-existing rule.
    expect(names).not.toContain('Former Co')
  })

  it('renders the month run for a master without filtering it away', async () => {
    render(<InvoiceMonthRun clients={[master, sub]} onPrint={vi.fn()} />)

    // The run has no client picker of its own — it builds the whole month — so
    // what is pinned here is simply that a master-only workspace still renders
    // it rather than dead-ending.
    expect(await screen.findByText(/Press Generate/)).toBeInTheDocument()
  })
})
